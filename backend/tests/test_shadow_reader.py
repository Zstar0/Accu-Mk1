# backend/tests/test_shadow_reader.py
"""Shadow-backed resolver reader (spec §5): serves the SenaiteAnalysesReader
Protocol from native rows. Parity pins: retest_of_uid synthesized as mk1:{id};
reportable surfaced; review_state=None aborts; resolver drops superseded
originals exactly as with the HTTP reader."""
import asyncio
import pytest
from unittest.mock import patch

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
