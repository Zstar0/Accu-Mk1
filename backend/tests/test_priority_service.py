"""Loader tests. Uses the conftest db_session (rolled back per test)."""
from models import CustomerPriority, LimsOrder, LimsSample, LimsSubSample, Priority
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
