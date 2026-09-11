"""SLA snapshot writer tests. Uses the conftest db_session (create_all, no
migrations/seeds), so priorities + the default SLA tier are seeded per test."""
from sqlalchemy import select

from models import LimsSample, LimsSubSample, SlaPriorityTier, SlaTier
from priority import service, snapshot
from tests.test_priority_service import _seed_priorities


def _seed_default_tier(db):
    """create_all leaves sla_tiers empty; _targets() requires exactly one default."""
    db.add(SlaTier(name="Standard", target_minutes=2880, is_default=True))
    db.flush()


def _sample(db, key=None, status="received"):
    s = LimsSample(sample_id="PB-9100", external_lims_uid="uid-9100", status=status, priority_key=key)
    db.add(s); db.flush()
    v = LimsSubSample(parent_sample_pk=s.id, sample_id="PB-9100-S01", external_lims_uid="uid-9100-s01", vial_sequence=1)
    db.add(v); db.flush()
    return s, v


def test_snapshot_uses_default_tier_when_unmapped(db_session):
    service.invalidate_priority_cache()
    _seed_priorities(db_session)
    _seed_default_tier(db_session)
    default_tier = db_session.execute(select(SlaTier).where(SlaTier.is_default)).scalar_one()
    s, v = _sample(db_session, key="high")
    n = snapshot.refresh(db_session, [s.id])
    assert n == 1
    assert s.sla_priority_key == "high" and s.sla_priority_source == "sample"
    assert s.sla_target_minutes == default_tier.target_minutes and s.sla_snapshot_at is not None
    assert v.sla_priority_key == "high" and v.sla_target_minutes == default_tier.target_minutes


def test_snapshot_uses_global_priority_tier(db_session):
    service.invalidate_priority_cache()
    _seed_priorities(db_session)
    _seed_default_tier(db_session)
    fast = SlaTier(name="_test_fast", target_minutes=120)
    db_session.add(fast); db_session.flush()
    db_session.add(SlaPriorityTier(priority="expedited", sla_tier_id=fast.id, service_group_id=None))
    db_session.flush()
    s, _ = _sample(db_session, key="expedited")
    snapshot.refresh(db_session, [s.id])
    assert s.sla_target_minutes == 120


def test_only_in_flight_skips_published(db_session):
    service.invalidate_priority_cache()
    _seed_priorities(db_session)
    _seed_default_tier(db_session)
    s, _ = _sample(db_session, key="high", status="published")
    assert snapshot.refresh(db_session, [s.id], only_in_flight=True) == 0
    assert s.sla_snapshot_at is None
