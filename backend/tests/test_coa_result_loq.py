"""The result's own LOQ on the COA (endo slice 3, spec
docs/superpowers/specs/2026-10-12-endo-slice3-promote-loq-design.md sections 6,
7 and 10): the effective LOQ is the result's (lims_analyses.loq) when set,
else the spec row's. It decides "< LOQ" and rides specification.loq, the field
coabuilder's LOQ column and the digital COA already read. A result with no
spec in its own unit stops the COA. Heavy metals print exactly as before.
fetch_sample_services is monkeypatched (test_native_sections.py's helpers)."""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from coa.native_sections import NativeSectionsError, build_native_sections, effective_loq
from models import AnalysisServiceSpec, LimsAnalysis, LimsSample
from tests.test_native_sections import _mk_native_profile, _mk_parent_with_rows, _order_lookup


def _endo(db, *, peptide_spec=True):
    """Service 281's shape on a native profile: the catch-all 0 to 5 EU/mL
    with LOQ 2.5, bac water 0 to 0.25 EU/mL with LOQ 0.2, and (launch step
    2) Peptide 0 to 350 EU/vial with no LOQ of its own."""
    _prof, [svc] = _mk_native_profile(db, key="endotoxin",
                                      services=[("ENDOTOXIN-USP85LAL", "mk1")], specs=False)
    svc.title, svc.unit = "Endotoxin USP85 LAL", "EU/mL"
    rows = [(None, "5", "EU/mL", "2.5"), ("Bacteriostatic Water", "0.25", "EU/mL", "0.2")]
    if peptide_spec:
        rows.append(("Peptide", "350", "EU/vial", None))
    for matrix, hi, unit, loq in rows:
        db.add(AnalysisServiceSpec(analysis_service_id=svc.id, matrix=matrix, rule_kind="range",
                                   min_value=Decimal("0"), max_value=Decimal(hi), unit=unit,
                                   loq=Decimal(loq) if loq else None))
    db.flush()
    return svc


def _endo_parent(db, svc, value, *, unit="EU/vial", loq=None, lod=None, sample_type="Peptide",
                 result_floor=None):
    """A parent with one verified, promoted endotoxin result."""
    parent = LimsSample(sample_id="P-8001", sample_type_title=sample_type)
    db.add(parent)
    db.flush()
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                        keyword=svc.keyword, title=svc.title, result_value=value,
                        result_unit=unit, review_state="verified", provenance="canonical",
                        loq=loq, lod=lod, lod_unit="EU/mL" if lod is not None else None,
                        result_floor=result_floor))
    db.flush()
    return parent


def _wire_row(db, parent, monkeypatch, key="endotoxin"):
    _order_lookup(monkeypatch, key=key)
    [section] = build_native_sections(db, parent)["sections"]
    [row] = section["rows"]
    return row


def test_effective_loq_prefers_the_results_own():
    spec = SimpleNamespace(loq=Decimal("2.5"))
    assert effective_loq(SimpleNamespace(loq=25.0), spec) == 25.0
    assert effective_loq(SimpleNamespace(loq=None), spec) == 2.5
    assert effective_loq(SimpleNamespace(loq=None), SimpleNamespace(loq=None)) is None


def test_a_below_loq_result_prints_less_than_loq_with_its_own_loq(db_session, monkeypatch):
    # "<25 EU/vial" is stored as 25 with LOQ 25 (spec section 4).
    svc = _endo(db_session)
    parent = _endo_parent(db_session, svc, "25", loq=25.0, lod=0.05)
    row = _wire_row(db_session, parent, monkeypatch)
    assert (row["result"], row["unit"], row["result_display"], row["conforms"]) == (
        "25", "EU/vial", "< LOQ", True)
    assert row["specification"] == {"rule_kind": "range", "equals": None, "min": 0.0,
                                    "max": 350.0, "unit": "EU/vial", "display": None,
                                    "loq": 25.0}


def test_a_result_above_its_own_loq_prints_the_number(db_session, monkeypatch):
    svc = _endo(db_session)
    parent = _endo_parent(db_session, svc, "400", loq=25.0, lod=0.05)
    row = _wire_row(db_session, parent, monkeypatch)
    assert (row["result_display"], row["conforms"], row["specification"]["loq"]) == (
        None, False, 25.0)


def test_a_result_without_its_own_loq_keeps_the_specs(db_session, monkeypatch):
    # An EU/mL result from the older prep: judged by the catch-all, censored at its LOQ.
    svc = _endo(db_session)
    parent = _endo_parent(db_session, svc, "2.5", unit="EU/mL")
    row = _wire_row(db_session, parent, monkeypatch)
    assert (row["specification"]["max"], row["specification"]["loq"], row["result_display"]) == (
        5.0, 2.5, "< LOQ")


def test_a_result_with_no_unit_of_its_own_is_judged_in_its_services_unit(db_session, monkeypatch):
    # Review Focus 3: a NULL result unit falls back to the service's (EU/mL),
    # so the catch-all judges it, never the Peptide EU/vial row.
    svc = _endo(db_session)
    parent = _endo_parent(db_session, svc, "2.5", unit=None)
    row = _wire_row(db_session, parent, monkeypatch)
    assert (row["unit"], row["specification"]["max"], row["specification"]["loq"],
            row["result_display"]) == ("EU/mL", 5.0, 2.5, "< LOQ")


def test_bac_water_is_judged_by_its_own_eu_ml_row(db_session, monkeypatch):
    svc = _endo(db_session)
    parent = _endo_parent(db_session, svc, "0.2", unit="EU/mL", loq=0.2, lod=0.01,
                          sample_type="Bacteriostatic Water")
    row = _wire_row(db_session, parent, monkeypatch)
    assert (row["specification"]["max"], row["specification"]["loq"], row["result_display"],
            row["conforms"]) == (0.25, 0.2, "< LOQ", True)


def test_a_blend_is_judged_by_the_peptide_eu_vial_row(db_session, monkeypatch):
    svc = _endo(db_session)
    parent = _endo_parent(db_session, svc, "40", loq=25.0, lod=0.05, sample_type="Peptide Blend")
    row = _wire_row(db_session, parent, monkeypatch)
    assert (row["specification"]["max"], row["conforms"], row["result_display"]) == (
        350.0, True, None)


def test_no_spec_in_the_results_unit_stops_the_coa(db_session, monkeypatch):
    svc = _endo(db_session, peptide_spec=False)
    parent = _endo_parent(db_session, svc, "25", loq=25.0, lod=0.05)
    _order_lookup(monkeypatch, key="endotoxin")
    with pytest.raises(NativeSectionsError,
                       match="No active Endotoxin USP85 LAL spec in EU/vial for Peptide"):
        build_native_sections(db_session, parent)


def test_heavy_metals_print_exactly_as_before(db_session, monkeypatch):
    _prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                     services=[("HM-PB", "mk1")], specs=False)
    db_session.add(AnalysisServiceSpec(analysis_service_id=svcs[0].id, matrix=None,
                                       rule_kind="range", max_value=Decimal("100"),
                                       loq=Decimal("0.5"), unit="ppm"))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="0.2")
    row = _wire_row(db_session, parent, monkeypatch, key="heavy_metals")
    assert row == {"keyword": "HM-PB", "name": "Hm-Pb", "result": "0.2", "unit": "ppm",
                   "method": "",
                   "specification": {"rule_kind": "range", "equals": None, "min": None,
                                     "max": 100.0, "unit": "ppm", "display": None,
                                     "loq": 0.5},
                   "conforms": True, "result_display": "< LOQ"}


def test_an_equals_row_never_takes_a_result_loq(db_session, monkeypatch):
    _prof, svcs = _mk_native_profile(db_session, key="sterility_usp71",
                                     services=[("STERILITY_USP71", "mk1")], specs=False)
    db_session.add(AnalysisServiceSpec(analysis_service_id=svcs[0].id, matrix=None,
                                       rule_kind="equals", equals_value="Not Detected"))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="Not Detected")
    db_session.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id).one().loq = 5.0
    db_session.flush()
    row = _wire_row(db_session, parent, monkeypatch, key="sterility_usp71")
    assert (row["specification"]["loq"], row["result_display"], row["conforms"]) == (
        None, None, True)


# ─── A ">" reading on the certificate (the endo floor slice) ─────────────────
#
# A floor is the mirror of the LOQ censor above, with one asymmetry that
# decides the whole design: a "<" value is an UPPER bound, so judging it
# against a maximum is conservative (if the ceiling passes, the truth passes).
# A ">" value is a LOWER bound, so judging it the ordinary way is
# anti-conservative. Bounds are inclusive, which makes the boundary case a
# silent-wrong-certificate: 350 against a 0 to 350 spec reads as Conforms.


def test_a_floor_prints_its_qualifier_and_does_not_conform(db_session, monkeypatch):
    # ">5" on the 0.05 cartridge at 1:250 and 2 mL: at least 2500 EU/vial.
    svc = _endo(db_session)
    parent = _endo_parent(db_session, svc, "2500", loq=25.0, lod=0.05, result_floor=True)
    row = _wire_row(db_session, parent, monkeypatch)
    assert (row["result"], row["unit"], row["result_display"], row["conforms"]) == (
        "2500", "EU/vial", "> 2500", False)
    # The LOQ still rides the row and still gets its column; the floor is by
    # definition above it, so the "< LOQ" rule can never censor the ">" away.
    assert row["specification"]["loq"] == 25.0


def test_a_floor_exactly_at_the_limit_does_not_conform(db_session, monkeypatch):
    """The trap. ">0.7" scales to exactly 350 against a 0 to 350 spec. Bounds
    are inclusive, so an ordinary verdict would print CONFORMS on a sample
    known to hold AT LEAST the limit. "At least 350" is not a pass."""
    svc = _endo(db_session)
    parent = _endo_parent(db_session, svc, "350", loq=25.0, lod=0.05, result_floor=True)
    row = _wire_row(db_session, parent, monkeypatch)
    assert (row["result_display"], row["conforms"]) == ("> 350", False)


def test_the_same_number_measured_rather_than_a_floor_conforms(db_session, monkeypatch):
    # The control for the test above: 350 measured is a pass, 350 as a floor
    # is not. Only result_floor tells them apart.
    svc = _endo(db_session)
    parent = _endo_parent(db_session, svc, "350", loq=25.0, lod=0.05)
    row = _wire_row(db_session, parent, monkeypatch)
    assert (row["result_display"], row["conforms"]) == (None, True)


@pytest.mark.parametrize("value, why", [
    ("250", "350 upper limit"),       # a floor that stops short of the limit
    ("2500", "absent upper limit"),   # a spec with nothing for a floor to reach
])
def test_a_floor_that_cannot_be_judged_stops_the_certificate(db_session, monkeypatch,
                                                             value, why):
    """No verdict may be emitted from a floor below the limit: the true value
    could be either side of it. The worksheet promote refuses such a row, so
    this is defence — and it fails closed, never printing a guess."""
    svc = _endo(db_session)
    if "absent" in why:
        db_session.query(AnalysisServiceSpec).filter_by(
            analysis_service_id=svc.id, matrix="Peptide").one().max_value = None
        db_session.flush()
    parent = _endo_parent(db_session, svc, value, loq=25.0, lod=0.05, result_floor=True)
    with pytest.raises(NativeSectionsError) as e:
        _wire_row(db_session, parent, monkeypatch)
    assert "floor" in str(e.value) and why in str(e.value)


def test_the_analyses_table_judges_a_floor_the_way_the_certificate_does(db_session):
    """display_spec_fields feeds the analyses table, and its docstring's
    contract is that the table can never disagree with the COA. A floor the
    certificate marks non-conforming must not show a green Conforms."""
    from coa.spec_rules import display_spec_fields

    svc = _endo(db_session)
    common = dict(service_id=svc.id, matrix="Peptide", peptide_id=None, unit="EU/vial")
    assert display_spec_fields(db_session, wire_result="350", **common)["conforms"] is True
    assert display_spec_fields(db_session, wire_result="350", floor=True,
                               **common)["conforms"] is False
    # Fail-soft, unlike the certificate: a floor it cannot judge ships no
    # verdict instead of aborting the page.
    assert display_spec_fields(db_session, wire_result="250", floor=True,
                               **common)["conforms"] is None
