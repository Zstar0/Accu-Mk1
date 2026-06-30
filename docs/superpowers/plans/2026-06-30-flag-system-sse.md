# Flag System — Real-time (SSE) Implementation Plan (Phase 1, Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Run on the devbox inside your mounted, isolated stack.

**Goal:** Add server→client real-time to the `flags` module: replace the Plan-1 `InMemoryEventSink` with an in-process pub/sub bus, expose an authenticated per-connection `GET /api/flags/stream` SSE endpoint, and make event emission **post-commit** so subscribers are never notified of a rolled-back transaction. Frontend (Plan 3) consumes this stream.

**Context — what Plan 1 already shipped (now on `master`):** `backend/flags/` with `models.py` (`flag_flags/flag_comments/flag_participants/flag_events`), `service.py` (all writers call `_audit()` which writes a `flag_events` row **and** `seams.EVENT_SINK.emit({...})`), `seams.py` (`InMemoryEventSink`, `set_event_sink`, `EVENT_SINK`), `routes.py` (`/api/flags` REST), and the in-stack tables. **Read those files first.**

**Tech stack / environment facts (verified):**
- Backend runs **single uvicorn process, no `--workers`** (`Dockerfile: CMD ["uvicorn","main:app",...]`) → in-process asyncio fan-out is sufficient; **no Redis/broker**.
- Mk1 **already does SSE** the FastAPI-native way: `async def` endpoint returning `StreamingResponse(gen(), media_type="text/event-stream")`, authed by `Depends(get_current_user)` (header bearer), `await request.is_disconnected()` for teardown, frames `event: X\ndata: Y\n\n`. See `main.py` `stream_scale_weight` (~line 13749) and `seed_peptides_stream` (~5348) for the house pattern. **Mirror it.**
- FastAPI runs **sync** `def` routes in a threadpool; the SSE generator is **async** on the loop. The producer (`service` → `EVENT_SINK.emit`) therefore runs on a worker thread while consumers (SSE generators) run on the loop. `asyncio.Queue` is loop-affine and **not** thread-safe → cross-thread delivery must go through `loop.call_soon_threadsafe`.
- Test deps: **`pytest` + `httpx` only — NO `pytest-asyncio`, NO `sse-starlette`.** Write async tests with plain `asyncio.run(...)` inside sync test functions. Do **not** add new dependencies.

## Global Constraints

- **Bare imports only** (CWD=`backend/`): `from flags.bus import ...`, `from flags import seams`.
- **Additive only.** Do not change REST request/response shapes, table schemas, or the `flag_` prefix. The only behavior change permitted is the **timing** of event emission (pre-commit → post-commit) — a latent-bug fix.
- **No new third-party deps.** Use stdlib `asyncio`, `json`, and the existing FastAPI/Starlette.
- **Preserve Plan-1 tests.** `tests/test_flags_service.py` asserts `seams.EVENT_SINK.events[0]["event_type"] == "raised"` after a create — your refactor must keep emit order and keep using `seams.EVENT_SINK`. Adding an extra `flag`/`event_id` key to the emitted dict is fine (additive).
- **Run tests from `backend/`:** `cd backend && pytest tests/test_flags_*.py -v`. In-stack: `docker compose -p accumark-<stackname> exec -T accu-mk1-backend sh -c "cd /app && pytest tests/test_flags_*.py -v"`.

---

## SSE Wire Contract (LOCKED — Plan 2 produces, Plan 3 consumes)

This is the integration boundary. Implement it **exactly**; Plan 3's client is written against it.

- **Endpoint:** `GET /api/flags/stream` (relative path; reaches the backend via the vite `/api` proxy in-stack).
- **Auth:** `Authorization: Bearer <jwt>` header — same `Depends(get_current_user)` as every other Mk1 stream. (Clients use `fetch` + `body.getReader()`, **not** native `EventSource`, because `EventSource` can't send headers — see `src/lib/scale-stream.ts`.)
- **Media + headers:** `text/event-stream`; `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
- **Frame:** standard SSE — optional `id: <flag_events.id>\n`, then `event: <event_type>\n`, then `data: <json>\n\n`.
- **Heartbeat:** a comment line `: keepalive\n\n` every ~15s (clients ignore comment lines) so proxies don't time the connection out.
- **`event_type`** ∈ `raised | assigned | unassigned | commented | status_changed | watcher_added | watcher_removed` (mirrors `flag_events.event_type`).
- **`data` JSON** (one object per event):
  ```json
  {
    "event_type": "status_changed",
    "flag_id": 12,
    "actor_id": 42,
    "from_value": "open",
    "to_value": "in_progress",
    "details": {},
    "event_id": 87,
    "flag": {
      "id": 12, "title": "Crashed out", "type": "blocker", "kind": "issue",
      "status": "in_progress", "entity_type": "sub_sample", "entity_id": "123",
      "assignee_id": 7, "created_by": 42
    }
  }
  ```
  - `event_id` = the `flag_events.id` of the audit row (monotonic; use as `Last-Event-ID`).
  - `flag` = a snapshot of the affected flag **after** the mutation, so the client can render a toast / update a card without a refetch.
- **Scoping (v1):** server **broadcasts every event to every authenticated subscriber.** This is correct for v1 because flags are internal and every staff user can already see every flag (the `all_open` triage tab). The **client** decides relevance: `flag.assignee_id === me || flag.created_by === me || (I'm watching)` → toast + badge bump; otherwise just update any open list/thread in place. Per-user **server-side** scoping is a future refinement (a single `_visible_to()` swap) and must not be hard-assumed-away by the client.
- **Reconnect:** on stream end the client reconnects sending `Last-Event-ID: <event_id>`. v1 server **may** replay `flag_events` rows with `id > Last-Event-ID` on connect (stretch, Task 4 Step 6); frames always carry `id:` so the hook exists. Client **must de-dupe by `event_id`.**
- **REST is the only writer.** SSE carries "what changed" only; all mutations go through existing `/api/flags*` endpoints. The stream never accepts writes.

---

## File Structure

**Create:**
- `backend/flags/bus.py` — `FlagEventBus` (in-process pub/sub, thread-safe publish) + `Subscription` + module singleton `BUS` + `SSEEventSink`.
- `backend/tests/test_flags_bus.py` — bus subscribe/publish/unsubscribe + cross-thread delivery.
- `backend/tests/test_flags_stream.py` — emit-after-commit regression + stream endpoint smoke.

**Modify:**
- `backend/flags/service.py` — `_audit()` stages events on `db.info` instead of emitting; new `_commit_and_emit(db)` drains-and-emits after commit; new `_flag_summary(flag)`; every `db.commit()` → `_commit_and_emit(db)`; `_audit` call sites pass the **flag object** (for the summary).
- `backend/flags/routes.py` — add `GET /stream` (above `/{flag_id}`); imports `Request`, `StreamingResponse`, `asyncio`, `json`.
- `backend/main.py` — in the lifespan, after `register_mk1_entities()`: capture the running loop on `BUS` and swap the sink to `SSEEventSink`.

---

### Task 1: Emit-after-commit + event enrichment (service.py refactor)

**Why first:** the SSE bus must never broadcast a transaction that then rolls back. Plan 1 emits inside `_audit()` **before** `db.commit()`. Move emission to **after** a successful commit, and enrich each event with `event_id` (the `flag_events.id`) and a `flag` summary.

**Files:** Modify `backend/flags/service.py`. Test: `backend/tests/test_flags_stream.py` (the emit-after-commit half).

- [ ] **Step 1: Write the failing regression test**

`backend/tests/test_flags_stream.py` (first test only for now):
```python
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def db():
    from database import Base
    import flags.models  # noqa: F401
    from flags import seams
    seams.register_mk1_entities()
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    s._engine_for_test = engine  # keep a handle for fresh sessions
    try:
        yield s
    finally:
        s.close()


def test_emit_happens_after_commit_and_is_enriched(db):
    """The sink must only see an event once the flag row is committed (visible
    in a fresh session), and the event must carry event_id + a flag summary."""
    from flags import seams, service
    from flags.models import FlagFlag
    from sqlalchemy.orm import sessionmaker

    Session = sessionmaker(bind=db._engine_for_test)
    seen = []

    class AssertCommittedSink:
        def emit(self, event):
            # a brand-new session must already see the flag → proves post-commit
            fresh = Session()
            try:
                assert fresh.get(FlagFlag, event["flag_id"]) is not None, "emitted before commit!"
            finally:
                fresh.close()
            seen.append(event)

    seams.set_event_sink(AssertCommittedSink())
    user = SimpleNamespace(id=42, role="standard", email="t@x.t")
    flag = service.create_flag(db, user=user, entity_type="sub_sample", entity_id="123",
                               type="blocker", title="Crashed out", first_comment="cloudy")

    assert seen, "no events emitted"
    raised = next(e for e in seen if e["event_type"] == "raised")
    assert raised["event_id"] is not None and isinstance(raised["event_id"], int)
    assert raised["flag"]["title"] == "Crashed out"
    assert raised["flag"]["status"] == "open"
    assert raised["flag"]["entity_type"] == "sub_sample"
```

- [ ] **Step 2: Run to confirm it fails** — `cd backend && pytest tests/test_flags_stream.py -v` (fails: Plan-1 emits pre-commit and without `event_id`/`flag`).

- [ ] **Step 3: Refactor `service.py`.** Replace the top-of-file `_audit` helper and add two helpers:
```python
def _flag_summary(flag) -> dict:
    return {
        "id": flag.id, "title": flag.title, "type": flag.type, "kind": flag.kind,
        "status": flag.status, "entity_type": flag.entity_type, "entity_id": flag.entity_id,
        "assignee_id": flag.assignee_id, "created_by": flag.created_by,
    }


def _audit(db, flag, actor_id, event_type, *, from_value=None, to_value=None, details=None):
    """Write the audit row now; STAGE the sink event to fire after commit.

    Accepts a FlagFlag object (preferred — enables the summary) so the emitted
    event can carry a post-mutation snapshot. Pass the object, not the id.
    """
    row = FlagEvent(flag_id=flag.id, actor_id=actor_id, event_type=event_type,
                    from_value=from_value, to_value=to_value, details=details)
    db.add(row)
    pending = db.info.setdefault("flag_pending_events", [])
    pending.append((row, {
        "event_type": event_type, "flag_id": flag.id, "actor_id": actor_id,
        "from_value": from_value, "to_value": to_value, "details": details or {},
        "event_id": None,                 # filled in post-commit from row.id
        "flag": _flag_summary(flag),
    }))


def _commit_and_emit(db):
    """Flush to populate row ids, commit, then emit staged events in order.

    event_id is read after flush (ids populated) but before commit (rows not yet
    expired) so the post-commit emit needs no per-event reload. Emit is strictly
    post-commit: a rollback never reaches the sink.
    """
    pending = db.info.pop("flag_pending_events", [])
    db.flush()                       # populate FlagEvent.id on every staged row
    for row, event in pending:
        event["event_id"] = row.id
    db.commit()
    for _row, event in pending:
        seams.EVENT_SINK.emit(event)
```
Then in every service writer: (a) change each `_audit(db, flag.id, ...)` call to `_audit(db, flag, ...)` (pass the object); (b) change each `db.commit()` to `_commit_and_emit(db)`. Writers to update: `create_flag`, `add_comment`, `assign`, `add_watcher`, `remove_watcher`, `change_status`. Keep the `db.refresh(...)` calls where they already are (after `_commit_and_emit`). **Note** the create_flag "assigned"/"commented" sub-events and the `change_status` "status_changed" event are all staged after the relevant field is set on `flag`, so the summary reflects the new state — keep that ordering.

- [ ] **Step 4: Run to confirm pass** — `pytest tests/test_flags_stream.py -v` (the one test) **and** the full suite `pytest tests/test_flags_*.py -v` to confirm Plan-1's `test_flags_service.py` still passes (emit order preserved).

- [ ] **Step 5: Commit** — `git add backend/flags/service.py backend/tests/test_flags_stream.py && git commit -m "feat(flags): emit events post-commit + enrich with event_id and flag summary"`

---

### Task 2: In-process event bus (`flags/bus.py`)

**Files:** Create `backend/flags/bus.py`, `backend/tests/test_flags_bus.py`.

**Interfaces produced:** `BUS` (singleton `FlagEventBus`), `FlagEventBus.subscribe(user_id) -> Subscription`, `Subscription.get()` (async), `Subscription.close()`, `FlagEventBus.publish(event)` (thread-safe), `FlagEventBus.set_loop(loop)`, and `SSEEventSink(bus)` with `.emit(event)` → `bus.publish(event)`.

- [ ] **Step 1: Write failing tests** — `backend/tests/test_flags_bus.py`:
```python
import asyncio
import threading
from flags.bus import FlagEventBus, SSEEventSink


def test_publish_delivers_to_subscriber():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        sub = bus.subscribe(user_id=7)
        bus.publish({"event_type": "raised", "flag_id": 1})
        got = await asyncio.wait_for(sub.get(), timeout=1.0)
        assert got["flag_id"] == 1
        sub.close()
    asyncio.run(scenario())


def test_cross_thread_publish_is_safe():
    """publish() called from a non-loop thread (mimics FastAPI's threadpool)."""
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        sub = bus.subscribe(user_id=7)
        t = threading.Thread(target=lambda: bus.publish({"event_type": "commented", "flag_id": 9}))
        t.start(); t.join()
        got = await asyncio.wait_for(sub.get(), timeout=1.0)
        assert got["flag_id"] == 9
        sub.close()
    asyncio.run(scenario())


def test_unsubscribe_stops_delivery():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        sub = bus.subscribe(user_id=7)
        sub.close()
        bus.publish({"event_type": "raised", "flag_id": 1})
        with pytest_raises_timeout():
            await asyncio.wait_for(sub.get(), timeout=0.2)
    asyncio.run(scenario())


def test_sink_forwards_to_bus():
    async def scenario():
        bus = FlagEventBus()
        bus.set_loop(asyncio.get_running_loop())
        sub = bus.subscribe(user_id=1)
        SSEEventSink(bus).emit({"event_type": "assigned", "flag_id": 5})
        got = await asyncio.wait_for(sub.get(), timeout=1.0)
        assert got["event_type"] == "assigned"
        sub.close()
    asyncio.run(scenario())


def test_publish_with_no_loop_is_noop():
    bus = FlagEventBus()  # never set_loop, no subscribers
    bus.publish({"event_type": "raised", "flag_id": 1})  # must not raise


# helper: assert an awaitable times out
import contextlib
@contextlib.contextmanager
def pytest_raises_timeout():
    try:
        yield
        raise AssertionError("expected TimeoutError")
    except asyncio.TimeoutError:
        pass
```

- [ ] **Step 2: Run to confirm fail** (no `flags.bus` yet).

- [ ] **Step 3: Implement `backend/flags/bus.py`:**
```python
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
    def __init__(self, bus: "FlagEventBus", user_id: Optional[int]) -> None:
        self._bus = bus
        self.user_id = user_id
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

    def subscribe(self, user_id: Optional[int]) -> Subscription:
        sub = Subscription(self, user_id)
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
            if not self._visible_to(sub.user_id, event):
                continue
            try:
                sub.queue.put_nowait(event)
            except asyncio.QueueFull:
                try:                       # slow consumer: drop oldest, keep newest
                    sub.queue.get_nowait()
                    sub.queue.put_nowait(event)
                except Exception:
                    pass

    def _visible_to(self, user_id: Optional[int], event: dict) -> bool:
        # v1: flags are internal and every staff user can see every flag, so
        # every event is visible to every subscriber. Future per-user scoping
        # is a swap of THIS method only (see the wire contract).
        return True


BUS = FlagEventBus()


class SSEEventSink:
    """Event sink (the Plan-1 seam) that fans events out over the bus."""
    def __init__(self, bus: FlagEventBus = BUS) -> None:
        self._bus = bus

    def emit(self, event: dict) -> None:
        self._bus.publish(event)
```

- [ ] **Step 4: Run to confirm pass** — `pytest tests/test_flags_bus.py -v` (5 tests pass).

- [ ] **Step 5: Commit** — `git add backend/flags/bus.py backend/tests/test_flags_bus.py && git commit -m "feat(flags): in-process event bus + SSE event sink (thread-safe fan-out)"`

---

### Task 3: Wire the bus at startup (`main.py` lifespan)

**Files:** Modify `backend/main.py`.

- [ ] **Step 1:** In the `lifespan` function, find the Plan-1 lines (just after `init_db()`):
```python
    from flags import seams as _flag_seams
    _flag_seams.register_mk1_entities()
```
Append immediately after them:
```python
    import asyncio as _asyncio
    from flags import bus as _flag_bus
    _flag_bus.BUS.set_loop(_asyncio.get_running_loop())
    _flag_seams.set_event_sink(_flag_bus.SSEEventSink(_flag_bus.BUS))
```
(Resulting order: register entities → capture the loop on the bus → swap the default `InMemoryEventSink` for the SSE-backed sink. `lifespan` is async, so `get_running_loop()` is valid here.)

- [ ] **Step 2: Verify import-time safety** — `cd backend && python -c "import main"` must succeed (no circulars). Do **not** run the server here; the in-stack smoke is Task 5.

- [ ] **Step 3: Commit** — `git add backend/main.py && git commit -m "feat(flags): activate SSE event sink + bus loop at startup"`

---

### Task 4: SSE endpoint `GET /api/flags/stream` (routes.py)

**Files:** Modify `backend/flags/routes.py`. Test: append to `backend/tests/test_flags_stream.py`.

- [ ] **Step 1: Write the failing endpoint test** (append to `test_flags_stream.py`). Test the generator behavior by exercising the bus + a `TestClient` stream with a bounded read:
```python
def test_stream_emits_event_frame():
    """Open the SSE stream, raise a flag via the bus, read one framed event."""
    import asyncio, json, threading
    from types import SimpleNamespace
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import get_db, Base
    import flags.models  # noqa: F401
    from flags import seams, bus
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    shared = sessionmaker(bind=engine)()
    app.dependency_overrides[get_db] = lambda: iter([shared])
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=42, role="standard", email="t@x.t")
    try:
        client = TestClient(app)
        with client.stream("GET", "/api/flags/stream") as r:
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("text/event-stream")
            # the bus loop is the TestClient's loop; publish from another thread
            threading.Thread(target=lambda: bus.BUS.publish(
                {"event_type": "raised", "flag_id": 1, "event_id": 1, "flag": {"id": 1}})).start()
            event_type = None
            for line in r.iter_lines():
                if line.startswith("event: "):
                    event_type = line[7:].strip()
                if line.startswith("data: "):
                    assert json.loads(line[6:])["flag_id"] == 1
                    break
            assert event_type == "raised"
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        shared.close()
```
> If `TestClient.stream` + the cross-thread publish proves flaky under the sync test transport (Starlette runs the app on its own loop; `BUS` captures *that* loop at first `subscribe`, and the publishing thread reaches it via `call_soon_threadsafe`, so it should work), fall back to a **direct generator unit test**: build a `Subscription`, `put_nowait` an event, drive the endpoint's inner async generator with `asyncio.run` and assert the first non-heartbeat frame. Either proves the frame format; pick the one that's green and note which.

- [ ] **Step 2: Run to confirm fail** (no `/stream` route yet → 404/422).

- [ ] **Step 3: Add imports to `routes.py`:** extend the FastAPI import with `Request`, and add:
```python
import asyncio
import json
from fastapi import Request
from fastapi.responses import StreamingResponse
from flags.bus import BUS
```

- [ ] **Step 4: Add the route ABOVE `@router.get("/{flag_id}", ...)`** (so the literal path wins; place it next to `/summary`):
```python
@router.get("/stream")
async def stream(request: Request, user=Depends(get_current_user)):
    sub = BUS.subscribe(getattr(user, "id", None))

    async def gen():
        yield ": connected\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(sub.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                frame = ""
                if event.get("event_id") is not None:
                    frame += f"id: {event['event_id']}\n"
                frame += f"event: {event['event_type']}\ndata: {json.dumps(event)}\n\n"
                yield frame
        finally:
            sub.close()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
```

- [ ] **Step 5: Run to confirm pass** — `pytest tests/test_flags_stream.py -v` then the full suite `pytest tests/test_flags_*.py -v`.

- [ ] **Step 6 (STRETCH — only if Steps 1–5 are green and time remains): `Last-Event-ID` replay.** If the request carries a `last-event-id` header (or `?last_event_id=`), before the live loop, read `flag_events` rows with `id > last_id` ordered by `id`, and yield a synthetic frame per row (reuse `_flag_summary` shape via a join to `flag_flags`). De-dupe is the client's job. Keep it bounded (e.g. most-recent 200). If awkward, skip — the `id:` frames already make this additive later. Note what you did.

- [ ] **Step 7: Commit** — `git add backend/flags/routes.py backend/tests/test_flags_stream.py && git commit -m "feat(flags): GET /api/flags/stream SSE endpoint (heartbeat + disconnect cleanup)"`

---

### Task 5: In-stack smoke

**Files:** none (verification). You are on the devbox inside your own stack; project name is `accumark-<stackname>` (e.g. `accumark-flagsse`).

- [ ] **Step 1: Full suite in-container** —
```bash
docker compose -p accumark-<stackname> exec -T accu-mk1-backend sh -c "cd /app && pytest tests/test_flags_*.py -v"
```
Expect all flags tests (Plan 1 + the new bus/stream tests) green.

- [ ] **Step 2: Live stream smoke (two shells).** Get a token (login as the seeded admin) and in shell A open the stream; in shell B raise a flag; confirm shell A prints a `raised` frame within ~1s. The backend listens on the stack's mapped port (your block's `…52`, e.g. `http://100.73.137.3:55X2`). Example:
```bash
TOKEN=$(curl -s -X POST http://100.73.137.3:55X2/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"<admin-email>","password":"<admin-pw>"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
# shell A (background): stream for ~8s
curl -sN -H "Authorization: Bearer $TOKEN" http://100.73.137.3:55X2/api/flags/stream &
# shell B: raise a flag
curl -s -X POST http://100.73.137.3:55X2/api/flags -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"entity_type":"sub_sample","entity_id":"1","type":"blocker","title":"sse smoke"}'
```
Expect shell A to show `event: raised` with a `data:` JSON carrying `flag.title == "sse smoke"`. If the admin creds aren't handy, the in-container pytest of Step 1 is the real gate — note what you ran and move on. (No commit — verification only.)

---

## Self-Review (fill in before opening the PR)

- **Spec §6 coverage:** SSE transport, per-user authenticated stream, REST-writes/SSE-reads split, "viewing→in-place / not-viewing→toast" left to the client per the contract. ✓
- **Advisor risks closed:** (1) header-auth — uses `Depends(get_current_user)` + fetch-reader client, no `EventSource`; (2) sync→async — `loop.call_soon_threadsafe` bridge; (3) process model — single uvicorn, in-process bus, no broker; (4) emit-after-commit — Task 1 + regression test. ✓
- **Additive:** no REST/schema/table changes; only emission timing moved (bug fix) + new files. ✓
- **No new deps; tests use `asyncio.run`, not `pytest-asyncio`.** ✓

## PR

When all tasks pass: `git push -u origin feat/flag-system-sse`, then `gh pr create --base master --title "feat(flags): real-time SSE (Plan 2) — event bus, post-commit emit, /api/flags/stream" --body "<task-by-task summary + smoke result + any deviations>"`. If `gh` fails, push anyway and report that the PR needs manual creation.

**Final message must report:** per-task pass/fail with test counts, full list of files created/modified, the PR URL (or that it needs manual creation), the result of the Task 5 smoke (or why it was skipped), and any deviations from this plan and why.
