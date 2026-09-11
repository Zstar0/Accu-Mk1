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
    """The module's auth override is a plain dict, so routes resolve
    `getattr(user, "id", None)` -> None and the audit row carries no user.
    That is the unknown/system actor: siblings render `by: None` and no name,
    so the line must stay bare — pinned exactly so an actor suffix cannot
    appear from nowhere."""
    with temp_sample() as t:
        r = client.put("/priorities/assign", json={
            "level": "sample", "id": str(t["pk"]), "priority_key": "high",
            "note": "embed test"})
        assert r.status_code == 200, r.text
        events = client.get(f"/samples/{t['sample_id']}/activity").json()["events"]
        line = next((e for e in events if e.get("source") == "priority_audit"), None)
        assert line is not None, "no priority_audit line in the activity feed"
        assert line["type"] == "priority"
        assert line["description"] == "Priority: Inherit → High"
        assert line["details"]["by"] is None


def test_activity_priority_line_names_the_actor():
    """spec §7: "Priority: High → Expedited (Jane)". The actor is resolved
    server-side from priority_audit.user_id, like every sibling source in the
    endpoint."""
    from database import SessionLocal
    from models import PriorityAudit, User

    tag = uuid.uuid4().hex[:8]
    db = SessionLocal()
    user_id = None
    try:
        with temp_sample() as t:
            u = User(email=f"prio-{tag}@example.test", hashed_password="x",
                     role="standard", first_name="Ada", last_name="Lovelace")
            db.add(u)
            db.flush()
            user_id = u.id
            db.add(PriorityAudit(user_id=user_id, level="sample",
                                 entity_id=str(t["pk"]), old_key="high",
                                 new_key="expedited", source="ui"))
            db.commit()
            events = client.get(f"/samples/{t['sample_id']}/activity").json()["events"]
            line = next((e for e in events if e.get("source") == "priority_audit"), None)
            assert line is not None
            assert line["description"] == "Priority: High → Expedited (Ada Lovelace)"
            assert line["details"]["by"] == "Ada Lovelace"
    finally:
        db.rollback()
        db.close()
        if user_id is not None:
            with engine.begin() as c:
                c.execute(text("DELETE FROM users WHERE id = :i"), {"i": user_id})


def test_activity_log_includes_customer_lines_for_this_customer_only():
    """spec §2.7: a customer-level change that alters this sample's effective
    value is part of its history. Only the customer who owns the sample's
    order qualifies — another customer's row must not leak in."""
    mine, other = 999003, 999004
    tag = uuid.uuid4().hex[:8]
    order_no = f"WP-T{tag}".upper()
    wp_order_id = 990000 + int(tag[:4], 16) % 9000
    cust_name = f"Acme {tag}"
    try:
        with temp_sample() as t:
            with engine.begin() as c:
                c.execute(text(
                    "INSERT INTO lims_orders (wp_order_id, order_number, "
                    "customer_user_id, customer_name) "
                    "VALUES (:w, :o, :c, :n)"),
                    {"w": wp_order_id, "o": order_no, "c": mine, "n": cust_name})
                c.execute(text("UPDATE lims_samples SET client_order_number = :o "
                               "WHERE id = :pk"), {"o": order_no, "pk": t["pk"]})
            for cid in (mine, other):
                r = client.put("/priorities/assign", json={
                    "level": "customer", "id": str(cid), "priority_key": "expedited"})
                assert r.status_code == 200, r.text

            events = client.get(f"/samples/{t['sample_id']}/activity").json()["events"]
            cust = [e for e in events
                    if e.get("source") == "priority_audit"
                    and e["details"]["level"] == "customer"]
            assert [e["details"]["entity_id"] for e in cust] == [str(mine)], cust
            assert cust[0]["description"] == (
                f"Priority: Inherit → Expedited via customer {cust_name}")
    finally:
        with engine.begin() as c:
            for cid in (mine, other):
                c.execute(text("DELETE FROM priority_audit WHERE level = 'customer' "
                               "AND entity_id = :i"), {"i": str(cid)})
                c.execute(text("DELETE FROM customer_priorities "
                               "WHERE wp_customer_user_id = :i"), {"i": cid})
            c.execute(text("DELETE FROM priority_audit WHERE level = 'order' "
                           "AND entity_id = :o"), {"o": order_no})
            c.execute(text("DELETE FROM lims_orders WHERE wp_order_id = :w"),
                      {"w": wp_order_id})


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


def test_order_priority_fields_accepts_bare_is_numbers(db_session):
    """The IS hands the explorer bare numbers; lims_orders stores WP-. The
    stamp must resolve either form and key the result by what was asked."""
    from models import CustomerPriority
    service.invalidate_priority_cache()
    _seed(db_session)
    db_session.add(CustomerPriority(wp_customer_user_id=42, priority_key="expedited"))
    db_session.flush()
    fields = service.order_priority_fields(db_session, ["8001", "WP-8001", "9999"])
    assert set(fields) == {"8001", "WP-8001"}
    assert fields["8001"]["effective_priority"]["key"] == "expedited"
    assert fields["8001"]["effective_priority"]["source_level"] == "customer"
    assert fields["WP-8001"] == fields["8001"]


def test_assign_order_accepts_bare_is_number(db_session):
    service.invalidate_priority_cache()
    _seed(db_session)
    service.assign(db_session, level="order", entity_id="8001",
                   priority_key="high", user_id=None, source="ui")
    order = db_session.query(LimsOrder).filter_by(order_number="WP-8001").one()
    assert order.priority_key == "high"


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
