import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  AnalysisTable,
  deriveBulkActions,
  deriveBulkActionsForPolicy,
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
  it.each(['retracted', 'published', 'to_be_verified', 'unassigned'])(
    'parent-native: %s row is display-only',
    state => {
      expect(
        visibleRowTransitionsForPolicy(row({ review_state: state }), 'parent-native')
      ).toEqual([])
    }
  )
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
  it('parent-native: mixed states offer nothing', () => {
    expect(
      deriveBulkActionsForPolicy([row({}), row({ review_state: 'retracted' })], 'parent-native')
        .actions
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
})
