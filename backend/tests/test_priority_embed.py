"""Task 8: every sample/vial row carries its effective priority, the activity
log derives lines from priority_audit, and the inbox priority PUTs route
through priority.service.assign.

The TestClient tests read the local dev Postgres; they early-return when the
registry is empty (a fresh DB) rather than failing. The db_session tests are
pure sqlite units (conftest fixture) and always run.
"""
from fastapi.testclient import TestClient
from sqlalchemy import text

import auth
from database import engine
from main import app
from models import (
    CustomerPriority, LimsOrder, LimsSample, LimsSubSample, Priority, SlaTier,
)
from priority import service

app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
client = TestClient(app)


def _newest_sample():
    with engine.connect() as c:
        return c.execute(text(
            "SELECT id, sample_id FROM lims_samples ORDER BY id DESC LIMIT 1"
        )).first()


# ── list / detail rows ──────────────────────────────────────────────────────

def test_registry_samples_rows_carry_priority_shape():
    r = client.get("/registry/samples", params={"limit": 5})
    assert r.status_code == 200
    for item in r.json()["items"]:
        assert "priority" in item and set(item["priority"]) >= {"key", "rank", "source_level"}


def test_sub_samples_list_rows_carry_priority_shape():
    with engine.connect() as c:
        sid = c.execute(text(
            "SELECT s.sample_id FROM lims_samples s JOIN lims_sub_samples v "
            "ON v.parent_sample_pk = s.id ORDER BY s.id DESC LIMIT 1"
        )).scalar()
    if not sid:
        return
    r = client.get("/api/sub-samples", params={"parent_sample_id": sid})
    assert r.status_code == 200
    vials = r.json()["sub_samples"]
    assert vials
    for v in vials:
        assert "priority_key" in v
        assert v["priority"] and set(v["priority"]) >= {"key", "rank", "source_level"}


def test_registry_details_payload_carries_priority_fields():
    row = _newest_sample()
    if not row:
        return
    pk, sid = row
    from sub_samples.registry_details import build_native_details
    from database import SessionLocal
    db = SessionLocal()
    try:
        out = build_native_details(db, sid)
    finally:
        db.close()
    assert out.registry_pk == pk
    assert out.priority and out.priority["key"]
    # explicit_priority_key is the row's own column — None means "inherit"
    assert out.explicit_priority_key is None or isinstance(out.explicit_priority_key, str)


# ── activity log ────────────────────────────────────────────────────────────

def test_activity_log_includes_priority_audit_lines():
    row = _newest_sample()
    if not row:
        return
    pk, sid = row
    try:
        r = client.put("/priorities/assign", json={
            "level": "sample", "id": str(pk), "priority_key": "high", "note": "t"})
        assert r.status_code == 200, r.text
        events = client.get(f"/samples/{sid}/activity").json()["events"]
        assert any(
            e.get("source") == "priority_audit"
            and e.get("type") == "priority"
            and "High" in (e.get("description") or "")
            for e in events
        )
    finally:
        client.put("/priorities/assign",
                   json={"level": "sample", "id": str(pk), "priority_key": None})


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
