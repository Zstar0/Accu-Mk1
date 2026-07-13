# Workflow Shadow Engine — native transition evaluation, record-only (DRAFT)

*Drafted 2026-07-13 during registry-stack UAT. Status: DRAFT — Handler review
pending. First enforcement-era slice of the state-system program; builds on
the slice-3 mirror (spec: 2026-07-12-workflow-state-system-design.md).*

## 1. Context and program position

Slice 3 shipped the catalog (`lims_workflow_states` / `lims_workflow_transitions`,
both scopes, machine-checkable-but-dormant `requirements` JSONB), the 3-source
transition log, and the admin Workflow page. SENAITE remains the authority for
sample state; Mk1 mirrors.

UAT (2026-07-13, PB-0075) demonstrated why the swap matters: SENAITE silently
no-ops transitions (HTTP 200, no state change), blocks verify on
submitter==verifier without surfacing it, and emitted a `publish` event for a
transition it never applied. Mirror-era code correctly refused to record what
SENAITE didn't hold — but the lab's business reality ("the COA is published")
diverged from workflow state for hours.

This slice makes Mk1's own machine run — **in shadow**: it evaluates the
catalog against native data on every state-relevant change and records what it
*would* do, next to what SENAITE actually did. Zero behavior change. The
divergence record burns in the requirements definitions and becomes the
evidence base for the per-section authority flips (separate, Handler-gated
slices).

## 2. Goals

1. A pure evaluation engine: given a sample's native rows, return the set of
   catalog transitions whose requirements are satisfied from the current state.
2. A requirements vocabulary v1 (closed set, JSONB) expressible entirely over
   Mk1-native data — no SENAITE reads in the engine, ever.
3. Shadow recording: would-be transitions + requirement outcomes persisted on
   every state-relevant touchpoint, comparable against actual (senaite/mk1/
   reconcile) history.
4. A divergence surface: registry-inspect panel block + an admin summary
   (agree / Mk1-ahead / SENAITE-ahead / contradiction, per transition).

## 3. Non-goals (later, separately-gated slices)

- No writes to `lims_samples.status` by the engine. No enforcement, no
  blocking, no auto-transitions.
- No SENAITE writes, no WP-chain changes (the IS→WP publish push rides the
  publish authority-flip slice).
- No authority flips. The per-transition `authority` column ships **dormant**
  (§6) so flip slices are data changes, not schema changes.
- No verify separation-of-duties enforcement — but the requirement kind exists
  in the vocabulary from day one (§5) so the policy is expressible when the
  Handler decides it.

## 4. Design

### 4.1 Engine (`backend/workflow/engine.py`)

Pure functions, own module, no request coupling:

- `eligible_transitions(db, sample) -> list[EligibleTransition]` — catalog
  edges out of `sample.status` (sample scope, active rows only), each with
  `requirements_met: bool` and per-requirement outcomes.
- `EligibleTransition = {transition_id, verb, from_state, to_state,
  requirements: [{kind, args, met, detail}]}`.

Evaluation reads only: `lims_samples`, `lims_analyses` (parent rows +
promotions), `lims_sub_samples`, `coa_generations` facts already mirrored into
Mk1 requests (publish success is passed in by the publish touchpoint, not
queried from IS — keep the engine DB-local).

### 4.2 Requirements vocabulary v1 (closed set)

JSONB shape: `[{"kind": "...", ...args}]`, ALL must hold. Kinds:

| kind | args | semantics |
|---|---|---|
| `analyses_all_in` | `states: [..]`, `scope: live` | every live (non-retracted/rejected, retested=False) parent analysis is in `states` |
| `analyses_none_in` | `states: [..]` | no live parent analysis is in `states` |
| `min_vials_received` | `count: n` | received sub-sample count ≥ n |
| `coa_published` | — | publish touchpoint attests IS publish success (arg passed in, engine does not call IS) |
| `distinct_actor` | `than_verb: submit` | acting user differs from the last actor of `than_verb` in the log (ISO 17025 separation; DORMANT until enforcement) |

Unknown kinds evaluate to `met=false, detail="unknown kind"` — fail closed,
visible in the shadow record, never silently true (slice-3 lesson: the silent
requirements-validation no-op).

### 4.3 Shadow recording — separate table, not the log

`lims_workflow_shadow_evaluations` (additive; `lims_` prefix; idempotent DDL,
**monotonic CHECKs only** — last-boot-wins lesson):

    id, lims_sample_pk (FK CASCADE), evaluated_at,
    current_status, transition_id (FK), verb, to_status,
    requirements_met bool, outcomes JSONB,
    trigger text CHECK IN ('is_sync','reconcile','mk1_hook','sweep')

The real transition log stays pure history. Dedup: skip insert when the latest
shadow row for (sample, transition) has identical
(current_status, requirements_met, outcomes-hash) — record deltas, not ticks.

### 4.4 Touchpoints (piggyback, never new load)

1. IS-sync tick — after ingesting a sample's events (`is_event_stream`),
   evaluate that sample. Same session, same fail-open contract.
2. Reconcile — `_refresh_parent_from_senaite` tail, best-effort.
3. Mk1 hooks — receive + publish record sites, after their log write.
4. Optional nightly sweep behind the same flag (off by default) for samples
   untouched by 1-3.

Env gate: `MK1_WORKFLOW_SHADOW_ENABLED` (default **on** in stacks, decide for
prod at deploy — Handler call §7). Kill switch = env, rollback = flag off +
optional table drop; no other surface.

### 4.5 Divergence surface

- Registry-inspect: "shadow" block under recent transitions — latest
  evaluation, eligible verbs, unmet requirements (reuses the panel idiom).
- `GET /api/workflow/shadow/summary` (admin): per-transition counts over a
  window — {agree, mk1_ahead (requirements met before SENAITE moved),
  senaite_ahead (SENAITE moved while requirements unmet → requirements wrong
  or SENAITE loose), contradiction (e.g. phantom publish)}. This table IS the
  flip-readiness report.

## 5. Authority-flip preview (dormant here)

`lims_workflow_transitions.authority text CHECK IN ('senaite','mk1') DEFAULT
'senaite'` — shipped in this slice's DDL, surfaced read-only on the Workflow
page, consumed by nothing. Flip slices (publish first) become: set
`authority='mk1'` for the section's transitions + enable the one-way valve
(reconcile/heal never downgrade an mk1-authored terminal state) + the
section's write path. Publish-flip slice additionally moves the WP status push
to IS's generation-publish path.

## 6. Handler decisions needed (before build)

1. Prod default for `MK1_WORKFLOW_SHADOW_ENABLED` — on (data from day one) or
   off (stacks first)?
2. `distinct_actor` on verify — encode now-dormant (recommended) or omit until
   the verify-flip slice?
3. Seed requirements: do we pre-fill v1 requirements for the obvious
   transitions (submit-all→to_be_verified, coa_published→published) or start
   empty and author via the Workflow page during shadow burn-in?
4. Nightly sweep — wanted at all, or are touchpoints 1-3 enough?

## 7. Testing

- Engine: pure-function tests per requirement kind (met/unmet/unknown-kind
  fail-closed), transition filtering by scope + active + from_state.
- Shadow recorder: delta-dedup, fail-open (recorder exception never breaks the
  touchpoint), CHECK monotonicity test (boot older schema → no silent write
  death — regression for the last-boot-wins class).
- Touchpoint wiring: is_sync tick evaluates ingested samples (extend
  test_is_event_stream_sync house pattern).
- Gate: full-suite failure-set byte-identical to base (slice-3 method).

## 8. ISO 17025 alignment

Shadow evaluations are attributable, time-stamped records of *why* a
transition was or wasn't available (§7.5 records; §7.1/7.4 defined
procedures). `distinct_actor` encodes review-independence when enforcement
arrives. The divergence report doubles as the validation evidence that the
native machine reproduces (or deliberately improves on) the SENAITE workflow
before authority moves — exactly the change-control story an assessor wants.

## 9. Follow-ups already known

- Heal-guard `last_synced_at` semantics (slice-3 list) — superseded for
  flipped sections by the one-way valve; still worth `status_synced_at` for
  mirror-era sections.
- Phantom-event contradiction class (SENAITE emitted publish, never applied):
  shadow summary surfaces these as `contradiction` — no chase, per Handler
  triage 2026-07-13.
