"""Two live canonical parent rows on one line: the engine must pick the one
that is furthest along, not whichever the DB returned last.

P-3016 (2026-09-23): a parent-level "retest" left a canonical 'unassigned'
parent-hosted row beside the later 'published' row for each metal. The
per-key dict in _live_parent_line_states was last-write-wins, so the blank
row won and the sample sat at to_be_verified with everything published.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import AnalysisService, LimsAnalysis, LimsSample
from workflow.engine import _live_parent_line_states


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _parent_with_rows(db, states):
    """One keyword, one canonical parent row per state, inserted IN ORDER so
    the last state listed has the highest id."""
    parent = LimsSample(sample_id="P-DEDUPE", external_lims_uid=None)
    svc = AnalysisService(title="Arsenic", keyword="ARSENIC-PPM", origin="mk1")
    db.add_all([parent, svc])
    db.flush()
    for st in states:
        db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                            keyword="ARSENIC-PPM", title="Arsenic",
                            provenance="canonical", review_state=st))
        db.flush()
    db.commit()
    return parent


@pytest.mark.parametrize("states, expected", [
    (["published", "unassigned"], "published"),      # P-3016 shape: blank row newer
    (["unassigned", "published"], "published"),
    (["verified", "unassigned"], "verified"),
    (["parent_to_verify", "unassigned"], "to_be_verified"),
    (["verified", "published"], "published"),
    (["published", "verified"], "published"),
])
def test_furthest_state_wins_regardless_of_insert_order(db, states, expected):
    parent = _parent_with_rows(db, states)
    assert _live_parent_line_states(db, parent) == {"ARSENIC-PPM": expected}
