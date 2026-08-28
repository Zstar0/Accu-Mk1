# backend/tests/test_shadow_reader.py
"""Shadow-backed resolver reader (spec §5): serves the SenaiteAnalysesReader
Protocol from native rows. Parity pins: retest_of_uid synthesized as mk1:{id};
reportable surfaced; review_state=None aborts; resolver drops superseded
originals exactly as with the HTTP reader."""
import asyncio
import pytest
from unittest.mock import Mock, patch

import main
from coa.shadow_reader import ShadowAnalysesReader


def _shape(uid, keyword, result="1", unit="%", state="verified",
           retest_of_id=None, reportable=True):
    class Row:
        pass
    r = Row()
    r.uid, r.keyword, r.result, r.unit = uid, keyword, result, unit
    r.review_state, r.retest_of_id, r.reportable = state, retest_of_id, reportable
    return r


def _run(reader, sid="P-1"):
    # asyncio.run (not get_event_loop().run_until_complete) — the latter is
    # order-dependent when pytest-asyncio tests elsewhere in the same
    # session have already consumed/closed the default event loop.
    return asyncio.run(reader.list_for_sample(sid))


def test_dict_shape_and_retest_link_synthesis():
    rows = [_shape("mk1:10", "HPLC-PUR", retest_of_id=None),
            _shape("mk1:11", "HPLC-PUR", retest_of_id=10)]
    with patch("coa.shadow_reader._shaped_rows", return_value=rows):
        out = _run(ShadowAnalysesReader(db=object()))
    by_uid = {o["uid"]: o for o in out}
    assert by_uid["mk1:11"]["retest_of_uid"] == "mk1:10"
    assert by_uid["mk1:10"]["retest_of_uid"] is None
    assert by_uid["mk1:10"]["reportable"] is True
    assert set(out[0]) >= {"uid", "keyword", "result", "unit", "review_state",
                           "retest_of_uid", "reportable"}


def test_none_review_state_aborts():
    rows = [_shape("mk1:10", "X", state=None)]
    with patch("coa.shadow_reader._shaped_rows", return_value=rows), \
         pytest.raises(ValueError):
        _run(ShadowAnalysesReader(db=object()))


def test_resolver_drops_superseded_original_via_mk1_links():
    from coa.source_resolver import _gather_candidates_for
    payload = {"P-1": [
        {"uid": "mk1:10", "keyword": "HPLC-PUR", "result": "95", "unit": "%",
         "review_state": "verified", "retest_of_uid": None, "reportable": True},
        {"uid": "mk1:11", "keyword": "HPLC-PUR", "result": "97", "unit": "%",
         "review_state": "verified", "retest_of_uid": "mk1:10", "reportable": True},
    ]}
    cands = _gather_candidates_for("P-1", True, payload, False)
    uids = [c.source_analysis_uid for c in cands["HPLC-PUR"]]
    assert uids == ["mk1:11"]


def test_gather_respects_reportable_false():
    from coa.source_resolver import _gather_candidates_for
    payload = {"P-1": [
        {"uid": "mk1:10", "keyword": "X", "result": "1", "unit": "",
         "review_state": "verified", "retest_of_uid": None, "reportable": False},
    ]}
    cands = _gather_candidates_for("P-1", True, payload, False)
    assert cands["X"][0].reportable is False


# ── serializer test: SenaiteShapeAnalysisResponse carries retest_of_id +
# reportable straight off the LimsAnalysis row (additive fields the shadow
# reader depends on) — real DB fixture, not the mocked _shaped_rows above.


def test_senaite_shape_response_carries_retest_of_id_and_reportable(db_session):
    from models import AnalysisService, LimsAnalysis, LimsSample
    from lims_analyses.service import list_parent_analyses_senaite_shape

    parent = LimsSample(sample_id="TEST-SHADOW-PARENT")
    db_session.add(parent)
    db_session.flush()
    svc = AnalysisService(keyword="SHADOW-KW", title="Shadow Test")
    db_session.add(svc)
    db_session.flush()

    original = LimsAnalysis(
        lims_sample_pk=parent.id, lims_sub_sample_pk=None,
        analysis_service_id=svc.id, keyword=svc.keyword, title=svc.title,
        review_state="retracted", provenance="canonical",
        retested=True, reportable=True,
    )
    db_session.add(original)
    db_session.flush()
    retest = LimsAnalysis(
        lims_sample_pk=parent.id, lims_sub_sample_pk=None,
        analysis_service_id=svc.id, keyword=svc.keyword, title=svc.title,
        review_state="verified", provenance="canonical",
        retested=False, retest_of_id=original.id, reportable=False,
    )
    db_session.add(retest)
    db_session.commit()

    rows = list_parent_analyses_senaite_shape(db_session, parent.sample_id)
    by_uid = {r.uid: r for r in rows}

    # original is retested=True -> excluded from the query itself; only the
    # retest row surfaces (mirrors the existing "current row" contract).
    assert f"mk1:{retest.id}" in by_uid
    assert by_uid[f"mk1:{retest.id}"].retest_of_id == original.id
    assert by_uid[f"mk1:{retest.id}"].reportable is False


# ── review Finding 1 (Critical) regression pin: main.py's needs_chromatogram
# fallback (runs when resolver_result stays None, e.g. the shadow reader's
# fail-open abort) must derive the requirement NATIVELY in mk1 mode and must
# NEVER call sub_samples.senaite.fetch_parent_analysis_keywords — a
# synchronous, blocking SENAITE HTTP call that fires even with SENAITE_URL
# unset (sub_samples/senaite.py resolves its own SENAITE_BASE_URL
# independently, defaulting to localhost:8080).


@pytest.mark.asyncio
async def test_mk1_resolver_failure_derives_chromatogram_natively_no_senaite_call(
    db_session, monkeypatch,
):
    from fastapi import HTTPException
    from models import AnalysisService, LimsAnalysis, LimsSample
    from types import SimpleNamespace

    sample_id = "P-9500"
    parent = LimsSample(sample_id=sample_id)
    db_session.add(parent)
    db_session.flush()
    svc = AnalysisService(keyword="HPLC-PUR", title="Peptide Purity (HPLC)")
    db_session.add(svc)
    db_session.flush()
    db_session.add(LimsAnalysis(
        lims_sample_pk=parent.id, lims_sub_sample_pk=None,
        analysis_service_id=svc.id, keyword=svc.keyword, title=svc.title,
        review_state="verified", provenance="canonical",
        retested=False, result_value="98.2",
    ))
    db_session.commit()

    monkeypatch.setattr(
        "coa.source_setting.coa_generation_source", lambda db: "mk1")

    # Force the resolver pre-flight to fail -> resolver_result stays None,
    # exercising generate_sample_coa's existing fail-open catch.
    def _boom(*a, **kw):
        raise RuntimeError("simulated resolver failure")
    monkeypatch.setattr("coa.source_resolver.resolve_sources", _boom)

    # THE PIN: must never be called in mk1 mode.
    forbidden = Mock(side_effect=AssertionError(
        "fetch_parent_analysis_keywords (SENAITE HTTP) must not be called "
        "in mk1 mode"))
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords", forbidden)

    # Variance-lock gate is unrelated to this fix and reaches Integration
    # Service over HTTP by default; keep it fast/deterministic — it is
    # already fail-soft in production when IS is unreachable.
    monkeypatch.setattr(
        "sub_samples.service.fetch_sample_services",
        Mock(side_effect=RuntimeError("no IS in this test")))

    monkeypatch.setattr(main, "COA_BUILDER_URL", "http://coabuilder.test")

    with pytest.raises(HTTPException) as exc_info:
        await main.generate_sample_coa(
            sample_id=sample_id, db=db_session,
            current_user=SimpleNamespace(id=1),
        )

    forbidden.assert_not_called()

    blockers = exc_info.value.detail["blockers"]
    attach_blocker = next(b for b in blockers if b["code"] == "missing_attachments")
    # needs_chromatogram derived True from the native HPLC-PUR row (no micro
    # exemption configured in this fixture) — proves the native derivation
    # ran and produced a real answer, not a silently-False fallback.
    assert "chromatogram" in attach_blocker["missing"]
    assert "sample_image" in attach_blocker["missing"]
