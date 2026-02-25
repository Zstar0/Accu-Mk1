# Research Summary — Accu-Mk1 v0.12.0

**Project:** Accu-Mk1
**Milestone:** v0.12.0 — "Analysis Results & Workflow Actions"
**Domain:** LIMS desktop app — inline result editing and SENAITE workflow transitions in SampleDetails
**Researched:** 2026-02-24
**Confidence:** HIGH

---

## Executive Summary

This milestone adds two tightly coupled capabilities to the existing `SampleDetails` view: inline editing of analysis result values for `unassigned` analyses, and workflow transition actions (submit, verify, retract, reject) both per-row and in bulk. Both are "thin wires" through a well-established stack. The backend proxy pattern already exists in `update_senaite_sample_fields`. The frontend editing pattern already exists in `EditableField.tsx`. The SENAITE two-step write (set Result then fire transition) already works in the integration-service adapter. There are no new libraries, no new infrastructure, and no architectural invention required. This is an implementation task, not a design task.

The single most important prerequisite is a one-field data model gap: `SenaiteAnalysis` is missing `uid` on both the backend Pydantic model and the frontend TypeScript interface. Without `uid`, no per-analysis API call is possible. The fix is trivial — the field is already returned by SENAITE and already present in the integration-service's `AnalysisResponse`; it just needs to be surfaced through the `lookupSenaiteSample` route. Every other piece of work depends on this being done first. Backend work is also limited to two new FastAPI endpoints in `backend/main.py` that follow the existing httpx proxy pattern exactly.

The primary risks are behavioral, not architectural. SENAITE can return `200 OK` for invalid or silently-skipped transitions, so the backend adapter must verify post-transition `review_state` against expected values rather than trusting HTTP status alone. Bulk operations must process analyses sequentially (not in parallel) to avoid SENAITE workflow race conditions on the parent sample. `SampleDetails.tsx` is already 1400+ lines and all new editing and workflow logic must be extracted into `AnalysisTable`, `useAnalysisEditing`, and `useWorkflowActions` before adding any new state — this extraction is the one structural decision that cannot be undone cheaply.

---

## Key Findings

### Recommended Stack

**No new dependencies are needed.** The full feature set is achievable with the existing installed stack. The existing `DataTable` component (TanStack Table v8.21.3) provides row selection via `RowSelectionState` and per-cell edit state via `tableMeta`. The existing `shadcn/ui` components (`Checkbox`, `Input`, `Button`, `Badge`, `DropdownMenu`, `AlertDialog`) cover all UI needs. `useMutation` from TanStack Query v5 handles optimistic updates with rollback. `sonner` handles toast feedback. The floating bulk toolbar is approximately 15 lines of Tailwind sticky positioning — not a paid component.

**Core technologies already in use:**

- `@tanstack/react-table` v8.21.3 — row selection (`RowSelectionState`), cell editing state (`tableMeta`)
- `@tanstack/react-query` v5 `useMutation` — optimistic updates, rollback, `isPending` state per mutation
- `shadcn/ui` — `Checkbox`, `Input`, `Button`, `DropdownMenu`, `AlertDialog` (all already installed)
- `sonner` v2.0.7 — toast feedback (already used throughout `SampleDetails.tsx`)
- FastAPI + `httpx` — SENAITE proxy (established pattern in `update_senaite_sample_fields`)

**Critical requirement for any new `useReactTable` call:** The component must open with `'use no memo'` directive plus the `// eslint-disable-next-line react-hooks/incompatible-library` comment on `useReactTable`, matching the existing `DataTable` pattern exactly. TanStack Table v8 and the React Compiler are confirmed incompatible (GitHub issues facebook/react#33057 and TanStack/table#6137). Any new component calling `useReactTable` must reproduce this exact pattern.

**No new TypeScript types are needed from new libraries.** Only additions to existing interfaces: `uid: string | null` (and `keyword: string | null`) on `SenaiteAnalysis` in `src/lib/api.ts`, plus two new response types for the new API functions.

See `.planning/research/STACK.md` for full dependency audit and the explicit "what NOT to add" table.

### Expected Features

**Must have (table stakes — 14 features):**

- Click-to-edit result value on `unassigned` rows (only; non-unassigned rows are read-only)
- Save on Enter, Cancel on Escape, disabled save when draft is empty
- Optimistic update with rollback on API error
- Per-row action dropdown showing only state-valid transitions (submit, verify, retract, reject)
- Spinner and disabled controls on the row while a transition is in-flight
- Toast feedback on every action (success and failure)
- Row `review_state` badge update after successful transition
- Sample-level `review_state` badge refresh after transitions (SENAITE may auto-transition the parent)
- Non-editable display for verified, published, and rejected rows
- Checkbox selection column (only on actionable rows; indeterminate header checkbox)
- Floating bulk action toolbar (appears when selection is non-empty; shows count and bulk actions)
- Batch submit via existing `POST /explorer/samples/{id}/results` endpoint
- Progress indicator during batch operations ("Submitting 3/5...")
- Per-item error summary after batch completes (not a single binary success/fail toast)

**Should have (differentiators — build if time allows):**

- Confirmation `AlertDialog` before retract and reject (single confirm per batch, not per item)
- "Submit All With Results" single-click button above the table
- Per-row status badge transition animation (CSS `transition` on badge background-color)
- "Pending entry" highlight for `unassigned` rows with no result yet
- Keyboard Tab navigation between consecutive editable result cells

**Defer to later milestone:**

- Save-result-only without auto-submit (requires new backend endpoint and UX rethink; FEATURES.md recommends deferring)
- Inline justification on retract (needs SENAITE Remarks endpoint; not confirmed working without additional research)
- Bulk verify with permission detection (SENAITE permissions system not researched for this milestone)
- Result diff indicator for retested analyses (depends on SENAITE exposing prior value; unconfirmed)

**Anti-features (explicitly out of scope):**

- Editable result cells for verified, published, or rejected analyses (SENAITE enforces at API level; UI affordance would always fail)
- Required justification text on submit and verify (adds friction to the primary happy path)
- Editable method, instrument, or analyst fields (managed by lab managers in SENAITE configuration)
- Automated sample publishing as a side effect of result entry (COA generation consequence; must stay explicit)
- WebSocket-based multi-user presence (unnecessary for this lab's team size)
- Undo history for workflow transitions (retract is the explicit LIMS mechanism for this)

See `.planning/research/FEATURES.md` for the full feature dependency graph and backend endpoint requirements.

### Architecture Approach

The milestone is surgical: two new endpoints in `backend/main.py`, two enriched data model fields, and a refactored analyses table section of `SampleDetails.tsx`. Nothing in the Zustand `ui-store.ts`, integration-service, or any component outside `SampleDetails` changes. The architecture follows the established SENAITE proxy pattern (`update_senaite_sample_fields`) for both new endpoints. State after any mutation is resolved by calling the existing `fetchSample()` imperative refresh — which already propagates sample-level SENAITE auto-transitions — rather than by patching local state directly.

**Major components and their responsibilities:**

1. **`backend/main.py` — two new endpoints following the established proxy pattern**
   - `POST /wizard/senaite/analyses/{uid}/result` — sets `Result` value only, no auto-submit
   - `POST /wizard/senaite/analyses/{uid}/transition` — fires a named SENAITE transition (`submit`, `verify`, `retract`, `reject`)
   - Both use JSON body first, form-encoded fallback on 400; same httpx client configuration; same `Depends(get_current_user)` auth

2. **`src/lib/api.ts` — data model additions and two new API functions**
   - Add `uid: string | null` (and `keyword: string | null`) to `SenaiteAnalysis` interface
   - Add `updateAnalysisResult(uid, value)` and `transitionAnalysis(uid, transition)` API functions with standard fetch + Bearer headers pattern

3. **`SampleDetails.tsx` — analyses section refactored, not rewritten**
   - Extract `AnalysisTable` as a standalone component (or at minimum a clearly-scoped sub-component) before adding any editing state
   - `AnalysisRow` gains `uid`, `onMutated` prop, inline edit local state (`editing`, `draft`, `saving`), and transition action buttons
   - `selectedUids: Set<string>` state local to `SampleDetails` (not Zustand) drives bulk toolbar visibility
   - `BulkActionToolbar` renders conditionally; sequential mutation loop with progress counter; single `fetchSample` refresh after all operations complete

**Component boundary rule:** Row selection state is transient, component-scoped, not shared across components — it belongs in `useState` local to `AnalysisTable`, not in `useUIStore`. This is per the project's state management onion (AGENTS.md).

**Suggested build order (each step independently verifiable before proceeding):**

1. Add `uid` to `SenaiteAnalysis` model — backend + frontend — verify in network tab
2. Add two backend endpoints in `main.py` — verify with Swagger UI against live SENAITE before any frontend work
3. Extract `AnalysisTable` component and implement inline result editing in `AnalysisRow`
4. Add per-row transition action buttons with `ALLOWED_TRANSITIONS` state machine constant
5. Add bulk selection, floating toolbar, and sequential processing loop

See `.planning/research/ARCHITECTURE.md` for full component boundaries, data flow diagrams (single edit, single transition, bulk submit), and the complete modified-vs-untouched file inventory.

### Critical Pitfalls

1. **SENAITE returns `200 OK` for silently-skipped transitions** — check `review_state` in the SENAITE response body against `EXPECTED_POST_STATES` constants after every transition POST; never treat HTTP 200 alone as transition success. This is a confirmed community-reported behavior, not a hypothetical.

2. **Partial write on failure leaves SENAITE ahead of the UI** — when a mutation fails after SENAITE has already persisted the result value, an optimistic rollback hides the stored data. Prevention: after any failed mutation, invalidate and refetch rather than only rolling back; do not assume "mutation failed" equals "SENAITE state unchanged."

3. **Parallel bulk writes cause SENAITE workflow race conditions** — SENAITE's parent-sample auto-transitions can produce inconsistent state if multiple analysis transitions arrive concurrently. Always use sequential `await` in the bulk loop: `for (const uid of selectedUids) { await transitionAnalysis(uid, transition) }`. Never use `Promise.all`.

4. **`SampleDetails.tsx` component bloat** — the component is already 1400+ lines. Extract `AnalysisTable` as a standalone component and create `useAnalysisEditing` and `useWorkflowActions` custom hooks *before* adding any new state. If `SampleDetails.tsx` grows past approximately 200 additional lines after this milestone, the extraction was insufficient. This is the one structural decision that cannot be undone cheaply.

5. **Double-save from `onBlur` and `onKeyDown Enter` both firing** — implement a single `commitEdit()` function guarded by a `savePending` ref. Both event handlers call `commitEdit()`; the ref prevents the second call from firing a duplicate mutation to SENAITE, which could trigger a second `submit` transition that fails with a state mismatch.

See `.planning/research/PITFALLS.md` for the full list of 13 pitfalls including concurrent optimistic update race conditions (Pitfall 3), stale UI when SENAITE web UI is used concurrently (Pitfall 5), bulk partial failure binary handling (Pitfall 6), and slow SENAITE response management (Pitfall 10).

---

## Implications for Roadmap

Based on combined research, a 3-phase structure is recommended. Each phase is independently deliverable and verifiable against the live SENAITE instance before the next phase begins.

### Phase 1: Data Foundation + Inline Result Editing

**Rationale:** The `uid` field is the prerequisite for every other piece of work. The two backend endpoints must be live-tested against SENAITE before any frontend work begins — catching SENAITE behavior surprises at this stage is far cheaper than mid-frontend-build. Component extraction (AnalysisTable, useAnalysisEditing) must happen before adding new state; this is the structural decision that defines the ceiling for all subsequent phases.

**Delivers:**
- `uid` (and `keyword`) added to `SenaiteAnalysis` everywhere (backend Pydantic model + frontend interface + lookup route mapping)
- `POST /wizard/senaite/analyses/{uid}/result` endpoint — verified via Swagger UI against live SENAITE
- `POST /wizard/senaite/analyses/{uid}/transition` endpoint — verified via Swagger UI; `EXPECTED_POST_STATES` validation in adapter
- `AnalysisTable` extracted as a standalone component; `useAnalysisEditing` hook created
- Click-to-edit result cells on `unassigned` rows with Enter/Escape, optimistic update, rollback, empty-draft guard
- Toast feedback on save success/failure; row refresh via `fetchSample` after confirmed mutation

**Addresses:** Table stakes features 1–4, 6–7, 9 from FEATURES.md

**Avoids:** Pitfall 1 (SENAITE 200 OK silent failure — EXPECTED_POST_STATES), Pitfall 2 (partial write detection via invalidate+refetch on error), Pitfall 4 (component bloat extraction done first), Pitfall 5 (double-save commitEdit guard), Pitfall 7 (keyboard event handling), Pitfall 12 (draft state not bound to server cache)

**Research flag:** No additional research needed. All patterns established and verified against actual codebase files. Standard implementation work.

---

### Phase 2: Per-Row Workflow Transitions

**Rationale:** With backend endpoints working and inline editing proven, per-row transition actions are straightforward additions to `AnalysisRow`. This phase delivers the core workflow capability and must establish the SENAITE state machine model (`ALLOWED_TRANSITIONS` constant) that drives button visibility. The confirmation dialog for destructive actions belongs here — not retrofitted later.

**Delivers:**
- `ALLOWED_TRANSITIONS` constant mapping `review_state` to valid transition names
- Per-row action `DropdownMenu` showing only valid transitions for the current state
- Submit action additionally requires non-empty result (disabled with tooltip otherwise)
- Per-row `isPending` loading state; all row controls disabled while mutation is in-flight
- Sample-level `review_state` badge refresh after any transition via `fetchSample`
- Confirmation `AlertDialog` for retract and reject (single confirm per action, not per bulk item)
- `EXPECTED_POST_STATES` adapter validation active for all four transition names

**Addresses:** Table stakes features 5, 8; differentiator item 1 (confirmation dialog)

**Avoids:** Pitfall 2 (SENAITE silent failure — state machine guards prevent impossible transition attempts), Pitfall 8 (invalid-state buttons — `ALLOWED_TRANSITIONS` drives visibility), Pitfall 10 (slow SENAITE / double-submit — per-row `isPending` disables controls), Pitfall 13 (retract Remarks requirement — verify against live instance before implementing)

**Research flag:** Before implementing the retract/reject `AlertDialog`, manually call the transition endpoint with `{"transition": "retract"}` against the live SENAITE instance using the Swagger UI. Confirm whether SENAITE requires a `Remarks` field or rejects the transition without one. This is a 30-minute live-instance verification step, not a research task. If Remarks is required, add a `<Textarea>` to the confirmation dialog before writing the UI component.

---

### Phase 3: Bulk Selection and Floating Toolbar

**Rationale:** Bulk operations are an additive layer over the per-row mechanics from Phases 1 and 2. They reuse the same `transitionAnalysis` API function; the new work is selection state management, toolbar rendering, sequential processing loop, and per-item error reporting. This phase delivers the primary daily-workflow efficiency gain — "enter all results, submit all at once."

**Delivers:**
- Checkbox selection column on actionable rows (indeterminate header checkbox via `useRef`)
- `selectedUids: Set<string>` state local to `SampleDetails` (useState, not Zustand)
- Floating sticky bulk action toolbar (conditional on non-empty selection; shows count, bulk buttons, clear)
- "Submit selected" — sequential `for...await` loop with per-item progress counter ("Submitting 3/5...")
- Per-item outcome display after batch completion: "N submitted, M failed" with expandable row-level errors
- Single `fetchSample` refresh after all batch operations complete (not one per mutation)
- "Submit All With Results" convenience button above the table (filters for unassigned+non-null result)
- "Pending entry" highlight for `unassigned` rows with no result yet

**Addresses:** Table stakes features 10–14; differentiators 2, 4

**Avoids:** Pitfall 3 (parallel writes race condition — sequential for...await), Pitfall 6 (bulk partial failure binary handling — per-item outcomes, selective rollback), Pitfall 9 (per-item confirmation dialogs — batch confirm pattern, one dialog for N destructive items)

**Research flag:** No additional research needed. The sequential bulk mutation pattern and per-item error reporting are well-documented patterns already established in the FEATURES.md dependency graph. Standard implementation work.

---

### Phase Ordering Rationale

- Phase 1 is non-negotiable first: `uid` is the prerequisite for everything, the component extraction is the structural foundation, and the backend endpoints must be live-tested before frontend work builds on their contract.
- Phase 2 before Phase 3: Per-row transitions must be solid before bulk operations wrap them. SENAITE behavior edge cases (silent failure, state machine guards) are far easier to isolate with a single row than with 8 rows in a sequential batch.
- Phase 3 last: The bulk toolbar is additive UI over Phase 1 and 2 mechanics. The milestone delivers value incrementally — Phase 1 enables result entry, Phase 2 enables workflow control, Phase 3 delivers efficiency at scale.

### Research Flags

| Phase | Research Needed | What to Verify |
|-------|----------------|----------------|
| Phase 1 | None — standard patterns | Confirm `uid` appears in `/wizard/senaite/lookup` response after model change |
| Phase 2 | 30 min live-instance verification | Test retract transition with no Remarks field against actual SENAITE; confirm whether Remarks is required |
| Phase 3 | None — standard patterns | N/A |

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All claims verified by reading installed package versions and existing source files. No new libraries needed — confirmed by cross-checking TanStack Table v8 feature list against all requirements. `'use no memo'` requirement confirmed via GitHub issues and existing DataTable code. |
| Features | HIGH | Table stakes list grounded in existing `EditableField.tsx` pattern and SENAITE workflow docs. SENAITE state machine confirmed via `senaite.py` implementation. One LOW-confidence item (retract requiring Remarks) is explicitly flagged as needing live-instance verification, not research. |
| Architecture | HIGH | All architectural claims verified against actual codebase files with specific line numbers. Every component exists, every pattern is already used. No assumptions made without citing code. |
| Pitfalls | HIGH (mostly) | SENAITE silent failure: MEDIUM (community report, not first-party docs — but behavior is consistent with "will only take place if suitable status" docs). All TanStack Query pitfalls: HIGH (tkdodo authoritative blog + official docs). Component bloat / keyboard handling: HIGH (established React patterns, multiple sources). |

**Overall confidence:** HIGH

### Gaps to Address

- **Retract/reject `Remarks` requirement (LOW confidence):** Before implementing the `AlertDialog` in Phase 2, manually test the retract transition against the live SENAITE instance via Swagger UI. If SENAITE rejects the transition without a Remarks value (or returns 200 with unchanged state), add a `<Textarea>` to the confirmation dialog before writing the UI. This is a 30-minute access task, not a research task.

- **`to_be_verified` result editability:** ARCHITECTURE.md notes that SENAITE may accept result updates on `to_be_verified` analyses in retesting scenarios, but this is unconfirmed. For Phase 1, only `unassigned` rows are editable. If a use case arises for `to_be_verified` editing, verify against the live instance and unlock it separately in a follow-on task.

- **Bulk verify permission scoping:** Not researched for this milestone. Bulk verify is explicitly deferred. If it becomes a near-term requirement, a separate spike into SENAITE's permissions API is needed before building any UI for it.

- **`keyword` field requirement for batch submit:** STACK.md recommends adding both `uid` and `keyword` to `SenaiteAnalysis`. The existing `POST /explorer/samples/{id}/results` batch endpoint takes `keyword` values (not UIDs) for routing. Confirm before Phase 3 which endpoint will be used for "Submit All With Results." If the new `POST /wizard/senaite/analyses/{uid}/transition` endpoint is used (per-UID, sequential), `keyword` is not needed. If the existing batch endpoint is reused, `keyword` must be added to the frontend type and lookup route.

---

## Sources

### Primary (HIGH confidence — verified against codebase)

- `backend/main.py` lines 5005, 5304, 5760–5837 — `SenaiteAnalysis` model, lookup endpoint, `update_senaite_sample_fields` proxy pattern
- `src/lib/api.ts` line 2016 — `SenaiteAnalysis` frontend interface (uid/keyword gap confirmed by reading file)
- `src/components/dashboard/EditableField.tsx` lines 70–107 — optimistic update + rollback pattern
- `src/components/senaite/SampleDetails.tsx` line 1167 — `fetchSample` imperative refresh pattern (`onAdded`)
- `integration-service/app/adapters/senaite.py` lines 901–997 — SENAITE two-step submit pattern
- `integration-service/app/api/desktop.py` lines 1084–1090 — submit state guard; `AnalysisResponse` schema
- `src/components/ui/data-table.tsx` line 42 — `'use no memo'` directive + React Compiler incompatibility comment

### Primary (HIGH confidence — official docs)

- TanStack Table v8 Row Selection guide — tanstack.com/table/v8/docs/guide/row-selection
- TanStack Table v8 Editable Data example — tanstack.com/table/latest/docs/framework/react/examples/editable-data
- TanStack Query v5 Optimistic Updates — tanstack.com/query/v5/docs/framework/react/guides/optimistic-updates
- SENAITE JSON API CRUD — senaitejsonapi.readthedocs.io/en/latest/crud.html
- React Compiler / TanStack Table incompatibility — github.com/facebook/react/issues/33057, github.com/TanStack/table/issues/6137

### Secondary (MEDIUM confidence)

- SENAITE community silent-failure report — community.senaite.org (200 OK without state change behavior; unresolved thread)
- Concurrent optimistic update race condition pattern — tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query
- TanStack Query GitHub discussion #7932 — real-world race condition report
- Bulk action UX patterns — eleken.co, patternfly.org/patterns/bulk-selection/ (floating toolbar, indeterminate checkbox)

### Tertiary (LOW confidence — requires live-instance verification)

- Retract transition `Remarks` field requirement — bikalims.org manual (specific to SENAITE configuration; not verified against the lab's instance)
- `to_be_verified` result editability in retesting scenario — inferred from SENAITE worksheet model; not confirmed

---

*Research completed: 2026-02-24*
*Ready for roadmap: yes*
