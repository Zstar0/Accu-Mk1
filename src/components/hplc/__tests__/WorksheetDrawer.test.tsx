import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorksheetDrawer } from '@/components/hplc/WorksheetDrawer'
import { useWorksheetDrawer } from '@/hooks/use-worksheet-drawer'
import type * as WorksheetDrawerHook from '@/hooks/use-worksheet-drawer'
import type { WorksheetListItem } from '@/lib/api'
import type * as ApiModule from '@/lib/api'
import { useUIStore } from '@/store/ui-store'

// Keep the module's other exports (worksheetPageKey, mergeItemPatch): the
// endo pieces import them.
vi.mock('@/hooks/use-worksheet-drawer', async importOriginal => ({
  ...(await importOriginal<typeof WorksheetDrawerHook>()),
  useWorksheetDrawer: vi.fn(),
}))
vi.mock('@/components/hplc/endo/EndoFlyoutSummary', () => ({
  EndoFlyoutSummary: () => <div>endo summary</div>,
}))
vi.mock('@/components/hplc/PcrWorksheetView', () => ({
  PcrWorksheetView: () => <div>pcr view</div>,
}))
vi.mock('@/components/hplc/BenchRunLog', () => ({ BenchRunLog: () => null }))
vi.mock('@/components/hplc/AddSamplesModal', () => ({ default: () => null }))
// The generic (editable) flyout's pieces: the item list says which worksheet
// it was handed, so the endo line's 2 mL prep can be traced to it.
vi.mock('@/components/hplc/WorksheetDrawerHeader', () => ({
  default: () => null,
}))
vi.mock('@/components/hplc/WorksheetDrawerItems', () => ({
  default: ({ worksheet }: { worksheet?: WorksheetListItem }) => (
    <div>
      {worksheet
        ? `generic items of WS-${worksheet.id}`
        : 'generic items without worksheet'}
    </div>
  ),
}))
vi.mock('@/components/hplc/EndoWorksheetActions', () => ({
  EndoWorksheetActions: () => null,
}))
vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getWorksheetUsers: vi.fn().mockResolvedValue([]),
  getInstruments: vi.fn().mockResolvedValue([]),
  getMethods: vi.fn().mockResolvedValue([]),
}))

describe('WorksheetDrawer', () => {
  it.todo('renders FAB with item count badge (WSHT-01)')
  it.todo('opens Sheet on FAB click')
  it.todo('renders header with title, analyst, status, date, count (WSHT-01)')
  it.todo(
    'shows complete confirmation dialog on Complete Worksheet click (WSHT-07)'
  )
  it.todo('marks worksheet completed on confirm (WSHT-07)')
})

describe('WorksheetDrawer: bench kinds (endo v2)', () => {
  const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }

  /** Opens the flyout on a worksheet holding one item per role given. The
   *  worksheet is on 2 mL, as every new worksheet is by default (HPLC too). */
  function openWith(...roles: string[]): HTMLElement {
    const ws = {
      id: 1,
      title: 'WS 1',
      status: 'open',
      notes: null,
      assigned_analyst: null,
      assigned_analyst_email: null,
      item_count: roles.length,
      created_at: null,
      completed_at: null,
      endo_prep: '2ml',
      items: roles.map((role, i) => ({
        id: 11 + i,
        sample_id: `P-000${i + 1}-S02`,
        assignment_role: role,
        analyses: [],
      })),
    } as unknown as WorksheetListItem
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
    useUIStore.setState({ worksheetDrawerOpen: true, activeWorksheetId: 1 })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorksheetDrawer />
      </QueryClientProvider>
    )
    return screen.getByRole('dialog')
  }

  beforeEach(() => vi.clearAllMocks())

  it('shows the read-only endo summary at the 1100px width', () => {
    const sheet = openWith('endo')
    expect(screen.getByText('endo summary')).toBeInTheDocument()
    expect(sheet.className).toContain('sm:max-w-[1100px]')
    expect(sheet.className).not.toContain('sm:max-w-[1760px]')
  })

  it('keeps the PCR bench view at its wide width', () => {
    const sheet = openWith('pcr')
    expect(screen.getByText('pcr view')).toBeInTheDocument()
    expect(sheet.className).toContain('sm:max-w-[1760px]')
  })

  // Ruling (Task 17): endo_prep defaults to 2ml on every new worksheet, so it
  // cannot mark one as endo; an empty worksheet keeps the editable flyout,
  // where samples get added.
  it('keeps the generic editable flyout on an empty worksheet', () => {
    const sheet = openWith()
    expect(screen.queryByText('endo summary')).not.toBeInTheDocument()
    expect(screen.getByText('generic items of WS-1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add Samples' })).toBeVisible()
    expect(sheet.className).toContain('sm:max-w-[1100px]')
  })

  it('hands a mixed worksheet to the item list, where the endo line reads its prep', () => {
    const sheet = openWith('endo', 'pcr')
    expect(screen.queryByText('endo summary')).not.toBeInTheDocument()
    expect(screen.queryByText('pcr view')).not.toBeInTheDocument()
    expect(screen.getByText('generic items of WS-1')).toBeInTheDocument()
    expect(sheet.className).toContain('sm:max-w-[1100px]')
  })
})
