import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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
  getEndoPrepRules: vi.fn().mockResolvedValue([]),
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

// Expedited, so bench order (due date, then priority) alone puts it first.
const BAC_WATER = {
  id: 11,
  sample_id: 'BW-0101',
  sample_uid: 'mk1://endo-11',
  assignment_role: 'endo',
  analyses: [],
  priority: 'expedited',
  prep_status: 'ready',
  date_received: null,
  declared_weight_mg: null,
  sample_identity: 'Bacteriostatic Water',
} as unknown as WorksheetListItem['items'][number]

/** The worksheet with bac water ahead of the peptide. */
function bacWaterFirst(over: Partial<WorksheetListItem> = {}) {
  const ws = worksheet('endo', over)
  return { ...ws, items: [BAC_WATER, ...ws.items], item_count: 2 }
}

/** A table's rows as [row number, is it the bac water]. */
function numbered(table: HTMLElement | undefined) {
  return within(table as HTMLElement)
    .getAllByRole('row')
    .slice(1)
    .map(tr => [
      tr.querySelector('td')?.textContent,
      tr.textContent?.includes('BW-0101'),
    ])
}

/** The Calculations legend as [term, its first line]. */
function calculations() {
  const heading = screen.getByRole('heading', { name: 'Calculations' })
  const dl = heading.nextElementSibling as HTMLElement
  return [...dl.querySelectorAll('div')].map(cell => [
    cell.querySelector('dt')?.textContent,
    cell.querySelector('dd')?.firstChild?.textContent,
  ])
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
    expect(screen.getByRole('combobox', { name: 'Prep' })).toHaveTextContent(
      /^2 mL$/
    )
    expect(screen.getByText('Endotoxin rev 3')).toBeInTheDocument()
    expect(
      screen.getByLabelText('Form the vial arrived in')
    ).toBeInTheDocument()
    expect(
      screen.getByText('2 · Sample dilution: from the vial to the cartridge')
    ).toBeInTheDocument()
    expect(screen.getByText('3 · Results: EU per vial')).toBeInTheDocument()
    // Dennis's header names; the inputs keep their own labels.
    expect(
      screen.getByRole('columnheader', { name: /^Reconstitution water/ })
    ).toHaveTextContent('Reconstitution watermL')
    expect(
      screen.getByRole('columnheader', { name: /^Result as read/ })
    ).toHaveTextContent('Result as readEU/mL on the MCS, factor 1')
    expect(screen.getByLabelText('Water (mL)')).toBeInTheDocument()
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

  it("numbers bac water last on a 2 mL run, in Box 1 and Box 3, as Dennis's sheet does", async () => {
    vi.mocked(getWorksheet).mockResolvedValue(bacWaterFirst())
    renderPage()
    await screen.findByText('1 · Sample intake: reconstitute each vial')
    const tables = screen.getAllByRole('table')
    expect(numbered(tables[0])).toEqual([
      ['1', false],
      ['2', true],
    ])
    expect(numbered(tables.at(-1))).toEqual([
      ['1', false],
      ['2', true],
    ])
  })

  it('a stock run keeps bench order: bac water stays where it sorts', async () => {
    vi.mocked(getWorksheet).mockResolvedValue(
      bacWaterFirst({ endo_prep: 'stock' })
    )
    renderPage()
    await screen.findByText(/Sample volume/)
    expect(numbered(screen.getAllByRole('table')[0])).toEqual([
      ['1', true],
      ['2', false],
    ])
  })

  it("Box 1's sub-text and the calculations read the method's water and total on 2 mL", async () => {
    vi.mocked(getWorksheet).mockResolvedValue(
      worksheet('endo', {
        endo_method: {
          id: 9,
          name: 'Endotoxin',
          revision: 3,
          status: 'active',
          run_parameters: {
            endotoxin: { std_total_dilution: 300, recon_water_ml: 3 },
          },
          cartridges: [],
        },
      })
    )
    renderPage()
    expect(
      await screen.findByText(
        'What came in, when it is due, and the water that goes into each vial (3 mL standard). Tick Made and MCS as you go.'
      )
    ).toBeInTheDocument()
    expect(calculations()).toEqual([
      [
        'Due date',
        '= the SLA clock: received + the turnaround in business time, skipping lab holidays',
      ],
      ['Reconstitution water', '3 mL'],
      ['Step 1 · Tris', '20 + 180 µL · 1:10'],
      ['Step 2 · LAL water', '20 + 280 µL · 1:15'],
      ['Step 3 · BG600', '125 + 125 µL · 1:2'],
      ['Total · MCS', '1:300, factor 1 on the MCS'],
      ['Bacteriostatic water', '20× dilution: 50 µL'],
    ])
    expect(
      screen.getByText(
        'underlined on the printed sheet, dotted on screen, where a row has its own'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'the sheet multiplies the reading by the total and the 3 mL'
      )
    ).toBeInTheDocument()
  })

  it("a stock run keeps Box 1's sub-text and the stock calculations", async () => {
    vi.mocked(getWorksheet).mockResolvedValue(
      worksheet('endo', { endo_prep: 'stock' })
    )
    renderPage()
    expect(
      await screen.findByText(
        'What came in, when it is due, and the water that goes into each vial. Tick Made and MCS as you go.'
      )
    ).toBeInTheDocument()
    expect(calculations()).toEqual([
      [
        'Due date',
        '= the SLA clock: received + the turnaround in business time, skipping lab holidays',
      ],
      ['Volume to add', '= MIN(10, 1 + FLOOR(wt ÷ 50))'],
      ['Vial concentration', '= declared wt ÷ volume to add'],
      ['Sample needed', '= target ÷ vial conc. × 1000'],
      ['LAL needed', '= 1000 − sample needed'],
      ['Bacteriostatic water', '20× dilution: 50 µL made to 1000 µL with LAL'],
    ])
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
