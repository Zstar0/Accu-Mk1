"""Generate Per-Vial COAs regenerates every vial (Handler, 2026-10-20).

The manual route no longer skips vials that already have a live child: it
hands the loop an empty `existing` set and reports "Regenerated N". The
Integration Service retires the previous draft of the same vial when the new
child is minted (IS 1.0.37). The automatic post-primary run keeps its
fetch_existing_vial_sequences idempotency.

Real dev Postgres session for the parent row (house pattern of
tests/test_hplc_native_attachments.py); the IS lookups, the vial listing and
the COABuilder loop are patched.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

import main
from auth import get_current_user
from database import SessionLocal
from models import LimsSample

TEST_PARENT = "TEST-VCREGEN-P1"
PRIMARY_ID = "11111111-1111-1111-1111-111111111111"
VIALS = [(1, {"a": 1}), (2, {"a": 2})]


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


@pytest.fixture(autouse=True)
def cleanup(db):
    yield
    db.rollback()
    db.execute(delete(LimsSample).where(LimsSample.sample_id.like("TEST-VCREGEN-%")))
    db.commit()


@pytest.fixture
def parent(db):
    row = LimsSample(sample_id=TEST_PARENT, external_lims_system="mk1",
                     sample_type="x", status="published")
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _client() -> TestClient:
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides[get_current_user] = (
        lambda: MagicMock(id=1, email="a@x", role="standard"))
    return TestClient(main.app)


def _post(loop):
    with patch.object(main, "COA_BUILDER_URL", "http://coab.test"), \
         patch("integration_db.fetch_primary_generation", return_value={"id": PRIMARY_ID}), \
         patch("integration_db.fetch_existing_vial_sequences", return_value={1, 2}) as existing, \
         patch("coa.variance_series.list_hplc_vials_with_figures", return_value=VIALS), \
         patch.object(main, "_generate_vial_coas_loop", loop):
        r = _client().post(f"/wizard/senaite/samples/{TEST_PARENT}/generate-vial-coas")
    return r, existing


def test_manual_generate_regenerates_vials_that_already_have_live_children(parent):
    loop = AsyncMock(return_value=([{"vial_sequence": 1}, {"vial_sequence": 2}], [], []))
    r, existing = _post(loop)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert body["message"] == "Regenerated 2 per-vial COA(s)"
    assert body["expected"] == 2
    assert [g["vial_sequence"] for g in body["generated"]] == [1, 2]
    assert body["skipped"] == [] and body["errors"] == []
    # Every vial reaches the loop with an EMPTY existing set, and the
    # live-child lookup is not consulted on the manual path at all.
    args, _kwargs = loop.call_args
    assert args[2] == VIALS
    assert args[3] == PRIMARY_ID
    assert args[4] == set()
    existing.assert_not_called()


def test_manual_generate_reports_failures(parent):
    loop = AsyncMock(return_value=(
        [{"vial_sequence": 1}], [], [{"vial_sequence": 2, "error": "COA aborted"}]))
    r, _existing = _post(loop)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is False
    assert body["message"] == "Regenerated 1 per-vial COA(s); 1 failed"
    assert body["errors"][0]["vial_sequence"] == 2


def test_automatic_post_primary_run_keeps_its_idempotency(db):
    """_maybe_emit_vial_coas is unchanged: a vial with a live child is still
    skipped there (the loop receives the Integration Service's existing set)."""
    loop = AsyncMock(return_value=([{"vial_sequence": 2}], [1], []))
    parent_row = SimpleNamespace(customer_remarks_include=False, customer_remarks=None)
    with patch.object(main, "COA_BUILDER_URL", "http://coab.test"), \
         patch("coa.variance_series.build_variance_replicates", return_value=[1, 2]), \
         patch("coa.variance_series.list_hplc_vials_with_figures", return_value=VIALS), \
         patch("integration_db.fetch_existing_vial_sequences", return_value={1}) as existing, \
         patch.object(main, "_generate_vial_coas_loop", loop):
        asyncio.run(main._maybe_emit_vial_coas(
            db, TEST_PARENT, parent_row, {"generation_id": PRIMARY_ID}))
    existing.assert_called_once_with(PRIMARY_ID)
    args, _kwargs = loop.call_args
    assert args[4] == {1}
