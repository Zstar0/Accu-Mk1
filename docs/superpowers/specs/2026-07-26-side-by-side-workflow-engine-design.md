# Side-by-Side Workflow Engine — Mk1 executes sample transitions in parallel

*Drafted 2026-07-26, Handler-approved in design conversation the same day.
Supersedes the execution model of `2026-07-13-workflow-shadow-engine-design.md`
(record-only evaluation → parallel execution); reuses its requirements
vocabulary (§4.2), shadow table (§4.3), and divergence-bucket vocabulary (§4.5).*

## 1. Goal

Mk1 executes its own sample-tier workflow transitions — deciding from its own
catalog, its own requirements, and its own native data — in parallel with
production, while SENAITE remains fully authoritative. After a burn-in window,
a divergence report answers the question this slice exists for:

> **If Mk1 had been driving, would every sample have ended up in the same
> state?**

Every divergence is either a rule to fix or a documented SENAITE-only pathway.
When the report is clean, the authority flip (a later, separately-gated slice)
becomes a data change, not a build.

This is the SENAITE phase-out doctrine (mirror → live-with → flip) applied to
the workflow section: the 1.4.0 state system built the catalog and the log;
this slice makes Mk1 *drive* a parallel trajectory; the flip changes which
trajectory readers trust.

### Why parallel execution rather than record-only evaluation

The 2026-07-13 draft evaluated eligibility from `sample.status` — SENAITE's
own state, re-mirrored on every tick. Divergence was recorded once and then
absorbed: the next evaluation restarted from wherever SENAITE said the sample
was, so Mk1 never accumulated its own trajectory and never demonstrated it
could have run the lab. It demonstrated only that its rules agree at
checkpoints SENAITE defines. Compounding divergence is the honest signal, so
Mk1 must hold its own state.

## 2. Key design facts (verified 2026-07-26)

- `lims_samples` has exactly ONE status column (`status`, the SENAITE
  mirror). The 1.4.0 state system deliberately created no second state
  column; there is nothing to reuse for the native trajectory.
- `lims_sample_transitions.source` carries a CHECK
  (`'mk1','senaite','reconcile','is_seed'` — database.py:1217). Widening it
  requires a DROP/re-ADD pair, which is this repo's documented
  **last-boot-wins hazard** (older image re-applies the narrower CHECK →
  silent write death; previously bitten via the attachment-kind CHECK).
- That log's docstring defines it as a "mirror of SENAITE reality." Native
  rehearsal rows do not belong in it during burn-in, and writing them there
  would force filtering into every existing consumer (status glyph,
  registry-inspect tail).
- The workflow catalog (23 states / 22 transitions, `entity_scope`d,
  requirements JSONB, admin CRUD + React Flow page) is live but has **no
  consumer outside `backend/workflow/`** today. This slice is its first.
- The analysis tier already enforces natively
  (`lims_analyses/state_machine.py`) and the FE routes `mk1:` uids to native
  endpoints; sample tier is the gap.

**Consequences:** the reality log is untouched by this slice — no new source
value, no CHECK change, no consumer changes. The native trajectory lives
entirely in NEW structures.

## 3. Data model (additive only)

### 3.1 `lims_samples.native_status` — materialized convenience

Nullable `VARCHAR(50)`, added by idempotent `ADD COLUMN IF NOT EXISTS`.
NULL = not yet seeded (engine skips the sample; never treats NULL as a state).

- Written ONLY by the engine and the seed script, in the same transaction as
  the corresponding shadow-evaluation row (house idiom: state on the row,
  history in an audit table — exactly `lims_analyses.review_state` +
  `lims_analysis_transitions`).
- Read by NO existing page or endpoint. `status` remains what every reader
  renders. Consumers of `native_status` are the divergence summary and the
  registry-inspect block, both new.
- Authority note: the shadow-evaluation table is the authoritative history;
  the column is its O(1) materialization. If they ever disagree, the table
  wins and re-seed heals.

### 3.2 `lims_workflow_shadow_evaluations` — trajectory + why

As designed in the 2026-07-13 spec §4.3, extended to record **executions,
not just evaluations**:

    id                BIGSERIAL PK
    lims_sample_pk    INT NOT NULL REFERENCES lims_samples(id) ON DELETE CASCADE
    evaluated_at      TIMESTAMP NOT NULL DEFAULT NOW()
    trigger           TEXT NOT NULL         -- 'receive' | 'publish' | 'analysis_cascade' | 'seed'
    verb              TEXT                  -- catalog verb attempted (NULL for seed)
    from_status       TEXT                  -- native_status before
    to_status         TEXT                  -- native_status after (= from_status when refused)
    outcome           TEXT NOT NULL         -- 'advanced' | 'requirements_unmet' | 'no_edge' | 'seeded'
    requirements_met  BOOLEAN
    outcomes          JSONB                 -- per-requirement [{kind, args, met, detail}]
    actor_user_id     INT NULL REFERENCES users(id)

Indexes: `(lims_sample_pk, evaluated_at)`; partial on
`(outcome) WHERE outcome != 'advanced'` for the summary.

DDL is monotonic — additive CREATE only, **no CHECK-modification pairs**
(last-boot-wins class). `outcome`/`trigger` vocabularies are enforced in code,
not CHECKs, so an older image booting this DB cannot brick writes.

`trigger` records the touchpoint that initiated the engine call; cascade
evaluations inherit the initiating site's value (a cascade fired from the
receive site records `trigger='receive'`, from an analysis change
`'analysis_cascade'`).

Delta-dedup applies to refusals only: skip insert when the sample's latest row
has identical (verb, from_status, outcome, outcomes-hash). A stuck sample is
one row, not a row per tick. Advances are always inserted.

## 4. Engine (`backend/workflow/engine.py`)

Pure, DB-local, no request coupling. Reads only `lims_samples`,
`lims_analyses` (parent tier + promotions), `lims_sub_samples`, and the
workflow catalog. **No SENAITE reads, no IS calls, ever** — publish success is
attested by the touchpoint as an argument.

    execute_verb(db, sample, verb, *, actor_user_id, attested=None) -> ShadowOutcome
        1. edge = active catalog transition (sample scope) with this verb
           whose from_state == sample.native_status
           — none → record outcome='no_edge', native_status unchanged
        2. evaluate edge.requirements (v1 vocabulary below); ALL must hold
           — any unmet → record outcome='requirements_unmet', unchanged
        3. advance: native_status = edge.to_state; record outcome='advanced'
           (same transaction)

    evaluate_cascades(db, sample, *, actor_user_id) -> list[ShadowOutcome]
        Repeatedly: find auto-class edges out of native_status whose
        requirements are all met; take the first (catalog sort_order);
        loop until none fire (bounded by state-graph depth; hard cap 10).

Cascade rationale: in SENAITE, `to_be_verified` and `verified` at the sample
tier are side effects of analysis-tier changes (all-submitted, all-verified).
Mk1 reproduces that natively: after any parent-analysis state change, the
cascade evaluator runs. Which edges are auto-class is catalog data (the verb
set on seeded edges), not engine hardcode.

### Requirements vocabulary v1 (unchanged from 2026-07-13 spec §4.2)

`analyses_all_in`, `analyses_none_in`, `min_vials_received`, `coa_published`
(attested, never queried), `distinct_actor` (encoded now, DORMANT until
enforcement). Unknown kinds evaluate `met=false, detail="unknown kind"` —
fail-closed, visible, never silently true.

## 5. Trigger sites (all Mk1-originated; production behavior unchanged)

At each site, the existing flow — including its SENAITE write — runs exactly
as today. The engine call is appended after it, fail-open (wrapped; an engine
exception logs and never breaks the request), same request, behind the env
gate.

| Site | Engine call |
|---|---|
| Receive flow (order-first check-in / receive wizard commit) | `execute_verb(..., 'receive')` then `evaluate_cascades` |
| `publish-coa` (after step-3 IS publish succeeds) | `execute_verb(..., 'publish', attested={'coa_published': True})` |
| Parent-analysis state changes (native transitions route, `promote_to_parent`, retract/retest cascades) | `evaluate_cascades` |

SENAITE-originated actions (someone acting in the SENAITE UI) intentionally
have NO trigger: `native_status` does not move, `status` does (IS event
stream), and the pair diverges. That is a feature — after burn-in, this bucket
*enumerates every workflow action that still has no Mk1 pathway*, generated
from production behavior instead of code archaeology.

Exact hook points (receive-flow site especially) are an implementation-plan
task: locate where `lims_sample_transitions` source='mk1' rows are written
today (the 1.4.0 receive + publish hooks) and piggyback — same sites, same
fail-open contract, zero new SENAITE load.

## 6. Divergence surface

### 6.1 Summary — `GET /api/workflow/shadow/summary` (admin)

Core is a two-column comparison over seeded samples, bucketed:

| Bucket | Meaning | Signal |
|---|---|---|
| `agree` | native_status == status | ready |
| `mk1_refused` | statuses differ; latest shadow row has `outcome='requirements_unmet'` | requirement miscalibrated OR SENAITE loose — both findings |
| `no_native_pathway` | statuses differ; no shadow attempt since divergence; log shows source='senaite' rows after the last native advance | SENAITE-only pathway — the gate-2 punch list |
| `stuck_behind` | statuses differ; latest shadow row has `outcome='no_edge'` | compounding divergence from an earlier refusal — diagnose, then re-seed |

Response: per-bucket counts + per-transition breakdown + sample-id lists
(capped), over an optional `since` window. This endpoint IS the
flip-readiness report: **flip-ready when agree ≈ 100% on Mk1-pathway verbs
and `no_native_pathway` is empty or each entry is explicitly accepted.**
Burn-in ends when the report says so, not the calendar.

### 6.2 Registry-inspect block (per-sample)

Under the existing recent-transitions tail: `status` vs `native_status`,
latest shadow evaluation (verb, outcome, unmet requirements), same panel
idiom. Admin/debug surface only.

## 7. Seeding and heal — one script, no UI

`backend/scripts/seed_native_status.py`:

- `--all` / `--samples P-xxxx,...`; dry-run by default, `--apply` to write.
- Sets `native_status = status` and writes an `outcome='seeded'` shadow row
  (trigger='seed') recording the adopted state.
- Serves three roles: initial seed at deploy; per-sample heal once a
  divergence is diagnosed (re-adopt reality, observation restarts clean);
  global burn-in reset after a rule fix.

No admin heal button in this slice — a later thin wrapper if wanted.

## 8. Rollout, guardrails, rollback

- Env gate `MK1_WORKFLOW_SHADOW_ENABLED` — **ON in prod at deploy** (Handler:
  the burn-in is the point; off means no clock). Kill switch = flip it off.
- Engine + recorder fail-open at every touchpoint: never breaks receive,
  publish, or an analysis transition. (Mirrors `_mirror_parent_analysis_bg`'s
  never-raise contract.)
- No SENAITE writes added or changed. No reader changes. No enforcement — the
  engine never blocks the real flow in this slice.
- Rollback: flag off; optionally drop the column + table. Nothing else
  touched — the reality log, catalog, and every existing reader are
  byte-identical with the flag off.
- Deploy order: image → seed script (off-hours, `--apply`) → verify summary
  shows 100% `agree` on day zero.

### §6 decisions from the 2026-07-13 draft — resolved (Handler, 2026-07-26)

1. Prod flag default → **ON**.
2. `distinct_actor` → **encoded now, dormant** (evaluated + recorded, never
   gates until the enforcement slice).
3. Seed requirements → **pre-fill the two obvious edges**
   (`submit-all → to_be_verified`, `coa_published → published`); author the
   rest via the Workflow settings page during burn-in (that page finally gets
   a consumer).
4. Nightly sweep → **dropped**. Under parallel execution the summary is a
   column comparison; there is nothing for a sweep to compute.

## 9. Explicit non-goals

- No writes to `lims_samples.status`; no reader consults `native_status`.
- No enforcement, no blocking, no auto-transitions of real state.
- No authority flip (next slice — becomes a data change when the report is
  clean). No COABuilder changes. No changes to SENAITE write paths.
- No published-COA snapshot work — but note: this slice rehearses publish
  authority, so the gate-4 snapshot question (immutable result values behind
  a published COA, bound to the verification code) must be answered before
  the ACTUAL publish flip. Flagged, out of scope here. Substrate exists:
  `coa_generation_sources` already captures value+unit per analyte per
  generation; it needs a reader and a coverage audit.

## 10. Testing

- Engine: pure-function tests per requirement kind (met / unmet /
  unknown-kind fail-closed); edge lookup by scope + active + from_state;
  cascade loop termination (cap 10); NULL `native_status` skip.
- Recorder: delta-dedup on refusals; advances always insert; same-transaction
  column+row write; fail-open (exception in engine → request succeeds, error
  logged).
- Touchpoints: receive/publish/cascade sites fire under the flag, no-op
  without it; publish attestation plumbed.
- Seed script: dry-run parity, idempotent re-run, seeded shadow row written.
- Gate: full-suite failure-set diff vs master in the same venv — zero
  branch-only failures (house method).

## 11. Relationship to the phase-out program

Section-3 (state system) authority track. Order of operations after this
slice ships: burn-in → fix rules / accept pathways until the summary is
clean → THEN the sample-tier authority flip (separately gated, data change)
→ which unblocks retiring the SENAITE workflow round-trips (`/update/{uid}`
transition proxy) → which, together with the 4+5 verdict/snapshot slice,
unblocks COABuilder re-wire (program step 5) and SENAITE retirement.

## As built (2026-07-26 implementation)

- Requirements vocabulary v1 is the LIVE catalog registry
  (`workflow/catalog.py REQUIREMENT_KINDS`) — entry shape
  `{kind, value, note}`, extended with `coa_published` (no value) and
  `distinct_actor` (value = than-verb, non-gating). The 07-13 draft's
  `{kind, args}` shape was never seeded and is dropped.
  `all_analyses_in_state` takes a comma-list value; empty live-line set
  evaluates unmet (fail-closed).
- Cascade eligibility = `lims_workflow_transitions.auto_fire` (new additive
  column; seeded TRUE for the builtin sample submit/verify edges via a
  guarded boot UPDATE).
- Trigger sites landed as: the `_record_sample_transition_bg` chokepoint
  (receive + publish, attestation = the hook only fires post-IS-success) and
  `lims_analyses` routes `transition`/`promote` via BackgroundTasks.
- Cascade probing does NOT record refusals (speculative probes would spam
  the trajectory); refusals are recorded only for explicit verbs.
- Seed data itself now carries `auto_fire` + the publish edge's
  `coa_published` requirement (first-boot ordering fix — migrations run
  before `seed_workflow_catalog`, so relying on a boot UPDATE alone was a
  no-op on true first boot); the boot UPDATEs are retained for existing DBs.
- Controller amendment implemented in the summary endpoint: divergent
  samples that fall to `no_native_pathway` are live-probed against
  `auto_fire` edges via `evaluate_requirements`; an unmet probe reclassifies
  the sample as `mk1_refused` with `latest_outcome='live_probe_unmet'`. This
  prevents a genuine rule-miscalibration (cascade stalled on an unmet
  requirement) from silently masquerading as a pathway gap.
- since-window semantics: bucket labels are window-relative (documented in
  the endpoint docstring and pinned by test) — `since=None` does not recover
  the sample's true original blocker, only its latest trajectory row.
- Seed script commits PER ROW, not once at the end — the spec/plan's
  single-commit sample was defective (a mid-loop rollback discarded already
  processed rows while the in-memory stats counter had already incremented
  for them, over-reporting). Stats increment strictly after a successful
  per-row commit. Repeated heals are intended to APPEND a new `seeded`
  trajectory row rather than dedup, by design — each re-adoption is a
  distinct, auditable event.
- The chokepoint commit gate (`wrote_log or wrote_status or wrote_received`)
  now also includes `wrote_engine`, so a side-by-side engine write can never
  be silently rolled back by the host function's pre-existing flag logic —
  closes a case where all three original flags were False but the engine had
  advanced `native_status`.

## Final-review fix wave (2026-07-27)

- **Submit-edge gating (finding #1).** The seeded sample-scope `submit` edge
  (`sample_received` → `to_be_verified`, `auto_fire=True`) fired
  unconditionally — the only gating the cascade had was `auto_fire`, with an
  empty `requirements` list. It now carries
  `{"kind": "all_analyses_in_state", "value": "to_be_verified,verified,published"}`
  (Handler-confirmed 2026-07-27 state list), seeded from first boot in
  `workflow/seeds.py` and reconciled on existing DBs via a guarded boot
  UPDATE in `database.py`, same idiom as the neighboring `coa_published`
  UPDATE. Verified by hand against the live dev DB before wiring the UPDATE
  into `database.py`: the statement touches exactly the one `submit` row,
  produces a well-formed one-element `jsonb` array via `||` concatenation,
  and is a true no-op on re-run (0 rows the second time). Note: the seed-path
  requirement's `note` is `None` while the boot-UPDATE path's `note` is
  `"all analyses submitted"` — a cosmetic asymmetry (same asymmetry pattern
  as `coa_published`'s two paths did not have, since that one's note text
  matches); the two paths are mutually exclusive (first-boot vs.
  existing-DB), so it never surfaces as a live inconsistency. Left as
  written per the brief rather than "fixed" unprompted.
- **Row locking (finding #2).** The chokepoint bg session
  (`main._record_sample_transition_bg`) and `run_cascades_bg`'s own bg
  session can interleave on the same sample (chokepoint bg vs.
  post-response analysis-route cascade). Both now take a row lock before
  reading `native_status`: the chokepoint uses
  `select(LimsSample).where(...).with_for_update()`; `run_cascades_bg` uses
  `db.get(LimsSample, sample_pk, with_for_update=True)`. Both touchpoints
  already commit their own request-scoped transaction (`apply_transition`
  internally, `promote()` explicitly) before scheduling the cascade
  background task, so the added lock does not introduce a cross-session
  hang in the existing HTTP-level test suite — verified by running
  `test_lims_analyses_routes.py` + `test_promote_writeback_route.py` +
  `test_list_parent_analyses_senaite_shape.py` after the change (no hang;
  one pre-existing unrelated `tier_mismatch` failure, confirmed present in
  both the branch and master baseline failure lists from Task 9's gate).
  Both entry points are background contexts — no user-facing latency
  impact.
- **`mk1_ahead` bucket (finding #3).** `_shadow_summary_payload` previously
  had no bucket for a divergent sample whose latest shadow row succeeded
  (`outcome == "advanced"`) — meaning Mk1's native trajectory has moved
  past what SENAITE's `status` shows. Added as its own branch, checked
  BEFORE the `no_native_pathway` live-probe fallthrough (an "advanced"
  outcome must never reach the live-probe branch). Buckets are now `agree`
  / `mk1_refused` / `stuck_behind` / `mk1_ahead` / `no_native_pathway`;
  docstrings and the endpoint's bucket-key set updated to match.
- **`run_cascades_bg` direct coverage (finding #4).** Two new tests in
  `test_workflow_engine.py` exercise the background target directly rather
  than only through the touchpoint tests: a happy path (own-session commit
  verified via `expire_all` + re-query) and a failure path (patches
  `workflow.engine.evaluate_cascades` to raise, asserts no propagation).
  Both create + commit their own fixtures rather than reusing `test_sample`
  (which only flushes) — `run_cascades_bg` opens a separate `SessionLocal()`
  connection that cannot see another session's uncommitted rows.
- **FE contradictory-diagnostic fix (finding #5).**
  `SampleRegistryDebug.tsx`'s "not seeded" badge rendered whenever
  `shadow.in_sync === null`, even when `shadow.error` was set — implying a
  healthy-but-unseeded sample when the shadow query had actually failed.
  Gated on `!shadow.error`. One regression test added pinning the error
  case renders the error line and not the "not seeded" badge.
- **Stable divergent-sample ordering (finding #8).** The seeded-samples
  query in `_shadow_summary_payload` now has `.order_by(LimsSample.sample_id)`
  so the 200-cap `divergent` list is stable across polls of the same
  underlying state.
- **Test isolation fix required by finding #1.** `test_workflow_shadow_summary.py`'s
  `TEST-SUM-D` fixture previously used the real `sample_received` slug as
  its unseeded/no-pathway example. Once `submit`'s new requirement went
  live in the shared dev DB, `sample_received` had a real, empty-line-set,
  live-probeable `auto_fire` edge — reclassifying D to `mk1_refused`
  instead of the intended `no_native_pathway`. D now uses a private
  `test_sum_d_isolated` state with zero outgoing sample-scope transitions
  (same isolation pattern as the file's existing `window_state` fixture).

## Verb-aware divergence bucketing (2026-07-27, UAT cancel finding)

`_shadow_summary_payload`'s live-probe fallthrough originally probed every
active `auto_fire` edge out of `native_status` blindly. Real repro
(sample PB-0067): SENAITE cancelled a sample directly while it sat in
`sample_received` — a state that (post the submit-edge gating fix above)
always has an unrelated auto `submit` edge — and the probe found THAT edge
unmet and misreported it as the reason, when the true story is "SENAITE
acted where Mk1 has no trigger." Since most SENAITE-direct actions
(cancel/dispatch) land on samples sitting in states with an auto_fire
edge, `no_native_pathway` was systematically under-counted — the exact
punch-list signal the report exists to build (tracked as
`project_native_verb_origination_punchlist`).

Fix: the fallthrough now resolves the sample's latest `source='senaite'`
`lims_sample_transitions` row first and, if its `verb` is non-null, probes
the catalog edge for THAT verb via `workflow.engine._find_edge` (any
active edge, not just `auto_fire`) instead of guessing from auto_fire
candidates:
- No catalog edge for that verb → `no_native_pathway` (catalog gap).
- Edge exists, unmet → `mk1_refused` / `live_probe_unmet`, `latest_verb`
  = the actual SENAITE verb (Mk1 would have refused what SENAITE did).
- Edge exists, met → `no_native_pathway` (Mk1 had the pathway; what's
  missing is a TRIGGER, not a rule — this is the punch-list signal).

No SENAITE-sourced transition (or a null verb) falls back to the original
auto-edge probe, unchanged — it remains the transient-cascade-stall
detector for the case where nothing external moved the sample at all.

**Follow-up (same day):** both `no_native_pathway` sub-cases above
(no edge for the verb; edge exists and is met) initially left `latest_verb`
as `None` on the divergent row — but this bucket exists specifically to
enumerate WHICH verbs Mk1 can't originate yet, so an operator couldn't see
"this was a cancel" without cross-referencing the transition log. Both
sub-cases now set `latest_verb` to the SENAITE verb that caused the
divergence; the shadow-eval-derived `outcome` field is left `None` as
before.

## Arming native_status on first touch (2026-07-27, P-0140 coverage-decay finding)

Real design gap, not a bug in the engine's logic: `native_status` is only
ever set by the one-time catalog seed script
(`scripts/seed_native_status.py`) or — after this fix — a first-touch
arm. A sample **minted after** the seed run (i.e. every sample created
during normal operation post-go-live) got `native_status=NULL` forever,
since nothing else in the system ever wrote the column, and the engine
skips NULL by design (§3.1: "NULL native_status = not seeded → engine
skips silently"). UAT proved this concretely: P-0140 was checked in
through the UI (the mk1 transition log row + status heal landed
normally), but produced ZERO shadow trajectory — the sample was invisible
to the divergence report for its entire life. Burn-in coverage would have
silently decayed to whatever fraction of the fleet existed at seed time.

**Fix — arm on first touch, at both true creation/first-contact hooks:**

- **New helper, `workflow/engine.py`: `arm_native_status(db, sample,
  adopted, *, trigger, actor_user_id=None)`.** Public (not the module's
  usual `_`-prefixed internal helpers) — both call sites below import it.
  Sets `sample.native_status = adopted`, flushes, and records a `seeded`
  trajectory row via the same internal `_record` the bulk seed script's
  outcome vocabulary uses. Flush-only; caller commits. Not deduped against
  a prior arm (same "repeated heals APPEND a new seeded row, by design"
  precedent `seed_native_status.py` already established) — callers check
  `native_status is None` before calling.
- **Site 1 — the `_record_sample_transition_bg` chokepoint (`main.py`).**
  After the locked sample fetch (finding #2's row lock), if the sample is
  unarmed and the verb is `receive`/`publish`: arm from
  `kwargs.get("from_status") or sample.status`, THEN proceed through the
  existing `execute_verb` + `evaluate_cascades` unchanged. Arms from
  `from_status`, not `status`, deliberately: by the time this hook runs,
  `heal_sample_status` has already advanced `sample.status` to the
  POST-transition state earlier in the same function — arming from
  `status` would make the verb about to execute a `no_edge` (there's no
  edge FROM the destination state for the verb that just landed you
  there). Both call sites (`receive`, `publish`) always pass `from_status`
  explicitly, so the `sample.status` fallback is defensive-only and should
  never actually fire in production.
- **Site 2 — a new bg task, `_arm_native_status_at_registration_bg`
  (`main.py`), scheduled from `POST /s2s/lims-samples`
  (`s2s_upsert_lims_sample`).** Deliberately a SEPARATE background task
  from the existing `_shadow_analyses_at_registration_bg` sibling, not
  folded into it: that sibling's SENAITE `fetch_parent_analyses` call can
  fail (SENAITE outage, unmapped keyword), and arming must not be coupled
  to that outcome. Scheduled unconditionally for every registration (both
  SENAITE-attached and SENAITE-free rows) — unlike the shadow-sync task,
  which only runs for SENAITE-attached rows (there's no AR to mirror for
  the SENAITE-free `external_lims_system='mk1'` form, but there's always a
  `status` to arm from). Gated on `shadow_enabled()`; arms from the row's
  current `status` (there is no prior state — this is the sample's first
  tick of existence); own short-lived session, never-raise, same hardening
  pattern as its sibling bg tasks.
- **New `trigger` vocabulary value: `'registration'`** (paired with
  `outcome='seeded'`) — added to the code-enforced vocabulary comment on
  `LimsWorkflowShadowEvaluation` in `models.py`. No test pins the trigger
  list exhaustively, so no other test needed updating for the new value.
