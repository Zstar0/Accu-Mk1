# Spec: Distinct sub-sample analysis workflow — `promoted` terminal state

*2026-06-08. Sub-samples get their own analysis lifecycle, distinct from parent
samples: a sub-sample analysis ends at a new **`promoted`** state when its result
is rolled up to the parent. `verified`/`published` become **parent-tier-only**, and
the vestigial sub-sample `verify` transition is removed so a sub-sample result can
never be stranded. **Type-agnostic** — identical for every sub-sample physical type
(vial today; capsule / inhaler / gel later). Backend state-machine + migration +
FE-badges **behavior change**; its own PR; needs sign-off. Independent of the two
unpushed features on `subvial/continue`.*

## Why

An audit of the sub-sample (vial-tier) `review_state` workflow found the design
**self-contradictory and on the wrong side of an unclosed decision**:

- The **foundational** two-tier spec (`docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md:53,140-148`)
  says a sub-sample analysis **terminates at `to_be_verified`** and that
  **`verified`/`published` are parent-tier-only** — verification *is* the
  *promote* act (`promote_to_parent`), which creates a parent-tier row already in
  `verified` and leaves the sub-sample alone.
- A **later "admin escape hatch"** kept `verify` legal on the sub-sample tier
  (`backend/lims_analyses/state_machine.py:116-123`), and the Phase-4b decision to
  *deprecate or reroute* it was **opened and never closed**
  (`docs/superpowers/plans/...phase4a-promote-backend.md:1248`).
- **Consequence (the live bug that triggered this):** a sub-sample can reach
  `verified` via a direct API `verify` (a realistic-data seeder did exactly this to
  `P-0142-S01` Endotoxin), but `promote_to_parent` **only accepts `to_be_verified`
  sources** (`backend/lims_analyses/service.py:447-451`). So a `verified` sub-sample
  is **unpromotable by any caller**, the UI offers **no recovery** (only a lossy
  retest), and its result is **stranded off the parent and the COA**. It was the
  only such row in the dataset (1 of 1 verified sub-samples; 9 others promoted
  normally) — confirming it's an anomaly, not the intended flow.

**Decision:** adopt the foundational two-tier model cleanly, and make the
sub-sample's "done-ness" a **real state** rather than a derived badge: on Promote,
the sub-sample moves `to_be_verified → promoted`. Block sub-sample `verify` so the
stranding class of bug becomes structurally impossible.

## Current state (verified via the workflow audit)

- **States** (`state_machine.py:64-74`): `unassigned, assigned, to_be_verified,
  verified, published, rejected, retracted`; terminal: `published, rejected`.
- **State-machine edges** `_ALLOWED` (`state_machine.py:90-105`, tier-agnostic):
  `unassigned→assign/submit/reject`, `assigned→submit/reject/reset`,
  `to_be_verified→verify/retract/reject`, `verified→publish/retract`.
- **Tier kind-matrix** `_TIER_ALLOWED_KINDS` (`state_machine.py:116-123`):
  `TIER_VIAL = {assign, submit, retract, reject, reset, verify, retest, auto}` —
  **`verify` is here** (the escape hatch); `TIER_PARENT = {publish, retract, auto}`
  (parent rows are *created in* `verified` by promote, so the parent never needs a
  `verify` transition).
- **Tier discriminator** `tier_of` (`state_machine.py:163-188`): any row with
  `lims_sub_sample_pk` set is **always sub-sample tier regardless of state**.
- **Promote** (`service.py` `promote_to_parent`): creates the parent-tier row +
  `lims_analysis_promotions` link + SENAITE write-back, and **leaves the source
  sub-sample's state unchanged** (at `to_be_verified`). Only accepts `to_be_verified`
  sources (`:447-451`).
- **Retest** (`service.py:178-197`): legal on sub-sample rows from `to_be_verified`
  **or `verified`**; creates a new `unassigned` linked row (`result_value=None`).
- **FE** (`src/components/senaite/AnalysisTable.tsx`): `ALLOWED_TRANSITIONS`
  (`:130-135`) drives the row menu; `isPromotable` (`:151-158`) requires
  `to_be_verified` + `mk1:` + unpromoted; `visibleRowTransitions` (`:185-194`) and
  `bulkActionsFor` (`:205-230`) **hide `verify` for native sub-sample rows**
  (consistently, single + bulk) — so the UI never verifies a sub-sample; you Promote.
  `StatusBadge` (`:~1204`) and the filter tabs (`:~1502-1503`) still *render*
  `verified` if present.
- **DB**: `review_state` CHECK constraint enumerates the 7 states
  (`2026-06-02-mk1-native-analyses-design.md:230-234`; DDL in `backend/database.py`).
- **Tests** assert/exercise sub-sample verify: `backend/tests/test_lims_analyses_state_machine.py:221-223`
  (asserts `verify` is vial-tier-legal) and `backend/tests/test_vial_retest.py:109-112`
  (`_walk_to_verified` drives a vial to `verified`). Per the additive-only convention,
  these are the **stale side** once the behavior tightens.

## Design

### Sub-sample state machine (type-agnostic)

```
unassigned ──assign──▶ assigned ──submit*──▶ to_be_verified ──promote──▶ promoted
     └────────submit*────────────────────────────┘                          │
unassigned/assigned ──reject──▶ rejected                                     │
to_be_verified ──retract──▶ retracted   ──reject──▶ rejected                 │
to_be_verified ──retest──▶ (new unassigned row)                              │
promoted ──retest──▶ (new unassigned row)  ◀────────correction───────────────┘
assigned ──reset──▶ unassigned
```
\* `submit` requires a `result_value`.

- **New state `promoted`** — a sub-sample-tier resting/done state. Non-terminal
  (allows `retest`), otherwise final.
- **`verify` removed from the sub-sample tier.** Sub-samples can never reach
  `verified` or `published` — those are **parent-tier-only**.
- Parent workflow **unchanged** (`…created-verified → published`, admin-retract).

### Promote moves the sub-sample

`promote_to_parent` keeps doing everything it does today (create parent-tier row,
promotion link, SENAITE write-back) **and additionally transitions the source
sub-sample `to_be_verified → promoted`** in the same transaction, with an audit row
using the existing `transition_kind='auto'` and reason `"promoted to parent"` (avoids
extending the `transition_kind` CHECK with a new value). Source-state guard stays
`to_be_verified` only.

### Block sub-sample `verify` (defense in depth)

1. Remove `verify` from `_TIER_ALLOWED_KINDS[TIER_VIAL]` (`state_machine.py:116-123`).
2. Add an explicit service guard so a `verify` transition on a sub-sample-tier row is
   rejected with a clear error (covers any direct API/seeder caller). Parent-tier
   verify is unaffected (parent rows are born `verified` via promote; the parent
   never used `verify`).

### State-machine edges

- Add `promoted` to the state set and CHECK constraint.
- `_ALLOWED`: `to_be_verified → promote → promoted`; `promoted → retest` (retest is
  special-cased like today, not a plain edge). `promoted` is non-terminal.
- Retest guard (`service.py:178-181`): legal sub-sample source states become
  `to_be_verified` **or `promoted`** (replacing `verified`).

### Migration (idempotent, hand-rolled per the project convention)

- Add `promoted` to the `review_state` CHECK constraint via an idempotent
  `ALTER TABLE` (drop+recreate the constraint), mirrored in `backend/database.py`.
- **Backfill** (reflect history under the new model): sub-sample rows currently
  `to_be_verified` that **are a promotion source** (`id IN (SELECT source_analysis_id
  FROM lims_analysis_promotions)`) → set `review_state='promoted'`. (These were
  promoted under the old model but left at `to_be_verified`.)
- **Defensive**: any sub-sample row still `verified` → `promoted` if it is a promotion
  source, else `to_be_verified` (so it's promotable again). After this + the verify
  block, no sub-sample can be `verified` going forward.

### FE (`AnalysisTable.tsx`)

- **StatusBadge**: add a `promoted` variant (label "Promoted").
- **`ALLOWED_TRANSITIONS`**: add `promoted: ['retest']`; remove the sub-sample
  `verified` entry (`verified: ['retest']`) — sub-samples no longer reach it.
- **`isPromotable`** unchanged (source = `to_be_verified`). Reconcile `isPromoted` /
  the "Promoted → #" badge / `canPromote` with the new `promoted` *state* (a
  `promoted` row is not re-promotable; the badge can derive from state or the
  existing promotion record — keep both consistent).
- **Filter tabs (sub-sample views):** the "done" tab counts `promoted` (label it
  "Promoted" on sub-sample/quick-look views); "Pending" = everything pre-promote.
  Parent views keep counting `verified`+`published`.
- The `verify`-hiding branches in `visibleRowTransitions` / `bulkActionsFor` simplify
  (sub-sample `verify` no longer exists to hide).

## Behavior notes

- A sub-sample can **never** reach `verified`/`published` → the stranded-result bug
  is structurally impossible.
- **Recovery from `promoted`** = `retest` (re-run, re-promote — the standard
  correction path). Admin "un-promote" (retract that also undoes the parent row) is
  **out of scope** (follow-up).
- **Type-agnostic**: identical for vial/capsule/inhaler/gel. No new identifier bakes
  in "vial"; physical type is a separate model.
- The parent-tier row created by promote is still born `verified` (COA reads
  parent-tier verified rows) — unchanged.

## Testing

- **Update the stale tests** (`test_lims_analyses_state_machine.py:221-223`,
  `test_vial_retest.py:109-112` + its `_walk_to_verified` helper and dependents) to
  reflect: sub-sample `verify` is rejected; promote moves the source to `promoted`;
  retest is legal from `to_be_verified` and `promoted`.
- **New backend tests:** promote transitions source `to_be_verified → promoted` (+
  audit row); `verify` on a sub-sample-tier row is rejected (tier matrix + service
  guard); retest from `promoted`; migration backfill (`to_be_verified` + promotion
  source → `promoted`; defensive `verified` handling); CHECK constraint accepts
  `promoted`.
- **FE:** `promoted` StatusBadge renders; `ALLOWED_TRANSITIONS.promoted` exposes
  retest; filter-tab counts treat `promoted` as done on sub-sample views.

## Files (anticipated; exact anchors pinned at plan time)

- `backend/lims_analyses/state_machine.py` — state set, `_ALLOWED`,
  `_TIER_ALLOWED_KINDS` (remove sub-sample `verify`; add `promoted`).
- `backend/lims_analyses/service.py` — `promote_to_parent` (move source → `promoted`);
  sub-sample `verify` guard; retest source states.
- `backend/database.py` + migration — `review_state` CHECK + idempotent ALTER +
  backfill.
- `src/components/senaite/AnalysisTable.tsx` — StatusBadge, `ALLOWED_TRANSITIONS`,
  `isPromoted`/badge reconcile, filter tabs, verify-hiding cleanup.
- `backend/tests/…` — update stale, add new.

## Out of scope

- The physical **sample-type/form model** (capsule / inhaler / gel) and the
  `vial`→generic vocabulary rename (`vial_sequence`, `VialsQuickLook`,
  `InboxVialCard`, "Vial N of M", …) — its own spec.
- **Admin un-promote / retract-from-`promoted`** that undoes the parent row — follow-up.
- **Parent-outcome mirroring** onto the sub-sample (the rejected "Approach C") — follow-up.
- The two unpushed features on `subvial/continue` (inbox filters, parent-analyses
  vial-assignment overlay) — separate, already complete.
