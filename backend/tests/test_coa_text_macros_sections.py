"""The section's COA text resolves {lod} from its rows (endo slice 4, spec
docs/superpowers/specs/2026-10-13-endo-slice4-coa-text-macros-design.md
section 5). Text without a macro is byte-identical."""
from decimal import Decimal

from coa.native_sections import build_native_sections
from models import AnalysisProfile, AnalysisServiceSpec
from tests.test_coa_result_loq import _endo, _endo_parent
from tests.test_native_sections import _mk_native_profile, _mk_parent_with_rows, _order_lookup

METHOD = ("Endotoxin testing performed using Limulus Amebocyte Lysate assay in accordance "
          "with USP <85>. Results and limit are per vial (the whole vial as one dose). "
          "[LOD {lod}.]")
CLEAN = ("Endotoxin testing performed using Limulus Amebocyte Lysate assay in accordance "
         "with USP <85>. Results and limit are per vial (the whole vial as one dose).")


def _section(db, parent, monkeypatch, key="endotoxin"):
    _order_lookup(monkeypatch, key=key)
    [section] = build_native_sections(db, parent)["sections"]
    return section


def _texts(db, key="endotoxin", **fields):
    prof = db.query(AnalysisProfile).filter_by(key=key).one()
    for name, value in fields.items():
        setattr(prof, name, value)
    db.flush()


def test_the_method_text_shows_the_results_lod(db_session, monkeypatch):
    svc = _endo(db_session)
    _texts(db_session, coa_method_text=METHOD)
    parent = _endo_parent(db_session, svc, "25", loq=25.0, lod=0.05)
    assert _section(db_session, parent, monkeypatch)["method_text"] == CLEAN + " LOD 0.05 EU/mL."


def test_a_result_without_an_lod_drops_the_segment(db_session, monkeypatch):
    svc = _endo(db_session)
    _texts(db_session, coa_method_text=METHOD)
    parent = _endo_parent(db_session, svc, "2.5", unit="EU/mL")
    assert _section(db_session, parent, monkeypatch)["method_text"] == CLEAN


def test_bac_water_prints_its_own_lod(db_session, monkeypatch):
    svc = _endo(db_session)
    _texts(db_session, coa_method_text="Results in EU/mL. [LOD {lod}.]")
    parent = _endo_parent(db_session, svc, "0.2", unit="EU/mL", loq=0.2, lod=0.01,
                          sample_type="Bacteriostatic Water")
    assert _section(db_session, parent, monkeypatch)["method_text"] == (
        "Results in EU/mL. LOD 0.01 EU/mL.")


def test_basis_prep_and_footnotes_resolve_and_an_empty_footnote_is_dropped(db_session,
                                                                           monkeypatch):
    svc = _endo(db_session)
    _texts(db_session,
           coa_basis_note="[LOD {lod}]",
           coa_prep_text="Reconstituted in 2 mL. [Cartridge LOD {lod}.]",
           coa_footnotes=[{"label": "a", "text": "[LOD {lod}.]"},
                          {"label": "b", "text": "Per USP <85>."}])
    with_lod = _section(db_session, _endo_parent(db_session, svc, "25", loq=25.0, lod=0.05),
                        monkeypatch)
    assert (with_lod["basis_note"], with_lod["prep_text"], with_lod["footnotes"]) == (
        "LOD 0.05 EU/mL", "Reconstituted in 2 mL. Cartridge LOD 0.05 EU/mL.",
        [{"label": "a", "text": "LOD 0.05 EU/mL."}, {"label": "b", "text": "Per USP <85>."}])


def test_without_an_lod_the_basis_is_none_and_the_footnote_is_gone(db_session, monkeypatch):
    svc = _endo(db_session)
    _texts(db_session,
           coa_basis_note="[LOD {lod}]",
           coa_footnotes=[{"label": "a", "text": "[LOD {lod}.]"},
                          {"label": "b", "text": "Per USP <85>."}])
    section = _section(db_session, _endo_parent(db_session, svc, "2.5", unit="EU/mL"),
                       monkeypatch)
    assert (section["basis_note"], section["footnotes"]) == (
        None, [{"label": "b", "text": "Per USP <85>."}])


def test_a_heavy_metal_section_is_byte_identical(db_session, monkeypatch):
    # Review Focus 1: brackets, braces and labels with no known macro print as typed.
    prof, svcs = _mk_native_profile(db_session, key="heavy_metals",
                                    services=[("HM-PB", "mk1")], specs=False)
    db_session.add(AnalysisServiceSpec(analysis_service_id=svcs[0].id, matrix=None,
                                       rule_kind="range", max_value=Decimal("100"),
                                       loq=Decimal("0.5"), unit="ppm"))
    notes = [{"label": "[a]", "text": "Per USP <232> [1]  {see}"}]
    prof.coa_basis_note, prof.coa_method_text = "Limits per USP <232>", "ICP-MS  [2]"
    prof.coa_prep_text, prof.coa_footnotes = "Microwave digestion", notes
    db_session.flush()
    parent = _mk_parent_with_rows(db_session, svcs, result="0.2")
    section = _section(db_session, parent, monkeypatch, key="heavy_metals")
    assert (section["basis_note"], section["method_text"], section["prep_text"],
            section["footnotes"]) == ("Limits per USP <232>", "ICP-MS  [2]",
                                      "Microwave digestion", notes)
    assert list(section) == ["profile_key", "title", "archetype", "sort_order", "basis_note",
                             "method_text", "prep_text", "footnotes", "rows"]


def test_a_malformed_footnote_still_passes_through(db_session, monkeypatch):
    # The builder's fail-open rule for footnotes written by SQL is kept.
    svc = _endo(db_session)
    _texts(db_session, coa_footnotes=[42, {"label": "a", "text": "[LOD {lod}.]"}])
    section = _section(db_session, _endo_parent(db_session, svc, "25", loq=25.0, lod=0.05),
                       monkeypatch)
    assert section["footnotes"] == [42, {"label": "a", "text": "LOD 0.05 EU/mL."}]
