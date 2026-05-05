---
phase: 03-sse-weight-streaming
plan: 01
subsystem: api
tags: [sse, scale, streaming, fastapi, react, hooks, weight-input]

# Dependency graph
requires:
  - phase: 02-scale-bridge
    provides: ScaleBridge singleton on app.state with read_weight() and /scale/status endpoint
provides:
  - GET /scale/weight/stream SSE endpoint at 4 Hz with weight/error event types
  - useScaleStream React hook with 5-reading rolling window stability detection
  - WeightInput component with scale SSE mode and manual entry fallback

affects:
  - 04-wizard-ui (drops WeightInput into each wizard weighing step)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - SSE endpoint pattern: StreamingResponse with send_event helper, asyncio.sleep(0.25) poll, CancelledError guard
    - Frontend SSE consumer: fetch + ReadableStream + TextDecoder + AbortController (NOT EventSource)
    - Rolling window stability: 5 readings, max-min <= 0.5 mg threshold
    - Scale mode detection: GET /scale/status on mount, fallback to manual on error

key-files:
  created:
    - backend/main.py (GET /scale/weight/stream endpoint added)
    - src/lib/scale-stream.ts
    - src/components/hplc/WeightInput.tsx
  modified:
    - backend/main.py

key-decisions:
  - "poll rate 4 Hz (asyncio.sleep(0.25)) — balance between responsiveness and CPU load"
  - "error events do NOT break SSE loop — bridge may self-reconnect"
  - "stability detection is pure frontend rolling window — avoids per-request state on server"
  - "WeightInput uses local state only (not Zustand) — transient UI state, not shared"

patterns-established:
  - "WeightInput: dual-mode component pattern for hardware-or-manual UI"
  - "useScaleStream: active boolean controls connection lifecycle"

# Metrics
duration: 10min
completed: 2026-02-20
---

# Phase 3 Plan 1: SSE Weight Streaming Summary

**FastAPI SSE endpoint streams balance readings at 4 Hz; React hook provides rolling-window stability detection; WeightInput component auto-selects scale vs manual mode based on /scale/status**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-02-20T04:23:13Z
- **Completed:** 2026-02-20T04:33:00Z
- **Tasks:** 2
- **Files modified:** 3 (1 modified, 2 created)

## Accomplishments
- Backend SSE endpoint `/scale/weight/stream` streams MT-SICS readings at 4 Hz, returns 503 when SCALE_HOST not set, continues looping on ConnectionError/ValueError so bridge can reconnect
- `useScaleStream` hook uses fetch + ReadableStream + AbortController (not EventSource) with JWT auth header support, 5-reading rolling window stability detection (max-min <= 0.5 mg)
- `WeightInput` component checks `/scale/status` on mount to auto-select scale vs manual mode; includes live weight display with green stable indicator, Accept Weight button (enabled only when stable), and always-available manual escape hatch via `<details>` element

## Task Commits

Each task was committed atomically:

1. **Task 1: Add GET /scale/weight/stream SSE endpoint** - `cdc9cde` (feat)
2. **Task 2: Create useScaleStream hook and WeightInput component** - `61c639c` (feat)

## Files Created/Modified
- `backend/main.py` - Added `stream_scale_weight` async route after existing `/scale/status` endpoint
- `src/lib/scale-stream.ts` - `useScaleStream` hook, `ScaleReading`/`ScaleStreamState` interfaces, stability constants
- `src/components/hplc/WeightInput.tsx` - Dual-mode weight input component (`WeightInput` + `WeightInputProps`)

## Decisions Made
- Poll rate set to 4 Hz (0.25s sleep) — balance between live feel and server CPU load
- SSE error events do not break the loop — `ConnectionError`/`ValueError` are transient; bridge reconnects automatically
- Stability detection is entirely frontend (rolling window in hook ref) — keeps server stateless
- All scale state local to component/hook — transient UI, not shared across components, not persisted

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- AST verification command in plan used `ast.FunctionDef` which does not match `async def` functions (`AsyncFunctionDef`). Used both types in verification — no functional issue.
- Pre-existing lint errors (30) exist across other files in the codebase; new files introduced zero additional errors.

## User Setup Required

None - no external service configuration required. Scale hardware configuration uses existing SCALE_HOST environment variable from Phase 2.

## Next Phase Readiness
- `WeightInput` is ready to be dropped into Phase 4's wizard step components
- Import: `import { WeightInput } from '@/components/hplc/WeightInput'`
- Usage: `<WeightInput stepKey="stock_vial_empty_mg" label="Empty vial weight" onAccept={handleWeightAccepted} />`
- Scale hardware test still deferred (192.168.3.113 on remote network) — Phase 4 wizard can be built and tested with manual-entry mode

---
*Phase: 03-sse-weight-streaming*
*Completed: 2026-02-20*

## Self-Check: PASSED
