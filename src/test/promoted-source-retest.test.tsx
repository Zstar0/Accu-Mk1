/**
 * Task 10: the promoted-source (vial-side) retest seam + warning modal —
 * the up-cascade mirror of Task 7-9's parent-native retest/verify work.
 * Surfaces:
 *   - isPromotedSourceRetestEligible (AnalysisTable.tsx): the pure seam
 *     gate — promoted + mk1: + service_origin='mk1' + not already retested.
 *   - AnalysisTable's row menu: wires the gate to onPromotedNativeRetest,
 *     additive alongside ALLOWED_TRANSITIONS['promoted'] (still []).
 *   - resolvePromotedSourceParentState / resolvePromotedSourceDialogParentState
 *     / runPromotedSourceRetest (native-parent-analyses.ts): the
 *     confirm-flow logic extracted out of SampleDetails so it's directly
 *     testable — SampleDetails() itself has no render harness in this repo
 *     (six nested queries; see sample-details-assignment-label.test.ts).
 *   - PromotedSourceRetestDialog: the warning copy, state-dependent on the
 *     parent's current review_state, failing closed when unknown.
 *   - promotedRowTooltipCopy (AnalysisTable.tsx, fix round 1): which help
 *     tooltip copy a row shows, covering the retracted-parent case
 *     (review round 1 fix) alongside the pre-existing seam-active/default
 *     cases.
 *
 * Fix round 1 (review feedback): the dialog's parent-state resolution
 * originally used a keyword-newest-row heuristic, which diverges from what
 * the backend actually acts on (THIS row's own LimsAnalysisPromotion
 * record) in the retracted-parent window — see
 * resolvePromotedSourceDialogParentState's doc comment for the full
 * discriminator. Fixed to branch on the row's own promoted_to_parent_id
 * first (no extra fetch needed for that branch).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  AnalysisTable,
  ALLOWED_TRANSITIONS_TEST_EXPORT as ALLOWED_TRANSITIONS,
  isPromotedSourceRetestEligible,
  promotedRowTooltipCopy,
} from '@/components/senaite/AnalysisTable'
import {
  resolvePromotedSourceParentState,
  resolvePromotedSourceDialogParentState,
  runPromotedSourceRetest,
  NO_ACTIVE_PROMOTION_PARENT_STATE,
} from '@/lib/native-parent-analyses'
import {
  PromotedSourceRetestDialog,
  type PromotedSourceRetestState,
} from '@/components/senaite/PromotedSourceRetestDialog'
import type { SenaiteAnalysis } from '@/lib/api'

// AnalysisTable uses IntersectionObserver for its sticky-toolbar effect; jsdom doesn't have it.
class MockIntersectionObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  constructor(_cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {}
}
Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
})

// Radix Tooltip (the "How to correct a promoted result" help icon, hovered
// in the fix-round-1 tooltip tests below) uses @radix-ui/react-use-size,
// which needs ResizeObserver; jsdom doesn't have it.
class MockResizeObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  configurable: true,
  value: MockResizeObserver,
})

// Radix DropdownMenu (the row action menu) drives pointer-capture APIs jsdom lacks.
window.HTMLElement.prototype.hasPointerCapture = vi.fn()
window.HTMLElement.prototype.setPointerCapture = vi.fn()
window.HTMLElement.prototype.releasePointerCapture = vi.fn()
window.HTMLElement.prototype.scrollIntoView = vi.fn()

vi.mock('@/components/ui/sidebar', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/ui/sidebar')>()
  return {
    ...actual,
    useSidebar: () => ({
      state: 'expanded' as const,
      open: true,
      setOpen: vi.fn(),
      openMobile: false,
      setOpenMobile: vi.fn(),
      isMobile: false,
      toggleSidebar: vi.fn(),
    }),
  }
})

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, transitionAnalysis: vi.fn() }
})

import { transitionAnalysis } from '@/lib/api'

const row = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis => ({
  uid: 'mk1:501', keyword: 'HM', title: 'Heavy Metals', result: '1', result_options: [],
  unit: null, method: null, method_uid: null, method_options: [], instrument: null,
  instrument_uid: null, instrument_options: [], analyst: null, due_date: null,
  review_state: 'promoted', sort_key: null, captured: null, retested: false,
  service_group_id: null, service_group_name: null, service_origin: 'mk1', ...over,
})

describe('isPromotedSourceRetestEligible', () => {
  it('true for a promoted, mk1:, mk1-origin, not-yet-retested row', () => {
    expect(isPromotedSourceRetestEligible(row({}))).toBe(true)
  })
  it('false when review_state is not promoted', () => {
    expect(isPromotedSourceRetestEligible(row({ review_state: 'verified' }))).toBe(false)
  })
  it('false for a SENAITE (non-mk1:) uid', () => {
    expect(isPromotedSourceRetestEligible(row({ uid: 'a8c27e69bfa84ff1bf16a3e370a44456' }))).toBe(false)
  })
  it('false when the backing service is senaite-origin', () => {
    expect(isPromotedSourceRetestEligible(row({ service_origin: 'senaite' }))).toBe(false)
  })
  it('false when service_origin is missing (unset, legacy row)', () => {
    expect(isPromotedSourceRetestEligible(row({ service_origin: undefined }))).toBe(false)
  })
  it('false once the row has already been retested — the backend 409s a repeat call', () => {
    expect(isPromotedSourceRetestEligible(row({ retested: true }))).toBe(false)
  })
  it('false for a null uid', () => {
    expect(isPromotedSourceRetestEligible(row({ uid: null }))).toBe(false)
  })
})

describe('ALLOWED_TRANSITIONS (default policy) — regression pin', () => {
  it('promoted stays [] — the seam is additive, not baked into the map', () => {
    expect(ALLOWED_TRANSITIONS['promoted']).toEqual([])
  })
})

describe('resolvePromotedSourceParentState', () => {
  const rows = (kw: string, states: string[]): SenaiteAnalysis[] =>
    states.map((s, i) => row({ uid: `mk1:${i}`, keyword: kw, review_state: s }))

  it('takes the LAST row for the keyword as current (mirrors the backend ORDER BY keyword, id)', () => {
    expect(resolvePromotedSourceParentState(rows('HM', ['retracted', 'verified']), 'HM')).toBe('verified')
  })
  it('ignores rows for other keywords', () => {
    const mixed = [...rows('HM', ['verified']), ...rows('HM2', ['published'])]
    expect(resolvePromotedSourceParentState(mixed, 'HM')).toBe('verified')
    expect(resolvePromotedSourceParentState(mixed, 'HM2')).toBe('published')
  })
  it('null when no row matches the keyword', () => {
    expect(resolvePromotedSourceParentState(rows('HM', ['verified']), 'OTHER')).toBeNull()
  })
  it('null for a null keyword', () => {
    expect(resolvePromotedSourceParentState(rows('HM', ['verified']), null)).toBeNull()
  })
})

describe('resolvePromotedSourceDialogParentState (fix round 1: row-first discriminator)', () => {
  it('promoted_to_parent_id null: returns the sentinel WITHOUT calling the fetch — no active promotion to look up', async () => {
    const fetchParentRows = vi.fn()
    const result = await resolvePromotedSourceDialogParentState(
      { promoted_to_parent_id: null, keyword: 'HM' },
      fetchParentRows
    )
    expect(result).toBe(NO_ACTIVE_PROMOTION_PARENT_STATE)
    expect(fetchParentRows).not.toHaveBeenCalled()
  })
  it('promoted_to_parent_id undefined (field omitted): same as null — fetch skipped', async () => {
    const fetchParentRows = vi.fn()
    const result = await resolvePromotedSourceDialogParentState(
      { keyword: 'HM' },
      fetchParentRows
    )
    expect(result).toBe(NO_ACTIVE_PROMOTION_PARENT_STATE)
    expect(fetchParentRows).not.toHaveBeenCalled()
  })
  it('promoted_to_parent_id set: fetches and resolves via the keyword-newest lookup', async () => {
    const rows: SenaiteAnalysis[] = [row({ uid: 'mk1:9', keyword: 'HM', review_state: 'verified' })]
    const fetchParentRows = vi.fn().mockResolvedValue(rows)
    const result = await resolvePromotedSourceDialogParentState(
      { promoted_to_parent_id: 9, keyword: 'HM' },
      fetchParentRows
    )
    expect(fetchParentRows).toHaveBeenCalledOnce()
    expect(result).toBe('verified')
  })
  it('promoted_to_parent_id set, fetch fails: null (dialog fails closed)', async () => {
    const fetchParentRows = vi.fn().mockRejectedValue(new Error('network'))
    const result = await resolvePromotedSourceDialogParentState(
      { promoted_to_parent_id: 9, keyword: 'HM' },
      fetchParentRows
    )
    expect(result).toBeNull()
  })
})

describe('runPromotedSourceRetest', () => {
  it('parses the mk1: uid and calls the injected retest fn with the numeric id', async () => {
    const retest = vi.fn().mockResolvedValue({
      new_row_id: 55, parent_unverified: true, parent_review_state: 'retracted',
    })
    const result = await runPromotedSourceRetest('mk1:123', retest)
    expect(retest).toHaveBeenCalledWith(123)
    expect(result).toEqual({ newRowId: 55, parentUnverified: true, parentReviewState: 'retracted' })
  })
  it('propagates a rejection from the retest fn (caller toasts the message)', async () => {
    const retest = vi.fn().mockRejectedValue(new Error('already retested'))
    await expect(runPromotedSourceRetest('mk1:9', retest)).rejects.toThrow('already retested')
  })
})

describe('PromotedSourceRetestDialog', () => {
  const base: PromotedSourceRetestState = {
    title: 'Heavy Metals', parentSampleId: 'P-0120', parentState: 'verified',
  }

  it('verified parent: names the un-verify blast radius', () => {
    render(<PromotedSourceRetestDialog state={base} pending={false} onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.getByText(/un-verify the parent value on/i)).toBeInTheDocument()
    expect(screen.getByText('P-0120')).toBeInTheDocument()
    expect(screen.getByText(/awaiting re-promotion/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^retest$/i })).not.toBeDisabled()
  })

  it('parent_to_verify (awaiting): same un-verify copy as verified', () => {
    render(
      <PromotedSourceRetestDialog
        state={{ ...base, parentState: 'parent_to_verify' }}
        pending={false} onCancel={() => {}} onConfirm={() => {}}
      />
    )
    expect(screen.getByText(/un-verify the parent value on/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^retest$/i })).not.toBeDisabled()
  })

  it('published parent: COA-untouched copy, action still enabled', () => {
    render(
      <PromotedSourceRetestDialog
        state={{ ...base, parentState: 'published' }}
        pending={false} onCancel={() => {}} onConfirm={() => {}}
      />
    )
    expect(screen.getByText(/NOT touched/)).toBeInTheDocument()
    expect(screen.getByText(/cannot be re-promoted until the COA-snapshot release/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^retest$/i })).not.toBeDisabled()
  })

  it('no-active-promotion sentinel (row-first discriminator, fix round 1): enabled, distinct copy — parent already retracted', () => {
    render(
      <PromotedSourceRetestDialog
        state={{ ...base, parentState: NO_ACTIVE_PROMOTION_PARENT_STATE }}
        pending={false} onCancel={() => {}} onConfirm={() => {}}
      />
    )
    expect(screen.getByText(/already retracted/i)).toBeInTheDocument()
    expect(screen.getByText(/does not change any parent value/i)).toBeInTheDocument()
    expect(screen.queryByText(/could not be determined/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/un-verify the parent value on/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^retest$/i })).not.toBeDisabled()
  })

  it('unknown/null parent state: fails closed, disables the action', () => {
    render(
      <PromotedSourceRetestDialog
        state={{ ...base, parentState: null }}
        pending={false} onCancel={() => {}} onConfirm={() => {}}
      />
    )
    expect(screen.getByText(/could not be determined/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^retest$/i })).toBeDisabled()
  })

  it('unrecognized parent state (e.g. "retracted"): also fails closed', () => {
    render(
      <PromotedSourceRetestDialog
        state={{ ...base, parentState: 'retracted' }}
        pending={false} onCancel={() => {}} onConfirm={() => {}}
      />
    )
    expect(screen.getByText(/could not be determined/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^retest$/i })).toBeDisabled()
  })

  it('renders nothing when state is null', () => {
    const { container } = render(
      <PromotedSourceRetestDialog state={null} pending={false} onCancel={() => {}} onConfirm={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('confirm fires onConfirm only; dialog stays open (Radix auto-close prevented)', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<PromotedSourceRetestDialog state={base} pending={false} onCancel={onCancel} onConfirm={onConfirm} />)
    await userEvent.click(screen.getByRole('button', { name: /^retest$/i }))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByText(/un-verify the parent value on/i)).toBeInTheDocument()
  })

  it('cancel fires onCancel, never onConfirm', async () => {
    // Cancel is wired both as AlertDialogCancel's own onClick AND via
    // onOpenChange (Radix closing the dialog on Cancel triggers both) —
    // same double-fire shape as ParentRetestConfirmDialog's identical
    // structure. Both calls are no-ops downstream (setPromotedRetest(null)
    // is idempotent), so the safety property under test is "never
    // onConfirm," not an exact call count.
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<PromotedSourceRetestDialog state={base} pending={false} onCancel={onCancel} onConfirm={onConfirm} />)
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('pending disables both buttons and shows "Retesting…"', () => {
    render(<PromotedSourceRetestDialog state={base} pending={true} onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.getByRole('button', { name: /^retesting/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled()
  })
})

describe('AnalysisTable render — promoted-source-retest seam (default policy)', () => {
  function renderTable(analyses: SenaiteAnalysis[], onPromotedNativeRetest?: (a: SenaiteAnalysis) => void) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <AnalysisTable
          analyses={analyses}
          analyteNameMap={new Map()}
          resultsReadOnly
          onPromotedNativeRetest={onPromotedNativeRetest}
        />
      </QueryClientProvider>
    )
  }

  beforeEach(() => {
    vi.mocked(transitionAnalysis).mockReset()
  })

  it('all four legs match + prop provided: row menu shows exactly Retest, routed to the callback', async () => {
    const spy = vi.fn()
    const promotedRow = row({})
    renderTable([promotedRow], spy)

    const trigger = screen.getByRole('button', { name: 'Analysis actions' })
    await userEvent.click(trigger)

    expect(await screen.findByRole('menuitem', { name: 'Retest' })).toBeInTheDocument()
    // Nothing else in the menu — no Promote, no Verify, no destructive-styled item.
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)

    await userEvent.click(screen.getByRole('menuitem', { name: 'Retest' }))
    expect(spy).toHaveBeenCalledWith(promotedRow)
    expect(transitionAnalysis).not.toHaveBeenCalled()
  })

  it('prop omitted: no action trigger renders at all — byte-identical to every existing surface', () => {
    renderTable([row({})], undefined)
    expect(screen.queryByRole('button', { name: 'Analysis actions' })).not.toBeInTheDocument()
  })

  it('review_state not promoted (verified): seam does not apply even with the prop present (default policy already offers plain Retest there)', async () => {
    const spy = vi.fn()
    renderTable([row({ review_state: 'verified' })], spy)
    await userEvent.click(screen.getByRole('button', { name: 'Analysis actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Retest' }))
    // Falls through to the plain default-policy retest path, not the seam callback.
    expect(spy).not.toHaveBeenCalled()
  })

  it('senaite-origin service: no action trigger even though promoted + mk1: + prop present', () => {
    renderTable([row({ service_origin: 'senaite' })], vi.fn())
    expect(screen.queryByRole('button', { name: 'Analysis actions' })).not.toBeInTheDocument()
  })

  it('already retested: no action trigger — the backend 409s a repeat source-retest', () => {
    renderTable([row({ retested: true })], vi.fn())
    expect(screen.queryByRole('button', { name: 'Analysis actions' })).not.toBeInTheDocument()
  })

  it('bypasses isLockedByParent deliberately: a locked parentLineStates entry does not suppress the seam', async () => {
    const spy = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <AnalysisTable
          analyses={[row({})]}
          analyteNameMap={new Map()}
          resultsReadOnly
          onPromotedNativeRetest={spy}
          parentLineStates={{ HM: 'verified' }}
        />
      </QueryClientProvider>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Analysis actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Retest' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Retest' }))
    expect(spy).toHaveBeenCalledOnce()
  })

  // Fix round 1 (LOW, adjacent to the dialog-state-resolution fix): the
  // "How to correct a promoted result" tooltip was gated on isPromoted
  // (promoted_to_parent_id != null), so it rendered nothing at all in the
  // retracted-parent state even though the seam is active there. Widened
  // via promotedRowTooltipCopy (see its own pure-fn tests below) — these
  // are cheap presence-only checks (trigger renders / doesn't), since
  // opening Radix Tooltip's content (hover/focus) has no reliable pattern
  // under jsdom in this repo — attempted and abandoned; the copy-selection
  // logic itself is what's actually load-bearing, and that's covered
  // directly and reliably by the pure-fn tests instead.
  it('tooltip trigger renders for a promoted_to_parent_id-null row when the seam is active (would previously render nothing)', () => {
    renderTable([row({ promoted_to_parent_id: null })], vi.fn())
    expect(screen.getByLabelText('How to correct a promoted result')).toBeInTheDocument()
    // The "Promoted → #N" badge needs a real id — stays isPromoted-only.
    expect(screen.queryByText(/Promoted →/)).not.toBeInTheDocument()
  })

  it('tooltip trigger does not render when neither isPromoted nor the seam is active', () => {
    renderTable([row({ promoted_to_parent_id: null, review_state: 'verified' })], vi.fn())
    expect(screen.queryByLabelText('How to correct a promoted result')).not.toBeInTheDocument()
  })
})

describe('promotedRowTooltipCopy (fix round 1)', () => {
  it('retracted-parent: seam active, not currently linked to a live parent', () => {
    expect(promotedRowTooltipCopy(false, true)).toBe('retracted-parent')
  })
  it('seam-active: seam active AND currently linked (the normal case)', () => {
    expect(promotedRowTooltipCopy(true, true)).toBe('seam-active')
  })
  it('default: isPromoted only, seam inactive — the pre-Task-10 copy, unchanged', () => {
    expect(promotedRowTooltipCopy(true, false)).toBe('default')
  })
  it('null: neither isPromoted nor the seam — no tooltip at all', () => {
    expect(promotedRowTooltipCopy(false, false)).toBeNull()
  })
})
