# Architecture: Sample Prep Wizard + Scale Integration

**Project:** Accu-Mk1 v0.11.0 — New Analysis Wizard
**Domain:** FastAPI + SQLAlchemy + React SPA + Mettler Toledo TCP scale bridge
**Researched:** 2026-02-19
**Overall Confidence:** HIGH (scale bridge) / HIGH (wizard session DB) / HIGH (SSE pattern)

---

## Executive Summary

The v0.11.0 wizard adds two distinct architectural concerns to the existing system: a **Scale Bridge** (TCP connection to Mettler Toledo XSR105DU via MT-SICS protocol) and a **Wizard Session** (resumable multi-step form with DB-backed state). These concerns are independent enough to be built and tested separately. The wizard can be built first with manual weight entry, then the scale bridge plugged in.

The existing SSE streaming pattern (used for SharePoint import, rebuild-standards, resync) is a direct model for scale weight streaming. No new streaming technology is needed — the same `StreamingResponse` + `fetch` + `ReadableStream` pattern applies.

**Recommended build order:**

1. DB models first (wizard session + measurements)
2. Wizard endpoints without scale (manual weight entry)
3. Scale bridge service as an injectable dependency
4. SSE weight-read endpoint that uses scale bridge
5. Frontend wizard UI with manual-entry fallback

---

## Existing Architecture Context

### Current SSE Pattern (HIGH confidence — code verified)

The project already uses SSE via `starlette.responses.StreamingResponse` with `media_type="text/event-stream"`. Four existing endpoints follow this pattern:

- `GET /hplc/seed-peptides/stream`
- `GET /hplc/rebuild-standards/stream`
- `GET /hplc/import-standards/stream`
- `GET /hplc/peptides/{id}/resync/stream`

**Backend pattern (from main.py):**

```python
from starlette.responses import StreamingResponse

async def event_generator():
    def send_event(event_type: str, data: dict) -> str:
        payload = json.dumps(data)
        return f"event: {event_type}\ndata: {payload}\n\n"

    yield send_event("progress", {"status": "reading", "value": None})
    await asyncio.sleep(0)  # flush

    # ... do work, yield more events ...

    yield send_event("done", {"value": 100.05, "unit": "mg", "stable": True})

return StreamingResponse(
    event_generator(),
    media_type="text/event-stream",
    headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
)
```

**Frontend pattern (from AdvancedPane.tsx and PeptideConfig.tsx):**

```typescript
const response = await fetch(`${getApiBaseUrl()}/wizard/steps/weigh/stream`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
})
const reader = response.body!.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  const parts = buffer.split('\n\n')
  buffer = parts.pop() ?? ''
  for (const part of parts) {
    const dataLine = part.split('\n').find(l => l.startsWith('data:'))
    const eventLine = part.split('\n').find(l => l.startsWith('event:'))
    if (!dataLine) continue
    const payload = JSON.parse(dataLine.slice(5).trim())
    const eventType = eventLine?.slice(6).trim()
    // handle: 'reading', 'weight', 'stable', 'error', 'timeout'
  }
}
```

This is the proven, working SSE transport already in use. Use it for scale weight streaming without modification to the pattern.

### Current Auth Pattern (HIGH confidence — code verified)

All endpoints use `Depends(get_current_user)` (JWT Bearer). Wizard endpoints follow the same pattern. SSE endpoints pass the token via `Authorization: Bearer` header in the initial fetch request — this is already proven to work with the existing SSE streaming endpoints.

---

## Scale Bridge Architecture

### MT-SICS Protocol Facts (MEDIUM confidence — multiple source cross-check)

The Mettler Toledo XSR105DU communicates via **MT-SICS (Mettler Toledo Standard Interface Command Set)** over TCP. Key facts verified across multiple sources:

**Transport:** TCP socket, plain text, commands terminated with `\r\n` (CRLF)

**Key commands:**
| Command | Sent | Purpose |
|---------|------|---------|
| `S\r\n` | Client → Scale | Request stable weight (blocks until stable) |
| `SI\r\n` | Client → Scale | Request immediate weight (returns instantly, stable or not) |
| `SIR\r\n` | Client → Scale | Request immediate weight, then repeat on each change |
| `@\r\n` | Client → Scale | Reset / abort current command |
| `I4\r\n` | Client → Scale | Query balance serial number |

**Response format for weight commands:**

```
<CMD> <STATUS> <     WEIGHT> <UNIT>\r\n

Examples:
S S      100.05 mg\r\n    — stable weight, 100.05 mg
S D       98.21 mg\r\n    — dynamic (unstable) weight
SI S     100.05 mg\r\n    — immediate, but happened to be stable
SI D      99.87 mg\r\n    — immediate, unstable
S I\r\n                    — S command timed out (balance still moving)
S +\r\n                    — overload
S -\r\n                    — underload
```

**Status codes:**
- `S` — stable weight value
- `D` — dynamic (unstable) weight value
- `I` — balance not stable in time / command not executable
- `+` — overload
- `-` — underload
- `E` — error (command syntax or parameter error)

**Weight value:** Right-aligned, 10 characters including decimal point and sign. Immediately preceded and followed by spaces.

**Ethernet port:** Not documented as a universal default in searched sources, but the Node.js mt-sics library example uses port 4001. The XSR series allows configuration via balance menu. Treat as configurable via environment variable — default 4001.

**CRITICAL constraint from protocol docs:** Do not send multiple commands without waiting for the corresponding response. The balance may confuse the sequence or ignore commands. The scale bridge must enforce serial command/response discipline.

### Scale Bridge Design

The scale bridge is a **singleton async service** that manages a persistent TCP connection. It is created at application startup and injected into endpoints via FastAPI `Depends()`.

**Why a singleton (not per-request connection):**

- TCP connection setup to lab instruments takes time (100-500ms)
- The balance does not support concurrent connections well (serial command/response protocol)
- A single connection can be reused across multiple weighing steps
- Connection state (connected/disconnected) must be tracked and exposed to the frontend

**Component: `backend/scale_bridge.py`**

```python
"""
Scale Bridge: Manages TCP connection to Mettler Toledo XSR105DU.
Uses MT-SICS protocol. Connection is persistent across requests.
"""
import asyncio
import socket
from dataclasses import dataclass
from typing import Optional
from enum import Enum


class ScaleStatus(str, Enum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    ERROR = "error"


@dataclass
class WeightReading:
    value_mg: float      # Weight in milligrams
    unit: str            # Unit as reported by scale (e.g., "mg", "g")
    stable: bool         # True if status was 'S'
    raw_response: str    # Full raw response for audit


class ScaleBridge:
    """
    Persistent TCP connection to Mettler Toledo XSR105DU.
    Thread-safe for single-connection, serial-command model.
    """

    def __init__(self, host: str, port: int, timeout: float = 10.0):
        self.host = host
        self.port = port
        self.timeout = timeout
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._lock = asyncio.Lock()  # Enforce serial command/response
        self.status = ScaleStatus.DISCONNECTED

    async def connect(self) -> None:
        """Open TCP connection. Called at app startup."""
        ...

    async def disconnect(self) -> None:
        """Close TCP connection. Called at app shutdown."""
        ...

    async def get_stable_weight(
        self,
        timeout_s: float = 15.0,
    ) -> WeightReading:
        """
        Send S command, poll until stable reading received.
        Raises ScaleTimeoutError if not stable within timeout_s.
        """
        async with self._lock:
            ...

    async def get_immediate_weight(self) -> WeightReading:
        """
        Send SI command, return current weight regardless of stability.
        Used for live preview streaming.
        """
        async with self._lock:
            ...

    def _parse_response(self, line: str) -> WeightReading:
        """
        Parse MT-SICS weight response line.
        Format: <CMD> <STATUS> <     WEIGHT> <UNIT>
        Example: 'S S      100.05 mg'
        """
        parts = line.strip().split()
        # parts[0] = command echo (S, SI)
        # parts[1] = status (S, D, I, +, -, E)
        # parts[2] = weight value
        # parts[3] = unit
        ...
```

**Dependency injection pattern (mirrors existing DB pattern):**

```python
# In main.py lifespan:
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # existing startup...

    # Scale bridge startup (if configured)
    scale_host = os.environ.get("SCALE_HOST")
    scale_port = int(os.environ.get("SCALE_PORT", "4001"))
    if scale_host:
        app.state.scale = ScaleBridge(scale_host, scale_port)
        await app.state.scale.connect()
    else:
        app.state.scale = None  # No scale configured — manual entry mode

    yield

    if app.state.scale:
        await app.state.scale.disconnect()


def get_scale(request: Request) -> Optional[ScaleBridge]:
    """FastAPI dependency. Returns None if scale not configured."""
    return getattr(request.app.state, "scale", None)
```

### Stable Weight Polling via SSE

When a tech clicks "Read Weight" on a wizard step, the frontend opens an SSE connection to a weight-read endpoint. The backend polls the scale (using SIR or repeated SI) and streams live weight values until a stable reading is locked.

**Endpoint: `GET /wizard/sessions/{session_id}/steps/{step_key}/weigh/stream`**

```python
@app.get("/wizard/sessions/{session_id}/steps/{step_key}/weigh/stream")
async def stream_weigh(
    session_id: int,
    step_key: str,
    scale: Optional[ScaleBridge] = Depends(get_scale),
    db: Session = Depends(get_db),
    _current_user = Depends(get_current_user),
):
    async def event_generator():
        def send(event_type: str, data: dict) -> str:
            return f"event: {event_type}\ndata: {json.dumps(data)}\n\n"

        if scale is None:
            # Manual entry mode — signal frontend to show text input
            yield send("manual_entry", {"reason": "no_scale_configured"})
            return

        if scale.status != ScaleStatus.CONNECTED:
            yield send("error", {"code": "scale_disconnected", "message": "Scale is not connected"})
            return

        try:
            # Stream live readings while waiting for stability
            yield send("reading", {"status": "waiting", "message": "Place sample on scale..."})
            await asyncio.sleep(0)

            deadline = asyncio.get_event_loop().time() + 30.0
            while asyncio.get_event_loop().time() < deadline:
                reading = await scale.get_immediate_weight()
                yield send("weight", {
                    "value_mg": reading.value_mg,
                    "unit": reading.unit,
                    "stable": reading.stable,
                })
                await asyncio.sleep(0)  # flush

                if reading.stable:
                    # Lock the value into the DB
                    _save_measurement(db, session_id, step_key, reading)
                    yield send("stable", {
                        "value_mg": reading.value_mg,
                        "unit": reading.unit,
                    })
                    return

                await asyncio.sleep(0.5)  # poll interval

            yield send("timeout", {"message": "Scale did not stabilize within 30 seconds"})

        except Exception as e:
            yield send("error", {"code": "scale_error", "message": str(e)})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
```

### SSE vs WebSocket Decision

**Use SSE. Do not use WebSockets.**

Rationale:
- SSE is already the established pattern in this codebase (4 existing endpoints)
- Weight reading is **unidirectional** — backend pushes, frontend listens
- The single bidirectional action (tech clicks "cancel") can be handled by the frontend simply closing the fetch connection (AbortController)
- WebSockets would require a new dependency or manual protocol implementation
- SSE with `X-Accel-Buffering: no` already handles nginx proxy flushing

**SSE is appropriate here.** The weight streaming event is short-lived (seconds), closes when stable or timeout, and does not need two-way messaging.

---

## Wizard Session Persistence

### Session State Machine

A wizard session has a well-defined lifecycle:

```
created → in_progress → completed
                     ↘ abandoned
```

**State transitions:**
- `created`: Session record exists, no steps completed yet
- `in_progress`: One or more steps saved, not yet submitted
- `completed`: All required steps done, final record saved
- `abandoned`: Tech explicitly cancelled or session too old (optional)

**The key design principle:** Sessions are resumable. If a tech starts, weighs steps 1-3, leaves for lunch, and returns — they can resume from step 3. The DB record shows which steps have measurements.

### New DB Tables

**Table: `wizard_sessions`**

```python
class WizardSession(Base):
    """
    A single sample prep wizard session.
    One session = one sample being prepared for HPLC injection.
    """
    __tablename__ = "wizard_sessions"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    status: Mapped[str] = mapped_column(String(20), default="in_progress")
    # Status: "in_progress" | "completed" | "abandoned"

    # Sample identity (from SENAITE lookup or manual entry)
    sample_id_label: Mapped[str] = mapped_column(String(200), nullable=False)
    peptide_id: Mapped[Optional[int]] = mapped_column(ForeignKey("peptides.id"), nullable=True)

    # Tech-entered targets (entered at wizard start)
    target_concentration_ug_ml: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    target_volume_ml: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Derived outputs (computed, not stored — recalculated from measurements)
    # These are stored only in wizard_measurements.calculation_trace

    # Session metadata
    operator_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Relationships
    measurements: Mapped[list["WizardMeasurement"]] = relationship(
        "WizardMeasurement", back_populates="session", cascade="all, delete-orphan"
    )
    peptide: Mapped[Optional["Peptide"]] = relationship("Peptide")
```

**Table: `wizard_measurements`**

```python
class WizardMeasurement(Base):
    """
    One weighing step within a wizard session.
    Each weighing event creates a record — raw weight only.
    All derived values (dilution factor, concentrations) are recalculated
    at read time from the raw measurements.
    """
    __tablename__ = "wizard_measurements"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("wizard_sessions.id"), nullable=False)

    # Which step this measurement belongs to
    step_key: Mapped[str] = mapped_column(String(50), nullable=False)
    # step_key values: "stock_vial_empty", "stock_vial_with_diluent",
    #                  "dil_vial_empty", "dil_vial_with_diluent",
    #                  "dil_vial_with_sample"

    # Raw weight from scale (or manual entry)
    weight_mg: Mapped[float] = mapped_column(Float, nullable=False)
    unit: Mapped[str] = mapped_column(String(10), default="mg")

    # Provenance
    source: Mapped[str] = mapped_column(String(20), default="scale")
    # source: "scale" | "manual"
    scale_raw_response: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Raw MT-SICS response for audit: "S S      100.05 mg"

    # Whether this reading was superseded (tech re-weighed)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)

    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    session: Mapped["WizardSession"] = relationship("WizardSession", back_populates="measurements")
```

**Design rationale — why store only raw weights:**

The existing `hplc_processor.py` already calculates `dilution_factor`, `stock_volume_ml`, etc. from 5 balance weights. The wizard produces those same 5 weights as measurements. Storing only raw weights means:

1. Calculation bugs can be fixed without data migration
2. Full audit trail: every measurement is immutable, re-weighing creates a new record with `is_current=False` on the old one
3. Consistent with the existing `HPLCAnalysis` model which stores raw weights and calculates everything else

### Re-weigh Pattern

If a tech makes an error and re-weighs a step, the endpoint does NOT update the existing record. It inserts a new `WizardMeasurement` and sets `is_current=False` on the previous record for the same `(session_id, step_key)`. This preserves the full weighing history.

```python
# When saving a measurement:
# 1. Set is_current=False on any existing current measurement for this step
db.execute(
    update(WizardMeasurement)
    .where(WizardMeasurement.session_id == session_id)
    .where(WizardMeasurement.step_key == step_key)
    .where(WizardMeasurement.is_current == True)
    .values(is_current=False)
)
# 2. Insert new current measurement
db.add(WizardMeasurement(
    session_id=session_id,
    step_key=step_key,
    weight_mg=reading.value_mg,
    source="scale",
    scale_raw_response=reading.raw_response,
))
db.commit()
```

---

## Backend Endpoint Design

### Wizard Endpoints

All endpoints follow existing patterns: `Depends(get_db)`, `Depends(get_current_user)`, SQLAlchemy sync session.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/wizard/sessions` | Create new wizard session (returns session_id) |
| `GET` | `/wizard/sessions` | List sessions (with status filter) |
| `GET` | `/wizard/sessions/{id}` | Get full session state (steps + measurements + calculated values) |
| `PUT` | `/wizard/sessions/{id}` | Update session metadata (targets, sample ID) |
| `PATCH` | `/wizard/sessions/{id}/complete` | Mark session completed |
| `PATCH` | `/wizard/sessions/{id}/abandon` | Mark session abandoned |
| `POST` | `/wizard/sessions/{id}/steps/{step_key}/manual` | Record manual weight entry |
| `GET` | `/wizard/sessions/{id}/steps/{step_key}/weigh/stream` | SSE: read weight from scale |
| `GET` | `/wizard/sessions/{id}/calculations` | Return recalculated values from current measurements |
| `GET` | `/scale/status` | Scale connection status (connected/disconnected) |

### Calculated Values Endpoint

The `GET /wizard/sessions/{id}/calculations` endpoint recalculates from raw measurements on demand. It reuses the existing `calculate_dilution_factor()` from `hplc_processor.py`:

```python
@app.get("/wizard/sessions/{session_id}/calculations")
async def get_wizard_calculations(
    session_id: int,
    db: Session = Depends(get_db),
    _current_user = Depends(get_current_user),
):
    """
    Recalculate all derived values from current measurements.
    Returns None for any values that cannot be calculated yet
    (i.e., required measurements not yet recorded).
    """
    measurements = _get_current_measurements(db, session_id)
    # ... build WeightInputs from measurements ...
    # ... call calculate_dilution_factor() ...
    # ... return derived values ...
```

This means the frontend does not need to implement any calculation logic. All scientific values are computed server-side, consistent with the existing "backend owns all calculations" principle.

---

## Component Boundaries

### System Components

```
┌─────────────────────────────────────────────────────────────────────┐
│  React Frontend                                                      │
│                                                                      │
│  ┌─────────────────────────────┐   ┌────────────────────────────┐  │
│  │  WizardPage                 │   │  ScaleStatusBadge          │  │
│  │  (step navigation, state)   │   │  (poll /scale/status)      │  │
│  └──────────────┬──────────────┘   └────────────────────────────┘  │
│                 │                                                     │
│  ┌──────────────┴──────────────────────────────────────────────┐    │
│  │  WeighStep                                                   │    │
│  │  - Opens SSE to /wizard/sessions/{id}/steps/{key}/weigh/stream│  │
│  │  - Shows live weight preview                                  │    │
│  │  - Falls back to text input if scale not connected            │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ HTTP + SSE
                                   │ Authorization: Bearer <token>
┌──────────────────────────────────┴──────────────────────────────────┐
│  FastAPI Backend                                                     │
│                                                                      │
│  ┌────────────────────┐   ┌─────────────────────────────────────┐  │
│  │  Wizard Endpoints  │   │  Scale Bridge (singleton)           │  │
│  │  /wizard/sessions  │   │                                      │  │
│  │  /wizard/*/weigh   │   │  ┌─────────────────────────────┐   │  │
│  │  /scale/status     │   │  │  asyncio.StreamReader/Writer│   │  │
│  └──────────┬─────────┘   │  │  TCP socket to scale        │   │  │
│             │             │  └─────────────────────────────┘   │  │
│  ┌──────────┴─────────┐   │  _lock: asyncio.Lock()             │  │
│  │  hplc_processor.py │   │  (serial cmd/response enforced)    │  │
│  │  (reused for calcs)│   └─────────────────────────┬───────────┘  │
│  └────────────────────┘                             │               │
│                                                     │               │
│  ┌─────────────────────────────────────────────────┐               │
│  │  SQLite DB                                       │               │
│  │  wizard_sessions + wizard_measurements           │               │
│  └─────────────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────────────┘
                                                      │ TCP
                                   ┌──────────────────┴──────┐
                                   │  Mettler Toledo         │
                                   │  XSR105DU               │
                                   │  MT-SICS over TCP:4001  │
                                   └─────────────────────────┘
```

### Data Flow: Weighing Step

```
1. Tech clicks "Read Weight" on step N
   └→ Frontend opens SSE: GET /wizard/sessions/42/steps/stock_vial_empty/weigh/stream

2. Backend receives request
   └→ ScaleBridge.get_immediate_weight() called in loop (0.5s interval)
   └→ SSE events streamed: "reading" → "weight" (with live value) → "weight" → ... → "stable"

3. On stable reading:
   └→ Backend saves WizardMeasurement to DB (step_key="stock_vial_empty", weight_mg=100.05)
   └→ Backend yields "stable" event with confirmed value
   └→ SSE connection closes (generator returns)

4. Frontend receives "stable" event
   └→ Marks step as complete
   └→ Fetches GET /wizard/sessions/42/calculations for updated derived values
   └→ Advances to next step
```

### Data Flow: Session Resume

```
1. Tech returns after leaving mid-session
   └→ Frontend queries GET /wizard/sessions (filter: status=in_progress)
   └→ Shows "Resume" option for incomplete sessions

2. Tech resumes session 42
   └→ GET /wizard/sessions/42
   └→ Backend returns: session metadata + all current measurements + calculated values
   └→ Frontend restores wizard to correct step (first step with no measurement)

3. Tech continues from where they left off
   └→ Steps with measurements shown as complete (read-only, with re-weigh option)
   └→ Steps without measurements shown as pending
```

---

## Build Order and Testability

### Phase 1: DB Models + Wizard Core (No Scale Required)

**Goal:** Working wizard with manual weight entry only.

Build sequence:
1. Add `WizardSession` and `WizardMeasurement` models to `models.py`
2. Add migration in `database.py` (`init_db` pattern — add columns with try/except)
3. Implement wizard REST endpoints (create, get, list, update, complete)
4. Implement manual weight entry endpoint (`POST /wizard/sessions/{id}/steps/{key}/manual`)
5. Implement calculations endpoint (`GET /wizard/sessions/{id}/calculations`)
6. Build frontend wizard UI with step navigation and manual text inputs

**Independently testable:** Full wizard flow works without any scale hardware. This phase delivers usable functionality even if scale integration is never built.

### Phase 2: Scale Bridge (Independently Testable)

**Goal:** `ScaleBridge` service that can be tested in isolation.

Build sequence:
1. Create `backend/scale_bridge.py` with `ScaleBridge` class
2. Add configuration via environment variables (`SCALE_HOST`, `SCALE_PORT`)
3. Register bridge in `lifespan` — gracefully skip if `SCALE_HOST` not set
4. Add `GET /scale/status` endpoint
5. Write a standalone test script that connects to the scale and reads one weight

**Test without full app:** `ScaleBridge` can be tested with a standalone `asyncio` script:

```python
# test_scale.py — run directly, no FastAPI required
import asyncio
from scale_bridge import ScaleBridge

async def main():
    bridge = ScaleBridge(host="192.168.1.100", port=4001)
    await bridge.connect()
    reading = await bridge.get_stable_weight(timeout_s=10.0)
    print(f"Weight: {reading.value_mg} mg (stable={reading.stable})")
    await bridge.disconnect()

asyncio.run(main())
```

**Mock fallback for CI:** When `SCALE_HOST` is not set, `get_scale()` dependency returns `None`. Endpoints that call `get_scale()` respond with `manual_entry` SSE event or appropriate status. Tests can run without any scale hardware.

### Phase 3: SSE Weight Streaming (Connects Phase 1 + Phase 2)

**Goal:** Replace manual weight entry with scale-driven SSE stream.

Build sequence:
1. Add `GET /wizard/sessions/{id}/steps/{key}/weigh/stream` endpoint
2. Frontend: open SSE connection when tech clicks "Read Weight"
3. Frontend: handle all SSE event types (reading, weight, stable, error, timeout, manual_entry)
4. Graceful fallback: if `manual_entry` event received, show text input

---

## Docker Network Consideration

The scale bridge connects to a physical device on the lab network. In Docker, the backend container needs network access to the scale's IP. The existing `docker-compose.yml` uses a custom bridge network. The scale is accessible via the host network — options:

**Option A (recommended):** Add `SCALE_HOST` environment variable to `backend/.env`. Since the backend container is on the same LAN as the scale (not the Docker overlay network), use `network_mode: host` for the backend service, or configure the scale with a static IP reachable from the Docker bridge network.

**Option B:** Use the Docker host's external IP (not `localhost`) to reach the scale from within the container.

**Option C (simpler for lab deployment):** If the scale is on the same physical network as the server host, the Docker container can reach it via a static IP. Add the IP to `.env`:

```env
SCALE_HOST=192.168.1.100
SCALE_PORT=4001
```

The scale bridge handles reconnection on startup. If the scale is off or unreachable, the bridge sets `status=disconnected` and the wizard runs in manual-entry mode.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Per-Request Scale Connection

**What goes wrong:** Opening a new TCP connection for each weighing SSE request. The Mettler Toledo balance may not handle rapid reconnects gracefully, and TCP setup latency will be visible to the user.

**Instead:** Use the singleton `ScaleBridge` attached to `app.state`. One connection persists for the application lifetime.

### Anti-Pattern 2: Storing Calculated Values in DB

**What goes wrong:** Storing `dilution_factor`, `stock_concentration_ug_ml` etc. alongside raw weights. If the calculation formula changes, stored values become wrong and require data migration.

**Instead:** Store only raw measurements (`weight_mg` for each step). Recalculate everything on demand via `GET /wizard/sessions/{id}/calculations`. This matches the existing pattern in `HPLCAnalysis` and `hplc_processor.py`.

### Anti-Pattern 3: Blocking asyncio with Scale TCP Read

**What goes wrong:** Using synchronous `socket.recv()` inside an async FastAPI endpoint. This blocks the event loop and prevents other requests from being served during the weight read.

**Instead:** Use `asyncio.open_connection()` which gives `asyncio.StreamReader`/`asyncio.StreamWriter`. The scale bridge must be fully async. The `_lock` prevents concurrent commands to the scale without blocking the event loop.

### Anti-Pattern 4: Updating Measurement Records In-Place

**What goes wrong:** When a tech re-weighs a step, overwriting the existing measurement record. Audit trail is lost.

**Instead:** On re-weigh, set `is_current=False` on the old record and insert a new record. The weighing history is preserved. Queries always filter `is_current=True` to get current values.

### Anti-Pattern 5: Scale State in Frontend

**What goes wrong:** Frontend tracks whether the scale is connected and uses this as the source of truth.

**Instead:** Backend owns scale state. Frontend polls `GET /scale/status` (e.g., every 5 seconds). The frontend can cache the last known status for UI display, but never assumes the scale is connected.

### Anti-Pattern 6: WebSockets for Weight Streaming

**What goes wrong:** Adding WebSocket dependency when SSE already works for this use case. Increases complexity — WebSockets require ping/pong keepalive, connection management, and a different client pattern than the 4 existing SSE consumers.

**Instead:** SSE via `StreamingResponse` with `ReadableStream` reader on the frontend. This is already proven in the codebase and sufficient for unidirectional weight push.

---

## Scalability Considerations

This is a lab application with at most 2-3 simultaneous users. These are not cloud-scale concerns, but they affect correctness:

| Concern | At 1-2 Lab Users | Notes |
|---------|-----------------|-------|
| Scale concurrency | No concurrent weighing — physical lab constraint (one balance) | The `asyncio.Lock()` on ScaleBridge enforces this technically |
| Session isolation | Sessions are per-tech (operator_id FK) | No cross-session contamination |
| DB write contention | SQLite with sync sessions — fine for 2-3 users | Existing pattern |
| SSE connection lifetime | Each weighing step = one short-lived SSE connection (seconds) | No long-held connections unlike SharePoint import streams |
| Scale reconnection | Auto-reconnect on startup; manual reconnect via `GET /scale/reconnect` endpoint (optional) | Should handle lab restarts |

---

## Sources

| Claim | Source | Confidence |
|-------|--------|------------|
| MT-SICS response format: `S S 100.05 mg\r\n` | Multiple MT-SICS reference manual search results, Node.js mt-sics library, community documentation | MEDIUM (PDFs couldn't be fetched directly; format confirmed by multiple independent sources) |
| S command waits for stable; SI returns immediately | Official MT-SICS documentation (multiple PDFs referenced) + mettler_toledo_device_python README | HIGH |
| Commands terminated with `\r\n` | Official MT-SICS docs + multiple sources | HIGH |
| Do not send multiple commands without waiting for response | Official MT-SICS protocol specification | HIGH |
| Status codes: S=stable, D=dynamic, I=not executable, +/- overload | Multiple MT-SICS reference manual sources | MEDIUM-HIGH |
| Port 4001 as example | Node.js mt-sics library example | LOW (configurable — treat as default only) |
| Ethernet TCP interface option exists for Excellence series | Official MT.com Ethernet interface documentation URL found (403 response) | MEDIUM |
| SSE pattern (StreamingResponse + ReadableStream) | Codebase verified — 4 working endpoints | HIGH |
| asyncio.Lock for serial command enforcement | Python docs + standard concurrent async pattern | HIGH |
| Re-weigh audit via is_current flag | Standard immutable audit log pattern | HIGH (architectural best practice) |
