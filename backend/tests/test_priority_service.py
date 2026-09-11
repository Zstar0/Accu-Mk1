"""Loader tests. Uses the conftest db_session (rolled back per test)."""
from sqlalchemy import select

from models import (
    CustomerPriority, LimsOrder, LimsSample, LimsSubSample, Priority, PriorityAudit, SlaTier,
)
from priority import service


def _seed_priorities(db):
    """conftest's db_session builds the schema with create_all (no migrations),
    so the seeded priorities rows are absent. Insert them here."""
    db.add_all([
        Priority(key="default", name="Default", rank=0, icon="minus",
                 color="zinc", pulse=False, is_default=True, is_active=True),
        Priority(key="high", name="High", rank=10, icon="chevron-up",
                 color="amber", pulse=False, is_default=False, is_active=True),
        Priority(key="expedited", name="Expedited", rank=20, icon="chevrons-up",
                 color="red", pulse=True, is_default=False, is_active=True),
    ])
    db.flush()


def _seed_default_tier(db):
    """snapshot._targets() needs exactly one default tier; create_all seeds none."""
    db.add(SlaTier(name="Standard", target_minutes=2880, is_default=True))
    db.flush()


def _mk(db, *, order_no="WP-9001", customer_id=777):
    db.add(LimsOrder(wp_order_id=9001, order_number=order_no, customer_user_id=customer_id))
    s = LimsSample(sample_id="PB-9001", external_lims_uid="uid-9001", client_order_number=order_no)
    db.add(s); db.flush()
    v = LimsSubSample(parent_sample_pk=s.id, sample_id="PB-9001-S01",
                      external_lims_uid="uid-9001-s01", vial_sequence=1)
    db.add(v); db.flush()
    return s, v


def test_inherit_chain_customer_to_vial(db_session):
    service.invalidate_priority_cache()
    _seed_priorities(db_session)
    s, v = _mk(db_session)
    db_session.add(CustomerPriority(wp_customer_user_id=777, priority_key="high"))
    db_session.flush()
    by_s, by_v = service.load_effective(db_session, sample_pks=[s.id], sub_sample_pks=[v.id])
    assert by_s[s.id].key == "high" and by_s[s.id].source_level == "customer"
    assert by_v[v.id].key == "high" and by_v[v.id].source_level == "customer"
    assert by_s[s.id].source_id == "777"


def test_vial_overrides_sample(db_session):
    service.invalidate_priority_cache()
    _seed_priorities(db_session)
    s, v = _mk(db_session)
    s.priority_key = "expedited"; v.priority_key = "default"; db_session.flush()
    by_s, by_v = service.load_effective(db_session, sample_pks=[s.id], sub_sample_pks=[v.id])
    assert by_s[s.id].key == "expedited" and by_s[s.id].source_level == "sample"
    assert by_v[v.id].key == "default" and by_v[v.id].source_level == "vial"


def test_missing_ids_resolve_default(db_session):
    service.invalidate_priority_cache()
    _seed_priorities(db_session)
    by_s, by_v = service.load_effective(db_session, sample_pks=[999999])
    assert by_s[999999].key == "default" and by_s[999999].source_level == "default"
    assert by_v == {}


def test_unknown_vial_pk_resolves_default(db_session):
    service.invalidate_priority_cache()
    _seed_priorities(db_session)
    by_s, by_v = service.load_effective(db_session, sub_sample_pks=[999999])
    assert by_v[999999].key == "default" and by_v[999999].source_level == "default"
    assert by_s == {}


def test_assign_sample_writes_column_audit_and_snapshot(db_session):
    service.invalidate_priority_cache()
    _seed_priorities(db_session)
    _seed_default_tier(db_session)
    s, v = _mk(db_session)
    res = service.assign(db_session, level="sample", entity_id=str(s.id), priority_key="expedited", user_id=5)
    assert (res.old_key, res.new_key) == (None, "expedited") and res.affected_sample_pks == [s.id]
    assert s.priority_key == "expedited"
    audit = db_session.execute(select(PriorityAudit).where(PriorityAudit.entity_id == str(s.id))).scalar_one()
    assert (audit.level, audit.new_key, audit.user_id, audit.source) == ("sample", "expedited", 5, "ui")
    assert s.sla_priority_key == "expedited" and s.sla_priority_source == "sample"


def test_assign_customer_affects_every_sample_on_their_orders(db_session):
    service.invalidate_priority_cache()
    _seed_priorities(db_session)
    _seed_default_tier(db_session)
    s, _ = _mk(db_session)
    res = service.assign(db_session, level="customer", entity_id="777", priority_key="high", user_id=1, note="VIP")
    assert res.affected_sample_pks == [s.id]
    assert s.sla_priority_key == "high" and s.sla_priority_source == "customer"


def test_assign_order_survives_duplicate_order_numbers(db_session):
    """lims_orders.order_number is indexed, NOT unique. scalar_one_or_none()
    raised MultipleResultsFound when two rows shared a number; assign now takes
    the lowest id and leaves the duplicate alone."""
    service.invalidate_priority_cache()
    _seed_priorities(db_session)
    _seed_default_tier(db_session)
    s, _ = _mk(db_session, order_no="WP-9003")
    db_session.add(LimsOrder(wp_order_id=9003, order_number="WP-9003", customer_user_id=777))
    db_session.flush()
    orders = db_session.execute(
        select(LimsOrder).where(LimsOrder.order_number == "WP-9003")).scalars().all()
    assert len(orders) == 2
    lowest = min(orders, key=lambda o: o.id)
    other = max(orders, key=lambda o: o.id)

    res = service.assign(db_session, level="order", entity_id="WP-9003",
                         priority_key="high", user_id=1)
    assert (res.old_key, res.new_key) == (None, "high")
    assert res.affected_sample_pks == [s.id]
    assert lowest.priority_key == "high" and lowest.priority_source == "ui"
    assert other.priority_key is None
    # The resolver must read the same duplicate assign() wrote to (lowest id).
    assert service.load_effective(db_session, sample_pks=[s.id])[0][s.id].key == "high"
    # ...and so must the order-list payload helper.
    assert service.order_priority_fields(db_session, ["WP-9003"])["WP-9003"]["priority_key"] == "high"


def test_assign_clear_to_inherit(db_session):
    service.invalidate_priority_cache()
    _seed_priorities(db_session)
    _seed_default_tier(db_session)
    s, _ = _mk(db_session)
    service.assign(db_session, level="sample", entity_id=str(s.id), priority_key="high", user_id=1)
    res = service.assign(db_session, level="sample", entity_id=str(s.id), priority_key=None, user_id=1)
    assert (res.old_key, res.new_key) == ("high", None) and s.priority_key is None


def test_assign_rejects_unknown_key_and_level(db_session):
    import pytest
    service.invalidate_priority_cache()
    _seed_priorities(db_session)
    _seed_default_tier(db_session)
    s, _ = _mk(db_session)
    with pytest.raises(ValueError):
        service.assign(db_session, level="sample", entity_id=str(s.id), priority_key="nope", user_id=1)
    with pytest.raises(ValueError):
        service.assign(db_session, level="planet", entity_id="1", priority_key="high", user_id=1)


def test_assign_customer_keeps_note_when_none_supplied(db_session):
    """Re-prioritising a customer without a note must preserve the stored one."""
    service.invalidate_priority_cache()
    _seed_priorities(db_session)
    _seed_default_tier(db_session)
    _mk(db_session)
    service.assign(db_session, level="customer", entity_id="777", priority_key="high",
                   user_id=1, note="VIP")
    service.assign(db_session, level="customer", entity_id="777", priority_key="expedited",
                   user_id=2, note=None)
    row = db_session.get(CustomerPriority, 777)
    assert (row.priority_key, row.note, row.updated_by) == ("expedited", "VIP", 2)


def test_legacy_priority_string_clamps_by_rank():
    """The legacy inbox/worksheet field is typed 'normal' | 'high' | 'expedited'
    on the frontend and the inbox PUTs 400 anything else — an admin-created key
    must never reach it verbatim. Clamp by rank, not by key."""
    from priority.resolver import Effective
    assert service.legacy_priority_string(
        Effective("rush", 25, "sample", "1")) == "expedited"
    assert service.legacy_priority_string(
        Effective("expedited", 20, "vial", "1")) == "expedited"
    assert service.legacy_priority_string(
        Effective("high", 10, "order", "WP-1")) == "high"
    assert service.legacy_priority_string(
        Effective("nudge", 5, "customer", "42")) == "high"
    assert service.legacy_priority_string(
        Effective("backburner", -10, "sample", "1")) == "normal"
    assert service.legacy_priority_string(
        Effective("default", 0, "default", None)) == "normal"
    # A re-ranked default is still "nothing explicit" -- source_level wins
    # over rank here, or every untouched sample would render as High.
    assert service.legacy_priority_string(
        Effective("default", 30, "default", None)) == "normal"
