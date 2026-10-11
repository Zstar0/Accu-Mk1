import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import type { WorksheetListItem } from '@/lib/api'
import type * as SlaSubjects from '@/services/sla-subjects'

// The page's own wiring is under test: the store's id, GET /worksheets/{id},
// the endo check and Box 1 on 2 mL. Leaves that fetch on their own are stubbed.
vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getWorksheet: vi.fn(),
  listWorksheets: vi.fn().mockResolvedValue([]),
  getWorksheetUsers: vi.fn().mockResolvedValue([]),
  getInstruments: vi.fn().mockResolvedValue([]),
  getMethods: vi.fn().mockResolvedValue([]),
  listConsumables: vi.fn().mockResolvedValue([]),
  updateWorksheetItem: vi.fn(),
}))
vi.mock('@/hooks/use-lab-calendar', () => ({
  useLabCalendar: () => ({ calendar: null, isLoading: false }),
}))
vi.mock('@/services/sla-subjects', async importOriginal => ({
  ...(await importOriginal<typeof SlaSubjects>()),
  useSlaForSubjects: () => ({
    byKey: new Map(),
    isLoading: false,
    isError: false,
  }),
}))
vi.mock('@/hooks/use-flags', () => ({ useEntityFlags: () => ({ data: [] }) }))
vi.mock('@/services/flag-types', () => ({ useFlagTypesMap: () => ({}) }))
vi.mock('@/components/flags/use-active-flag-entity', () => ({
  useRegisterActiveFlagEntity: () => undefined,
}))
vi.mock('@/components/flags/EntityFlagButton', () => ({
  EntityFlagButton: () => null,
}))
vi.mock('@/components/flags/RaiseFlagButton', () => ({
  RaiseFlagButton: () => null,
}))
vi.mock('@/components/hplc/BenchRunLog', () => ({ BenchRunLog: () => null }))
vi.mock('@/components/hplc/EndoWorksheetActions', () => ({
  EndoWorksheetActions: () => null,
}))
vi.mock('@/components/hplc/ReassignButton', () => ({
  ReassignButton: () => null,
}))
vi.mock('@/components/hplc/SlaAgeIndicator', () => ({
  SlaAgeIndicator: () => null,
}))
vi.mock('@/components/hplc/AddSamplesModal', () => ({ default: () => null }))

import { getWorksheet, updateWorksheetItem } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { EndoWorksheetPage } from '@/components/hplc/endo/EndoWorksheetPage'

function worksheet(
  role: string,
  over: Partial<WorksheetListItem> = {}
): WorksheetListItem {
  return {
    id: 42,
    title: 'Endo 10/10/2026',
    status: 'open',
    notes: null,
    assigned_analyst: null,
    assigned_analyst_email: null,
    item_count: 1,
    created_at: null,
    completed_at: null,
    endo_prep: '2ml',
    cartridge_type_id: null,
    cartridge_sensitivity_eu_ml: null,
    endo_method_id: null,
    endo_method: {
      id: 9,
      name: 'Endotoxin',
      revision: 3,
      status: 'active',
      run_parameters: null,
      cartridges: [
        {
          id: 1,
          name: 'Endosafe 0.05',
          sensitivity_eu_ml: 0.05,
          is_default: true,
          active: true,
        },
      ],
    },
    items: [
      {
        id: 10,
        sample_id: 'P-0001-S01',
        sample_uid: 'mk1://endo-10',
        assignment_role: role,
        analyses: [],
        priority: 'normal',
        prep_status: 'ready',
        date_received: null,
        declared_weight_mg: 10,
        sample_identity: 'BPC-157',
      },
    ],
    ...over,
  } as WorksheetListItem
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <EndoWorksheetPage />
    </QueryClientProvider>
  )
}

describe('EndoWorksheetPage', () => {
  beforeEach(() => {
    vi.mocked(getWorksheet).mockReset()
    useUIStore.getState().navigateToWorksheet(42)
  })

  it('loads the worksheet by id and shows Box 1 on 2 mL with the run header', async () => {
    vi.mocked(getWorksheet).mockResolvedValue(worksheet('endo'))
    renderPage()
    expect(
      await screen.findByText('1 · Sample intake: reconstitute each vial')
    ).toBeInTheDocument()
    expect(getWorksheet).toHaveBeenCalledWith(42)
    expect((screen.getByLabelText('Prep') as HTMLSelectElement).value).toBe(
      '2ml'
    )
    expect(screen.getByText('Endotoxin rev 3')).toBeInTheDocument()
    expect(
      screen.getByLabelText('Form the vial arrived in')
    ).toBeInTheDocument()
    expect(
      screen.getByText('2 · Sample dilution: from the vial to the cartridge')
    ).toBeInTheDocument()
  })

  it('a stock run keeps the stock columns', async () => {
    vi.mocked(getWorksheet).mockResolvedValue(
      worksheet('endo', { endo_prep: 'stock' })
    )
    renderPage()
    expect(await screen.findByText(/Sample volume/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Form the vial arrived in')).toBeNull()
    expect(screen.queryByLabelText('Run cartridge')).toBeNull()
    expect(screen.queryByText(/Sample dilution/)).toBeNull()
  })

  it('switching worksheets in the run log drops the title being edited', async () => {
    vi.mocked(getWorksheet).mockImplementation(async id =>
      worksheet('endo', { id, title: `Endo run ${id}` })
    )
    renderPage()
    expect(await screen.findByText('Endo run 42')).toBeInTheDocument()
    act(() => useUIStore.getState().navigateToWorksheet(43))
    expect(await screen.findByText('Endo run 43')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(screen.getByLabelText('Worksheet title')).toBeInTheDocument()
    // 42 is cached, so the page goes straight back to it with no skeleton.
    act(() => useUIStore.getState().navigateToWorksheet(42))
    expect(await screen.findByText('Endo run 42')).toBeInTheDocument()
    expect(screen.queryByLabelText('Worksheet title')).toBeNull()
  })

  it("shows the server's refusal of a Box 2 edit on its row", async () => {
    const refusal =
      'prep_total_dilution must be at least 20 (the step 1 ratio x the fixed 1:2 step) or step 2 cannot be made'
    vi.mocked(getWorksheet).mockResolvedValue(worksheet('endo'))
    vi.mocked(updateWorksheetItem).mockRejectedValue(new Error(refusal))
    renderPage()
    const total = await screen.findByLabelText('Total dilution (1 in N)')
    fireEvent.change(total, { target: { value: '15' } })
    fireEvent.blur(total)
    expect(await screen.findByText(`Not saved: ${refusal}`)).toBeInTheDocument()
    expect(updateWorksheetItem).toHaveBeenCalledWith(42, 10, {
      prep_total_dilution: 15,
    })
  })

  it('offers the flyout for a worksheet that is not endotoxin', async () => {
    vi.mocked(getWorksheet).mockResolvedValue(worksheet('pcr'))
    renderPage()
    expect(
      await screen.findByRole('button', { name: 'Open in flyout' })
    ).toBeInTheDocument()
  })
})
