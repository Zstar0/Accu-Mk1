/**
 * Task 7: NativeParentAnalysesCard now renders the shared AnalysisTable
 * (verbPolicy='parent-native') instead of its own flat-list markup — see
 * task-7-brief.md. Reads shaped rows via listNativeParentAnalysesShaped;
 * retest cascades through parentRetestAnalysis, gated by
 * ParentRetestConfirmDialog (blast-radius confirm, fails closed with no
 * promotion record).
 *
 * isParentPage is passed as an explicit prop rather than derived from a
 * sampleId regex — SampleDetails already computes `parentSampleId === null`
 * for the sibling overlay queries — so "never fetches on a sub-sample page"
 * below is a real assertion against the query's `enabled` gate (the mock is
 * called or not), not a tautological check of a hand-rolled predicate. That
 * gate is unique to this card; nothing else in the suite can reach it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NativeParentAnalysesCard } from '@/components/senaite/SampleDetails'
import {
  listNativeParentAnalysesShaped,
  parentRetestAnalysis,
  transitionAnalysis,
  type SenaiteAnalysis,
  type SenaiteLookupResult,
  type ParentPromotionInfo,
} from '@/lib/api'
import { NATIVE_PARENT_ANALYSES_QUERY_KEY } from '@/lib/native-parent-analyses'
import { useAnalysisSlaMap } from '@/services/analysis-sla'

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

// Radix DropdownMenu (row action menu) + AlertDialog drive pointer-capture APIs jsdom lacks.
window.HTMLElement.prototype.hasPointerCapture = vi.fn()
window.HTMLElement.prototype.setPointerCapture = vi.fn()
window.HTMLElement.prototype.releasePointerCapture = vi.fn()
window.HTMLElement.prototype.scrollIntoView = vi.fn()

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    listNativeParentAnalysesShaped: vi.fn(),
    parentRetestAnalysis: vi.fn(),
    transitionAnalysis: vi.fn(),
  }
})

// Mock the SLA hook wholesale — same pattern as src/test/vials-quicklook.test.tsx:
// protects this render test from real services/groups/sample-sla queries firing;
// the hook's own internals are covered by analysis-sla.test.tsx. Imported below
// so the "wires the native rows in" test can assert on its call arguments —
// the card's one novel piece of SLA wiring is building a synthetic lookup
// ({...lookup, analyses: nativeRows}) instead of passing the page lookup
// straight through, and only a call-args assertion can catch a regression
// back to the latter (the rendered table looks identical either way since
// this mock ignores its argument).
vi.mock('@/services/analysis-sla', () => ({
  useAnalysisSlaMap: vi.fn(() => ({
    byKeyword: new Map(),
    isLoading: false,
    isError: false,
    isPublished: false,
    priority: null,
  })),
}))

// AnalysisTable calls useSidebar internally; stub it so tests don't need a full SidebarProvider.
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

// Copy of Task 5's shapedRow builder (analysis-table-verb-policy.test.tsx).
const shapedRow = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis => ({
  uid: 'mk1:7', keyword: 'HM', title: 'Heavy Metals', result: '1', result_options: [],
  unit: null, method: null, method_uid: null, method_options: [], instrument: null,
  instrument_uid: null, instrument_options: [], analyst: null, due_date: null,
  review_state: 'verified', sort_key: null, captured: null, retested: false,
  service_group_id: null, service_group_name: null, ...over,
})

function fakeLookup(overrides: Partial<SenaiteLookupResult> = {}): SenaiteLookupResult {
  return {
    sample_id: 'P-0120',
    sample_uid: 'uid-P-0120',
    client: null,
    contact: null,
    sample_type: null,
    date_received: '2026-08-01T00:00:00',
    date_sampled: null,
    profiles: [],
    client_order_number: null,
    client_sample_id: null,
    client_lot: null,
    review_state: 'sample_received',
    declared_weight_mg: null,
    analytes: [],
    remarks: [],
    analyses: [],
    attachments: [],
    published_coa: null,
    senaite_url: null,
    cached_at: null,
    ...overrides,
  } as unknown as SenaiteLookupResult
}

const promo = (keyword: string, ids: (string | null)[]): ParentPromotionInfo => ({
  keyword,
  parent_analysis_id: 1,
  promoted_at: '2026-08-01T00:00:00Z',
  sources: ids.map(sample_id => ({ sample_id, contribution_kind: 'primary' })),
})

function renderCard(
  rows: SenaiteAnalysis[],
  promos: Map<string, ParentPromotionInfo> = new Map(),
  opts: {
    staleSpy?: () => void
    qc?: QueryClient
    sampleId?: string
    isParentPage?: boolean
  } = {}
) {
  vi.mocked(listNativeParentAnalysesShaped).mockResolvedValue(rows)
  const qc = opts.qc ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={qc}>
      <NativeParentAnalysesCard
        sampleId={opts.sampleId ?? 'P-0120'}
        isParentPage={opts.isParentPage ?? true}
        lookup={fakeLookup({ date_received: '2026-08-01' })}
        promotionsByKeyword={promos}
        onParentDataStale={opts.staleSpy}
      />
    </QueryClientProvider>
  )
  return { ...utils, qc }
}

describe('NativeParentAnalysesCard', () => {
  beforeEach(() => {
    vi.mocked(listNativeParentAnalysesShaped).mockReset()
    vi.mocked(parentRetestAnalysis).mockReset()
    vi.mocked(transitionAnalysis).mockReset()
    vi.mocked(useAnalysisSlaMap).mockClear()
  })

  it('renders the shared AnalysisTable with the card header folded in', async () => {
    const { container } = renderCard([shapedRow({})])

    expect(await screen.findByText('Accu-Mk1 Analyses')).toBeInTheDocument()
    // A table row with the analysis title + a state badge. Scoped to the
    // <table> — "Verified" also appears as a filter-tab label outside it.
    const table = screen.getByRole('table')
    expect(within(table).getByText('Heavy Metals')).toBeInTheDocument()
    expect(within(table).getByText('Verified')).toBeInTheDocument()
    // The shared table's column headers and filter tabs are visible — the
    // old flat-list markup (a `divide-y` div, no headers/tabs) is gone.
    expect(screen.getByText('Result')).toBeInTheDocument()
    expect(screen.getByText('Method')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /All/ })).toBeInTheDocument()
    expect(container.querySelector('.divide-y')).not.toBeInTheDocument()
  })

  it('renders nothing while empty', async () => {
    const { container } = renderCard([])

    await waitFor(() => expect(listNativeParentAnalysesShaped).toHaveBeenCalledWith('P-0120'))
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('Accu-Mk1 Analyses')).not.toBeInTheDocument()
  })

  it('never fetches on a sub-sample page', async () => {
    const { container } = renderCard([shapedRow({})], new Map(), {
      sampleId: 'P-0120-S01',
      isParentPage: false,
    })

    // Give any (incorrect) fetch a chance to fire before asserting it didn't.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(listNativeParentAnalysesShaped).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })

  it('wires the native rows into useAnalysisSlaMap, not the page lookup straight through', async () => {
    // The card's one novel piece of SLA wiring: it must build a synthetic
    // lookup ({...lookup, analyses: nativeRows}) since the page's own
    // lookup.analyses are SENAITE rows that never contain native keywords
    // (see the card's slaLookup comment). A regression back to passing
    // `lookup` straight through would still render an identical table (the
    // hook is mocked), so only a call-args assertion catches it.
    renderCard([shapedRow({ keyword: 'HM' })])
    await screen.findByText('Heavy Metals')

    expect(useAnalysisSlaMap).toHaveBeenCalledWith(
      expect.objectContaining({
        date_received: '2026-08-01',
        analyses: expect.arrayContaining([
          expect.objectContaining({ keyword: 'HM' }),
        ]),
      })
    )
  })

  it('verified row offers only Retest; lineage rows are display-only', async () => {
    // Same title/keyword → one retest-chain group: the last row in the
    // array is `current`, the earlier one is its history entry (`1 prev`).
    // The history row is 'verified'+retested (NOT 'retracted') on purpose:
    // AnalysisTable's default 'All' filter drops retracted/rejected rows
    // from `filteredAnalyses` before grouping even runs (SENAITE's "Valid"
    // view convention — see the `all` branch of its filter), so a genuinely
    // retracted row can never surface as a collapsed history entry under
    // the default tab; it would only ever appear on its own under the
    // Invalid tab. A superseded-but-still-valid row (retested: true) is
    // the real shape of a history entry here.
    renderCard([
      shapedRow({ uid: 'mk1:1', retested: true }),
      shapedRow({ uid: 'mk1:2' }),
    ])
    await screen.findByText('Heavy Metals')

    const historyToggle = screen.getByRole('button', { name: /1 prev/i })
    expect(historyToggle).toBeInTheDocument()

    // Verified (current) row's menu offers only Retest.
    await userEvent.click(screen.getByRole('button', { name: 'Analysis actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Retest' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Promote' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Verify (Variance)' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')

    // Expanding history reveals the superseded lineage row with no menu
    // trigger of its own — only the current row's trigger exists.
    await userEvent.click(historyToggle)
    expect(await screen.findByText('Superseded')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Analysis actions' })).toHaveLength(1)
  })

  it('results and method/instrument are not editable', async () => {
    // mk1: uid + to_be_verified would normally be result-editable
    // (isResultEditable's MK1_EDITABLE_STATES) — resultsReadOnly must
    // override that, or this assertion is tautological.
    renderCard([
      shapedRow({ uid: 'mk1:3', review_state: 'to_be_verified', result: '1' }),
    ])
    await screen.findByText('Heavy Metals')

    expect(screen.queryByRole('button', { name: /Edit result for/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit method for/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit instrument for/i })).not.toBeInTheDocument()
  })

  it('retest confirm names the blast radius and fires the parent-retest route', async () => {
    const promos = new Map([['HM', promo('HM', ['P-0120-S01', 'P-0120-S02'])]])
    vi.mocked(parentRetestAnalysis).mockResolvedValue({ new_row_ids: [101, 102], parent_review_state: null })
    const staleSpy = vi.fn()
    const { qc } = renderCard(
      [shapedRow({ uid: 'mk1:4', keyword: 'HM', title: 'Heavy Metals', review_state: 'verified' })],
      promos,
      { staleSpy }
    )
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    await screen.findByText('Heavy Metals')

    await userEvent.click(screen.getByRole('button', { name: 'Analysis actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Retest' }))

    expect(await screen.findByText(/retracts 2 promoted source results/i)).toBeInTheDocument()
    expect(screen.getByText(/P-0120-S01, P-0120-S02/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^retest$/i }))

    await waitFor(() => expect(parentRetestAnalysis).toHaveBeenCalledTimes(1))
    expect(parentRetestAnalysis).toHaveBeenCalledWith('P-0120', 'HM')
    await waitFor(() => expect(staleSpy).toHaveBeenCalled())
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: [NATIVE_PARENT_ANALYSES_QUERY_KEY] })
  })

  it('retest confirm fails closed with no promotion record', async () => {
    renderCard(
      [shapedRow({ uid: 'mk1:5', keyword: 'HM', title: 'Heavy Metals', review_state: 'verified' })],
      new Map()
    )
    await screen.findByText('Heavy Metals')

    await userEvent.click(screen.getByRole('button', { name: 'Analysis actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Retest' }))

    expect(await screen.findByText(/no promoted source results are visible for this row/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^retest$/i })).toBeDisabled()
    expect(parentRetestAnalysis).not.toHaveBeenCalled()
  })

  it('parent_to_verify row renders the "To Verify" badge', async () => {
    renderCard([
      shapedRow({ uid: 'mk1:6', keyword: 'HM', title: 'Heavy Metals', review_state: 'parent_to_verify' }),
    ])
    await screen.findByText('Heavy Metals')

    const table = screen.getByRole('table')
    expect(within(table).getByText('To Verify')).toBeInTheDocument()
  })

  it('verify completion invalidates the native-parent-analyses query and calls onParentDataStale', async () => {
    vi.mocked(transitionAnalysis).mockResolvedValue({
      success: true, message: 'ok', new_review_state: 'verified', keyword: 'HM',
    })
    const staleSpy = vi.fn()
    const { qc } = renderCard(
      [shapedRow({ uid: 'mk1:6', keyword: 'HM', title: 'Heavy Metals', review_state: 'parent_to_verify' })],
      new Map(),
      { staleSpy }
    )
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    await screen.findByText('Heavy Metals')

    await userEvent.click(screen.getByRole('button', { name: 'Analysis actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Verify' }))

    await waitFor(() => expect(transitionAnalysis).toHaveBeenCalledWith('mk1:6', 'verify'))
    await waitFor(() => expect(staleSpy).toHaveBeenCalled())
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: [NATIVE_PARENT_ANALYSES_QUERY_KEY] })
  })
})
