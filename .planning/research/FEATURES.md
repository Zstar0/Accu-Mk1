# Feature Landscape: Sample Prep Wizard (v0.11.0)

**Domain:** Guided lab workflow wizard — HPLC sample preparation with scale integration
**Milestone type:** Subsequent (adding to existing lab app)
**Researched:** 2026-02-19

---

## Context

This wizard guides a lab tech through 5 sequential steps to prepare a peptide sample for HPLC injection:

1. Sample lookup (SENAITE by ID)
2. Enter target concentration and total volume
3. Stock prep: weigh empty vial → add peptide → add diluent → weigh again → calculate stock concentration
4. Dilution: weigh new vial → add calculated diluent → weigh → add calculated stock → weigh
5. Review and confirm session record

Scale integration: Mettler Toledo XSR105DU over TCP/IP using MT-SICS protocol. Backend polls the scale for a stable weight reading (`S` command over TCP port 8001, response `S S <value> <unit>\r\n`). Frontend receives the reading via SSE or WebSocket stream.

---

## Table Stakes

Features the wizard must have to be usable. Missing any of these = broken workflow.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Vertical step sidebar (left) + content area (right)** | Standard two-column wizard layout; established pattern (Stripe, PatternFly, Google). Gives tech orientation at a glance. | Low | Step list fixed left, scrollable content right. Steps labeled with action nouns, not numbers alone. |
| **Step completion gating (linear forward)** | Each step depends on prior data. Dilution calculation requires stock concentration from step 3. Tech cannot skip ahead. | Low | "Next" button disabled until step's required data is captured or confirmed. |
| **Completed steps are revisitable via sidebar** | Techs must correct mistakes (e.g., re-read a weight). Forcing re-entry from step 1 is unacceptable. | Low | Clicking a completed step in the sidebar navigates back; data is preserved. Future (unvisited) steps remain locked. |
| **Live weight display with stable indicator** | Lab tech needs to see whether the current reading is stable before accepting it. An unstable reading auto-accepted is a GMP violation. | Medium | Show live numeric value + animated "Stabilizing..." vs "Stable" badge. Only enable "Accept Weight" or auto-accept when scale reports stable (`S S` response, not `S D`). |
| **Auto-accept stable weight** | Tech's hands are occupied placing vials. Requiring a button click while holding a vial causes errors. | Medium | When scale returns stable for N consecutive readings (e.g., 3 in a row), auto-accept. Show 3–5 second countdown so tech can intervene. |
| **Calculated values shown inline (not hidden)** | Lab tech must verify computed values before proceeding. Hiding the formula = no auditability. | Low | Show formula, inputs, and result. E.g., "Stock conc = mass added / volume = 12.34 mg / 1.000 mL = 12.34 mg/mL". |
| **SENAITE sample lookup by ID** | Sample data (peptide name, declared weight) must be pulled from LIMS. Manual entry introduces transcription errors. | Medium | Text input, search button, spinner, display returned sample fields. Show peptide name, batch/lot, declared purity. |
| **Session autosave on every step advance** | Lab workflow is interrupted constantly. Power cycling, shifts, distractions. Losing 20 minutes of weighing data is unacceptable. | Medium | On "Next", persist current step data to DB before advancing. Draft record exists even for incomplete sessions. |
| **Session resume from draft** | If tech navigates away or app crashes, they must be able to resume without re-weighing. | Medium | Load draft by session ID; restore to last completed step; prefill all captured data. |
| **Scale offline/error state** | Scale is physically connected via LAN; network drops happen. Tech must know the scale is unavailable. | Medium | Show "Scale offline" banner with retry option. Allow manual weight entry as fallback. |
| **SENAITE not found / error state** | Sample ID may be wrong, SENAITE may be unreachable. Fail clearly, don't silently pass. | Low | Show specific error: "No sample found for ID X" vs "SENAITE unreachable". |
| **Confirm/accept button for each weighing step** | After auto-accept, tech should still be able to re-read. Provide an "Accept" affordance and a "Re-read" or "Clear" button. | Low | "Accept Weight" + "Re-read" buttons per weighing step. Auto-accept is a convenience, not a lock. |
| **Session record written to DB on completion** | Audit trail. Lab must know every measurement, timestamp, and who performed the prep. | Medium | On wizard completion: write session record with all weights, calcs, timestamps, user ID. |
| **Abandon / cancel wizard** | Tech must be able to exit without completing. Accidentally triggering session creation is wrong. | Low | "Cancel" accessible at any step. Show confirmation dialog. Draft persists; can be resumed or deleted. |

---

## Differentiators

Features that elevate the wizard from functional to delightful. Not expected, but valued — especially in a daily-use lab tool.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Step status icons in sidebar** | Completed steps show a checkmark, current step shows a dot or ring, locked steps are dimmed. Zero ambiguity about progress. | Low | Using Lucide icons: `CheckCircle2` (done), `Circle` (current), `Lock` (locked). Matches existing codebase icon usage. |
| **Step subtitle in sidebar** | Sidebar shows not just step name but a summary of completed data. E.g., "Sample lookup — WB-0042 / Peptide-A" | Low | Reduces need to click back to verify. Collapsed summary is read-only. |
| **Countdown timer before auto-accept** | 3-second countdown gives tech a chance to lift the vial or reject the reading before it's committed. | Low | Progress bar or counter: "Auto-accepting in 3...". Cancel button resets auto-accept. |
| **Weight trend sparkline** | Show the last 5–10 weight readings as a tiny sparkline to visualize drift and settling. Lab techs recognize settling behavior. | Medium | SSE/WebSocket streams readings; frontend buffers last N values, renders mini chart. |
| **Tare reminder** | Before each weighing step that requires a vial, prompt: "Ensure scale is tared / vial is on scale." | Low | Inline instruction card before the weight display activates. |
| **Calculated result with formula toggle** | Show result by default; "Show formula" expander reveals C1V1 = C2V2 derivation or mass/volume calc. For verification by senior staff. | Low | shadcn `Collapsible` component — already in codebase. |
| **Step completion timestamp** | Each completed step in the sidebar shows a timestamp. "Stock prep — completed 09:14 AM". | Low | Stored in session record; displayed in sidebar tooltip or subtitle. |
| **GMP-compliant session record export** | After completion, offer PDF/CSV export of the session record (all inputs, outputs, timestamps, user). | High | Defer to v2 — high effort, but flag as a likely compliance requirement. |
| **Keyboard navigation** | Tab to navigate between fields; Enter to advance when step is complete. Essential for tech who uses keyboard more than mouse while wearing gloves. | Medium | Aligns with PatternFly and WCAG guidance on wizard keyboard support. |
| **Inline help text per step** | Short instruction below the step heading: what to do, what the system will capture. First-time tech orientation. | Low | shadcn `Label` with muted text. No modal required — inline is less disruptive. |
| **Weight units display** | Show unit as returned by scale (e.g., `g`). Don't hardcode. XSR105DU returns unit in the response string. | Low | Parse from SICS response: `S S   0.0123 g`. Display alongside value. |
| **Re-read with reason** | If tech clicks "Re-read" after accepting, optionally prompt for a brief reason (e.g., "Sample spilled"). Logged in session record. | Low | Simple optional text field. Defaults blank. Useful for GMP audit trail. |

---

## Anti-Features

Features to explicitly NOT build in v0.11.0. Scope control.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Non-linear step jumping (full free navigation)** | This wizard has hard data dependencies: dilution calc requires stock conc, which requires weighing step 3. Allowing free-jump creates invalid states. | Lock future steps. Allow back-navigation to completed steps only. |
| **Editable completed step data without invalidation** | If tech goes back and changes a weight that feeds into a calculation, downstream results become stale without recalculation. Complex to handle correctly. | When navigating back and editing, flag downstream steps as "needs reconfirmation" — but do NOT try to auto-recalculate silently. Force tech to re-advance through affected steps. Implement in v2 if needed. |
| **Multiple simultaneous sessions** | One tech, one balance, one prep at a time. Managing concurrent sessions adds session selection UI, conflict resolution, and auth complexity. | One active session per user at a time. Draft is singular. |
| **Auto-calculate dilution on the fly as tech types** | Target concentration and volume change as tech types; live recalculation is visually noisy and confusing mid-entry. | Calculate once, on step advance (when tech confirms inputs). Show formula and result. |
| **Scale calibration or tare commands from the app** | The XSR105DU is a precision analytical balance. Calibration is SOP-controlled and should not be triggered from software. Tare is done manually by the tech at the instrument. | The app reads only. Send `S` or `SI` commands only. Do not send tare (`T`) or calibration commands. |
| **Barcode scanner integration** | Useful, but adds hardware dependency and driver complexity. Not all workstations have scanners. | Manual text input with SENAITE search for v1. Barcode support deferred. |
| **Email/notification on session completion** | No email infrastructure exists in this app. SENAITE integration pattern is pull, not push. | Write session to DB. Tech manually continues to HPLC injection. |
| **Undo history within a step** | React form state handles undo for text fields. Weight readings are discrete accepted values, not a typed stream. Undo across steps is dangerous in a lab context. | Re-read button is the "undo" for weight steps. Back navigation is the "undo" for form steps. Explicit, not implicit. |
| **Tutorial / onboarding overlay on first use** | Wizard itself is already guided. Overlay-on-top adds cognitive load and is often dismissed without reading. | Use inline instruction text on each step. No overlay. |
| **Offline mode (no SENAITE, no scale)** | Without scale, you cannot do sample prep. Without SENAITE, you have no sample data. Full offline mode is not a valid lab scenario. | Handle transient outages gracefully (retry, manual fallback), but do not build a fully offline mode. |
| **Results entry / purity calculation in this wizard** | The project description includes "results entry after HPLC run" as a target feature, but that is a different workflow that happens after injection. Mixing it into this wizard conflates two distinct lab activities. | Results entry is a separate post-run workflow. This wizard ends at "session ready for injection." |

---

## Step-by-Step Behavior Specification

### Step Locking / Unlocking Logic

```
LOCKED   = step not yet reachable (greyed, not clickable in sidebar)
CURRENT  = active step (highlighted in sidebar, content shown)
COMPLETE = step done (checkmark, clickable in sidebar to go back)

Rules:
- Step N+1 is LOCKED until Step N is COMPLETE
- COMPLETE steps become clickable (back navigation)
- Going back to a COMPLETE step does NOT lock steps after it
  UNLESS the tech modifies data in that step (flag downstream as "needs reconfirm")
- v0.11.0: If tech modifies a past step, require they re-advance through affected steps
  (simple invalidation — no silent recalc)
```

### Step-Type Classification

| Step | Type | Unlock Condition |
|------|------|-----------------|
| 1. Sample Lookup | User action + confirm | SENAITE returns valid sample; tech clicks "Use this sample" |
| 2. Target Parameters | Form entry + confirm | Both target concentration and total volume entered (non-zero); tech clicks "Next" |
| 3. Stock Prep (5 weighings) | Instrument reading x5 | All 5 weight readings accepted; stock concentration calculated; tech clicks "Confirm Stock Prep" |
| 4. Dilution (3 weighings) | Instrument reading x3 | All 3 weight readings accepted; dilution verified; tech clicks "Confirm Dilution" |
| 5. Review & Confirm | Review + confirm | Tech clicks "Complete Session" |

### Weighing Step Sub-flow

Each weighing point within steps 3 and 4 follows this pattern:

```
1. Display instruction: "Place empty vial on scale"
2. Show live weight value (polling from backend SSE/WS)
3. Show stability indicator: "Stabilizing..." → "Stable"
4. Stable for 3 consecutive readings → start auto-accept countdown (3 sec)
5. Tech can: (a) let it auto-accept, or (b) click "Accept Weight" immediately, or (c) click "Re-read" to clear
6. On accept: value locked, instruction advances to next weighing point
7. All weighing points complete → calculations shown → "Confirm" button active
```

### Scale Weight Display States

| State | Visual | Description |
|-------|--------|-------------|
| Connecting | Spinner + "Connecting to scale..." | Initial TCP connection establishing |
| Live / Unstable | Animated value + amber "Stabilizing" badge | `SI` reading coming in, balance in motion |
| Stable | Value + green "Stable" badge + countdown | `S` command returned stable reading |
| Auto-accepted | Locked value + checkmark | Weight committed to session |
| Scale offline | Red banner + "Retry" | TCP connection failed or timed out |
| Manual fallback | Input field + "Enter manually" | Tech overrides with keyboard entry |

### Session Persistence Model

```
States:
  draft     = in-progress wizard, incomplete
  complete  = all steps done, session record written

On each "Next":
  → persist current step data to DB (upsert by session_id)
  → advance to next step
  → update current_step pointer

On navigate away / close:
  → draft persists silently (no confirmation needed)
  → "Resume" banner shown on wizard entry if draft exists

On "Cancel":
  → confirmation dialog: "Discard this session?"
  → Yes: delete draft, return to app
  → No: stay in wizard

On "Complete Session":
  → write final record (status = complete, all measurements, calcs, user_id, timestamps)
  → show success state
  → return to app
```

---

## Error State Coverage

| Scenario | Expected Behavior |
|----------|------------------|
| SENAITE unreachable | Show "Cannot connect to SENAITE" with retry button. Do not block — allow tech to enter sample data manually as fallback. |
| SENAITE returns no match for ID | Show "No sample found for ID [X]". Tech can correct ID and retry. |
| SENAITE returns multiple matches | Show disambiguation list with client, date, status. Tech selects correct sample. |
| Scale offline at wizard start | Show "Scale offline" banner. Auto-retry every 10 seconds. Manual entry fallback available. |
| Scale disconnects mid-step | Show inline error in the weight display area: "Scale disconnected — retrying..." Auto-retry. Current accepted weights are preserved. |
| Scale returns unstable reading indefinitely | After 60 seconds without stable, show advisory: "Scale not stabilizing. Check for vibration or overload. Enter weight manually if needed." |
| Weight outlier (>20% deviation from tare) | Flag as advisory, not hard block. Show: "Weight change larger than expected. Verify sample is correct." Tech must acknowledge before proceeding. |
| Weight negative after tare | Show error: "Negative weight reading. Check vial is on scale and scale is tared." Block accept. |
| Session DB write failure | Show error, allow retry. Do not lose the captured data — hold in frontend state until write succeeds. |
| Navigating away with unsaved data | Browser/app close: autosave fires. Explicit navigation within the app: silent autosave, no confirmation popup (draft is preserved). |

---

## Feature Dependencies

```
Step 1 (Sample Lookup)
  └── SENAITE JSON API integration (backend)
  └── Sample ID input + search UI

Step 2 (Target Parameters)
  └── Numeric inputs: target concentration (mg/mL), total volume (mL)

Step 3 (Stock Prep)
  └── Scale TCP polling (backend → SSE/WS → frontend)
  └── Weight acceptance UI (live display + accept/re-read)
  └── Calculation: stock_concentration = mass_peptide / volume_diluent_added
  └── "mass_peptide" = (vial+peptide weight) - (empty vial weight)
  └── "volume_diluent_added" = (vial+peptide+diluent weight) - (vial+peptide weight)
        [uses density of diluent — typically 1.000 g/mL for water-based]

Step 4 (Dilution)
  └── Calculation from Step 2 + Step 3:
        required_stock_volume = (C_target × V_total) / C_stock   [C1V1 = C2V2]
        required_diluent_volume = V_total - required_stock_volume
  └── Scale reading for 3 weighing points
  └── Verification: actual added vs calculated

Step 5 (Review)
  └── Read-only summary of all steps
  └── DB write on confirm
```

---

## MVP Recommendation for v0.11.0

### Must-Build (Table Stakes — Wizard is broken without these)

1. Vertical step sidebar with 3 states: locked, current, complete
2. Linear step gating — "Next" disabled until step complete
3. Back navigation to completed steps (sidebar click)
4. SENAITE sample lookup by ID (backend endpoint, frontend search UI)
5. Scale live weight display with stable/unstable indicator
6. Auto-accept stable weight with countdown (3 sec)
7. "Accept Weight" and "Re-read" buttons per weighing point
8. Inline calculated results (formula + result)
9. Autosave on each step advance (draft persistence)
10. Session resume from draft
11. Scale offline state + manual entry fallback
12. SENAITE not-found / unreachable error states
13. Session record written to DB on completion
14. Cancel wizard with confirmation

### Build if Time Allows (Differentiators for v0.11.0)

1. Step status icons in sidebar (checkmark / dot / lock)
2. Step subtitle showing captured data summary
3. Countdown timer with cancel for auto-accept
4. Tare reminder card before each weighing substep
5. "Show formula" collapsible on calculated results
6. Weight unit display from SICS response string
7. Inline help text per step (what to do, what happens next)
8. Keyboard navigation (Tab / Enter flow)

### Defer to v0.12.0 or Later

- Weight trend sparkline (requires buffered SSE stream UI)
- Step completion timestamps in sidebar
- GMP session record PDF/CSV export
- Re-read with reason logging
- Barcode scanner integration
- Results entry / purity calculation post-run (separate workflow)
- Editable completed step data with downstream invalidation
- Weight outlier advisory (nice-to-have safety net)

---

## Confidence Assessment

| Area | Confidence | Source |
|------|------------|--------|
| Wizard step navigation patterns | HIGH | NNG, PatternFly design guidelines, Eleken (verified against multiple authoritative sources) |
| Stripe-style vertical step navigator behavior | HIGH | Stripe OnboardingView component docs (official) — 4 states: not-started, in-progress, blocked, complete; left sidebar + right content |
| Scale MT-SICS protocol basics | MEDIUM | N3uron docs (confirmed S/SI commands and stable response concept); PDFs unreadable but multiple sources confirm TCP port 8001 and SICS command structure |
| Scale UX waiting / stable indicator pattern | MEDIUM | WebSearch + NNG status visibility heuristic; no single authoritative lab-instrument-web-UI source; derived from established UX principles |
| SENAITE JSON API search | HIGH | Official ReadTheDocs — search by ID with catalog param confirmed; `&complete=True` for full fields; Basic Auth |
| Session persistence / draft state | HIGH | AppMaster article on save-and-resume wizards; corroborated by react-admin, Zustand persist middleware patterns |
| Step locking logic | HIGH | PatternFly design guidelines (official) + NNG article — sequential locking is the recommended default |
| HPLC dilution calculation (C1V1 = C2V2) | HIGH | Standard chemistry; confirmed in multiple chromatography forum and calculator sources |
| Anti-feature reasoning | MEDIUM | Derived from wizard UX principles + domain knowledge of GMP/lab constraints; no single authoritative source for lab-specific anti-features |

---

## Sources

### Wizard UX

- [Wizards: Definition and Design Recommendations — NNG](https://www.nngroup.com/articles/wizards/)
- [PatternFly Wizard Design Guidelines](https://www.patternfly.org/components/wizard/design-guidelines/)
- [Wizard UI Pattern: When to Use It — Eleken](https://www.eleken.co/blog-posts/wizard-ui-pattern-explained)
- [Wizard Design Pattern — UX Planet (Nick Babich)](https://uxplanet.org/wizard-design-pattern-8c86e14f2a38)
- [Save-and-resume multi-step wizard patterns — AppMaster](https://appmaster.io/blog/save-and-resume-multi-step-wizard)

### Stripe Wizard Reference

- [OnboardingView component — Stripe Apps SDK](https://docs.stripe.com/stripe-apps/components/onboardingview?app-sdk-version=9)
- [Stripe Apps Patterns](https://docs.stripe.com/stripe-apps/patterns)

### Scale Integration

- [MT-SICS Reference Manual (Excellence Balances) — Mettler Toledo](https://www.mt.com/dam/product_organizations/laboratory_weighing/WEIGHING_SOLUTIONS/PRODUCTS/MT-SICS/MANUALS/en/Excellence-SICS-BA-en-11780711D.pdf)
- [Mettler Toledo Client Configuration — N3uron](https://docs.n3uron.com/docs/mettler-toledo-configuration)
- [mt-sics Node.js library — Atlantis-Software (GitHub)](https://github.com/Atlantis-Software/mt-sics)

### SENAITE

- [SENAITE JSON API — ReadTheDocs](https://senaitejsonapi.readthedocs.io/en/latest/api.html)

### React + shadcn Stepper

- [Stepperize — shadcn template](https://www.shadcn.io/template/damianricobelli-stepperize)
- [React Hook Form Multi-Step — Zustand + Zod + shadcn](https://www.buildwithmatija.com/blog/master-multi-step-forms-build-a-dynamic-react-form-in-6-simple-steps)

### Multi-Step Form Patterns

- [8 Best Multi-Step Form Examples 2025 — Webstacks](https://www.webstacks.com/blog/multi-step-form)
- [Baymard: Back Button UX Expectations](https://baymard.com/blog/back-button-expectations)
