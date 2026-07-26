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
