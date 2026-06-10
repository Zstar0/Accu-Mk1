# Variance-Gated Indicator + Bulk Verify (Variance) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface which sub-sample rows belong to a variance series (a "Variance" chip across all pre-signoff states), tag variance buckets in AssignStep, and add a bulk "Verify (Variance) selected" toolbar action.

**Architecture:** Pure frontend, additive. A new state-independent membership predicate (`isVarianceMember`) plus a suppression-aware call-site helper (`showVarianceChip`) drive a small `VarianceChip`. The AssignStep bucket header gains a `Variance ×N` pill from the already-present `varianceN`. `deriveBulkActions` is extended to accept the table's `primaryRole` + `varianceEntitlement` and return a `showVarianceVerify` flag (mirroring `showPromote`), wired to a new toolbar button that runs `executeBulk(uids, 'variance_verify')`. No backend, schema, or endpoint change — all inputs already exist FE-side.

**Tech Stack:** React + TypeScript, Vitest + Testing Library, Tailwind. Stack containers `accumark-subvial-*` (FE :5532).

**Spec:** `docs/superpowers/specs/2026-06-10-variance-gated-indicator-design.md`

---

## File Structure

- `src/components/senaite/AnalysisTable.tsx` — add `isVarianceMember`, `showVarianceChip`, `VarianceChip`; render chip in `AnalysisRow`; extend `deriveBulkActions` + toolbar button. (All variance row/bulk logic already lives here — keep it co-located.)
- `src/components/intake/ReceiveWizard/AssignStep.tsx` — `Variance ×N` pill in `Bucket` / `MicroBucket` headers.
- `src/test/variance-verify-gating.test.tsx` — unit tests for `isVarianceMember`, `showVarianceChip`, `deriveBulkActions` (`showVarianceVerify`), and a `VarianceChip` render test.
- `src/test/assign-step.test.tsx` — bucket pill render tests.

## Conventions (match existing code)

- Per-task commit, message footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Run FE tests in the container: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run <path>"`.
- Additive-only; if an UNRELATED test is red, baseline it against the prior commit (stash-baseline is the arbiter) — don't chase it. The documented pre-existing FE failures are `App.test.tsx` and `peptide-requests-list.test.tsx`.
- Chip styling reuses the `StatusBadge` shape: `inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border`.

---

## Task 1: Membership predicate, suppression helper, chip, and row wiring

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx` (add helpers ~after `canVarianceVerify` at `:210`; add `VarianceChip` near `StatusBadge` ~`:347`; render in `AnalysisRow` at the status cell `:1267-1275`)
- Test: `src/test/variance-verify-gating.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `src/test/variance-verify-gating.test.tsx` (import `isVarianceMember`, `showVarianceChip`, `VarianceChip` alongside the existing imports from `@/components/senaite/AnalysisTable`):

```tsx
import {
  canVarianceVerify,
  isVarianceMember,
  showVarianceChip,
  VarianceChip,
  ALLOWED_TRANSITIONS_TEST_EXPORT as ALLOWED_TRANSITIONS,
  StatusBadge,
} from '@/components/senaite/AnalysisTable'

describe('isVarianceMember (state-independent membership)', () => {
  it('true for an entitled hplc sub-row regardless of state', () => {
    expect(isVarianceMember(mk({ review_state: 'unassigned' }), 'hplc', ENTITLED)).toBe(true)
    expect(isVarianceMember(mk({ review_state: 'received' }), 'hplc', ENTITLED)).toBe(true)
    expect(isVarianceMember(mk({ review_state: 'to_be_verified' }), 'hplc', ENTITLED)).toBe(true)
    expect(isVarianceMember(mk({ review_state: 'variance_verified' }), 'hplc', ENTITLED)).toBe(true)
    expect(isVarianceMember(mk({ promoted_to_parent_id: 5 }), 'hplc', ENTITLED)).toBe(true)
  })
  it('false for SENAITE rows, no entitlement, wrong role, null role', () => {
    expect(isVarianceMember(mk({ uid: 'a8c27e69bfa8' }), 'hplc', ENTITLED)).toBe(false)
    expect(isVarianceMember(mk({}), 'hplc', {})).toBe(false)
    expect(isVarianceMember(mk({}), 'hplc', undefined)).toBe(false)
    expect(isVarianceMember(mk({}), 'endo', ENTITLED)).toBe(false)
    expect(isVarianceMember(mk({}), null, ENTITLED)).toBe(false)
  })
})

describe('showVarianceChip (member, with suppression)', () => {
  it('true for an entitled member in a pre-signoff state', () => {
    expect(showVarianceChip(mk({ review_state: 'unassigned' }), 'hplc', ENTITLED)).toBe(true)
    expect(showVarianceChip(mk({ review_state: 'to_be_verified' }), 'hplc', ENTITLED)).toBe(true)
  })
  it('suppressed on promoted rows (became canonical line)', () => {
    expect(showVarianceChip(mk({ review_state: 'promoted' }), 'hplc', ENTITLED)).toBe(false)
    expect(showVarianceChip(mk({ promoted_to_parent_id: 5 }), 'hplc', ENTITLED)).toBe(false)
  })
  it('suppressed on variance_verified (already badged Verified — Variance)', () => {
    expect(showVarianceChip(mk({ review_state: 'variance_verified' }), 'hplc', ENTITLED)).toBe(false)
  })
  it('false when not a member', () => {
    expect(showVarianceChip(mk({}), 'hplc', {})).toBe(false)
  })
})

describe('VarianceChip', () => {
  it('renders the Variance label', () => {
    render(<VarianceChip />)
    expect(screen.getByText('Variance')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/variance-verify-gating.test.tsx"`
Expected: FAIL — `isVarianceMember`, `showVarianceChip`, `VarianceChip` are not exported.

- [ ] **Step 3: Add the helpers and chip**

In `src/components/senaite/AnalysisTable.tsx`, immediately after `canVarianceVerify` (ends `:210`) add:

```tsx
/** True when a row is a MEMBER of a variance series — native (mk1:) sub-row whose
 *  host vial role maps to a parent-purchased variance key (n>=2). State-INDEPENDENT
 *  (unlike canVarianceVerify, which also requires to_be_verified & not-promoted).
 *  Drives the membership chip. */
export function isVarianceMember(
  a: SenaiteAnalysis,
  vialRole: string | null | undefined,
  entitlement: Record<string, number> | undefined,
): boolean {
  if (!a.uid || !a.uid.startsWith('mk1:')) return false
  const key = vialRole ? ROLE_VARIANCE_KEYS[vialRole] : undefined
  if (!key || !entitlement) return false
  const n = entitlement[key]
  return typeof n === 'number' && n >= 2
}

/** Whether to render the membership chip on a row: a variance member, EXCEPT on
 *  rows that already self-describe as variance — promoted (became the canonical
 *  line) and variance_verified ("Verified — Variance" badge). */
export function showVarianceChip(
  a: SenaiteAnalysis,
  vialRole: string | null | undefined,
  entitlement: Record<string, number> | undefined,
): boolean {
  if (!isVarianceMember(a, vialRole, entitlement)) return false
  if (isPromoted(a)) return false
  if (a.review_state === 'variance_verified') return false
  return true
}
```

Then after `StatusBadge` (ends `:347`) add the chip component:

```tsx
/** Small membership chip marking a row as part of a variance series. Visually
 *  distinct from the colored status badges (sky outline, echoing the AssignStep
 *  variance annotation). Gate visibility with showVarianceChip(). */
export function VarianceChip() {
  return (
    <span
      title="Replicate in a variance series — signed off via Verify (Variance), never promoted."
      className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-400 dark:border-sky-500/20"
    >
      Variance
    </span>
  )
}
```

- [ ] **Step 4: Render the chip in the row**

In `AnalysisRow`, in the status cell, after the `StatusBadge` block (`:1275`, before the `isPromoted` block at `:1276`), add:

```tsx
          {showVarianceChip(analysis, vialRole, varianceEntitlement) && <VarianceChip />}
```

(`vialRole` and `varianceEntitlement` are already props on `AnalysisRow`, `:1130`/`:1155`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/variance-verify-gating.test.tsx"`
Expected: PASS (existing `canVarianceVerify`/`StatusBadge` tests still green).

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/components/senaite/AnalysisTable.tsx src/test/variance-verify-gating.test.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(variance): membership chip on variance-series rows

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: AssignStep HPLC bucket `Variance ×N` pill

**Scope note:** The Micro sub-zones already render an inline `(×N variance)` annotation
(`SubDropZone`, `AssignStep.tsx:630`), covered by passing tests (`assign-step.test.tsx:92,99`).
Only the HPLC "Analyses Dept." `Bucket` header lacks a tag — that's the one in the user's
screenshot. Add the pill there only; leave `SubDropZone` untouched (additive, no test churn).
The HPLC bucket's existing `VarianceCountLines` (base/variance split below the header)
stays — the header pill is a quick flag, the lines are the demand math.

**Files:**
- Modify: `src/components/intake/ReceiveWizard/AssignStep.tsx` (`Bucket` header right-cluster `:478-485`)
- Test: `src/test/assign-step.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `src/test/assign-step.test.tsx` (uses the existing `VARIANCE_PLAN` with `variance.hplc=3`, and `PLAN` with all-zero variance):

```tsx
describe('variance HPLC bucket pill', () => {
  it('renders Variance ×N on the HPLC bucket header when hplc variance >= 2', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(VARIANCE_PLAN)
    renderStep()
    expect(await screen.findByText('Variance ×3')).toBeInTheDocument()
  })
  it('no HPLC bucket pill when no variance', async () => {
    vi.mocked(getVialPlan).mockResolvedValue(PLAN)
    renderStep()
    await screen.findByText('Analyses Dept.')
    expect(screen.queryByText(/Variance ×/)).not.toBeInTheDocument()
  })
})
```

(The existing `/×2 variance/i` Endo assertion at `:92` stays valid — `SubDropZone` is unchanged. "Variance ×3" does not match `/×\d variance/i`, so the no-variance assertion at `:99` also stays valid.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/assign-step.test.tsx"`
Expected: FAIL — no "Variance ×3" text yet. (All existing assign-step tests still pass.)

- [ ] **Step 3: Add a pill component**

In `src/components/intake/ReceiveWizard/AssignStep.tsx`, above the `Bucket` function (`:442`) add:

```tsx
/** Header pill flagging a bucket as carrying variance demand. */
function VariancePill({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400">
      Variance ×{n}
    </span>
  )
}
```

- [ ] **Step 4: Render the pill in the `Bucket` header**

In `Bucket`'s header right-cluster `<div className="flex items-center gap-2">` (`:478`), add the pill as the first child, before the `{demand !== null && (...)}` span (`:479`):

```tsx
        <div className="flex items-center gap-2">
          {varianceN >= 2 && <VariancePill n={varianceN} />}
          {demand !== null && (
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/assign-step.test.tsx"`
Expected: PASS (existing variance sub-row / override-editor tests still green).

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/components/intake/ReceiveWizard/AssignStep.tsx src/test/assign-step.test.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(variance): Variance xN pill on AssignStep buckets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Bulk Verify (Variance) toolbar action

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx` (`deriveBulkActions` `:256-282`; call site `:1652`; toolbar `:1771-1804`)
- Test: `src/test/variance-verify-gating.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `src/test/variance-verify-gating.test.tsx` (import `deriveBulkActions`):

```tsx
import {
  // ...existing...
  deriveBulkActions,
} from '@/components/senaite/AnalysisTable'

describe('deriveBulkActions — showVarianceVerify', () => {
  const v = (over: Partial<SenaiteAnalysis>) =>
    mk({ review_state: 'to_be_verified', promoted_to_parent_id: null, ...over })

  it('true when every selected row passes canVarianceVerify', () => {
    const sel = [v({ uid: 'mk1:1' }), v({ uid: 'mk1:2' })]
    expect(deriveBulkActions(sel, {}, 'hplc', ENTITLED).showVarianceVerify).toBe(true)
  })
  it('false if any selected row is not entitled / not member', () => {
    const sel = [v({ uid: 'mk1:1' }), v({ uid: 'a8c27e69bfa8' })] // SENAITE row
    expect(deriveBulkActions(sel, {}, 'hplc', ENTITLED).showVarianceVerify).toBe(false)
  })
  it('false without entitlement', () => {
    const sel = [v({ uid: 'mk1:1' })]
    expect(deriveBulkActions(sel, {}, 'hplc', {}).showVarianceVerify).toBe(false)
    expect(deriveBulkActions(sel, {}, 'hplc', undefined).showVarianceVerify).toBe(false)
  })
  it('false on empty selection', () => {
    expect(deriveBulkActions([], {}, 'hplc', ENTITLED).showVarianceVerify).toBe(false)
  })
  it('false if any selected row is promoted (mutually exclusive with promote)', () => {
    const sel = [v({ uid: 'mk1:1' }), v({ uid: 'mk1:2', promoted_to_parent_id: 9 })]
    expect(deriveBulkActions(sel, {}, 'hplc', ENTITLED).showVarianceVerify).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/variance-verify-gating.test.tsx"`
Expected: FAIL — `showVarianceVerify` is undefined (not on the return type).

- [ ] **Step 3: Extend `deriveBulkActions`**

In `src/components/senaite/AnalysisTable.tsx`, change the signature and return (`:256-282`):

```tsx
export function deriveBulkActions(
  selected: SenaiteAnalysis[],
  parentLineStates?: Record<string, string>,
  vialRole?: string | null,
  varianceEntitlement?: Record<string, number>,
): {
  actions: BulkTransition[]
  showPromote: boolean
  showVarianceVerify: boolean
} {
  const anyLocked = selected.some(a => isLockedByParent(a, parentLineStates))
  const anyPromotableOrPromoted = selected.some(a => isPromotable(a) || isPromoted(a))
  const LOCKED_DROP = new Set<BulkTransition>(['retest', 'retract', 'reject'])
  const actions = BULK_TRANSITIONS.filter(
    t =>
      selected.length > 0 &&
      !(t === 'verify' && anyPromotableOrPromoted) &&
      !(anyLocked && (LOCKED_DROP.has(t) || t === 'verify')) &&
      selected.every(
        a =>
          a.review_state !== null &&
          a.review_state !== undefined &&
          (ALLOWED_TRANSITIONS[a.review_state] ?? []).includes(t) &&
          (t !== 'submit' || !!a.result),
      ),
  )
  const showPromote =
    !anyLocked && selected.length > 0 && selected.every(isPromotable)
  const showVarianceVerify =
    selected.length > 0 &&
    selected.every(a => canVarianceVerify(a, vialRole, varianceEntitlement))
  return { actions, showPromote, showVarianceVerify }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/variance-verify-gating.test.tsx"`
Expected: PASS.

- [ ] **Step 5: Wire the flag at the call site**

At `:1652`, update the destructure and pass `primaryRole` + `varianceEntitlement`:

```tsx
  const { actions: bulkAvailableActions, showPromote: bulkShowPromote, showVarianceVerify: bulkShowVarianceVerify } =
    deriveBulkActions(selectedAnalyses, parentLineStates, primaryRole, varianceEntitlement)
```

(`primaryRole` and `varianceEntitlement` are component props already in scope — they're passed to each `AnalysisRow` at `:1881-1882`.)

- [ ] **Step 6: Add the toolbar button**

In the toolbar's non-processing branch, immediately after the `{bulkShowPromote && (...)}` block (ends `:1780`), add:

```tsx
                {bulkShowVarianceVerify && (
                  <Button
                    size="sm"
                    disabled={toolbarDisabled}
                    onClick={() => void bulk.executeBulk([...bulk.selectedUids], 'variance_verify')}
                  >
                    Verify (Variance) selected
                  </Button>
                )}
```

Then update the "No common actions" fallback (`:1800`) to also account for the new flag:

```tsx
            {bulkAvailableActions.length === 0 && !bulkShowPromote && !bulkShowVarianceVerify && !bulk.isBulkProcessing && (
```

- [ ] **Step 7: Run the full variance + table suites**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run src/test/variance-verify-gating.test.tsx src/test/assign-step.test.tsx src/test/status-badge.test.tsx src/test/vials-quicklook.test.tsx"`
Expected: PASS (baseline any unrelated red against the prior commit).

- [ ] **Step 8: Commit**

```bash
git -C C:/tmp/Accu-Mk1-subvial add src/components/senaite/AnalysisTable.tsx src/test/variance-verify-gating.test.tsx
git -C C:/tmp/Accu-Mk1-subvial commit -m "feat(variance): bulk Verify (Variance) toolbar action

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] Full FE suite: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && npx vitest run"` → only the documented pre-existing failures (`App.test.tsx`, `peptide-requests-list.test.tsx`).
- [ ] Live check on the stack (FE :5532, login `forrest@valenceanalytical.com` / `test123`; PB-0076 has HPLC variance n=2 already set; HMR is unreliable — use `Ctrl+Shift+R` / fresh tab):
  - PB-0076-S06 HPLC rows show the `Variance` chip pre-signoff; chip absent once a row is promoted or variance-verified.
  - PB-0076 Assignment tab: `Variance ×2` pill on the HPLC bucket.
  - Select only entitled `to_be_verified` HPLC sub-rows → `Verify (Variance) selected` button appears and signs them off; deselect to a mixed/promoted selection → button disappears.
```
