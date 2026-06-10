# Mk1-Native Analyses Phase 4b — Promote-to-Parent Frontend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the supervisor verification UX through Phase 4a's `POST /api/lims-analyses/promote`. Bench supervisors get a per-row **Promote** affordance on Mk1 vial-tier analyses in `to_be_verified`, and a post-lock **Promote** stage inside the `VarianceSummary` modal for variance HPLC. Promoted vials display a `Promoted → #N` badge so the table reflects what's been verified.

**Architecture:** Backend surfaces a new `promoted_to_parent_id` field on every `SenaiteShapeAnalysisResponse` (joined from `lims_analysis_promotions.source_analysis_id`). FE extends `SenaiteAnalysis` TS type with the field, adds `promoteAnalyses()` in `src/lib/api.ts`, and renders two new affordances: (1) a `Promote` button on each `AnalysisTable` row whose `uid.startsWith('mk1:')` AND `review_state === 'to_be_verified'` (the existing `Verify` admin button stays — both are present), and (2) a `Promoted → #<parentId>` badge wherever `promoted_to_parent_id !== null`. `VarianceSummary` gets a new post-lock `<PromoteStage>` section: per-analyte, per-vial radio for `'chosen'`, `Use mean (<computed>)` button that switches to `'aggregated_in'` for all rows, a `result_value` input, and a `Promote` confirm button. No state-machine changes; the existing vial-tier `apply_transition(kind='verify')` stays as an admin-only path.

**Tech Stack:** React + TypeScript (frontend) + FastAPI + SQLAlchemy 2.0 + Postgres (backend). React Query for fetch/mutate, sonner for toasts (already in use in `VarianceSummary`).

**Spec:** `docs/superpowers/specs/2026-06-02-mk1-native-analyses-design.md` §"Verification UI for variance picking" (Open Question 8) + §"Phase 4 acceptance" (scenarios #1-3 are 4b's user-facing acceptance: single-vial UI promote, variance pick-one UI promote, variance aggregate UI promote).

**Predecessors:** Phase 4a (backend `lims_analysis_promotions` + `promote_to_parent` service + `POST /api/lims-analyses/promote` route).

**Branch:** `subvial/continue` (existing worktree at `C:/tmp/Accu-Mk1-subvial`, PR #9).

---

## Scope decisions (locked in; flag if you disagree before Task 1)

1. **Promote button is additive, NOT a replacement.** The existing `Verify` button on `AnalysisTable` rows in `to_be_verified` continues to call `transitionAnalysis(uid, 'verify')` (which currently dispatches to `POST /api/lims-analyses/{id}/transitions` for mk1: UIDs — admin in-place verify). The new `Promote` button is a separate affordance, mk1-only. Two buttons per vial-tier row. Phase 4c (or later) can deprecate the in-place verify if the supervisor never picks it.

2. **Variance promote happens post-lock, as a separate stage.** `Lock` and `Promote` stay distinct actions. After lock, the new `<PromoteStage>` section reveals below the existing stats table. Each analyte (each keyword in `data.stats`) gets its own row in the stage: a vial picker (radio per in-set vial) + `Use mean (<computed>)` button + `result_value` input + `Promote` button. Successful promote dims that analyte row.

3. **`Use mean` is a switch, not a separate submit.** Clicking `Use mean (<computed>)` populates the `result_value` field with the computed mean and changes the contribution_kind selection from "pick one" to "aggregated_in" (all vials become `'aggregated_in'`). The supervisor still clicks `Promote` to confirm. Picking a specific vial flips back to "pick one" with the chosen vial → `'chosen'`, others → `'reference'`. Single UX, two modes.

4. **`Promoted → #N` badge surfaces in `senaite_shape` only.** Backend extends `SenaiteShapeAnalysisResponse` with `promoted_to_parent_id: Optional[int]`. The default `AnalysisResponse` shape (the `id`-keyed Pydantic model used for Mk1-internal callers) does NOT get the field — keeping the contract minimal. FE renders the badge as a small monospace text after the StatusBadge, with optional click → opens parent-row detail (Phase 4c can add navigation).

5. **`promote` is NOT a transition kind in the state machine.** The new FE button is wired through its own handler — `promoteAnalyses()` in `src/lib/api.ts` — separate from `transitionAnalysis()`. We do NOT extend `ALLOWED_TRANSITIONS['to_be_verified']` in `AnalysisTable.tsx` with `'promote'`; the button renders conditionally on `uid.startsWith('mk1:')` outside the transition-buttons loop.

6. **Result_value input for variance promote validates as a non-empty string.** No numeric parsing client-side; the backend already accepts strings (matches existing `lims_analyses.result_value`). Supervisor can paste numerics, ranges, "<0.5 EU/mg", etc.

7. **No FE tests in Phase 4b.** Same cadence as Phase 3 / 3.5 / 3.6 — typecheck + live UI verification. Backend gets 2 new service tests + 1 route test for the senaite_shape extension.

If any decision is wrong, redirect before Task 1.

---

## File Structure

**Backend (modified):**
- `backend/lims_analyses/schemas.py` — add `promoted_to_parent_id: Optional[int] = None` field to `SenaiteShapeAnalysisResponse`.
- `backend/lims_analyses/service.py` — extend `list_analyses_in_senaite_shape` to bulk-load `LimsAnalysisPromotion` rows keyed by `source_analysis_id` and populate `promoted_to_parent_id` on each response row.
- `backend/tests/test_lims_analyses_service.py` — append 2 tests (un-promoted row carries `None`, promoted row carries parent_id).
- `backend/tests/test_lims_analyses_routes.py` — append 1 test (GET `?as=senaite_shape` exposes the new field).

**Frontend (modified):**
- `src/lib/api.ts` — add `promoteAnalyses()` function calling `POST /api/lims-analyses/promote`; extend `SenaiteAnalysis` type with `promoted_to_parent_id?: number | null`.
- `src/components/senaite/AnalysisTable.tsx` — add per-row `Promote` button (mk1 + to_be_verified); render `Promoted → #N` badge when `promoted_to_parent_id` is set; wire the new button to a confirm-dialog-and-call flow.
- `src/components/samples/VarianceSummary.tsx` — add `<PromoteStage>` sub-component rendered post-lock; per-analyte promote affordance with pick-one / use-mean mode toggle, result_value input, and Promote button.

**Out of scope (Phase 4c / later phases):**
- Deprecate/remove the vial-tier `apply_transition(kind='verify')` path entirely.
- Click-through navigation from a `Promoted → #N` badge to the parent-tier row detail page.
- Bulk promote across many vials in one click (only relevant for variance, which is already a single screen).
- Promote affordance on the worksheet inbox / WorksheetsInboxPage (handled later if supervisors request it).
- COA resolver default-path rewrite (Phase 5).
- FE unit tests (Phase 3-3.6 cadence didn't add component tests).

---

## How to run tests

- Backend single file: `docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/<file> -v"`
- Backend full: same harness, `tests/`. Baseline at end of Phase 4a: 458 passed, 27 skipped, 13 baseline failures.
- FE typecheck: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"`. Baseline: 2 pre-existing errors.

If the backend container was recreated, reinstall pytest:
```bash
docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio
```

---

## Task 1: Backend — extend `SenaiteShapeAnalysisResponse` with `promoted_to_parent_id`

**Files:**
- Modify: `backend/lims_analyses/schemas.py`
- Modify: `backend/lims_analyses/service.py`

- [ ] **Step 1: Add field to `SenaiteShapeAnalysisResponse`**

In `backend/lims_analyses/schemas.py`, find `class SenaiteShapeAnalysisResponse(BaseModel):`. After the `service_group_name: Optional[str] = None` line, append:

```python
    # Phase 4b: when this vial-tier row has been promoted to a parent-tier
    # canonical result, this is the parent-tier row's id. Joined from
    # lims_analysis_promotions.source_analysis_id. None for un-promoted
    # rows and for parent-tier rows themselves (only vial-tier rows can
    # be sources of a promotion).
    promoted_to_parent_id: Optional[int] = None
```

- [ ] **Step 2: Bulk-load promotions in `list_analyses_in_senaite_shape`**

In `backend/lims_analyses/service.py`, find `def list_analyses_in_senaite_shape`. After the existing import block (the `from lims_analyses.schemas import (...)`), add a bulk-load of promotion link rows for the displayed `rows`:

```python
    # Phase 4b: bulk-load promotion links so we can surface promoted_to_parent_id
    # on each vial-tier row. Single-query, indexed lookup on source_analysis_id.
    from models import LimsAnalysisPromotion
    row_ids = [r.id for r in rows]
    promo_by_source: Dict[int, int] = {}
    if row_ids:
        for p in db.execute(
            select(LimsAnalysisPromotion)
            .where(LimsAnalysisPromotion.source_analysis_id.in_(row_ids))
        ).scalars().all():
            promo_by_source[p.source_analysis_id] = p.parent_analysis_id
```

Place this block AFTER `if not rows: return []` and BEFORE the existing `service_ids = ...` bulk load. (Order doesn't matter strictly, but co-locating with other bulk loads keeps the function readable.)

- [ ] **Step 3: Plumb the field into each row's response**

In the same `list_analyses_in_senaite_shape` function, find the loop body where each row builds a `SenaiteShapeAnalysisResponse`. After the last field in the constructor call (currently `service_group_name=None`), append:

```python
            promoted_to_parent_id=promo_by_source.get(r.id),
```

So the full row construction looks like:

```python
        out.append(SenaiteShapeAnalysisResponse(
            ...
            service_group_id=None,
            service_group_name=None,
            promoted_to_parent_id=promo_by_source.get(r.id),
        ))
```

- [ ] **Step 4: Restart + smoke**

```bash
cd /c/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/accumark-stack
docker compose -p accumark-subvial restart accu-mk1-backend 2>&1 | tail -2
until curl -sS http://localhost:5530/health 2>/dev/null | grep -q ok; do sleep 2; done
docker exec accumark-subvial-accu-mk1-backend pip install pytest pytest-asyncio 2>&1 | tail -1
docker exec accumark-subvial-accu-mk1-backend python -c "
from database import SessionLocal
from sqlalchemy import select
from models import LimsSubSample
from lims_analyses.service import list_analyses_in_senaite_shape
db = SessionLocal()
sub = db.execute(select(LimsSubSample).where(LimsSubSample.sample_id == 'PB-0075-S01')).scalar_one_or_none()
if sub:
    rows = list_analyses_in_senaite_shape(db, host_kind='sub_sample', host_pk=sub.id)
    for r in rows:
        print(f'  uid={r.uid} kw={r.keyword} promoted_to_parent_id={r.promoted_to_parent_id}')
else:
    print('PB-0075-S01 not found')
db.close()
"
```

Expected: rows print with `promoted_to_parent_id=None` (the seeded sub-sample has no promotions yet).

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/lims_analyses/schemas.py backend/lims_analyses/service.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
feat(mk1): surface promoted_to_parent_id in senaite_shape

Phase 4b Task 1. Backend extension: every senaite_shape response
row now carries promoted_to_parent_id, joined from
lims_analysis_promotions.source_analysis_id. Empty for un-promoted
rows. FE consumes this to render the "Promoted -> #N" badge on
the AnalysisTable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Backend tests for the new field

**Files:**
- Modify: `backend/tests/test_lims_analyses_service.py`
- Modify: `backend/tests/test_lims_analyses_routes.py`

- [ ] **Step 1: Service tests**

Append to `backend/tests/test_lims_analyses_service.py` (at the bottom, after the promote_to_parent tests):

```python
def test_senaite_shape_carries_null_promoted_to_parent_id_for_unpromoted_row(db, sub_sample, analysis_service):
    """A freshly-created vial-tier row has no promotion link → field is None."""
    from lims_analyses.service import list_analyses_in_senaite_shape
    row = _create(db, sub_sample, analysis_service)
    rows = list_analyses_in_senaite_shape(
        db, host_kind="sub_sample", host_pk=sub_sample.id,
    )
    matching = [r for r in rows if r.uid == f"mk1:{row.id}"]
    assert matching, f"expected uid=mk1:{row.id}; got {[r.uid for r in rows]}"
    assert matching[0].promoted_to_parent_id is None


def test_senaite_shape_carries_parent_id_for_promoted_row(db, sub_sample, analysis_service):
    """After promote_to_parent, the source vial's senaite_shape row carries
    promoted_to_parent_id = parent.id."""
    from lims_analyses.service import list_analyses_in_senaite_shape, promote_to_parent
    parent_pk = _find_parent_with_n_clean_subs(db, analysis_service, 1)
    if parent_pk is None:
        pytest.skip("no parent with a free sub-sample for promoted-shape test")
    fresh = _find_clean_sub_sample(db, analysis_service, parent_pk=parent_pk)
    src = _make_vial_in_to_be_verified(db, fresh, analysis_service)
    parent_row, _ = promote_to_parent(
        db, keyword=src.keyword, result_value="98.55", result_unit=None,
        method_id=None, instrument_id=None,
        sources=[{"analysis_id": src.id, "contribution_kind": "chosen"}],
    )
    parent_row.title = "TEST: parent " + parent_row.title
    db.commit()
    rows = list_analyses_in_senaite_shape(
        db, host_kind="sub_sample", host_pk=fresh.id,
    )
    promoted = [r for r in rows if r.uid == f"mk1:{src.id}"]
    assert promoted, f"expected source row in senaite_shape output"
    assert promoted[0].promoted_to_parent_id == parent_row.id
```

- [ ] **Step 2: Route test**

Append to `backend/tests/test_lims_analyses_routes.py`:

```python
def test_senaite_shape_response_includes_promoted_to_parent_id_field(sub_sample, analysis_service):
    """The new field appears in the JSON response even when null. The FE
    treats this as the discriminator for rendering the Promoted badge."""
    created = client.post("/api/lims-analyses", json=_create_payload(sub_sample, analysis_service)).json()
    r = client.get(f"/api/lims-analyses?host_kind=sub_sample&host_pk={sub_sample.id}&as=senaite_shape")
    assert r.status_code == 200
    rows = r.json()
    assert rows
    # The field is present on every row (None for un-promoted, int for promoted)
    assert all("promoted_to_parent_id" in r for r in rows)
    # The newly-created row is un-promoted
    new_row = next(r for r in rows if r["uid"] == f"mk1:{created['id']}")
    assert new_row["promoted_to_parent_id"] is None
```

- [ ] **Step 3: Run tests**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/test_lims_analyses_service.py tests/test_lims_analyses_routes.py -v -k 'senaite_shape and (promoted or new)' 2>&1 | tail -10"
```

Expected: 3 new tests passed.

- [ ] **Step 4: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add backend/tests/test_lims_analyses_service.py backend/tests/test_lims_analyses_routes.py
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
test(mk1): promoted_to_parent_id surfacing in senaite_shape

Phase 4b Task 2. 2 service tests (un-promoted row None, promoted
row carries parent_id) + 1 route test (field present in JSON
response shape).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: FE — `promoteAnalyses()` API + `SenaiteAnalysis` type extension

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Extend `SenaiteAnalysis` type**

In `src/lib/api.ts`, find the `SenaiteAnalysis` interface (TypeScript type representing the FE row shape). After the last field, append:

```typescript
  // Phase 4b: when this vial-tier row has been promoted to a parent-tier
  // canonical result, this is the parent-tier row's id. Used to render
  // the "Promoted → #N" badge in AnalysisTable.
  promoted_to_parent_id?: number | null
```

Use `Grep` first to find the exact interface declaration:

```bash
grep -n "interface SenaiteAnalysis\|type SenaiteAnalysis" src/lib/api.ts | head -3
```

The field is optional + nullable so existing callers that don't supply it still type-check.

- [ ] **Step 2: Add `promoteAnalyses()` function**

After `transitionAnalysis()` in `src/lib/api.ts`, add:

```typescript
export interface PromoteSourceRef {
  analysis_id: number
  contribution_kind: 'chosen' | 'aggregated_in' | 'reference'
}

export interface PromoteRequest {
  keyword: string
  result_value: string
  result_unit?: string | null
  method_id?: number | null
  instrument_id?: number | null
  sources: PromoteSourceRef[]
  reason?: string | null
}

export interface PromoteResponse {
  parent: {
    id: number
    review_state: string
    result_value: string | null
    result_unit: string | null
    keyword: string
    title: string
    lims_sample_pk: number | null
    [k: string]: unknown
  }
  promotions: Array<{
    id: number
    parent_analysis_id: number
    source_analysis_id: number
    contribution_kind: string
    promoted_at: string
    reason: string | null
  }>
}

/**
 * Phase 4b: promote N vial-tier sources to a single parent-tier verified row.
 *
 * Throws on non-2xx with a structured Error message including the backend's
 * detail (404 missing source, 409 parent_row_already_exists, 400 validation).
 */
export async function promoteAnalyses(req: PromoteRequest): Promise<PromoteResponse> {
  const response = await fetch(`${API_BASE_URL()}/api/lims-analyses/promote`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(req),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    const detail = err?.detail
    const message = typeof detail === 'string'
      ? detail
      : detail?.message ?? `Promote failed: ${response.status}`
    throw new Error(message)
  }
  return response.json()
}
```

- [ ] **Step 3: Typecheck**

```bash
docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"
```

Expected: 2 pre-existing errors only.

- [ ] **Step 4: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/lib/api.ts
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
feat(mk1-fe): promoteAnalyses() + SenaiteAnalysis.promoted_to_parent_id

Phase 4b Task 3. FE API client for POST /api/lims-analyses/promote.
Throws on non-2xx with the backend's structured error message
(404 / 409 / 400 surfaced verbatim). SenaiteAnalysis type extended
with the optional nullable promoted_to_parent_id so AnalysisTable
can render the Promoted -> #N badge.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: FE `AnalysisTable` — per-row Promote button + Promoted badge

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx`

This file is large (~1389 lines). The changes are localized: a new component for the Promote button, a badge render, and the button rendered conditionally inside the per-row action buttons.

- [ ] **Step 1: Add the `PromoteButton` sub-component**

In `src/components/senaite/AnalysisTable.tsx`, find the existing transition-action rendering. Likely near where `TRANSITION_LABELS` is consumed in the row JSX. Add a sub-component:

```typescript
function PromoteButton({
  analysis,
  onPromoted,
}: {
  analysis: SenaiteAnalysis
  onPromoted: () => void
}) {
  const [pending, setPending] = useState(false)
  const [open, setOpen] = useState(false)
  const [resultValue, setResultValue] = useState(analysis.result ?? '')
  const handle = async () => {
    if (!resultValue) {
      toast.error('Result value is required')
      return
    }
    if (!analysis.uid.startsWith('mk1:')) return
    const limsId = parseInt(analysis.uid.slice('mk1:'.length), 10)
    setPending(true)
    try {
      await promoteAnalyses({
        keyword: analysis.keyword ?? '',
        result_value: resultValue,
        result_unit: analysis.unit ?? null,
        method_id: analysis.method_uid ? parseInt(analysis.method_uid, 10) : null,
        instrument_id: analysis.instrument_uid ? parseInt(analysis.instrument_uid, 10) : null,
        sources: [{ analysis_id: limsId, contribution_kind: 'chosen' }],
        reason: 'Single-vial promote from AnalysisTable',
      })
      toast.success('Promoted to parent')
      setOpen(false)
      onPromoted()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="default" disabled={pending}>Promote</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Promote {analysis.keyword} to parent</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <p className="text-sm text-muted-foreground">
            This creates a parent-tier verified row for <code>{analysis.keyword}</code>
            with the chosen value. The vial-tier row stays in <code>to_be_verified</code>;
            an audit row records the promotion. This cannot be undone without retracting
            and deleting the parent-tier row.
          </p>
          <label className="text-sm font-medium">
            Result value
            <input
              type="text"
              value={resultValue}
              onChange={(e) => setResultValue(e.target.value)}
              className="mt-1 w-full px-2 py-1 border rounded bg-background text-sm font-mono"
              autoFocus
            />
          </label>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button onClick={handle} disabled={pending || !resultValue}>
              {pending ? 'Promoting…' : 'Promote'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

Add the imports at the top of the file if not already present:

```typescript
import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { promoteAnalyses, type SenaiteAnalysis } from '@/lib/api'
```

(Most are likely already imported; check before adding duplicates.)

- [ ] **Step 2: Render Promote button + Promoted badge in the row**

Find the row-action-button rendering — likely a `<TableRow>` body that maps `ALLOWED_TRANSITIONS[analysis.review_state]` to buttons. Inject the Promote button + badge:

```typescript
{/* Phase 4b: Promote button alongside Verify for mk1: vial-tier rows */}
{analysis.uid.startsWith('mk1:')
  && analysis.review_state === 'to_be_verified'
  && analysis.promoted_to_parent_id == null && (
  <PromoteButton analysis={analysis} onPromoted={refetch} />
)}

{/* Phase 4b: Promoted badge — replaces the action buttons cell once promoted */}
{analysis.promoted_to_parent_id != null && (
  <span className="ml-2 text-xs font-mono text-green-700 dark:text-green-300">
    Promoted → #{analysis.promoted_to_parent_id}
  </span>
)}
```

Where exactly: find the JSX node where `ALLOWED_TRANSITIONS[state]?.map(...)` renders the existing buttons. Insert the Promote button right after that loop. Place the badge in the same row container, after the buttons.

`refetch` should be the existing react-query refetch function for the analyses list. If not exposed at this layer, accept an `onPromoted` callback as a prop higher up and thread it through.

- [ ] **Step 3: Typecheck**

```bash
docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"
```

Expected: 2 pre-existing errors only.

- [ ] **Step 4: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/components/senaite/AnalysisTable.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
feat(mk1-fe): AnalysisTable Promote button + Promoted badge

Phase 4b Task 4. New per-row Promote affordance for mk1: vial-tier
rows in to_be_verified, additive to the existing Verify button. Opens
a confirm dialog with the result_value editable, then POSTs to
/api/lims-analyses/promote with contribution_kind='chosen'.
Promoted rows display "Promoted -> #N" in green; the Promote button
disappears post-promote.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: FE `VarianceSummary` — post-lock Promote stage

**Files:**
- Modify: `src/components/samples/VarianceSummary.tsx`

The variance modal currently has: header, vials checkboxes, stats table, lock button. Phase 4b adds a post-lock `<PromoteStage>` section showing one promote row per analyte (one per keyword in `data.stats`).

- [ ] **Step 1: Add the imports + state**

Extend the imports in `src/components/samples/VarianceSummary.tsx`:

```typescript
import { promoteAnalyses } from '@/lib/api'
```

- [ ] **Step 2: Add the `PromoteStage` sub-component**

After `VialRow` at the bottom of `src/components/samples/VarianceSummary.tsx`, add:

```typescript
function PromoteStage({
  parentSampleId,
  vials,
  stats,
  onPromoted,
}: {
  parentSampleId: string
  vials: VarianceVial[]
  stats: Record<string, VarianceStatsEntry>
  onPromoted: () => void
}) {
  const inSet = vials.filter(v => v.in_variance_set)
  return (
    <section className="border rounded-md">
      <header className="px-4 py-2 border-b font-semibold text-sm bg-muted/50">
        Promote variance results to parent {parentSampleId}
      </header>
      <ul className="divide-y">
        {Object.entries(stats).map(([keyword, stat]) => (
          <PromoteAnalyteRow
            key={keyword}
            keyword={keyword}
            stat={stat}
            vials={inSet}
            onPromoted={onPromoted}
          />
        ))}
        {Object.keys(stats).length === 0 && (
          <li className="p-4 text-center text-muted-foreground text-sm">
            No analyte stats — no vials in the variance set, or no results entered.
          </li>
        )}
      </ul>
    </section>
  )
}

function PromoteAnalyteRow({
  keyword,
  stat,
  vials,
  onPromoted,
}: {
  keyword: string
  stat: VarianceStatsEntry
  vials: VarianceVial[]
  onPromoted: () => void
}) {
  // Vials that have a result entered for this keyword
  const eligible = vials.filter(v => v.results?.[keyword]?.uid?.startsWith('mk1:'))
  const eligibleIds = eligible.map(v =>
    parseInt(v.results[keyword].uid.slice('mk1:'.length), 10)
  )

  const meanVal = stat.kind !== 'categorical' && stat.mean !== null
    ? stat.mean.toFixed(2)
    : ''

  const [mode, setMode] = useState<'pick' | 'mean'>('pick')
  const [chosenId, setChosenId] = useState<number | null>(eligibleIds[0] ?? null)
  const [resultValue, setResultValue] = useState<string>(() => {
    const first = eligible[0]
    return first ? String(first.results[keyword].value ?? '') : ''
  })
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)

  const handleUseMean = () => {
    setMode('mean')
    setResultValue(meanVal)
    setChosenId(null)
  }
  const handlePickRadio = (id: number) => {
    setMode('pick')
    setChosenId(id)
    const v = eligible.find(e => parseInt(e.results[keyword].uid.slice('mk1:'.length), 10) === id)
    if (v) setResultValue(String(v.results[keyword].value ?? ''))
  }

  const handlePromote = async () => {
    if (!resultValue || eligibleIds.length === 0) return
    setPending(true)
    try {
      const sources = eligibleIds.map(id => ({
        analysis_id: id,
        contribution_kind:
          mode === 'mean' ? 'aggregated_in' as const :
          id === chosenId ? 'chosen' as const : 'reference' as const,
      }))
      await promoteAnalyses({
        keyword,
        result_value: resultValue,
        sources,
        reason: `Variance promote (${mode === 'mean' ? 'aggregate' : 'pick'})`,
      })
      toast.success(`Promoted ${keyword} to parent`)
      setDone(true)
      onPromoted()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  if (done) {
    return (
      <li className="px-4 py-3 text-sm bg-green-50 dark:bg-green-950/20">
        <span className="font-medium text-green-700 dark:text-green-300">
          ✓ {keyword} promoted
        </span>
      </li>
    )
  }
  if (eligible.length === 0) {
    return (
      <li className="px-4 py-3 text-sm text-muted-foreground">
        {keyword}: no Mk1 vial-tier results to promote
      </li>
    )
  }

  return (
    <li className="px-4 py-3 space-y-2">
      <div className="font-medium text-sm">{keyword}</div>
      <ul className="space-y-1 ml-2">
        {eligible.map(v => {
          const aid = parseInt(v.results[keyword].uid.slice('mk1:'.length), 10)
          return (
            <li key={v.sample_id} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`pick-${keyword}`}
                checked={mode === 'pick' && chosenId === aid}
                onChange={() => handlePickRadio(aid)}
              />
              <code className="min-w-[8rem]">{v.sample_id}</code>
              <span className="text-muted-foreground">
                {String(v.results[keyword].value ?? '—')}
              </span>
            </li>
          )
        })}
      </ul>
      <div className="flex items-center gap-3 mt-2">
        {meanVal && (
          <Button
            variant={mode === 'mean' ? 'default' : 'outline'}
            size="sm"
            onClick={handleUseMean}
          >
            Use mean ({meanVal})
          </Button>
        )}
        <input
          type="text"
          value={resultValue}
          onChange={(e) => setResultValue(e.target.value)}
          placeholder="result value"
          className="px-2 py-1 border rounded text-sm font-mono flex-1"
        />
        <Button
          size="sm"
          onClick={handlePromote}
          disabled={pending || !resultValue || (mode === 'pick' && chosenId === null)}
        >
          {pending ? 'Promoting…' : 'Promote'}
        </Button>
      </div>
    </li>
  )
}
```

- [ ] **Step 3: Render `PromoteStage` post-lock in `VarianceSummaryBody`**

Find `VarianceSummaryBody`. After the existing locked stats section (the `<section>` containing the stats table) and before the "Lock variance set" button block, add:

```typescript
      {locked && (
        <PromoteStage
          parentSampleId={parentSampleId}
          vials={data.vials}
          stats={data.stats}
          onPromoted={() => queryClient.invalidateQueries({ queryKey: ['variance-set', parentSampleId] })}
        />
      )}
```

The `onPromoted` callback invalidates the variance-set query so the stats and post-promote display refresh.

NOTE: This assumes `VarianceVial.results[keyword]` exposes the analysis `uid` (with `mk1:` prefix for Mk1-owned vials). If the type doesn't currently expose `uid`, check the variance-set backend response shape and extend the type. The variance backend already returns analysis identifiers per result.

If `uid` is not present, the fallback is to add it to the backend `VarianceSetResponse` shape — but verify before writing the FE code: grep for `VarianceVial` in `src/lib/api.ts` to see the type.

```bash
grep -n "VarianceVial\|VarianceStatsEntry\|getVarianceSet" src/lib/api.ts | head -10
```

If `uid` is missing from `VarianceVial.results[keyword]`, **stop and surface to the user before proceeding** — the variance-set backend may need extending. Open question for redirect.

- [ ] **Step 4: Typecheck**

```bash
docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"
```

Expected: 2 pre-existing errors only. If new errors appear about `VarianceVial.results[k].uid` not being a field, STOP and surface — this is the open question from Step 3.

- [ ] **Step 5: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/components/samples/VarianceSummary.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "$(cat <<'EOF'
feat(mk1-fe): VarianceSummary post-lock Promote stage

Phase 4b Task 5. After locking the variance set, supervisors get
per-analyte Promote affordances: pick one vial (chosen + N references)
or "Use mean (<computed>)" (all aggregated_in). Confirm fires POST
/api/lims-analyses/promote per analyte. Promoted analytes turn green.
Lock and Promote stay distinct actions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Full suite + live UI verification

Verification-only — no commit.

- [ ] **Step 1: Full backend suite**

```bash
docker exec -e MSYS_NO_PATHCONV=1 accumark-subvial-accu-mk1-backend bash -c "cd /app && python -m pytest tests/ -q --tb=no 2>&1 | tail -5"
```

Expected: ≥ 461 passed (was 458 at end of Phase 4a; +3 new tests in Phase 4b). 13 baseline failures unchanged. Zero regressions.

- [ ] **Step 2: FE typecheck**

```bash
docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"
```

Expected: 2 pre-existing errors only.

- [ ] **Step 3: Live UI — single-vial Promote**

```
1. Open http://localhost:5532
2. sessionStorage.setItem('accu_mk1_api_url_override', 'http://localhost:5530'); location.reload()
3. Log in as forrest@valenceanalytical.com / test123
4. Navigate to a Mk1 sub-sample with an endo or sterility analysis in to_be_verified.
   (Use the worksheet inbox to find one, or create one via the Receive Wizard
   + assign endo + enter a result + submit.)
5. On the AnalysisTable, the row should show: Verify | Promote | Retest | etc buttons.
6. Click Promote. Dialog opens with result_value pre-filled from the row.
7. Confirm. Toast: "Promoted to parent."
8. Row updates to show "Promoted → #<N>" badge instead of the Promote button.
9. Verify backend: a parent-tier lims_analyses row exists for the parent sample
   with the chosen result_value, and a lims_analysis_promotions row links the
   vial-tier source to it.
```

- [ ] **Step 4: Live UI — variance Promote (pick-one)**

```
1. Find a parent sample with 2+ vials with HPLC results in to_be_verified.
   (If none exists, set one up: create 2 sub-samples, assign hplc role to both,
   enter results, submit.)
2. Open the variance summary modal (button next to the parent sample).
3. Make sure both vials are in the variance set. Lock the variance set.
4. New "Promote" section appears at the bottom listing each analyte.
5. For one HPLC analyte: vial 1 is selected by default (radio). Click vial 2's
   radio. result_value field updates with vial 2's value.
6. Click Promote. Toast: "Promoted IDENTITY_HPLC to parent."
7. The analyte row turns green with "✓ IDENTITY_HPLC promoted."
8. Verify backend: parent-tier row exists with vial 2's value;
   lims_analysis_promotions has 1 'chosen' (vial 2) + 1 'reference' (vial 1).
```

- [ ] **Step 5: Live UI — variance Promote (use-mean)**

```
1. With another locked variance set + a fresh HPLC analyte that hasn't been promoted,
2. Click "Use mean (<computed>)" button. Mode flips to aggregate; result_value populates
   with the computed mean.
3. Click Promote. Toast: "Promoted <ANALYTE> to parent."
4. Verify backend: parent-tier row carries the mean value; lims_analysis_promotions
   has N 'aggregated_in' rows.
```

- [ ] **Step 6: Live UI — 409 re-promote**

```
1. On the same family that just had a successful promote,
2. Attempt to promote the same analyte again (open another vial's row in to_be_verified
   with that keyword, click Promote).
3. Toast surfaces the 409 detail message: "A parent-tier row already exists for
   this parent + keyword. Retract the existing parent row first, then re-promote."
4. The vial-tier row stays in to_be_verified; no parent row created.
```

---

## Verification (Phase 4b acceptance)

- [ ] **Backend: `SenaiteShapeAnalysisResponse` carries `promoted_to_parent_id` field** (Task 1 Step 4)
- [ ] **Backend: promoted vial-tier row surfaces parent's id in senaite_shape** (Task 2 service test)
- [ ] **Backend: GET `?as=senaite_shape` JSON includes the new field** (Task 2 route test)
- [ ] **FE: `promoteAnalyses()` typed + exports work** (Task 3 typecheck)
- [ ] **FE: `Promote` button renders on mk1 + to_be_verified rows; clicking it promotes via POST /promote** (Task 4 + Task 6 Step 3)
- [ ] **FE: `Promoted → #N` badge replaces the Promote button after promote** (Task 4 + Task 6 Step 3)
- [ ] **FE: VarianceSummary post-lock Promote stage works for pick-one** (Task 5 + Task 6 Step 4)
- [ ] **FE: VarianceSummary post-lock Promote stage works for use-mean** (Task 5 + Task 6 Step 5)
- [ ] **FE: 409 on re-promote surfaces a clear error toast** (Task 6 Step 6)
- [ ] **Full backend suite ≥ 461 passed, 13 baseline failures, zero regressions** (Task 6 Step 1)
- [ ] **FE typecheck: 2 pre-existing errors only** (Task 6 Step 2)

---

## Risks and unknowns

- **`VarianceVial.results[keyword].uid` may not exist in the current backend response.** Task 5 Step 3 calls out the check explicitly. If missing, the Promote stage can't dispatch — the backend variance-set response needs a sidecar extension. That's small but DOES require backend work. Open question: do we extend the variance-set response, or do we read the lims_analyses rows separately in the Promote stage (extra fetch)? Recommendation: extend the variance-set response (one query, no extra round-trip).

- **The `Promote` button in `AnalysisTable` requires the result_value at confirm time.** For single-vial promote, the supervisor sees the row's current `analysis.result` pre-filled — but if they want to override the value (rare, but possible), the dialog lets them. This may surprise a supervisor expecting "verify what's there" — the dialog should make clear that this is the CANONICAL parent value being recorded.

- **No "undo" path.** Once promoted, the only way to re-promote is to retract the parent-tier row and delete it. Phase 4b doesn't add an unpromote button. This is intentional — promoted = supervisor verified the COA value. Admin path stays manual.

- **`PromoteStage` renders one section per analyte in `data.stats`.** For variance sets with many analytes (HPLC + 5+ peptide IDs), this can be a long modal. UX is acceptable as a v1; if supervisors complain, Phase 4c can add per-analyte collapsibility.

- **The Promote button doesn't show when `promoted_to_parent_id != null`.** This means once a vial is promoted, you can't re-promote IT to another parent row. That's correct — a vial-tier row only has one canonical promotion at a time. But the same VIAL can be retracted-then-re-promoted (Phase 4a tested this) by retracting the parent row and clicking Promote again — the badge disappears since the source has no live promotion.

- **The Promote dialog auto-focuses the result_value input** — supervisors used to a fast keyboard flow can tab through and confirm. If we add field validation (number-only for HPLC, etc.) later, that's a Phase 4c add-on.

- **Variance-set unlock won't roll back promotions.** If a supervisor unlocks the variance set after promoting some analytes, the promotions stay. That's by design — promote is its own commit point. Document in the modal copy if it's confusing.

## Open questions (carried forward)

1. **Does the variance-set response carry analysis `uid` per result?** Verified in Task 5 Step 3.
2. **Should the Promote button on AnalysisTable confirm with a dialog (current design) or one-click promote?** Current design: confirm dialog. One-click is faster but more error-prone for the canonical COA value.
3. **Click-through on "Promoted → #N" badge to the parent-tier row detail page?** Deferred to Phase 4c.

## Out of scope (carried forward)

- Deprecate vial-tier `apply_transition(kind='verify')` (Phase 4c).
- Worksheet inbox Promote affordance (Phase 4c).
- COA resolver default-path rewrite (Phase 5).
- Family-state derivation + WP signaling (Phase 5).
- Customer prelim-COA opt-in (Phase 6).
