import pytest
from sqlalchemy import create_engine

from database import Base
from models import LimsAnalysis
from lims_analyses.hplc_native import KW_PURITY, slot_key, kw_slot_key
from lims_analyses.service import apply_transition, promote_to_parent, _find_active_parent_row, parent_retest
from sqlalchemy.orm import sessionmaker
from tests.hplc_native_family import native_family


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _submit_verify(db, row, value):
    # NOTE (deviation from brief's literal helper): vial-tier rows cannot
    # self-verify (TierMismatchError) — only submit takes them to
    # 'to_be_verified', which is exactly the state promote_to_parent
    # requires of its sources. The follow-on 'verify' is done on the
    # PARENT-tier row after promotion, not here.
    apply_transition(db, analysis_id=row.id, kind="submit", result_value=value, user_id=1, commit=False)


def _purity_rows(rows):
    return sorted((r for r in rows if r.keyword == KW_PURITY), key=lambda r: r.slot)


def test_slot_key_helpers():
    class R:  # duck rows
        analysis_service_id = 7; slot = None; keyword = "HPLC-PURITY"
    assert slot_key(R()) == (7, 0) and kw_slot_key(R()) == ("HPLC-PURITY", 0)
    R.slot = 3
    assert slot_key(R()) == (7, 3) and kw_slot_key(R()) == ("HPLC-PURITY", 3)


def test_promote_two_slots_of_same_service_mints_two_parent_rows(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1101",
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    rows = next(iter(vial_rows.values()))
    pur1, pur2 = _purity_rows(rows)
    _submit_verify(db, pur1, "98.1"); _submit_verify(db, pur2, "96.2")
    p1, _ = promote_to_parent(db, keyword=KW_PURITY, result_value="98.1", result_unit="%",
                              method_id=None, instrument_id=None,
                              sources=[{"analysis_id": pur1.id, "contribution_kind": "chosen"}],
                              user_id=1, commit=False)
    p2, _ = promote_to_parent(db, keyword=KW_PURITY, result_value="96.2", result_unit="%",
                              method_id=None, instrument_id=None,
                              sources=[{"analysis_id": pur2.id, "contribution_kind": "chosen"}],
                              user_id=1, commit=False)
    assert (p1.slot, p1.peptide_id, p1.title) == (1, peps[1].id, pur1.title)
    assert (p2.slot, p2.peptide_id, p2.title) == (2, peps[2].id, pur2.title)
    assert p1.id != p2.id and p1.analysis_service_id == p2.analysis_service_id


def test_repromote_supersedes_only_its_own_slot(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1102",
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    rows = next(iter(vial_rows.values()))
    pur1, pur2 = _purity_rows(rows)
    _submit_verify(db, pur1, "98.1"); _submit_verify(db, pur2, "96.2")
    p1, _ = promote_to_parent(db, keyword=KW_PURITY, result_value="98.1", result_unit="%", method_id=None,
                              instrument_id=None, sources=[{"analysis_id": pur1.id, "contribution_kind": "chosen"}],
                              user_id=1, commit=False)
    p2, _ = promote_to_parent(db, keyword=KW_PURITY, result_value="96.2", result_unit="%", method_id=None,
                              instrument_id=None, sources=[{"analysis_id": pur2.id, "contribution_kind": "chosen"}],
                              user_id=1, commit=False)
    apply_transition(db, analysis_id=p2.id, kind="verify", user_id=1, commit=False)
    # retest slot 2's vial row, re-promote it
    child = apply_transition(db, analysis_id=pur2.id, kind="retest", user_id=1, commit=False)
    _submit_verify(db, child, "95.0")
    p2b, _ = promote_to_parent(db, keyword=KW_PURITY, result_value="95.0", result_unit="%", method_id=None,
                               instrument_id=None, sources=[{"analysis_id": child.id, "contribution_kind": "chosen"}],
                               user_id=1, commit=False)
    db.refresh(p1); db.refresh(p2)
    assert p1.review_state == "parent_to_verify"          # slot 1 untouched
    assert p2.review_state == "retracted" and p2b.slot == 2


def test_find_active_parent_row_is_slot_scoped(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1103",
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    rows = next(iter(vial_rows.values()))
    pur1, pur2 = _purity_rows(rows)
    _submit_verify(db, pur1, "98.1"); _submit_verify(db, pur2, "96.2")
    for r in (pur1, pur2):
        promote_to_parent(db, keyword=KW_PURITY, result_value=r.result_value, result_unit="%", method_id=None,
                          instrument_id=None, sources=[{"analysis_id": r.id, "contribution_kind": "chosen"}],
                          user_id=1, commit=False)
    svc_id = services[KW_PURITY].id
    a = _find_active_parent_row(db, parent_sample_pk=parent.id, keyword=KW_PURITY, analysis_service_id=svc_id, slot=1)
    b = _find_active_parent_row(db, parent_sample_pk=parent.id, keyword=KW_PURITY, analysis_service_id=svc_id, slot=2)
    assert a is not None and b is not None and a.id != b.id and (a.slot, b.slot) == (1, 2)
    # No slot on a multi-slot native parent → refuse to guess
    assert _find_active_parent_row(db, parent_sample_pk=parent.id, keyword=KW_PURITY, analysis_service_id=svc_id) is None


def test_parent_retest_with_slot_unpromotes_only_that_slot(db):
    parent, services, peps, vial_rows = native_family(db, sample_id="PB-1104",
                                                      slots=[("BPC-157", "BPC157"), ("TB-500", "TB500")])
    rows = next(iter(vial_rows.values()))
    pur1, pur2 = _purity_rows(rows)
    _submit_verify(db, pur1, "98.1"); _submit_verify(db, pur2, "96.2")
    parents = []
    for r in (pur1, pur2):
        p, _ = promote_to_parent(db, keyword=KW_PURITY, result_value=r.result_value, result_unit="%", method_id=None,
                                 instrument_id=None, sources=[{"analysis_id": r.id, "contribution_kind": "chosen"}],
                                 user_id=1, commit=False)
        apply_transition(db, analysis_id=p.id, kind="verify", user_id=1, commit=False)
        parents.append(p)
    db.commit()
    new_ids, state = parent_retest(db, sample_id="PB-1104", keyword=KW_PURITY, user_id=1, reason="t",
                                   analysis_service_id=services[KW_PURITY].id, slot=2)
    db.refresh(parents[0]); db.refresh(parents[1])
    assert parents[0].review_state == "verified"
    assert parents[1].review_state == "retracted"
    assert len(new_ids) == 1 and db.get(LimsAnalysis, new_ids[0]).retest_of_id == pur2.id
