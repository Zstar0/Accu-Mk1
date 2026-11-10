"""The flagged legacy_rows block on the wire for an a la carte sample.
Plan 4 Task 2: build_legacy_rows returns [] only for an eligible sample when
the caller passes the native sections; _legacy_block then adds
page1: "none". Every other sample keeps today's block and abort."""
import asyncio
from types import SimpleNamespace

import pytest

from coa.legacy_rows import build_legacy_rows
from coa.native_sections import NativeSectionsError, build_native_sections
from coa.wire_document import build_coa_wire_document, build_vial_wire_document
from tests.test_a_la_carte_verdict import ELIGIBLE, _add_row, _alc

FLAGGED = {"source": "mk1", "rows": [], "page1": "none"}
ABORT = "no legacy-family analyses"


@pytest.fixture
def mk1_mode(monkeypatch):
    monkeypatch.setattr("coa.wire_document.coa_generation_source", lambda db: "mk1")
    monkeypatch.setattr("coa.wire_document.build_sample_meta",
                        lambda db, p, vial=None: {"source": "mk1"})


def _retest_bw(db, monkeypatch):
    return _alc(
        db, monkeypatch, "endotoxin-usp85-lal", "ENDOTOXIN-USP85LAL",
        matrix="Bacteriostatic Water",
        services={"endotoxin-usp85-lal": True, "bacteriostatic-water-panel": True},
        is_retest=True, retest_of_sample_id="BW-0001",
        catalog_snapshot={"retest": {
            "retest": ["endotoxin-usp85-lal"], "carry": [], "missing": [],
            "drop": ["bacteriostatic-water-panel"],
            "add": {"profiles": [], "variance_points": 0}}},
    )


def test_build_legacy_rows_empty_for_eligible_with_sections(db_session, monkeypatch):
    p = _alc(db_session, monkeypatch)
    assert build_legacy_rows(db_session, p, sections=[{"profile_key": "fentanyl"}]) == []


def test_build_legacy_rows_still_aborts_without_sections(db_session, monkeypatch):
    p = _alc(db_session, monkeypatch)
    with pytest.raises(NativeSectionsError, match=ABORT):
        build_legacy_rows(db_session, p)


def _senaite_born(db, mp):
    return _alc(db, mp, external_lims_system="senaite")


def _hplc_all_rows_rejected(db, mp):
    p = _alc(db, mp, services={"hplc-purity-identity": True})
    _add_row(db, p, "HPLC-PURITY", "mk1", review_state="rejected")
    return p


def _lookup_failed(db, mp):
    p = _alc(db, mp)

    def boom(sample_id):
        raise RuntimeError("IS down")
    mp.setattr("coa.native_sections.fetch_sample_services", boom)
    return p


def _lookup_empty(db, mp):
    p = _alc(db, mp)
    mp.setattr("coa.native_sections.fetch_sample_services",
               lambda sample_id: {"services": {}, "package": "alacarte"})
    return p


def _bw_panel_no_rows(db, mp):
    return _alc(db, mp, matrix="Bacteriostatic Water",
                services={"bacteriostatic-water-panel": True})


@pytest.mark.parametrize("case", [_senaite_born, _hplc_all_rows_rejected,
                                  _lookup_failed, _lookup_empty, _bw_panel_no_rows],
                         ids=["senaite_born", "hplc_all_rows_rejected", "lookup_failed",
                              "lookup_empty", "bw_panel_no_rows"])
def test_guard_still_aborts(db_session, monkeypatch, case):
    p = case(db_session, monkeypatch)
    with pytest.raises(NativeSectionsError, match=ABORT):
        build_legacy_rows(db_session, p, sections=[{"profile_key": "x"}])


def test_guard_still_aborts_when_verdict_errors(db_session, monkeypatch):
    from coa.a_la_carte import a_la_carte_verdict

    p = _alc(db_session, monkeypatch)

    def failing_query(db, pk):
        raise RuntimeError("lookup failed")
    monkeypatch.setattr("coa.native_sections._lab_added_profile_keys", failing_query)
    sections = [{"profile_key": "x"}]
    assert a_la_carte_verdict(db_session, p, sections=sections).reason.startswith("error:")
    with pytest.raises(NativeSectionsError) as ei:
        build_legacy_rows(db_session, p, sections=sections)
    assert str(ei.value) == (
        f"legacy rows: no legacy-family analyses found for {p.sample_id} — "
        "refusing to assemble an empty results table (mirror gap?)")


@pytest.mark.parametrize("key,keyword", ELIGIBLE)
def test_wire_document_emits_flagged_block_for_each_eligible_key(
        db_session, monkeypatch, mk1_mode, key, keyword):
    p = _alc(db_session, monkeypatch, key, keyword)
    doc = build_coa_wire_document(db_session, p)
    assert doc["legacy_rows"] == FLAGGED
    assert doc["sections"]
    assert doc["sections"] == build_native_sections(db_session, p)["sections"]


def test_panel_drop_bw_retest_emits_flagged_block(db_session, monkeypatch, mk1_mode):
    p = _retest_bw(db_session, monkeypatch)
    assert build_coa_wire_document(db_session, p)["legacy_rows"] == FLAGGED


def test_unflagged_block_has_no_page1_key(db_session, monkeypatch, mk1_mode):
    p = _alc(db_session, monkeypatch)
    monkeypatch.setattr("coa.wire_document.build_legacy_rows",
                        lambda db, p, **kw: [{"Keyword": "HPLC-PUR"}])
    doc = build_coa_wire_document(db_session, p)
    assert doc["legacy_rows"] == {"source": "mk1", "rows": [{"Keyword": "HPLC-PUR"}]}
    assert "page1" not in doc["legacy_rows"]


def test_vial_wire_document_still_aborts_for_a_la_carte(db_session, monkeypatch, mk1_mode):
    p = _alc(db_session, monkeypatch)
    with pytest.raises(NativeSectionsError, match=ABORT):
        build_vial_wire_document(db_session, p)


def test_regen_primary_posts_flagged_block(db_session, monkeypatch, mk1_mode):
    import main
    from tests.test_coa_deferred_sections_warning import _patch_generate_prereqs

    p = _alc(db_session, monkeypatch)
    order = {"services": {"fentanyl": True}, "package": "alacarte"}
    monkeypatch.setattr("coa.source_setting.coa_generation_source", lambda db: "mk1")
    monkeypatch.setattr("sub_samples.service.fetch_sample_services", lambda sid: order)
    client = _patch_generate_prereqs(
        monkeypatch, {"verification_code": "QRST-7890", "pdf_base64": None})

    async def _fake_publish(sample_id, current_user, db):
        return main.SampleCOAActionResponse(
            success=True, message="COA published", verification_code="QRST-7890")
    monkeypatch.setattr(main, "publish_sample_coa", _fake_publish)

    # asyncio.run, as test_coa_sections_endpoint.py does: pytest-asyncio is
    # not installed in this venv.
    asyncio.run(main.regen_primary_coa(sample_id=p.sample_id, db=db_session,
                                       current_user=SimpleNamespace(id=1)))
    sent = client.calls[0][1]["json"]["native_sections"]["legacy_rows"]
    assert sent["page1"] == "none"
    assert sent == FLAGGED
