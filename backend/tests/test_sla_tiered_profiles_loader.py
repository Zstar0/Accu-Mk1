"""``main._load_tiered_profiles``: the rows both report engines resolve profile
SLA tiers from. In-memory SQLite, so it never touches the dev database."""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main
from models import (
    AnalysisProfile, LimsSample, LimsSampleTransition, LimsSubSampleEvent, SlaTier,
    analysis_profile_members,
)


@pytest.fixture
def db():
    from database import Base
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    s.add(SlaTier(id=1, name="Standard", target_minutes=1440, business_hours_only=True, is_default=True))
    s.add(SlaTier(id=3, name="USP71", target_minutes=6720, business_hours_only=True))
    s.add(AnalysisProfile(id=8, key="usp71", name="Sterility USP 71", is_addon=True, sla_tier_id=3))
    s.add(AnalysisProfile(id=9, key="hplc", name="HPLC", is_addon=False))                      # no tier
    s.add(AnalysisProfile(id=10, key="old", name="Retired", is_addon=True, sla_tier_id=3, active=False))
    s.flush()
    for pid, svc in ((8, 279), (8, 280), (9, 10), (10, 60)):
        s.execute(analysis_profile_members.insert().values(
            analysis_profile_id=pid, analysis_service_id=svc, sort_order=0))
    s.commit()
    yield s
    s.close()


def test_only_active_tiered_profiles_come_back_with_their_member_services(db):
    assert main._load_tiered_profiles(db) == [(8, "Sterility USP 71", 3, frozenset({279, 280}))]


def test_a_tiered_profile_with_no_members_is_harmless(db):
    db.add(AnalysisProfile(id=11, key="empty", name="Empty", is_addon=True, sla_tier_id=3))
    db.commit()
    rows = {r[0]: r for r in main._load_tiered_profiles(db)}
    assert rows[11] == (11, "Empty", 3, frozenset())


def test_delivered_reads_the_publish_ledger_and_the_coa_published_event(db):
    """The ledger has the history (a partial COA from before 1.21.9 wrote no
    event); the event covers a partial publish the engine declined to ledger."""
    from datetime import datetime
    for pk, sid in ((1, "P-2777"), (2, "P-NEW"), (3, "P-OPEN"), (4, "P-RECV")):
        db.add(LimsSample(id=pk, sample_id=sid, status="verified"))
    db.flush()
    db.add(LimsSampleTransition(lims_sample_pk=1, verb="publish", to_status="published",
                                source="senaite", occurred_at=datetime(2026, 9, 15, 3, 47)))
    db.add(LimsSubSampleEvent(lims_sample_pk=2, event="coa_published", details={}))
    db.add(LimsSampleTransition(lims_sample_pk=4, verb="receive", to_status="sample_received",
                                source="mk1", occurred_at=datetime(2026, 9, 10, 18, 56)))
    db.add(LimsSubSampleEvent(lims_sample_pk=4, event="coa_generated", details={}))
    db.commit()
    assert main._delivered_sample_pks(db, [1, 2, 3, 4]) == frozenset({1, 2})
    assert main._delivered_sample_pks(db, []) == frozenset()
    assert main._delivered_sample_pks(db, [3]) == frozenset()
