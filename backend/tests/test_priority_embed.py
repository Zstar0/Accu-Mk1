"""Task 8: every sample/vial row carries its effective priority, the activity
log derives lines from priority_audit, and the inbox priority PUTs route
through priority.service.assign.

The TestClient tests run against the local dev Postgres and are HERMETIC: each
seeds its own lims_samples (+ lims_sub_samples) row through `engine.begin()`
and removes it, with its priority_audit rows, in `finally`. Nothing asserts
against pre-existing registry content, and none of them early-return — a fresh
database exercises them exactly like a populated one. The db_session tests are
pure sqlite units (conftest fixture).
"""
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import _run_migrations, engine
from main import app
from models import (
    CustomerPriority, LimsOrder, LimsSample, LimsSubSample, Priority, SlaTier,
)
from priority import service

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)

# TestClient built outside a `with` block never fires the app lifespan, so nothing
# else in this module runs migrations — and without the seeded `priorities` rows
# every effective-priority read degrades to None. Same import-time call
# `test_priority_migration.py` uses; `_run_migrations()` is idempotent.
_run_migrations()


@contextmanager
def temp_sample(with_vial: bool = False):
    """Seed a throwaway registry row (optionally with one vial) on the dev
    Postgres and tear it down — audit rows first, then vial, then sample.

    `last_synced_at` is stamped with a naive UTC value, not SQL NOW(): the
    column is a naive TIMESTAMP and `service.list_sub_samples` compares it to
    `datetime.utcnow()`; a server-local NOW() can read as stale and fire a
    SENAITE reconcile round-trip inside the test.
    """
    tag = uuid.uuid4().hex[:8]
    # Uppercase: registry lookups normalise sample_id with .upper().
    sid = f"PB-T{tag}".upper()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    sample_pk = vial_pk = None
    vial_uid = f"mk1://t-{tag}"
    try:
        with engine.begin() as c:
            sample_pk = c.execute(text(
                "INSERT INTO lims_samples (sample_id, external_lims_uid, status, "
                "last_synced_at) VALUES (:sid, :uid, 'sample_received', :now) "
                "RETURNING id"
            ), {"sid": sid, "uid": f"mk1test-{tag}", "now": now}).scalar()
            if with_vial:
                vial_pk = c.execute(text(
                    "INSERT INTO lims_sub_samples (parent_sample_pk, sample_id, "
                    "external_lims_uid, vial_sequence) "
                    "VALUES (:pk, :sid, :uid, 1) RETURNING id"
                ), {"pk": sample_pk, "sid": f"{sid}-S01", "uid": vial_uid}).scalar()
        yield {"pk": sample_pk, "sample_id": sid, "vial_pk": vial_pk,
               "vial_uid": vial_uid}
    finally:
        with engine.begin() as c:
            if vial_pk is not None:
                c.execute(text("DELETE FROM priority_audit WHERE level = 'vial' "
                               "AND entity_id = :id"), {"id": str(vial_pk)})
            if sample_pk is not None:
                c.execute(text("DELETE FROM priority_audit WHERE level = 'sample' "
                               "AND entity_id = :id"), {"id": str(sample_pk)})
                c.execute(text("DELETE FROM lims_sub_samples WHERE parent_sample_pk = :pk"),
                          {"pk": sample_pk})
                c.execute(text("DELETE FROM lims_samples WHERE id = :pk"), {"pk": sample_pk})


# ── list / detail rows ────────────────────────────────────────────────────

def test_registry_samples_rows_carry_priority_shape():
    with temp_sample() as t:
        r = client.get("/registry/samples",
                       params={"search": t["sample_id"], "limit": 5})
        assert r.status_code == 200, r.text
        items = r.json()["items"]
        row = next((i for i in items if i["id"] == t["sample_id"]), None)
        assert row is not None, f"seeded row missing from {[i['id'] for i in items]}"
        assert set(row["priority"]) >= {"key", "rank", "source_level"}
        assert row["priority"]["key"] == "default"
        assert row["priority"]["source_level"] == "default"


def test_sub_samples_list_rows_carry_priority_shape():
    with temp_sample(with_vial=True) as t:
        r = client.get("/api/sub-samples",
                       params={"parent_sample_id": t["sample_id"]})
        assert r.status_code == 200, r.text
        vials = r.json()["sub_samples"]
        assert [v["id"] for v in vials] == [t["vial_pk"]]
        v = vials[0]
        assert "priority_key" in v and v["priority_key"] is None
        assert set(v["priority"]) >= {"key", "rank", "source_level"}
        assert v["priority"]["key"] == "default"


def test_registry_details_payload_carries_priority_fields():
    from database import SessionLocal
    from sub_samples.registry_details import build_native_details
    with temp_sample() as t:
        db = SessionLocal()
        try:
            out = build_native_details(db, t["sample_id"])
        finally:
            db.close()
        assert out.registry_pk == t["pk"]
        assert out.priority and out.priority["key"] == "default"
        # explicit_priority_key is the row's own column - None means "inherit"
        assert out.explicit_priority_key is None


# ── activity log ─────────────────────────────────────────────────────────

def test_activity_log_includes_priority_audit_lines():
    with temp_sample() as t:
        r = client.put("/priorities/assign", json={
            "level": "sample", "id": str(t["pk"]), "priority_key": "high",
            "note": "embed test"})
        assert r.status_code == 200, r.text
        events = client.get(f"/samples/{t['sample_id']}/activity").json()["events"]
        line = next((e for e in events if e.get("source") == "priority_audit"), None)
        assert line is not None, "no priority_audit line in the activity feed"
        assert line["type"] == "priority"
        assert "High" in (line.get("description") or "")


# ── uid → assign target (inbox PUTs) ────────────────────────────────────────

def _seed(db):
    db.add_all([
        Priority(key="default", name="Default", rank=0, icon="minus",
                 color="zinc", pulse=False, is_default=True, is_active=True),
        Priority(key="high", name="High", rank=10, icon="chevron-up",
                 color="amber", pulse=False, is_default=False, is_active=True),
        Priority(key="expedited", name="Expedited", rank=20, icon="chevrons-up",
                 color="red", pulse=True, is_default=False, is_active=True),
    ])
    db.add(SlaTier(name="Standard", target_minutes=2880, is_default=True))
    db.add(LimsOrder(wp_order_id=8001, order_number="WP-8001", customer_user_id=42))
    s = LimsSample(sample_id="PB-8001", external_lims_uid="uid-8001",
                   client_order_number="WP-8001")
    db.add(s)
    db.flush()
    v = LimsSubSample(parent_sample_pk=s.id, sample_id="PB-8001-S01",
                      external_lims_uid="mk1://nat-8001", vial_sequence=1)
    db.add(v)
    db.flush()
    return s, v


def test_priority_target_for_uid_resolves_vial_then_sample(db_session):
    service.invalidate_priority_cache()
    s, v = _seed(db_session)
    assert service.priority_target_for_uid(db_session, "mk1://nat-8001") == ("vial", str(v.id))
    assert service.priority_target_for_uid(db_session, "uid-8001") == ("sample", str(s.id))
    assert service.priority_target_for_uid(db_session, "nope") is None


def test_assign_through_uid_target_sets_effective(db_session):
    service.invalidate_priority_cache()
    s, v = _seed(db_session)
    level, entity_id = service.priority_target_for_uid(db_session, "mk1://nat-8001")
    service.assign(db_session, level=level, entity_id=entity_id,
                   priority_key="expedited", user_id=None, source="ui")
    by_uid = service.load_effective_for_uids(db_session, ["mk1://nat-8001", "uid-8001"])
    assert by_uid["mk1://nat-8001"].key == "expedited"
    assert by_uid["mk1://nat-8001"].source_level == "vial"
    assert by_uid["uid-8001"].key == "default"
    assert service.legacy_priority_string(by_uid["uid-8001"]) == "normal"


def test_inbox_priority_inherits_from_order(db_session):
    """The inbox no longer copies order priority into sample_priorities — the
    row's effective value resolves through lims_orders.priority_key."""
    service.invalidate_priority_cache()
    s, v = _seed(db_session)
    order = db_session.query(LimsOrder).filter_by(order_number="WP-8001").one()
    order.priority_key = "high"
    db_session.flush()
    by_uid = service.load_effective_for_uids(db_session, ["mk1://nat-8001"])
    eff = by_uid["mk1://nat-8001"]
    assert eff.key == "high" and eff.source_level == "order"
    assert service.legacy_priority_string(eff) == "high"


def test_order_priority_fields_resolve_customer_inheritance(db_session):
    service.invalidate_priority_cache()
    _seed(db_session)
    db_session.add(CustomerPriority(wp_customer_user_id=42, priority_key="high"))
    db_session.flush()
    fields = service.order_priority_fields(db_session, ["WP-8001"])["WP-8001"]
    assert fields["priority_key"] is None
    assert fields["effective_priority"]["key"] == "high"
    assert fields["effective_priority"]["source_level"] == "customer"
