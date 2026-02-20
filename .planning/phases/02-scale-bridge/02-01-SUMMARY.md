---
phase: 02-scale-bridge
plan: 01
subsystem: hardware
tags: [mt-sics, tcp, asyncio, scale, mettler-toledo, fastapi, lifespan]

# Dependency graph
requires:
  - phase: 01-wizard-db
    provides: FastAPI app structure, lifespan pattern, app.state pattern, auth middleware

provides:
  - ScaleBridge singleton asyncio TCP client for MT-SICS protocol
  - _parse_sics_response() MT-SICS response parser
  - GET /scale/status endpoint returning disabled/connected/disconnected
  - scale_host and scale_port seeded into DEFAULT_SETTINGS/settings table
  - .env.example SCALE_HOST/SCALE_PORT documentation
  - test_scale.py standalone hardware verification script

affects:
  - 03-sse-streaming
  - 04-wizard-ui

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ScaleBridge on app.state: hardware singleton stored on FastAPI app.state, initialized in lifespan"
    - "Graceful degradation: env var absent = feature disabled, not error"
    - "Exponential backoff reconnect: 2s initial, doubles on failure, capped at 60s"

key-files:
  created:
    - backend/scale_bridge.py
    - backend/test_scale.py
    - backend/.env.example
  modified:
    - backend/main.py

key-decisions:
  - "ScaleBridge stored on app.state (not per-request connection) — singleton owns TCP connection lifecycle"
  - "SCALE_HOST absent = bridge is None, not an error — manual-entry mode always works"
  - "_parse_sics_response raises ValueError for all error codes (ES/ET/EL/I/+/-/E/L) — caller handles"
  - "asyncio.Lock per-bridge guards concurrent SI commands on shared TCP stream"
  - "Hardware test deferred: scale at 192.168.3.113 on remote network not currently accessible"

patterns-established:
  - "app.state pattern for hardware singletons: assign in lifespan, read via request.app.state in endpoints"
  - "Env-var feature flags: absent = disabled gracefully, set = enabled with config"

# Metrics
duration: 4min
completed: 2026-02-20
---

# Phase 2 Plan 01: Scale Bridge Summary

**MT-SICS TCP client (ScaleBridge) with async reconnect loop, response parser, FastAPI lifespan integration, and /scale/status endpoint — balance disabled gracefully when SCALE_HOST absent**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-20T03:45:13Z
- **Completed:** 2026-02-20T03:48:47Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- ScaleBridge asyncio TCP client with exponential-backoff reconnect loop (2s → 60s cap) and per-bridge asyncio.Lock for safe concurrent access
- MT-SICS response parser handling all status flags (S/D stable, I/+/-/E/L errors) and error codes (ES/ET/EL) with correct ValueError semantics
- FastAPI lifespan integration: conditional ScaleBridge init from SCALE_HOST, clean shutdown, /scale/status endpoint with JWT auth returning disabled/connected/disconnected
- scale_host and scale_port seeded into DEFAULT_SETTINGS and settings table; .env.example documents both vars
- Standalone test_scale.py for field-level hardware verification without FastAPI dependency

## Task Commits

Each task was committed atomically:

1. **Task 1: Create ScaleBridge class and MT-SICS parser** - `8453dd3` (feat)
2. **Task 2: Integrate ScaleBridge into FastAPI lifespan, add status endpoint and settings** - `f6a6cbd` (feat)
3. **Task 3: Create standalone test script** - `f8a36b1` (feat)

## Files Created/Modified

- `backend/scale_bridge.py` — ScaleBridge class with asyncio TCP client, _parse_sics_response parser, SCALE_PORT_DEFAULT constant
- `backend/main.py` — Added Request import, scale_host/scale_port to DEFAULT_SETTINGS, lifespan ScaleBridge init/shutdown, GET /scale/status endpoint
- `backend/test_scale.py` — Standalone hardware test script, no FastAPI dependency
- `backend/.env.example` — Created with JWT, API key, integration service, and scale sections

## Decisions Made

- ScaleBridge is a singleton on `app.state` (not per-request connection) — the TCP connection lifecycle is owned by the bridge and survives across requests
- SCALE_HOST absent means `app.state.scale_bridge = None`, not an error or degraded state — manual-entry mode is a first-class mode
- `_parse_sics_response` raises `ValueError` for all error conditions; callers (read_weight) translate connection drops to `ConnectionError`
- `asyncio.Lock` guards the SI command/response cycle so concurrent calls do not interleave on the TCP stream
- Hardware test deferred to when scale at 192.168.3.113 is accessible on the network

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Python venv not on PATH; discovered `.venv/Scripts/python.exe` in backend directory. Used explicit path for all verification commands. Not a code issue.

## User Setup Required

None - no external service configuration required beyond what is documented in `.env.example`.

To test hardware connection when on the lab network:
```bash
cd backend && python test_scale.py 192.168.3.113 8001
```

## Next Phase Readiness

- Phase 3 (SSE streaming) can build directly on `request.app.state.scale_bridge.read_weight()` — the API is stable
- Phase 3 needs `bridge.connected` for status-aware SSE event emission
- Hardware validation blocked until lab network access — code is correct, unit tests pass, physical test deferred

---
*Phase: 02-scale-bridge*
*Completed: 2026-02-20*

## Self-Check: PASSED
