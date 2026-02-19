# Research Summary: v0.11.0 New Analysis Wizard

**Project:** Accu-Mk1
**Milestone:** v0.11.0 — HPLC Sample Prep Wizard with Mettler Toledo Scale Integration
**Researched:** 2026-02-19
**Confidence:** HIGH (architecture, SSE pattern, wizard flow) / MEDIUM (scale hardware specifics)

## Executive Summary

This milestone adds a 5-step guided sample preparation wizard to the existing FastAPI + React lab app. The wizard captures weighing data from a Mettler Toledo XSR105DU analytical balance via TCP (MT-SICS protocol), performs dilution calculations, and writes a complete audit-trail session record to SQLite. The key architectural insight from research is that **this can be built in two independent phases**: the wizard core (DB models, step navigation, calculations, session persistence) works fully with manual weight entry, and the scale bridge is plugged in as a FastAPI dependency afterward. This staging approach is critical for de-risking the hardware dependency.

The stack additions are minimal: only `sse-starlette` is a new backend package. Everything else — `asyncio` for TCP, `httpx` for SENAITE, `Zustand` for wizard UI state, and the SSE streaming pattern — is already present in the codebase. The existing SSE pattern (`StreamingResponse` + `fetch` + `ReadableStream`) is used by 4 existing endpoints and is a direct model for scale weight streaming. No new streaming technology is needed.

The highest-risk areas are hardware unknowns (does the XSR105DU have the Ethernet module? what port? what IP?), SENAITE custom field mapping (peptide name and declared weight field names are instance-specific), and precision arithmetic (the calculation chain must use Python `Decimal` from the first line — retrofitting later is painful). All of these are blockers that must be resolved before Phase 2 begins.

---

## Key Findings

### Stack Additions

The existing stack handles everything except three concerns. One new package total.

| Concern | Solution | New? |
|---------|----------|------|
| MT-SICS balance communication over TCP | `asyncio.open_connection()` stdlib | No |
| Stream live weight readings to frontend | `sse-starlette` | **YES — only new package** |
| SENAITE sample lookup | `httpx` (already installed) | No |
| Wizard UI step state | Zustand (already installed) | No |

**Add to `requirements.txt`:** `sse-starlette>=2.1.0`

Do NOT add: `pyserial` (wrong transport — scale uses TCP not serial), `websockets` (SSE is sufficient), any step-wizard frontend library (build with shadcn/ui primitives + Zustand).

**New environment variables required:**
```
SCALE_IP=192.168.x.x   # MUST verify on device before writing code
SCALE_PORT=4001         # Default; configurable on balance
```

See `STACK.md` for full reference implementations of `ScaleClient`, `SenaiteClient`, and the SSE endpoint skeleton.

### Expected Features

**Must-build (table stakes — wizard is broken without these):**
- Vertical step sidebar (left) + content area (right), 3 states: locked / current / complete
- Linear step gating — "Next" disabled until step complete; completed steps backnavigable
- SENAITE sample lookup by ID with not-found and unreachable error states
- Live weight display with stable/unstable indicator (SSE stream)
- Auto-accept stable weight with 3-second countdown + manual override
- "Accept Weight" and "Re-read" buttons per weighing point
- Inline calculated results with formula visible
- Session autosave on each step advance (draft persistence to DB)
- Session resume from draft (with "Resume" banner on wizard entry)
- Scale offline state with auto-retry + manual weight entry fallback
- Session record written to DB on completion
- Cancel wizard with confirmation dialog

**Build if time allows (differentiators):**
- Step status icons (Lucide: CheckCircle2 / Circle / Lock)
- Step subtitle showing captured data summary in sidebar
- Countdown timer with cancel for auto-accept
- Tare reminder card before each weighing substep
- "Show formula" collapsible on calculated results (shadcn `Collapsible`)
- Keyboard navigation (Tab/Enter flow)

**Defer to v0.12.0:**
- Weight trend sparkline
- GMP session record PDF/CSV export
- Re-read with reason logging
- Barcode scanner integration
- Results entry / purity calculation (separate post-run workflow)

**Anti-features (explicitly do not build):**
- Free step jumping — step 4 depends on step 3's calculated stock concentration
- Auto-recalculation when tech edits a past step — cascade invalidation only
- Tare/calibration commands from the app — read only (`SI` and `S` only)
- Multiple simultaneous sessions — one active draft per user

See `FEATURES.md` for full step-by-step behavior specification and error state coverage.

### Architecture Approach

Two independent architectural concerns are added: a **Scale Bridge** (singleton asyncio TCP service) and a **Wizard Session** (resumable multi-step DB-backed state machine). These can be built and tested separately. The wizard runs in manual-entry mode until the scale bridge is connected, and the scale bridge can be tested with a standalone `asyncio` script without FastAPI running.

**Major components:**

1. **`backend/scale_bridge.py` — ScaleBridge singleton**
   - Persistent TCP connection to XSR105DU via MT-SICS
   - `asyncio.Lock()` enforces serial command/response discipline (balance handles one command at a time)
   - Registered in FastAPI `lifespan`; injected via `Depends(get_scale)`; returns `None` when `SCALE_HOST` not set (triggers manual-entry mode)
   - Polls `SI` at 300ms for live streaming; uses software stability detection (5 consecutive readings within 0.5mg)

2. **DB tables: `wizard_sessions` + `wizard_measurements`**
   - Sessions: status, sample reference, target parameters, operator, timestamps
   - Measurements: raw weights only (not calculated values) — calculations are always recomputed from raw measurements on demand
   - Re-weigh pattern: `is_current=False` on old record, insert new — full history preserved for audit trail

3. **SSE weight streaming endpoint: `GET /wizard/sessions/{id}/steps/{key}/weigh/stream`**
   - Follows existing codebase SSE pattern exactly (`StreamingResponse` + `media_type="text/event-stream"` + `X-Accel-Buffering: no`)
   - Auth via standard `Authorization: Bearer` header in initial fetch (already proven in existing endpoints)
   - Events: `reading` → `weight` (live with `stable: bool`) → `stable` (locked value) / `error` / `timeout` / `manual_entry`

4. **`GET /wizard/sessions/{id}/calculations`**
   - Recalculates all derived values (stock concentration, dilution volumes) from current raw measurements on demand
   - Reuses `hplc_processor.py` calculation functions — backend owns all math, frontend displays only

5. **Frontend: `PrepWizardStore` (Zustand) + `WizardPage` + `WeighStep` components**
   - Zustand (middle tier of state onion) manages cross-step session state during wizard
   - Selector pattern strictly (project rule: no destructuring from store)
   - Step navigation driven by `currentStep` integer index; no URL routing changes needed

See `ARCHITECTURE.md` for full data flow diagrams, endpoint table, and build-order detail.

### Critical Pitfalls

1. **Accepting `S D` (dynamic) weight as confirmed** — Parse the MT-SICS stability field on every response. Gate the "Accept" button on `stable === true`. Add software-side dwell (3+ consecutive stable readings). Do NOT enable confirmation the moment any value appears. This is a GMP violation if missed. Build into the scale bridge from day one — do not retrofit.

2. **Stale tare from a previous session** — The XSR105DU retains tare state across power cycles and TCP reconnects. Add a mandatory scale check step at wizard start: read `TA` command, surface non-zero tare as a warning. Never silently tare from software.

3. **TCP drop without detection — silent stale readings** — Configure TCP keepalive aggressively (`TCP_KEEPIDLE=5s`, `TCP_KEEPINTVL=2s`, `TCP_KEEPCNT=3`). Include a `last_updated` timestamp in every SSE payload. Disable the Confirm button when status is `stale` or `disconnected`. A dead connection can mimic perfect stability (constant value, no fluctuation).

4. **Floating-point precision in the calculation chain** — Use `Decimal` (not `float`) for ALL scientific calculations in Python. Parse scale response values as strings directly to `Decimal` — never via float intermediate. Return calculated values to frontend as strings, not JSON numbers. Define explicit rounding policy: 4 decimal places for weights, 2 for concentrations. This must be in the first formula written — retrofitting is an audit of all arithmetic.

5. **Unit inconsistency (g vs mg vs µg)** — Scale returns grams. Calculations need milligrams. SENAITE declared weight may be in mg. All weights must be converted to a canonical unit (mg) immediately at the parse boundary. Use explicit unit suffixes in every variable name (`weight_g`, `peptide_mass_mg`, `stock_conc_ug_per_ml`). Validate calculation output magnitude in unit tests (1mg in 1mL = ~1000 µg/mL stock).

See `PITFALLS.md` for full pitfall descriptions including step regression cascade invalidation, SSE reconnect desync, and atomic transaction requirements.

---

## Implications for Roadmap

### Phase 1: DB Models and Calculation Foundation

**Rationale:** Everything depends on the data model and calculation correctness. Building these first means the wizard core is testable without any hardware or network services, and calculation errors (the hardest to detect later) are caught early with unit tests.

**Delivers:** `wizard_sessions` and `wizard_measurements` tables, migration, all wizard REST endpoints (CRUD + manual weight entry), `GET /wizard/sessions/{id}/calculations` using `hplc_processor.py`, unit tests for the full calculation chain with `Decimal` arithmetic.

**Addresses:** Session autosave, session resume, cancel wizard, session record on completion.

**Avoids:** Floating-point precision pitfall (Decimal from first formula), unit inconsistency pitfall (canonical mg at parse boundary), atomic transaction pitfall (single transaction per step confirmation).

**Standard patterns:** Follows existing SQLAlchemy model pattern, existing `init_db` migration pattern, existing `hplc_processor.py` calculation structure. Skip research-phase for this phase.

---

### Phase 2: Scale Bridge Service

**Rationale:** Build and test the scale bridge in complete isolation from the wizard UI. A standalone `asyncio` test script (`test_scale.py`) can validate real hardware connectivity before any frontend is involved. This phase is hardware-dependent — it requires the physical balance to be reachable on the network.

**Delivers:** `backend/scale_bridge.py` (ScaleBridge singleton), FastAPI lifespan registration, `GET /scale/status` endpoint, TCP keepalive configuration, `SI` polling with software stability detection, `TA` tare-check command, error handling for overload/underload/disconnect.

**Avoids:** Silent stale readings pitfall (TCP keepalive + timestamp staleness), stale tare pitfall (TA check on session init), MT-SICS single-client conflict pitfall (connection timeout + graceful fallback), dynamic reading accepted as stable pitfall (stability gating in bridge).

**Blocking hardware unknowns that must be resolved before this phase starts:**
- Confirm Ethernet module is installed on the XSR105DU (optional add-on — check back of balance)
- Get the actual configured TCP port from balance menu (Menu > Communication > Interface > Ethernet > Port)
- Get the static IP address from lab/IT

**Needs research-phase:** Low — MT-SICS protocol is well-documented. But physical hardware access is required before any code can be validated.

---

### Phase 3: SSE Weight Streaming Endpoint

**Rationale:** Connect Phase 1 (DB + session) and Phase 2 (scale bridge) via the SSE weight-streaming endpoint. This is the integration layer. The existing codebase SSE pattern is used exactly — no new technology.

**Delivers:** `GET /wizard/sessions/{id}/steps/{step_key}/weigh/stream` endpoint, all SSE event types (`reading`, `weight`, `stable`, `error`, `timeout`, `manual_entry`), graceful fallback to `manual_entry` when scale bridge is `None` or disconnected.

**Avoids:** SSE reconnect desync pitfall (emit current state as first event on any new connection; include heartbeat every 10s via `ping=10` on `EventSourceResponse`).

**Standard patterns:** Follows the exact same pattern as the 4 existing SSE endpoints in the codebase. Skip research-phase.

---

### Phase 4: Frontend Wizard UI

**Rationale:** Build after the backend API is complete and tested. The wizard UI has many states (step locking, weight display states, scale connection states) that are simpler to implement when the backend contract is fixed.

**Delivers:** `WizardPage` with vertical step sidebar (locked/current/complete states), all 5 wizard steps, `PrepWizardStore` Zustand store, `WeighStep` component with SSE consumer, live weight display with stability indicator, auto-accept countdown, manual fallback input, SENAITE sample lookup UI, inline calculated results.

**Uses:** `EventSource` (native browser API, no library), Zustand (selector pattern per project rules), shadcn/ui primitives (Card, Button, Input, Progress, Collapsible).

**Avoids:** Double-submit race condition (debounce Confirm button + `UNIQUE(session_id, step_key)` DB constraint), step regression without cascade invalidation (warn on back-navigation to a confirmed step with data).

**Differentiators to include (low effort, high value):**
- Step status icons (Lucide CheckCircle2/Circle/Lock)
- Countdown timer with cancel for auto-accept
- Tare reminder card before each weighing substep
- Inline help text per step

**Standard patterns:** Zustand store follows AGENTS.md selector pattern exactly. shadcn/ui components already in codebase. Skip research-phase.

---

### Phase 5: SENAITE Integration

**Rationale:** Placed last because it's the only external service dependency and the hardest to validate without a live SENAITE instance. The wizard is usable with manual sample entry until this phase is complete.

**Delivers:** `GET /wizard/senaite/search?id={sample_id}` endpoint using `SenaiteClient` (httpx + cookie auth), response field mapping to wizard data model, SENAITE unreachable and not-found error states.

**Avoids:** `getClientSampleID` index assumption — verify against actual SENAITE instance before building search UI.

**Blocking unknowns that must be resolved before this phase:**
- Fetch one known sample from the live SENAITE instance with `?complete=yes` and inspect the full JSON to identify: peptide name field, declared weight field, declared weight unit, any other wizard-relevant fields.
- Confirm whether `getClientSampleID` is indexed (determines search UX — system ID vs lab-assigned ID).

**Needs research-phase:** LOW — SENAITE jsonapi is well-documented. The only uncertainty is custom field names, which require inspecting the live instance (not research).

---

### Phase Ordering Rationale

- **Phase 1 first:** No hardware or external service required. Delivers independently testable functionality (manual-entry wizard works end-to-end). Locks in the calculation precision approach before any arithmetic is written elsewhere.
- **Phase 2 second:** Hardware-dependent but isolated. The standalone test script validates hardware independently. Does not block frontend work.
- **Phase 3 third:** Pure integration layer — requires both Phase 1 API and Phase 2 bridge to exist.
- **Phase 4 fourth:** Frontend is easiest to build against a known, tested backend API. All five wizard steps can be built in parallel once the state model and endpoint contract are settled.
- **Phase 5 last:** External dependency (SENAITE instance access required). The wizard already works with manual sample entry, so this phase is an enhancement, not a blocker.

### Research Flags

**Skip research-phase (standard patterns):**
- Phase 1 (DB Models): follows established SQLAlchemy + hplc_processor.py patterns
- Phase 3 (SSE Endpoint): exact same pattern as 4 existing endpoints
- Phase 4 (Frontend UI): Zustand + shadcn/ui, well-documented patterns

**Needs hardware/service access before coding (not research):**
- Phase 2 (Scale Bridge): requires physical balance on network — get IP, port, confirm Ethernet module
- Phase 5 (SENAITE): requires live instance access to inspect custom field names

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | One new package (sse-starlette). All other tools already in codebase and verified working. |
| Features | HIGH | Wizard UX patterns well-documented (NNG, PatternFly). Step behavior specification is detailed and internally consistent. |
| Architecture | HIGH | SSE pattern code-verified in existing codebase (4 endpoints). DB model pattern established. Scale bridge design follows standard asyncio patterns. |
| MT-SICS Protocol | MEDIUM-HIGH | Command set confirmed by multiple independent sources. Response format consistent across all references. Port and hardware presence require physical verification. |
| SENAITE Integration | HIGH (API) / LOW (custom fields) | Official readthedocs documentation for API and auth. Custom field names (peptide, declared weight) are instance-specific — cannot know without inspecting live instance. |
| Pitfalls | HIGH | Floating-point arithmetic: mathematically certain. TCP keepalive behavior: Python stdlib documented. MT-SICS stability codes: confirmed by InstrumentKit source code. |

**Overall confidence:** HIGH for architecture and implementation approach. Key unknowns are hardware facts (IP, port, Ethernet module) and SENAITE custom field names — neither requires research, both require access to the physical lab setup.

### Gaps to Address Before Implementation

1. **Scale hardware access (blocks Phase 2):** Confirm Ethernet module is installed. Get static IP and configured TCP port. If no Ethernet module, the entire TCP approach changes (serial-to-network adapter adds complexity and latency).

2. **SENAITE field inspection (blocks Phase 5):** Fetch a known sample with `?complete=yes`. Log the full JSON. Build field mapping from that output. This takes 10 minutes with instance access.

3. **`getClientSampleID` index status:** Determines whether the "enter sample ID" step uses the SENAITE system ID or the lab's own numbering. Affects UX of Step 1.

4. **Scale TCP port:** Default is 4001 but must be verified on the actual balance (Menu > Communication > Interface > Ethernet > Port). Port mismatch will silently fail to connect.

5. **Scale auto-sleep setting:** Check whether the XSR105DU has auto-shutoff configured. If so, the scale may drop its network stack during idle periods. Disable for lab use or implement aggressive reconnect handling.

---

## Sources

### Primary (HIGH confidence)
- Existing codebase SSE endpoints (`main.py`) — confirmed pattern for `StreamingResponse` + `media_type="text/event-stream"`
- [SENAITE jsonapi ReadTheDocs](https://senaitejsonapi.readthedocs.io/) — search endpoint, cookie auth limitation, `complete=yes` behavior
- [sse-starlette GitHub](https://github.com/sysid/sse-starlette) — `EventSourceResponse` API, `ping` parameter, `X-Accel-Buffering`
- [Python asyncio streams docs](https://docs.python.org/3/library/asyncio-stream.html) — `open_connection`, `readuntil`
- [InstrumentKit MT-SICS source](https://instrumentkit.readthedocs.io/en/latest/_modules/instruments/mettler_toledo/mt_sics.html) — MT-SICS response status codes (actual parsing code)
- [NNG Wizard Guidelines](https://www.nngroup.com/articles/wizards/) — step navigation, locking behavior
- [PatternFly Wizard Design Guidelines](https://www.patternfly.org/components/wizard/design-guidelines/) — sequential locking recommended default

### Secondary (MEDIUM confidence)
- [N3uron Mettler Toledo docs](https://docs.n3uron.com/docs/mettler-toledo-configuration) — MT-SICS S/SI command behavior, stable vs dynamic weight
- [Atlantis-Software mt-sics Node.js library](https://github.com/Atlantis-Software/mt-sics) — TCP port 4001, connection pattern
- MT-SICS Supplement 2024 (geass.com) — response format, command set (PDF binary, cross-referenced)

### Tertiary (LOW confidence — requires live instance validation)
- `getClientSampleID` as a searchable SENAITE field — must verify against actual instance
- Peptide name and declared weight field names in SENAITE — instance-specific custom fields

---

*Research completed: 2026-02-19*
*Ready for roadmap: yes*
