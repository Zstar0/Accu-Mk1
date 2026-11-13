import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import {
  CalSheetError,
  createCalSheet,
  getCalSheet,
  getInstruments,
  getPeptides,
  listCalSheets,
  type CalSheetListItem,
  type PeptideRecord,
} from '@/lib/api'
import type { CalInputs } from '@/lib/hplc-calibration'
import { resetCalSaves } from '@/services/hplc-calibration-sheets'
import { useUIStore } from '@/store/ui-store'
import { HplcCalibrationSheetPage } from '../HplcCalibrationSheetPage'
import { fixtureCase, makeSheet } from './cal-test-helpers'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getCalSheet: vi.fn(),
  getPeptides: vi.fn(),
  getInstruments: vi.fn(),
  listCalSheets: vi.fn(),
  createCalSheet: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function row(over: Partial<CalSheetListItem>): CalSheetListItem {
  const { inputs: _i, effective_inputs: _e, ...item } = makeSheet({})
  return { ...item, ...over }
}

const SHEETS = [
  row({
    id: 3,
    curve_id: null,
    proposed_name: '1290C-20261113-RETA',
    updated_at: '2026-11-13T09:00:00',
  }),
  row({
    id: 2,
    curve_id: 70,
    curve_name: '1290A-20261101-BPC',
    curve_is_active: true,
    peptide_abbreviation: 'BPC',
    peptide_name: 'BPC-157',
    instrument_name: '1290A',
    updated_at: '2026-11-01T09:00:00',
  }),
  row({
    id: 1,
    curve_id: 60,
    curve_name: '1290C-20261020-RETA',
    curve_is_active: false,
    changed_since_filed: true,
    updated_at: '2026-10-20T09:00:00',
  }),
]

function renderList() {
  useUIStore.setState({ calibrationSheetPageId: null })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HplcCalibrationSheetPage />
    </QueryClientProvider>
  )
}

const rowOf = (name: string) =>
  screen.getByText(name).closest('li') as HTMLElement

describe('HplcCalSheetList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetCalSaves()
    vi.mocked(getPeptides).mockResolvedValue([
      { id: 11, name: 'Retatrutide', abbreviation: 'RETA' } as PeptideRecord,
      { id: 12, name: 'BPC-157', abbreviation: 'BPC' } as PeptideRecord,
    ])
    vi.mocked(getInstruments).mockResolvedValue([])
    vi.mocked(listCalSheets).mockResolvedValue(SHEETS)
  })

  it('the list marks drafts, filed sheets and sheets changed since filing', async () => {
    renderList()
    await screen.findByText('1290C-20261113-RETA')
    const draft = rowOf('1290C-20261113-RETA')
    const filed = rowOf('1290A-20261101-BPC')
    const changed = rowOf('1290C-20261020-RETA')
    expect(within(draft).getByText('Draft')).toBeInTheDocument()
    expect(within(filed).getByText('Filed')).toBeInTheDocument()
    expect(within(changed).getByText('Changed since filed')).toBeInTheDocument()
    // the star only on the active curve
    expect(within(filed).getByLabelText('Active curve')).toBeInTheDocument()
    expect(within(draft).queryByLabelText('Active curve')).toBeNull()
    expect(within(changed).queryByLabelText('Active curve')).toBeNull()
    // compound and instrument
    expect(within(filed).getByText('BPC-157')).toBeInTheDocument()
    expect(within(filed).getByText('1290A')).toBeInTheDocument()
    // newest first, as the server sends them
    const names = [
      ...document.querySelectorAll('li [data-testid="sheet-name"]'),
    ]
    expect(names.map(n => n.textContent)).toEqual([
      '1290C-20261113-RETA',
      '1290A-20261101-BPC',
      '1290C-20261020-RETA',
    ])
  })

  it('a row opens its sheet', async () => {
    vi.mocked(getCalSheet).mockResolvedValue(
      makeSheet(fixtureCase(1).inputs as CalInputs, { id: 2 })
    )
    renderList()
    await screen.findByText('1290A-20261101-BPC')
    fireEvent.click(
      within(rowOf('1290A-20261101-BPC')).getByRole('button', { name: /Open/ })
    )
    expect(useUIStore.getState().calibrationSheetPageId).toBe(2)
  })

  it('the peptide filter asks the server for that peptide only', async () => {
    renderList()
    await screen.findByText('1290C-20261113-RETA')
    const filter = screen.getByLabelText('Compound') as HTMLSelectElement
    await waitFor(() => expect(filter.options.length).toBe(3))
    fireEvent.change(filter, { target: { value: '12' } })
    await waitFor(() =>
      expect(listCalSheets).toHaveBeenLastCalledWith(12, {
        limit: 100,
        offset: 0,
      })
    )
  })

  it('M5 (a): a full page of 100 offers Show more, which appends the next page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      row({ id: 1000 - i, proposed_name: `SHEET-${i}` })
    )
    const page2 = [row({ id: 1, proposed_name: 'SHEET-LAST' })]
    vi.mocked(listCalSheets).mockImplementation(async (_p, pg) =>
      pg?.offset ? page2 : page1
    )
    renderList()
    await screen.findByText('SHEET-0')
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    await screen.findByText('SHEET-LAST')
    expect(listCalSheets).toHaveBeenLastCalledWith(undefined, {
      limit: 100,
      offset: 100,
    })
    expect(document.querySelectorAll('[data-testid="sheet-name"]').length).toBe(
      101
    )
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })

  it('M5 (a): a short page has no Show more', async () => {
    renderList()
    await screen.findByText('1290C-20261113-RETA')
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })

  it('M5 (b): loading says so, and no empty box shows', async () => {
    vi.mocked(listCalSheets).mockImplementation(
      () => new Promise(() => undefined)
    )
    renderList()
    expect(await screen.findByText('Loading...')).toBeInTheDocument()
    expect(document.querySelector('ul')).toBeNull()
    expect(screen.queryByText('No calibration worksheets yet.')).toBeNull()
  })

  it('M5 (b): a failed load says so with Try again', async () => {
    vi.mocked(listCalSheets).mockRejectedValueOnce(
      new CalSheetError('Load calibration sheets failed: 500', 500)
    )
    renderList()
    expect(
      await screen.findByText(
        'The worksheets could not be loaded: Load calibration sheets failed: 500.'
      )
    ).toBeInTheDocument()
    expect(document.querySelector('ul')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('1290C-20261113-RETA')).toBeInTheDocument()
  })

  it('M5 (c): a row that cannot be worked out says so beside its status', async () => {
    vi.mocked(listCalSheets).mockResolvedValue([
      row({
        id: 4,
        proposed_name: 'BROKEN',
        blocking: ['cannot_be_worked_out'],
      }),
      row({ id: 3, proposed_name: 'FINE', blocking: ['some_warning'] }),
    ])
    renderList()
    await screen.findByText('BROKEN')
    expect(
      within(rowOf('BROKEN')).getByText('Cannot be worked out')
    ).toBeInTheDocument()
    expect(within(rowOf('FINE')).queryByText('Cannot be worked out')).toBeNull()
  })

  it('New calibration worksheet makes one and opens it', async () => {
    vi.mocked(createCalSheet).mockResolvedValue(
      makeSheet(fixtureCase(21).inputs as CalInputs, { id: 14 })
    )
    vi.mocked(getCalSheet).mockResolvedValue(
      makeSheet(fixtureCase(21).inputs as CalInputs, { id: 14 })
    )
    renderList()
    await screen.findByText('1290C-20261113-RETA')
    fireEvent.click(
      screen.getByRole('button', { name: 'New calibration worksheet' })
    )
    await waitFor(() =>
      expect(useUIStore.getState().calibrationSheetPageId).toBe(14)
    )
    expect(createCalSheet).toHaveBeenCalledTimes(1)
  })

  it('an empty list says so', async () => {
    vi.mocked(listCalSheets).mockResolvedValue([])
    renderList()
    expect(
      await screen.findByText('No calibration worksheets yet.')
    ).toBeInTheDocument()
  })
})
