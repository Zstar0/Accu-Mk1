"""In-process pub/sub for flag events. Single-uvicorn-process fan-out — no broker.

The producer (flags.service, run in FastAPI's sync threadpool) calls publish()
from a worker thread; consumers (the SSE async generators) run on the event loop.
asyncio.Queue is loop-affine and NOT thread-safe, so publish() marshals delivery
onto the loop via loop.call_soon_threadsafe.
"""
from __future__ import annotations

import asyncio
from typing import Optional


class Subscription:
    def __init__(self, bus: "FlagEventBus", user_id: Optional[int], *,
                 group_ids=frozenset(), is_admin: bool = False, system: bool = False) -> None:
        self._bus = bus
        self.user_id = user_id
        self.group_ids = frozenset(int(g) for g in group_ids)
        self.is_admin = bool(is_admin)
        self.system = bool(system)   # the Slack notifier: sees everything, DMs participants only
        self.queue: "asyncio.Queue[dict]" = asyncio.Queue(maxsize=1000)

    async def get(self) -> dict:
        return await self.queue.get()

    def close(self) -> None:
        self._bus._unsubscribe(self)


class FlagEventBus:
    def __init__(self) -> None:
        self._subs: set[Subscription] = set()
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self, user_id: Optional[int], *, group_ids=frozenset(),
                  is_admin: bool = False, system: bool = False) -> Subscription:
        sub = Subscription(self, user_id, group_ids=group_ids, is_admin=is_admin, system=system)
        self._subs.add(sub)
        if self._loop is None:
            try:
                self._loop = asyncio.get_running_loop()
            except RuntimeError:
                pass
        return sub

    def _unsubscribe(self, sub: Subscription) -> None:
        self._subs.discard(sub)

    def publish(self, event: dict) -> None:
        """Thread-safe; safe to call from any thread (or with no subscribers)."""
        loop = self._loop
        if loop is None:
            return
        loop.call_soon_threadsafe(self._deliver, event)

    def _deliver(self, event: dict) -> None:
        """Runs on the loop thread — only place that touches the queues."""
        for sub in list(self._subs):
            if not self._visible_to(sub, event):
                continue
            try:
                sub.queue.put_nowait(event)
            except asyncio.QueueFull:
                try:                       # slow consumer: drop oldest, keep newest
                    sub.queue.get_nowait()
                    sub.queue.put_nowait(event)
                except Exception:
                    pass

    def _visible_to(self, sub: Subscription, event: dict) -> bool:
        """Producer-stamped `audience` (spec §6.4): None = everyone; {"groups": [...]} =
        members of those groups, admins, and the system subscriber. The bus never
        touches the database."""
        aud = event.get("audience")
        if sub.system or aud is None or sub.is_admin:
            return True
        groups = {int(g) for g in (aud.get("groups") or [])}
        return bool(groups & sub.group_ids)


BUS = FlagEventBus()


class SSEEventSink:
    """Event sink (the Plan-1 seam) that fans events out over the bus."""
    def __init__(self, bus: FlagEventBus = BUS) -> None:
        self._bus = bus

    def emit(self, event: dict) -> None:
        self._bus.publish(event)
