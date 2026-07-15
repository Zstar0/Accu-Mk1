"""Tests for Layer-4 Task 4: the nightly shadow reconcile rider
(workflow/parent_mirror_reconcile.py).

Why this exists: the read flip retires the sample-details display fetch that
the slice-3 passive drift observer piggybacked on -- SENAITE-direct analysis
changes would otherwise go stale in the shadows with nothing to catch them.
The rider is a scheduled full sweep reusing the slice-2 backfill core
(`scripts/backfill_parent_analysis_shadows.py`, already M/I-blind per Layer 1,
idempotent, "doubles as manual reconcile" by design).

Test shape mirrors `tests/test_is_event_stream_sync.py`'s house rule: never
run the real asyncio loop with real sleeps -- `tick()` is a synchronous,
directly-callable function and is what every test here drives. The
invocation-shape tests patch the backfill core (`rider.backfill`) so they
never touch a real registry sweep. The M/I-preservation test instead uses
the REAL core with a mocked `fetch_parent_analyses`, reusing
`test_backfill_parent_analysis_shadows.py`'s harness idioms (TEST-prefixed
sample_id, `checkpoint_from_now`-style pre-seeded tmp_path checkpoint,
`sleep_s=0`) -- with an explicit `checkpoint_path` override so the rider's
own date-templated default (which would do a full-registry sweep from
scratch) is never exercised against the live prod-shaped dev registry.
"""
from __future__ import annotations

import logging
from datetime import datetime
from unittest.mock import patch

import pytest
from sqlalchemy import delete, func, select

from database import SessionLocal
from models import AnalysisService, Instrument, LimsAnalysis, LimsAnalysisTransition, LimsSample
from workflow import parent_mirror_reconcile as rider

ENV_VAR = rider.ENV_VAR
RUN_HOUR = rider.RUN_HOUR_UTC

IN_WINDOW = datetime(2026, 7, 15, RUN_HOUR, 5, 0)
IN_WINDOW_LATER_SAME_DAY = datetime(2026, 7, 15, RUN_HOUR, 45, 0)
NEXT_DAY_IN_WINDOW = datetime(2026, 7, 16, RUN_HOUR, 5, 0)
OUT_OF_WINDOW = datetime(2026, 7, 15, RUN_HOUR + 3, 0, 0)

TEST_SAMPLE_ID = "TEST-PMRR-NATIVE-MI"


@pytest.fixture(autouse=True)
def reset_guard():
    """`_last_run_date` is a module-level guard that persists across tests
    in-process -- reset before and after every test or "second tick same
    day" bleeds across test boundaries."""
    rider._last_run_date = None
    yield
    rider._last_run_date = None


# ═══════════════════════════════════════════════════════════════════════════
# gating + invocation shape -- core is always PATCHED here, never really run
# ═══════════════════════════════════════════════════════════════════════════


def test_tick_noop_when_env_disabled_by_default(monkeypatch):
    monkeypatch.delenv(ENV_VAR, raising=False)  # code default is "false"
    with patch.object(rider, "backfill") as mock_backfill:
        rider.tick(now=IN_WINDOW)
    mock_backfill.assert_not_called()


def test_tick_noop_when_env_explicitly_false(monkeypatch):
    monkeypatch.setenv(ENV_VAR, "false")
    with patch.object(rider, "backfill") as mock_backfill:
        rider.tick(now=IN_WINDOW)
    mock_backfill.assert_not_called()


def test_tick_noop_outside_the_nightly_window(monkeypatch):
    monkeypatch.setenv(ENV_VAR, "true")
    with patch.object(rider, "backfill") as mock_backfill:
        rider.tick(now=OUT_OF_WINDOW)
    mock_backfill.assert_not_called()


def test_tick_runs_once_in_window_with_throttle_and_fresh_checkpoint(monkeypatch):
    monkeypatch.setenv(ENV_VAR, "true")
    with patch.object(rider, "backfill", return_value={"seen": 0}) as mock_backfill:
        rider.tick(now=IN_WINDOW)

    mock_backfill.assert_called_once()
    args, kwargs = mock_backfill.call_args
    assert args[0] is SessionLocal
    # SENAITE bulk-scan hazard (feedback_senaite_bulk_scan_hazard): a single
    # Zope core took a ~15-min outage from an unthrottled sweep once already
    # -- the rider must never call the core with a throttle below 0.5s.
    assert kwargs["sleep_s"] >= 0.5
    assert kwargs["checkpoint_path"] == "/tmp/reconcile_shadows_2026-07-15.json"
    assert kwargs["dry_run"] is False


def test_tick_second_call_same_day_does_not_rerun(monkeypatch):
    monkeypatch.setenv(ENV_VAR, "true")
    with patch.object(rider, "backfill", return_value={"seen": 0}) as mock_backfill:
        rider.tick(now=IN_WINDOW)
        rider.tick(now=IN_WINDOW_LATER_SAME_DAY)
    mock_backfill.assert_called_once()


def test_tick_next_day_runs_again_with_a_new_checkpoint(monkeypatch):
    monkeypatch.setenv(ENV_VAR, "true")
    with patch.object(rider, "backfill", return_value={"seen": 0}) as mock_backfill:
        rider.tick(now=IN_WINDOW)
        rider.tick(now=NEXT_DAY_IN_WINDOW)

    assert mock_backfill.call_count == 2
    second_kwargs = mock_backfill.call_args_list[1].kwargs
    assert second_kwargs["checkpoint_path"] == "/tmp/reconcile_shadows_2026-07-16.json"


def test_tick_core_exception_is_logged_never_propagates(monkeypatch, caplog):
    monkeypatch.setenv(ENV_VAR, "true")
    with caplog.at_level(logging.WARNING, logger="workflow.parent_mirror_reconcile"):
        with patch.object(rider, "backfill", side_effect=RuntimeError("senaite hiccup")):
            rider.tick(now=IN_WINDOW)  # must not raise

    assert any("parent_mirror.reconcile_failed" in r.message for r in caplog.records)


# ═══════════════════════════════════════════════════════════════════════════
# M/I preservation -- real core, mocked fetch_parent_analyses (harness
# idioms borrowed from test_backfill_parent_analysis_shadows.py)
# ═══════════════════════════════════════════════════════════════════════════


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


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.rollback()
    db.execute(delete(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id.in_(
            select(LimsAnalysis.id).where(
                LimsAnalysis.lims_sample_pk.in_(
                    select(LimsSample.id).where(LimsSample.sample_id == TEST_SAMPLE_ID)
                )
            )
        )
    ))
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk.in_(
            select(LimsSample.id).where(LimsSample.sample_id == TEST_SAMPLE_ID)
        )
    ))
    db.execute(delete(LimsSample).where(LimsSample.sample_id == TEST_SAMPLE_ID))
    db.commit()


def _item(uid, keyword, **kw):
    base = {"uid": uid, "keyword": keyword, "result": None, "unit": None,
            "review_state": None, "retest_of_uid": None, "instrument_uid": None,
            "created": None}
    base.update(kw)
    return base


def test_rider_tick_preserves_native_mi_on_second_pass(
        db, monkeypatch, tmp_path, two_analysis_services, seeded_instrument):
    """L1 ownership invariant (read-flip spec §5), re-proven at the RIDER
    level rather than the bare backfill-core level: a natively-set
    method_id/instrument_id on a shadow row must survive a rider tick -- the
    rider never writes M/I because it just calls the same L1-blinded core,
    but this proves the tick() plumbing (env gate, window, checkpoint
    threading) doesn't accidentally bypass or duplicate that behavior."""
    monkeypatch.setenv(ENV_VAR, "true")
    from lims_analyses import service as la_service

    svc_a, _svc_b = two_analysis_services
    parent = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x",
                        status="received", external_lims_uid="SENAITE-UID-RIDER")
    db.add(parent); db.commit(); db.refresh(parent)

    # Explicit checkpoint override (tmp_path, pre-seeded at the current
    # max(id) -- same idiom as test_backfill_parent_analysis_shadows.py's
    # `checkpoint_from_now`) so this test's tick() calls only ever "see" the
    # TEST- prefixed row created here, never a full sweep of the live
    # prod-shaped dev registry.
    from scripts.backfill_parent_analysis_shadows import save_checkpoint
    ckpt = str(tmp_path / "rider_reconcile.json")
    max_id_before = db.execute(
        select(func.max(LimsSample.id)).where(LimsSample.id < parent.id)
    ).scalar() or 0
    save_checkpoint(ckpt, max_id_before, "seed")

    items_v1 = [_item("A", svc_a.keyword, result="OLD")]
    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items_v1):
        rider.tick(now=IN_WINDOW, sleep_s=0, checkpoint_path=ckpt)

    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, analysis_service_id=svc_a.id, provenance="shadow"
    ).one()
    la_service.set_method_instrument(
        db, analysis_id=row.id,
        method_id=None, instrument_id=seeded_instrument.id, user_id=None,
    )

    # Resume gotcha (same as the backfill suite's own M/I test): the first
    # tick already advanced this checkpoint past parent.id, so rewind it
    # before the second pass or it silently sees zero rows.
    save_checkpoint(ckpt, max_id_before, "reseed")

    # A second SAME-checkpoint pass on the NEXT day -- bypasses the
    # once-per-UTC-day guard exactly the way a real subsequent night would,
    # without touching the date-templated default checkpoint path.
    items_v2 = [_item("A", svc_a.keyword, result="NEW",
                      instrument_uid="TEST-SOME-OTHER-UID")]
    with patch("scripts.backfill_parent_analysis_shadows.fetch_parent_analyses",
               return_value=items_v2):
        rider.tick(now=NEXT_DAY_IN_WINDOW, sleep_s=0, checkpoint_path=ckpt)

    db.expire_all()
    row = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id, analysis_service_id=svc_a.id, provenance="shadow"
    ).one()
    assert row.result_value == "NEW"                       # mirror still mirrors
    assert row.instrument_id == seeded_instrument.id        # native M/I survives
    assert row.method_id is None
