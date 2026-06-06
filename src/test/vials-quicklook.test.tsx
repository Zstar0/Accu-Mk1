import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n/config'
import { VialsQuickLookDialog } from '@/components/senaite/VialsQuickLookDialog'
import { useUIStore } from '@/store/ui-store'
import type { SenaiteAnalysis, SubSampleListResponse } from '@/lib/api'

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

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    listSubSamples: vi.fn(),
    listLimsAnalysesForSubSample: vi.fn(),
    listParentLineStates: vi.fn(),
    fetchSubSamplePhotoUrl: vi.fn(),
  }
})

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
} from '@/lib/api'

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
    const link = await screen.findByRole('button', { name: 'P-0144-S01' })
    await userEvent.click(link)
    expect(navigateToSample).toHaveBeenCalledWith('P-0144-S01')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows the photo thumb for vials with a photo, placeholder otherwise', async () => {
    renderDialog()
    const img = await screen.findByAltText('P-0144-S01 photo')
    expect(img).toHaveAttribute('src', 'blob:fake-photo-1')
    // S02 has photo_external_uid: null → placeholder, and no fetch for it
    expect(screen.getByText('no photo')).toBeInTheDocument()
    expect(fetchSubSamplePhotoUrl).toHaveBeenCalledTimes(1)
    expect(fetchSubSamplePhotoUrl).toHaveBeenCalledWith('P-0144-S01')
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
})
