"""build_native_sections: the wire document + fail-closed rules 1-4.

fetch_sample_services is monkeypatched throughout — it is a live HTTP
pass-through to Integration Service.
"""
import pytest

from coa import source_resolver
from coa.native_sections import ELIGIBLE_STATES, NativeSectionsError, build_native_sections


def test_eligible_states_matches_source_resolver_parent_result_states():
    """Drift guard: the ("verified", "published") COA-eligibility policy is
    dual-encoded — coa/native_sections.py:ELIGIBLE_STATES (this module) and
    coa/source_resolver.py:_PARENT_RESULT_STATES both gate which parent-tier
    review_states may be cited on a COA. They must change together; a lone
    edit to one silently reopens or narrows COA eligibility on the other
    resolution path (native sections vs. the SENAITE-parity source
    resolver) without either test suite catching it."""
    assert tuple(ELIGIBLE_STATES) == tuple(source_resolver._PARENT_RESULT_STATES)


def _mk_native_profile(db, *, key, services, archetype="limit_table",
                       title=None, sort=10, specs=True):
    """Profile with the given member services (list of (keyword, origin)).
    specs=True files a loose NULL-matrix range spec (max 100 ppm) per mk1
    member so rule 5 resolves; specs=False leaves services spec-less for
    the rule-5 abort tests."""
    from decimal import Decimal
    from models import (AnalysisProfile, AnalysisService, AnalysisServiceSpec,
                        analysis_profile_members)
    prof = AnalysisProfile(
        key=key, name=key.replace("_", " ").title(), is_addon=True,
        coa_archetype=archetype, coa_section_title=title, coa_sort_order=sort,
    )
    db.add(prof); db.flush()
    svcs = []
    for i, (kw, origin) in enumerate(services):
        svc = AnalysisService(title=kw.title(), keyword=kw, origin=origin, unit="ppm")
        db.add(svc); db.flush()
        db.execute(analysis_profile_members.insert().values(
            analysis_profile_id=prof.id, analysis_service_id=svc.id, sort_order=i,
        ))
        if specs and origin == "mk1":
            db.add(AnalysisServiceSpec(
                analysis_service_id=svc.id, matrix=None, rule_kind="range",
                max_value=Decimal("100"), unit="ppm",
            ))
        svcs.append(svc)
    db.flush()
    return prof, svcs


def _mk_parent_with_rows(db, svcs, *, state="verified", result="0.12"):
    from models import LimsAnalysis, LimsSample
    parent = LimsSample(sample_id="P-7001")
    db.add(parent); db.flush()
    for svc in svcs:
        db.add(LimsAnalysis(
            lims_sample_pk=parent.id, analysis_service_id=svc.id,
            keyword=svc.keyword, title=svc.title,
            result_value=result, result_unit=svc.unit, review_state=state,
        ))
    db.flush()
    return parent


def test_happy_path_document_shape(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(
        db_session, key="heavy_metals",
        services=[("HM-PB", "mk1"), ("HM-AS", "mk1")],
        title="Heavy Metals",
    )
    parent = _mk_parent_with_rows(db_session, svcs)
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"heavy_metals": True}, "package": "core"},
    )
    doc = build_native_sections(db_session, parent)
    assert doc["sample_id"] == "P-7001"
    assert doc["ordered_profiles"] == ["heavy_metals"]
    [section] = doc["sections"]
    assert section["profile_key"] == "heavy_metals"
    assert section["title"] == "Heavy Metals"
    assert section["archetype"] == "limit_table"
    assert section["sort_order"] == 10
    assert [r["keyword"] for r in section["rows"]] == ["HM-PB", "HM-AS"]  # member order
    row = section["rows"][0]
    assert row["result"] == "0.12" and row["unit"] == "ppm"
    assert row["specification"] == {"rule_kind": "range", "equals": None,
                                    "min": None, "max": 100.0, "unit": "ppm",
                                    "display": None, "loq": None}
    assert row["conforms"] is True


def test_duplicate_order_key_emits_one_section(db_session, monkeypatch):
    """package == a truthy services key must not duplicate the section
    (ledger final-review minor: ordered_keys had no dedup)."""
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs)
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"heavy_metals": True}, "package": "heavy_metals"},
    )
    doc = build_native_sections(db_session, parent)
    assert [s["profile_key"] for s in doc["sections"]].count("heavy_metals") == 1
    assert doc["ordered_profiles"].count("heavy_metals") == 1


def test_rule1_is_fetch_failure_aborts(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs)
    def _boom(sample_id):
        raise RuntimeError("IS unreachable")
    monkeypatch.setattr("coa.native_sections.fetch_sample_services", _boom)
    with pytest.raises(NativeSectionsError, match="order lookup failed"):
        build_native_sections(db_session, parent)


def test_rule4_ineligible_state_aborts_not_skips(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs, state="to_be_verified")
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"heavy_metals": True}, "package": None},
    )
    with pytest.raises(NativeSectionsError, match="no eligible result"):
        build_native_sections(db_session, parent)


def test_rule4_parent_to_verify_state_aborts_not_skips(db_session, monkeypatch):
    """Task 6 pin: a promoted-but-unreviewed row (parent_to_verify — awaiting
    the reviewer's verify sign-off) is not certifiable, same as to_be_verified.
    ELIGIBLE_STATES is already ('verified', 'published') here — narrower than
    coa/source_resolver's pre-Task-6 _LIVE_RESULT_STATES by design (native
    services have no SENAITE verify step) — so this was already correct
    before Task 6; pinned as an explicit control alongside the resolver fix."""
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs, state="parent_to_verify")
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"heavy_metals": True}, "package": None},
    )
    with pytest.raises(NativeSectionsError, match="no eligible result"):
        build_native_sections(db_session, parent)


def test_rule3_empty_result_aborts(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs, result="")
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"heavy_metals": True}, "package": None},
    )
    with pytest.raises(NativeSectionsError, match="empty result"):
        build_native_sections(db_session, parent)


def test_mixed_origin_profile_is_not_reportable(db_session, monkeypatch):
    """A profile with any SENAITE member is excluded from ordered_profiles
    entirely (all-native rule) — it does NOT abort, and it does NOT emit."""
    prof, svcs = _mk_native_profile(
        db_session, key="bac_water_panel",
        services=[("ENDO-XYZ", "senaite"), ("HM-PB", "mk1")],
    )
    parent = _mk_parent_with_rows(db_session, svcs)
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"bac_water_panel": True}, "package": None},
    )
    doc = build_native_sections(db_session, parent)
    assert doc["ordered_profiles"] == [] and doc["sections"] == []


def test_null_archetype_profile_is_not_reportable(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="internal_qc",
                                    services=[("QC-X", "mk1")], archetype=None)
    parent = _mk_parent_with_rows(db_session, svcs)
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"internal_qc": True}, "package": None},
    )
    doc = build_native_sections(db_session, parent)
    assert doc["ordered_profiles"] == [] and doc["sections"] == []


def test_retested_row_is_not_current(db_session, monkeypatch):
    """A parent row that has been retest-superseded (retracted) plus a new
    verified retest row: the retest row is used; if ONLY the retracted row
    exists, the section aborts (rule 4)."""
    from models import LimsAnalysis
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs, state="retracted")
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"heavy_metals": True}, "package": None},
    )
    with pytest.raises(NativeSectionsError, match="no eligible result"):
        build_native_sections(db_session, parent)
    db_session.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svcs[0].id,
        keyword="HM-PB", title="Hm-Pb", result_value="0.09",
        result_unit="ppm", review_state="verified",
    ))
    db_session.flush()
    doc = build_native_sections(db_session, parent)
    assert doc["sections"][0]["rows"][0]["result"] == "0.09"


def test_no_order_linked_yields_empty_document(db_session, monkeypatch):
    from models import LimsSample
    parent = LimsSample(sample_id="P-7002")
    db_session.add(parent); db_session.flush()
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: None,   # IS 404: no linked order
    )
    doc = build_native_sections(db_session, parent)
    assert doc == {"sample_id": "P-7002", "ordered_profiles": [], "sections": []}


def test_method_label_from_hplc_methods(db_session, monkeypatch):
    """A row with method_id set surfaces hplc_methods.name; unset -> ''."""
    from models import HplcMethod, LimsAnalysis
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1"), ("HM-AS", "mk1")])
    method = HplcMethod(name="EPA 200.8")
    db_session.add(method); db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs)
    from sqlalchemy import select as sa_select
    rows = db_session.execute(
        sa_select(LimsAnalysis).where(LimsAnalysis.lims_sample_pk == parent.id)
    ).scalars().all()
    for row in rows:
        if row.keyword == "HM-PB":
            row.method_id = method.id
    db_session.flush()
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"heavy_metals": True}, "package": None},
    )
    doc = build_native_sections(db_session, parent)
    rows_by_kw = {r["keyword"]: r for r in doc["sections"][0]["rows"]}
    assert rows_by_kw["HM-PB"]["method"] == "EPA 200.8"
    assert rows_by_kw["HM-AS"]["method"] == ""


def test_retest_of_id_row_is_not_current(db_session, monkeypatch):
    """Design spec (2026-07-28-native-coa-sections-design.md:73): a row is
    only "current" when retest_of_id IS NULL, even if review_state is
    otherwise eligible. Alone, a retest_of_id-set row must NOT be picked (the
    section aborts, rule 4). Alongside a current (retest_of_id NULL) row, the
    current one's result is used."""
    from models import LimsAnalysis, LimsSample
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = LimsSample(sample_id="P-7003")
    db_session.add(parent); db_session.flush()
    # A prior row this stale row claims to be a retest of (real FK target,
    # though SQLite here does not enforce it).
    older_row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svcs[0].id,
        keyword=svcs[0].keyword, title=svcs[0].title,
        result_value="0.50", result_unit=svcs[0].unit, review_state="retracted",
    )
    db_session.add(older_row); db_session.flush()
    stale_row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svcs[0].id,
        keyword=svcs[0].keyword, title=svcs[0].title,
        result_value="0.99", result_unit=svcs[0].unit,
        review_state="verified", retest_of_id=older_row.id,
    )
    db_session.add(stale_row); db_session.flush()
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"heavy_metals": True}, "package": None},
    )
    with pytest.raises(NativeSectionsError, match="no eligible result"):
        build_native_sections(db_session, parent)

    current_row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svcs[0].id,
        keyword=svcs[0].keyword, title=svcs[0].title,
        result_value="0.12", result_unit=svcs[0].unit, review_state="verified",
    )
    db_session.add(current_row); db_session.flush()
    doc = build_native_sections(db_session, parent)
    assert doc["sections"][0]["rows"][0]["result"] == "0.12"


def test_blank_unit_logs_warning_and_still_builds(db_session, monkeypatch, caplog):
    """A row resolving to unit="" (svc.unit=None, row.result_unit=None) is the
    ENDO-LAL blank-unit failure class — but pH's unit is legitimately blank
    per the spec's family table, so this must NOT abort. It logs a warning
    and the document still builds."""
    from decimal import Decimal
    from models import (AnalysisProfile, AnalysisService, AnalysisServiceSpec,
                        LimsAnalysis, LimsSample, analysis_profile_members)
    prof = AnalysisProfile(
        key="ph_panel", name="Ph Panel", is_addon=True,
        coa_archetype="limit_table", coa_section_title="pH", coa_sort_order=10,
    )
    db_session.add(prof); db_session.flush()
    svc = AnalysisService(title="Ph", keyword="PH", origin="mk1", unit=None)
    db_session.add(svc); db_session.flush()
    db_session.execute(analysis_profile_members.insert().values(
        analysis_profile_id=prof.id, analysis_service_id=svc.id, sort_order=0,
    ))
    # Rule 5 needs a resolvable spec (not this test's concern — pH's
    # legitimately-blank unit is); a real-world pH range keeps it inert.
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svc.id, matrix=None, rule_kind="range",
        min_value=Decimal("0"), max_value=Decimal("14"),
    ))
    parent = LimsSample(sample_id="P-7004")
    db_session.add(parent); db_session.flush()
    db_session.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.title,
        result_value="7.0", result_unit=None, review_state="verified",
    ))
    db_session.flush()
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {"ph_panel": True}, "package": None},
    )
    with caplog.at_level("WARNING", logger="coa.native_sections"):
        doc = build_native_sections(db_session, parent)
    assert doc["sections"][0]["rows"][0]["unit"] == ""
    assert any(
        "native_section_blank_unit" in r.getMessage() and "keyword=PH" in r.getMessage()
        for r in caplog.records
    )


# ── Spec-ownership slice 1: Mk1 fills the wire + rule 5 ─────────────────────

def _order_lookup(monkeypatch, key="heavy_metals"):
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {key: True}, "package": None},
    )


def test_out_of_range_result_conforms_false_but_builds(db_session, monkeypatch):
    """Non-conforming is a VERDICT, not an abort — the certificate prints
    Does Not Conform; only an unappliable rule aborts."""
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs, result="999")
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)
    row = doc["sections"][0]["rows"][0]
    assert row["conforms"] is False
    assert row["specification"]["max"] == 100.0


def test_equals_spec_fills_and_verdicts(db_session, monkeypatch):
    from models import AnalysisServiceSpec
    prof, svcs = _mk_native_profile(db_session, key="sterility_usp71",
                                    services=[("STERILITY_USP71", "mk1")],
                                    specs=False)
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[0].id, matrix=None, rule_kind="equals",
        equals_value="Not Detected"))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="Not Detected")
    _order_lookup(monkeypatch, key="sterility_usp71")
    doc = build_native_sections(db_session, parent)
    row = doc["sections"][0]["rows"][0]
    assert row["conforms"] is True
    assert row["specification"] == {"rule_kind": "equals",
                                    "equals": "Not Detected", "min": None,
                                    "max": None, "unit": None, "display": None,
                                    "loq": None}


def test_rule5_no_spec_aborts_naming_service_and_matrix(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")], specs=False)
    parent = _mk_parent_with_rows(db_session, svcs)
    _order_lookup(monkeypatch)
    with pytest.raises(NativeSectionsError, match="HM-PB.*no active spec"):
        build_native_sections(db_session, parent)


def test_rule5_inactive_spec_aborts(db_session, monkeypatch):
    from models import AnalysisServiceSpec
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")], specs=False)
    from decimal import Decimal
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[0].id, matrix=None, rule_kind="range",
        max_value=Decimal("0.5"), active=False))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs)
    _order_lookup(monkeypatch)
    with pytest.raises(NativeSectionsError, match="no active spec"):
        build_native_sections(db_session, parent)


def test_unappliable_rule_aborts(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs, result="N/A")
    _order_lookup(monkeypatch)
    with pytest.raises(NativeSectionsError, match="not numeric"):
        build_native_sections(db_session, parent)


def test_nan_result_aborts_fail_closed(db_session, monkeypatch):
    # The old COABuilder engine false-passed NaN; the producer now refuses.
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs, result="nan")
    _order_lookup(monkeypatch)
    with pytest.raises(NativeSectionsError, match="non-finite"):
        build_native_sections(db_session, parent)


def test_matrix_specific_spec_beats_null(db_session, monkeypatch):
    from decimal import Decimal
    from models import AnalysisServiceSpec
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])  # NULL @ 100
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[0].id, matrix="Bacteriostatic Water",
        rule_kind="range", max_value=Decimal("0.05"), unit="ppm"))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="0.12")
    parent.sample_type_title = "Bacteriostatic Water"
    db_session.flush()
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)
    row = doc["sections"][0]["rows"][0]
    assert row["conforms"] is False          # judged by the BW row (0.05)
    assert row["specification"]["max"] == 0.05


def test_blend_matrix_resolves_peptide_spec(db_session, monkeypatch):
    from decimal import Decimal
    from models import AnalysisServiceSpec
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")], specs=False)
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[0].id, matrix="Peptide", rule_kind="range",
        max_value=Decimal("0.5"), unit="ppm"))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="0.12")
    parent.sample_type_title = "Peptide Blend"
    db_session.flush()
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)
    assert doc["sections"][0]["rows"][0]["conforms"] is True


def test_null_sample_type_title_uses_null_matrix_spec(db_session, monkeypatch):
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])
    parent = _mk_parent_with_rows(db_session, svcs)   # sample_type_title None
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)
    assert doc["sections"][0]["rows"][0]["conforms"] is True


# ── Spec-ownership slice 2: peptide-first precedence + identity anchor ──────

def _mk_peptide(db, abbreviation, name=None):
    from models import Peptide
    pep = Peptide(name=name or abbreviation, abbreviation=abbreviation)
    db.add(pep); db.flush()
    return pep


def test_peptide_tier_spec_beats_matrix_and_wildcard(db_session, monkeypatch):
    """The parent's identity anchor (R6, sample_peptide_id — the single
    peptide-linked family service) resolves the peptide-tier spec ahead of
    both the matrix and wildcard rows filed on the same service."""
    from decimal import Decimal
    from models import AnalysisServiceSpec
    peptide = _mk_peptide(db_session, "BPC157")
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")], specs=False)
    svcs[0].peptide_id = peptide.id
    db_session.flush()
    db_session.add(AnalysisServiceSpec(   # wildcard: 100
        analysis_service_id=svcs[0].id, matrix=None, rule_kind="range",
        max_value=Decimal("100"), unit="ppm"))
    db_session.add(AnalysisServiceSpec(   # matrix: 1
        analysis_service_id=svcs[0].id, matrix="Peptide", rule_kind="range",
        max_value=Decimal("1"), unit="ppm"))
    db_session.add(AnalysisServiceSpec(   # peptide: 0.05
        analysis_service_id=svcs[0].id, peptide_id=peptide.id, matrix=None,
        rule_kind="range", max_value=Decimal("0.05"), unit="ppm"))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="0.12")
    parent.sample_type_title = "Peptide"
    db_session.flush()
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)
    row = doc["sections"][0]["rows"][0]
    assert row["specification"]["max"] == 0.05
    assert row["conforms"] is False          # 0.12 > the peptide-tier 0.05


def test_blend_family_skips_peptide_tier(db_session, monkeypatch):
    """R5: two distinct peptide anchors on the family (a blend) makes
    sample_peptide_id return None — resolution must coarsen straight to the
    matrix tier, never touching the peptide-tier row filed on the service."""
    from decimal import Decimal
    from models import AnalysisServiceSpec
    pep_a = _mk_peptide(db_session, "BPC157")
    pep_b = _mk_peptide(db_session, "TB500")
    prof, svcs = _mk_native_profile(
        db_session, key="heavy_metals",
        services=[("HM-PB", "mk1"), ("HM-AS", "mk1")], specs=False,
    )
    svcs[0].peptide_id = pep_a.id
    svcs[1].peptide_id = pep_b.id
    db_session.flush()
    db_session.add(AnalysisServiceSpec(   # peptide tier — must NOT be reached
        analysis_service_id=svcs[0].id, peptide_id=pep_a.id, matrix=None,
        rule_kind="range", max_value=Decimal("0.01"), unit="ppm"))
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[0].id, matrix="Peptide", rule_kind="range",
        max_value=Decimal("1"), unit="ppm"))
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[1].id, matrix="Peptide", rule_kind="range",
        max_value=Decimal("1"), unit="ppm"))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="0.12")
    parent.sample_type_title = "Peptide Blend"
    db_session.flush()
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)
    row = next(r for r in doc["sections"][0]["rows"] if r["keyword"] == "HM-PB")
    assert row["specification"]["max"] == 1.0     # matrix, not the 0.01 peptide row
    assert row["conforms"] is True

    # Control: collapse the family to a SINGLE anchor (both services now
    # point at pep_a) — sample_peptide_id must flip to pep_a.id and the
    # peptide-tier row (0.01) must now be the one that resolves. Proves the
    # skip above is actually caused by the two-anchor discriminator, not
    # some other reason the peptide tier never fires.
    svcs[1].peptide_id = pep_a.id
    db_session.flush()
    doc = build_native_sections(db_session, parent)
    row = next(r for r in doc["sections"][0]["rows"] if r["keyword"] == "HM-PB")
    assert row["specification"]["max"] == 0.01
    assert row["conforms"] is False               # 0.12 > 0.01


def test_unresolvable_peptide_coarsens_to_matrix_never_aborts(db_session, monkeypatch):
    """R4: a real peptide anchor with no spec filed AT that peptide_id must
    fall through to the matrix tier, never abort COA generation."""
    from decimal import Decimal
    from models import AnalysisServiceSpec
    peptide = _mk_peptide(db_session, "BPC157")
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")], specs=False)
    svcs[0].peptide_id = peptide.id
    db_session.flush()
    db_session.add(AnalysisServiceSpec(   # only a matrix row — no peptide row
        analysis_service_id=svcs[0].id, matrix="Peptide", rule_kind="range",
        max_value=Decimal("1"), unit="ppm"))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="0.12")
    parent.sample_type_title = "Peptide"
    db_session.flush()
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)   # must not raise
    row = doc["sections"][0]["rows"][0]
    assert row["specification"]["max"] == 1.0
    assert row["conforms"] is True


def test_rule5_abort_message_names_tiers_consulted(db_session, monkeypatch):
    """The extended rule-5 abort message names every tier consulted so the
    lab knows exactly which analysis_service_specs row is missing."""
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")], specs=False)
    parent = _mk_parent_with_rows(db_session, svcs)
    _order_lookup(monkeypatch)
    with pytest.raises(NativeSectionsError,
                       match=r"tiers consulted: peptide=None, matrix=None, wildcard"):
        build_native_sections(db_session, parent)


# ── COA display fields + LOQ censoring (2026-08-16 spec, task 4) ────────────

def test_wire_carries_loq_and_display_fields(db_session, monkeypatch):
    """A spec with loq filed + a profile with all four display fields: the
    section carries the display chrome, the row's specification.loq is on
    the wire, and a result below the LOQ prints "< LOQ" while the VERDICT
    (conforms) still judges the raw number."""
    from decimal import Decimal
    from models import AnalysisServiceSpec
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")], specs=False)
    prof.coa_basis_note = "Basis: dry weight"
    prof.coa_method_text = "ICP-MS per EPA 200.8"
    prof.coa_prep_text = "Microwave digestion"
    prof.coa_footnotes = [{"label": "1", "text": "See appendix"}]
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[0].id, matrix=None, rule_kind="range",
        max_value=Decimal("100"), loq=Decimal("0.5"), unit="ppm"))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="0.2")
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)
    sec = doc["sections"][0]
    assert sec["basis_note"] == "Basis: dry weight"
    assert sec["method_text"] == "ICP-MS per EPA 200.8"
    assert sec["prep_text"] == "Microwave digestion"
    assert sec["footnotes"][0]["label"] == "1"
    row = sec["rows"][0]
    assert row["specification"]["loq"] == 0.5
    assert row["result_display"] == "< LOQ"
    assert row["conforms"] is True          # verdict on the RAW number (0.2 <= 100)


def test_censoring_boundary(db_session, monkeypatch):
    """result == loq is NOT censored; below is; above is not."""
    from decimal import Decimal
    from models import AnalysisServiceSpec, LimsAnalysis, LimsSample
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")], specs=False)
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[0].id, matrix=None, rule_kind="range",
        max_value=Decimal("100"), loq=Decimal("0.5"), unit="ppm"))
    db_session.flush()
    _order_lookup(monkeypatch)

    def _parent(sample_id, result):
        # _mk_parent_with_rows hardcodes sample_id "P-7001" — each boundary
        # case needs its own parent, so build inline with a distinct id.
        p = LimsSample(sample_id=sample_id)
        db_session.add(p); db_session.flush()
        db_session.add(LimsAnalysis(
            lims_sample_pk=p.id, analysis_service_id=svcs[0].id,
            keyword=svcs[0].keyword, title=svcs[0].title,
            result_value=result, result_unit=svcs[0].unit, review_state="verified",
        ))
        db_session.flush()
        return p

    doc = build_native_sections(db_session, _parent("P-8001", "0.5"))
    assert doc["sections"][0]["rows"][0]["result_display"] is None

    doc = build_native_sections(db_session, _parent("P-8002", "0.51"))
    assert doc["sections"][0]["rows"][0]["result_display"] is None

    doc = build_native_sections(db_session, _parent("P-8003", "0.49"))
    assert doc["sections"][0]["rows"][0]["result_display"] == "< LOQ"


def test_censored_result_can_still_be_non_conforming(db_session, monkeypatch):
    """Display and verdict are orthogonal: a below-LOQ result censors on the
    wire AND can independently fail the spec (e.g. a min_value floor) —
    result_display must not leak into or soften the verdict."""
    from decimal import Decimal
    from models import AnalysisServiceSpec
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")], specs=False)
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[0].id, matrix=None, rule_kind="range",
        min_value=Decimal("1"), loq=Decimal("0.5"), unit="ppm"))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="0.2")
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)
    row = doc["sections"][0]["rows"][0]
    assert row["result_display"] == "< LOQ"
    assert row["conforms"] is False          # 0.2 < min_value 1, raw-number verdict


def test_equals_rows_never_censor(db_session, monkeypatch):
    """A stray loq filed on an equals-rule spec must never censor — the
    censoring convention is range-only."""
    from models import AnalysisServiceSpec
    from decimal import Decimal
    prof, svcs = _mk_native_profile(db_session, key="sterility_usp71",
                                    services=[("STERILITY_USP71", "mk1")],
                                    specs=False)
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svcs[0].id, matrix=None, rule_kind="equals",
        equals_value="Not Detected", loq=Decimal("0.5")))
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="Not Detected")
    _order_lookup(monkeypatch, key="sterility_usp71")
    doc = build_native_sections(db_session, parent)
    row = doc["sections"][0]["rows"][0]
    assert row["result_display"] is None
    assert row["conforms"] is True


def test_unset_fields_wire_shape(db_session, monkeypatch):
    """Profile with no display fields, spec with no loq: every key is
    present on the wire (never dropped), with the documented unset values."""
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")])  # specs=True, no loq
    parent = _mk_parent_with_rows(db_session, svcs)
    _order_lookup(monkeypatch)
    doc = build_native_sections(db_session, parent)
    sec = doc["sections"][0]
    assert (sec["basis_note"], sec["method_text"], sec["prep_text"]) == (None, None, None)
    assert sec["footnotes"] == []
    assert sec["rows"][0]["specification"]["loq"] is None
    assert sec["rows"][0]["result_display"] is None
