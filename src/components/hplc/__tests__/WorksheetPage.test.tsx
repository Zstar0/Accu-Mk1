import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import type { WorksheetListItem } from '@/lib/api'
import type * as WorksheetDrawerHook from '@/hooks/use-worksheet-drawer'
import { getWorksheet } from '@/lib/api'
import { useWorksheetDrawer } from '@/hooks/use-worksheet-drawer'
import { useUIStore } from '@/store/ui-store'
import { WorksheetPage } from '@/components/hplc/WorksheetPage'
import { WorksheetDrawer } from '@/components/hplc/WorksheetDrawer'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getWorksheet: vi.fn(),
  getWorksheetUsers: vi.fn().mockResolvedValue([]),
  getInstruments: vi.fn().mockResolvedValue([]),
  getMethods: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/hooks/use-worksheet-drawer', async importOriginal => ({
  ...(await importOriginal<typeof WorksheetDrawerHook>()),
  useWorksheetDrawer: vi.fn(),
}))
vi.mock('@/components/hplc/prep/HplcWorksheetPage', () => ({
  HplcWorksheetPage: ({ worksheet }: { worksheet: WorksheetListItem }) => (
    <div>hplc page for WS-{worksheet.id}</div>
  ),
}))
vi.mock('@/components/hplc/endo/EndoWorksheetPage', () => ({
  EndoWorksheetPage: () => <div>endo page</div>,
}))
vi.mock('@/components/hplc/endo/EndoFlyoutSummary', () => ({
  EndoFlyoutSummary: () => <div>endo summary</div>,
}))
vi.mock('@/components/hplc/BenchRunLog', () => ({ BenchRunLog: () => null }))
vi.mock('@/components/hplc/AddSamplesModal', () => ({ default: () => null }))
vi.mock('@/components/hplc/WorksheetDrawerHeader', () => ({
  default: () => null,
}))
vi.mock('@/components/hplc/WorksheetDrawerItems', () => ({
  default: () => <div>generic items</div>,
}))
vi.mock('@/components/hplc/EndoWorksheetActions', () => ({
  EndoWorksheetActions: () => null,
}))

function worksheetOf(roles: string[]): WorksheetListItem {
  return {
    id: 7,
    title: 'WS 7',
    status: 'open',
    notes: null,
    assigned_analyst: null,
    assigned_analyst_email: null,
    item_count: roles.length,
    created_at: null,
    completed_at: null,
    items: roles.map((role, i) => ({
      id: 11 + i,
      sample_id: `P-000${i + 1}-S01`,
      assignment_role: role,
      analyses: [],
    })),
  } as unknown as WorksheetListItem
}

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
)

describe('WorksheetPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('WorksheetPage shows the HPLC page for an all-HPLC worksheet and the endo page otherwise', async () => {
    useUIStore.setState({ worksheetPageId: 7 })
    vi.mocked(getWorksheet).mockResolvedValue(worksheetOf(['hplc', 'hplc']))
    const { unmount } = render(wrap(<WorksheetPage />))
    expect(await screen.findByText('hplc page for WS-7')).toBeInTheDocument()
    unmount()

    vi.mocked(getWorksheet).mockResolvedValue(worksheetOf(['endo']))
    const second = render(wrap(<WorksheetPage />))
    expect(await screen.findByText('endo page')).toBeInTheDocument()
    second.unmount()

    vi.mocked(getWorksheet).mockResolvedValue(worksheetOf(['hplc', 'endo']))
    render(wrap(<WorksheetPage />))
    expect(await screen.findByText('endo page')).toBeInTheDocument()
    expect(screen.queryByText(/hplc page/)).not.toBeInTheDocument()
  })

  it('the drawer opens the HPLC worksheet page', () => {
    const ws = worksheetOf(['hplc'])
    const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
    vi.mocked(useWorksheetDrawer).mockReturnValue({
      openWorksheets: [ws],
      activeWorksheet: ws,
      isResolvingActive: false,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      updateMutation: mutation,
      removeMutation: mutation,
      completeMutation: mutation,
      reassignMutation: mutation,
      updateItemMutation: mutation,
      bulkTicksMutation: mutation,
      freezeWellsMutation: mutation,
      unfreezeWellsMutation: mutation,
      addNoteMutation: mutation,
      applyMethodInstrumentMutation: mutation,
      reorderMutation: mutation,
      addItemMutation: mutation,
    } as unknown as ReturnType<typeof useWorksheetDrawer>)
    useUIStore.setState({
      worksheetDrawerOpen: true,
      activeWorksheetId: 7,
      worksheetPageId: null,
    })
    render(wrap(<WorksheetDrawer />))
    // the editable flyout stays (Start Prep, remove and reassign live there)
    expect(screen.getByText('generic items')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Add Samples' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open worksheet' }))
    const ui = useUIStore.getState()
    expect(ui.worksheetDrawerOpen).toBe(false)
    expect(ui.activeSubSection).toBe('worksheet')
    expect(ui.worksheetPageId).toBe(7)
  })
})
