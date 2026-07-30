"""build_native_sections: the wire document + fail-closed rules 1-4.

fetch_sample_services is monkeypatched throughout — it is a live HTTP
pass-through to Integration Service.
"""
import pytest

from coa.native_sections import NativeSectionsError, build_native_sections


def _mk_native_profile(db, *, key, services, archetype="limit_table",
                       title=None, sort=10):
    """Profile with the given member services (list of (keyword, origin))."""
    from models import AnalysisProfile, AnalysisService, analysis_profile_members
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
    assert row["specification"] is None and row["conforms"] is None


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
    from models import AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample, analysis_profile_members
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
