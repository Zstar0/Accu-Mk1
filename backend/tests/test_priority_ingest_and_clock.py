"""Task 9: order-payload priority mapping at s2s upsert CREATE, and the SLA
clock snapshots written at the receive/publish touchpoints.

Hermetic: StaticPool in-memory SQLite + `get_db` / `database.SessionLocal`
overrides, `ACCUMK1_INTERNAL_SERVICE_TOKEN` patched in per test. The brief's
sketch talked to the dev Postgres through the module-level `engine`; the s2s
fixture idiom already established in `test_s2s_orders_upsert.py` is used
instead so the tests leave no rows behind anywhere.
"""
import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import database
from database import Base, get_db
from main import app
from models import LimsOrder, LimsSample, PriorityAudit, SlaTier
from priority import service
from tests.test_priority_service import _seed_priorities

SVC_TOKEN = "test-svc-token"
HDR = {"X-Service-Token": SVC_TOKEN}
URL = "/s2s/orders/upsert"


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    service.invalidate_priority_cache()  # the map is process-cached for 60 s
    _seed_priorities(session)
    session.commit()
    yield session
    session.close()
    service.invalidate_priority_cache()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db
    tc = TestClient(app)
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db


def _seed_default_tier(db):
    db.add(SlaTier(name="Standard", target_minutes=2880, is_default=True))
    db.commit()


def _body(order_number="WP-7001", wp_order_id=7001, **extra):
    return {"orders": [{"wp_order_id": wp_order_id, "order_number": order_number,
                        "status": "order-submitted", "samples": [], **extra}]}


def _post(client, body):
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        return client.post(URL, json=body, headers=HDR)


# ── order-payload priority ────────────────────────────────────────────


def test_payload_priority_lands_on_create_with_audit(client, db_session):
    r = _post(client, _body(priority="expedited"))
    assert r.status_code == 200, r.text
    row = db_session.query(LimsOrder).filter_by(order_number="WP-7001").one()
    assert (row.priority_key, row.priority_source) == ("expedited", "order-payload")
    audits = db_session.query(PriorityAudit).filter_by(level="order", entity_id="WP-7001").all()
    assert len(audits) == 1
    assert (audits[0].old_key, audits[0].new_key, audits[0].source) == (
        None, "expedited", "order-payload")


def test_payload_priority_is_create_only(client, db_session):
    assert _post(client, _body(priority="expedited")).status_code == 200
    assert _post(client, _body(priority="high")).status_code == 200
    row = db_session.query(LimsOrder).filter_by(order_number="WP-7001").one()
    assert row.priority_key == "expedited"
    assert db_session.query(PriorityAudit).filter_by(level="order").count() == 1


def test_no_priority_in_payload_leaves_order_inheriting(client, db_session):
    assert _post(client, _body()).status_code == 200
    row = db_session.query(LimsOrder).filter_by(order_number="WP-7001").one()
    assert (row.priority_key, row.priority_source) == (None, None)
    assert db_session.query(PriorityAudit).count() == 0


def test_unknown_payload_priority_is_ignored_and_logged(client, db_session, caplog):
    with caplog.at_level("WARNING"):
        r = _post(client, _body(priority="ludicrous"))
    assert r.status_code == 200, r.text
    row = db_session.query(LimsOrder).filter_by(order_number="WP-7001").one()
    assert (row.priority_key, row.priority_source) == (None, None)
    assert db_session.query(PriorityAudit).count() == 0
    assert any("ludicrous" in rec.getMessage() for rec in caplog.records)


def test_priority_failure_does_not_fail_the_upsert(client, db_session):
    """assign() refreshes the SLA snapshot for the order's in-flight samples,
    and that raises when no default SlaTier exists (none is seeded here). The
    order stamps must still land — same posture as the placeholder seed."""
    db_session.add(LimsSample(sample_id="PB-7001", client_order_number="WP-7001",
                              status="received"))
    db_session.commit()
    r = _post(client, _body(priority="expedited"))
    assert r.status_code == 200, r.text
    assert r.json()["upserted"] == 1
    # The assignment itself already landed (assign mutates and flushes before
    # it refreshes the snapshot) -- only the snapshot is lost, which is the
    # right half to lose.
    row = db_session.query(LimsOrder).filter_by(order_number="WP-7001").one()
    assert (row.priority_key, row.priority_source) == ("expedited", "order-payload")
    assert db_session.query(LimsSample).filter_by(sample_id="PB-7001").one().sla_priority_key is None


# ── clock-event snapshots ─────────────────────────────────────────────


@pytest.fixture
def session_local(db_session):
    """`database.SessionLocal` for the touchpoint code paths, which open their
    own short-lived session. Close is a no-op so the fixture keeps the handle."""
    class _Handle:
        def __init__(self, s):
            self._s = s

        def __getattr__(self, name):
            return getattr(self._s, name)

        def close(self):
            pass

    prev = database.SessionLocal
    database.SessionLocal = lambda: _Handle(db_session)
    yield
    database.SessionLocal = prev


def _pre_received_sample(db):
    s = LimsSample(sample_id="PB-7100", external_lims_uid="uid-7100", status="sample_due")
    db.add(s)
    db.commit()
    return s


def test_receive_page_touchpoint_writes_the_snapshot(session_local, db_session):
    from main import _receive_native_phase
    s = _pre_received_sample(db_session)
    _seed_default_tier(db_session)
    import workflow.engine as engine_mod
    import workflow.sample_log as log_mod
    with patch.object(log_mod, "record_sample_transition", return_value=True), \
         patch.object(log_mod, "heal_sample_status", return_value=True), \
         patch.object(engine_mod, "drive_sample_touchpoint", return_value=True):
        out = _receive_native_phase(sample_id="PB-7100", image_bytes=None,
                                    remarks=None, user_id=None)
    assert out["ok"] is True and out["already"] is False
    db_session.refresh(s)
    assert s.sla_priority_key == "default"
    assert s.sla_target_minutes == 2880
    assert s.sla_snapshot_at is not None


def test_receive_page_touchpoint_snapshot_failure_is_fail_open(session_local, db_session):
    """No default SlaTier — refresh raises NoResultFound. Check-in must still
    succeed; the clock snapshot may never block a receive."""
    from main import _receive_native_phase
    s = _pre_received_sample(db_session)
    import workflow.engine as engine_mod
    import workflow.sample_log as log_mod
    with patch.object(log_mod, "record_sample_transition", return_value=True), \
         patch.object(log_mod, "heal_sample_status", return_value=True), \
         patch.object(engine_mod, "drive_sample_touchpoint", return_value=True):
        out = _receive_native_phase(sample_id="PB-7100", image_bytes=None,
                                    remarks=None, user_id=None)
    assert out["ok"] is True
    db_session.refresh(s)
    assert s.sla_priority_key is None


@pytest.mark.parametrize("verb", ["receive", "publish"])
def test_transition_hook_touchpoint_writes_the_snapshot(session_local, db_session, verb):
    from main import _record_sample_transition_bg
    s = _pre_received_sample(db_session)
    _seed_default_tier(db_session)
    import workflow.engine as engine_mod
    import workflow.sample_log as log_mod
    with patch.object(log_mod, "record_sample_transition", return_value=False), \
         patch.object(log_mod, "heal_sample_status", return_value=False), \
         patch.object(engine_mod, "drive_sample_touchpoint", return_value=False):
        _record_sample_transition_bg(sample_id="PB-7100", to_status="published",
                                     source="mk1", verb=verb, from_status="received",
                                     actor_user_id=None)
    db_session.expire_all()
    row = db_session.query(LimsSample).filter_by(sample_id="PB-7100").one()
    assert row.sla_priority_key == "default"
    assert row.sla_snapshot_at is not None


def test_transition_hook_snapshot_failure_is_fail_open(session_local, db_session):
    from main import _record_sample_transition_bg
    _pre_received_sample(db_session)  # no default SlaTier seeded
    import workflow.engine as engine_mod
    import workflow.sample_log as log_mod
    with patch.object(log_mod, "record_sample_transition", return_value=True), \
         patch.object(log_mod, "heal_sample_status", return_value=False), \
         patch.object(engine_mod, "drive_sample_touchpoint", return_value=False):
        _record_sample_transition_bg(sample_id="PB-7100", to_status="published",
                                     source="mk1", verb="publish", from_status="received",
                                     actor_user_id=None)
    db_session.expire_all()
    row = db_session.query(LimsSample).filter_by(sample_id="PB-7100").one()
    assert row.sla_priority_key is None
