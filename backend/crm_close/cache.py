"""In-process TTL cache with single-flight loads per key.

Locks are per key: a loader may load another key (the timeline loads the lead match), and
loads for different customers never wait on each other.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable, TypeVar

T = TypeVar("T")


class TTLCache:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._data: dict[str, tuple[float, Any]] = {}
        self._refresh: dict[str, float] = {}
        self._lock = threading.Lock()
        self._load_locks: dict[str, threading.Lock] = {}

    def _fresh(self, key: str, ttl: float):
        hit = self._data.get(key)
        return hit if hit and self._clock() - hit[0] < ttl else None

    def get_or_load(self, key: str, ttl: float, loader: Callable[[], T]) -> tuple[T, float]:
        with self._lock:
            hit = self._fresh(key, ttl)
        if hit:
            return hit[1], hit[0]
        with self._lock:
            load_lock = self._load_locks.setdefault(key, threading.Lock())
        with load_lock:
            with self._lock:
                hit = self._fresh(key, ttl)
            if hit:
                return hit[1], hit[0]
            value = loader()
            at = self._clock()
            with self._lock:
                self._data[key] = (at, value)
            return value, at

    def peek(self, key: str):
        with self._lock:
            hit = self._data.get(key)
        return (hit[1], hit[0]) if hit else None

    def drop(self, prefix: str) -> None:
        with self._lock:
            for k in [k for k in self._data if k.startswith(prefix)]:
                del self._data[k]

    def allow_refresh(self, key: str, cooldown: float) -> bool:
        with self._lock:
            last = self._refresh.get(key)
            if last is not None and self._clock() - last < cooldown:
                return False
            self._refresh[key] = self._clock()
            return True
