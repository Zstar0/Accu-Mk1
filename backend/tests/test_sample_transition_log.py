"""Tests for Task 3: the native sample-transition recorder
(workflow/sample_log.py) + the two Mk1 hooks that call it — publish_sample_coa
(publish) and receive_senaite_sample (receive).

Recorder unit tests exercise `record_sample_transition` directly against a
live session: insert, the two source-specific dedup rules (§6.2/§6.3), an
unknown sample, and an is_event_id collision (proving the caller's session
survives the IntegrityError via the begin_nested() savepoint).

Endpoint hook tests drive the real endpoints through TestClient with
httpx.AsyncClient mocked (`patch("httpx.AsyncClient")` + __aenter__/__aexit__
idiom from tests/test_parent_mirror_hooks.py:69), letting
`_record_sample_transition_bg` run for real (own SessionLocal, committed
before the awaited endpoint returns) so the DB row can be asserted directly.
The publish-flow fixture (`_drive_publish_coa`) is adapted from
tests/test_parent_mirror_hooks.py's helper of the same name — same one mocked
httpx instance serves all three of publish-coa's `async with` blocks.

House pattern: TEST-prefixed rows (`TEST-WST3-` sample_ids), FK-safe cleanup
(LimsSampleTransition before LimsSample). Real seeded admin user id=1 is used
for actor_user_id (avoids creating/cleaning up a dedicated User row — see
test_workflow_catalog_api.py's `client` fixture for the same convention).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

import main
from auth import get_current_user
from database import SessionLocal
from models import LimsSample, LimsSampleTransition
from workflow.sample_log import record_sample_transition

TEST_SAMPLE_ID = "TEST-WST3-SAMPLE"


# ── fixtures ─────────────────────────────────────────────────────────────

def _client_as_user(user_id: int = 1) -> TestClient:
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides[get_current_user] = (
        lambda: MagicMock(id=user_id, email="a@x", role="standard"))
    return TestClient(main.app)


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
    db.execute(delete(LimsSampleTransition).where(
        LimsSampleTransition.lims_sample_pk.in_(
            select(LimsSample.id).where(LimsSample.sample_id.like("TEST-WST3-%"))
        )
    ))
    db.execute(delete(LimsSample).where(LimsSample.sample_id.like("TEST-WST3-%")))
    db.commit()


@pytest.fixture
def seed_sample(db):
    row = LimsSample(sample_id=TEST_SAMPLE_ID, sample_type="x", status="verified")
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ═══════════════════════════════════════════════════════════════════════════
# Recorder unit tests
# ═══════════════════════════════════════════════════════════════════════════


def test_insert_creates_row_with_expected_fields(db, seed_sample):
    now = datetime.utcnow()
    ok = record_sample_transition(
        db, sample_id=seed_sample.sample_id, verb="receive",
        from_status="sample_due", to_status="sample_received",
        source="mk1", actor_user_id=1, occurred_at=now,
    )
    assert ok is True

    row = db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).one()
    assert row.verb == "receive"
    assert row.from_status == "sample_due"
    assert row.to_status == "sample_received"
    assert row.source == "mk1"
    assert row.actor_user_id == 1
    assert row.occurred_at == now


def test_occurred_at_defaults_to_now(db, seed_sample):
    before = datetime.utcnow()
    ok = record_sample_transition(
        db, sample_id=seed_sample.sample_id, to_status="sample_received",
        source="mk1",
    )
    after = datetime.utcnow()
    assert ok is True

    row = db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).one()
    assert before <= row.occurred_at <= after


def test_flush_never_commits(db, seed_sample):
    """record_sample_transition flushes (visible in-session) but the caller
    owns the commit — a rollback on the caller's session must undo it."""
    ok = record_sample_transition(
        db, sample_id=seed_sample.sample_id, to_status="sample_received",
        source="mk1",
    )
    assert ok is True
    assert db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).count() == 1

    db.rollback()

    other = SessionLocal()
    try:
        assert other.query(LimsSampleTransition).filter_by(
            lims_sample_pk=seed_sample.id
        ).count() == 0
    finally:
        other.close()


def test_senaite_source_skips_within_mk1_window(db, seed_sample):
    """source='senaite' skips if an mk1 row exists for the same
    (lims_sample_pk, verb) with occurred_at within +-5 minutes."""
    now = datetime.utcnow()
    assert record_sample_transition(
        db, sample_id=seed_sample.sample_id, verb="receive",
        to_status="sample_received", source="mk1", occurred_at=now,
    ) is True

    skipped = record_sample_transition(
        db, sample_id=seed_sample.sample_id, verb="receive",
        to_status="sample_received", source="senaite",
        occurred_at=now + timedelta(minutes=3), is_event_id="TEST-WST3-EVT-A",
    )
    assert skipped is False

    count = db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).count()
    assert count == 1


def test_senaite_source_outside_window_inserts(db, seed_sample):
    """Same (lims_sample_pk, verb) but occurred_at outside the +-5 minute
    window is NOT deduped — a genuinely separate transition is recorded."""
    now = datetime.utcnow()
    assert record_sample_transition(
        db, sample_id=seed_sample.sample_id, verb="receive",
        to_status="sample_received", source="mk1", occurred_at=now,
    ) is True

    inserted = record_sample_transition(
        db, sample_id=seed_sample.sample_id, verb="receive",
        to_status="sample_received", source="senaite",
        occurred_at=now + timedelta(minutes=10), is_event_id="TEST-WST3-EVT-B",
    )
    assert inserted is True

    count = db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).count()
    assert count == 2


def test_reconcile_source_skips_within_60min_any_verb(db, seed_sample):
    """source='reconcile' skips if ANY row exists (any source/verb) with the
    same to_status and occurred_at within the last 60 minutes."""
    now = datetime.utcnow()
    assert record_sample_transition(
        db, sample_id=seed_sample.sample_id, verb=None,
        to_status="verified", source="senaite", occurred_at=now,
        is_event_id="TEST-WST3-EVT-C",
    ) is True

    skipped = record_sample_transition(
        db, sample_id=seed_sample.sample_id, verb=None,
        to_status="verified", source="reconcile",
        occurred_at=now + timedelta(minutes=30),
    )
    assert skipped is False

    count = db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).count()
    assert count == 1


def test_reconcile_source_outside_window_inserts(db, seed_sample):
    now = datetime.utcnow()
    assert record_sample_transition(
        db, sample_id=seed_sample.sample_id, verb=None,
        to_status="verified", source="senaite", occurred_at=now,
        is_event_id="TEST-WST3-EVT-D",
    ) is True

    inserted = record_sample_transition(
        db, sample_id=seed_sample.sample_id, verb=None,
        to_status="verified", source="reconcile",
        occurred_at=now + timedelta(minutes=90),
    )
    assert inserted is True

    count = db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).count()
    assert count == 2


def test_unknown_sample_returns_false(db):
    result = record_sample_transition(
        db, sample_id="TEST-WST3-NO-SUCH-SAMPLE",
        to_status="sample_received", source="mk1",
    )
    assert result is False


def test_duplicate_event_id_returns_false(db, seed_sample):
    """The is_event_id partial unique catches a collision; the savepoint
    guard means the caller's session is still usable afterward (no
    poisoning) — proven by the follow-up query."""
    first = record_sample_transition(
        db, sample_id=seed_sample.sample_id, to_status="sample_received",
        source="mk1", is_event_id="TEST-WST3-EVT-DUP",
    )
    assert first is True

    second = record_sample_transition(
        db, sample_id=seed_sample.sample_id, to_status="verified",
        source="mk1", is_event_id="TEST-WST3-EVT-DUP",
    )
    assert second is False

    rows = db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).all()
    assert len(rows) == 1
    assert rows[0].to_status == "sample_received"


# ═══════════════════════════════════════════════════════════════════════════
# Endpoint hook tests — publish_sample_coa
# ═══════════════════════════════════════════════════════════════════════════


def _drive_publish_coa(sample_id: str, *, transition_state: str,
                       reread_state: str | None = None):
    """Adapted from tests/test_parent_mirror_hooks.py's helper of the same
    name. `_mark_shadows_published_bg` is stubbed (irrelevant here, avoids an
    unrelated best-effort mirror attempt); `_record_sample_transition_bg` is
    left UNPATCHED so it runs for real and the DB row can be asserted."""
    mock_instance = AsyncMock()
    get_item = {"uid": "AR-UID-PUBLISH-1"}
    if reread_state is not None:
        get_item["review_state"] = reread_state
    get_resp = MagicMock()
    get_resp.raise_for_status = MagicMock()
    get_resp.status_code = 200
    get_resp.json = MagicMock(return_value={"items": [get_item]})
    mock_instance.get = AsyncMock(return_value=get_resp)

    post_resp = MagicMock()
    post_resp.raise_for_status = MagicMock()
    post_resp.json = MagicMock(return_value={
        "success": True, "message": "ok",
        "items": [{"review_state": transition_state}],
    })
    mock_instance.post = AsyncMock(return_value=post_resp)

    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)

    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"), \
             patch.object(main, "_mark_shadows_published_bg", lambda sample_id: None):
            r = _client_as_user().post(
                f"/wizard/senaite/samples/{sample_id}/publish-coa"
            )
    finally:
        p.stop()
    return r


def test_publish_hook_writes_transition(db, seed_sample):
    r = _drive_publish_coa(seed_sample.sample_id, transition_state="published")

    assert r.status_code == 200, r.text
    assert r.json()["success"] is True

    row = db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).one()
    assert row.verb == "publish"
    assert row.to_status == "published"
    assert row.from_status == "verified"  # seed_sample.status
    assert row.source == "mk1"
    assert row.actor_user_id == 1


def test_publish_hook_skipped_when_not_actually_published(db, seed_sample):
    """Mirrors test_publish_no_mirror_when_partial_publish_deferred in
    test_parent_mirror_hooks.py: to_be_verified is an ACCEPTED-but-deferred
    state, not 'published' — the transition-log hook must not fire either."""
    r = _drive_publish_coa(seed_sample.sample_id, transition_state="to_be_verified")

    assert r.status_code == 200, r.text
    assert r.json()["success"] is True

    row = db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).one_or_none()
    assert row is None


def test_publish_hook_never_fails_on_recorder_exception(db, seed_sample, caplog):
    import logging
    mock_instance = AsyncMock()
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.status_code = 200
    resp.json = MagicMock(return_value={
        "success": True, "message": "ok", "uid": "AR-UID-PUBLISH-2",
        "items": [{"review_state": "published", "uid": "AR-UID-PUBLISH-2"}],
    })
    mock_instance.get = AsyncMock(return_value=resp)
    mock_instance.post = AsyncMock(return_value=resp)

    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)

    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"), \
             patch.object(main, "_mark_shadows_published_bg", lambda sample_id: None), \
             patch("workflow.sample_log.record_sample_transition",
                   side_effect=RuntimeError("boom")), \
             caplog.at_level(logging.WARNING):
            r = _client_as_user().post(
                f"/wizard/senaite/samples/{seed_sample.sample_id}/publish-coa"
            )
    finally:
        p.stop()

    assert r.status_code == 200, r.text
    assert r.json()["success"] is True
    assert any("workflow.sample_log_failed" in rec.message for rec in caplog.records)

    row = db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).one_or_none()
    assert row is None


# ═══════════════════════════════════════════════════════════════════════════
# Endpoint hook tests — receive_senaite_sample
# ═══════════════════════════════════════════════════════════════════════════


def _mock_receive_flow(*, initial_state="sample_due", final_state="sample_received",
                       wf_post_status=200):
    """Sequenced GET responses matching receive_senaite_sample's exact call
    order for the happy path (no image, no remarks): sample lookup, CSRF
    page fetch, CSRF re-fetch before the workflow POST, post-transition
    verify re-read. One POST for the workflow_action transition itself."""
    mock_instance = AsyncMock()

    sample_resp = MagicMock()
    sample_resp.json = MagicMock(return_value={
        "count": 1,
        "items": [{"review_state": initial_state, "path": "/senaite/samples/ar-1"}],
    })

    page_resp = MagicMock()
    page_resp.text = '<input name="_authenticator" value="AUTH1"/>'

    page_resp2 = MagicMock()
    page_resp2.text = '<input name="_authenticator" value="AUTH2"/>'

    verify_resp = MagicMock()
    verify_resp.json = MagicMock(return_value={
        "count": 1,
        "items": [{"review_state": final_state}],
    })

    mock_instance.get = AsyncMock(
        side_effect=[sample_resp, page_resp, page_resp2, verify_resp]
    )

    wf_resp = MagicMock()
    wf_resp.status_code = wf_post_status
    mock_instance.post = AsyncMock(return_value=wf_resp)

    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p


def test_receive_hook_writes_transition(db, seed_sample):
    proxy = _mock_receive_flow()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client_as_user().post(
                "/wizard/senaite/receive-sample",
                json={"sample_uid": "UID-RECV-1", "sample_id": seed_sample.sample_id},
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    assert r.json()["success"] is True

    row = db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).one()
    assert row.verb == "receive"
    assert row.to_status == "sample_received"
    assert row.from_status == "sample_due"
    assert row.source == "mk1"
    assert row.actor_user_id == 1


def test_receive_hook_skipped_when_transition_not_verified(db, seed_sample):
    """The post-transition verify re-read does NOT show sample_received ->
    the endpoint reports failure and the transition-log hook must not fire."""
    proxy = _mock_receive_flow(final_state="sample_due")
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"):
            r = _client_as_user().post(
                "/wizard/senaite/receive-sample",
                json={"sample_uid": "UID-RECV-2", "sample_id": seed_sample.sample_id},
            )
    finally:
        proxy.stop()

    assert r.status_code == 200
    assert r.json()["success"] is False

    row = db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).one_or_none()
    assert row is None


def test_receive_hook_never_fails_on_recorder_exception(db, seed_sample, caplog):
    import logging
    proxy = _mock_receive_flow()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"), \
             patch("workflow.sample_log.record_sample_transition",
                   side_effect=RuntimeError("boom")), \
             caplog.at_level(logging.WARNING):
            r = _client_as_user().post(
                "/wizard/senaite/receive-sample",
                json={"sample_uid": "UID-RECV-3", "sample_id": seed_sample.sample_id},
            )
    finally:
        proxy.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert "received" in body["senaite_response"]["steps_done"]
    assert any("workflow.sample_log_failed" in rec.message for rec in caplog.records)

    row = db.query(LimsSampleTransition).filter_by(
        lims_sample_pk=seed_sample.id
    ).one_or_none()
    assert row is None
