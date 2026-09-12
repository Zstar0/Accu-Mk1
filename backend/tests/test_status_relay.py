"""M8 native status relay Mk1 -> Integration Service.

sqlite in-memory (no live DB needed — pure logic + a mocked httpx.Client).
Contract shape here is the twin pin with the IS side
(2026-09-12-is-native-slice-b.md) — never change test_contract_body_shape
without confirming the IS-side test moves in lockstep.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine, delete, select
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401  (register tables on Base before create_all)
from models import Base, LimsSample, LimsSampleTransition, LimsSubSampleEvent
from workflow import status_relay
from workflow.status_relay import (
    RELAYED_SLUGS,
    build_relay_body,
    event_id_for,
    flush_pending_relays,
    queue_relay,
    relay_native_status,
)


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture(autouse=True)
def _clear_pending_queue():
    status_relay.pending_relays.clear()
    yield
    status_relay.pending_relays.clear()


def _native(db, sample_id="P-5001", **kw):
    row = LimsSample(sample_id=sample_id, external_lims_system="mk1",
                     status="sample_due", client_order_number=kw.pop(
                         "client_order_number", "WP-4242"), **kw)
    db.add(row)
    db.flush()
    return row


def _senaite(db, sample_id="P-9001", **kw):
    row = LimsSample(sample_id=sample_id, external_lims_system="senaite",
                     status="sample_due", **kw)
    db.add(row)
    db.flush()
    return row


def _add_transition(db, sample, verb, to_status="sample_received"):
    db.add(LimsSampleTransition(lims_sample_pk=sample.id, verb=verb,
                                to_status=to_status, source="mk1",
                                occurred_at=__import__("datetime").datetime.utcnow()))
    db.flush()


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def test_relayed_slugs_mapping():
    assert RELAYED_SLUGS == {
        "sample_received": "receive", "verified": "verify", "published": "publish",
    }


def test_event_id_for_ordinal_counts_prior_transitions(db_session):
    sample = _native(db_session)
    _add_transition(db_session, sample, "receive")
    assert event_id_for(db_session, sample, "receive") == "mk1-P-5001-receive-1"
    _add_transition(db_session, sample, "receive")
    assert event_id_for(db_session, sample, "receive") == "mk1-P-5001-receive-2"
    # a different verb has its own count
    assert event_id_for(db_session, sample, "verify") == "mk1-P-5001-verify-0"


def test_contract_body_shape(db_session):
    """Twin-pinned with the IS side — the exact keys and shape IS expects."""
    sample = _native(db_session)
    _add_transition(db_session, sample, "receive")
    body = build_relay_body(db_session, sample, "receive")
    assert set(body.keys()) == {"transition", "event_id", "order_ref", "occurred_at"}
    assert body["transition"] == "receive"
    assert body["event_id"] == "mk1-P-5001-receive-1"
    assert body["order_ref"] == "WP-4242"
    assert body["occurred_at"].endswith("Z")
    # ISO8601, parseable
    from datetime import datetime
    datetime.strptime(body["occurred_at"], "%Y-%m-%dT%H:%M:%SZ")


def test_senaite_born_skips_with_no_http(db_session):
    sample = _senaite(db_session)
    with patch("httpx.Client.post", side_effect=AssertionError("must not call IS")):
        result = relay_native_status(db_session, sample_id=sample.sample_id,
                                     transition="receive")
    assert result == "skipped"
    events = db_session.execute(select(LimsSubSampleEvent)).scalars().all()
    assert events == []


def test_native_sent_records_relayed_event(db_session):
    sample = _native(db_session)
    _add_transition(db_session, sample, "receive")
    with patch("httpx.Client.post", return_value=_Resp({"status": "ok"})):
        result = relay_native_status(db_session, sample_id=sample.sample_id,
                                     transition="receive")
    assert result == "sent"
    ev = db_session.execute(select(LimsSubSampleEvent)).scalars().one()
    assert ev.event == "native_status_relayed"
    assert ev.details["transition"] == "receive"


def test_is_duplicate_response(db_session):
    sample = _native(db_session)
    with patch("httpx.Client.post", return_value=_Resp({"status": "duplicate"})):
        result = relay_native_status(db_session, sample_id=sample.sample_id,
                                     transition="receive")
    assert result == "duplicate"


def test_httpx_error_records_failed_event_no_raise(db_session):
    sample = _native(db_session)
    with patch("httpx.Client.post", side_effect=OSError("connection refused")):
        result = relay_native_status(db_session, sample_id=sample.sample_id,
                                     transition="receive")
    assert result == "failed"
    ev = db_session.execute(select(LimsSubSampleEvent)).scalars().one()
    assert ev.event == "native_status_relay_failed"
    assert "connection refused" in ev.details["error"]


def test_engine_hook_queues_for_native_under_mk1_authority(db_session):
    from workflow.engine import _write_status_if_authoritative
    sample = _native(db_session)
    with patch("workflow.authority.sample_status_authority", return_value="mk1"):
        wrote = _write_status_if_authoritative(
            db_session, sample, "verified", verb="verify",
            actor_user_id=None, from_status="to_be_verified")
    assert wrote is True
    assert list(status_relay.pending_relays) == [(sample.sample_id, "verify")]
    ev = db_session.execute(select(LimsSubSampleEvent)).scalars().one()
    assert ev.event == "native_status_relay_pending"
    assert ev.details == {"transition": "verify"}


def test_engine_hook_nothing_for_legacy_sample(db_session):
    from workflow.engine import _write_status_if_authoritative
    sample = _senaite(db_session)
    with patch("workflow.authority.sample_status_authority", return_value="mk1"):
        wrote = _write_status_if_authoritative(
            db_session, sample, "verified", verb="verify",
            actor_user_id=None, from_status="to_be_verified")
    assert wrote is True
    assert list(status_relay.pending_relays) == []
    assert db_session.execute(select(LimsSubSampleEvent)).scalars().all() == []


def test_flush_pending_relays_drains_queue(db_session, monkeypatch):
    sample = _native(db_session)
    monkeypatch.setattr("database.SessionLocal", lambda: db_session)
    # SessionLocal() is called with no args and normally opens a NEW session;
    # here we hand back the same in-memory one so the assertions can see it.
    # (db_session.close() inside flush would sever it — patch close to a
    # no-op for this one test.)
    monkeypatch.setattr(db_session, "close", lambda: None)
    queue_relay(sample.sample_id, "receive")
    with patch("httpx.Client.post", return_value=_Resp({"status": "ok"})):
        outcomes = flush_pending_relays()
    assert outcomes == ["sent"]
    assert list(status_relay.pending_relays) == []


class _RacyQueue:
    """Stands in for the module's deque: the first popleft() raises
    IndexError as if a concurrent flush already emptied the real queue
    between the caller's truthiness check (there is none now — the fix
    removed it) and its own pop — proving flush_pending_relays() treats
    an empty-queue race as a clean exit, not a crash."""

    def __init__(self, items):
        self._items = list(items)
        self._first_call = True

    def popleft(self):
        if self._first_call:
            self._first_call = False
            raise IndexError("simulated concurrent drain")
        if not self._items:
            raise IndexError("pop from an empty deque")
        return self._items.pop(0)


def test_flush_pending_relays_never_raises_on_concurrent_drain(monkeypatch):
    """Fix round 1: two flush_pending_relays() calls in different threadpool
    threads can both attempt to pop the same queue — with a plain list this
    raced `while pending_relays:` against `.pop(0)` and could raise
    IndexError. `popleft()` inside the try (not a truthiness check outside
    it) must turn that race into a clean early exit."""
    monkeypatch.setattr(status_relay, "pending_relays", _RacyQueue([]))
    outcomes = flush_pending_relays()
    assert outcomes == []
