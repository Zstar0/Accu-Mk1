"""MB5: native-born Bac Water rows ride the page-1 legacy-rows wire under
the SENAITE keyword/title GenericAssayEngine reads, gated by the owning
profile's coa_archetype (legacy_bw), carrying Mk1-owned specification +
conforms. SENAITE-born BW stays byte-identical.

Note: before this task no legacy_rows test exercised the BW keywords at
all; the SENAITE-born byte-identical pin below is new."""
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import coa.legacy_rows as lr
from coa.bw_shim import LEGACY_BW_ARCHETYPE
from coa.hplc_shim import LEGACY_HPLC_ARCHETYPE
from coa.legacy_rows import build_legacy_rows
from coa.native_sections import NativeSectionsError
from database import Base

BW_PROFILE_KEY = "bacteriostatic-water-panel"
LEGACY_TITLES = {
    "PH-DETERM": "pH Determination",
    "Benzyl_Alcohol_Assay": "Benzyl Alcohol Assay (HPLC)",
    "FILL-NET-CONTENT": "Fill volume / Net content",
}


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


# ---------------- gate (unit, no DB; same idiom as the HPLC slice-8 tests) --

def _bw(**over):
    base = dict(
        uid="mk1:11", keyword="PH-BW", title="pH Determination", result="5.5", unit="pH",
        review_state="verified", captured="2026-10-05T00:00:00+00:00",
        service_origin="mk1", peptide_id=None, slot=None, analysis_service_id=951,
    )
    base.update(over)
    return SimpleNamespace(**base)


def _senaite(**over):
    base = dict(
        uid="a" * 32, keyword="PH-DETERM", title="pH Determination", result="5.5",
        unit="", review_state="published", captured="2026-10-05T00:00:00+00:00",
        service_origin="senaite", peptide_id=None, slot=None, analysis_service_id=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


_PARENT = SimpleNamespace(sample_id="BW-1001", external_lims_system="mk1",
                          sample_type_title="Bacteriostatic Water")


def _no_slot_wires(db, parent):
    raise AssertionError("slot_wires must not run for a BW-only sample")


def test_legacy_bw_archetype_admits_and_rekeys(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_bw()])
    monkeypatch.setattr(lr, "slot_wires", _no_slot_wires)
    monkeypatch.setattr(lr, "native_hplc_service_archetypes",
                        lambda db, parent: {951: LEGACY_BW_ARCHETYPE})
    [row] = build_legacy_rows(None, _PARENT)
    assert (row["Keyword"], row["Title"], row["ServiceTitle"]) == ("PH-DETERM", "pH Determination", "pH Determination")


def test_limit_table_archetype_excludes_bw_rows(monkeypatch):
    monkeypatch.setattr(lr, "native_hplc_service_archetypes",
                        lambda db, parent: {951: "limit_table"})
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_bw(), _senaite(keyword="ENDO-LAL")])
    assert [r["Keyword"] for r in build_legacy_rows(None, _PARENT)] == ["ENDO-LAL"]


def test_legacy_hplc_archetype_does_not_admit_a_bw_row(monkeypatch):
    # Archetype must match the ROW's family, not merely be "a legacy one".
    monkeypatch.setattr(lr, "native_hplc_service_archetypes",
                        lambda db, parent: {951: LEGACY_HPLC_ARCHETYPE})
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_bw(), _senaite(keyword="ENDO-LAL")])
    assert [r["Keyword"] for r in build_legacy_rows(None, _PARENT)] == ["ENDO-LAL"]


def test_unresolvable_lookup_admits_bw_rows(monkeypatch):
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [_bw()])
    monkeypatch.setattr(lr, "slot_wires", _no_slot_wires)
    monkeypatch.setattr(lr, "native_hplc_service_archetypes", lambda db, parent: None)
    assert [r["Keyword"] for r in build_legacy_rows(None, _PARENT)] == ["PH-DETERM"]


def test_senaite_born_bw_is_byte_identical_and_never_calls_resolver(monkeypatch):
    def _boom(db, parent):
        raise AssertionError("resolver must not run when no native row is present")
    monkeypatch.setattr(lr, "native_hplc_service_archetypes", _boom)
    monkeypatch.setattr(lr, "_shaped_rows", lambda db, sid: [
        _senaite(uid="u1", keyword="PH-DETERM", title="pH Determination",
                 result="5.5", unit=""),
        _senaite(uid="u2", keyword="Benzyl_Alcohol_Assay", title="Benzyl Alcohol Assay",
                 result="0.90", unit="v/v"),
        _senaite(uid="u3", keyword="FILL-NET-CONTENT", title="Fill volume / Net content",
                 result="10.1", unit="mL"),
    ])
    parent = SimpleNamespace(sample_id="BW-0130", sample_type_title="Bacteriostatic Water")
    assert build_legacy_rows(None, parent) == [
        {"uid": "u1", "Keyword": "PH-DETERM", "Title": "pH Determination",
         "ServiceTitle": "pH Determination", "Result": "5.5", "Unit": "",
         "review_state": "published", "ResultCaptureDate": "2026-10-05T00:00:00+00:00"},
        {"uid": "u2", "Keyword": "Benzyl_Alcohol_Assay", "Title": "Benzyl Alcohol Assay",
         "ServiceTitle": "Benzyl Alcohol Assay", "Result": "0.90", "Unit": "v/v",
         "review_state": "published", "ResultCaptureDate": "2026-10-05T00:00:00+00:00"},
        {"uid": "u3", "Keyword": "FILL-NET-CONTENT", "Title": "Fill volume / Net content",
         "ServiceTitle": "Fill volume / Net content", "Result": "10.1", "Unit": "mL",
         "review_state": "published", "ResultCaptureDate": "2026-10-05T00:00:00+00:00"},
    ]


# ---------------- real catalog + real row selection (end to end) ------------

def _native_bw_sample(db, monkeypatch, values=None, external_lims_system="mk1"):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import AnalysisService, Department, LimsAnalysis, LimsSample
    # seed_bw_native_catalog seeds nothing without the Analytical department.
    db.add(Department(name="Analytical"))
    db.flush()
    seed_bw_native_catalog(db)
    for kw, title in LEGACY_TITLES.items():
        db.add(AnalysisService(title=title, keyword=kw, origin="senaite"))
    parent = LimsSample(sample_id="BW-1001", external_lims_system=external_lims_system,
                        sample_type_title="Bacteriostatic Water")
    db.add(parent)
    db.flush()
    values = values or {"PH-BW": "5.5", "BENZYL-ALCOHOL-BW": "0.9",
                        "FILL-VOLUME-BW": "10.1"}
    for kw, value in values.items():
        svc = db.query(AnalysisService).filter_by(keyword=kw, origin="mk1").one()
        db.add(LimsAnalysis(
            lims_sample_pk=parent.id, analysis_service_id=svc.id,
            keyword=svc.keyword, title=svc.title, result_value=value,
            result_unit=svc.unit, review_state="verified", provenance="canonical",
        ))
    db.flush()
    # native_hplc_service_archetypes imports this lazily from sub_samples.service.
    monkeypatch.setattr(
        "sub_samples.service.fetch_sample_services",
        lambda sample_id: {"services": {BW_PROFILE_KEY: True}, "package": None},
    )
    return parent


def test_native_bw_parent_yields_three_legacy_rows_with_specs(db, monkeypatch):
    parent = _native_bw_sample(db, monkeypatch)
    rows = {r["Keyword"]: r for r in build_legacy_rows(db, parent)}
    assert set(rows) == {"PH-DETERM", "Benzyl_Alcohol_Assay", "FILL-NET-CONTENT"}
    for kw, title in LEGACY_TITLES.items():
        assert rows[kw]["Title"] == rows[kw]["ServiceTitle"] == title

    ph, ba, fill = rows["PH-DETERM"], rows["Benzyl_Alcohol_Assay"], rows["FILL-NET-CONTENT"]
    assert (ph["Result"], ph["specification"]["rule_kind"], ph["specification"]["min"],
            ph["specification"]["max"], ph["conforms"]) == ("5.5", "range", 4.5, 7.0, True)
    assert (ba["Result"], ba["specification"]["rule_kind"], ba["specification"]["min"],
            ba["specification"]["max"], ba["conforms"]) == ("0.9", "range", 0.72, 1.08, True)
    # The printed spec cell must match legacy BW certificates exactly; COABuilder
    # prints wire `display` verbatim (native_sections._format_spec_display).
    assert ba["specification"]["display"] == "0.9% (v/v) ±20%"
    assert ph["specification"]["display"] == "4.5 – 7.0"
    assert fill["specification"]["display"] == "\u2014"  # legacy no-spec glyph
    assert (fill["Result"], fill["specification"]["rule_kind"], fill["conforms"]) == (
        "10.1", "informational", None)


def test_out_of_range_ph_ships_conforms_false(db, monkeypatch):
    parent = _native_bw_sample(db, monkeypatch, values={"PH-BW": "7.5"})
    [ph] = build_legacy_rows(db, parent)
    assert (ph["Keyword"], ph["conforms"]) == ("PH-DETERM", False)


def test_pending_native_row_rides_with_no_result_and_unjudged(db, monkeypatch):
    # Review Focus 5: before promote, the parent holds only the registration
    # placeholder ('ordered', no result). It rides page 1 with Result None /
    # conforms None (COABuilder prints NOT TESTED / IN REVIEW); the unchanged
    # resolver pre-flight is what blocks generation.
    from models import LimsAnalysis
    parent = _native_bw_sample(db, monkeypatch, values={"PH-BW": "5.5"})
    row = db.query(LimsAnalysis).filter_by(keyword="PH-BW").one()
    row.result_value, row.review_state, row.provenance = None, "unassigned", "ordered"
    db.flush()
    [ph] = build_legacy_rows(db, parent)
    assert (ph["Keyword"], ph["Result"], ph["conforms"]) == ("PH-DETERM", None, None)
    assert ph["specification"]["rule_kind"] == "range"


def test_profile_rearchetyped_off_legacy_bw_removes_page_one_rows(db, monkeypatch):
    # The gate reads the REAL mapping: re-archetyping the profile away from
    # legacy_bw leaves zero page-1 rows, which hits the fail-closed empty abort.
    from models import AnalysisProfile
    parent = _native_bw_sample(db, monkeypatch)
    db.query(AnalysisProfile).filter_by(key=BW_PROFILE_KEY).one().coa_archetype = "limit_table"
    db.flush()
    with pytest.raises(NativeSectionsError, match="no legacy-family analyses"):
        build_legacy_rows(db, parent)


def _shadow_ph_determ(db, parent, result="6.1"):
    """A live SENAITE mirror row for PH-DETERM on the parent (what every
    SENAITE-born BW parent carries)."""
    from models import AnalysisService, LimsAnalysis
    svc = db.query(AnalysisService).filter_by(keyword="PH-DETERM", origin="senaite").one()
    db.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.title, result_value=result,
        review_state="senaite_mirror", mirror_review_state="published",
        provenance="shadow", retested=False,
    ))
    db.flush()


def test_senaite_born_parent_never_admits_a_native_bw_row(db, monkeypatch):
    # Review fix: a canonical PH-BW on a SENAITE-born parent (reachable via
    # POST /api/lims-analyses + promote) must not ride beside the shadow
    # PH-DETERM. The shape collapse keys on the RAW keyword, so only the
    # native-born gate keeps the line from printing twice.
    parent = _native_bw_sample(db, monkeypatch, values={"PH-BW": "5.5"},
                               external_lims_system="senaite")
    _shadow_ph_determ(db, parent, result="6.1")
    rows = build_legacy_rows(db, parent)
    assert [r["Keyword"] for r in rows] == ["PH-DETERM"]
    [ph] = rows
    assert ph["Result"] == "6.1"
    assert "specification" not in ph and "conforms" not in ph


def test_native_born_bw_wire_keyword_collision_aborts(db, monkeypatch):
    # A native-born parent that also carries a live shadow PH-DETERM would
    # emit two PH-DETERM rows after re-keying: fail closed, never print twice.
    parent = _native_bw_sample(db, monkeypatch, values={"PH-BW": "5.5"})
    _shadow_ph_determ(db, parent)
    with pytest.raises(NativeSectionsError, match="PH-DETERM more than once"):
        build_legacy_rows(db, parent)
