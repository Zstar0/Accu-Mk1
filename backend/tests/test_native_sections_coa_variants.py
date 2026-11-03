from coa.native_sections import build_native_sections
from models import AnalysisProfileCoaVariant, AnalysisServiceSpec, LimsAnalysis, LimsSampleForm
from tests.test_native_sections import (_add_parent_row, _mk_native_profile, _mk_peptide,
                                        _nasal_parent, _order_lookup)

NOTES = [{"label": "Basis:", "text": "USP<232>"}]


def _hm(db, *, specs=False):
    prof, svcs = _mk_native_profile(db, key="heavy_metals", specs=specs,
                                    services=[("HM-PB", "mk1"), ("HM-AS", "mk1")])
    prof.coa_basis_note = "Limits scale with dose"
    prof.coa_method_text = "MP-AES"
    prof.coa_prep_text = "Hot block digestion"
    prof.coa_footnotes = NOTES
    db.flush()
    return prof, svcs


def _variant(db, prof, form_id, **fields):
    db.add(AnalysisProfileCoaVariant(analysis_profile_id=prof.id, sample_form_id=form_id, **fields))
    db.flush()


def _section(db, parent, monkeypatch, **kw):
    _order_lookup(monkeypatch)
    return build_native_sections(db, parent, **kw)["sections"][0]


def _assert_default_text(sec):
    assert sec["method_text"] == "MP-AES"
    assert sec["prep_text"] == "Hot block digestion"
    assert sec["footnotes"] == NOTES


def test_no_variant_keeps_key_order_and_text(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    sec = _section(db_session, parent, monkeypatch)
    assert list(sec) == ["profile_key", "title", "archetype", "sort_order", "basis_note",
                         "method_text", "prep_text", "footnotes", "rows"]
    assert sec["title"] == prof.name
    assert sec["basis_note"] is None    # the 1.55.0 hide
    _assert_default_text(sec)


def test_custom_text_prints_with_macros_filled(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    for row in db_session.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id):
        row.lod, row.lod_unit = 0.05, "ppm"
    _variant(db_session, prof, parent.sample_form_id, coa_section_title="Metals (Nasal)",
             coa_prep_text="Diluted 1:10. [LOD {lod}.]", coa_method_text="ICP",
             coa_basis_note="Report only", coa_footnotes=[{"label": "a", "text": "[LOD {lod}.]"}])
    sec = _section(db_session, parent, monkeypatch)
    assert sec["title"] == "Metals (Nasal)"
    assert sec["prep_text"] == "Diluted 1:10. LOD 0.05 ppm."
    assert sec["method_text"] == "ICP"
    assert sec["basis_note"] == "Report only"    # a custom note overrides the hide
    assert sec["footnotes"] == [{"label": "a", "text": "LOD 0.05 ppm."}]


def test_leave_off_gives_none_and_empty_list(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_basis_note="", coa_method_text="",
             coa_prep_text="", coa_footnotes=[])
    sec = _section(db_session, parent, monkeypatch)
    assert sec["basis_note"] is None and sec["method_text"] is None and sec["prep_text"] is None
    assert sec["footnotes"] == []


def test_same_as_default_keeps_the_basis_note_hide(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    sec = _section(db_session, parent, monkeypatch)
    assert sec["basis_note"] is None
    assert sec["prep_text"] == "Diluted"
    assert sec["footnotes"] == NOTES


def test_default_prints_for_another_form(db_session, monkeypatch):
    prof, svcs = _hm(db_session, specs=True)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    pen = LimsSampleForm(name="Pen", route="injectable")
    db_session.add(pen); db_session.flush()
    parent.sample_form_id = pen.id
    db_session.flush()
    _assert_default_text(_section(db_session, parent, monkeypatch))


def test_default_prints_with_no_form(db_session, monkeypatch):
    prof, svcs = _hm(db_session, specs=True)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    parent.sample_form_id = None
    db_session.flush()
    _assert_default_text(_section(db_session, parent, monkeypatch))


def test_default_prints_for_a_non_peptide_matrix_with_a_form(db_session, monkeypatch):
    prof, svcs = _hm(db_session, specs=True)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    parent.sample_type_title = "Bacteriostatic Water"
    db_session.flush()
    _assert_default_text(_section(db_session, parent, monkeypatch))


def test_default_prints_for_an_inactive_variant(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted", active=False)
    _assert_default_text(_section(db_session, parent, monkeypatch))


def test_a_deactivated_form_keeps_its_variant(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    db_session.get(LimsSampleForm, parent.sample_form_id).active = False
    db_session.flush()
    assert _section(db_session, parent, monkeypatch)["prep_text"] == "Diluted"


def test_a_second_profile_on_the_sample_is_unchanged(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    other, other_svcs = _mk_native_profile(db_session, key="other_panel", sort=20, specs=False,
                                           services=[("OT-1", "mk1")])
    other.coa_prep_text = "Other prep"
    parent = _nasal_parent(db_session, svcs + other_svcs, form_row_svcs=svcs + other_svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    monkeypatch.setattr("coa.native_sections.fetch_sample_services",
                        lambda sample_id: {"services": {"heavy_metals": True, "other_panel": True},
                                           "package": None})
    first, second = build_native_sections(db_session, parent)["sections"]
    assert first["prep_text"] == "Diluted"
    assert second["prep_text"] == "Other prep"


def test_a_vial_certificate_uses_the_parents_form(db_session, monkeypatch):
    prof, svcs = _hm(db_session)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    ids = {r.id for r in db_session.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id)}
    assert _section(db_session, parent, monkeypatch, vial_parent_ids=ids)["prep_text"] == "Diluted"


def test_guard_a_row_on_general_limits_keeps_default_limit_text(db_session, monkeypatch, caplog):
    prof, svcs = _hm(db_session, specs=True)    # wildcard on both, form row only on HM-PB
    parent = _nasal_parent(db_session, svcs, form_row_svcs=[svcs[0]])
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted", coa_method_text="ICP",
             coa_section_title="Metals (Nasal)", coa_basis_note="", coa_footnotes=[])
    with caplog.at_level("WARNING", logger="coa.native_sections"):
        sec = _section(db_session, parent, monkeypatch)
    assert sec["title"] == "Metals (Nasal)"
    assert sec["prep_text"] == "Diluted" and sec["method_text"] == "ICP"
    assert sec["basis_note"] == "Limits scale with dose"
    assert sec["footnotes"] == NOTES
    assert sum("native_section_variant_limits_guard" in r.getMessage()
               for r in caplog.records) == 1


def test_guard_a_peptide_tier_row_keeps_default_limit_text(db_session, monkeypatch, caplog):
    from decimal import Decimal
    peptide = _mk_peptide(db_session, "BPC157")
    prof, svcs = _hm(db_session)
    svcs[1].peptide_id = peptide.id
    db_session.add(AnalysisServiceSpec(analysis_service_id=svcs[1].id, peptide_id=peptide.id,
                                       rule_kind="range", max_value=Decimal("100"), unit="ppm"))
    parent = _nasal_parent(db_session, svcs, form_row_svcs=svcs)
    _variant(db_session, prof, parent.sample_form_id, coa_basis_note="", coa_footnotes=[])
    with caplog.at_level("WARNING", logger="coa.native_sections"):
        sec = _section(db_session, parent, monkeypatch)
    assert sec["basis_note"] == "Limits scale with dose" and sec["footnotes"] == NOTES
    assert any("native_section_variant_limits_guard" in r.getMessage() for r in caplog.records)


def test_guard_stays_quiet_when_the_variant_overrides_no_limit_field(db_session, monkeypatch, caplog):
    prof, svcs = _hm(db_session, specs=True)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=[svcs[0]])
    _variant(db_session, prof, parent.sample_form_id, coa_prep_text="Diluted")
    with caplog.at_level("WARNING", logger="coa.native_sections"):
        _section(db_session, parent, monkeypatch)
    assert not any("native_section_variant_limits_guard" in r.getMessage() for r in caplog.records)


def test_guard_counts_printed_rows_only_withdrawn_member(db_session, monkeypatch):
    prof, svcs = _hm(db_session, specs=True)
    parent = _nasal_parent(db_session, [svcs[0]], form_row_svcs=[svcs[0]])
    _add_parent_row(db_session, parent, svcs[1], state="rejected", provenance="ordered")
    _variant(db_session, prof, parent.sample_form_id, coa_basis_note="", coa_footnotes=[])
    sec = _section(db_session, parent, monkeypatch)
    assert [r["keyword"] for r in sec["rows"]] == ["HM-PB"]
    assert sec["basis_note"] is None and sec["footnotes"] == []


def test_guard_counts_printed_rows_only_vial_scope(db_session, monkeypatch):
    prof, svcs = _hm(db_session, specs=True)
    parent = _nasal_parent(db_session, svcs, form_row_svcs=[svcs[0]])
    _variant(db_session, prof, parent.sample_form_id, coa_basis_note="", coa_footnotes=[])
    pb = db_session.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, keyword="HM-PB").one()
    sec = _section(db_session, parent, monkeypatch, vial_parent_ids={pb.id})
    assert sec["basis_note"] is None and sec["footnotes"] == []
