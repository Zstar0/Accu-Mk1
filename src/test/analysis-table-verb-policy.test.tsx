import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  AnalysisTable,
  deriveBulkActions,
  deriveBulkActionsForPolicy,
  isParentBenchRow,
  visibleRowTransitions,
  visibleRowTransitionsForPolicy,
} from '@/components/senaite/AnalysisTable'
import type { SenaiteAnalysis } from '@/lib/api'

// AnalysisTable uses IntersectionObserver for its sticky-toolbar effect; jsdom doesn't have it.
// Must be a real class (not arrow function) since AnalysisTable does `new IntersectionObserver(...)`.
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

// Radix DropdownMenu (the row action menu) drives pointer-capture APIs jsdom
// lacks. Without these shims the menu never opens under userEvent.
window.HTMLElement.prototype.hasPointerCapture = vi.fn()
window.HTMLElement.prototype.setPointerCapture = vi.fn()
window.HTMLElement.prototype.releasePointerCapture = vi.fn()
window.HTMLElement.prototype.scrollIntoView = vi.fn()

// AnalysisTable calls useSidebar internally; stub it so the test doesn't need
// a full SidebarProvider (mirrors src/test/vials-quicklook.test.tsx).
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
  uid: 'mk1:7', keyword: 'HM', title: 'Heavy Metals', result: '1', result_options: [],
  unit: null, method: null, method_uid: null, method_options: [], instrument: null,
  instrument_uid: null, instrument_options: [], analyst: null, due_date: null,
  review_state: 'verified', sort_key: null, captured: null, retested: false,
  service_group_id: null, service_group_name: null, ...over,
})

describe('visibleRowTransitionsForPolicy', () => {
  it('parent-native: verified row offers exactly retest', () => {
    expect(visibleRowTransitionsForPolicy(row({}), 'parent-native')).toEqual(['retest'])
  })
  it('parent-native: parent_to_verify (awaiting) row offers verify + retest', () => {
    expect(
      visibleRowTransitionsForPolicy(row({ review_state: 'parent_to_verify' }), 'parent-native')
    ).toEqual(['verify', 'retest'])
  })
  it.each(['retracted', 'to_be_verified', 'unassigned'])(
    'parent-native: %s row is display-only',
    state => {
      expect(
        visibleRowTransitionsForPolicy(row({ review_state: state }), 'parent-native')
      ).toEqual([])
    }
  )
  it('parent-native: published row offers retest (published-parent-retest ruling 2026-08-28)', () => {
    expect(
      visibleRowTransitionsForPolicy(row({ review_state: 'published' }), 'parent-native')
    ).toEqual(['retest'])
  })
  it('parent-native: published row already retested is display-only (repeat retest is a no-op)', () => {
    expect(
      visibleRowTransitionsForPolicy(
        row({ review_state: 'published', retested: true }), 'parent-native'
      )
    ).toEqual([])
  })
  it('default policy delegates to the legacy fn unchanged', () => {
    const a = row({ review_state: 'to_be_verified' })
    expect(visibleRowTransitionsForPolicy(a, 'default')).toEqual(visibleRowTransitions(a))
    // Regression pin for the optional 3rd arg: a delegation that silently
    // dropped parentLineStates would still pass the no-args case above. Use
    // a parentLineStates map that actually changes the output (locks the
    // row, per isLockedByParent) so a dropped arg is caught, not masked.
    const locked: Record<string, string> = { HM: 'verified' }
    expect(visibleRowTransitionsForPolicy(a, 'default', locked)).toEqual(
      visibleRowTransitions(a, locked)
    )
    expect(visibleRowTransitionsForPolicy(a, 'default', locked)).toEqual([])
  })
})

describe('deriveBulkActionsForPolicy', () => {
  it('parent-native: all-verified selection offers retest only, no side channels', () => {
    expect(deriveBulkActionsForPolicy([row({}), row({ uid: 'mk1:8' })], 'parent-native')).toEqual({
      actions: ['retest'], showPromote: false, showVarianceVerify: false,
    })
  })
  it('parent-native: all-parent_to_verify selection offers verify only', () => {
    expect(
      deriveBulkActionsForPolicy(
        [row({ review_state: 'parent_to_verify' }), row({ uid: 'mk1:8', review_state: 'parent_to_verify' })],
        'parent-native'
      )
    ).toEqual({ actions: ['verify'], showPromote: false, showVarianceVerify: false })
  })
  it('parent-native: mixed states offer nothing', () => {
    expect(
      deriveBulkActionsForPolicy([row({}), row({ review_state: 'retracted' })], 'parent-native')
        .actions
    ).toEqual([])
  })
  it('parent-native: mixed parent_to_verify/verified offer nothing', () => {
    expect(
      deriveBulkActionsForPolicy(
        [row({ review_state: 'parent_to_verify' }), row({ uid: 'mk1:8', review_state: 'verified' })],
        'parent-native'
      ).actions
    ).toEqual([])
  })
  it('default policy delegates to the legacy fn unchanged', () => {
    const sel = [row({ review_state: 'to_be_verified' })]
    expect(deriveBulkActionsForPolicy(sel, 'default')).toEqual(deriveBulkActions(sel))
    // Regression pin for the optional 3rd/4th args: a delegation that
    // silently dropped parentLineStates and/or vialKind would still pass
    // the no-args case above. An EMPTY parentLineStates object is NOT a
    // discriminating value here — isLockedByParent treats {} the same as
    // undefined (no key matches), and showVarianceVerify doesn't consult
    // anyLocked at all — so {} would pass even with parentLineStates
    // silently dropped. Use a map keyed to the row's own keyword ('HM')
    // that actually locks it, flipping `actions` from ['retest','retract',
    // 'reject'] (unlocked, per the no-args case above) to [] (locked).
    // vialKind='variance' independently flips showVarianceVerify true.
    const parentLineStates: Record<string, string> = { HM: 'verified' }
    expect(deriveBulkActionsForPolicy(sel, 'default', parentLineStates, 'variance')).toEqual(
      deriveBulkActions(sel, parentLineStates, 'variance')
    )
    expect(deriveBulkActionsForPolicy(sel, 'default', parentLineStates, 'variance')).toEqual({
      actions: [], showPromote: false, showVarianceVerify: true,
    })
  })
})

describe('AnalysisTable render — parent-native verb policy', () => {
  function renderTable(analyses: SenaiteAnalysis[], onParentRetest: (a: SenaiteAnalysis) => void) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <AnalysisTable
          analyses={analyses}
          analyteNameMap={new Map()}
          verbPolicy="parent-native"
          resultsReadOnly
          onParentRetest={onParentRetest}
        />
      </QueryClientProvider>
    )
  }

  beforeEach(() => {
    vi.mocked(transitionAnalysis).mockReset()
  })

  it('verified row offers only Retest, routes through onParentRetest, and never opens the built-in destructive confirm', async () => {
    const spy = vi.fn()
    const verifiedRow = row({ uid: 'mk1:7', review_state: 'verified' })
    const retractedRow = row({
      uid: 'mk1:8', keyword: 'HM2', title: 'Heavy Metals 2', review_state: 'retracted',
    })
    renderTable([verifiedRow, retractedRow], spy)

    // Default 'all' filter excludes retracted rows, so only the verified
    // row's action trigger is present.
    const trigger = screen.getByRole('button', { name: 'Analysis actions' })
    await userEvent.click(trigger)

    expect(await screen.findByRole('menuitem', { name: 'Retest' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Promote' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Verify' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Verify (Variance)' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('menuitem', { name: 'Retest' }))

    expect(spy).toHaveBeenCalledWith(verifiedRow)
    expect(transitionAnalysis).not.toHaveBeenCalled()
    expect(screen.queryByText('Retract analysis?')).not.toBeInTheDocument()
    expect(screen.queryByText('Reject analysis?')).not.toBeInTheDocument()

    // Switch to the Invalid tab to bring the retracted row into view — it
    // should be the only row, and it must render no action menu at all.
    await userEvent.click(screen.getByRole('tab', { name: /Invalid/ }))
    expect(await screen.findByText('Heavy Metals 2')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Analysis actions' })).not.toBeInTheDocument()
  })

  it('parent_to_verify (awaiting) row offers Verify + Retest; clicking Verify routes through the generic transition endpoint, not onParentRetest', async () => {
    vi.mocked(transitionAnalysis).mockResolvedValue({
      success: true, message: 'ok', new_review_state: 'verified', keyword: 'HM',
    })
    const spy = vi.fn()
    const awaitingRow = row({ uid: 'mk1:9', review_state: 'parent_to_verify' })
    renderTable([awaitingRow], spy)

    await userEvent.click(screen.getByRole('button', { name: 'Analysis actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Verify' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Retest' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('menuitem', { name: 'Verify' }))

    await waitFor(() => expect(transitionAnalysis).toHaveBeenCalledWith('mk1:9', 'verify'))
    expect(spy).not.toHaveBeenCalled()
  })

  it('bulk: two parent_to_verify rows selected offer "Verify selected", firing transitionAnalysis per uid', async () => {
    vi.mocked(transitionAnalysis).mockResolvedValue({
      success: true, message: 'ok', new_review_state: 'verified', keyword: 'HM',
    })
    const spy = vi.fn()
    const rowA = row({ uid: 'mk1:10', keyword: 'HM', title: 'Heavy Metals', review_state: 'parent_to_verify' })
    const rowB = row({
      uid: 'mk1:11', keyword: 'HM2', title: 'Heavy Metals 2', review_state: 'parent_to_verify',
    })
    renderTable([rowA, rowB], spy)

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Heavy Metals' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Heavy Metals 2' }))

    expect(screen.queryByRole('button', { name: 'Retest selected' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Verify selected' }))

    await waitFor(() => expect(transitionAnalysis).toHaveBeenCalledWith('mk1:10', 'verify'))
    await waitFor(() => expect(transitionAnalysis).toHaveBeenCalledWith('mk1:11', 'verify'))
    expect(spy).not.toHaveBeenCalled()
  })
})

// Task 7 (methods bench-stamping): the Wrench "Set method / instrument" row
// action must render ONLY for mk1:-origin rows in a STAMPABLE_STATES review
// state, under the default verb policy. parent-native is exercised
// separately since it's expected to be display-only even for a row state
// STAMPABLE_STATES would otherwise allow (see the 'parent-native: %s row is
// display-only' pin above, which already covers 'to_be_verified').
describe('AnalysisTable render — Set method / instrument gating', () => {
  function renderDefaultTable(analyses: SenaiteAnalysis[]) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <AnalysisTable analyses={analyses} analyteNameMap={new Map()} />
      </QueryClientProvider>
    )
  }

  it('default policy: mk1 to_be_verified row offers it', async () => {
    renderDefaultTable([row({ uid: 'mk1:20', review_state: 'to_be_verified' })])
    await userEvent.click(screen.getByRole('button', { name: 'Analysis actions' }))
    expect(
      await screen.findByRole('menuitem', { name: /set method \/ instrument/i })
    ).toBeInTheDocument()
  })

  it('default policy: non-mk1 (SENAITE) row in the same state does not offer it', async () => {
    renderDefaultTable([row({ uid: 'senaite-uid-1', review_state: 'to_be_verified' })])
    await userEvent.click(screen.getByRole('button', { name: 'Analysis actions' }))
    // Other to_be_verified verbs (Retest/Verify/...) still render, proving
    // the menu opened and this omission is real, not an empty menu.
    expect(await screen.findByRole('menuitem', { name: 'Retest' })).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: /set method \/ instrument/i })
    ).not.toBeInTheDocument()
  })

  it('default policy: mk1 verified row (outside STAMPABLE_STATES) does not offer it', async () => {
    renderDefaultTable([row({ uid: 'mk1:21', review_state: 'verified' })])
    await userEvent.click(screen.getByRole('button', { name: 'Analysis actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Retest' })).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: /set method \/ instrument/i })
    ).not.toBeInTheDocument()
  })

  it('parent-native policy: mk1 to_be_verified row stays display-only (no action trigger at all)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <AnalysisTable
          analyses={[row({ uid: 'mk1:22', review_state: 'to_be_verified' })]}
          analyteNameMap={new Map()}
          verbPolicy="parent-native"
          resultsReadOnly
          onParentRetest={vi.fn()}
        />
      </QueryClientProvider>
    )
    // Same idiom as the "display-only" pin above — parent-native suppresses
    // the whole trigger when it has nothing to offer, and Set method/
    // instrument must not be the thing that keeps it alive here.
    expect(screen.queryByRole('button', { name: 'Analysis actions' })).not.toBeInTheDocument()
  })
})

describe('default policy — parent_to_verify (read-flip main table seam)', () => {
  // The registry-sourced main table surfaces canonical parent rows in
  // 'parent_to_verify' (seam between #96's card-scoped verbs and the
  // read-flip). The default policy offers exactly Verify — retest stays
  // card-only: the generic endpoint tier-blocks parent retest and the
  // Accu-Mk1 card owns that destructive confirm + cascade.
  it('row offers exactly verify', () => {
    expect(visibleRowTransitions(row({ review_state: 'parent_to_verify' }))).toEqual(['verify'])
  })
  it('bulk: all-parent_to_verify selection offers verify', () => {
    expect(
      deriveBulkActions([
        row({ review_state: 'parent_to_verify' }),
        row({ uid: 'mk1:8', review_state: 'parent_to_verify' }),
      ])
    ).toEqual({ actions: ['verify'], showPromote: false, showVarianceVerify: false })
  })
  it('bulk: mixed parent_to_verify + verified offers nothing (empty intersection)', () => {
    expect(
      deriveBulkActions([
        row({ review_state: 'parent_to_verify' }),
        row({ uid: 'mk1:8', review_state: 'verified' }),
      ]).actions
    ).toEqual([])
  })
})

// ── Parent registry retest seam (read-flip main table, 2026-08-28) ─────────
// In mk1 read mode the main AnalysisTable is the native parent surface; the
// generic transition endpoint tier-blocks parent retest, so retest on a
// canonical parent row must route through onParentRetest (the dedicated
// route) — and published canonical rows gain the verb (Handler ruling).

describe('visibleRowTransitionsForPolicy — parent registry retest seam', () => {
  const canonical = (over: Partial<SenaiteAnalysis> = {}) =>
    row({ provenance: 'canonical', ...over })

  it('seam: published canonical mk1 row offers retest', () => {
    expect(
      visibleRowTransitionsForPolicy(
        canonical({ review_state: 'published' }), 'default', undefined, true
      )
    ).toEqual(['retest'])
  })
  it('seam: published canonical row already retested offers nothing', () => {
    expect(
      visibleRowTransitionsForPolicy(
        canonical({ review_state: 'published', retested: true }), 'default', undefined, true
      )
    ).toEqual([])
  })
  it('seam: published SHADOW row offers nothing (mirror rows are not natively retestable)', () => {
    expect(
      visibleRowTransitionsForPolicy(
        row({ provenance: 'shadow', review_state: 'published' }), 'default', undefined, true
      )
    ).toEqual([])
  })
  it('seam: parent_to_verify canonical row offers verify + retest (matches the card policy)', () => {
    expect(
      visibleRowTransitionsForPolicy(
        canonical({ review_state: 'parent_to_verify' }), 'default', undefined, true
      )
    ).toEqual(['verify', 'retest'])
  })
  it('seam off: published rows stay display-only (other surfaces byte-identical)', () => {
    expect(
      visibleRowTransitionsForPolicy(canonical({ review_state: 'published' }), 'default')
    ).toEqual([])
  })
})

describe('deriveBulkActionsForPolicy — parent registry retest seam', () => {
  const canonical = (over: Partial<SenaiteAnalysis> = {}) =>
    row({ provenance: 'canonical', ...over })

  it('seam: all-eligible verified + published selection offers retest', () => {
    expect(
      deriveBulkActionsForPolicy(
        [canonical({}), canonical({ uid: 'mk1:8', review_state: 'published' })],
        'default', undefined, undefined, true
      ).actions
    ).toEqual(['retest'])
  })
  it('seam: a shadow row in the selection kills bulk retest (generic path would tier-block)', () => {
    expect(
      deriveBulkActionsForPolicy(
        [canonical({}), row({ uid: 'mk1:8', provenance: 'shadow' })],
        'default', undefined, undefined, true
      ).actions
    ).toEqual([])
  })
  it('seam: all-parent_to_verify selection keeps verify only (retest stays a row verb there)', () => {
    expect(
      deriveBulkActionsForPolicy(
        [canonical({ review_state: 'parent_to_verify' }),
         canonical({ uid: 'mk1:8', review_state: 'parent_to_verify' })],
        'default', undefined, undefined, true
      ).actions
    ).toEqual(['verify'])
  })
})

describe('AnalysisTable render — parent registry retest seam (default policy)', () => {
  function renderSeamTable(
    analyses: SenaiteAnalysis[],
    onParentRetest: (a: SenaiteAnalysis) => void,
    onParentBulkRetest?: (a: SenaiteAnalysis[]) => void,
  ) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <AnalysisTable
          analyses={analyses}
          analyteNameMap={new Map()}
          resultsReadOnly
          parentRegistryRetestSeam
          onParentRetest={onParentRetest}
          onParentBulkRetest={onParentBulkRetest}
        />
      </QueryClientProvider>
    )
  }

  beforeEach(() => {
    vi.mocked(transitionAnalysis).mockReset()
  })

  it('verified canonical row routes Retest through onParentRetest, never the generic endpoint (the PB-0486 regression)', async () => {
    const spy = vi.fn()
    const verifiedRow = row({ provenance: 'canonical', review_state: 'verified' })
    renderSeamTable([verifiedRow], spy)

    await userEvent.click(screen.getByRole('button', { name: 'Analysis actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Retest' }))

    expect(spy).toHaveBeenCalledWith(verifiedRow)
    expect(transitionAnalysis).not.toHaveBeenCalled()
  })

  it('published canonical row offers Retest and routes through onParentRetest', async () => {
    const spy = vi.fn()
    const publishedRow = row({ provenance: 'canonical', review_state: 'published' })
    renderSeamTable([publishedRow], spy)

    await userEvent.click(screen.getByRole('button', { name: 'Analysis actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Retest' }))

    expect(spy).toHaveBeenCalledWith(publishedRow)
    expect(transitionAnalysis).not.toHaveBeenCalled()
  })

  it('bulk: two eligible rows selected offer "Retest selected", routed through onParentBulkRetest', async () => {
    const rowSpy = vi.fn()
    const bulkSpy = vi.fn()
    const a = row({ provenance: 'canonical', uid: 'mk1:10', keyword: 'HM', title: 'Heavy Metals', review_state: 'verified' })
    const b = row({ provenance: 'canonical', uid: 'mk1:11', keyword: 'HM2', title: 'Heavy Metals 2', review_state: 'published' })
    renderSeamTable([a, b], rowSpy, bulkSpy)

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Heavy Metals' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Heavy Metals 2' }))
    await userEvent.click(screen.getByRole('button', { name: 'Retest selected' }))

    expect(bulkSpy).toHaveBeenCalledWith([a, b])
    expect(transitionAnalysis).not.toHaveBeenCalled()
  })
})

// ─── Parent-bench exemption (Handler ruling 2026-08-31, BW-0106) ────────────
// A shadow row whose keyword has no vial assignment is a test with no vial
// home (Bac Water's Benzyl/pH/Fill trio) — the parent IS the bench, so the
// parent page's result-entry deterrent (resultsReadOnly) must not apply.

describe('isParentBenchRow', () => {
  it('shadow row with no vial assignment is exempt', () => {
    expect(isParentBenchRow({ provenance: 'shadow' }, undefined)).toBe(true)
  })
  it('shadow row WITH a vial assignment keeps the deterrent', () => {
    expect(
      isParentBenchRow({ provenance: 'shadow' }, { matches: [], editable: false })
    ).toBe(false)
  })
  it.each(['canonical', 'ordered', undefined, null])(
    'provenance %s is never exempt',
    prov => {
      expect(isParentBenchRow({ provenance: prov as string | null }, undefined)).toBe(false)
    }
  )
})

describe('AnalysisTable render — parent-bench result entry', () => {
  function renderReadOnlyTable(
    analyses: SenaiteAnalysis[],
    vialAssignmentByKeyword?: Map<string, { matches: never[]; editable: boolean }>
  ) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <AnalysisTable
          analyses={analyses}
          analyteNameMap={new Map()}
          resultsReadOnly
          vialAssignmentByKeyword={
            vialAssignmentByKeyword as Parameters<typeof AnalysisTable>[0]['vialAssignmentByKeyword']
          }
        />
      </QueryClientProvider>
    )
  }

  const bwShadow = row({
    uid: 'aeba844fa4bb404f9ef05f993fcd67f7',
    keyword: 'PH-DETERM',
    title: 'pH Determination',
    result: null,
    review_state: 'unassigned',
    provenance: 'shadow',
  } as Partial<SenaiteAnalysis>)

  it('shadow row with no vial home renders the result input despite resultsReadOnly', () => {
    renderReadOnlyTable([bwShadow])
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('same row with a vial assignment for its keyword stays read-only', () => {
    renderReadOnlyTable(
      [bwShadow],
      new Map([['PH-DETERM', { matches: [] as never[], editable: false }]])
    )
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('canonical parent row stays read-only', () => {
    renderReadOnlyTable([
      row({
        uid: 'mk1:9', keyword: 'HM-PB', result: null,
        review_state: 'unassigned', provenance: 'canonical',
      } as Partial<SenaiteAnalysis>),
    ])
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
