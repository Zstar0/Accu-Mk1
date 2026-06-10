# Spec: Variance sub-sample name treatment (analysis table + AR list)

*2026-06-10. Denote which sub-samples are variance replicates by treating the
sub-sample NAME itself as the signal — sky-colored text + a small icon — wherever
sub-sample names render. Two surfaces: the analysis-table first-column vial list
(pure FE) and the SenaiteDashboard AR list (needs a small, cheap backend data add).
Builds on the variance addon (`2026-06-10-variance-testing-addon-design.md`) and the
variance-gated indicator (`2026-06-10-variance-gated-indicator-design.md`), reusing
its `showVarianceChip` predicate and sky visual language.*

## Why

After the variance-gated indicator shipped, variance is visible as a chip on analysis
*rows* and a pill on the AssignStep bucket — but not where users scan sub-sample names:
the analysis-table first column (which lists each analysis's contributing vials,
"Vial 6 — PB-0076-S05") and the AR list (SenaiteDashboard). Marking the name directly
is the most legible "which sub-samples are variance" signal.

## Decisions (from brainstorming)

- **Treatment:** sky text color + a small leading icon on the sub-sample name. No new
  badge — the name is the signal. Reuses the sky family from the chip/pill.
- **Surfaces:** both the analysis-table first-column vial list AND the SenaiteDashboard
  (parent-row flag + per-sub name treatment in the expand).
- **Semantics differ by surface granularity (intentional, documented):**
  - **Analysis table** lists vials *per analysis row* — each vial carries its own
    `mk1Analysis`, so we apply the precise `showVarianceChip` rule (variance member,
    **un-promoted**, not `variance_verified`). The promoted/canonical vial (the one with
    the "↑ from" badge) stays plain.
  - **SenaiteDashboard** lists sub-samples as *vials* (one vial hosts many analyses);
    the payload has no per-keyword promotion state, and a vial isn't cleanly "promoted."
    So the dashboard uses **membership-level** marking: the parent purchased variance for
    the vial's role bucket. This is a coarser at-a-glance hint, consistent with the
    dashboard being a list view; the authoritative, promotion-aware view is the analysis
    table.

## What already exists (verified)

- `showVarianceChip(a, vialRole, entitlement)` (`AnalysisTable.tsx:231`): member +
  not promoted + not `variance_verified`. `ROLE_VARIANCE_KEYS` (`:187`).
- Analysis-table first-column vial list: `vialAssign.matches.map(m => <button>…</button>)`
  (`AnalysisTable.tsx:1263-1273`); each `m: VialMatch` has `vialSampleId`, `vialLabel`,
  `mk1Analysis: SenaiteAnalysis` (`lib/vial-assignment.ts:57`). The row already has
  `vialRole` (=`primaryRole`) and `varianceEntitlement` props; the row chip uses them.
- `varianceEntitlement` is parent-scoped, already fetched on SampleDetails / QuickLook.
- SenaiteDashboard (`SenaiteDashboard.tsx`): parent rows (Sample ID cell `:449`, Vials
  `:450`, Assigned role badge `:467`), expand-in-row sub list (`:555-578`, sub name at
  `:567`). Per-parent `agg = aggregates[s.id]` (`ParentAggregate`). Subs loaded via
  `listSubSamples` (`SubSample` has `assignment_role`, no variance/promotion fields).
- Backend `aggregate_by_parent` (`sub_samples/service.py:904`): single batched SQL,
  no WP calls. `derive_variance_demand({"variance": <map>})` (`:576`) → `{hplc,endo,ster}`
  bucket counts via `VARIANCE_BUCKET_KEYS` + `normalize_variance_entitlement` (int ≥2).
- `lims_samples.variance_override` (TEXT JSON `{service_key: n}`) is the only variance
  source today (WP emits none until Phase 3); read directly here. Authoritative gate
  stays server-side at sign-off (fail-closed) — this is a display hint.

## Design

### 1. Backend — per-parent variance map on aggregates (Surface B data)

- `aggregate_by_parent` (`service.py:904`): add `LimsSample.variance_override` to the
  path-1 parent `select(...)`. For each parent row, parse the override JSON
  (`json.loads(override or "{}")`, guard exceptions → `{}`) and compute
  `variance = derive_variance_demand({"variance": parsed})` → `{hplc,endo,ster}`.
  Add `"variance": variance` to the path-1 result dict. Path-2 (sub-as-search-hit)
  rows get `"variance": {"hplc": 0, "endo": 0, "ster": 0}`.
- `ParentAggregate` schema (`sub_samples/schemas.py:85`): add
  `variance: dict[str, int] = Field(default_factory=lambda: {"hplc": 0, "endo": 0, "ster": 0}, …)`.
- Route (`routes.py:160`) is `ParentAggregate(**agg)` — flows through unchanged once the
  dict carries `variance`.
- **Caveat (documented in code):** reads `variance_override` directly, not the
  `fetch_sample_services` chokepoint. Identical today (override is the sole source);
  Phase 3 extends this to WP-sourced variance.

### 2. Frontend — analysis-table first-column vial treatment (Surface A, pure FE)

- `AnalysisTable.tsx:1263-1273`: for each `m`, compute
  `const vialIsVariance = showVarianceChip(m.mk1Analysis, vialRole, varianceEntitlement)`.
  When true, the vial button gets sky text (`text-sky-600 dark:text-sky-400`, replacing
  the `text-muted-foreground`) and a small leading `Layers` icon (lucide, `className="h-3 w-3"`);
  `title` becomes "Variance replicate". When false, render exactly as today.
- No new props (row already has `vialRole` + `varianceEntitlement`). No new fetch.
- Import `Layers` from `lucide-react` (existing import line `:2`).

### 3. Frontend — SenaiteDashboard treatment (Surface B)

- `lib/api.ts` `ParentAggregate` (`:5085`): add
  `variance?: { hplc: number; endo: number; ster: number }`.
- Two exported pure predicates in `SenaiteDashboard.tsx` (for testability):
  ```ts
  export function parentHasVariance(agg: ParentAggregate | undefined): boolean {
    const v = agg?.variance
    return !!v && (v.hplc >= 2 || v.endo >= 2 || v.ster >= 2)
  }
  export function subIsVarianceMember(sub: SubSample, agg: ParentAggregate | undefined): boolean {
    const role = sub.assignment_role
    if (role !== 'hplc' && role !== 'endo' && role !== 'ster') return false
    return (agg?.variance?.[role] ?? 0) >= 2
  }
  ```
- **Parent row** (Sample ID cell `:449`): when `parentHasVariance(agg)`, prepend a small
  sky `Layers` icon (`h-3 w-3 text-sky-500`, `title="Has variance testing"`) before
  `{s.id}`. Sample ID text stays its normal color (the parent isn't itself a replicate).
- **Expanded sub name** (`:567`): when `subIsVarianceMember(sub, agg)`, the sub name gets
  sky text + a small leading `Layers` icon; otherwise unchanged.
- `Layers` imported from lucide (the file already imports `ChevronDown`/`ChevronRight`).

## Out of scope

- Promotion-aware suppression in the dashboard (per-vial granularity can't express it;
  membership-level is intentional — see Decisions).
- WP-sourced variance in the list (Phase 3 extends the aggregates read).
- Changing `showVarianceChip` / the variance gate / any backend transition logic.
- The existing row chip / bucket pill (unchanged).

## Testing

- **Backend (new `tests/test_variance_aggregate.py`, ZZTEST fixtures + teardown per the
  live-DB rule):** a ZZTEST parent in `lims_samples` with one sub-sample and
  `variance_override = '{"hplcpurity_identity": 2}'` → `aggregate_by_parent` returns
  `variance == {"hplc": 2, "endo": 0, "ster": 0}`; a parent with no override →
  `{"hplc":0,"endo":0,"ster":0}`. Assert ZZTEST count = 0 after teardown.
- **Backend route (`test_sub_samples_routes.py`):** extend the mocked aggregates test so
  the mocked return includes `variance`; assert it serializes in the response.
- **FE dashboard (new `src/test/dashboard-variance.test.tsx`):** unit-test
  `parentHasVariance` (true when any bucket ≥2; false on undefined / all-zero) and
  `subIsVarianceMember` (true for an entitled role; false for xtra/unassigned/null role
  and zero entitlement).
- **FE analysis table:** the vial treatment is a presentational conditional on the
  already-unit-tested `showVarianceChip`; covered by its existing tests +
  live verification (no new logic to unit-test).
- **Live (stack, PB-0076, HPLC override n=2):** S06 vial name sky+icon in the analysis
  table first column, S05 (promoted) plain; PB-0076 parent row in the AR list shows the
  variance icon; expanding shows S05/S06 names treated per membership.
- Pre-existing failures baselined per project rule (FE `App.test.tsx`,
  `peptide-requests-list.test.tsx`; backend `test_sub_samples_service.py` ×5 etc.).

## Build order

1. **Backend** — aggregates `variance` map (§1): service + schema + tests.
2. **FE Surface A** — analysis-table first-column vial treatment (§2).
3. **FE Surface B** — `ParentAggregate` type + dashboard predicates, parent flag, sub
   name treatment (§3).

Each task: tests + per-task commit
(`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`).
