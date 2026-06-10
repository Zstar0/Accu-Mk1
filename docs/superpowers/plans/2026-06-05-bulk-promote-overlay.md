# Bulk Promote Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Verify dead-end on promotable native vial rows (per-row `⋯` menu + bulk toolbar) and add a "Promote selected" bulk action with a read-only confirm dialog.

**Architecture:** Row-level gating reusing the Phase-4b `canPromote` discriminator, lifted to module-level pure helpers (`isPromotable`, `visibleRowTransitions`, `deriveBulkActions`, `deriveBulkPromoteBlockers`) so the row component, bulk toolbar, and tests share one source of truth. A new `BulkPromoteDialog` (colocated beside the existing single-row `PromoteDialog`) lists keyword → value read-only, derives blockers, and executes sequential `promoteAnalyses` calls with in-dialog progress.

**Tech Stack:** React + TypeScript, shadcn/ui (Dialog/Button), vitest + @testing-library/react. All FE — no backend changes. Tests run in container `accumark-subvial-accu-mk1-frontend`.

**Spec:** `docs/superpowers/specs/2026-06-05-bulk-promote-overlay-design.md`.
**Branch:** `subvial/continue` (worktree `C:/tmp/Accu-Mk1-subvial`).

---

## File Structure

- Modify `src/components/senaite/AnalysisTable.tsx` — export pure helpers; row menu uses `visibleRowTransitions`; bulk toolbar uses `deriveBulkActions` + Promote selected button; add `BulkPromoteDialog`.
- Create `src/test/bulk-promote-overlay.test.tsx` — helper unit tests + dialog render tests.

**Test commands:**
- FE tests: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/bulk-promote-overlay.test.tsx"`
- Typecheck: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"` → expect ONLY the 2 known pre-existing errors (`WorksheetsInboxPage.tsx(356,38)`, `SampleDetails.tsx ... subSamples ... never read`).

**Operational notes for all tasks:**
- Locate ALL edit points by symbol name, never line number (line refs below are hints).
- Frontend container bind-mounts the repo at `/app`; host edits are live. Do NOT restart containers.
- Commit only the files each task lists; never touch other dirty files in `docs/superpowers/`.

---

## Task 1: Pure helpers — `isPromotable`, `visibleRowTransitions`, `deriveBulkActions`, `deriveBulkPromoteBlockers`

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx`
- Create test: `src/test/bulk-promote-overlay.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/test/bulk-promote-overlay.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import {
  isPromotable,
  visibleRowTransitions,
  deriveBulkActions,
  deriveBulkPromoteBlockers,
} from '@/components/senaite/AnalysisTable'
import type { SenaiteAnalysis } from '@/lib/api'

const base: Partial<SenaiteAnalysis> = {
  title: 'Rapid Sterility Screening (PCR)',
  keyword: 'STER-PCR',
  result: '11',
}

function mk(overrides: Partial<SenaiteAnalysis>): SenaiteAnalysis {
  return { ...base, ...overrides } as SenaiteAnalysis
}

const promotable = mk({ uid: 'mk1:820', review_state: 'to_be_verified', promoted_to_parent_id: null })
const senaiteTbv = mk({ uid: 'a8c27e69bfa84ff1bf16a3e370a44456', review_state: 'to_be_verified' })

describe('isPromotable', () => {
  it('true for mk1 uid + to_be_verified + unpromoted', () => {
    expect(isPromotable(promotable)).toBe(true)
  })
  it('false for SENAITE uid', () => {
    expect(isPromotable(senaiteTbv)).toBe(false)
  })
  it('false for wrong state', () => {
    expect(isPromotable(mk({ uid: 'mk1:820', review_state: 'verified' }))).toBe(false)
  })
  it('false when already promoted', () => {
    expect(
      isPromotable(mk({ uid: 'mk1:820', review_state: 'to_be_verified', promoted_to_parent_id: 1260 })),
    ).toBe(false)
  })
})

describe('visibleRowTransitions', () => {
  it('drops verify on a promotable row, keeps escape hatches', () => {
    const t = visibleRowTransitions(promotable)
    expect(t).not.toContain('verify')
    expect(t).toContain('retract')
  })
  it('keeps verify on a SENAITE to_be_verified row', () => {
    expect(visibleRowTransitions(senaiteTbv)).toContain('verify')
  })
  it('still gates submit on having a result', () => {
    const unsubmitted = mk({ uid: 'mk1:9', review_state: 'unassigned', result: null })
    expect(visibleRowTransitions(unsubmitted)).not.toContain('submit')
  })
})

describe('deriveBulkActions', () => {
  it('all-promotable selection: no verify, showPromote true', () => {
    const r = deriveBulkActions([promotable, mk({ uid: 'mk1:821', review_state: 'to_be_verified', keyword: 'ENDO' })])
    expect(r.actions).not.toContain('verify')
    expect(r.showPromote).toBe(true)
  })
  it('mixed selection (promotable + SENAITE): no verify, no promote', () => {
    const r = deriveBulkActions([promotable, senaiteTbv])
    expect(r.actions).not.toContain('verify')
    expect(r.showPromote).toBe(false)
  })
  it('pure SENAITE selection keeps verify', () => {
    const r = deriveBulkActions([senaiteTbv])
    expect(r.actions).toContain('verify')
    expect(r.showPromote).toBe(false)
  })
  it('empty selection: nothing', () => {
    const r = deriveBulkActions([])
    expect(r.actions).toEqual([])
    expect(r.showPromote).toBe(false)
  })
})

describe('deriveBulkPromoteBlockers', () => {
  it('no blockers for distinct keywords with results', () => {
    expect(
      deriveBulkPromoteBlockers([promotable, mk({ uid: 'mk1:821', review_state: 'to_be_verified', keyword: 'ENDO' })]),
    ).toEqual([])
  })
  it('flags missing result', () => {
    const blockers = deriveBulkPromoteBlockers([mk({ uid: 'mk1:9', review_state: 'to_be_verified', result: null })])
    expect(blockers.some(b => b.includes('no result'))).toBe(true)
  })
  it('flags duplicate keywords', () => {
    const blockers = deriveBulkPromoteBlockers([
      promotable,
      mk({ uid: 'mk1:9', review_state: 'to_be_verified', keyword: 'STER-PCR' }),
    ])
    expect(blockers.some(b => b.includes('STER-PCR'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/bulk-promote-overlay.test.tsx"`
Expected: FAIL — `isPromotable` etc. are not exported.

- [ ] **Step 3: Add the helpers**

In `src/components/senaite/AnalysisTable.tsx`, near `ALLOWED_TRANSITIONS` / `TRANSITION_LABELS` (module level, before the row component), add:

```tsx
// --- Bulk-overlay redesign: promote-aware gating helpers (exported for tests) ---

/** Phase-4b promotable discriminator, lifted so row + bulk logic share it. */
export function isPromotable(a: SenaiteAnalysis): boolean {
  return (
    !!a.uid &&
    a.uid.startsWith('mk1:') &&
    a.review_state === 'to_be_verified' &&
    a.promoted_to_parent_id == null
  )
}

/** Row-menu transitions: submit needs a result; verify is hidden when Promote
 *  is the correct action (promotable native vial rows dead-end on verify). */
export function visibleRowTransitions(a: SenaiteAnalysis): string[] {
  if (!a.uid || !a.review_state) return []
  return (ALLOWED_TRANSITIONS[a.review_state] ?? []).filter(
    t => (t !== 'submit' || !!a.result) && !(t === 'verify' && isPromotable(a)),
  )
}

const BULK_TRANSITIONS = ['submit', 'retest', 'verify', 'retract', 'reject'] as const
export type BulkTransition = (typeof BULK_TRANSITIONS)[number]

/** Bulk toolbar actions: intersection of allowed transitions, except verify is
 *  suppressed when ANY selected row is promotable; Promote shows when ALL are. */
export function deriveBulkActions(selected: SenaiteAnalysis[]): {
  actions: BulkTransition[]
  showPromote: boolean
} {
  const anyPromotable = selected.some(isPromotable)
  const actions = BULK_TRANSITIONS.filter(
    t =>
      selected.length > 0 &&
      !(t === 'verify' && anyPromotable) &&
      selected.every(
        a =>
          a.review_state !== null &&
          a.review_state !== undefined &&
          (ALLOWED_TRANSITIONS[a.review_state] ?? []).includes(t) &&
          (t !== 'submit' || !!a.result),
      ),
  )
  return { actions, showPromote: selected.length > 0 && selected.every(isPromotable) }
}

/** Reasons bulk promote cannot proceed (empty array = good to go). */
export function deriveBulkPromoteBlockers(selected: SenaiteAnalysis[]): string[] {
  const blockers: string[] = []
  const missing = selected.filter(a => !a.result)
  if (missing.length > 0) {
    blockers.push(
      `${missing.length} selected ${missing.length === 1 ? 'analysis has' : 'analyses have'} no result value`,
    )
  }
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const a of selected) {
    const k = a.keyword ?? ''
    if (seen.has(k)) dups.add(k)
    seen.add(k)
  }
  if (dups.size > 0) {
    blockers.push(
      `Duplicate keywords selected (${[...dups].join(', ')}) — one parent row per keyword; use the row menu Promote to merge multiple vials`,
    )
  }
  return blockers
}
```

Confirm `SenaiteAnalysis` is already imported in AnalysisTable.tsx (it is — the file types `analysis: SenaiteAnalysis` throughout).

- [ ] **Step 4: Run the tests — should pass**

Same command as Step 2. Expected: 14 passed.

- [ ] **Step 5: Typecheck**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"`
Expected: only the 2 pre-existing errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/senaite/AnalysisTable.tsx src/test/bulk-promote-overlay.test.tsx
git commit -m "feat(analysis-table): promote-aware gating helpers

Phase: bulk-promote-overlay, Task 1. isPromotable / visibleRowTransitions /
deriveBulkActions / deriveBulkPromoteBlockers as exported pure helpers.
Verify is suppressed where Promote is the correct action; Promote selected
eligibility = all selected rows promotable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `BulkPromoteDialog`

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx` (new component beside `PromoteDialog`)
- Modify test: `src/test/bulk-promote-overlay.test.tsx` (append)
- Modify: `docs/superpowers/specs/2026-06-05-bulk-promote-overlay-design.md` (one line)

**Context:** The single-row `PromoteDialog` (search for `function PromoteDialog`) is the pattern: shadcn Dialog, `promoteAnalyses` from `@/lib/api`, toast on success/failure. The bulk variant lists rows read-only, derives blockers via `deriveBulkPromoteBlockers` (Task 1), and executes sequentially with in-dialog progress on the confirm button. Note: the spec says progress appears "in the toolbar"; the dialog is modal and covers the toolbar, so progress lives on the confirm button instead — Step 6 updates the spec line to match.

- [ ] **Step 1: Write the failing tests**

Append to `src/test/bulk-promote-overlay.test.tsx`:

```tsx
import { render, fireEvent, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { BulkPromoteDialog } from '@/components/senaite/AnalysisTable'
import * as api from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, promoteAnalyses: vi.fn().mockResolvedValue({}) }
})

describe('BulkPromoteDialog', () => {
  it('lists keyword and value per row, read-only', () => {
    const { getByText } = render(
      <BulkPromoteDialog
        analyses={[promotable, mk({ uid: 'mk1:821', review_state: 'to_be_verified', keyword: 'ENDO', result: '0.4' })]}
        open
        onOpenChange={() => {}}
        onPromoted={() => {}}
      />,
    )
    expect(getByText('STER-PCR')).toBeTruthy()
    expect(getByText('11')).toBeTruthy()
    expect(getByText('ENDO')).toBeTruthy()
    expect(getByText('0.4')).toBeTruthy()
  })

  it('shows blocker and disables confirm when a result is missing', () => {
    const { getByText, getByRole } = render(
      <BulkPromoteDialog
        analyses={[mk({ uid: 'mk1:9', review_state: 'to_be_verified', result: null })]}
        open
        onOpenChange={() => {}}
        onPromoted={() => {}}
      />,
    )
    expect(getByText(/no result/)).toBeTruthy()
    expect((getByRole('button', { name: /^Promote \d/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('promotes each row sequentially then fires onPromoted', async () => {
    const onPromoted = vi.fn()
    const { getByRole } = render(
      <BulkPromoteDialog
        analyses={[promotable, mk({ uid: 'mk1:821', review_state: 'to_be_verified', keyword: 'ENDO', result: '0.4' })]}
        open
        onOpenChange={() => {}}
        onPromoted={onPromoted}
      />,
    )
    fireEvent.click(getByRole('button', { name: /^Promote 2/ }))
    await waitFor(() => expect(onPromoted).toHaveBeenCalled())
    expect(vi.mocked(api.promoteAnalyses)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.promoteAnalyses)).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: 'STER-PCR', result_value: '11', reason: 'Bulk promote from AnalysisTable' }),
    )
  })
})
```

NOTE: the `vi.mock` factory hoists — place the `vi.mock('@/lib/api', ...)` call at the TOP of the test file (above the existing imports of the helpers), not mid-file. The Task 1 helper tests are pure and unaffected by the mock. If `promotable`/`mk` are declared after the mock, that's fine (mock factories run lazily).

- [ ] **Step 2: Run to verify it fails**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/bulk-promote-overlay.test.tsx"`
Expected: FAIL — `BulkPromoteDialog` not exported.

- [ ] **Step 3: Create the component**

In `src/components/senaite/AnalysisTable.tsx`, directly after the closing brace of `PromoteDialog`, add:

```tsx
// --- Bulk promote: read-only confirm dialog, sequential execution ---

export function BulkPromoteDialog({
  analyses,
  open,
  onOpenChange,
  onPromoted,
}: {
  analyses: SenaiteAnalysis[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onPromoted: () => void
}) {
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const blockers = deriveBulkPromoteBlockers(analyses)
  const pending = progress !== null

  const handle = async () => {
    setProgress({ current: 0, total: analyses.length })
    let failed = 0
    for (let i = 0; i < analyses.length; i++) {
      const a = analyses[i]!
      setProgress({ current: i + 1, total: analyses.length })
      if (!a.uid?.startsWith('mk1:') || !a.result) continue
      const limsId = parseInt(a.uid.slice('mk1:'.length), 10)
      try {
        await promoteAnalyses({
          keyword: a.keyword ?? '',
          result_value: a.result,
          result_unit: a.unit ?? null,
          method_id: a.method_uid ? parseInt(a.method_uid, 10) : null,
          instrument_id: a.instrument_uid ? parseInt(a.instrument_uid, 10) : null,
          sources: [{ analysis_id: limsId, contribution_kind: 'chosen' }],
          reason: 'Bulk promote from AnalysisTable',
        })
      } catch (e) {
        failed++
        toast.error(`${a.keyword ?? a.title}: ${(e as Error).message}`)
      }
    }
    setProgress(null)
    if (failed === 0) toast.success(`Promoted ${analyses.length} to parent`)
    else toast.warning(`Promoted ${analyses.length - failed} of ${analyses.length}; ${failed} failed`)
    onOpenChange(false)
    onPromoted()
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!pending) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Promote {analyses.length} analyses to parent</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <p className="text-sm text-muted-foreground">
            Each row creates a parent-tier verified row with the vial's current value. Vial-tier
            rows stay in <code>to_be_verified</code>; audit rows record each promotion. To undo,
            retract the parent row.
          </p>
          <table className="w-full text-sm">
            <tbody>
              {analyses.map(a => (
                <tr key={a.uid} className="border-b border-border/50">
                  <td className="py-1.5 pr-3 font-medium">{a.keyword ?? a.title}</td>
                  <td className="py-1.5 font-mono">{a.result ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {blockers.map(b => (
            <p key={b} className="text-sm text-destructive">{b}</p>
          ))}
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={handle} disabled={pending || blockers.length > 0}>
              {pending && progress
                ? `Promoting ${progress.current}/${progress.total}…`
                : `Promote ${analyses.length} to parent`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

All imports (`Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `Button`, `toast`, `promoteAnalyses`, `useState`) already exist in AnalysisTable.tsx — confirm at the top of the file.

- [ ] **Step 4: Run the tests — should pass**

Same command as Step 2. Expected: 17 passed (14 + 3).

- [ ] **Step 5: Typecheck**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"`
Expected: only the 2 pre-existing errors.

- [ ] **Step 6: Align the spec's progress wording**

In `docs/superpowers/specs/2026-06-05-bulk-promote-overlay-design.md`, change the line:

`3. Progress text in the toolbar like existing bulk transitions ("Promoting 2/4…").`

to:

`3. Progress text on the dialog's confirm button ("Promoting 2/4…") — the modal covers the toolbar, so in-dialog progress replaces the toolbar treatment.`

- [ ] **Step 7: Commit**

```bash
git add src/components/senaite/AnalysisTable.tsx src/test/bulk-promote-overlay.test.tsx docs/superpowers/specs/2026-06-05-bulk-promote-overlay-design.md
git commit -m "feat(analysis-table): BulkPromoteDialog

Phase: bulk-promote-overlay, Task 2. Read-only keyword/value confirm
dialog with blocker gating (missing results, duplicate keywords) and
sequential promoteAnalyses execution with in-dialog progress; failures
toast and continue.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire the row menu + bulk toolbar

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx` (row component + main table)

- [ ] **Step 1: Row menu uses `visibleRowTransitions`**

In the row component (search for `// Phase 4b: Promote affordance`), the local `allowedTransitions` is currently computed inline (~line 850):

```tsx
  const allowedTransitions =
    analysis.uid && analysis.review_state
      ? (ALLOWED_TRANSITIONS[analysis.review_state] ?? []).filter(
          t => t !== 'submit' || !!analysis.result
        )
      : []
```

Replace with:

```tsx
  const allowedTransitions = visibleRowTransitions(analysis)
```

And the local `canPromote` (~line 859):

```tsx
  const canPromote =
    !!analysis.uid
    && analysis.uid.startsWith('mk1:')
    && analysis.review_state === 'to_be_verified'
    && (analysis.promoted_to_parent_id == null)
```

Replace with:

```tsx
  const canPromote = isPromotable(analysis)
```

(Keep the explanatory comment above it; trim it to reference the shared helper.)

- [ ] **Step 2: Bulk toolbar uses `deriveBulkActions` + Promote selected**

In the main `AnalysisTable` component:

a) Add dialog state next to `bulkPendingConfirm` (search for `const [bulkPendingConfirm`):

```tsx
  const [bulkPromoteOpen, setBulkPromoteOpen] = useState(false)
```

b) Replace the inline `bulkAvailableActions` computation (search for `// Bulk available actions`):

```tsx
  // Bulk available actions — promote-aware intersection (see deriveBulkActions)
  const { actions: bulkAvailableActions, showPromote: bulkShowPromote } =
    deriveBulkActions(selectedAnalyses)
```

(`selectedAnalyses` is already computed immediately above — keep it.)

c) In the toolbar JSX (search for `bulkAvailableActions.map`), add the Promote button BEFORE the mapped transition buttons, inside the same non-processing branch:

```tsx
              <>
                {bulkShowPromote && (
                  <Button
                    size="sm"
                    disabled={toolbarDisabled}
                    onClick={() => setBulkPromoteOpen(true)}
                  >
                    Promote selected
                  </Button>
                )}
                {bulkAvailableActions.map(t => (
                  /* ...existing button markup unchanged... */
                ))}
              </>
```

d) Update the "No common actions" empty-state condition (search for `No common actions`) to account for Promote:

```tsx
            {bulkAvailableActions.length === 0 && !bulkShowPromote && !bulk.isBulkProcessing && (
```

e) Mount the dialog near the existing bulk confirm dialog (search for `Bulk destructive transition confirmation`), adding before/after it:

```tsx
      {/* Bulk promote confirm */}
      <BulkPromoteDialog
        analyses={selectedAnalyses}
        open={bulkPromoteOpen}
        onOpenChange={setBulkPromoteOpen}
        onPromoted={() => {
          bulk.clearSelection()
          onTransitionComplete?.()
        }}
      />
```

Confirm `onTransitionComplete` is in scope in the main component (it's a destructured prop) — if the existing code refreshes through a different callback name, match that.

- [ ] **Step 3: Full test file + typecheck**

Run: `docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/bulk-promote-overlay.test.tsx src/test/analysis-mk1-indicator.test.tsx && node_modules/.bin/tsc --noEmit 2>&1 | tail -10"`
Expected: 21 passed (17 + 4); only the 2 pre-existing typecheck errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/senaite/AnalysisTable.tsx
git commit -m "feat(analysis-table): wire promote-aware row menu + bulk toolbar

Phase: bulk-promote-overlay, Task 3. Row menu hides Verify on promotable
vial rows; bulk toolbar suppresses Verify selected when any selected row
is promotable and offers Promote selected when all are, opening
BulkPromoteDialog. Selection clears + table refreshes after promotion.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Remove Verify only where Promote applies (row menu) → Task 1 `visibleRowTransitions` + Task 3 Step 1. ✓
- Bulk: verify suppressed when any selected promotable; Promote selected when all → Task 1 `deriveBulkActions` + Task 3 Step 2. ✓
- Read-only confirm dialog, values as-is, blockers (missing result, duplicate keywords) → Task 2. ✓
- Sequential promoteAnalyses, failures toast + continue, one refresh at end → Task 2 handler + Task 3 `onPromoted`. ✓
- Testing matrix from spec → Tasks 1–2 tests. ✓
- Progress wording deviation (in-dialog vs toolbar) → spec amended in Task 2 Step 6. ✓

**2. Placeholder scan:** `/* ...existing button markup unchanged... */` in Task 3 Step 2c is a keep-as-is instruction for code that already exists at the anchored location, not a placeholder. No TBDs.

**3. Type consistency:** `isPromotable`/`visibleRowTransitions`/`deriveBulkActions`/`deriveBulkPromoteBlockers`/`BulkPromoteDialog` names consistent across Tasks 1–3 and tests. `BulkTransition` type used only internally. Dialog props `{analyses, open, onOpenChange, onPromoted}` match between Task 2 component and Task 3 mount. ✓
