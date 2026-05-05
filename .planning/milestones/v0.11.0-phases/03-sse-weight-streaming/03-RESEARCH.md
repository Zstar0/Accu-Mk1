# Phase 3: SSE Weight Streaming - Research

**Researched:** 2026-02-19
**Domain:** FastAPI SSE streaming, React 19 fetch-based SSE consumption, stability detection, manual fallback UI
**Confidence:** HIGH — all patterns verified directly from the codebase (4 existing SSE endpoints, exact SSE parser code in frontend, complete ScaleBridge API from Phase 2)

---

## Summary

Phase 3 adds a `GET /scale/weight/stream` SSE endpoint that polls `ScaleBridge.read_weight()` in a loop and streams readings to the wizard UI. The frontend consumes the stream with the existing `fetch` + `ReadableStream` + `TextDecoder` pattern already used in 3 places. Stability detection (5 consecutive readings within 0.5 mg) belongs in the frontend because it is pure UI state — no database persistence needed, no server round-trip savings, and the frontend already owns the "Accept Weight" button's enabled state.

The manual fallback is straightforward: the wizard step checks `GET /scale/status` on mount. If the response is `{"status": "disabled"}`, it renders a plain `<Input type="number">` (from the existing `WeightsForm` component pattern) instead of the "Read Weight" SSE button. The `source` field on `WizardMeasurementCreate` distinguishes the two paths in the DB audit trail.

No new packages are needed on either end. The backend already imports `StreamingResponse` per-endpoint (not globally). The frontend already has all helper utilities: `getApiBaseUrl()`, `getAuthToken()`, `getBearerHeaders()` (via `src/lib/api.ts`).

**Primary recommendation:** One backend SSE endpoint + one frontend custom hook `useScaleStream` + one wizard weight-input component that renders either the live SSE display or the manual input based on scale status.

---

## User Constraints (no CONTEXT.md — prior decisions from STATE.md)

### Locked Decisions
- ScaleBridge as singleton on `app.state` (not per-request connection) — access via `request.app.state.scale_bridge`
- SSE via `StreamingResponse` (existing codebase pattern — 4 endpoints already using it)
- SCALE_HOST env var controls scale mode; absent = manual-entry mode (no crash, `bridge is None`)
- Scale IP confirmed: 192.168.3.113 (remote network — not currently accessible for hardware testing)
- `asyncio.Lock` per-bridge guards concurrent SI command/response cycles on shared TCP stream

### Claude's Discretion
- No CONTEXT.md exists — all implementation details below are research-driven recommendations
- Stability detection location (frontend vs backend) — research recommends frontend (see Architecture Patterns)
- Poll interval for SSE loop — research recommends 250ms (4 readings/second)
- Exact component name and file placement

### Deferred (out of scope for Phase 3)
- Wizard UI steps/navigation (Phase 4)
- SENAITE lookup (Phase 5)
- Settings UI for scale_host/scale_port (Phase 4 or 5)

---

## Standard Stack

No new packages required on either end.

### Backend (already installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `starlette.responses.StreamingResponse` | via fastapi 0.115 | SSE response | Already used in 4 endpoints; imported per-endpoint |
| `asyncio` (stdlib) | Python 3.11+ | Poll loop with sleep | Used in existing SSE generators |
| `json` (stdlib) | Python 3.11+ | Serialize SSE data payloads | Already used in all 4 SSE endpoints |

### Frontend (already installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `fetch` (native) | Browser API | SSE with auth headers | Existing pattern — EventSource can't send auth headers |
| `ReadableStream` (native) | Browser API | Stream consumption | Used in all 3 existing frontend SSE consumers |
| `TextDecoder` (native) | Browser API | Decode chunks | Used in all 3 existing frontend SSE consumers |
| `AbortController` (native) | Browser API | Cancel stream on unmount | Used in `PeptideConfig.tsx` SSE consumer |
| `getApiBaseUrl()` | `src/lib/config.ts` | API base URL | Existing helper |
| `getAuthToken()` | `src/store/auth-store.ts` | JWT token for Bearer header | Existing helper |

### Installation
```bash
# Nothing to install — all capabilities already present
```

---

## Architecture Patterns

### Recommended File Structure
```
backend/
└── main.py           # ADD: GET /scale/weight/stream endpoint

src/
├── lib/
│   └── scale-stream.ts      # NEW: useScaleStream hook
└── components/
    └── hplc/
        └── WeightInput.tsx  # NEW: weight input component (SSE mode or manual mode)
```

### Pattern 1: Backend SSE Endpoint (exact template from codebase)

The 4 existing SSE endpoints all follow this identical structure. Copy it exactly.

**Source:** `backend/main.py` lines 2469-2758 — verified directly from codebase.

```python
# GET /scale/weight/stream — Phase 3
@app.get("/scale/weight/stream")
async def stream_scale_weight(
    request: Request,
    _current_user=Depends(get_current_user),
):
    """
    SSE endpoint: streams live weight readings from the scale at ~4 Hz.

    Events emitted:
      weight  {"value": float, "unit": str, "stable": bool}
      error   {"message": str}
      done    {}  (emitted when client disconnects cleanly)

    If scale bridge is disabled (SCALE_HOST not set), returns 503.
    """
    from starlette.responses import StreamingResponse
    import asyncio

    bridge = getattr(request.app.state, "scale_bridge", None)
    if bridge is None:
        raise HTTPException(status_code=503, detail="Scale not configured (SCALE_HOST not set)")

    async def event_generator():
        def send_event(event_type: str, data: dict) -> str:
            payload = json.dumps(data)
            return f"event: {event_type}\ndata: {payload}\n\n"

        try:
            while True:
                # Check client disconnect (ASGI disconnect detection)
                if await request.is_disconnected():
                    break

                try:
                    reading = await bridge.read_weight()
                    yield send_event("weight", {
                        "value": reading["value"],
                        "unit": reading["unit"],
                        "stable": reading["stable"],
                    })
                except ConnectionError as e:
                    yield send_event("error", {"message": str(e)})
                except ValueError as e:
                    # Malformed MT-SICS response — log and continue
                    yield send_event("error", {"message": f"Parse error: {e}"})

                await asyncio.sleep(0.25)  # 4 Hz poll rate
        except asyncio.CancelledError:
            pass  # Client disconnected — normal shutdown

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
```

**Key detail:** `request.is_disconnected()` is the ASGI way to detect client disconnect in FastAPI streaming responses. It is an async call that resolves `True` when the client closes the connection. Without this check, the generator runs forever even after the client navigates away.

### Pattern 2: Frontend SSE Consumption (exact template from codebase)

The existing frontend SSE consumers in `PeptideConfig.tsx` (lines 160-246, 253-340) and `AdvancedPane.tsx` (lines 23-70) all use `fetch` + `ReadableStream` + `TextDecoder`. This is the correct pattern because `EventSource` (the native SSE API) cannot send custom request headers — it cannot include the `Authorization: Bearer <token>` header required by this app's JWT auth.

**Source:** `src/components/hplc/PeptideConfig.tsx` lines 168-176 — verified directly from codebase.

```typescript
// src/lib/scale-stream.ts
import { useEffect, useRef, useState, useCallback } from 'react'
import { getApiBaseUrl } from './config'
import { getAuthToken } from '@/store/auth-store'

export interface ScaleReading {
  value: number
  unit: string
  stable: boolean
}

export interface ScaleStreamState {
  reading: ScaleReading | null
  error: string | null
  streaming: boolean
  stableCount: number    // consecutive stable readings within threshold
  isStable: boolean      // true when stableCount >= STABILITY_THRESHOLD
}

const STABILITY_THRESHOLD = 5
const STABILITY_TOLERANCE_MG = 0.5

export function useScaleStream(active: boolean) {
  const [state, setState] = useState<ScaleStreamState>({
    reading: null,
    error: null,
    streaming: false,
    stableCount: 0,
    isStable: false,
  })

  const abortRef = useRef<AbortController | null>(null)
  const windowRef = useRef<number[]>([])  // rolling window of recent values

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setState(prev => ({ ...prev, streaming: false }))
  }, [])

  useEffect(() => {
    if (!active) {
      stop()
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setState(prev => ({ ...prev, streaming: true, error: null }))

    const run = async () => {
      try {
        const token = getAuthToken()
        const response = await fetch(`${getApiBaseUrl()}/scale/weight/stream`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        const reader = response.body?.getReader()
        if (!reader) throw new Error('No response body')

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // Parse SSE events from buffer
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          let eventType = ''
          let eventData = ''

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6)
            } else if (line === '' && eventType && eventData) {
              try {
                const payload = JSON.parse(eventData)

                if (eventType === 'weight') {
                  const newValue: number = payload.value

                  // Update rolling window
                  windowRef.current = [...windowRef.current.slice(-(STABILITY_THRESHOLD - 1)), newValue]

                  // Stability detection: all values in window within tolerance
                  let stableCount = 0
                  if (windowRef.current.length >= STABILITY_THRESHOLD) {
                    const min = Math.min(...windowRef.current)
                    const max = Math.max(...windowRef.current)
                    if (max - min <= STABILITY_TOLERANCE_MG) {
                      stableCount = STABILITY_THRESHOLD
                    }
                  }

                  setState(prev => ({
                    ...prev,
                    reading: { value: payload.value, unit: payload.unit, stable: payload.stable },
                    error: null,
                    stableCount,
                    isStable: stableCount >= STABILITY_THRESHOLD,
                  }))
                } else if (eventType === 'error') {
                  setState(prev => ({ ...prev, error: payload.message }))
                }
              } catch {
                // Skip malformed events
              }
              eventType = ''
              eventData = ''
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setState(prev => ({ ...prev, error: err instanceof Error ? err.message : 'Stream failed' }))
        }
      } finally {
        setState(prev => ({ ...prev, streaming: false }))
      }
    }

    run()

    return () => {
      controller.abort()
    }
  }, [active, stop])

  return { ...state, stop }
}
```

### Pattern 3: Scale Status Check (determines mode)

The wizard step needs to know on mount whether scale mode or manual mode is active. Use `GET /scale/status` (already implemented in Phase 2).

```typescript
// In the WeightInput component or its parent wizard step:
const [scaleMode, setScaleMode] = useState<'loading' | 'scale' | 'manual'>('loading')

useEffect(() => {
  const token = getAuthToken()
  fetch(`${getApiBaseUrl()}/scale/status`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
    .then(r => r.json())
    .then(data => {
      setScaleMode(data.status === 'disabled' ? 'manual' : 'scale')
    })
    .catch(() => setScaleMode('manual'))  // Any error → fallback to manual
}, [])
```

The `/scale/status` response is `{"status": "disabled" | "connected" | "disconnected", ...}`. Both `"connected"` and `"disconnected"` mean scale mode — even disconnected shows the SSE UI (the stream emits `error` events until reconnect). Only `"disabled"` (SCALE_HOST not set) uses manual mode.

**Rationale:** A disconnected scale can reconnect. The tech should still see the SSE UI with an error banner rather than switching to manual. Manual is only for when the scale is not configured at all.

### Pattern 4: WeightInput Component — Mode Switching

```typescript
// src/components/hplc/WeightInput.tsx
interface WeightInputProps {
  stepKey: string          // e.g. "stock_vial_empty_mg"
  label: string            // Human-readable label
  onAccept: (value: number, source: 'scale' | 'manual') => void
}

export function WeightInput({ stepKey, label, onAccept }: WeightInputProps) {
  const [scaleMode, setScaleMode] = useState<'loading' | 'scale' | 'manual'>('loading')
  const [streamActive, setStreamActive] = useState(false)
  const [manualValue, setManualValue] = useState('')

  const { reading, isStable, error, streaming } = useScaleStream(streamActive)

  // ... scale status check useEffect ...

  if (scaleMode === 'loading') {
    return <Skeleton className="h-24 w-full" />
  }

  if (scaleMode === 'manual') {
    return (
      <div className="space-y-2">
        <Label>{label}</Label>
        <div className="flex gap-2">
          <Input
            type="number"
            step="0.01"
            placeholder="0.00"
            value={manualValue}
            onChange={e => setManualValue(e.target.value)}
            className="font-mono"
          />
          <Button
            onClick={() => onAccept(parseFloat(manualValue), 'manual')}
            disabled={!manualValue || isNaN(parseFloat(manualValue))}
          >
            Accept
          </Button>
        </div>
      </div>
    )
  }

  // Scale mode
  return (
    <div className="space-y-3">
      <Label>{label}</Label>
      {!streaming ? (
        <Button onClick={() => setStreamActive(true)}>Read Weight</Button>
      ) : (
        <div className="space-y-2">
          {/* Live weight display */}
          <div className={`rounded-md border p-4 font-mono text-2xl ${
            isStable ? 'border-green-500 bg-green-50' : 'border-muted bg-muted/30'
          }`}>
            {reading ? `${reading.value.toFixed(2)} ${reading.unit}` : '—'}
          </div>

          {/* Stability indicator */}
          {isStable && (
            <Badge variant="outline" className="border-green-500 text-green-700">
              Stable
            </Badge>
          )}

          {/* Error banner */}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error} — scale reconnecting...</AlertDescription>
            </Alert>
          )}

          <div className="flex gap-2">
            <Button
              onClick={() => reading && onAccept(reading.value, 'scale')}
              disabled={!isStable || !reading}
            >
              Accept Weight
            </Button>
            <Button variant="outline" onClick={() => setStreamActive(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Manual entry escape hatch — always available in scale mode */}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Enter manually instead</summary>
        <div className="mt-2 flex gap-2">
          <Input
            type="number"
            step="0.01"
            placeholder="0.00"
            value={manualValue}
            onChange={e => setManualValue(e.target.value)}
            className="font-mono"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setStreamActive(false)
              onAccept(parseFloat(manualValue), 'manual')
            }}
            disabled={!manualValue || isNaN(parseFloat(manualValue))}
          >
            Accept
          </Button>
        </div>
      </details>
    </div>
  )
}
```

### Stability Detection: Frontend vs Backend

**Decision: Frontend.** Reasoning:
1. Stability is UI state — it gates the "Accept Weight" button, which is a frontend concern.
2. No other consumer needs stability information (it's not stored in DB, not used by calculations).
3. Moving it to backend would require another SSE field or endpoint, adds complexity for no gain.
4. All 5 existing SSE endpoints in this codebase have the backend emit raw data; UI state derived from data lives in React.
5. The rolling window (5 values) is trivial to manage in a `useRef` inside the hook — no shared state needed.

**Stability algorithm:**
```typescript
// Rolling window approach — simpler and more robust than consecutive-counter
const STABILITY_THRESHOLD = 5       // number of readings
const STABILITY_TOLERANCE_MG = 0.5  // mg (from requirement SCALE-03)

// Keep last N values in a ref (not state — no re-render on every push)
const window = last5Values
const isStable = window.length >= 5 && (max(window) - min(window)) <= 0.5
```

**Note on "consecutive":** The requirement says "5 consecutive readings within 0.5 mg of each other." The rolling window approach satisfies this: if all 5 values in the last-5 window are within 0.5 mg of each other, they are by definition consecutive and within range.

### Anti-Patterns to Avoid

- **Using `EventSource`:** Native `EventSource` API cannot send `Authorization` headers. This app uses JWT auth on all endpoints. Use `fetch` + `ReadableStream` as established in the codebase.
- **Storing stability in Zustand:** Stability is transient UI state for one wizard step. It does not persist between sessions, is not shared between components, and resets every time the stream starts. Use `useState`/`useRef` in the hook — not Zustand.
- **Opening new TCP connection per SSE request:** The `ScaleBridge` singleton already handles this. The SSE endpoint just calls `bridge.read_weight()` in a loop — never instantiates its own connection.
- **No disconnect detection:** Without `request.is_disconnected()`, the SSE generator runs indefinitely after the client navigates away, holding the `asyncio.Lock` and blocking other readers. Check disconnect on every loop iteration.
- **Blocking the asyncio.Lock during the full loop:** `bridge.read_weight()` already acquires and releases the `asyncio.Lock` internally per read. The poll loop does NOT need its own lock. Just call `await bridge.read_weight()` and let the bridge handle concurrency.
- **Sending one SSE per weight field (5 streams simultaneously):** Only one SSE connection is open at a time — one per active "Read Weight" button. The wizard shows one weight input at a time. Multiple simultaneous streams would contend on the `asyncio.Lock`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SSE event formatting | Custom streaming format | `f"event: {type}\ndata: {json}\n\n"` (existing pattern) | Already verified in 4 endpoints |
| SSE parsing in frontend | Custom byte parser | Existing buffer/split('\n') pattern from PeptideConfig.tsx | Already battle-tested in 3 frontend consumers |
| Auth header on SSE | Middleware workaround | `fetch` with `Authorization` header + `AbortController` | Native browser APIs, established pattern |
| Scale TCP management | New connection in endpoint | `request.app.state.scale_bridge.read_weight()` | Phase 2 singleton handles all TCP lifecycle |
| Stability indicator | Custom animation | shadcn `Badge` (green variant) + `Alert` for errors | Already in UI component library |

---

## Common Pitfalls

### Pitfall 1: Concurrent SSE Readers Contend on asyncio.Lock

**What goes wrong:** If two wizard steps are visible simultaneously (unlikely but possible), or the tech double-clicks "Read Weight," two SSE connections are open. Both call `bridge.read_weight()` concurrently. `bridge.read_weight()` acquires the `asyncio.Lock` — so the second call blocks until the first completes. This is safe (by design) but means the second stream appears to have 2x latency.

**Why it happens:** The `asyncio.Lock` in `ScaleBridge` serializes all reads — by design, since the TCP stream is shared.

**How to avoid:** The WeightInput component should only open one SSE stream at a time. Disable the "Read Weight" button while streaming. The `streamActive` state flag handles this.

**Warning signs:** One stream appears to deliver readings at 500ms intervals instead of 250ms.

### Pitfall 2: SSE Generator Runs Forever After Client Disconnects

**What goes wrong:** The `while True` poll loop in the backend SSE generator continues executing after the frontend navigates away, because ASGI doesn't automatically cancel the generator.

**Why it happens:** HTTP/1.1 TCP connection close is not always detected immediately by the server-side generator.

**How to avoid:** Check `await request.is_disconnected()` at the top of every loop iteration. Also wrap the generator in a `try/except asyncio.CancelledError: pass` block.

**Warning signs:** The backend logs show scale reads continuing after the client page closes. The `asyncio.Lock` is held indefinitely, blocking all other scale reads.

### Pitfall 3: Manual Fallback Mode Is Missing the `source: 'manual'` Field

**What goes wrong:** The measurement is recorded with `source: 'scale'` even when the tech typed it manually.

**Why it happens:** The `onAccept` callback or the API call omits the `source` field.

**How to avoid:** The `WeightInput.onAccept(value, source)` signature explicitly passes `'manual'` or `'scale'`. The wizard step that calls `POST /wizard/sessions/{id}/measurements` uses this value directly.

**Warning signs:** All measurements show `source: 'scale'` in the DB even when the scale was offline.

### Pitfall 4: Scale Disconnected ≠ Manual Mode

**What goes wrong:** When the scale is configured but disconnected (e.g., network blip), the UI switches to manual input mode. The tech enters weights manually. When the scale reconnects, the tech doesn't realize scale mode is back.

**Why it happens:** Conflating `status: 'disconnected'` with `status: 'disabled'` in the mode-selection logic.

**How to avoid:** `status === 'disabled'` → manual mode (permanent). `status === 'connected' || status === 'disconnected'` → scale mode (possibly temporarily degraded, SSE emits error events). The SSE stream handles reconnect automatically via the ScaleBridge reconnect loop.

**Warning signs:** Tech reports that the "Read Weight" button disappeared after a network blip.

### Pitfall 5: React 19 Strict Mode Double-Mount

**What goes wrong:** In React 19 dev mode with Strict Mode, effects run twice (mount → unmount → mount). The SSE stream is opened, closed, and reopened. The second stream may hit the `asyncio.Lock` while the first is mid-read.

**Why it happens:** React 19 Strict Mode intentionally double-invokes effects to catch cleanup bugs.

**How to avoid:** The `AbortController` cleanup in `useScaleStream`'s `useEffect` return must abort the fetch correctly. The existing `PeptideConfig.tsx` SSE consumer uses this same pattern and works in Strict Mode. Follow the same pattern exactly.

**Warning signs:** Two SSE connections visible in browser DevTools Network tab during dev.

### Pitfall 6: Scale Hardware Not Accessible During Development

**What goes wrong:** The SSE endpoint cannot be tested end-to-end because the scale at 192.168.3.113 is on a remote network.

**Why it happens:** Physical constraint.

**How to avoid:**
1. Mock mode: Add a `?mock=true` query param that yields fake readings without a real bridge (dev only).
2. Or: Test the backend SSE endpoint with a `bridge.read_weight()` mock in the test.
3. The `GET /scale/status → "disabled"` path (manual mode) is fully testable without hardware.

**Warning signs:** All SSE tests fail in CI because SCALE_HOST is not set.

---

## Code Examples

### Full Backend SSE Endpoint (verified pattern)
```python
# Source: existing send_event pattern from main.py line 2484
# Source: existing StreamingResponse pattern from main.py line 2750

@app.get("/scale/weight/stream")
async def stream_scale_weight(
    request: Request,
    _current_user=Depends(get_current_user),
):
    from starlette.responses import StreamingResponse
    import asyncio

    bridge = getattr(request.app.state, "scale_bridge", None)
    if bridge is None:
        raise HTTPException(status_code=503, detail="Scale not configured")

    async def event_generator():
        def send_event(event_type: str, data: dict) -> str:
            payload = json.dumps(data)
            return f"event: {event_type}\ndata: {payload}\n\n"

        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    reading = await bridge.read_weight()
                    yield send_event("weight", reading)
                except (ConnectionError, ValueError) as e:
                    yield send_event("error", {"message": str(e)})
                await asyncio.sleep(0.25)
        except asyncio.CancelledError:
            pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
```

### Frontend SSE Parse Loop (exact existing pattern)
```typescript
// Source: src/components/hplc/PeptideConfig.tsx lines 185-234 — verified directly

const reader = response.body?.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break

  buffer += decoder.decode(value, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop() || ''

  let eventType = ''
  let eventData = ''

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim()
    } else if (line.startsWith('data: ')) {
      eventData = line.slice(6)
    } else if (line === '' && eventType && eventData) {
      try {
        const payload = JSON.parse(eventData)
        // handle payload by eventType
      } catch { /* skip malformed */ }
      eventType = ''
      eventData = ''
    }
  }
}
```

### Zustand Selector Syntax (required by AGENTS.md)
```typescript
// ✅ GOOD — selector syntax, no destructuring
const token = useAuthStore(state => state.token)

// ✅ GOOD — getState() in callbacks (no hook call outside component)
const token = getAuthToken()  // already exported from auth-store.ts

// ❌ BAD — do not destructure Zustand stores
const { token } = useAuthStore()
```

---

## Files to Create/Modify

| File | Action | What |
|------|--------|------|
| `backend/main.py` | MODIFY | Add `GET /scale/weight/stream` SSE endpoint under `# --- Scale endpoints` block |
| `src/lib/scale-stream.ts` | CREATE | `useScaleStream` hook with stability detection |
| `src/components/hplc/WeightInput.tsx` | CREATE | Weight input component: SSE mode or manual mode |

### What Does NOT Change
- `backend/scale_bridge.py` — Phase 2 ScaleBridge is complete and correct; Phase 3 uses it as-is
- `src/store/ui-store.ts` — No global UI state needed for transient SSE state
- Any existing wizard session endpoints — `POST /wizard/sessions/{id}/measurements` already accepts `source: 'scale' | 'manual'`

---

## Endpoint Design

| Method | Path | Purpose | Auth | Phase |
|--------|------|---------|------|-------|
| `GET` | `/scale/status` | Check if scale configured | JWT | Phase 2 (done) |
| `GET` | `/scale/weight/stream` | SSE live weight stream | JWT | Phase 3 (new) |

**SSE event schema:**

```
event: weight
data: {"value": 8505.75, "unit": "g", "stable": true}

event: error
data: {"message": "Scale connection lost: Connection reset by peer"}
```

**503 when scale disabled:**
```json
{"detail": "Scale not configured (SCALE_HOST not set)"}
```

The frontend uses `GET /scale/status` first to determine mode. If disabled → render manual input (no SSE button). If enabled (connected or disconnected) → render "Read Weight" button.

---

## Wizard Integration Context

The wizard step that uses `WeightInput` is in `CreateAnalysis.tsx` (currently a "Coming Soon" stub). Phase 3 does NOT build the full wizard UI — that is Phase 4. Phase 3 only needs:

1. The SSE endpoint so it works correctly
2. The `useScaleStream` hook tested in isolation
3. The `WeightInput` component that can be dropped into any wizard step

The `WeightInput` component accepts a `stepKey` prop (one of the `VALID_STEP_KEYS` from `main.py`) and an `onAccept(value, source)` callback. The parent wizard step calls `POST /wizard/sessions/{id}/measurements` with the accepted value.

**Existing `WeightInput` field labels (from `VALID_STEP_KEYS` in `main.py`):**
- `stock_vial_empty_mg` → "Stock Vial + Cap (empty)"
- `stock_vial_loaded_mg` → "Stock Vial + Cap + Diluent"
- `dil_vial_empty_mg` → "Dilution Vial + Cap (empty)"
- `dil_vial_with_diluent_mg` → "Dilution Vial + Cap + Diluent"
- `dil_vial_final_mg` → "Dilution Vial + Cap + Diluent + Sample"

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `EventSource` API | `fetch` + `ReadableStream` | `EventSource` cannot set `Authorization` header; `fetch` can |
| Polling (`setInterval` + `fetch`) | SSE long-lived connection | SSE has lower overhead; server pushes data, no repeated HTTP connections |
| `SIR` continuous read from balance | `SI` polled at 250ms by backend | `SIR` sends indefinitely until `@` reset — harder to manage with Lock; `SI` + app-level poll is simpler and already tested |

**On `SIR` vs `SI`:** Phase 2 research flagged `SIR` (continuous read mode) as an option for Phase 3. After reviewing the `asyncio.Lock` design and the existing `read_weight()` API, `SI` polled at 250ms is the correct choice. `SIR` would require the backend to read continuously from the TCP stream, which conflicts with the Lock-per-request design and makes disconnect handling harder. At 250ms polling, the frontend gets 4 readings/second — more than sufficient to detect stability and give live feedback.

---

## Open Questions

1. **`request.is_disconnected()` availability in FastAPI 0.115**
   - What we know: `Request.is_disconnected()` is a Starlette method available since Starlette 0.20+. FastAPI 0.115 ships Starlette 0.41+ (pinned in requirements.txt).
   - What's unclear: Whether `is_disconnected()` works correctly with uvicorn's ASGI implementation for streaming responses specifically.
   - Recommendation: Use it — it's the documented approach. Fallback: wrap the generator in `try/except GeneratorExit` as a secondary disconnect detection mechanism.
   - Confidence: MEDIUM (not verified against this specific FastAPI+uvicorn version combination, but universally documented as the correct approach)

2. **Poll rate 250ms vs 500ms**
   - What we know: 250ms = 4 Hz, 500ms = 2 Hz. MT-SICS `SI` command response time on local TCP is ~5-20ms. The `asyncio.Lock` adds queue time if multiple readers exist.
   - What's unclear: Whether 250ms is fast enough to feel "live" vs 500ms being sufficient.
   - Recommendation: 250ms (4 Hz) for snappier UX. Stability detection needs only 5 readings; at 500ms that's 2.5 seconds of wait after the weight settles. At 250ms it's 1.25 seconds.

3. **Manual fallback in scale mode (always visible vs hidden)**
   - What we know: Success criterion 3 says "scale offline → manual input instead of SSE." The requirement says "instead of" but doesn't say it can't also be available in scale mode.
   - Recommendation: Show manual fallback as a collapsible/details element in scale mode too — tech may prefer manual entry even when scale works. The `source` field differentiates in the audit trail.

---

## Sources

### Primary (HIGH confidence — verified from codebase)
- `backend/main.py` lines 2469-2758: 4 existing SSE endpoint implementations — `send_event()` helper, generator pattern, `StreamingResponse` return
- `backend/main.py` lines 275-306: Lifespan pattern, `request.app.state.scale_bridge` access
- `backend/main.py` lines 4656-4678: Existing `GET /scale/status` endpoint — the Phase 2 bridge status check
- `backend/scale_bridge.py`: Complete `ScaleBridge` class — `read_weight()` raises `ConnectionError` or `ValueError`, `connected` property
- `src/components/hplc/PeptideConfig.tsx` lines 160-246: Full frontend SSE consumer with `fetch`, `AbortController`, `TextDecoder`, buffer parsing
- `src/components/preferences/panes/AdvancedPane.tsx` lines 23-70: Second frontend SSE consumer pattern variant
- `src/store/auth-store.ts`: `getAuthToken()` export, `useAuthStore` selector pattern
- `src/lib/config.ts`: `getApiBaseUrl()` export
- `src/lib/api.ts`: `getBearerHeaders()` pattern, `API_BASE_URL` dynamic getter

### Secondary (MEDIUM confidence)
- `AGENTS.md`: Zustand selector syntax requirement (no destructuring), React Compiler (no manual useMemo/useCallback), state management onion pattern
- `.planning/STATE.md`: Locked decisions — ScaleBridge singleton, SSE via StreamingResponse, SCALE_HOST env var, asyncio.Lock

### Tertiary (LOW confidence, flag for validation)
- `request.is_disconnected()` behavior under uvicorn streaming: documented but not directly tested in this specific setup
- MT-SICS `SIR` vs `SI` for streaming: `SI` chosen over `SIR` based on Phase 2 research recommendation — not verified against physical hardware

---

## Metadata

**Confidence breakdown:**
- Backend SSE pattern: HIGH — copied from 4 existing endpoints in the same codebase
- Frontend SSE consumption: HIGH — copied from 3 existing consumers in the same codebase
- Stability detection algorithm: HIGH — straightforward rolling window, requirement is clear (5 readings, 0.5 mg tolerance)
- Manual fallback: HIGH — existing `Input` component + existing `source` field on WizardMeasurementCreate
- `request.is_disconnected()`: MEDIUM — documented API, not tested under this exact uvicorn version
- Poll rate (250ms): MEDIUM — reasonable engineering judgment, no performance data from hardware

**Research date:** 2026-02-19
**Valid until:** 2026-05-19 (stable patterns; FastAPI SSE and React fetch streaming are long-lived APIs)
**Hardware dependency:** Scale at 192.168.3.113 not accessible — SSE endpoint can be developed and unit-tested without hardware using the `status: 'disabled'` path and a mock bridge
