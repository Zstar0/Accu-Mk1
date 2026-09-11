"""Process-level cache for the Ready to Publish report (2026-09-11).

The report costs ~2 s of DB time per call on prod (391 candidates, line
states resolved per sample), and the header/sidebar count chip polls it
from every open browser. One cached payload per ``include_test_orders``
variant, served for ``TTL_SECONDS`` and cleared on every publish (Handler
ruling: "clear the cache whenever an item is published"), so the chip can
never show a sample that just went out. Single-process by design: the
backend runs one uvicorn worker; a multi-worker deploy would need Redis.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable, Optional

TTL_SECONDS = 60.0

_lock = threading.Lock()
_entries: dict[bool, tuple[float, Any]] = {}


def get_or_build(include_test_orders: bool, build: Callable[[], Any],
                 *, now: Optional[float] = None) -> Any:
    """Return the cached payload for this variant, building it when missing
    or older than TTL. The build runs outside the lock (it is the slow part);
    a concurrent miss may build twice, which is harmless."""
    t = time.monotonic() if now is None else now
    with _lock:
        hit = _entries.get(include_test_orders)
        if hit is not None and t - hit[0] < TTL_SECONDS:
            return hit[1]
    payload = build()
    with _lock:
        _entries[include_test_orders] = (t, payload)
    return payload


def invalidate() -> None:
    """Drop every variant. Called after a publish (any outcome) and by tests."""
    with _lock:
        _entries.clear()
