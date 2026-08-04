---
title: "Native parent verification flow — promotion becomes submission; a second sign-off verifies the parent, mirroring SENAITE, via the hardcoded state machine"
date: 2026-08-04
status: draft
authors: [ZeroSignal, forrestp]
depends_on: "native parent analyses table (Mk1 PR #95 — the card this flow's verbs live in); side-by-side engine (shadow trajectory must not regress)"
part_of: "SENAITE phase-out — native workflow parity at the parent tier"
---

# Native Parent Verification Flow

## Summary

Native promotion currently mints canonical parent rows directly in `verified` — the bench tech's
promote IS the sign-off. The Handler ruled (2026-08-04) that the native flow must mirror SENAITE:
**promotion is submission; a lab manager's verify at the parent is a second, deliberate sign-off.**
This spec adds that step through the **hardcoded state machine only** — the workflow catalog stays
descriptive; wiring execution to the catalog is its own later release. Corrections flow through
**retest, not retract**: retest on `verified`/awaiting parents (cascade down, ships in PR #95),
and native vial-side retest on promoted sources (cascade up = un-promote, with a warning modal).
Everything is logged to the activity records with actor, timestamp, and senaite-vs-mk1 service
origin.

## Handler rulings (2026-08-04, conversation)

1. Mirror the SENAITE verification flow at the parent tier. No enforcement of WHO verifies yet
   (no user groups); any authenticated user may verify for now.
2. Hardcoded mechanism this release. Catalog wiring (this flow consulting/enforcing
   `#settings/workflow` edges and requirements, and the eventual catalog-driven state machine)
   is **its own release**, recorded below.
3. Corrections use retest, not retract/un-verify: retest on the verified parent, and retest on
   the (promoted) sub-sample rows of any parent — including published parents.
4. **Deferral confirmed:** re-promoting over a **published** parent (supersede + regen +
   republish) waits for the published-COA-snapshot release. Until then it 409s with a clear
   message. Bench re-runs on published samples can still START immediately (vial retest is
   allowed; the published parent row is untouched).
5. All of these acts land in the activity records: who, when, and whether the service is
   SENAITE-based or Accu-Mk1-owned.

## Current state (verified in code, worktree @ PR #95 head `f15c77d`)

- `promote_to_parent` (backend/lims_analyses/service.py:798-814) INSERTs the canonical parent row
  with `review_state="verified"`, `verified_at=now`, analyst = promoter. No state-machine call.
- `verify` is unreachable through `apply_transition` at BOTH tiers: `_ALLOWED` has
  `(to_be_verified, verify) → verified`, but `verify` is in neither `_TIER_ALLOWED_KINDS` set
  (state_machine.py:136-144). The verify branch in `apply_transition` (service.py:346-348) and the
  `verified_at` stamp branch (:385-386) are dead code today.
- `tier_of` (state_machine.py:184-211) classifies a parent-hosted row by STATE: verified /
  published / retracted → TIER_PARENT; anything else → TIER_VIAL ("parent acting as a vial in a
  variance set"). A parent-hosted `to_be_verified` row is indistinguishable from a variance
  mid-run row — which is why this spec mints a NEW slug instead of reusing `to_be_verified`.
- The workflow catalog (`#settings/workflow`, lims_workflow_states/transitions) already MODELS
  the wanted flow — analysis-scope `to_be_verified --verify--> verified` (workflow/seeds.py:56) —
  but execution ignores the catalog entirely. The shadow engine evaluates SAMPLE-scope edges to
  maintain `lims_samples.native_status` (live today; feeds the flip-readiness report).
- FE retest suppression on promoted vial rows (`promoted: []`, AnalysisTable.tsx:159-178) exists
  for a SENAITE-specific reason (sub-side retest dead-ends on the SENAITE write-back while the
  parent line is verified). Server-side, `apply_transition` retest from `promoted` is legal at
  TIER_VIAL (service.py:284).
- COA: `native_sections.ELIGIBLE_STATES = ("verified", "published")` is fail-closed;
  `source_resolver._LIVE_RESULT_STATES` includes `to_be_verified` while its own docstring claims
  verified/published — a live divergence that could certify unverified values.
- Activity: `LimsSubSampleEvent` (`lims_sub_sample_events`, models.py:1889) is the lightweight
  event log behind the activity feed (family fan-out read; tests
  test_subsample_activity / test_activity_family_fanout). `sub_sample_pk` is NOT NULL — there is
  no parent-hosted event row today.
- Promote's retest-supersession only supersedes a `verified` old parent (service.py:772);
  a published parent 409s (`parent_row_already_exists`) — the citable-COA guard.

## Design

### 1. State machine (hardcoded; no catalog reads)

New analysis review_state **`parent_to_verify`** (display label "To Verify"):

- `_ALLOWED` additions: `(parent_to_verify, verify) → verified` ·
  `(parent_to_verify, retract) → retracted` · `(parent_to_verify, auto) → parent_to_verify`.
- `_TIER_ALLOWED_KINDS[TIER_PARENT]` gains `verify` (becomes `{publish, retract, auto, verify}`).
  TIER_VIAL is unchanged — `verify` stays impossible on vial rows and on parent-acting-as-vial
  rows, so the variance ambiguity never arises.
- `tier_of`: parent-hosted + `parent_to_verify` → TIER_PARENT (one added membership in the
  existing state tuple).
- The `review_state` CHECK constraint and `schemas.ReviewState` learn the slug. The CHECK is the
  known-stale one (`architecture_mk1_review_state_check_stale`): the plan must ADD the value via
  the idempotent boot-DDL path without tightening anything else.
- Retest eligibility sets that name parent states — `apply_transition` retest gate
  (service.py:281-285) and the dedicated-route/cascade guards (§4) — admit `parent_to_verify`.

### 2. Promotion mints `parent_to_verify`; verify is the second sign-off

- `promote_to_parent` mints the canonical parent row with `review_state="parent_to_verify"`,
  `verified_at=NULL`. Analyst stays the promoter (unchanged). Its from-None transition row reads
  `to_state="parent_to_verify"`.
- Verification = the existing generic endpoint, `POST /api/lims-analyses/{id}/transitions` with
  `kind="verify"` — now legal at TIER_PARENT. `apply_transition`'s existing verify branch
  (requires `result_value`) and `verified_at` stamp come alive; the transition row records the
  verifier (`user_id`). No new route. The sample-tier shadow cascade fires post-response exactly
  as it does after promote (routes.py `_schedule_sbs_cascade`).
- No who-can-verify enforcement this release. The catalog release adds it as edge requirements
  (`role_at_least` / `distinct_actor`) evaluated at this gate.
- Retest-supersession in promote (service.py:756-796) supersedes old parents in
  `verified` OR `parent_to_verify` (re-promote over an awaiting row retires it the same way).
  **Published old parents keep the 409** with an upgraded message naming the deferral:
  "published parent — supersede/republish ships with the COA-snapshot release."

### 3. COA gating — fail-closed until verified

- `native_sections.ELIGIBLE_STATES` unchanged (`verified`, `published`): an unverified
  (`parent_to_verify`) row blocks certificate generation by construction.
- **Fix the pre-existing divergence:** `_resolve_mk1_parent_tier` (coa/source_resolver.py) stops
  accepting `to_be_verified` (and never accepts `parent_to_verify`) for parent-tier resolution —
  aligned to verified/published, matching its own docstring. Vial-tier resolution semantics
  unchanged.

### 4. Corrections — retest both directions, never retract-from-published

**Down (parent → sources), ships in PR #95, extended:** the dedicated
`POST /api/lims-analyses/parent/{sample_id}/retest` guard and
`cascade_parent_retest_to_sources`'s un-promote step accept `parent_to_verify` alongside
`verified` (the un-promote retract applies to both; the awaiting row's stale value must not
linger, same rationale as the verified case).

**Up (source → parent), NEW:** native vial-side retest on promoted rows.

- FE: the `promoted: []` suppression is lifted ONLY for `mk1:`-uid rows whose service is
  Accu-Mk1-owned — SENAITE-origin rows keep the suppression and its write-back rationale.
  (Mechanism for "service is native": the row's service origin is already resolvable through the
  senaite-shape serializer; exact field plumbed at plan time.)
- Confirm modal before firing (blast radius UP): when the parent row for the keyword is
  `verified` or `parent_to_verify`, the modal states "Retesting this promoted result will
  un-verify the parent value on <parent sample id> — it returns to awaiting re-promotion." When
  the parent is `published`, the modal states the parent row and its COA are NOT touched, and the
  re-run's new value cannot be re-promoted until the snapshot release.
- Server: a dedicated route (shape mirrors the parent-retest route; exact path at plan time)
  wraps `apply_transition(kind="retest")` on the source row PLUS the upward cascade in one
  transaction: resolve the promotion record → parent row; if parent in
  (`verified`, `parent_to_verify`) → retract it (state → `retracted`, clear result fields,
  transition row reason "un-promoted: source retested from vial") — reusing the cascade's
  step-5 semantics; if parent `published` → leave it untouched. The generic transitions endpoint
  is NOT taught this side effect — vial retest through it keeps today's behavior (bench flows
  untouched); the new route is the card/section's verb target, matching the dedicated-route
  idiom from PR #95.

### 5. Card + sub-sample section verbs

- Parent card (`verbPolicy='parent-native'`): `parent_to_verify` rows offer **Verify** (direct,
  no confirm — non-destructive) and **Retest** (existing blast-radius confirm). `verified` rows:
  Retest (as shipped). Bulk mirrors rows: bulk Verify over an all-`parent_to_verify` selection
  (sequential generic transitions), bulk Retest as shipped. Badge: "To Verify", styled like the
  SENAITE to-verify badge.
- Sub-sample native section: promoted rows (native services only) regain **Retest** with the §4
  modal. Result/method editing on promoted rows stays locked.
- Read surfaces need no query changes: both native parent reads have no state filter, and the
  read-flip parent view keeps `parent_to_verify` rows visible (tier guard passes) as display-only
  under the default policy.

### 6. Activity records

Every act below writes an activity event with `user_id`, timestamp, and a `service_origin`
detail (`"senaite"` | `"mk1"`, from the analysis service's origin). **Transaction shape as
shipped (execution correction, 2026-08-04):** the parent-verify event rides the same
transaction as its state change (inside `apply_transition`); the two retest events are
written in a commit window FOLLOWING their cascades, because the cascades own their own
per-source commits (a shared shape with the pre-existing down-cascade — the only reachable
partial-failure state is "retest durable, event lost", never a false event). Folding the
events into single transactions requires restructuring the cascades' commit discipline and
is carried to the catalog release alongside the `_schedule_sbs_cascade` wiring for the two
dedicated retest routes.

| Act | Event | Details |
|---|---|---|
| Parent verify | `parent_analysis_verified` | keyword, analysis id, service_origin |
| Parent retest (cascade down) | `parent_analysis_retested` | keyword, retested source row ids, un-promoted yes/no, service_origin |
| Vial retest of a promoted row (cascade up) | `promoted_source_retested` | keyword, new retest row id, parent state before, parent un-verified yes/no, service_origin |
| Un-promote (as part of either cascade) | folded into the two events above — no separate event | |

Mechanism: extend the existing `lims_sub_sample_events` log with a nullable parent host
(`lims_sample_pk`, mirroring `lims_analyses`' two-host pattern; exactly one host set, CHECK
enforced) so parent-tier events appear in the family activity feed alongside vial events. The
family fan-out read includes parent-hosted events. Additive DDL; existing rows untouched.

### 7. Shadow-engine containment

`workflow/engine._live_parent_line_states` maps `parent_to_verify` → `to_be_verified` when
collapsing parent line states, so the seeded sample-scope gates (`all_analyses_in_state` value
lists) and the flip-readiness report keep working without catalog data edits. Engine code only —
the catalog and its seeds are untouched this release.

## What does not change

- The workflow catalog, its seeds, its API, and the settings page — untouched. The shadow
  engine's trajectory logic — untouched except the §7 mapping.
- SENAITE surfaces: the main Analyses table, the wizard proxy transitions, write-backs, vial
  locking via SENAITE parent line states. SENAITE-origin promoted rows keep the retest
  suppression.
- Published parent rows: no verb in this release touches one. `native_sections` fail-closed
  behavior. The generic transitions endpoint's vial retest behavior.
- Existing `verified` parent rows: grandfathered — no backfill, no state migration. Only new
  promotions enter the new flow.
- PR #95's shipped behavior for `verified` rows (retest verb, confirm, dedicated route).

## Deferred to named later releases

1. **Catalog wiring release:** the verify gate consults the analysis-scope catalog edge and
   evaluates its requirements (then `role_at_least`/`distinct_actor` become settings-page law);
   `parent_to_verify` state + edges modeled in the catalog; eventually the catalog-driven state
   machine (post-authority-flip). Also: the stale "requirements are documentation" banner copy
   and the two unpickable requirement kinds in the settings UI.
2. **Published-COA snapshot release:** immutable snapshot bound to the verification code, then
   supersede-published at re-promote + regen + republish as one flow (relaxing the 409 in §2).

## Testing

- State machine units: `parent_to_verify` legality matrix (verify/retract/auto at TIER_PARENT;
  everything else TierMismatch), `tier_of` classification, retest eligibility.
- Route level: promote mints `parent_to_verify` (+ transition row shape); verify through the
  generic endpoint stamps `verified_at` + verifier and 409s on vial rows (pin); re-promote
  supersedes `parent_to_verify`; re-promote over published 409s with the deferral message (pin);
  parent-retest route + cascade accept `parent_to_verify` (un-promote fires); the new vial-side
  retest route: cascade-up on verified parent, cascade-up on awaiting parent, published parent
  untouched, SENAITE-origin rows rejected.
- COA: native_sections still aborts on `parent_to_verify`; source_resolver no longer resolves
  `to_be_verified`/`parent_to_verify` parent values (regression pin for the divergence fix).
- Activity: each event row written in-transaction with service_origin; family fan-out includes
  parent-hosted events.
- Shadow engine: `_live_parent_line_states` mapping keeps the seeded sample gates satisfied
  (sample submit/verify edges) with a `parent_to_verify` line present.
- FE vitest: badge + verb gating for `parent_to_verify` under parent-native policy (Verify +
  Retest; display-only elsewhere); bulk verify; promoted-row Retest visible only for native
  services; both modals' copy; default-policy regression pins stay green.
- Gates: backend failure-set diff vs baseline; `npx tsc --noEmit` + targeted vitest (never
  `check:all` in worktrees).

## Risks

| Risk | Mitigation |
|---|---|
| New promotions now require a verify click before COA — turnaround adds a human step | By design (Handler ruling); the card surfaces To Verify rows prominently; bulk verify keeps it one click per sample |
| `parent_to_verify` leaks into a surface that hardcodes state lists | **Corrected at final review:** the new-slug strategy only self-announces on surfaces that bucket via lookup maps with no fallback; surfaces using if/else chains with a catch-all (families state, explorer counts, status-board columns) MISCLASSIFIED the slug silently and needed explicit cases (landed in the final-review fix wave). Structural lesson for the next slug: sweep for catch-all buckets, not just state lists |
| Vial-side retest unlock surprises a bench tech on SENAITE rows | Unlock is native-origin-only; SENAITE rows keep the suppression and its documented rationale |
| Un-promote cascade races a concurrent verify/publish | Both cascades resolve the parent row and act in one transaction; published is checked inside the transaction and never touched |
| Activity host extension breaks the existing feed | Additive nullable column + CHECK; family fan-out extended behind existing tests |

## Open questions

1. Exact route path + request shape for the vial-side retest (mirrors the parent-retest idiom) —
   plan time.
2. How the FE learns "service is native" on promoted vial rows (serializer field vs existing
   catalog lookup) — plan time; must not add a per-row query.
