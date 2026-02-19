# Domain Pitfalls: Lab Scale Integration + Guided Sample Prep Wizard

**Domain:** Hardware-coupled wizard flow for laboratory sample preparation
**Researched:** 2026-02-19
**Context:** Accu-Mk1 v0.11.0 — Mettler Toledo XSR105DU (MT-SICS over TCP), 5-step weighing wizard, FastAPI SSE backend, SQLite session persistence
**Milestone:** Adding scale integration + guided prep wizard to existing FastAPI + React (Tauri) app

---

## Critical Pitfalls

Mistakes that cause incorrect measurements, corrupted session data, or rewrites.

---

### Pitfall 1: Accepting "S D" (Dynamic) Weight as a Confirmed Reading

**What goes wrong:** The backend polls the scale with the `S` command. When the scale is not stable, it returns a response with the `D` stability indicator (dynamic/unstable weight). Code that ignores this indicator captures a live-fluctuating value and treats it as a confirmed weight. The tech confirms a number that is still changing.

**How MT-SICS stability works:**
- `S` command — requests current weight; the scale **waits** for stability before responding. If it times out waiting, some models return a `D` response rather than blocking indefinitely.
- `SI` command — returns the current weight **irrespective of stability** (always returns immediately, stability field will be `S` or `D`).
- Response format: `S <status> <value> <unit>` where status is one of:
  - `S` — stable weight value
  - `D` — dynamic (unstable) weight value
  - `I` — internal balance error (not ready)
  - `+` — overload (weighing range exceeded)
  - `-` — underload (pan not in place or below minimum)

**Why it happens:**
- Developer uses `SI` for responsiveness (no blocking wait), but doesn't gate confirmation on `status == 'S'`
- Response parser splits on whitespace and takes the number field directly, skipping the stability character
- SSE stream sends every polled value to the frontend; UI shows "current reading" and the tech clicks confirm on a mid-swing value

**Consequences:**
- Captured weight is wrong (could be off by 5–50 mg depending on timing)
- Stock concentration calculation is wrong (`stock_conc = declared_weight_mg * 1000 / diluent_mL`)
- Error propagates silently through all downstream dilution calculations
- Session record contains incorrect data with no indication it was captured during instability

**Prevention:**
1. **Gate confirmation on stability status, not just value presence.** The backend must parse the stability field from every MT-SICS response and only expose a "confirmable" reading when `status === 'S'`.
2. **Use `S` (not `SI`) for the final capture call** after the SSE stream shows stability for N consecutive polls. The blocking `S` command gives the scale an opportunity to self-stabilize.
3. **Stream stability state to frontend.** SSE payload should include a `stable: boolean` field. The "Confirm Weight" button must be disabled when `stable === false`.
4. **Add stability dwell time.** Require the reading to be stable for at least 2–3 consecutive polls (at a poll interval of 500ms or similar) before enabling confirmation. This prevents transient stable-then-unstable oscillation.

**Warning signs:**
- Confirm button enabled the moment any value appears on screen
- Backend sends raw `SI` response to frontend without parsing stability field
- Weight value jumps around after tech confirms and a second poll fires

**Which phase:** Phase 1 (Scale Integration Foundation) — stability gating must be part of the initial scale service design, not retrofitted.

---

### Pitfall 2: Scale Has Tare Accumulated from Previous Session

**What goes wrong:** The Mettler Toledo XSR105DU retains its tare state across power cycles and TCP reconnections. If a previous operator left a container on the pan (or the app crashed mid-session with a tare applied), the scale's internal tare is non-zero when the new session starts. The app connects, polls the scale, and receives a net weight relative to an unknown tare — not the true gross weight.

**MT-SICS tare behavior:**
- `T` command — tares the scale (waits for stability, then sets tare to current stable weight). Returns `T S <tare_value> <unit>` on success, `T I` if balance not ready.
- `TI` command — immediate tare (doesn't wait for stability).
- `TA` command — queries or sets the current tare value directly.
- Tare persists in balance memory. It is not cleared by TCP disconnect or application restart.

**Why it happens:**
- App assumes scale always shows gross weight at session start
- No startup check of current tare state
- Wizards begin collecting weights without zeroing first
- Operator runs two sessions back-to-back without physically clearing the pan

**Consequences:**
- Container weight is misattributed (what looks like "0.00 g net" is actually tare minus previous container)
- Peptide mass calculation uses a wrong baseline
- The error is invisible — readings appear plausible, just offset

**Prevention:**
1. **Check tare state at session start with `TA` command.** If tare is non-zero, surface a warning to the tech: "Scale has an existing tare of X g. Clear it before proceeding?"
2. **Design a mandatory "scale check" step at wizard start.** Show current scale state (net weight, tare value, stability). Require the tech to confirm the pan is empty and tare is zeroed, or actively apply a fresh tare.
3. **Never silently tare the scale from software** unless the wizard explicitly asks the tech to place only the container on the pan at that specific step.
4. **Use `Z` (zero) on session init if tare is zero and gross weight is also near-zero.** This re-zeroes the scale from a clean state.

**Warning signs:**
- Wizard skips directly from "connect to scale" to "place container, confirm tare" without reading current tare state
- Scale reads a non-trivial value before anything is placed on it

**Which phase:** Phase 1 (Scale Integration Foundation) — tare state check must be part of the session initialization sequence.

---

### Pitfall 3: TCP Connection Drop Without Detection — Silent Stale Readings

**What goes wrong:** The TCP socket to the scale drops (scale sleep, network blip, cable, switch reboot) but the FastAPI polling loop does not detect the disconnection. The SSE stream continues sending the last cached reading to the frontend. The tech sees a number that looks live but is stale. They confirm a weight that was captured minutes ago.

**TCP socket behavior in Python:**
- `socket.recv()` blocks on a dropped connection without necessarily raising an exception immediately. The OS-level TCP keepalive may take minutes (default 2 hours on Linux) to detect the dead connection.
- A socket write to a dead connection may succeed initially (data goes into OS buffer) and only fail on the second write.
- `SO_KEEPALIVE` with aggressive settings is needed to detect drops within seconds.

**Why it happens:**
- Simple `asyncio` TCP connection without keepalive configuration
- Error caught at socket level but polling loop continues with last known value
- No "last updated" timestamp surfaced to the frontend
- Scale enters sleep/idle mode (some Mettler Toledo models have configurable auto-shutoff)

**Consequences:**
- Tech confirms a weight that is seconds or minutes old, not current
- If scale was moved or bumped between reads, the stale value is from before the disturbance
- No indication to the tech that the connection is down

**Prevention:**
1. **Configure TCP keepalive with aggressive parameters:**
   ```python
   import socket
   sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
   sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 5)    # Start after 5s idle
   sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 2)   # Probe every 2s
   sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)     # 3 probes then drop
   ```
2. **Track last successful read timestamp.** SSE payload must include `last_updated: ISO8601`. If `now - last_updated > threshold` (e.g., 3 seconds), set `status: 'stale'` in the SSE payload.
3. **Disable the Confirm button when status is `'stale'` or `'disconnected'`.** The UI must visually distinguish between "live reading", "stale reading", and "no connection."
4. **Implement reconnect loop in the polling service.** On any socket error, close the socket, wait N seconds, and attempt reconnection. SSE stream continues but broadcasts `{ status: 'reconnecting' }` until restored.
5. **Check whether the XSR105DU has an auto-sleep setting.** If the lab leaves it idle, the scale may power down its network stack. Configure the balance to disable auto-shutoff for lab-network-connected use.

**Warning signs:**
- SSE stream shows a constant value that never fluctuates (dead connection mimics perfect stability)
- No "connection lost" UI state in the wizard
- Poll timestamp not included in SSE events

**Which phase:** Phase 1 (Scale Integration Foundation) — connection health monitoring is part of the core polling service, not optional.

---

### Pitfall 4: MT-SICS Single-Client TCP Limitation — Connection Conflict

**What goes wrong:** Many Mettler Toledo balance Ethernet interfaces accept only one concurrent TCP client connection. If a previous connection was not cleanly closed (app crash, process restart, network failure), the balance may be in a state where it believes a client is still connected and refuses new connections, returning ECONNREFUSED or simply hanging the connection attempt.

**Why it happens:**
- App crashes or is force-killed without closing the TCP socket
- Debugging session leaves a dangling connection open
- OS TCP_TIME_WAIT delays effective port release

**Consequences:**
- New app startup cannot connect to the scale
- Lab tech cannot use the wizard until the scale is power-cycled or the stale connection times out
- Debugging is difficult because the port appears open at the network level

**Prevention:**
1. **Implement a connection timeout on connect attempts** (5–10 seconds). If connect hangs, fail cleanly rather than blocking the startup flow.
2. **Track scale connection state in SQLite.** On startup, check if a previous session left a "connected" flag and warn the user before attempting reconnect.
3. **Set `SO_REUSEADDR` on the client socket** to avoid address binding issues on restart.
4. **Log the existing connection** in lab documentation: if scale won't connect, power cycle the balance (30 seconds off) to clear stale TCP state.
5. **Backend should attempt connect once on wizard start**, not at app boot. Don't hold an idle TCP connection if no wizard session is active.

**Warning signs:**
- Scale connection works on first launch but fails after app restart
- Balance's network indicator light shows active connection when app is not running
- Connection timeout errors only on second launch attempt

**Which phase:** Phase 1 (Scale Integration Foundation).

---

### Pitfall 5: Floating-Point Precision Errors in Weight Difference Calculations

**What goes wrong:** Weight differences are calculated in Python/JavaScript using IEEE 754 double-precision floating point. For values like `4213.58 - 2783.16`, the result is not exactly `1430.42` in binary floating point. The error (typically at the 13th–15th decimal digit) is harmless for display but dangerous when chained through multiple calculations.

**Concrete example:**
```python
>>> 4213.58 - 2783.16
1430.4199999999998  # Not 1430.42
```

In the calculation chain for this app:
- `container_tare = vial_empty - vial_before_peptide` (weight difference)
- `peptide_mass_mg = vial_after_peptide - vial_before_peptide` (weight difference)
- `stock_conc_ug_ml = peptide_mass_mg * 1000 / total_diluent_mL`

Each operation can accumulate error. When `stock_conc` feeds into `diluent_to_add` and `stock_to_add`, the final volumes may be off by a non-trivial amount at µL scale.

**Why it happens:**
- Decimal fractions like 0.58 cannot be represented exactly in binary floating point
- Python's `float` is IEEE 754 double (same as JavaScript's `number`)
- The scale returns 4 decimal places (e.g., `0.0001 g` resolution for XSR105DU) — these values are particularly prone to binary representation errors

**Consequences:**
- Displayed concentration values that differ from what would be calculated by hand
- Round-trip storage of floats in SQLite and retrieval may subtly change values
- Dilution volumes that are systematically wrong at the µL level

**Prevention:**
1. **Use Python's `decimal.Decimal` for all scientific calculations in the backend.** Set precision to match instrument resolution + safety margin:
   ```python
   from decimal import Decimal, ROUND_HALF_UP, getcontext
   getcontext().prec = 28  # More than enough for 4-decimal-place weights

   peptide_mass = Decimal('4213.58') - Decimal('2783.16')  # Exact: 1430.42
   stock_conc = peptide_mass * Decimal('1000') / Decimal(str(total_diluent_ml))
   ```
2. **Parse scale response values as strings first, then convert to Decimal.** Do not parse them as float intermediately:
   ```python
   # WRONG - float intermediate loses precision
   weight = float(response_parts[2])

   # CORRECT - string to Decimal directly
   weight = Decimal(response_parts[2])
   ```
3. **Return calculated values to the frontend as strings, not JSON numbers.** JSON numbers are parsed as JavaScript floats. Use `str(result)` to serialize.
4. **Store weights in SQLite as TEXT (the string representation) or REAL with explicit rounding.** Do not chain calculations through REAL columns and re-read.
5. **Define explicit rounding policy:** final displayed values rounded to 4 significant decimal places for weights, 2 for concentrations. Apply rounding only at display/output, not in intermediate calculations.

**Warning signs:**
- `peptide_mass_mg * 1000 / total_diluent_mL` returns values like `498.9999999999999` instead of `499.0`
- Unit tests for calculations fail at `==` comparison for exact values
- Different results when calculation is performed in Python vs JavaScript

**Which phase:** Phase 1 (Scale Integration Foundation) — the calculation module must use `Decimal` from the first line of code. Retrofitting later requires auditing all arithmetic.

---

### Pitfall 6: Unit Inconsistency in the Calculation Chain

**What goes wrong:** The calculation chain mixes units without explicit conversion, and the mixing is invisible because all values are just Python floats. The scale returns values in **grams** (g), but calculations need **milligrams** (mg). Diluent volume may be entered in **mL** but dilution ratios need consistent units. A conversion factor applied in the wrong place (or forgotten) silently corrupts all concentration values.

**The specific chain for this app:**

| Variable | Source Unit | Needed Unit | Conversion |
|----------|-------------|-------------|------------|
| Scale reading (peptide mass) | g | mg | ×1000 |
| Declared weight (from SENAITE) | mg | mg | none |
| Total diluent volume | mL (user-entered) | mL | none |
| Stock concentration | µg/mL | µg/mL | mg×1000/mL = µg/mL |
| Target concentration | µg/mL (user-entered) | µg/mL | none |
| Diluent to add | mL | mL | none |
| Stock to add | mL | mL | none |

**Formula audit:**
```
stock_conc (µg/mL) = peptide_mass_mg * 1000 / total_diluent_mL
  -- requires peptide_mass in mg. If scale returns g, must multiply by 1000 first.
  -- The inner ×1000 converts mg → µg (not g → mg). Both conversions must happen.

diluent_to_add (mL) = total_volume_mL * (1 - target_conc_ug_ml / stock_conc_ug_ml)
stock_to_add (mL) = total_volume_mL * target_conc_ug_ml / stock_conc_ug_ml
```

If `peptide_mass` is in **g** (not mg) and the ×1000 is interpreted as g→mg rather than mg→µg:
- Result is 1000× too high for concentration (g treated as mg)
- Or if only the mg→µg ×1000 is applied: result is 1000× too low (g→µg without g→mg conversion)

**Why it happens:**
- Scale response is in g; formula comment says "mg"; developer misreads which ×1000 is which
- Unit context is implicit in variable names only, not enforced
- No unit tests verify the numeric magnitude of the calculation output

**Consequences:**
- Stock concentration off by factor of 1000
- All dilution volumes wrong
- No error is raised — the calculation runs fine, just with wrong numbers

**Prevention:**
1. **Use explicit unit suffixes in all variable names:**
   ```python
   weight_g = Decimal(scale_response)      # Raw scale value in grams
   peptide_mass_mg = weight_g * 1000       # Explicit g → mg conversion
   stock_conc_ug_per_ml = peptide_mass_mg * 1000 / total_diluent_ml  # mg → µg
   ```
2. **Write unit-annotated docstrings for every calculation function:**
   ```python
   def calculate_stock_concentration(peptide_mass_mg: Decimal, total_diluent_ml: Decimal) -> Decimal:
       """Returns stock concentration in µg/mL. Input must be mg and mL."""
   ```
3. **Write numeric range validation tests.** For a 1 mg peptide in 1 mL, stock conc should be ~1000 µg/mL. If the result is ~1.0 or ~1,000,000, the unit chain is wrong.
4. **Consider using a unit-aware library (like `pint`) for internal calculations**, especially if more calculation types are added.

**Warning signs:**
- Stock concentration results that are implausibly low (<1 µg/mL) or implausibly high (>100,000 µg/mL) for typical peptide samples
- A variable named `peptide_mass` without a unit suffix
- The same ×1000 factor applied twice in the same formula

**Which phase:** Phase 1 (Calculation Module) — define unit convention and enforce it in the first formula written.

---

## Moderate Pitfalls

Mistakes that cause incorrect state, confusing UX, or data integrity issues.

---

### Pitfall 7: Wizard Step Regression Invalidates Downstream Steps — No Cascade

**What goes wrong:** A tech completes steps 1–4, then navigates back to step 2 and changes a weight. Steps 3 and 4 were calculated using the old weight value. The database now has step 3 and 4 results that are inconsistent with the new step 2 value. No recalculation or invalidation occurs.

**Specific scenario:**
- Step 2: Weigh vial + peptide → 4213.58 g confirmed
- Step 4 calculates stock concentration from step 2 value → stored in DB
- Tech goes back to step 2, re-weighs → now 4198.21 g
- Step 4 still shows old concentration

**Why it happens:**
- Wizard stores each step as a DB record on confirm; update to prior step doesn't cascade
- Frontend allows backward navigation without triggering recalculation
- "Completed" steps are treated as immutable once confirmed

**Consequences:**
- Session record contains internal contradictions
- Tech submits for HPLC run with wrong stock concentration
- Audit trail shows no indication that step 2 was re-done after step 4

**Prevention:**
1. **Define a step dependency graph explicitly.** Step N is valid only if all steps it depends on are confirmed AND their values have not changed since.
   ```
   Step 1 (container tare) → Step 2 (peptide + container)
   Step 2 → Step 3 (diluent volume) → Step 4 (stock concentration)
   Step 4 → Step 5 (dilution volumes)
   ```
2. **On step regression with a value change, invalidate all downstream steps.** The DB update for step 2 should mark steps 3, 4, 5 as `status: 'invalidated'`. The UI should show these steps as needing re-confirmation.
3. **Distinguish "going back to review" from "going back to change."** Navigation back without a value change does not invalidate downstream steps. Only a change to a confirmed value triggers cascade invalidation.
4. **Show an explicit warning when navigating back to a confirmed step:** "If you change this reading, steps 3, 4, and 5 will need to be re-confirmed."
5. **The session record must log the full history of changes**, not just the final values. If step 2 was confirmed at 4213.58 g, then changed to 4198.21 g, both values and timestamps should be in the audit log.

**Warning signs:**
- Wizard allows backward navigation without any "are you sure?" prompt
- Step confirmation stores a single row per step (no history)
- Session review page shows only latest values, not change history

**Which phase:** Phase 2 (Wizard Flow) — invalidation logic must be part of the state model, not added after UX is built.

---

### Pitfall 8: SSE Stream Desync After Reconnection — Frontend Shows Stale State

**What goes wrong:** The SSE connection from the frontend to the FastAPI `/events/scale` endpoint drops (network blip, tab sleep, browser power save). The browser automatically reconnects SSE. However, the backend has been buffering new readings and the reconnect may replay old events or, more commonly, deliver only new events — leaving the frontend in an inconsistent state where it missed the transition from "unstable" to "stable."

**SSE reconnect behavior:**
- Browser sends `Last-Event-ID` header on reconnect
- If the backend does not implement `Last-Event-ID` replay, the frontend misses all events during the outage
- If the backend has no ID scheme, every reconnect starts fresh — frontend doesn't know what it missed

**Consequences:**
- Frontend shows "awaiting stable reading" when the scale has already stabilized (missed the event)
- Or: frontend shows "stable" from a pre-disconnect reading when the scale is now in motion
- Confirm button state is wrong

**Prevention:**
1. **Always emit the current scale state as the first SSE event on any new connection.** Backend connects → immediately sends `{ weight: current, stable: bool, status: string }` — client is always bootstrapped.
2. **Do not rely on event replay for state reconstruction.** Scale readings are time-sensitive; replaying old events does not help. Instead, ensure the backend re-broadcasts state on reconnect.
3. **Implement a client-side SSE reconnect handler** that shows "reconnecting..." state until the first new event arrives:
   ```typescript
   eventSource.onerror = () => {
     setScaleStatus('reconnecting')
   }
   eventSource.onmessage = (e) => {
     setScaleStatus('connected')
     // ... handle event
   }
   ```
4. **Add a heartbeat event every 2–3 seconds** so the frontend can distinguish "no readings" (scale quiet, no change) from "connection lost" (no events at all).

**Warning signs:**
- No heartbeat events in SSE stream
- Frontend scale display does not show a reconnecting state
- SSE event handler only handles `onmessage`, not `onerror`

**Which phase:** Phase 2 (Wizard Flow) — SSE stream design must include reconnect handling from the start.

---

### Pitfall 9: Scale Overload/Underload Not Handled in Wizard UI

**What goes wrong:** MT-SICS returns `+` (overload) or `-` (underload) as the status field instead of a weight value. Backend parses this as a number, gets NaN or zero, and streams it to the frontend. UI shows "0.00 g" or crashes the SSE parser. Tech is confused. The wizard does not know why it cannot get a stable reading.

**MT-SICS overload/underload codes:**
- `S + <value> <unit>` — overload: weight exceeds max capacity (XSR105DU capacity is 120g)
- `S - <value> <unit>` — underload: pan missing or below minimum detectable weight
- `S I <value> <unit>` — internal error: balance not ready (warming up, calibrating)
- `S EL <value> <unit>` — logical error: command cannot execute in current state

**Why it happens:**
- Response parser assumes `status == 'S' or status == 'D'` and tries to parse a numeric value from the weight field
- `+` and `-` are not numeric; parsing fails silently
- No distinction made between "no weight" and "error condition"

**Consequences:**
- UI shows misleading "0.00 g" when the scale is actually overloaded
- Tech doesn't know to remove weight or check the pan
- Wizard is stuck with no actionable error message

**Prevention:**
1. **Parse all five MT-SICS status codes explicitly:**
   ```python
   MT_SICS_STATUS = {
       'S': 'stable',
       'D': 'dynamic',
       '+': 'overload',
       '-': 'underload',
       'I': 'not_ready',
       'L': 'logical_error',
   }
   ```
2. **SSE payload must include the parsed status string, not just the weight value.** Frontend renders different UI for each status.
3. **Show user-facing error messages for each condition:**
   - Overload: "Weight exceeds scale capacity (120g max). Remove some material."
   - Underload: "Pan may be missing or weight below minimum. Check the balance pan."
   - Not ready: "Balance is warming up or calibrating. Please wait."
4. **Block the Confirm button for all non-`stable` statuses**, not just `dynamic`.

**Warning signs:**
- SSE payload only has `weight` and `stable` fields (missing `status`)
- Backend sends NaN to frontend when scale returns `+` or `-`
- No error message variation in the UI for different scale states

**Which phase:** Phase 1 (Scale Integration Foundation) — status parsing belongs in the MT-SICS response parser, day one.

---

### Pitfall 10: SQLite Session Persistence Without Atomic Step Commits

**What goes wrong:** A wizard step requires the tech to confirm a weight AND trigger a recalculation. The backend:
1. Saves the weight to the `wizard_steps` table
2. Calculates stock concentration
3. Updates the `session_calculations` table

If the process crashes between steps 2 and 3, the session has a confirmed weight but no calculation record. On resume, the wizard doesn't know if the calculation was done and may skip it, show stale values, or error out.

**Why it happens:**
- Multi-step DB writes without a wrapping transaction
- Session resume logic reads step status but doesn't verify calculation consistency
- "Step completed" flag set before all effects of that step are committed

**Consequences:**
- Resumed session is in an inconsistent state
- Tech may not notice that a calculation is missing
- Audit trail shows a confirmed step without the resulting calculation

**Prevention:**
1. **Wrap every step confirmation in a single SQLite transaction:**
   ```python
   with db.begin():
       db.execute("INSERT INTO wizard_steps ...")   # Save weight
       db.execute("UPDATE session_calculations ...") # Save result
       db.execute("UPDATE wizard_sessions SET current_step = ?", [next_step])
   ```
   All three writes succeed or none do.
2. **Session resume must validate consistency, not just step status.** A step is truly "complete" only if both the input value and the dependent output are present and consistent.
3. **Define a session integrity check function** that runs at wizard resume and reports any incomplete state with a clear recovery path.

**Warning signs:**
- Step confirmation triggers multiple separate `db.execute()` calls outside a transaction
- Session resume reads only `current_step` without validating downstream calculation records

**Which phase:** Phase 2 (Session Persistence) — transaction discipline is a first-commit requirement.

---

## Minor Pitfalls

Mistakes that cause annoyance but are fixable.

---

### Pitfall 11: MT-SICS Response Parsing — Line Ending Sensitivity

**What goes wrong:** MT-SICS responses are terminated with `<CR><LF>` (`\r\n`). Python `socket.recv()` or `asyncio.StreamReader.readline()` may return lines with `\r` included if the reader splits only on `\n`. Parsing `"S S 1234.5678 g\r"` splits correctly only if the trailing `\r` is stripped. If not stripped, the unit field becomes `"g\r"` which fails unit comparisons.

**Prevention:**
- Always call `.strip()` or `.rstrip('\r\n')` on each MT-SICS response line before parsing.
- Use `asyncio.StreamReader.readuntil(b'\r\n')` for reliable frame detection; then decode and strip both.

**Which phase:** Phase 1 (Scale Integration Foundation).

---

### Pitfall 12: Scale Time Drift Between Polls — Wizard Thinks Scale Is Unresponsive

**What goes wrong:** The `S` (stable weight, blocking) command can take several seconds if the scale is in motion. If the backend poll interval is shorter than the blocking time, commands queue up. The queue grows unboundedly, responses arrive out of order, and the backend may report stale readings as current.

**Prevention:**
- Use a request-response pattern: send `S`, wait for response, then wait the poll interval, then send the next `S`. Never send a new command until the previous response is received.
- Set a command timeout (e.g., 8 seconds) and abort the command if no response arrives. Treat timeout as a `D` (unstable) reading.
- Use `SI` for the live display stream (fast, non-blocking), and switch to `S` only for the final confirmed capture.

**Which phase:** Phase 1 (Scale Integration Foundation).

---

### Pitfall 13: Declared Weight from SENAITE Is in Different Units Than Scale Output

**What goes wrong:** SENAITE stores declared peptide weight in mg (per spec). The scale outputs in g. The validation step ("does measured weight match declared weight?") compares the two values directly without conversion — comparing mg to g — resulting in a 1000× discrepancy that always fails or always passes depending on direction.

**Prevention:**
- Normalize all weights to a single canonical unit (mg) at the boundary of the system:
  - Scale response → convert g to mg immediately upon parse
  - SENAITE declared weight → already in mg, no conversion
- All internal calculations operate in mg. Convert to g only for display if needed.

**Which phase:** Phase 1 (Scale Integration Foundation) — establish the canonical unit at the system boundary.

---

### Pitfall 14: Confirm Button Double-Submit Race Condition

**What goes wrong:** The tech clicks "Confirm Weight" while the SSE stream delivers a new reading 50ms later. Two confirmation requests hit the backend simultaneously. The backend commits two rows to `wizard_steps` for the same step, or commits one and then overwrites it with a slightly different value from the second request.

**Prevention:**
- Debounce the Confirm button (disable for 500ms after first click).
- Backend must enforce a unique constraint: `(session_id, step_number)` in `wizard_steps`. Second insert for same step returns a conflict error; frontend surfaces this gracefully.
- Or: use optimistic locking — include a `step_version` in the confirm request; backend rejects if version doesn't match current.

**Which phase:** Phase 2 (Wizard Flow).

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| **Scale Service (initial)** | Accepting `D` (dynamic) readings as confirmed | Parse stability field; gate Confirm on `stable === true` |
| **Scale Service (initial)** | Stale tare from previous session | Read `TA` command at session start; surface tare state to tech |
| **Scale Service (initial)** | TCP drop without detection | Aggressive keepalive + timestamp-based staleness detection |
| **Scale Service (initial)** | Overload/underload shows as "0.00 g" | Parse all 5+ MT-SICS status codes; map to user-facing messages |
| **Scale Service (initial)** | `g` vs `mg` unit confusion at parse boundary | Convert to canonical mg immediately on parse |
| **Calculation Module** | Float arithmetic in Python/JS accumulates error | Use `Decimal` from first formula; parse scale strings directly to `Decimal` |
| **Calculation Module** | Unit inconsistency (g vs mg vs µg) in formula chain | Explicit unit suffixes in variable names; validate output magnitude in tests |
| **Wizard Flow** | Step regression invalidates downstream without cascade | Dependency graph + cascade invalidation on value change |
| **Wizard Flow** | SSE reconnect leaves frontend in stale state | Re-broadcast current state on any new SSE connection |
| **Wizard Flow** | Confirm button double-submit | Debounce + `UNIQUE(session_id, step_number)` in DB |
| **Session Persistence** | Crash between weight save and calculation save | Single transaction per step confirmation |
| **Session Persistence** | Session resume sees inconsistent state | Consistency check function at resume time |

---

## Confidence Assessment

| Area | Confidence | Source |
|------|------------|--------|
| MT-SICS response codes (S/D/+/-/I/L/ES/ET/EL) | HIGH | InstrumentKit Python library source code; multiple official MT-SICS reference manuals (indirect via search); N3uron integration docs |
| MT-SICS tare state persistence | MEDIUM | Documented in MT-SICS protocol behavior; inferred from tare command set (T, TI, TA) and balance memory design |
| TCP keepalive behavior on Python sockets | HIGH | Python socket documentation; Linux kernel TCP behavior; well-documented pattern |
| MT-SICS single-client TCP limitation | MEDIUM | Reported in integration forum discussions; inferred from Mettler Toledo "server or server+client" mode documentation; not explicitly stated for XSR105DU |
| IEEE 754 float precision in weight subtraction | HIGH | Multiple authoritative sources including Oracle IEEE 754 documentation, Python decimal module docs |
| SSE reconnect behavior and bootstrap pattern | HIGH | SSE specification; multiple authoritative articles; Tauri SSE plugin docs |
| Wizard step regression invalidation pattern | MEDIUM | General state machine patterns; no specific hardware-wizard literature found |
| SQLite transaction isolation for wizard steps | HIGH | SQLite documentation; standard ACID pattern |

---

## Sources

### MT-SICS Protocol
- [MT-SICS Response Status Codes — InstrumentKit Python Library Source](https://instrumentkit.readthedocs.io/en/latest/_modules/instruments/mettler_toledo/mt_sics.html) (HIGH confidence — actual parsing code)
- [MT-SICS Spider Error Codes (ES/ET/EL) — ManualsLib](https://www.manualslib.com/manual/1443956/Mettler-Toledo-Spider.html?page=58)
- [Mettler Toledo N3uron Integration Docs — Stable vs Immediate Weight](https://docs.n3uron.com/docs/mettler-toledo-configuration)
- [MT-SICS Supplement Reference Manual — geass.com (2024)](https://www.geass.com/wp-content/uploads/2024/12/MT-SICS.pdf)
- [node-mt-sics Library — Atlantis-Software on GitHub](https://github.com/Atlantis-Software/mt-sics)
- [OmniServer MT-SICS Starter Protocol — Software Toolbox](https://softwaretoolbox.com/omniserver/metter-toledo-mt-sics-opc-ua-driver)

### TCP/Socket Engineering
- [node-net-reconnect npm — Reconnecting TCP Socket Library](https://www.npmjs.com/package/node-net-reconnect)
- [Node.js TCP Socket Reconnect Pattern — GitHub Gist](https://gist.github.com/branneman/0a77af5d10b93084e4f2)
- [NI Community: Communication Issue with Mettler Toledo Analytical Balance](https://forums.ni.com/t5/LabVIEW/Communication-Issue-between-Driver-and-Analytical-Balance/td-p/2497172)

### Floating Point Precision
- [What Every Computer Scientist Should Know About Floating-Point Arithmetic — Oracle](https://docs.oracle.com/cd/E19957-01/806-3568/ncg_goldberg.html)
- [Catastrophic Cancellation — Wikipedia](https://en.wikipedia.org/wiki/Catastrophic_cancellation)
- [Decimal.js — arbitrary-precision Decimal for JavaScript](https://mikemcl.github.io/decimal.js/)
- [Handling Floating Point Precision in JavaScript — Java Code Geeks (2024)](https://www.javacodegeeks.com/2024/11/handling-floating-point-precision-in-javascript.html)
- [Precision Decimal Math in JavaScript — Atomic Object](https://spin.atomicobject.com/javascript-math-precision-decimals/)

### SSE Reliability
- [The Hidden Risks of SSE — Medium](https://medium.com/@2957607810/the-hidden-risks-of-sse-server-sent-events-what-developers-often-overlook-14221a4b3bfe)
- [SSE Reconnect in React — OneUptime (2026)](https://oneuptime.com/blog/post/2026-01-15-server-sent-events-sse-react/view)

### Wizard State Management
- [Solving the Wizard Problem — Chris Zempel](https://chriszempel.com/posts/thewizardproblem/)
- [A Composable Pattern for Pure State Machines — Andy Matuschak (GitHub Gist)](https://gist.github.com/andymatuschak/d5f0a8730ad601bcccae97e8398e25b2)
