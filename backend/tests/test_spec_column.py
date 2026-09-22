"""Spec column on the analyses table (slice 22).

Every row ships its active spec + verdict, resolved by the SAME
resolve_spec / evaluate the certificate is built from, so the table can never
disagree with the COA. P-5010 (2026-09-21): purity 97 against a 98 minimum
was only visible as non-conforming once the COA was generated.

Also here: the native-born SENAITE-attach gate (same slice).
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from coa.spec_rules import display_spec_fields
from database import Base
from lims_analyses.hplc_native import KW_IDENTITY, KW_PURITY, KW_QUANTITY
from lims_analyses.service import (
    apply_transition, list_analyses_in_senaite_shape, list_parent_analyses_senaite_shape,
    promote_to_parent,
)
from models import AnalysisServiceSpec, LimsSample
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


def _family(db, sample_id="P-7300", slots=(("Cagrilintide", "CAGRI"),)):
    parent, services, peps, vial_rows = native_family(db, sample_id=sample_id, slots=list(slots))
    vial_pk, rows = next(iter(vial_rows.items()))
    return parent, services, peps, vial_pk, rows


def _submit(db, row, value):
    apply_transition(db, analysis_id=row.id, kind="submit", result_value=value, user_id=1)
    db.refresh(row)
    return row


def _by_kw(shaped):
    return {(r.keyword, r.slot): r for r in shaped}


# --- the pure helper ---------------------------------------------------------

def test_range_spec_passes_and_fails(db):
    _, services, *_ = _family(db)
    sid = services[KW_PURITY].id
    ok = display_spec_fields(db, service_id=sid, matrix="Peptide", peptide_id=None, wire_result="99.2")
    bad = display_spec_fields(db, service_id=sid, matrix="Peptide", peptide_id=None, wire_result="97")
    assert ok["conforms"] is True and bad["conforms"] is False
    assert (bad["specification"]["rule_kind"], bad["specification"]["min"]) == ("range", 98.0)


def test_pending_informational_and_unrunnable_rules_have_no_verdict(db):
    _, services, *_ = _family(db)
    pur, qty = services[KW_PURITY].id, services[KW_QUANTITY].id
    pending = display_spec_fields(db, service_id=pur, matrix=None, peptide_id=None, wire_result=None)
    info = display_spec_fields(db, service_id=qty, matrix=None, peptide_id=None, wire_result="2")
    # The COA fails closed here (SpecRuleError aborts generation); a table renders.
    garbage = display_spec_fields(db, service_id=pur, matrix=None, peptide_id=None, wire_result="n/a")
    for out in (pending, info, garbage):
        assert out["specification"] is not None and out["conforms"] is None
    assert info["specification"]["rule_kind"] == "informational"


def test_no_spec_and_no_service_ship_nothing(db):
    _, services, *_ = _family(db)
    db.query(AnalysisServiceSpec).filter_by(analysis_service_id=services[KW_PURITY].id).delete()
    db.commit()
    assert display_spec_fields(db, service_id=services[KW_PURITY].id, matrix=None,
                               peptide_id=None, wire_result="97") == {}
    assert display_spec_fields(db, service_id=None, matrix=None, peptide_id=None, wire_result="97") == {}


def test_a_peptide_tier_spec_beats_the_wildcard_and_the_cache_is_per_peptide(db):
    _, services, peps, *_ = _family(db, slots=(("KPV", "KPV"), ("GHK-Cu", "GHK")))
    sid = services[KW_PURITY].id
    db.add(AnalysisServiceSpec(analysis_service_id=sid, peptide_id=peps[2].id, rule_kind="range",
                               min_value=95, unit="%"))
    db.commit()
    cache: dict = {}
    slot1 = display_spec_fields(db, service_id=sid, matrix=None, peptide_id=peps[1].id,
                                wire_result="97", cache=cache)
    slot2 = display_spec_fields(db, service_id=sid, matrix=None, peptide_id=peps[2].id,
                                wire_result="97", cache=cache)
    assert (slot1["specification"]["min"], slot1["conforms"]) == (98.0, False)
    assert (slot2["specification"]["min"], slot2["conforms"]) == (95.0, True)
    assert len(cache) == 2


# --- through the shared serializer: vial rows AND parent rows ------------------

def test_vial_rows_and_parent_rows_carry_the_same_spec_and_verdict(db):
    parent, _, _, vial_pk, rows = _family(db)
    by = {r.keyword: r for r in rows}
    _submit(db, by[KW_IDENTITY], "Conforms")
    _submit(db, by[KW_PURITY], "97")
    _submit(db, by[KW_QUANTITY], "2")

    vial = _by_kw(list_analyses_in_senaite_shape(db, host_kind="sub_sample", host_pk=vial_pk))
    assert vial[(KW_PURITY, 1)].conforms is False            # the P-5010 case
    assert vial[(KW_PURITY, 1)].specification["min"] == 98.0
    assert vial[(KW_IDENTITY, 1)].conforms is True
    assert vial[(KW_QUANTITY, 1)].conforms is None           # informational
    assert vial[(KW_QUANTITY, 1)].specification["display"] == "As measured"

    promote_to_parent(db, keyword=KW_PURITY, result_value="97", result_unit=None, method_id=None,
                      instrument_id=None, user_id=1,
                      sources=[{"analysis_id": by[KW_PURITY].id, "contribution_kind": "chosen"}])
    shaped = [r for r in list_parent_analyses_senaite_shape(db, parent.sample_id)
              if r.keyword == KW_PURITY and r.provenance == "canonical"]
    assert [(r.conforms, r.specification["min"]) for r in shaped] == [(False, 98.0)]


def test_an_unresulted_row_shows_its_spec_with_no_verdict(db):
    _, _, _, vial_pk, _ = _family(db)
    vial = _by_kw(list_analyses_in_senaite_shape(db, host_kind="sub_sample", host_pk=vial_pk))
    row = vial[(KW_PURITY, 1)]
    assert row.specification["min"] == 98.0 and row.conforms is None


def test_the_lookup_row_model_keeps_the_fields():
    """registry-details re-types rows to SenaiteAnalysis; an undeclared field
    is silently dropped there (the response_model trap)."""
    from sub_samples.lookup_models import SenaiteAnalysis
    row = SenaiteAnalysis(title="x", specification={"rule_kind": "range", "min": 98.0}, conforms=False)
    dumped = row.model_dump()
    assert dumped["conforms"] is False and dumped["specification"]["min"] == 98.0


# --- SENAITE attach gate -------------------------------------------------------

def test_senaite_is_not_called_for_a_native_born_sample_or_its_vials(db):
    from main import _senaite_has_no_ar
    _family(db, sample_id="P-7310")
    db.add(LimsSample(sample_id="P-0456", external_lims_system="senaite"))
    db.commit()
    assert _senaite_has_no_ar(db, "P-7310") is True
    assert _senaite_has_no_ar(db, "P-7310-S01") is True        # vial COA of a native parent
    assert _senaite_has_no_ar(db, "P-0456") is False           # legacy: keep attaching
    assert _senaite_has_no_ar(db, "P-0456-S02") is False
    assert _senaite_has_no_ar(db, "P-9999") is False           # unknown: legacy behaviour
