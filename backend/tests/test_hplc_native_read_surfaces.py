import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.hplc_native import KW_PURITY
from lims_analyses.service import (apply_transition, promote_to_parent, list_native_parent_analyses,
                                   list_native_parent_analyses_senaite_shape, list_parent_analyses_senaite_shape)
from tests.hplc_native_family import native_family


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:"); Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try: yield s
    finally: s.close()


def _two_slot_family(db, sid):
    parent, services, peps, vial_rows = native_family(db, sample_id=sid,
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    rows = next(iter(vial_rows.values()))
    pur1, pur2 = sorted((r for r in rows if r.keyword == KW_PURITY), key=lambda r: r.slot)
    return parent, services, pur1, pur2


def test_native_list_keeps_both_slots(db):
    # NOTE (deviation from brief's literal sketch): list_native_parent_analyses
    # is parent-tier + provenance='canonical' only (see its docstring) -- a
    # vial-tier row never appears there, so both slots must first be promoted
    # to parent before the dedup-key fix (service, slot) has anything to keep
    # apart. Without the fix both promotions would collapse onto one
    # "current" row keyed by analysis_service_id alone.
    parent, services, pur1, pur2 = _two_slot_family(db, "PB-1201")
    apply_transition(db, analysis_id=pur1.id, kind="submit", result_value="98", user_id=1, commit=False)
    apply_transition(db, analysis_id=pur2.id, kind="submit", result_value="96", user_id=1, commit=False)
    promote_to_parent(db, keyword=KW_PURITY, result_value="98", result_unit="%", method_id=None, instrument_id=None,
                      sources=[{"analysis_id": pur1.id, "contribution_kind": "chosen"}], user_id=1, commit=False)
    promote_to_parent(db, keyword=KW_PURITY, result_value="96", result_unit="%", method_id=None, instrument_id=None,
                      sources=[{"analysis_id": pur2.id, "contribution_kind": "chosen"}], user_id=1, commit=False)
    db.commit()
    # NativeParentAnalysisRow (the card's own display shape) carries no slot
    # field -- adapt the brief's `r.slot` assertion to what's actually on the
    # shape: two distinct current PURITY rows survive, one per promoted slot,
    # instead of collapsing onto a single "current" row for the shared
    # analysis_service_id.
    out = list_native_parent_analyses(db, "PB-1201")
    purity = [r for r in out if r.keyword == KW_PURITY]
    assert len(purity) == 2
    assert sorted(r.result_value for r in purity) == ["96", "98"]


def test_canonical_slot1_does_not_suppress_slot2_placeholder(db):
    parent, services, pur1, pur2 = _two_slot_family(db, "PB-1202")
    apply_transition(db, analysis_id=pur1.id, kind="submit", result_value="98", user_id=1, commit=False)
    # Vial-tier rows cannot self-verify (TierMismatchError) -- promote_to_parent
    # only requires the source at 'to_be_verified' (submit's target state), so
    # skip straight to promotion, matching test_hplc_native_promote_slots.py's
    # _submit_verify helper convention.
    promote_to_parent(db, keyword=KW_PURITY, result_value="98", result_unit="%", method_id=None, instrument_id=None,
                      sources=[{"analysis_id": pur1.id, "contribution_kind": "chosen"}], user_id=1, commit=False)
    db.commit()
    for fn in (list_native_parent_analyses_senaite_shape, list_parent_analyses_senaite_shape):
        shaped = fn(db, "PB-1202")
        purity = [r for r in shaped if r.keyword == KW_PURITY]
        assert {(r.slot, r.provenance) for r in purity} == {(1, "canonical"), (2, "ordered")}


def test_overlay_is_slot_scoped(db):
    parent, services, pur1, pur2 = _two_slot_family(db, "PB-1203")
    apply_transition(db, analysis_id=pur1.id, kind="submit", result_value="98", user_id=1, commit=False)
    db.commit()
    shaped = list_native_parent_analyses_senaite_shape(db, "PB-1203")
    by_slot = {r.slot: r.review_state for r in shaped if r.keyword == KW_PURITY}
    assert by_slot[1] == "to_be_verified" and by_slot[2] == "unassigned"


def test_remove_slot2_placeholder_leaves_slot1_vial_rows(db):
    from lims_analyses.manage_native import remove_parent_native_analysis
    from models import LimsAnalysis
    from sqlalchemy import select
    parent, services, pur1, pur2 = _two_slot_family(db, "PB-1301")
    ph2 = db.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == parent.id,
                                                LimsAnalysis.keyword == KW_PURITY, LimsAnalysis.slot == 2)).scalar_one()
    pur1_id, pur2_id = pur1.id, pur2.id
    remove_parent_native_analysis(db, parent=parent, analysis_id=ph2.id, confirm=False, user_id=1)
    pur1_after = db.get(LimsAnalysis, pur1_id)
    assert pur1_after is not None and pur1_after.review_state == "unassigned"  # slot 1 untouched
    assert db.get(LimsAnalysis, pur2_id) is None                   # slot 2 pristine row deleted


def test_delete_pristine_requires_slot_on_multislot_vial(db):
    from lims_analyses.service import delete_pristine_analysis, BadRequestError
    parent, services, pur1, pur2 = _two_slot_family(db, "PB-1302")
    with pytest.raises(BadRequestError):
        delete_pristine_analysis(db, sub_sample_pk=pur1.lims_sub_sample_pk, keyword=KW_PURITY, user_id=1)
    delete_pristine_analysis(db, sub_sample_pk=pur1.lims_sub_sample_pk, keyword=KW_PURITY, user_id=1, slot=1)
    db.refresh(pur2)
    assert pur2.review_state == "unassigned"
