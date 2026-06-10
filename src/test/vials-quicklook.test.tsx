import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n/config'
import { VialsQuickLookDialog } from '@/components/senaite/VialsQuickLookDialog'
import { useUIStore } from '@/store/ui-store'
import type { SenaiteAnalysis, SubSampleListResponse } from '@/lib/api'
import type { SampleSlaSnapshot } from '@/services/order-sla'

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

// Radix DropdownMenu (vial re-assign trigger) drives pointer-capture APIs jsdom lacks.
// Without these shims the menu never opens under userEvent.
window.HTMLElement.prototype.hasPointerCapture = vi.fn()
window.HTMLElement.prototype.setPointerCapture = vi.fn()
window.HTMLElement.prototype.releasePointerCapture = vi.fn()
window.HTMLElement.prototype.scrollIntoView = vi.fn()

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    listSubSamples: vi.fn(),
    listLimsAnalysesForSubSample: vi.fn(),
    listParentLineStates: vi.fn(),
    fetchSubSamplePhotoUrl: vi.fn(),
    patchVialAssignment: vi.fn(),
    fetchVarianceEntitlement: vi.fn(),
    transitionAnalysis: vi.fn(),
  }
})

// Mock the SLA hook wholesale: (1) protect existing tests from VialSection's new
// useAnalysisSlaMap firing real services/groups/sample-sla queries, and (2) give
// test #3 a spy. The hook's internals are covered by analysis-sla.test.tsx.
const fakeSlaSnapshot: SampleSlaSnapshot = {
  groupKey: 100,
  groupName: 'Analytics',
  tier: {
    id: 2,
    name: 'HPLC fast',
    target_minutes: 240,
    business_hours_only: false,
    is_default: false,
    amber_threshold_percent: 80,
    created_at: '2026-01-01T00:00:00',
    updated_at: '2026-01-01T00:00:00',
  },
  status: { elapsed_minutes: 60, remaining_minutes: 180, target_minutes: 240, breached: false },
  color: 'green',
  reason: { tierSource: 'group', unmappedKeywords: [] },
  priority: 'normal',
} as SampleSlaSnapshot

vi.mock('@/services/analysis-sla', () => ({
  useAnalysisSlaMap: vi.fn(() => ({
    byKeyword: new Map([['PUR-HPLC', fakeSlaSnapshot]]),
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

import {
  listSubSamples,
  listLimsAnalysesForSubSample,
  listParentLineStates,
  fetchSubSamplePhotoUrl,
  patchVialAssignment,
  fetchVarianceEntitlement,
  transitionAnalysis,
} from '@/lib/api'
import { useAnalysisSlaMap } from '@/services/analysis-sla'
import { VialPhotoThumb } from '@/components/senaite/vial-quicklook-helpers'
import { AnalysisTable } from '@/components/senaite/AnalysisTable'

const mkAnalysis = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis =>
  ({
    uid: 'mk1:1',
    keyword: 'ENDO',
    title: 'Endotoxin',
    result: '',
    review_state: 'unassigned',
    service_group_name: 'Microbiology',
    result_options: [],
    unit: null,
    method: null,
    method_uid: null,
    method_options: [],
    instrument: null,
    instrument_uid: null,
    instrument_options: [],
    analyst: null,
    due_date: null,
    sort_key: null,
    captured: null,
    retested: false,
    service_group_id: null,
    promoted_to_parent_id: null,
    ...over,
  }) as SenaiteAnalysis

const SUBS: SubSampleListResponse = {
  parent: {
    sample_id: 'P-0144',
    external_lims_uid: null,
    peptide_name: 'BPC-157',
    status: 'received',
    sub_sample_count: 2,
    last_synced_at: '2026-06-05T00:00:00Z',
    assignment_role: 'hplc',
  },
  sub_samples: [
    {
      id: 22,
      sample_id: 'P-0144-S02',
      parent_sample_id: 'P-0144',
      vial_sequence: 2,
      received_at: '2026-06-01T00:00:00Z',
      received_by_user_id: null,
      photo_external_uid: null,
      remarks: null,
      assignment_role: 'endo',
      assignment_kind: 'core',
    },
    {
      id: 21,
      sample_id: 'P-0144-S01',
      parent_sample_id: 'P-0144',
      vial_sequence: 1,
      received_at: '2026-06-01T00:00:00Z',
      received_by_user_id: null,
      photo_external_uid: 'attach-uid-1',
      remarks: null,
      assignment_role: 'hplc',
      assignment_kind: 'variance',
    },
  ],
}

function renderDialog(onOpenChange = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <VialsQuickLookDialog
          open
          onOpenChange={onOpenChange}
          parentSampleId="P-0144"
          analyteNameMap={new Map()}
        />
      </QueryClientProvider>
    </I18nextProvider>
  )
  return { onOpenChange, container: utils.container }
}

// The nav test stubs the store's navigateToSample; snapshot it and restore after
// every test so module-level store state doesn't leak between tests.
const originalNavigateToSample = useUIStore.getState().navigateToSample
afterEach(() => {
  useUIStore.setState({ navigateToSample: originalNavigateToSample })
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listSubSamples).mockResolvedValue(SUBS)
  vi.mocked(listParentLineStates).mockResolvedValue({ states: {} })
  vi.mocked(fetchSubSamplePhotoUrl).mockResolvedValue('blob:fake-photo-1')
  vi.mocked(listLimsAnalysesForSubSample).mockImplementation(async pk =>
    pk === 21
      ? [mkAnalysis({ uid: 'mk1:101', keyword: 'PUR-HPLC', title: 'Purity (HPLC)', service_group_name: 'Analytics' })]
      : [mkAnalysis({ uid: 'mk1:201', keyword: 'ENDO', title: 'Endotoxin' })]
  )
  vi.mocked(patchVialAssignment).mockResolvedValue({
    sample_id: 'P-0144-S01',
    assignment_role: 'endo',
  })
  vi.mocked(fetchVarianceEntitlement).mockResolvedValue({
    variance: { hplcpurity_identity: 3 },
    unreachable: false,
  })
})

describe('VialsQuickLookDialog', () => {
  it('renders one section per vial ordered by vial_sequence with role badges', async () => {
    renderDialog()
    const headers = await screen.findAllByTestId('quicklook-vial-header')
    expect(headers).toHaveLength(2)
    expect(headers[0]).toHaveTextContent('P-0144-S01')
    expect(headers[0]).toHaveTextContent('HPLC')
    expect(headers[1]).toHaveTextContent('P-0144-S02')
    expect(headers[1]).toHaveTextContent('ENDO')
    // each vial's analyses render through AnalysisTable
    expect(await screen.findByText('Purity (HPLC)')).toBeInTheDocument()
    expect(await screen.findByText('Endotoxin')).toBeInTheDocument()
  })

  it('shows the empty state for a vial with no analyses', async () => {
    vi.mocked(listLimsAnalysesForSubSample).mockResolvedValue([])
    renderDialog()
    const empties = await screen.findAllByText('No analyses assigned')
    expect(empties).toHaveLength(2)
  })

  it('isolates a failing vial: error + retry shown while sibling renders rows', async () => {
    vi.mocked(listLimsAnalysesForSubSample).mockImplementation(async pk => {
      if (pk === 22) throw new Error('boom')
      return [mkAnalysis({ uid: 'mk1:101', keyword: 'PUR-HPLC', title: 'Purity (HPLC)', service_group_name: 'Analytics' })]
    })
    renderDialog()
    expect(await screen.findByText('Purity (HPLC)')).toBeInTheDocument()
    expect(await screen.findByText(/Failed to load analyses/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('vial ID click navigates and closes the dialog', async () => {
    const navigateToSample = vi.fn()
    useUIStore.setState({ navigateToSample })
    const { onOpenChange } = renderDialog()
    // wait for the expanded card (steady state); the loading slim-header button
    // is replaced when analyses load, so grab the attached one to click.
    await screen.findByText('Purity (HPLC)')
    const link = await screen.findByRole('button', { name: 'P-0144-S01' })
    await userEvent.click(link)
    expect(navigateToSample).toHaveBeenCalledWith('P-0144-S01')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows the photo thumb for vials with a photo, placeholder otherwise', async () => {
    renderDialog()
    // wait for steady state (both expanded cards mounted) so the transient
    // loading slim-headers have unmounted — otherwise a vial's header briefly
    // exists twice during the load→loaded branch switch (v1.3 remount).
    await screen.findByText('Purity (HPLC)')
    await screen.findByText('Endotoxin')
    const img = await screen.findByAltText('P-0144-S01 photo')
    expect(img).toHaveAttribute('src', 'blob:fake-photo-1')
    // S02 has photo_external_uid: null → placeholder, and no fetch for it.
    // (Exact call count is incidental: when a vial's analyses load, VialSection
    // switches return branches and the cached photo re-fetches — the invariant
    // that matters is the photoless vial never fetches.)
    expect(screen.getAllByText('no photo').length).toBeGreaterThan(0)
    expect(fetchSubSamplePhotoUrl).toHaveBeenCalledWith('P-0144-S01')
    expect(fetchSubSamplePhotoUrl).not.toHaveBeenCalledWith('P-0144-S02')
  })

  it('collapse toggle hides a vial table without unmounting siblings', async () => {
    renderDialog()
    await screen.findByText('Purity (HPLC)')
    const toggles = screen.getAllByRole('button', { name: /collapse vial/i })
    await userEvent.click(toggles[0]!)
    await waitFor(() => {
      expect(screen.queryByText('Purity (HPLC)')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Endotoxin')).toBeInTheDocument()
  })

  it('shows the empty state (not a spinner) for a zero-vial parent', async () => {
    vi.mocked(listSubSamples).mockResolvedValue({
      parent: { ...SUBS.parent, sub_sample_count: 0 },
      sub_samples: [],
    })
    const { container } = renderDialog()
    expect(await screen.findByText('No vials found.')).toBeInTheDocument()
    // the loading spinner (Loader2 renders an svg with animate-spin) must be gone
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('shows "Vial N of X" in each vial header', async () => {
    renderDialog()
    const headers = await screen.findAllByTestId('quicklook-vial-header')
    // family-indexed: parent is vial 1, so seq+1 of count+1 (count=2 → total 3)
    expect(headers[0]).toHaveTextContent('Vial 2 of 3')
    expect(headers[1]).toHaveTextContent('Vial 3 of 3')
  })

  it('re-assign: selecting a role patches the vial and refetches sub-samples', async () => {
    renderDialog()
    await screen.findByText('Purity (HPLC)')
    // first re-assign trigger is S01 (vials sorted ascending by vial_sequence)
    const triggers = screen.getAllByRole('button', { name: /re-assign vial/i })
    await userEvent.click(triggers[0]!)
    const endoItem = await screen.findByText('Microbiology — Endotoxin')
    await userEvent.click(endoItem)
    await waitFor(() => {
      expect(patchVialAssignment).toHaveBeenCalledWith('P-0144-S01', 'endo')
    })
    // invalidating ['sub-samples', parentSampleId] (active) refetches it
    await waitFor(() => {
      expect(listSubSamples).toHaveBeenCalledTimes(2)
    })
  })

  it('re-assign: refetches the parent page overlay queries (parent-overlay-vial-analyses)', async () => {
    // Probe simulating SampleDetails' parent-page overlay query for vial pk 21.
    // Key is the literal string on purpose — it locks the cross-component
    // contract (key drift here = stale parent AR table after re-assign).
    const overlayFn = vi.fn(async () => [])
    function OverlayProbe() {
      useQuery({
        queryKey: ['parent-overlay-vial-analyses', 21],
        queryFn: overlayFn,
        staleTime: Infinity,
      })
      return null
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}>
          <OverlayProbe />
          <VialsQuickLookDialog
            open
            onOpenChange={vi.fn()}
            parentSampleId="P-0144"
            analyteNameMap={new Map()}
          />
        </QueryClientProvider>
      </I18nextProvider>
    )
    await screen.findByText('Purity (HPLC)')
    expect(overlayFn).toHaveBeenCalledTimes(1)
    const triggers = screen.getAllByRole('button', { name: /re-assign vial/i })
    await userEvent.click(triggers[0]!)
    const endoItem = await screen.findByText('Microbiology — Endotoxin')
    await userEvent.click(endoItem)
    await waitFor(() => {
      expect(patchVialAssignment).toHaveBeenCalledWith('P-0144-S01', 'endo')
    })
    // staleTime Infinity → only an explicit invalidation can refetch the probe
    await waitFor(() => {
      expect(overlayFn).toHaveBeenCalledTimes(2)
    })
  })

  it('wires per-vial SLA into AnalysisTable via useAnalysisSlaMap', async () => {
    renderDialog()
    // wait for S01's analyses so the hook has been called with the populated lookup
    await screen.findByText('Purity (HPLC)')
    expect(useAnalysisSlaMap).toHaveBeenCalledWith(
      expect.objectContaining({
        date_received: '2026-06-01T00:00:00Z',
        analyses: expect.arrayContaining([
          expect.objectContaining({ keyword: 'PUR-HPLC' }),
        ]),
      })
    )
  })

  it('merges the vial header into the AnalysisTable card (no double wrap)', async () => {
    renderDialog()
    await screen.findByText('Purity (HPLC)')
    // headerContent replaced AnalysisTable's default "Analyses" title block
    expect(
      screen.queryByText('Analyses', { selector: 'span' })
    ).not.toBeInTheDocument()
    // the vial header now lives inside the same card as the filter tabs
    const tablist = screen.getAllByRole('tablist', { name: /filter analyses/i })[0]!
    const card = tablist.closest('[data-slot="card"]') ?? tablist.parentElement!.parentElement!
    expect(
      within(card as HTMLElement).getByTestId('quicklook-vial-header')
    ).toBeInTheDocument()
  })

  it('offers Verify (Variance) on variance-kind vial rows and applies the transition', async () => {
    vi.mocked(listLimsAnalysesForSubSample).mockImplementation(async pk =>
      pk === 21
        ? [mkAnalysis({ uid: 'mk1:101', keyword: 'PUR-HPLC', title: 'Purity (HPLC)', service_group_name: 'Analytics', review_state: 'to_be_verified', result: '99' })]
        : [mkAnalysis({ uid: 'mk1:201', keyword: 'ENDO', title: 'Endotoxin' })]
    )
    vi.mocked(transitionAnalysis).mockResolvedValue({
      success: true, message: 'ok', new_review_state: 'variance_verified', keyword: 'PUR-HPLC',
    })
    renderDialog()
    await screen.findByText('Purity (HPLC)')
    // S01 (hplc, assignment_kind='variance', to_be_verified): open its row actions menu
    const menus = screen.getAllByRole('button', { name: /analysis actions/i })
    await userEvent.click(menus[0]!)
    const item = await screen.findByText('Verify (Variance)')
    await userEvent.click(item)
    await waitFor(() => {
      expect(transitionAnalysis).toHaveBeenCalledWith('mk1:101', 'variance_verify')
    })
  })
})

describe('AnalysisTable default header (regression lock)', () => {
  it('renders the default Analyses title + progress bar without the new props', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}>
          <AnalysisTable
            analyses={[
              mkAnalysis({ uid: 'mk1:1', keyword: 'PUR-HPLC', title: 'Purity (HPLC)', service_group_name: 'Analytics' }),
            ]}
            analyteNameMap={new Map()}
          />
        </QueryClientProvider>
      </I18nextProvider>
    )
    expect(screen.getByText('Analyses', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('Analysis Progress')).toBeInTheDocument()
  })
})

describe('AnalysisTable promoted-row correction hint', () => {
  const renderTable = (analyses: SenaiteAnalysis[]) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}>
          <AnalysisTable analyses={analyses} analyteNameMap={new Map()} />
        </QueryClientProvider>
      </I18nextProvider>
    )
  }

  it('shows a help affordance on promoted rows (styled tooltip trigger)', () => {
    renderTable([
      mkAnalysis({
        uid: 'mk1:9',
        keyword: 'PUR-HPLC',
        title: 'Purity (HPLC)',
        service_group_name: 'Analytics',
        review_state: 'promoted',
        promoted_to_parent_id: 4812,
      }),
    ])
    // The Radix tooltip content portals only on hover (jsdom-unfriendly, same
    // as the SLA cell), so assert the durable trigger contract: the aria-labeled
    // help affordance is present on a promoted row.
    expect(screen.getByLabelText('How to correct a promoted result')).toBeInTheDocument()
  })

  it('shows no such affordance on a non-promoted row', () => {
    renderTable([
      mkAnalysis({
        uid: 'mk1:10',
        keyword: 'PUR-HPLC',
        title: 'Purity (HPLC)',
        service_group_name: 'Analytics',
        review_state: 'to_be_verified',
        promoted_to_parent_id: null,
      }),
    ])
    expect(screen.queryByLabelText('How to correct a promoted result')).not.toBeInTheDocument()
  })
})

describe('VialPhotoThumb', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchSubSamplePhotoUrl).mockResolvedValue('blob:z')
  })

  it('uses an always-absolute aria-hidden overlay for hover zoom (no layout shift)', async () => {
    const { container } = render(<VialPhotoThumb sampleId="X" hasPhoto hoverZoom />)
    const base = await screen.findByAltText('X photo')
    expect(base).toHaveAttribute('src', 'blob:z')
    // base thumb stays static/in-flow: no hover-expansion, no transition
    expect(base).not.toHaveClass('group-hover:absolute')
    expect(base).not.toHaveClass('transition-all')
    // no '(enlarged)' accessible node anywhere
    expect(screen.queryByAltText('X photo (enlarged)')).not.toBeInTheDocument()
    // the overlay is aria-hidden (empty alt), always absolute + pointer-events-none,
    // hidden at rest, revealed on group-hover
    const overlay = container.querySelector('img[aria-hidden="true"]')
    expect(overlay).not.toBeNull()
    expect(overlay).toHaveClass('absolute')
    expect(overlay).toHaveClass('pointer-events-none')
    expect(overlay).toHaveClass('opacity-0')
    expect(overlay).toHaveClass('group-hover:opacity-100')
  })

  it('renders no overlay when hoverZoom is false', async () => {
    const { container } = render(<VialPhotoThumb sampleId="X" hasPhoto />)
    await screen.findByAltText('X photo')
    expect(container.querySelector('img[aria-hidden="true"]')).toBeNull()
    expect(screen.queryByAltText('X photo (enlarged)')).not.toBeInTheDocument()
  })

  it('shows the placeholder and fetches nothing when hasPhoto is false', async () => {
    render(<VialPhotoThumb sampleId="X" hasPhoto={false} hoverZoom />)
    expect(await screen.findByText('no photo')).toBeInTheDocument()
    expect(screen.queryByAltText('X photo (enlarged)')).not.toBeInTheDocument()
    expect(fetchSubSamplePhotoUrl).not.toHaveBeenCalled()
  })

  it('hideWhenEmpty renders nothing when there is no photo', () => {
    const { container } = render(
      <VialPhotoThumb sampleId="X" hasPhoto={false} hideWhenEmpty />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('hideWhenEmpty renders nothing when the optimistic fetch fails, the thumb once it loads', async () => {
    vi.mocked(fetchSubSamplePhotoUrl).mockRejectedValueOnce(new Error('404'))
    const failed = render(<VialPhotoThumb sampleId="X" hasPhoto hideWhenEmpty />)
    await waitFor(() => expect(fetchSubSamplePhotoUrl).toHaveBeenCalled())
    expect(failed.container).toBeEmptyDOMElement()
    failed.unmount()

    render(<VialPhotoThumb sampleId="Y" hasPhoto hideWhenEmpty />)
    expect(await screen.findByAltText('Y photo')).toHaveAttribute('src', 'blob:z')
  })
})
