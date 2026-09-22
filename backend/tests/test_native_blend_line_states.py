"""Parent line-state maps on a native blend.

A native blend carries one parent row PER analyte slot under ONE keyword and
ONE service (HPLC-PURITY x3), plus one 'ordered' placeholder per slot. Two maps
describe a parent's lines, and both must treat each slot as its own line:

  service.native_parent_line_states      -> FE lock gate + Ready-to-Publish
  workflow.engine._live_parent_line_states -> the sample-status cascade

Keyed by keyword they collapsed the slots. Found 2026-09-20 when master's
ordered-placeholder fill (P-2739, "a paid-for native line still on its vial
must read as pending") met the slot-aware keys: on a blend that guarantee
silently stopped holding, and a verified sample grew phantom pending lines.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.hplc_native import parent_line_state_key
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED
from lims_analyses.service import native_parent_line_states
from models import AnalysisService, LimsAnalysis, LimsSample
from workflow.engine import _live_parent_line_states, evaluate_requirements


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _blend(db, *, canonical: dict, sample_id="PB-7000"):
    """A 3-slot native blend parent. Every slot has its 'ordered' placeholder
    (placeholders are never retired); `canonical` maps slot -> review_state
    for the slots that have been promoted."""
    parent = LimsSample(sample_id=sample_id, external_lims_uid=None)
    svc = AnalysisService(title="HPLC Purity", keyword="HPLC-PURITY", origin="mk1")
    db.add_all([parent, svc])
    db.flush()
    for slot in (1, 2, 3):
        db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                            keyword="HPLC-PURITY", title=f"slot {slot}", slot=slot,
                            provenance=PROVENANCE_ORDERED, review_state="unassigned"))
    for slot, state in canonical.items():
        db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                            keyword="HPLC-PURITY", title=f"slot {slot}", slot=slot,
                            provenance="canonical", review_state=state))
    db.commit()
    return parent, svc


def _k(svc, slot):
    return parent_line_state_key("HPLC-PURITY", svc.id, slot)


ALL_VERIFIED = [{"kind": "all_analyses_in_state", "value": "verified,published", "note": None}]


# ── fully verified: no phantom pending lines ────────────────────────────────

def test_verified_blend_has_exactly_three_lines_all_verified(db):
    parent, svc = _blend(db, canonical={1: "verified", 2: "verified", 3: "verified"})
    for states in (native_parent_line_states(db, parent.sample_id),
                   _live_parent_line_states(db, parent)):
        assert states == {_k(svc, 1): "verified", _k(svc, 2): "verified", _k(svc, 3): "verified"}
        # The regression: the placeholders re-entered under the bare keyword.
        assert "HPLC-PURITY" not in states


# ── one slot verified, two still on the vial ────────────────────────────────

def test_unpromoted_slots_read_as_pending_not_hidden_by_a_verified_sibling(db):
    parent, svc = _blend(db, canonical={1: "verified"})
    for states in (native_parent_line_states(db, parent.sample_id),
                   _live_parent_line_states(db, parent)):
        assert states == {_k(svc, 1): "verified",
                          _k(svc, 2): "unassigned", _k(svc, 3): "unassigned"}


def test_sample_does_not_cascade_to_verified_with_slots_still_on_the_vial(db):
    """The gate that drives the sample-tier status. Keyed by keyword this
    passed with one of three peptides verified."""
    parent, _ = _blend(db, canonical={1: "verified"})
    met, outcomes = evaluate_requirements(db, parent, ALL_VERIFIED)
    assert met is False, outcomes

    done, _ = _blend(db, canonical={1: "verified", 2: "verified", 3: "verified"},
                     sample_id="PB-7001")
    met, outcomes = evaluate_requirements(db, done, ALL_VERIFIED)
    assert met is True, outcomes


# ── slot-less rows: unchanged ───────────────────────────────────────────────

def test_slotless_placeholder_is_still_covered_by_its_canonical_row(db):
    parent = LimsSample(sample_id="P-7002", external_lims_uid=None)
    svc = AnalysisService(title="Endotoxin", keyword="ENDO-LAL", origin="mk1")
    db.add_all([parent, svc])
    db.flush()
    db.add_all([
        LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id, keyword="ENDO-LAL",
                     title="Endotoxin", provenance=PROVENANCE_ORDERED, review_state="unassigned"),
        LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id, keyword="ENDO-LAL",
                     title="Endotoxin", provenance="canonical", review_state="verified"),
    ])
    db.commit()
    assert native_parent_line_states(db, "P-7002") == {"ENDO-LAL": "verified"}
    assert _live_parent_line_states(db, parent) == {"ENDO-LAL": "verified"}
