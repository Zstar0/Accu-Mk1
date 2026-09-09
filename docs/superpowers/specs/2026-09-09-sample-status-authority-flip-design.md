# Sample-status authority flip — Accu-Mk1 owns sample-tier status; SENAITE follows

*Companion to `2026-07-26-side-by-side-workflow-engine-design.md` (the engine this
spec flips to authority) and `2026-07-12-workflow-state-system-design.md` (the
catalog it treats as the source of truth). Ruling: Handler, 2026-09-09 — "accumk1
should own the status changes now that we are running in accumk1 mode."*

## 1. Goal

Make the workflow catalog + native engine the **writer** of a sample's status in
Accu-Mk1, so the status the lab sees (the badge, the samples list, the receive
inbox, the Order Status columns, the SLA clock) is what Mk1 decided — never a
mirror of what SENAITE happened to accept. SENAITE keeps receiving every
transition, best-effort, with read-back and scheduled retry, until it is retired.

Add the one verb the lab cannot originate today and needs at any point in the
process: **cancel**, behind a confirm.

Close the three gaps that stop the catalog from being the *only* source of
truth for sample status: the code-derived vocabulary guard, the hardcoded
frontend label/color maps, and the fact that the cancel edges only exist for
two states.

### Why now (PB-0462, 2026-09-09)

PB-0462 showed "To Verify" with every analysis verified and a published COA.
Three facts, each verified in prod:

1. SENAITE never auto-verified the AR. Its `check_all_verified` compares the
   count of live analyses to the count carrying the `IVerified` marker; a
   retracted/rejected analysis keeps the marker, so any sample with a Replace
   or remove in its history never matches. SENAITE's own docstring says the
   sample "needs to be transitioned manually".
2. Mk1's publish teed `publish` to SENAITE, which returned HTTP 200 and
   silently refused (AR not verified). The route accepts `to_be_verified` as a
   terminal state for the partial-publish flow, so nothing warned.
3. The badge reads `lims_samples.status`, which mirrors SENAITE. Mk1's own
   engine (`native_status`) was either right or stranded — and nothing read it.

The fleet had 25 samples in that shape; 20 were healed SENAITE-side and 49
converged natively the same night. Residual divergence: 19 of 2,147 armed
samples over 90 days, in four classes (§9).

## 2. Key design facts (verified 2026-09-09)

- **Engine.** `workflow/engine.py::execute_verb(db, sample, verb, *, trigger,
  actor_user_id)` finds the edge from `sample.native_status` in
  `lims_workflow_transitions`, evaluates the edge's `requirements` entries
  (vocabulary in code: `all_analyses_in_state`, `field_present`,
  `coa_published`, `distinct_actor`), writes `sample.native_status = to_slug`,
  and records one `LimsWorkflowShadowEvaluation` row per attempt
  (`advanced` / `no_edge` / `requirements_unmet`). `evaluate_cascades` fires
  `auto_fire` edges until none applies; cascade refusals are not recorded.
  `drive_sample_touchpoint(db, sample_id, verb, *, from_status, ...)` is the
  chokepoint every touchpoint calls (registration arm, receive, the verify
  cascade, publish). Flush-only; callers commit.
- **Catalog.** States and transitions live in `lims_workflow_states` /
  `lims_workflow_transitions` (`entity_scope='sample'`); the Settings → Workflow
  pane (admin-only) creates, edits and deletes both, including requirements.
  `workflow/seeds.py::seed_workflow_catalog` inserts only missing rows, so
  admin edits survive boot. Seeded sample states: sample_registered,
  sample_due, sample_received, ready_for_initial_review,
  waiting_for_addon_results, to_be_verified, verified, published, dispatched,
  cancelled, invalid. Seeded cancel edges: sample_due → cancelled,
  sample_received → cancelled only.
- **The badge column.** `lims_samples.status` is read by
  `sub_samples/registry_details.py` (badge), `registry_list.py` (samples
  list), `registry_inbox.py` (`status == 'sample_received'`), `main.py`
  status filters (~22965), `workflow/catalog.py` counts. It is written by
  `sub_samples/service.py::_refresh_parent_from_senaite` (`row.status =
  meta['review_state']`), `workflow/sample_log.py::heal_sample_status`
  (whitelist-guarded), and `workflow/is_event_stream.py` (`sample.status =
  new_status`, same whitelist). `native_status` is read only by the
  divergence/debug surfaces.
- **Vocabulary guard.** `SAMPLE_REVIEW_STATE_WHITELIST` is built from the
  `SEED_STATES` constant plus `{"rejected", "stored"}` — code, not the live
  catalog.
- **Frontend labels.** `senaite-utils.tsx`, `explorer/helpers.tsx`,
  `OrderStatusPage.tsx`, `AnalysisTable.tsx` map slug → label/color in code.
  `GET /api/workflow/graph` already serves each state's `label`, `category`,
  `sort_order`.
- **Switch pattern.** `registry_read_source` is a Settings row holding a JSON
  object keyed by surface (`sample_details`, `coa_generation`, …); readers
  default to `senaite` when the key is absent; the admin UI flips keys.
- **Scheduler.** `flags.scheduler.Scheduler.register(name, interval=…, fn)`
  in the lifespan runs in-process periodic jobs (recurring_mint, slack_digest,
  attachment_gc, flag_watch_poller).
- **SENAITE tees today.** Analysis-tier verify → `senaite_writeback.
  writeback_parent_verify` (per line, JSON API transition). Publish →
  `publish_sample_coa` posts `update/{uid} {"transition":"publish"}` and
  re-reads the AR. Receive → the receive-page flip already writes SENAITE
  first. There is no cancel tee. SENAITE returns 200 for refused transitions;
  only a read-back tells the truth. The JSON API's `transitions` list is empty
  even when a transition is allowed — do not use it as a guard.
- **`lims_workflow_sync_state`** is a cursor table (`name`,
  `cursor_created_at`), not a queue.
- **Analysis tier.** `lims_analyses/state_machine.py` has no `cancel` verb.
  Vial/parent rows reach terminal states via reject/retract/promote/verify.

## 3. Data model (additive only)

### 3.1 Authority switch — `registry_read_source.sample_status`

New key in the existing `registry_read_source` JSON: `"sample_status":
"senaite" | "mk1"`. Absent → `senaite` (today's behavior, byte-identical).
Helper `workflow/authority.py::sample_status_authority(db) -> str`, cached per
request like `coa_generation_source`. The admin surface that lists read-source
keys gains the row; flipping it is a data change with no deploy.

### 3.2 `lims_senaite_tee_retries` — the retry queue

| column | type | notes |
|---|---|---|
| `id` | serial PK | |
| `lims_sample_pk` | FK → lims_samples | |
| `verb` | text | `verify` / `publish` / `cancel` / `receive` |
| `expected_state` | text | SENAITE `review_state` that proves success |
| `attempts` | int | default 0 |
| `next_attempt_at` | timestamptz | backoff schedule |
| `last_error` | text | last read-back mismatch or HTTP error |
| `status` | text | `pending` / `done` / `gave_up` / `senaite_only` |
| `created_at`, `updated_at` | timestamptz | |

Unique on (`lims_sample_pk`, `verb`) while `status='pending'` (partial unique
index). Vocabulary lives in code, not CHECKs (last-boot-wins class, per the
07-26 spec).

### 3.3 Catalog seed additions (data, editable afterwards)

Sample-scope transitions `cancel` → `cancelled` from every seeded state except
`cancelled` itself: sample_registered, sample_due, sample_received,
ready_for_initial_review, waiting_for_addon_results, to_be_verified, verified,
published, dispatched, invalid. `auto_fire=False`, `requirements=[]`,
description "Customer-requested cancellation; allowed at any point." The two
existing cancel edges are left as they are (seed is insert-if-missing). Admins
can later add a requirement (e.g. `distinct_actor`) in the pane without code.

Two more seeded transitions give the partial-publish flow a native pathway,
so the addon-pending samples do not regress to a "Received" badge at the flip
(§9): `sample_received → waiting_for_addon_results` (verb `partial_publish`,
`auto_fire=True`, requirements `[coa_published]`) and
`waiting_for_addon_results → to_be_verified` (verb `submit`, `auto_fire=True`,
same requirement entry as the seeded `sample_received → to_be_verified`
submit edge). The existing `waiting_for_addon_results → published` edge stays.
The plan verifies the exact `coa_published` semantics against the engine
before pinning the entry; no new requirement kind is added.

### 3.4 Analysis-tier `cancel` verb (code — the tier the catalog does not govern)

`lims_analyses/state_machine.py`: verb `cancel` from `unassigned`, `assigned`,
`to_be_verified`, `parent_to_verify` → `cancelled` (dead state, already in
`_EXCLUDED_LINE_STATES`, SKIP_STATES and the board/COA exclusions). Rows in
`verified`, `promoted`, `variance_verified`, `published` are **not** touched:
they are history, and a cancellation after verification is a customer request,
not a lab error. Retest children that are pending are cancelled with the rest.

### 3.5 No new columns on `lims_samples`

`status` becomes native-written in mk1 mode; `native_status` stays as the
engine's own column (identical once flipped; the divergence summary keeps
comparing them, which is now a self-check).

## 4. Authority semantics

### 4.1 mk1 mode — the engine writes the badge

In `execute_verb`, after `sample.native_status = to_slug`, when
`sample_status_authority(db) == "mk1"` and `to_slug` is in the live catalog's
sample-state vocabulary (§7.1): `sample.status = to_slug` and
`record_sample_transition(source="mk1", verb, from_status, to_status)`. One
flush, same transaction as the verb. Nothing else changes in the engine.

`evaluate_cascades` inherits it (it calls `execute_verb`).

### 4.2 mk1 mode — SENAITE-sourced writers stop writing `status`

Gated by the same helper, evaluated once per call:

- `_refresh_parent_from_senaite`: skips `row.status = meta['review_state']`
  (every other field still refreshes). The transition LOG still records what
  SENAITE reported, `source='senaite'`, so divergence stays visible.
- `is_event_stream` heal: skips the `sample.status` write; still records the
  event in the log.
- `heal_sample_status`: accepts a new keyword `source` and, in mk1 mode, writes
  only for `source in ("mk1", "reconcile_native")`. The receive-page touchpoint
  passes `source="mk1"`.

No allowlist for SENAITE-originated verbs: dispatch and invalidate were never
used (Handler, 2026-09-09) and cancel becomes native (§8). A transition made in
SENAITE's UI after the flip is logged as `source='senaite'` and shows up in the
divergence summary as `senaite_only`; it does not move the badge.

### 4.3 senaite mode — unchanged

Every write path behaves exactly as today. Tests pin both modes.

### 4.4 Touchpoint synchrony

The user's direct intents write status inside the request: receive (already
synchronous via `heal_sample_status`, now `source="mk1"`), publish (the ledger
row + `drive_sample_touchpoint(verb="publish")` move from background to
before-commit; the SENAITE tee stays after commit), cancel (§8, synchronous).
Analysis-driven submit/verify keep the existing background cascade — the
badge follows within one cascade tick. The cascade's "refusals are not
recorded" rule stays; the converge job (§6) covers the strandings.

## 5. SENAITE tee with read-back and retry

Every native transition that SENAITE can represent is teed, then proven:

| verb | tee | read-back proves |
|---|---|---|
| receive | existing receive-page SENAITE call | AR `sample_received` |
| verify (sample) | new: `update/{uid} {"transition":"verify"}` once the native cascade reaches `verified` | AR `verified` |
| publish | existing publish tee | AR `published` |
| cancel | new: `update/{uid} {"transition":"cancel"}` | AR `cancelled` |

Read-back = the AR via `search?getId=…&catalog=senaite_catalog_sample&complete=yes`
(never the transition response, never the `transitions` list). On mismatch or
HTTP error: one `lims_senaite_tee_retries` row, `status='pending'`,
`next_attempt_at = now + 5 min`. The user's request never waits on, or fails
over, the tee.

**Job `senaite_tee_retry`** (scheduler, every 5 min, batch ≤ 50 rows due):
re-issue the transition, read back, mark `done` or bump `attempts` with
backoff 5 → 15 → 45 min → 3 h → 12 h; after 8 attempts mark `gave_up` and
emit the `senaite_lagging` bucket in the divergence summary. Two verb-specific
rules:

- **publish refused because the AR is `to_be_verified`** (the PB-0462 class):
  issue `verify` first, read back, then `publish` in the same attempt.
- **cancel refused because the AR is verified/published** (SENAITE forbids
  cancel after verification): mark `senaite_only` immediately, no retry —
  this is a documented SENAITE-only pathway, and the badge is already right.

Retry never overrides a later native state: before re-issuing, the job checks
`sample.status` still equals the verb's target; otherwise it marks `done`
(superseded).

## 6. Scheduled converge

**Job `native_status_converge`** (scheduler, every 15 min, batch ≤ 200
samples received in the last 90 days): the logic of the proven
`backfill_native_converge.py`, made resident —

1. seed `native_status` where NULL from `status` (arm);
2. for samples whose live parent lines are all verified (excluding retracted /
   rejected / cancelled) but `native_status` lags, run `evaluate_cascades`;
3. for samples with a Mk1 publish ledger row and `native_status='verified'`,
   `execute_verb("publish")`;
4. in mk1 mode these advances write `status` (§4.1) and record
   `source='reconcile_native'`.

Every advance is a shadow-evaluation row (`trigger='converge'`), so the
summary shows what the job did. The job is idempotent and bounded; a failure
on one sample logs and continues.

## 7. The catalog as the only source of truth

### 7.1 Vocabulary guard from the live catalog

`workflow/catalog.py::sample_state_slugs(db) -> frozenset[str]` reads
`lims_workflow_states` where `entity_scope='sample' and is_active`, cached 60 s.
`SAMPLE_REVIEW_STATE_WHITELIST` becomes a fallback used only when the query
fails (boot before seed). `heal_sample_status`, the IS heal and §4.1 all use the
live set plus `{"rejected", "stored"}` (SENAITE-only legacy values the mirror
must still accept in senaite mode).

### 7.2 Frontend labels and colors from the catalog

New hook `useWorkflowStates()` (TanStack Query on `GET /api/workflow/graph`,
staleTime 10 min) returning `{slug → {label, category, sort_order}}`.
`StatusBadge` and the explorer/Order-Status label maps resolve label from the
hook first and fall back to today's hardcoded maps; color stays keyed by
`category` (active / terminal / exception) with the existing per-slug classes as
overrides. A state added in the pane renders with its label on day one. Order
Status columns keep their fixed keys; unknown slugs fall into the existing
"Other" handling rather than vanishing.

### 7.3 Cancel edges as data

§3.3 — seeded, then owned by the pane. The engine needs no cancel-specific
code beyond the analysis-tier cascade (§8.3).

## 8. Cancel

### 8.1 Route

`POST /api/samples/{sample_id}/cancel` body `{reason: str (required, ≥ 3 chars),
confirm: bool}`; staff-authenticated (any role; the pane can add
`distinct_actor` or a role gate later). Steps, one transaction:

1. `execute_verb(db, sample, "cancel", trigger="cancel", actor_user_id=…)` —
   `no_edge` → 409 with the current status; `requirements_unmet` → 412 with
   the outcomes (mirrors the Clear/Replace gate shape).
2. Analysis-tier cascade (§8.3) + worksheet release: pending rows are
   cancelled first, then their worksheet memberships are removed and the
   analyst claim cleared (`clear_for_item(reset_state=False)` — no reset
   transition on a row that is already dead), so the Vial Status Board's
   Assigned lane drops them and open worksheets no longer list them.
3. `LimsSubSampleEvent(event="sample_cancelled", details={reason, from_status,
   published_coa: bool, cancelled_rows: n})` on the parent.
4. Commit; then the SENAITE tee (§5) in a background task.

Response: `{status, from_status, cancelled_rows, released_worksheets,
published_coa_still_live: bool}`.

`dry_run: true` returns the same shape without writing (the confirm dialog's
preview), including the row counts and whether a published COA exists.

### 8.2 Frontend

Sample Details header dropdown gains "Cancel sample…" → `CancelSampleDialog`
(sibling of `ClearAnalyteDialog`): dry-run preview on open, a required reason
field, a typed confirm (the sample id), and — when `published_coa_still_live`
— a highlighted line: "The published certificate and its AccuVerify page stay
live. Cancelling does not withdraw them." Destructive button "Cancel sample".
Not shown when the sample is already cancelled. Order Status, the samples list
and the inbox need no change: `cancelled` is already a catalog state and
falls out of the live filters by status.

### 8.3 Analysis-tier cascade

`lims_analyses/service.py::cancel_pending_rows(db, *, parent_sample_pk,
user_id, reason)`: every canonical row on the parent and its vials in
`unassigned / assigned / to_be_verified / parent_to_verify` → `cancelled` via
`apply_transition(kind="cancel", reason=…)` (audited per row, `commit=False`);
verified/promoted/variance-verified/published rows untouched; shadow rows
untouched (SENAITE's own). Returns the ids.

### 8.4 What cancel does not do (this slice)

No un-cancel / reinstate. No Integration Service or WooCommerce order update
(lab-only; IS learns about cancellation in a later slice). No COA withdrawal.
No refund logic. Each is named here so nobody infers it.

## 9. Residual classes and what happens to them at the flip

| class (2026-09-09 count) | at flip |
|---|---|
| native `sample_received` vs mirror `waiting_for_addon_results` (5) | the seeded `partial_publish` edge (§3.3) moves them natively into the existing `waiting_for_addon_results` state once the converge runs, so the badge keeps its meaning; no new state is added. |
| native `to_be_verified` vs mirror `published`, last eval `no_edge:publish` (11) | diagnosed **before** the flip (which line the engine sees as unverified — BW trio shadows are the suspect); fixed by the converge once the requirement is met, or by a documented rule. |
| native `verified` vs mirror `sample_received` (2) | native is right; the tee retry job pushes SENAITE forward. |
| seeded mid-flight `waiting_for_addon_results` (1) | converge re-seeds from line states. |

## 10. Error handling and fail-safes

- Switch absent or unreadable → `senaite` mode. A broken Settings row can
  never flip authority by accident.
- The engine's status write only accepts slugs in the live catalog; anything
  else logs `workflow.status_write_refused` and leaves `status` alone.
- Tee failures never surface to the user; they become queue rows.
- The converge and retry jobs are bounded, idempotent, per-sample try/except,
  and log one summary line per run (`healed / retried / gave_up / errors`).
- Rollback = set `sample_status` back to `senaite`, then one
  `_refresh_parent_from_senaite` sweep over samples touched since the flip
  (the transition log identifies them: `source in ('mk1','reconcile_native')`
  after the flip timestamp).

## 11. Rollout

1. Deploy dark: switch absent, jobs registered but writing only
   `native_status` and queue rows; the tee retry job runs in both modes (it
   fixes the silent-200 class regardless of authority).
2. Run the converge for a day; diagnose the 11 `no_edge:publish` residuals;
   review `GET /api/workflow/shadow/summary` — flip when agreement on
   Mk1-pathway verbs is at 100% minus the documented SENAITE-only classes.
3. Flip `sample_status` to `mk1` in the admin UI. Watch the summary for 48 h.
4. Cancel ships in the same deploy and works in both modes, with one stated
   limit: in senaite mode the badge still follows SENAITE, and SENAITE allows
   cancel only before verification — so a post-verification cancel moves
   `native_status` and cancels the rows but the badge does not change until
   the flip. The dialog states this while the switch is in senaite mode.
5. Later slice: IS notification on cancel; reinstate; retiring the
   SENAITE-sourced writers entirely when SENAITE is disconnected.

## 12. Testing

- Engine: mk1 mode writes `status` + ledger `source='mk1'`; senaite mode does
  not touch `status`; non-catalog slug refused and logged.
- Writers: `_refresh_parent_from_senaite`, IS heal, `heal_sample_status`
  gated per mode; the transition log still records SENAITE-sourced rows.
- Vocabulary: `sample_state_slugs` reflects a state added at runtime; fallback
  on query failure.
- Tee + queue: read-back mismatch enqueues; retry job backoff, `done`,
  `gave_up`, the verify-then-publish rule, the cancel `senaite_only` rule,
  the superseded-by-later-state rule. SENAITE mocked by response fixtures.
- Converge job: arm / cascade / publish steps on fixture samples; bounded;
  per-sample failure isolation.
- Cancel: edges exist from every seeded state after seeding; route 409/412/200
  shapes; dry-run writes nothing; cascade cancels only pending rows; worksheet
  release; event; published-COA flag; frontend dialog (preview, reason
  required, typed confirm, published warning).
- Frontend: `useWorkflowStates` label resolution with fallback; badge renders
  a runtime-added state's label.
- Gating: full backend failure-set diff against pristine master (suites run
  **solo** — concurrent runs deadlock on the shared dev DB); frontend
  `check:all` per-file deltas.

## 13. Non-goals

- Changing the analysis-tier state machine beyond adding `cancel`.
- New requirement kinds. New states for SENAITE addon-plugin parking.
- Any change to how COAs are generated, published or withdrawn.
- IS / WooCommerce cancellation semantics.
- Retiring the SENAITE tee — that is the disconnect program's call.
