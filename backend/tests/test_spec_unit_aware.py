"""Unit-aware specs (endo slice 3, spec
docs/superpowers/specs/2026-10-12-endo-slice3-promote-loq-design.md sections 6
and 10): one active spec per scope and unit, resolve_spec choosing by the
result's unit, the cases pinned for Dennis, unit spellings and NULL-unit rows
(Review Focus 3), the analyses table's Spec column and the boot list's index
swap. The Postgres half of the swap is tests/test_spec_unit_indexes_pg.py."""
import re
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy.exc import IntegrityError, MultipleResultsFound

import database
from coa.spec_rules import (display_spec_fields, effective_unit, normalize_matrix,
                            normalize_unit, resolve_spec)
from models import AnalysisService, AnalysisServiceSpec  # noqa: F401  (register tables before conftest's create_all)
from tests.test_hplc_native_schema import _captured
from tests.test_spec_rules import _mk_peptide, _mk_service, _mk_spec

_RANGE = {"rule_kind": "range", "min_value": Decimal("0")}


def _endo(db):
    """Service 281's active rows as production held them on 2026-10-12 (spec
    section 3), plus the Peptide 0 to 350 EU/vial row of launch step 2."""
    svc = AnalysisService(title="Endotoxin USP85 LAL", keyword="ENDOTOXIN-USP85LAL",
                          origin="mk1", unit="EU/mL")
    db.add(svc)
    db.flush()
    pep = _mk_peptide(db, "BPC157")
    return SimpleNamespace(
        svc=svc, pep=pep,
        catch_all=_mk_spec(db, svc, max_value=Decimal("5"), unit="EU/mL",
                           loq=Decimal("2.5"), **_RANGE),
        bac=_mk_spec(db, svc, matrix="Bacteriostatic Water", max_value=Decimal("0.25"),
                     unit="EU/mL", loq=Decimal("0.2"), **_RANGE),
        per_peptide=_mk_spec(db, svc, peptide_id=pep.id, max_value=Decimal("5"),
                             unit="EU/mL", loq=Decimal("2.5"), **_RANGE),
        vial=_mk_spec(db, svc, matrix="Peptide", max_value=Decimal("350"),
                      unit="EU/vial", **_RANGE),
    )


def _r(db, w, matrix, unit, peptide_id=None):
    return resolve_spec(db, w.svc.id, matrix, peptide_id=peptide_id, unit=unit)


def _specs_of(db, svc):
    """The service's spec rows as stored, re-read from the database."""
    return db.query(AnalysisServiceSpec).filter(
        AnalysisServiceSpec.analysis_service_id == svc.id).order_by(AnalysisServiceSpec.id).all()


# --- normalization ----------------------------------------------------------

@pytest.mark.parametrize("raw, expected", [
    ("EU/Vial", "eu/vial"), (" eu/vial ", "eu/vial"), (None, ""), ("", "")])
def test_normalize_unit_trims_and_lowers(raw, expected):
    assert normalize_unit(raw) == expected


@pytest.mark.parametrize("result_unit, service_unit, expected", [
    ("EU/vial", "EU/mL", "eu/vial"),
    (None, "EU/mL", "eu/ml"),          # a vial row carries no unit until promote stamps one
    ("  ", " EU/mL ", "eu/ml"),        # a whitespace-only unit is none
    ("", None, ""),
    (None, None, ""),
])
def test_effective_unit_is_the_results_own_else_its_services(result_unit, service_unit, expected):
    assert effective_unit(result_unit, service_unit) == expected


# --- the cases pinned for Dennis (spec section 10) ---------------------------

def test_bac_water_eu_ml_resolves_0_25_never_5_or_350(db_session):
    w = _endo(db_session)
    assert _r(db_session, w, "Bacteriostatic Water", "EU/mL") is w.bac
    # Bac water is never judged per vial: no EU/vial row in its scope or the catch-all.
    assert _r(db_session, w, "Bacteriostatic Water", "EU/vial") is None


def test_peptide_eu_vial_resolves_350_even_past_an_eu_ml_per_peptide_row(db_session):
    w = _endo(db_session)
    assert _r(db_session, w, "Peptide", "EU/vial") is w.vial
    # The per-peptide row is EU/mL: an EU/vial result falls through to the Peptide row.
    assert _r(db_session, w, "Peptide", "EU/vial", peptide_id=w.pep.id) is w.vial


def test_peptide_eu_ml_from_the_older_prep_still_resolves_5(db_session):
    w = _endo(db_session)
    assert _r(db_session, w, "Peptide", "EU/mL") is w.catch_all
    assert _r(db_session, w, "Peptide", "EU/mL", peptide_id=w.pep.id) is w.per_peptide


@pytest.mark.parametrize("matrix", ["Capsule", None])
def test_a_sample_type_matching_nothing_gets_the_catch_all_only_in_its_own_unit(db_session, matrix):
    w = _endo(db_session)
    assert _r(db_session, w, matrix, "EU/mL") is w.catch_all
    assert _r(db_session, w, matrix, "EU/vial") is None


def test_a_blend_resolves_as_peptide(db_session):
    w = _endo(db_session)
    blend = normalize_matrix("Peptide Blend")
    assert _r(db_session, w, blend, "EU/vial") is w.vial
    assert _r(db_session, w, blend, "EU/mL") is w.catch_all


# --- Review Focus 3: spellings, NULL units, the catalog-unit fallback --------

@pytest.mark.parametrize("unit", ["EU/vial", "EU/Vial", " eu/VIAL ", "EU/VIAL"])
def test_unit_spellings_in_results_are_one_unit(db_session, unit):
    w = _endo(db_session)
    assert _r(db_session, w, "Peptide", unit) is w.vial


def test_unit_spellings_in_spec_rows_are_one_unit(db_session):
    svc = _mk_service(db_session, keyword="ENDO-SPELLING")
    vial = _mk_spec(db_session, svc, matrix="Peptide", unit=" EU/Vial ",
                    max_value=Decimal("350"), **_RANGE)
    _mk_spec(db_session, svc, unit="EU/mL", max_value=Decimal("5"), **_RANGE)
    assert resolve_spec(db_session, svc.id, "Peptide", unit="eu/vial") is vial


def test_null_unit_rows_match_only_an_empty_unit_once_a_service_files_units(db_session):
    """A NULL-unit spec row matches only a result whose effective unit is
    also empty, whenever the service files a row in the result's unit."""
    svc = _mk_service(db_session, keyword="MOISTURE-UNITS")      # catalog unit NULL
    wild = _mk_spec(db_session, svc, unit=None, max_value=Decimal("1"), **_RANGE)
    mg = _mk_spec(db_session, svc, matrix="Peptide", unit="mg", max_value=Decimal("2"), **_RANGE)
    assert resolve_spec(db_session, svc.id, None, unit="") is wild
    assert resolve_spec(db_session, svc.id, "Peptide", unit="") is wild   # never the mg row
    assert resolve_spec(db_session, svc.id, "Peptide", unit="mg") is mg
    assert resolve_spec(db_session, svc.id, None, unit="mg") is None       # never the NULL row
    assert resolve_spec(db_session, svc.id, "Peptide", unit="ppm") is None


def test_a_result_in_its_catalog_unit_keeps_todays_lookup_when_no_spec_is_filed_in_it(db_session):
    """Heavy metals and sterility print exactly as before: a spec filed as
    "µg/g" (prod HM, COA 8BRR-G7EF) or with no unit (STERILITY_USP71,
    catalog/service_spec_seed.py:22-24) keeps judging results in the
    service's catalog unit. A result in a third unit resolves nothing."""
    hm = AnalysisService(title="Lead", keyword="HM-PB-UNITS", origin="mk1", unit="ppm")
    ster = AnalysisService(title="Sterility", keyword="STER-UNITS", origin="mk1", unit="Pos/Neg")
    db_session.add_all([hm, ster])
    db_session.flush()
    lead = _mk_spec(db_session, hm, unit="µg/g", max_value=Decimal("0.5"), **_RANGE)
    sterile = _mk_spec(db_session, ster, rule_kind="equals", max_value=None,
                       equals_value="Not Detected", unit=None)
    assert resolve_spec(db_session, hm.id, "Peptide", unit="ppm") is lead
    assert resolve_spec(db_session, ster.id, None, unit="Pos/Neg") is sterile
    assert resolve_spec(db_session, hm.id, None, unit="mg/kg") is None


def test_before_launch_an_eu_vial_result_resolves_nothing_never_the_eu_ml_row(db_session):
    w = _endo(db_session)
    w.vial.active = False      # launch step 2 not done yet, or rolled back (spec 9)
    db_session.flush()
    assert _r(db_session, w, "Peptide", "EU/vial") is None
    assert _r(db_session, w, "Peptide", "EU/vial", peptide_id=w.pep.id) is None


def test_without_a_unit_two_active_rows_in_one_scope_raise(db_session):
    w = _endo(db_session)
    peptide_ml = _mk_spec(db_session, w.svc, matrix="Peptide", unit="EU/mL",
                          max_value=Decimal("5"), **_RANGE)
    with pytest.raises(MultipleResultsFound):
        resolve_spec(db_session, w.svc.id, "Peptide")
    assert _r(db_session, w, "Peptide", "EU/mL") is peptide_ml
    assert _r(db_session, w, "Peptide", "EU/vial") is w.vial


# --- the analyses table's Spec column ----------------------------------------

def test_the_spec_column_judges_in_the_rows_unit_and_caches_per_unit(db_session):
    w = _endo(db_session)
    cache: dict = {}
    vial = display_spec_fields(db_session, service_id=w.svc.id, matrix="Peptide", peptide_id=None,
                               wire_result="25", cache=cache, unit="EU/vial")
    ml = display_spec_fields(db_session, service_id=w.svc.id, matrix="Peptide", peptide_id=None,
                             wire_result="25", cache=cache, unit="eu/ml")
    assert (vial["specification"]["max"], vial["specification"]["unit"], vial["conforms"]) == (
        350.0, "EU/vial", True)
    assert (ml["specification"]["max"], ml["specification"]["unit"], ml["conforms"]) == (
        5.0, "EU/mL", False)


# --- one active row per scope and unit (the model's indexes) -----------------

def test_eu_ml_and_eu_vial_rows_stand_side_by_side_in_every_scope(db_session):
    svc = _mk_service(db_session, keyword="ENDO-SCOPES")
    pep = _mk_peptide(db_session, "TB500")
    for scope in ({"matrix": "Peptide"}, {"peptide_id": pep.id}, {}):
        _mk_spec(db_session, svc, unit="EU/mL", **scope)
        _mk_spec(db_session, svc, unit="EU/vial", **scope)   # must not raise
    # All six rows were stored and stay active, two units in each scope.
    assert [(s.matrix, s.peptide_id, s.unit, s.active) for s in _specs_of(db_session, svc)] == [
        ("Peptide", None, "EU/mL", True), ("Peptide", None, "EU/vial", True),
        (None, pep.id, "EU/mL", True), (None, pep.id, "EU/vial", True),
        (None, None, "EU/mL", True), (None, None, "EU/vial", True),
    ]


@pytest.mark.parametrize("first, second", [
    ("EU/vial", " eu/VIAL "), ("EU/Vial", "EU/vial"), (None, ""), (None, "  ")])
def test_a_second_active_row_in_one_scope_and_unit_is_refused(db_session, first, second):
    svc = _mk_service(db_session, keyword="ENDO-DUP")
    _mk_spec(db_session, svc, matrix="Peptide", unit=first)
    with pytest.raises(IntegrityError):
        _mk_spec(db_session, svc, matrix="Peptide", unit=second)
    db_session.rollback()


def test_an_inactive_duplicate_is_history_never_a_conflict(db_session):
    svc = _mk_service(db_session, keyword="ENDO-OFF")
    _mk_spec(db_session, svc, unit="EU/vial")
    _mk_spec(db_session, svc, unit="eu/vial", active=False)   # must not raise
    # Both rows were stored: the active one and its inactive twin.
    assert [(s.unit, s.active) for s in _specs_of(db_session, svc)] == [
        ("EU/vial", True), ("eu/vial", False)]


# --- the boot list -----------------------------------------------------------

def test_the_boot_list_swaps_the_spec_indexes_once_and_never_recreates_the_old_names():
    """The swap runs after the peptide_id column exists, once per boot, and
    no boot statement creates an old name again (a second boot of this image
    changes nothing; the Postgres file proves it on a real database)."""
    swap = database._SPEC_UNIT_INDEX_SWAP
    stmts = _captured()
    assert stmts.count(swap) == 1
    peptide_col_at = next(i for i, s in enumerate(stmts)
                          if "analysis_service_specs ADD COLUMN IF NOT EXISTS peptide_id" in s)
    assert peptide_col_at < stmts.index(swap)
    old_create = re.compile(
        r"CREATE UNIQUE INDEX (IF NOT EXISTS )?uq_analysis_service_specs_(matrix|peptide|wildcard)\s")
    assert not any(old_create.search(s) for s in stmts)
    # Sample forms (task 4): the wildcard index is now the _v2 name, a form
    # tier index joins it, and the previous wildcard_unit name is dropped too.
    for new in ("matrix_unit", "peptide_unit", "form_unit", "wildcard_unit_v2"):
        assert f"CREATE UNIQUE INDEX IF NOT EXISTS uq_analysis_service_specs_{new}\n" in swap
    for old in ("matrix", "peptide", "wildcard", "wildcard_unit"):
        assert f"DROP INDEX IF EXISTS uq_analysis_service_specs_{old};" in swap
    assert swap.count("lower(btrim(coalesce(unit, '')))") == 4
    # Created before the old names go: a failure inside the block keeps the old ones.
    assert swap.rindex("CREATE UNIQUE INDEX") < swap.index("DROP INDEX")
