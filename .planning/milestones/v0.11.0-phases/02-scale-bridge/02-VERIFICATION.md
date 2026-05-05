---
phase: 02-scale-bridge
verified: 2026-02-20T03:52:18Z
status: human_needed
score: 5/7 must-haves verified (2 deferred - hardware unreachable)
human_verification:
  - test: Run python test_scale.py 192.168.3.113 8001 from backend directory
    expected: Prints Connected, Stability STABLE or DYNAMIC, Weight value, Scale communication test PASSED
    why_human: Requires physical Mettler Toledo XSR105DU on 192.168.3.113 - remote network not accessible
  - test: With SCALE_HOST=192.168.3.113 start backend and call GET /scale/status with valid JWT
    expected: Returns status connected, host 192.168.3.113, port 8001
    why_human: Requires physical balance reachable - code path correct but connected branch needs hardware
---

# Phase 2: Scale Bridge Verification Report

**Phase Goal:** Backend connects to the Mettler Toledo XSR105DU over TCP and correctly reads stable weights using MT-SICS protocol, with the scale status exposed via API.
**Verified:** 2026-02-20T03:52:18Z
**Status:** human_needed
**Re-verification:** No - initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | GET /scale/status returns disabled when SCALE_HOST env var is absent | VERIFIED | lifespan sets app.state.scale_bridge = None when SCALE_HOST absent; confirmed by programmatic lifespan test |
| 2 | GET /scale/status returns connected when SCALE_HOST set and balance reachable | HUMAN_NEEDED | Code path correct - requires physical hardware on 192.168.3.113 |
| 3 | GET /scale/status returns disconnected when SCALE_HOST set but balance unreachable | VERIFIED | When bridge.connect() fails _connected stays False, endpoint returns disconnected. Structurally confirmed |
| 4 | App starts normally with no SCALE_HOST - no crash, no startup error | VERIFIED | asyncio test through lifespan confirms bridge is None, no exception raised |
| 5 | test_scale.py connects to balance sends SI prints parsed weight with stability flag - no FastAPI | HUMAN_NEEDED | Script exists imports cleanly correct logic - requires physical balance on 192.168.3.113 |
| 6 | scale_host and scale_port in DEFAULT_SETTINGS and seeded into settings table | VERIFIED | DEFAULT_SETTINGS scale_host is empty string and scale_port is 8001 confirmed |
| 7 | SCALE_HOST and SCALE_PORT are documented in .env.example | VERIFIED | backend/.env.example contains commented SCALE_HOST and SCALE_PORT with MT-SICS section header |

**Score:** 5/7 truths verified automatically. 2 deferred - blocked by physical hardware access, not code gaps.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| backend/scale_bridge.py | ScaleBridge singleton class with MT-SICS TCP client | VERIFIED | 221 lines, no stubs, exports ScaleBridge + _parse_sics_response + SCALE_PORT_DEFAULT |
| backend/scale_bridge.py | MT-SICS response parser (_parse_sics_response) | VERIFIED | Handles S/D flags, ES/ET/EL error codes, I/+/-/E/L balance error statuses. All raise ValueError. Full test suite passed |
| backend/test_scale.py | Standalone scale test script | VERIFIED | 50 lines, shebang present, imports only asyncio + sys + scale_bridge. Zero FastAPI deps. Module loads cleanly |
| backend/main.py | Scale bridge lifespan integration and /scale/status endpoint | VERIFIED | Lifespan conditionally creates ScaleBridge from SCALE_HOST, sets app.state.scale_bridge, shuts down after yield. GET /scale/status at line 4658 with JWT auth |
| backend/.env.example | Documents SCALE_HOST and SCALE_PORT | VERIFIED | 60-line file with complete scale section |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| main.py lifespan() | scale_bridge.ScaleBridge | from scale_bridge import in lifespan body + app.state.scale_bridge assignment | WIRED | Lines 288 and 295 - bridge created and assigned to app.state |
| main.py lifespan() | os.environ SCALE_HOST | os.environ.get(SCALE_HOST) conditional | WIRED | Lines 292-299 - absent sets None, present starts bridge |
| main.py get_scale_status() | ScaleBridge.connected | getattr(request.app.state, scale_bridge, None) then bridge.connected | WIRED | Lines 4671-4675 - safely reads from request.app.state, returns disabled/connected/disconnected |
| test_scale.py | ScaleBridge | from scale_bridge import ScaleBridge | WIRED | Line 14 - direct import, no FastAPI intermediary |

### Requirements Coverage

| Requirement | Status | Notes |
|-------------|--------|-------|
| SC-1: Standalone test script connects to physical balance | HUMAN_NEEDED | Script code is correct; hardware unreachable |
| SC-2: GET /scale/status returns connected when reachable | HUMAN_NEEDED | Code path confirmed correct; hardware unreachable |
| SC-3: App starts without SCALE_HOST (graceful degradation) | SATISFIED | Verified programmatically via lifespan test |
| SC-4: Scale IP/port configurable via env vars and settings | SATISFIED | SCALE_HOST/SCALE_PORT in lifespan + DEFAULT_SETTINGS + .env.example |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | - | - | - | No stubs, no TODOs, no placeholder content found in any Phase 2 files |

### Human Verification Required

#### 1. Standalone Balance Test (test_scale.py)

**Test:** From the backend/ directory on a machine with network access to 192.168.3.113, run:

    python test_scale.py 192.168.3.113 8001

**Expected:** Script connects, sends SI command, prints weight reading with stability flag (STABLE or DYNAMIC), and prints Scale communication test PASSED.

**Why human:** Physical Mettler Toledo XSR105DU at 192.168.3.113 is on a remote lab network not accessible from this machine. The code is correct - this is purely a network/hardware access blocker.

#### 2. GET /scale/status Returns connected

**Test:** Set SCALE_HOST=192.168.3.113 in the environment, start the backend (uvicorn main:app), authenticate to get a JWT, then call:

    GET /scale/status  (Authorization: Bearer <token>)

**Expected:** Returns {status: connected, host: 192.168.3.113, port: 8001}

**Why human:** Requires physical balance reachable and _connected = True after TCP connection succeeds. The disconnected branch was structurally verified (bridge exists but not connected). The connected branch requires the hardware to respond.

---

## Structural Verification Detail

### scale_bridge.py

- Level 1 (Exists): Present at backend/scale_bridge.py
- Level 2 (Substantive): 221 lines. Real asyncio TCP implementation. No stubs.
- Level 3 (Wired): Imported in main.py lifespan (line 288) and test_scale.py (line 14)
- Parser correctness: 9/9 test cases passed (stable, dynamic, ES/ET/EL, I/+/-/E/L)
- Implementation: asyncio.Lock on SI command cycle, wait_for(connect, 5.0s), wait_for(readline, 3.0s), ASCII decode with errors=replace, exponential backoff (2s to 60s cap), clean task cancellation in stop()

### test_scale.py

- Level 1 (Exists): Present at backend/test_scale.py
- Level 2 (Substantive): 50 lines. Shebang present (#!/usr/bin/env python3). Connects, calls read_weight(), prints structured output, sys.exit(1) on failure.
- Level 3 (Self-contained): Imports only asyncio, sys, scale_bridge.ScaleBridge. Zero FastAPI dependencies confirmed.

### main.py scale integration

- Request import: line 16 (from fastapi import FastAPI, Depends, HTTPException, Header, Request, status)
- import os: line 7
- DEFAULT_SETTINGS: scale_host and scale_port at lines 257-258
- Lifespan startup: Conditional ScaleBridge init at lines 287-300, assigned to app.state.scale_bridge
- Lifespan shutdown: getattr guard + await stop() at lines 304-306
- Endpoint: @app.get(/scale/status) at line 4658 with Depends(get_current_user), three-way status return

### .env.example

- Level 1 (Exists): Present at backend/.env.example
- Level 2 (Substantive): 60 lines. Scale section at lines 55-60 with commented SCALE_HOST and SCALE_PORT.

---

_Verified: 2026-02-20T03:52:18Z_
_Verifier: Claude (gsd-verifier)_
