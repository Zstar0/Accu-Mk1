"""ai_chat.hub: per-user event buffer with replay, live fan-out to SSE subscribers, and the SSE frame (spec 8).

Every chat event for a user goes through `EventHub.publish`, which stamps it with a per-user `seq`, keeps
it in a bounded buffer, and puts it on each subscriber's queue. A browser that reconnects sends its last
seen `seq` as `Last-Event-ID`; `subscribe` replays what is still buffered, or answers with a single `resync`
event when it cannot (the id was evicted, came from before a restart, or is not an integer).

`seq` starts at `boot_base` (`int(time.time()) * 1_000_000`) for every user, so any id issued before a
restart sorts below the new buffer and is answered with `resync`.

Everything here runs on the event loop thread: `asyncio.Queue` is not thread-safe, and `subscribe` relies on
having no `await` between reading the buffer and registering the queue. Event dicts are shared between the
buffer, backlogs and queues, so consumers must treat them as read-only. Event contents are never logged.
"""
from __future__ import annotations

import asyncio
import json
import time
from collections import deque

_QUEUE_MAX = 1000  # per-subscriber live queue, drop oldest when full (same policy as flags/bus.py)


class Subscription:
    """One SSE connection's view of a user's stream: the replay `backlog`, then live events from `get()`."""

    def __init__(self, hub: "EventHub", user_id: int, backlog: list[dict]) -> None:
        self._hub = hub
        self.user_id = user_id
        self.backlog = backlog
        self.queue: "asyncio.Queue[dict]" = asyncio.Queue(maxsize=_QUEUE_MAX)

    async def get(self) -> dict:
        return await self.queue.get()

    def close(self) -> None:
        """Idempotent: stop receiving events."""
        self._hub._unsubscribe(self)


class EventHub:
    def __init__(self, buffer_size: int = 2000, boot_base: int | None = None) -> None:
        self._buffer_size = buffer_size
        self._boot_base = int(time.time()) * 1_000_000 if boot_base is None else boot_base
        self._buffers: dict[int, deque[dict]] = {}
        self._next: dict[int, int] = {}  # next seq to issue, per user
        self._subs: dict[int, set[Subscription]] = {}

    def publish(self, user_id: int, type: str, chat_id: int | None, turn_id: str | None, **fields) -> dict:
        """Stamp, buffer and fan out one event; returns the wire dict. Event loop only."""
        seq = self._next.get(user_id, self._boot_base)
        self._next[user_id] = seq + 1
        # The four contract keys come last so a stray `seq` field can never break the replay order.
        event = {**fields, "seq": seq, "type": type, "chat_id": chat_id, "turn_id": turn_id}
        self._buffers.setdefault(user_id, deque(maxlen=self._buffer_size)).append(event)
        for sub in self._subs.get(user_id, ()):
            try:
                sub.queue.put_nowait(event)
            except asyncio.QueueFull:  # slow consumer: drop the oldest, keep the newest
                sub.queue.get_nowait()
                sub.queue.put_nowait(event)
        return event

    def subscribe(self, user_id: int, last_event_id: str | None) -> Subscription:
        """Backlog and registration happen in this one synchronous call, so each event is either in the
        backlog or on the queue, never both and never neither."""
        sub = Subscription(self, user_id, self._backlog(user_id, last_event_id))
        self._subs.setdefault(user_id, set()).add(sub)
        return sub

    def _unsubscribe(self, sub: Subscription) -> None:
        subs = self._subs.get(sub.user_id)
        if subs is not None:
            subs.discard(sub)
            if not subs:
                del self._subs[sub.user_id]

    def _backlog(self, user_id: int, last_event_id: str | None) -> list[dict]:
        if last_event_id is None:
            return []
        buf = self._buffers.get(user_id, ())
        nxt = self._next.get(user_id, self._boot_base)
        newest = nxt - 1
        oldest = buf[0]["seq"] if buf else nxt
        try:
            last = int(last_event_id)
        except ValueError:
            last = None
        if last is None or not oldest - 1 <= last <= newest:
            return [{"seq": newest, "type": "resync", "chat_id": None, "turn_id": None}]
        return [e for e in buf if e["seq"] > last]


def format_frame(event: dict) -> str:
    """One SSE frame. The JSON is a single line (json escapes newlines in text), so `data:` never splits."""
    return f"id: {event['seq']}\nevent: {event['type']}\ndata: {json.dumps(event, separators=(',', ':'))}\n\n"


# ponytail: single uvicorn worker; sticky routing or a broker if workers > 1
HUB = EventHub()
