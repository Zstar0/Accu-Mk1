# Spec: Explicit variance-bucket assignment (vial-based variance workflow)

*2026-06-10. Replace the implicit, demand-math variance model with **explicit per-vial
assignment**: at check-in, a vial is dragged into a core bench bucket (HPLC / Endo /
Sterility) **or** its Variance sub-bucket. The assignment — not the customer's purchased
entitlement — determines the workflow path: core → promote, variance → `variance_verify`.
Supersedes the implicit parts of `2026-06-10-variance-testing-addon-design.md` and the
gating in `2026-06-10-variance-gated-indicator-design.md`. Sequenced ahead of, and
compatible with, the future vial-based "parent-as-grouping-master" model.*

## Why

The implicit variance model (`max(base, n)` demand, "all same-role vials are equal," no
per-vial designation, promotion guesses the canonical) is the root cause of a cluster of
problems hit across this arc:

- A variance replicate shows **"Ready to Promote"** because the system can't tell it from
  a canonical candidate; the flip to "Ready to Verify" is gated on the *parent line being
  verified* (`varianceReady = canVarVerify && locked`, `AnalysisTable.tsx`), which is late
  and confusing — the ⋯ menu offers **both** Promote and Verify (Variance) at once.
- Sign-off is gated on **commercial entitlement** (`ensure_variance_entitlement`, fail-
  closed), which forced fragile entitlement-on-parent-page wiring and a per-row-role
  classification problem (fixed today at `829ce36`, but symptomatic).
- The workflow has no clean way to **re-assign** a vial (Variance ↔ core, → Xtra).

Making variance an **explicit per-vial assignment** makes the workflow path a pure
function of current assignment: deterministic, re-assignable, no lock-waiting, no
mixed affordances.

## Decisions (from brainstorming)

- **Assignment is operational and free** — the lab assigns vials to variance buckets
  regardless of what the WP order purchased (e.g. internal QC replicates). Commercial
  entitlement becomes an **informational marker** on the Assignment page (which assigned
  vials are "part of the paid product"), **never a gate**, but stays visible/auditable.
- **The parent is the canonical** (its own HPLC run); variance vials verify directly and
  **never wait on the parent row**. The plain core bucket is for retest/canonical-
  candidate vials that promote to the parent.
- **Re-assignment** re-routes the path live; **artifacts are preserved** (no auto-reset);
  manual cleanup now, **auto-cleanup rules deferred**; a **locked** variance set blocks
  re-assignment.
- **Sequenced** ahead of the vial-based parent-as-container north star; this spec must not
  block it (`assignment_kind` carries forward).

## What already exists (verified)

- `assignment_role` ∈ {hplc, endo, ster, xtra, null} drives bench routing + analyte mirror
  (`models.py`). Set at check-in via `AssignStep` drag + `auto_assign`/`compute_vial_plan`.
- `lims_sub_samples.in_variance_set` / `lims_samples.in_variance_set` (default TRUE) — the
  **stats-inclusion** flag for `compute_variance_stats` (mean/SD/CV%), with
  `variance_exclusion_reason` for dropping outliers (`variance.py:32-33`). **Orthogonal to
  workflow routing — must not be reused for the bucket assignment.**
- `lims_samples.variance_override` (JSON `{service_key: n}`) — the lab-set purchased count,
  surfaced via `/variance-entitlement` and (this arc) the aggregates `variance` map.
- Lifecycle: `variance_verified` state + `variance_verify` transition exist; today gated by
  `ensure_variance_entitlement` (commercial). `isPromotable` is variance-blind
  (`AnalysisTable.tsx:176`). AssignStep already renders presentational `HPLC · x/y` /
  `VARIANCE · x/y` count lines (`VarianceCountLines`) — this spec makes the variance line a
  real drop target.

## Design

### 1. Data model

- New column `lims_sub_samples.assignment_kind` — enum `'core' | 'variance'`, **nullable**,
  **default NULL** (a freshly received vial has no kind until check-in assigns it).
  Distinct from `in_variance_set`. Bench routing stays on `assignment_role`: a variance
  HPLC vial is `assignment_role='hplc'` + `assignment_kind='variance'` and still routes to
  the HPLC bench with the full analyte mirror.
- Idempotent migration (Mk1 convention — `database.py` hand-rolled `ALTER TABLE ... ADD
  COLUMN IF NOT EXISTS`). **Backfill:** existing vials with a non-null `assignment_role`
  → `assignment_kind='core'` (preserves today's promote-path behavior); unassigned vials
  (`role` null) stay NULL. `variance_override` is untouched (becomes the paid-count
  display). PB-0076 is dev/test data — the lab re-assigns it under the new buckets.
- Enum (not boolean) is deliberate: future-proof for the vial-based model (a third kind
  could appear) and reads clearly in the API/UI.

### 2. AssignStep — explicit drop zones

- Analysis Dept renders `HPLC` + `HPLC Variance` drop zones; Microbiology renders
  `Endo` / `Endo Variance` and `Sterility` / `Sterility Variance`. Dropping into a core
  zone sets `(role, kind='core')`; into a Variance zone sets `(role, kind='variance')`.
  Xtra/unassigned set `kind=NULL`.
- **Auto-assign** fills core zones to base demand first, then variance zones up to the
  purchased count; the tech overrides by dragging. (Auto-assign heuristic may be refined
  in the plan — manual drag is always authoritative.)
- **Entitlement marker:** each Variance zone shows the purchased count as an informational
  target (e.g. `Variance · paid 2`) and visually marks which assigned variance vials are
  within the paid allotment vs extra QC. Over/under is shown as a count, **never blocks**.
- Demand/targets: core demand = base (HPLC 1, Endo 1, Ster 2); variance target = purchased
  count (informational). Replaces the `max(base, n)` single-bucket inflation.

### 3. Lifecycle — two paths keyed off `assignment_kind`

- `assignment_kind='variance'` → **verify path**: offers `variance_verify` (requires a
  result + `to_be_verified`); **`isPromotable` returns false**; **no parent-lock
  dependency** — this removes the "Ready to Promote on a variance row" confusion. Badge
  reads "Ready to Verify" / "Verified — Variance" with no `locked` gate.
- `assignment_kind='core'` (or NULL with a role) → **promote path** as today.
- **Sign-off gate moves from entitlement to assignment:** `variance_verify` is allowed
  when the host vial's `assignment_kind='variance'`. `ensure_variance_entitlement` is
  **retired as the gate**; commercial entitlement is display-only. (The backend still
  validates state/result/tier and that the row is sub-hosted.)

### 4. Indicators re-keyed

- The membership chip, analysis-table vial-name treatment, and SenaiteDashboard parent
  flag / sub-name treatment **re-key off `assignment_kind='variance'`** instead of
  parent-scoped entitlement. This is simpler and retires the fragile entitlement-on-parent-
  page wiring (`vialListVarianceEntitlement`, the per-row-role classification). The
  dashboard aggregates `variance` map can carry per-vial kind instead of the bucket-count
  map, or be dropped in favor of the sub-sample's own `assignment_kind`.

### 5. Re-assignment

- Dragging a vial between buckets updates `(assignment_role, assignment_kind)`; the
  workflow path recomputes from the new value. **Artifacts (results/analyses) are
  preserved** — no auto-reset of lifecycle state. Manual cleanup (add/remove analysis
  services) is available now; **automatic cleanup rules are deferred** to a follow-up.
- A **locked** variance set (`variance_locked_at`) blocks re-assignment of its members
  (consistent with the lock's purpose).

### 6. Parent

Stays the canonical (its own run); it is not a sub-vial and has no `assignment_kind`.
`in_variance_set` (stats inclusion) is unchanged.

## Out of scope

- The vial-based parent-as-grouping-master model (separate north-star arc). This spec keeps
  parent-as-canonical and only adds `assignment_kind` to sub-vials.
- Automatic cleanup rules when re-assigning vials with existing artifacts (deferred).
- WP addon emitting the purchased map (the override remains the interim source).
- COA variance-statistics rendering (own spec).

## Migration / compatibility notes

- Supersedes the implicit demand math (`derive_demand` `max()`) and the commercial sign-off
  gate; both are replaced, not extended — this is an intentional re-architecture of the
  variance model (noted against the usual additive-only rule).
- `assignment_kind` carries forward unchanged into the future vial-based model.

## Open items for the plan

- Exact `auto_assign` variance-fill heuristic (fill core then variance to paid count).
- Whether the aggregates `variance` map is replaced by per-vial `assignment_kind` or kept.
- Backend transition-gate wording + which existing variance tests are superseded vs kept.
