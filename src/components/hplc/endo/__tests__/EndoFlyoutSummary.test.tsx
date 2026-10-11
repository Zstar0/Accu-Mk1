import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EndoFlyoutSummary } from '@/components/hplc/endo/EndoFlyoutSummary'
import { getWorksheet, type WorksheetListItem } from '@/lib/api'
import type * as ApiModule from '@/lib/api'
import type { EndoReaderRecord } from '@/lib/endo-prep-2ml'
import type * as SlaSubjects from '@/services/sla-subjects'
import { useUIStore } from '@/store/ui-store'
import { endoItem, endoWorksheet } from './endo-fixtures'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getWorksheet: vi.fn(),
  listConsumables: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/hooks/use-lab-calendar', () => ({
  useLabCalendar: () => ({ calendar: null, isLoading: false }),
}))
// Keep the module's other exports: worksheetItemSlaSubjects calls
// slaSubjectIdentities from it.
vi.mock('@/services/sla-subjects', async importOriginal => ({
  ...(await importOriginal<typeof SlaSubjects>()),
  useSlaForSubjects: () => ({
    byKey: new Map(),
    isLoading: false,
    isError: false,
  }),
}))
vi.mock('@/components/hplc/EndoWorksheetActions', () => ({
  EndoWorksheetActions: () => <button type="button">Print</button>,
}))

const invalid: EndoReaderRecord = {
  test_id: 'T-9',
  result: '<0.05',
  reader: 'MCS-1234',
  slot: 2,
  operator: 'QA',
  tested_at: '2026-10-09 14:02',
  temp_start: 37,
  temp_end: 37.1,
  software: '1.0',
  cartridge_lot: 'L1',
  cartridge_expiry: '2027-01-31',
  cartridge_range: '5 - 0.05',
  spike_level: 0.8,
  recovery: 44,
  rec_min: 50,
  rec_max: 200,
  sample_cv: 3.1,
  spike_cv: 3.7,
  cv_limit: 25,
  reader_pass: false,
  valid: false,
  why: ['spike recovery 44 % outside 50-200 %'],
  file_name: 'EndoScanV-Export-2026-10-09.csv',
}

const stamp = '2026-10-09T18:00:00Z'

function fullWorksheet(over: Partial<WorksheetListItem> = {}) {
  return endoWorksheet(
    [
      endoItem({
        sample_id: 'P-0001-S02',
        made_at: stamp,
        ran_at: stamp,
        result_reading: '<0.05',
      }),
      endoItem({
        sample_id: 'P-0002-S02',
        made_at: stamp,
        result_reading: '0.8',
      }),
      endoItem({
        sample_id: 'P-0003-S02',
        result_reading: '<0.05',
        result_reader: invalid,
      }),
      endoItem({ sample_id: 'P-0004-S02' }),
    ],
    over
  )
}

function setup(
  full: WorksheetListItem,
  fetch: 'lands' | 'pending' | 'fails' = 'lands'
) {
  if (fetch === 'lands') vi.mocked(getWorksheet).mockResolvedValue(full)
  if (fetch === 'pending')
    // never settles: the read is still in flight
    vi.mocked(getWorksheet).mockReturnValue(new Promise(() => undefined))
  if (fetch === 'fails')
    vi.mocked(getWorksheet).mockRejectedValue(new Error('Server error'))
  // the flyout is handed the list payload, which has no endo_method key
  const listed = { ...full, endo_method: undefined }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  render(<EndoFlyoutSummary worksheet={listed} users={[]} />, { wrapper: wrap })
}

function countOf(label: string): string | null | undefined {
  const counts = screen.getByLabelText('Run counts')
  return within(counts).getByText(label).nextElementSibling?.textContent
}

describe('EndoFlyoutSummary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('counts rows, ticks and, once the run settings load, results, Invalid and ready for Mk1', async () => {
    setup(fullWorksheet())
    expect(countOf('Rows')).toBe('4')
    expect(countOf('Made')).toBe('2/4')
    expect(countOf('MCS')).toBe('1/4')
    expect(countOf('Results in')).toBe('3/4')
    await waitFor(() => expect(countOf('Ready for Mk1')).toBe('2/4'))
    expect(countOf('Invalid')).toBe('1')
    expect(getWorksheet).toHaveBeenCalledWith(77)
    expect(screen.getByText('Fail')).toBeInTheDocument()
  })

  it('shows … for Invalid and Ready for Mk1 until the run settings land', () => {
    setup(fullWorksheet(), 'pending')
    expect(countOf('Results in')).toBe('3/4')
    expect(countOf('Invalid')).toBe('…')
    expect(countOf('Ready for Mk1')).toBe('…')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says so when the run settings cannot be read, with a retry', async () => {
    setup(fullWorksheet(), 'fails')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the run settings'
    )
    expect(countOf('Invalid')).toBe('-')
    expect(countOf('Ready for Mk1')).toBe('-')
    vi.mocked(getWorksheet).mockResolvedValue(fullWorksheet())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(countOf('Ready for Mk1')).toBe('2/4'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('opens the worksheet page and closes the flyout', () => {
    setup(fullWorksheet())
    useUIStore.setState({ worksheetDrawerOpen: true })
    fireEvent.click(screen.getByRole('button', { name: 'Open worksheet' }))
    const ui = useUIStore.getState()
    expect(ui.worksheetPageId).toBe(77)
    expect(ui.activeSubSection).toBe('worksheet')
    expect(ui.worksheetDrawerOpen).toBe(false)
  })

  it('shows no results counts on a stock worksheet', () => {
    setup(fullWorksheet({ endo_prep: 'stock' }))
    expect(screen.getByText('1 mg/mL stock')).toBeInTheDocument()
    expect(
      within(screen.getByLabelText('Run counts')).queryByText('Results in')
    ).not.toBeInTheDocument()
  })
})
