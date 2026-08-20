# Methods — bench stamping (slice 2)

*Designed 2026-08-19 with the Handler. Slice 2 of the methods/instruments
program — builds on slice 1 (`2026-08-19-methods-foundation-design.md`:
generic method fields, `method_services` + defaults, local instruments).
Mk1-only; no wire, IS, WP, SENAITE, or COABuilder changes. The HPLC lane's
existing flow (prep bridge, instrument+peptide derivation) is untouched and
stays authoritative for HPLC.*

## 1. Problem

Slice 1 makes methods and instruments exist; nothing on the bench writes them
onto analysis rows. For a non-HPLC worksheet (the Handler's hm#1 observation):

- The flyout's Method column shows `—` because `method_name` is derived as
  `_resolve_method(instrument_uid, service_group_id)` (`main.py:19370`) — an
  instrument+peptide/group join that native families don't participate in.
- `worksheet_items.instrument_uid` is a **SENAITE UID string**
  (`models.py:975`). A locally created instrument (slice 1) has
  `senaite_uid = NULL` — it is *unrepresentable* on a worksheet item today.
- Native `lims_analyses` rows end up with `method_id`/`instrument_id` NULL, so
  the COA Method column stays blank and there is no run traceability.

## 2. As-is facts (verified 2026-08-19 against the arcitest composition)

- `WorksheetItem` (`models.py:957`) is **vial-granular**: `sample_id` +
  `lims_sub_sample_pk` join, `service_group_id`, `department_id`,
  `instrument_uid`, `prep_status`, `analyses_json`.
- `PATCH /api/lims-analyses/{id}/method-instrument` → `set_method_instrument`
  (`lims_analyses/service.py:600`) stamps + writes an audit transition, and
  currently has **no review-state guard** — it will restamp a verified or
  published row silently.
- The submit-result route (`routes.py:441`) does **not** accept
  `method_id`/`instrument_id`; `create_analysis` (`routes.py:164`) and
  `promote` (`routes.py:544`) do. Promote already carries both to the parent
  row; the COA prints `_method_label(row.method_id)`
  (`coa/native_sections.py:117`).
- HPLC rows get stamped by the prep bridge
  (`lims_analyses/prep_bridge.py:293–332`) — vial-first, existing-value-wins.
  **Untouched by this slice.**
- Slice 1 provides: `method_services` with one active default per service,
  `AnalysisServiceResponse.default_method_id` (fail-open — NULL when the
  default's method is inactive), `instrument_methods` m2m, instruments with
  `department_id`.

## 3. Rulings

- **R0 (program-wide, inherited from slice 1) — zero new SENAITE coupling.**
  The new stamping path reads/writes `worksheet_items.instrument_id` (FK) and
  `lims_analyses.method_id`/`instrument_id` only. `instrument_uid` is frozen
  legacy for the existing HPLC lane — nothing new reads or writes it, and no
  new code touches a SENAITE surface.
- **R5 — explicit acts only, never at seeding.** A placeholder must not claim
  a method nobody chose. Stamping happens on exactly two verbs: the
  worksheet-level apply (§4.2) and result submission (§4.4). No background or
  seed-time stamping.
- **R6 — the bench-shaped verb is worksheet-level.** All items in an HM run go
  on one instrument with one method; "apply to worksheet" with per-row
  override beats per-row clicking. Per-row PATCH remains the override.
- **R7 — reported states are protected.** Restamping a
  `verified`/`published`/`promoted`/`variance_verified` (or dead
  `rejected`/`retracted`) row is an amendment-class action, not a bench
  convenience. `set_method_instrument` gains the state guard (§4.5); the bulk
  verb *skips and reports*, the direct PATCH *409s*.
- **R8 — coverage-scoped stamping.** The bulk verb stamps only analyses whose
  service the chosen method covers (`method_services`). A mixed worksheet
  never gets wrong-method stamps; uncovered analyses are reported, not
  silently stamped or silently skipped.

## 4. Design

### 4.1 Schema — `worksheet_items.instrument_id`

Additive nullable `instrument_id INT FK instruments(id) ON DELETE SET NULL`.
`instrument_uid` stays as the SENAITE-uid leg for the HPLC lane; the two may
coexist on a row (the HPLC flow keeps writing `instrument_uid`, the native
apply writes `instrument_id`). Display resolves `instrument_id` first, then
`instrument_uid`.

### 4.2 Bulk verb — `POST /api/worksheets/{id}/apply-method-instrument`

Body: `{method_id, instrument_id, item_ids?}` (absent `item_ids` = all items).
One transaction:

1. Validate method active; validate instrument active and linked to the method
   via `instrument_methods` (400 otherwise — the picker can't produce this,
   the API still refuses it).
2. For each targeted item with a `lims_sub_sample_pk`: for each of that vial's
   `lims_analyses` rows where `analysis_service_id ∈ method_services(method)`
   AND `review_state ∈ {unassigned, assigned, to_be_verified}`: apply
   `set_method_instrument` semantics (existing-value overwrite is fine here —
   re-applying a run context is the point; each row gets its audit
   transition).
3. Write `item.instrument_id` on every targeted item.
4. Response: `{stamped: n, skipped_state: [{analysis_id, review_state}],
   skipped_uncovered: [{analysis_id, keyword}], items_updated: n}` — the
   caller renders the skip lists; nothing is silent (R8).

### 4.3 Per-row override

The existing `PATCH /{analysis_id}/method-instrument`, surfaced in the FE on
the analysis row (worksheet flyout row menu + the sample-details analyses
card) with the same picker pair. No new endpoint.

### 4.4 Result-entry stamping

`SubmitResultRequest` gains optional `method_id`/`instrument_id` (additive;
absent = today's behavior). When present, applied with
`set_method_instrument` semantics in the same transaction *before* the result
transition, so one submit yields one coherent audit trail. FE: the native
result form shows Method (prefilled from the service's `default_method_id`)
and Instrument (filtered to the chosen method's `instrument_methods`) whenever
the service has at least one linked method; both omitted-able (a lab can
submit without stamping — the fields are defaults, not gates).

### 4.5 State guard on `set_method_instrument`

Refuse with 409 (`{"detail": {code: "state_locked", review_state}}`) when the
row is in `verified`, `published`, `promoted`, `variance_verified`,
`parent_to_verify`, `senaite_mirror`, `rejected`, or `retracted` — i.e. only
`unassigned`/`assigned`/`to_be_verified` rows are stampable. Corrections to
reported rows go through the amendment/retract path, which produces fresh
stampable rows. Plan-time check: enumerate existing callers (prep bridge
writes rows directly, not via this service fn — confirm) so the tightening
breaks no live flow.

### 4.6 Pickers and display

- **Method picker** (worksheet apply + result form + row override): active
  methods linked via `method_services` to the relevant service set — for the
  worksheet verb, the union of services on the targeted items' analyses;
  default(s) listed first and pre-selected when unambiguous (one distinct
  default across the set).
- **Instrument picker**: the chosen method's `instrument_methods`, active
  only; when the worksheet has a `department_id`, same-department instruments
  sort first (filter, not gate).
- **Flyout columns for native lanes**: Method/Instrument read the *stamped*
  values off the item's vial analyses — one distinct value → show it; several
  → `mixed`; none → `—`. `_resolve_method` stays as the HPLC-lane fallback
  when no stamped value exists. Wire this through the existing worksheet
  items payload (`main.py:19360–19378`), additive keys.

### 4.7 Explicit non-goals

No HPLC-lane changes (prep bridge and instrument+peptide derivation stay
authoritative there — a stamped value merely displays if present). No COA or
wire changes (the chain already prints). No lifecycle/versioning (slice 3).
No analyst-assignment changes. No stamping of parent-tier rows directly —
they inherit via promote, as today.

## 5. Failure modes addressed

| Mode | Control |
|---|---|
| Wrong-method stamps on a mixed worksheet | coverage scoping (R8) + `skipped_uncovered` report |
| Silent restamp of reported results | state guard (R7): bulk skips+reports, PATCH 409s |
| Local instrument unrepresentable on items | `worksheet_items.instrument_id` FK (§4.1) |
| Instrument not qualified for method | route-edge validation against `instrument_methods` (§4.2) |
| Seed-time method claims | R5 — explicit acts only |

## 6. Acceptance (arcitest)

1. hm#1 worksheet with the two HM vials: apply `AM-ELEM-001` + the ICP-MS
   instrument → every covered, editable HM analysis on both vials stamped,
   one audit transition each; response reports 0 uncovered.
2. Re-run the apply after one row is verified → that row in `skipped_state`,
   others restamped.
3. Flyout Method/Instrument columns show the stamped pair (not `—`);
   HPLC-lane items unchanged.
4. Submit a result with the prefilled method/instrument → row carries both +
   result in one audit sequence.
5. Direct PATCH on a `verified` row → 409 `state_locked`.
6. Promote a stamped row → parent carries both; COA (armed profile) prints
   the method name — end-to-end with zero new COA code.

## 7. Follow-ups ledgered

- Analyst-run context bundling (analyst + method + instrument as one
  "run header" on the worksheet) — revisit once bench usage is observed.
- Printing method identity on worksheets/bench sheets.
- Slice 3 interaction: once revisions exist, pickers must offer only the
  active revision (slice 1's fail-open default rule already handles the flip
  window).
