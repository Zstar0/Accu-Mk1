# Variance Sub-Sample Name Treatment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark variance sub-samples by treating the sub-sample NAME (sky text + a small `Layers` icon) wherever names render — the analysis-table first-column vial list and the SenaiteDashboard AR list.

**Architecture:** Surface A (analysis table) is pure FE, reusing the already-tested `showVarianceChip` predicate per vial (precise: un-promoted replicates only). Surface B (SenaiteDashboard) needs a cheap per-parent `variance` bucket map added to the existing batched `aggregate_by_parent` SQL (read directly from `lims_samples.variance_override` — one extra column, no WP calls), then a parent-row flag + membership-level per-sub name treatment. The two surfaces differ in semantics by data granularity (per-row vs per-vial), documented in the spec.

**Tech Stack:** FastAPI + SQLAlchemy (Python), React + TypeScript, Vitest + pytest. Stack containers `accumark-subvial-*` (FE :5532, API :5530 with `--reload`, Postgres `accumark_mk1`).

**Spec:** `docs/superpowers/specs/2026-06-10-variance-subsample-name-treatment-design.md`

---

## File Structure

- `backend/sub_samples/service.py` — `aggregate_by_parent`: add `variance_override` to the parent query + a `_variance_buckets_from_override` helper; add `variance` to each result dict.
- `backend/sub_samples/schemas.py` — `ParentAggregate`: add `variance` field (default zeros).
- `backend/tests/test_variance_aggregate.py` — NEW; ZZTEST live-DB test for the variance map.
- `backend/tests/test_sub_samples_routes.py` — extend the mocked aggregates test for `variance` passthrough.
- `src/components/senaite/AnalysisTable.tsx` — Surface A: per-vial treatment in the first-column list.
- `src/lib/api.ts` — `ParentAggregate` type: add `variance`.
- `src/components/senaite/SenaiteDashboard.tsx` — Surface B: `parentHasVariance` / `subIsVarianceMember` predicates, parent-row flag, sub-name treatment.
- `src/test/dashboard-variance.test.tsx` — NEW; unit tests for the two predicates.

## Conventions

- Per-task commit, footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- FE tests: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run <path>"`.
- Backend tests: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest <path> -q"`. Backend service tests hit the LIVE `accumark_mk1` DB — use ZZTEST fixtures + teardown; after the run assert no ZZTEST rows remain.
- Additive-only; baseline UNRELATED pre-existing failures against the prior commit (FE: `App.test.tsx`, `peptide-requests-list.test.tsx`; backend `test_sub_samples_service.py` ×5 create_sub_sample_* etc.). Do NOT stage the pre-existing dirty `package-lock.json`.
- `AnalysisTable.tsx` does NOT import `cn` — build conditional classNames with template literals (match the file's existing style). `SenaiteDashboard.tsx` likewise uses template-literal classNames.

---

## Task 1: Backend — per-parent variance map on aggregates

**Files:**
- Modify: `backend/sub_samples/service.py` (`aggregate_by_parent`, ~line 904-961)
- Modify: `backend/sub_samples/schemas.py` (`ParentAggregate`, ~line 85-97)
- Create: `backend/tests/test_variance_aggregate.py`
- Modify: `backend/tests/test_sub_samples_routes.py` (the mocked aggregates test, ~line 323)

- [ ] **Step 1: Write the failing backend tests**

Create `backend/tests/test_variance_aggregate.py`:

```python
"""Aggregates endpoint surfaces a per-parent variance bucket map (read directly
from lims_samples.variance_override). Service test runs against the LIVE
accumark_mk1 DB: ZZTEST-AGGV fixtures with explicit teardown."""
from datetime import datetime

import pytest
from sqlalchemy import text

from database import SessionLocal
from sub_samples import service as sub_service
from models import LimsSample, LimsSubSample


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _make_parent(db, sample_id, override):
    parent = LimsSample(
        sample_id=sample_id, peptide_name="ZZ Agg", status="received",
        assignment_role="hplc", variance_override=override,
    )
    db.add(parent)
    db.flush()
    db.add(LimsSubSample(
        sample_id=f"{sample_id}-S01", parent_sample_pk=parent.id,
        vial_sequence=1, received_at=datetime.utcnow(), assignment_role="hplc",
        external_lims_uid=f"zz-uid-aggv-{sample_id}-s01",
    ))
    db.commit()


@pytest.fixture()
def aggv_fixture(db):
    _make_parent(db, "ZZTEST-AGGV-ON", '{"hplcpurity_identity": 2}')
    _make_parent(db, "ZZTEST-AGGV-OFF", None)
    yield
    db.rollback()
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-AGGV%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-AGGV%'"))
    db.commit()


def test_variance_map_reflects_override(db, aggv_fixture):
    out = sub_service.aggregate_by_parent(db, ["ZZTEST-AGGV-ON", "ZZTEST-AGGV-OFF"])
    assert out["ZZTEST-AGGV-ON"]["variance"] == {"hplc": 2, "endo": 0, "ster": 0}
    assert out["ZZTEST-AGGV-OFF"]["variance"] == {"hplc": 0, "endo": 0, "ster": 0}


def test_no_zztest_residue(db, aggv_fixture):
    pass  # teardown asserted below


def test_zztest_cleaned(db):
    n = db.execute(text(
        "SELECT count(*) FROM lims_samples WHERE sample_id LIKE 'ZZTEST-AGGV%'"
    )).scalar_one()
    assert n == 0
```

- [ ] **Step 2: Run to verify failure**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_aggregate.py -q"`
Expected: FAIL — `KeyError: 'variance'` (the dict doesn't carry it yet).

- [ ] **Step 3: Implement the service change**

In `backend/sub_samples/service.py`, add a helper just above `aggregate_by_parent` (line ~904). `json` is already imported in this module and `derive_variance_demand` is defined earlier (line ~576), so both are in scope:

```python
def _variance_buckets_from_override(override: Optional[str]) -> dict:
    """Bucket map {hplc,endo,ster} from a parent's variance_override JSON.
    Direct override read (NOT the fetch_sample_services chokepoint) — identical
    today since WP emits no variance until Phase 3; this is an AR-list display
    hint, not the authoritative sign-off gate (which stays server-side)."""
    try:
        parsed = json.loads(override) if override else {}
    except (ValueError, TypeError):
        parsed = {}
    return derive_variance_demand({"variance": parsed})
```

Then change the path-1 query and loop. Replace the existing `parent_rows = db.execute(...)` select + its `for` loop (lines ~929-945) with:

```python
    parent_rows = db.execute(
        select(
            LimsSample.sample_id,
            LimsSample.assignment_role,
            LimsSample.variance_override,
            func.count(LimsSubSample.id).label("sub_count"),
        )
        .outerjoin(LimsSubSample, LimsSubSample.parent_sample_pk == LimsSample.id)
        .where(LimsSample.sample_id.in_(parent_sample_ids))
        .group_by(
            LimsSample.sample_id,
            LimsSample.assignment_role,
            LimsSample.variance_override,
        )
    ).all()
    for sample_id, parent_role, variance_override, sub_count in parent_rows:
        if sub_count == 0:
            continue
        result[sample_id] = {
            "vial_count": sub_count + 1,
            "parent_role": parent_role or "hplc",
            "variance": _variance_buckets_from_override(variance_override),
        }
```

And in the path-2 loop (sub-as-search-hit, lines ~955-959), add a zero variance map:

```python
        for sample_id, role in sub_rows:
            result[sample_id] = {
                "vial_count": 0,
                "parent_role": role or "unassigned",
                "variance": {"hplc": 0, "endo": 0, "ster": 0},
            }
```

- [ ] **Step 4: Update the schema**

In `backend/sub_samples/schemas.py`, add to `ParentAggregate` (after `parent_role`, ~line 97):

```python
    variance: dict[str, int] = Field(
        default_factory=lambda: {"hplc": 0, "endo": 0, "ster": 0},
        description="Per-bucket variance counts (total replicates incl. canonical) "
                    "read from the parent's variance_override. Zeros when none. "
                    "AR-list display hint — the authoritative gate is server-side "
                    "at sign-off (fail-closed).",
    )
```

- [ ] **Step 5: Extend the route passthrough test**

In `backend/tests/test_sub_samples_routes.py`, in `test_aggregates_returns_count_and_parent_role_per_parent` (~line 323), update the mocked return value and add an assertion. Change the mocked dict to include `variance` and assert it serializes:

```python
        fn.return_value = {
            "BW-0006": {"vial_count": 4, "parent_role": "hplc",
                        "variance": {"hplc": 2, "endo": 0, "ster": 0}},
        }
```

and after the existing assertions add:

```python
    assert aggs["BW-0006"]["variance"] == {"hplc": 2, "endo": 0, "ster": 0}
```

- [ ] **Step 6: Run to verify pass**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_aggregate.py tests/test_sub_samples_routes.py -q"`
Expected: PASS (baseline any unrelated pre-existing red in `test_sub_samples_routes.py` against the prior commit). Confirm `ZZTEST-AGGV` count is 0 (the `test_zztest_cleaned` case).

- [ ] **Step 7: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/sub_samples/service.py backend/sub_samples/schemas.py backend/tests/test_variance_aggregate.py backend/tests/test_sub_samples_routes.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(variance): per-parent variance map on aggregates endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: FE Surface A — analysis-table first-column vial treatment

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx` (import `Layers`; the vial list map ~line 1263-1273)

- [ ] **Step 1: Add the `Layers` icon import**

In `src/components/senaite/AnalysisTable.tsx`, the lucide import is line 2:
`import { Activity, ArrowDownUp, ArrowUpDown, Check, ChevronDown, ChevronRight, Database, HelpCircle, Lock, MoreHorizontal, Pencil, X } from 'lucide-react'`
Add `Layers` to that list (alphabetical-ish, e.g. after `HelpCircle`):

```tsx
import { Activity, ArrowDownUp, ArrowUpDown, Check, ChevronDown, ChevronRight, Database, HelpCircle, Layers, Lock, MoreHorizontal, Pencil, X } from 'lucide-react'
```

- [ ] **Step 2: Apply the treatment to each vial match**

Replace the vial list block (lines ~1263-1273):

```tsx
          {vialAssign && vialAssign.matches.map(m => (
            <button
              key={m.vialSampleId}
              type="button"
              onClick={e => { e.stopPropagation(); useUIStore.getState().navigateToSample(m.vialSampleId) }}
              className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 shrink-0"
              title={`Assigned to ${m.vialSampleId}`}
            >
              {m.vialLabel} — {m.vialSampleId}
            </button>
          ))}
```

with (computes `showVarianceChip` per vial; sky text + `Layers` icon when it's an un-promoted variance replicate):

```tsx
          {vialAssign && vialAssign.matches.map(m => {
            const vialIsVariance = showVarianceChip(m.mk1Analysis, vialRole, varianceEntitlement)
            return (
              <button
                key={m.vialSampleId}
                type="button"
                onClick={e => { e.stopPropagation(); useUIStore.getState().navigateToSample(m.vialSampleId) }}
                className={`inline-flex items-center gap-0.5 text-[10px] underline underline-offset-2 shrink-0 ${
                  vialIsVariance
                    ? 'text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={vialIsVariance ? `Variance replicate — ${m.vialSampleId}` : `Assigned to ${m.vialSampleId}`}
              >
                {vialIsVariance && <Layers className="h-3 w-3" />}
                {m.vialLabel} — {m.vialSampleId}
              </button>
            )
          })}
```

(`showVarianceChip`, `vialRole`, and `varianceEntitlement` are all already in scope inside `AnalysisRow` — the row chip already uses them.)

- [ ] **Step 3: Verify the existing analysis-table suites stay green**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/variance-verify-gating.test.tsx src/test/vials-quicklook.test.tsx"`
Expected: PASS. (No new unit test — the treatment is a presentational conditional on the already-tested `showVarianceChip`; verified live in the final step.)

- [ ] **Step 4: Typecheck**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx tsc --noEmit"`
Expected: no NEW errors in `AnalysisTable.tsx` (the pre-existing `WorksheetsInboxPage.tsx` error is unrelated).

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/components/senaite/AnalysisTable.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(variance): sky name + icon on variance vials in analysis-table first column

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: FE Surface B — SenaiteDashboard parent flag + sub-name treatment

**Files:**
- Modify: `src/lib/api.ts` (`ParentAggregate`, ~line 5085)
- Modify: `src/components/senaite/SenaiteDashboard.tsx` (predicates + parent row ~line 449 + sub row ~line 567; import `Layers`)
- Create: `src/test/dashboard-variance.test.tsx`

- [ ] **Step 1: Extend the `ParentAggregate` type**

In `src/lib/api.ts`, `ParentAggregate` (~line 5085) — add the `variance` field:

```ts
export interface ParentAggregate {
  /** Total vials = parent + sub-samples. Parents with no sub-samples
   *  are omitted from the response entirely (caller treats absence as
   *  "single-vial; render a dash"). */
  vial_count: number
  /** The parent AR's own assignment_role. Sub-sample roles are surfaced
   *  inline on expand via /api/sub-samples/{parent}, not here. */
  parent_role: 'hplc' | 'endo' | 'ster' | 'xtra' | 'unassigned'
  /** Per-bucket variance counts from the parent's variance_override (zeros when
   *  none). AR-list display hint; authoritative gate is server-side. Optional
   *  for back-compat with older responses. */
  variance?: { hplc: number; endo: number; ster: number }
}
```

- [ ] **Step 2: Write the failing predicate tests**

Create `src/test/dashboard-variance.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { parentHasVariance, subIsVarianceMember } from '@/components/senaite/SenaiteDashboard'
import type { ParentAggregate, SubSample } from '@/lib/api'

const agg = (variance?: ParentAggregate['variance']): ParentAggregate =>
  ({ vial_count: 2, parent_role: 'hplc', variance }) as ParentAggregate

const sub = (role: SubSample['assignment_role']): SubSample =>
  ({ id: 1, sample_id: 'P-1-S01', parent_sample_id: 'P-1', vial_sequence: 1,
     received_at: '', received_by_user_id: null, photo_external_uid: null,
     remarks: null, assignment_role: role }) as SubSample

describe('parentHasVariance', () => {
  it('true when any bucket >= 2', () => {
    expect(parentHasVariance(agg({ hplc: 2, endo: 0, ster: 0 }))).toBe(true)
    expect(parentHasVariance(agg({ hplc: 0, endo: 3, ster: 0 }))).toBe(true)
  })
  it('false for all-zero, undefined variance, or undefined agg', () => {
    expect(parentHasVariance(agg({ hplc: 0, endo: 0, ster: 0 }))).toBe(false)
    expect(parentHasVariance(agg(undefined))).toBe(false)
    expect(parentHasVariance(undefined)).toBe(false)
  })
})

describe('subIsVarianceMember', () => {
  it('true when the sub role bucket has variance >= 2', () => {
    expect(subIsVarianceMember(sub('hplc'), agg({ hplc: 2, endo: 0, ster: 0 }))).toBe(true)
    expect(subIsVarianceMember(sub('endo'), agg({ hplc: 0, endo: 2, ster: 0 }))).toBe(true)
  })
  it('false for wrong role bucket, xtra/unassigned/null role, or no variance', () => {
    expect(subIsVarianceMember(sub('endo'), agg({ hplc: 2, endo: 0, ster: 0 }))).toBe(false)
    expect(subIsVarianceMember(sub('xtra'), agg({ hplc: 2, endo: 0, ster: 0 }))).toBe(false)
    expect(subIsVarianceMember(sub('unassigned'), agg({ hplc: 2, endo: 0, ster: 0 }))).toBe(false)
    expect(subIsVarianceMember(sub(null), agg({ hplc: 2, endo: 0, ster: 0 }))).toBe(false)
    expect(subIsVarianceMember(sub('hplc'), agg(undefined))).toBe(false)
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/dashboard-variance.test.tsx"`
Expected: FAIL — `parentHasVariance` / `subIsVarianceMember` not exported.

- [ ] **Step 4: Add the predicates + `Layers` import**

In `src/components/senaite/SenaiteDashboard.tsx`, add `Layers` to the lucide import (the file imports `ChevronDown`, `ChevronRight`, etc.). Then add the two exported predicates near the top of the module (after imports, before the component):

```tsx
/** True when a parent AR has variance testing on any bucket (display flag). */
export function parentHasVariance(agg: ParentAggregate | undefined): boolean {
  const v = agg?.variance
  return !!v && (v.hplc >= 2 || v.endo >= 2 || v.ster >= 2)
}

/** True when a sub-sample vial's role bucket has variance on its parent.
 *  Membership-level (the AR-list is a vial view; promotion is per-analysis and
 *  isn't expressible per vial — see spec "Decisions"). */
export function subIsVarianceMember(sub: SubSample, agg: ParentAggregate | undefined): boolean {
  const role = sub.assignment_role
  if (role !== 'hplc' && role !== 'endo' && role !== 'ster') return false
  return (agg?.variance?.[role] ?? 0) >= 2
}
```

- [ ] **Step 5: Run to verify the predicate tests pass**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/dashboard-variance.test.tsx"`
Expected: PASS.

- [ ] **Step 6: Parent-row flag**

In the parent row's Sample ID cell (line ~449), which is currently:

```tsx
              <TableCell className="font-mono text-sm">{s.id}</TableCell>
```

replace with a leading sky `Layers` icon when the parent has variance:

```tsx
              <TableCell className="font-mono text-sm">
                <span className="inline-flex items-center gap-1">
                  {parentHasVariance(agg) && (
                    <Layers className="h-3 w-3 text-sky-500 shrink-0" aria-label="Has variance testing" />
                  )}
                  {s.id}
                </span>
              </TableCell>
```

(`agg` is already in scope at this point — `const agg = aggregates[s.id]`, line ~438.)

- [ ] **Step 7: Sub-name treatment in the expand**

In the expanded sub list, the sub name is rendered at line ~567:

```tsx
                              <span className="font-mono">{sub.sample_id}</span>
```

replace with sky text + a `Layers` icon when the sub is a variance member (`agg` for this parent is in scope in the expand render — it's the same `const agg = aggregates[s.id]`):

```tsx
                              <span className={`font-mono inline-flex items-center gap-1 ${
                                subIsVarianceMember(sub, agg) ? 'text-sky-600 dark:text-sky-400' : ''
                              }`}>
                                {subIsVarianceMember(sub, agg) && <Layers className="h-3 w-3 shrink-0" />}
                                {sub.sample_id}
                              </span>
```

IMPORTANT: confirm `agg` is in scope inside the expanded-row render. The expansion is rendered within the same `sortedSamples.map(s => { const agg = aggregates[s.id]; ... })` closure (line ~437-438), so `agg` is available. If the expand JSX is in a separate scope, pass `agg` down or re-read `aggregates[s.id]`. Read lines ~437-585 to confirm before editing.

- [ ] **Step 8: Run dashboard test + typecheck**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/dashboard-variance.test.tsx src/test/senaite-lookup-map.test.tsx"`
Expected: PASS.
Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx tsc --noEmit"`
Expected: no NEW errors in `SenaiteDashboard.tsx` or `api.ts`.

- [ ] **Step 9: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/lib/api.ts src/components/senaite/SenaiteDashboard.tsx src/test/dashboard-variance.test.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(variance): variance flag + sub-name treatment in SenaiteDashboard AR list

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] Backend variance suites: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_variance_aggregate.py tests/test_variance_demand.py tests/test_sub_samples_routes.py -q"` → green except documented pre-existing.
- [ ] Full FE suite: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run"` → only the 2 documented pre-existing failures.
- [ ] ZZTEST residue: `docker exec accumark-subvial-postgres psql -U postgres -d accumark_mk1 -t -c "SELECT count(*) FROM lims_samples WHERE sample_id LIKE 'ZZTEST%'"` → 0.
- [ ] Live (stack, PB-0076, HPLC override n=2; HMR unreliable — `Ctrl+Shift+R`):
  - Analysis table first column: S06 vial name sky + `Layers` icon; S05 (promoted "↑ from") plain.
  - AR list: PB-0076 parent row shows the sky `Layers` icon next to the ID; expanding shows S05 + S06 names treated (membership-level — both HPLC subs under an HPLC-variance parent).
```
