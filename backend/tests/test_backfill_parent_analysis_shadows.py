"""Tests for Task 9: one-time backfill of parent-analysis shadow rows for
EXISTING SENAITE ARs (write hooks only capture post-deploy writes).

Modeled directly on test_backfill_basic_info.py's seams:
  * `select_current_lines` (pure, no DB) — newest-line-per-keyword selection
    incl. retest supersession — mirrors basic-info's enumeration unit tests.
  * `fetch_parent_analyses` (module-level, monkeypatchable) — the raw SENAITE
    payload extraction is tested separately by mocking `sub_samples.senaite._get`
    (house pattern, see test_sub_samples_senaite.py::fetch_results_by_keyword);
    the `backfill()` core tests patch `fetch_parent_analyses` directly so they
    never touch HTTP or care about raw payload shape.
  * `backfill()` iterates the LIVE `lims_samples` registry table (real
    SessionLocal(), prod-shaped dev Postgres per test_parent_mirror_helper.py's
    house pattern) ordered by id — each test pre-seeds its checkpoint at the
    current max(id) so it only ever "sees" the TEST-prefixed rows it creates,
    never the whole table.
"""
from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import delete, func, select

from database import SessionLocal
from models import AnalysisService, Instrument, LimsAnalysis, LimsAnalysisTransition, LimsSample

TEST_SAMPLE_IDS = [
    "TEST-PM9-PARENT", "TEST-PM9-PARENT2", "TEST-PM9-NOUID",
    "TEST-PM9-S01", "TEST-PM9-UNKNOWNKW",
]


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def two_analysis_services(db):
    svcs = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.isnot(None))
    ).scalars().all()[:2]
    if len(svcs) < 2:
        pytest.skip("need >=2 seeded analysis_services rows with a keyword")
    return svcs


@pytest.fixture
def seeded_instrument(db):
    inst = db.execute(
        select(Instrument).where(Instrument.senaite_uid.isnot(None))
    ).scalars().first()
    if inst is None:
        pytest.skip("no seeded Instrument with a senaite_uid available")
    return inst


@pytest.fixture
def checkpoint_from_now(db, tmp_path):
    """Pre-seed a checkpoint at the CURRENT max(lims_samples.id) so backfill()
    only processes rows this test creates afterward, never the whole
    prod-shaped dev registry."""
    from scripts.backfill_parent_analysis_shadows import save_checkpoint
    max_id = db.execute(select(func.max(LimsSample.id))).scalar() or 0
    path = str(tmp_path / "ckpt.json")
    save_checkpoint(path, max_id, "seed")
    return path


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.rollback()
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id.in_(
            select(LimsAnalysis.id).where(
                LimsAnalysis.lims_sample_pk.in_(
                    select(LimsSample.id).where(LimsSample.sample_id.in_(TEST_SAMPLE_IDS))
                )
            )
        )
    ))
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk.in_(
            select(LimsSample.id).where(LimsSample.sample_id.in_(TEST_SAMPLE_IDS))
        )
    ))
    db.execute(delete(LimsSample).where(LimsSample.sample_id.in_(TEST_SAMPLE_IDS)))
    db.commit()


# ═══════════════════════════════════════════════════════════════════════════
# select_current_lines — pure, no DB (newest-line-per-keyword incl. retest
# supersession)
# ═══════════════════════════════════════════════════════════════════════════
from scripts.backfill_parent_analysis_shadows import select_current_lines


def _item(uid, keyword, **kw):
    base = {"uid": uid, "keyword": keyword, "result": None, "unit": None,
            "review_state": None, "retest_of_uid": None, "instrument_uid": None,
            "created": None}
    base.update(kw)
    return base


def test_select_current_lines_single_line_per_keyword():
    items = [_item("A", "KW1", result="1"), _item("B", "KW2", result="2")]
    out = select_current_lines(items)
    assert set(out.keys()) == {"KW1", "KW2"}
    assert out["KW1"]["uid"] == "A"
    assert out["KW2"]["uid"] == "B"


def test_select_current_lines_drops_retest_superseded_original():
    """A is retested by B (B.retest_of_uid == A's uid): A must be dropped as
    superseded, B is the current line for the keyword."""
    items = [
        _item("A", "KW1", result="1"),
        _item("B", "KW1", result="2", retest_of_uid="A"),
    ]
    out = select_current_lines(items)
    assert out["KW1"]["uid"] == "B"
    assert out["KW1"]["result"] == "2"


def test_select_current_lines_picks_newest_by_created_date_over_position():
    """Position in the list must NOT win over an explicit created date: X2 is
    listed FIRST but has the LATER date, so it must be selected over X1."""
    items = [
        _item("X2", "KW1", created="2026-03-01T00:00:00+00:00"),
        _item("X1", "KW1", created="2026-01-01T00:00:00+00:00"),
    ]
    out = select_current_lines(items)
    assert out["KW1"]["uid"] == "X2"


def test_select_current_lines_falls_back_to_last_in_list_when_no_dates():
    items = [
        _item("X1", "KW1", created=None),
        _item("X2", "KW1", created=None),
    ]
    out = select_current_lines(items)
    assert out["KW1"]["uid"] == "X2"  # last in list


def test_select_current_lines_created_date_tie_breaks_to_last_in_list():
    """Tie-break consistency: when two lines share a created timestamp the
    LAST one in catalog order must win — the same rule as the no-dates
    fallback. A bare max() returns the FIRST maximal element and would
    contradict that fallback."""
    items = [
        _item("X1", "KW1", created="2026-01-01T00:00:00+00:00"),
        _item("X2", "KW1", created="2026-01-01T00:00:00+00:00"),
    ]
    out = select_current_lines(items)
    assert out["KW1"]["uid"] == "X2"


def test_select_current_lines_skips_items_without_a_keyword():
    items = [_item("A", None, result="1"), _item("B", "KW1", result="2")]
    out = select_current_lines(items)
    assert set(out.keys()) == {"KW1"}


def test_select_current_lines_multi_retest_chain_keeps_only_final():
    """A -> B -> C (each retests the previous): only C (not referenced by
    anyone else's retest_of_uid) survives."""
    items = [
        _item("A", "KW1", result="1"),
        _item("B", "KW1", result="2", retest_of_uid="A"),
        _item("C", "KW1", result="3", retest_of_uid="B"),
    ]
    out = select_current_lines(items)
    assert out["KW1"]["uid"] == "C"
    assert out["KW1"]["result"] == "3"


# ═══════════════════════════════════════════════════════════════════════════
# fetch_parent_analyses — raw SENAITE payload extraction (mocks
# sub_samples.senaite._get, house pattern from test_sub_samples_senaite.py)
# ═══════════════════════════════════════════════════════════════════════════
from scripts.backfill_parent_analysis_shadows import fetch_parent_analyses


def test_fetch_parent_analyses_queries_correct_endpoint_and_params():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": []}
    with patch("sub_samples.senaite._get", return_value=mock_resp) as m:
        fetch_parent_analyses("P-0001")
    assert m.call_args.args[0].endswith("/@@API/senaite/v1/Analysis")
    assert m.call_args.kwargs["params"] == {
        "getRequestID": "P-0001", "complete": "yes", "limit": 200,
    }


def test_fetch_parent_analyses_extracts_keyword_result_unit_state():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"uid": "U1", "getKeyword": "ANALYTE-1-PUR", "Result": "99.2",
         "Unit": "%", "review_state": "to_be_verified"},
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        out = fetch_parent_analyses("P-0001")
    assert out == [{
        "uid": "U1", "keyword": "ANALYTE-1-PUR", "result": "99.2", "unit": "%",
        "review_state": "to_be_verified", "retest_of_uid": None,
        "instrument_uid": None, "created": None,
    }]


def test_fetch_parent_analyses_keyword_falls_back_to_plain_Keyword_field():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"uid": "U1", "Keyword": "ID_GHKCU", "Result": "Conforms"},
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        out = fetch_parent_analyses("P-0001")
    assert out[0]["keyword"] == "ID_GHKCU"


def test_fetch_parent_analyses_retest_of_uid_prefers_getRetestOfUID():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"uid": "U2", "getKeyword": "KW", "getRetestOfUID": "U1",
         "RetestOf": {"uid": "SHOULD-NOT-USE"}},
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        out = fetch_parent_analyses("P-0001")
    assert out[0]["retest_of_uid"] == "U1"


def test_fetch_parent_analyses_retest_of_uid_falls_back_to_RetestOf_dict():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"uid": "U2", "getKeyword": "KW", "RetestOf": {"uid": "U1"}},
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        out = fetch_parent_analyses("P-0001")
    assert out[0]["retest_of_uid"] == "U1"


def test_fetch_parent_analyses_instrument_uid_from_nested_instrument_object():
    """SENAITE's Analysis catalog carries the instrument as a nested
    `Instrument` object ref ({"uid": ..., "title": ...}) on the same payload
    shape as getRequestID/Keyword/Result — same endpoint main.py's AR-detail
    fetch reads at ~12504-12510. Only the uid is needed for
    resolve_instrument_id; title is not extracted here."""
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"uid": "U1", "getKeyword": "KW", "Instrument": {"uid": "INST-UID-1", "title": "HPLC-1"}},
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        out = fetch_parent_analyses("P-0001")
    assert out[0]["instrument_uid"] == "INST-UID-1"


def test_fetch_parent_analyses_instrument_uid_none_when_absent():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"uid": "U1", "getKeyword": "KW"},
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        out = fetch_parent_analyses("P-0001")
    assert out[0]["instrument_uid"] is None


def test_fetch_parent_analyses_created_field_fallback_chain():
    mock_resp = MagicMock(status_code=200)
    mock_resp.json.return_value = {"items": [
        {"uid": "U1", "getKeyword": "KW", "DateCreated": "2026-01-01T00:00:00+00:00"},
    ]}
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        out = fetch_parent_analyses("P-0001")
    assert out[0]["created"] == "2026-01-01T00:00:00+00:00"


def test_fetch_parent_analyses_raises_on_http_error():
    mock_resp = MagicMock(status_code=500, text="boom")
    with patch("sub_samples.senaite._get", return_value=mock_resp):
        with pytest.raises(RuntimeError):
            fetch_parent_analyses("P-0001")


# ═══════════════════════════════════════════════════════════════════════════
# backfill() core — iterates the lims_samples registry, mirrors current lines
# ═══════════════════════════════════════════════════════════════════════════
from scripts.backfill_parent_analysis_shadows import backfill, load_checkpoint, save_checkpoint


def _run(checkpoint_path, **kw):
    kwargs = dict(sleep_s=0, batch_size=50, checkpoint_path=checkpoint_path,
                  dry_run=False, limit=None)
    kwargs.update(kw)
    return backfill(SessionLocal, **kwargs)


def test_backfill_creates_shadow_rows_for_current_lines(
        db, checkpoint_from_now, two_analysis_services):
    svc_a, svc_b = two_analysis_services
    parent = LimsSample(sample_id="TEST-PM9-PARENT", sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-1")
    db.add(parent); db.commit(); db.refresh(parent)

    items = [
        _item("A", svc_a.keyword, result="1", unit="%", review_state="verified"),
        _item("B", svc_b.keyword, result="2", review_state="to_be_verified"),
    ]
    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items) as fetch:
        stats = _run(checkpoint_from_now)

    fetch.assert_called_once_with("TEST-PM9-PARENT")
    assert stats["seen"] == 1
    assert stats["created"] == 2
    assert stats["updated"] == 0
    assert stats["errors"] == 0

    rows = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow"
    ).order_by(LimsAnalysis.analysis_service_id).all()
    assert len(rows) == 2
    by_svc = {r.analysis_service_id: r for r in rows}
    assert by_svc[svc_a.id].result_value == "1"
    assert by_svc[svc_a.id].result_unit == "%"
    assert by_svc[svc_a.id].mirror_review_state == "verified"
    assert by_svc[svc_b.id].mirror_review_state == "to_be_verified"
    # Known gap: method resolution is not attempted this slice.
    assert by_svc[svc_a.id].method_id is None


def test_backfill_only_mirrors_current_line_after_retest_supersession(
        db, checkpoint_from_now, two_analysis_services):
    svc_a, _svc_b = two_analysis_services
    parent = LimsSample(sample_id="TEST-PM9-PARENT", sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-1")
    db.add(parent); db.commit(); db.refresh(parent)

    items = [
        _item("A", svc_a.keyword, result="OLD", review_state="retracted"),
        _item("B", svc_a.keyword, result="NEW", review_state="verified", retest_of_uid="A"),
    ]
    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items):
        stats = _run(checkpoint_from_now)

    assert stats["created"] == 1  # one shadow row per keyword, not per line
    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, analysis_service_id=svc_a.id, provenance="shadow"
    ).one()
    assert row.result_value == "NEW"
    assert row.mirror_review_state == "verified"
    assert row.retested is False  # backfilled as the current row, not a retest chain


def test_backfill_resolves_instrument_uid_onto_shadow_row(
        db, checkpoint_from_now, two_analysis_services, seeded_instrument):
    svc_a, _svc_b = two_analysis_services
    parent = LimsSample(sample_id="TEST-PM9-PARENT", sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-1")
    db.add(parent); db.commit(); db.refresh(parent)

    items = [_item("A", svc_a.keyword, result="1", instrument_uid=seeded_instrument.senaite_uid)]
    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items):
        _run(checkpoint_from_now)

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, analysis_service_id=svc_a.id, provenance="shadow"
    ).one()
    assert row.instrument_id == seeded_instrument.id


def test_backfill_unresolved_keyword_is_a_silent_no_op(db, checkpoint_from_now):
    parent = LimsSample(sample_id="TEST-PM9-UNKNOWNKW", sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-X")
    db.add(parent); db.commit(); db.refresh(parent)

    items = [_item("A", "TEST-PM9-NO-SUCH-KEYWORD-EVER", result="1")]
    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items):
        stats = _run(checkpoint_from_now)

    assert stats["seen"] == 1
    assert stats["created"] == 0 and stats["updated"] == 0 and stats["errors"] == 0
    assert db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id).count() == 0


def test_backfill_idempotent_rerun_updates_not_duplicates(
        db, checkpoint_from_now, two_analysis_services):
    svc_a, _svc_b = two_analysis_services
    parent = LimsSample(sample_id="TEST-PM9-PARENT", sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-1")
    db.add(parent); db.commit(); db.refresh(parent)

    items_v1 = [_item("A", svc_a.keyword, result="1", review_state="to_be_verified")]
    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items_v1):
        stats1 = _run(checkpoint_from_now)
    assert stats1["created"] == 1 and stats1["updated"] == 0

    rows = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow").all()
    assert len(rows) == 1

    # Simulate the documented resume gotcha: re-run from the SAME starting
    # point (as if the checkpoint file had been deleted to retry/rescan).
    save_checkpoint(checkpoint_from_now, db.execute(
        select(func.max(LimsSample.id)).where(LimsSample.id < parent.id)
    ).scalar() or 0, "reseed")

    items_v2 = [_item("A", svc_a.keyword, result="2", review_state="verified")]
    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items_v2):
        stats2 = _run(checkpoint_from_now)
    assert stats2["created"] == 0 and stats2["updated"] == 1

    # The row was mutated through backfill()'s OWN SessionLocal(), a
    # different session than this test's `db` fixture — expire this
    # session's identity map so the re-query below reflects that commit
    # instead of the stale in-memory copy from the earlier `rows` query.
    db.expire_all()
    rows = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, provenance="shadow").all()
    assert len(rows) == 1  # still exactly one row — updated in place
    assert rows[0].result_value == "2"
    assert rows[0].mirror_review_state == "verified"


def test_backfill_dry_run_writes_nothing(db, checkpoint_from_now, two_analysis_services):
    svc_a, _svc_b = two_analysis_services
    parent = LimsSample(sample_id="TEST-PM9-PARENT", sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-1")
    db.add(parent); db.commit(); db.refresh(parent)

    items = [_item("A", svc_a.keyword, result="1")]
    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items) as fetch:
        stats = _run(checkpoint_from_now, dry_run=True)

    assert stats["seen"] == 1
    fetch.assert_called_once()  # dry-run still fetches (rehearsal), just doesn't write
    assert db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id).count() == 0


def test_backfill_dry_run_leaves_no_checkpoint(db, tmp_path, two_analysis_services):
    svc_a, _svc_b = two_analysis_services
    parent = LimsSample(sample_id="TEST-PM9-PARENT", sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-1")
    db.add(parent); db.commit(); db.refresh(parent)
    max_id_before = db.execute(
        select(func.max(LimsSample.id)).where(LimsSample.id < parent.id)
    ).scalar() or 0
    ckpt = tmp_path / "dry.json"
    save_checkpoint(str(ckpt), max_id_before, "seed")
    orig_mtime = ckpt.stat().st_mtime_ns

    items = [_item("A", svc_a.keyword, result="1")]
    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items):
        backfill(SessionLocal, sleep_s=0, batch_size=50, checkpoint_path=str(ckpt),
                 dry_run=True, limit=None)

    # File is unchanged (checkpoint is loaded but never rewritten on dry-run).
    assert ckpt.stat().st_mtime_ns == orig_mtime
    assert load_checkpoint(str(ckpt)) == max_id_before


def test_backfill_skips_null_external_lims_uid(db, checkpoint_from_now):
    parent = LimsSample(sample_id="TEST-PM9-NOUID", sample_type="x",
                        status="received", external_lims_uid=None)
    db.add(parent); db.commit(); db.refresh(parent)

    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses") as fetch:
        stats = _run(checkpoint_from_now)

    assert stats["seen"] == 1
    assert stats["skipped_no_uid"] == 1
    assert stats["created"] == 0 and stats["updated"] == 0
    fetch.assert_not_called()
    assert db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id).count() == 0


def test_backfill_skips_secondary_sample_ids(db, checkpoint_from_now):
    """Defensive: a stray `-S\\d+` secondary in lims_samples has a real
    external_lims_uid (it IS a SENAITE AR) but must never be treated as a
    parent — same regex convention as backfill_lims_sample_basic_info.py."""
    parent = LimsSample(sample_id="TEST-PM9-S01", sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-SECONDARY")
    db.add(parent); db.commit(); db.refresh(parent)

    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses") as fetch:
        stats = _run(checkpoint_from_now)

    assert stats["seen"] == 1
    assert stats["skipped_secondary"] == 1
    fetch.assert_not_called()
    assert db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id).count() == 0


def test_backfill_one_parent_error_does_not_abort_others(
        db, checkpoint_from_now, two_analysis_services):
    svc_a, _svc_b = two_analysis_services
    p1 = LimsSample(sample_id="TEST-PM9-PARENT", sample_type="x",
                    status="received", external_lims_uid="SENAITE-UID-1")
    p2 = LimsSample(sample_id="TEST-PM9-PARENT2", sample_type="x",
                    status="received", external_lims_uid="SENAITE-UID-2")
    db.add_all([p1, p2]); db.commit(); db.refresh(p1); db.refresh(p2)

    def _side_effect(sample_id):
        if sample_id == "TEST-PM9-PARENT":
            raise RuntimeError("senaite hiccup")
        return [_item("A", svc_a.keyword, result="1")]

    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               side_effect=_side_effect):
        stats = _run(checkpoint_from_now)

    assert stats["seen"] == 2
    assert stats["errors"] == 1
    assert stats["created"] == 1


def test_backfill_stats_count_only_committed_rows_on_partial_keyword_failure(
        db, checkpoint_from_now, two_analysis_services):
    """Reviewer reproduction (Task 9 review, Important): two-keyword parent,
    first mirror call succeeds, second raises. The per-parent transaction
    rolls back the WHOLE parent (session closed uncommitted), so NOTHING
    persists — the stats line (the run's documented coverage evidence) must
    therefore report created=0/updated=0/errors=1, NOT the pre-fix
    created=1/errors=1 overcount for a row that never landed."""
    from lims_analyses.parent_mirror import mirror_parent_analysis as real_mirror
    svc_a, svc_b = two_analysis_services
    parent = LimsSample(sample_id="TEST-PM9-PARENT", sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-1")
    db.add(parent); db.commit(); db.refresh(parent)

    items = [
        _item("A", svc_a.keyword, result="1"),
        _item("B", svc_b.keyword, result="2"),
    ]
    calls = {"n": 0}

    def _flaky_mirror(db_arg, **kw):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise RuntimeError("boom on second keyword")
        return real_mirror(db_arg, **kw)

    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items), \
         patch("scripts.backfill_parent_analysis_shadows.mirror_parent_analysis",
               side_effect=_flaky_mirror):
        stats = _run(checkpoint_from_now)

    assert calls["n"] == 2  # first keyword really did write (then rolled back)
    assert stats["errors"] == 1
    assert stats["created"] == 0 and stats["updated"] == 0
    # And the DB agrees with the stats: nothing persisted for this parent.
    assert db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id).count() == 0


def test_backfill_respects_limit(db, checkpoint_from_now, two_analysis_services):
    svc_a, _svc_b = two_analysis_services
    p1 = LimsSample(sample_id="TEST-PM9-PARENT", sample_type="x",
                    status="received", external_lims_uid="SENAITE-UID-1")
    p2 = LimsSample(sample_id="TEST-PM9-PARENT2", sample_type="x",
                    status="received", external_lims_uid="SENAITE-UID-2")
    db.add_all([p1, p2]); db.commit()

    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=[_item("A", svc_a.keyword, result="1")]):
        stats = _run(checkpoint_from_now, limit=1)
    assert stats["seen"] == 1


# ═══════════════════════════════════════════════════════════════════════════
# checkpoint + CLI
# ═══════════════════════════════════════════════════════════════════════════
from scripts.backfill_parent_analysis_shadows import main


def test_checkpoint_round_trip(tmp_path):
    p = str(tmp_path / "ckpt.json")
    assert load_checkpoint(p) == 0  # missing file -> fresh
    save_checkpoint(p, 150, "P-0150")
    assert load_checkpoint(p) == 150
    (tmp_path / "ckpt.json").write_text("garbage")
    assert load_checkpoint(p) == 0  # corrupt file -> fresh


def test_main_prints_stats_json_and_exit_code(db, tmp_path, capsys, two_analysis_services):
    svc_a, _svc_b = two_analysis_services
    parent = LimsSample(sample_id="TEST-PM9-PARENT", sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-1")
    db.add(parent); db.commit(); db.refresh(parent)
    max_id_before = db.execute(
        select(func.max(LimsSample.id)).where(LimsSample.id < parent.id)
    ).scalar() or 0
    ckpt = str(tmp_path / "c.json")
    save_checkpoint(ckpt, max_id_before, "seed")

    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=[_item("A", svc_a.keyword, result="1")]):
        rc = main(["--checkpoint", ckpt, "--sleep", "0"])
    assert rc == 0
    stats = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert stats["created"] == 1


def test_main_exit_code_reflects_errors(db, tmp_path, capsys):
    parent = LimsSample(sample_id="TEST-PM9-PARENT", sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-1")
    db.add(parent); db.commit(); db.refresh(parent)
    max_id_before = db.execute(
        select(func.max(LimsSample.id)).where(LimsSample.id < parent.id)
    ).scalar() or 0
    ckpt = str(tmp_path / "c.json")
    save_checkpoint(ckpt, max_id_before, "seed")

    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               side_effect=RuntimeError("senaite hiccup")):
        rc = main(["--checkpoint", ckpt, "--sleep", "0"])
    assert rc == 1
    stats = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert stats["errors"] == 1
