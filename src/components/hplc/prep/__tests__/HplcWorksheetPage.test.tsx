import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import type { WorksheetListItem } from '@/lib/api'
import type * as WorksheetDrawerHook from '@/hooks/use-worksheet-drawer'
import { getHplcSheet, patchHplcRow } from '@/lib/api'
import { useWorksheetDrawer } from '@/hooks/use-worksheet-drawer'
import { HplcWorksheetPage } from '../HplcWorksheetPage'
import { makeRow, makeSheet } from './hplc-sheet-fixtures'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getHplcSheet: vi.fn(),
  patchHplcRow: vi.fn(),
  promoteHplcRow: vi.fn(),
  getHplcPrepRules: vi.fn().mockResolvedValue([]),
  getInstruments: vi.fn().mockResolvedValue([]),
  getWorksheetUsers: vi.fn().mockResolvedValue([]),
  updateWorksheetItem: vi.fn(),
}))
vi.mock('@/hooks/use-worksheet-drawer', async importOriginal => ({
  ...(await importOriginal<typeof WorksheetDrawerHook>()),
  useWorksheetDrawer: vi.fn(),
}))
vi.mock('@/components/hplc/AddSamplesModal', () => ({ default: () => null }))

const worksheet = {
  id: 7,
  title: 'HPLC run 7',
  status: 'open',
  notes: null,
  assigned_analyst: null,
  assigned_analyst_email: null,
  item_count: 1,
  created_at: null,
  completed_at: null,
  items: [],
} as unknown as WorksheetListItem

function renderPage() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HplcWorksheetPage worksheet={worksheet} />
    </QueryClientProvider>
  )
}

describe('HplcWorksheetPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
    vi.mocked(useWorksheetDrawer).mockReturnValue({
      updateMutation: mutation,
      completeMutation: mutation,
      addItemMutation: mutation,
    } as unknown as ReturnType<typeof useWorksheetDrawer>)
  })

  it('a failed save rolls the cell back and shows the reason', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([makeRow({ hplc_prep: { stock_vial_mg: 5012.31 } })])
    )
    let refuse: (e: Error) => void = () => undefined
    vi.mocked(patchHplcRow).mockReturnValue(
      new Promise((_resolve, reject) => {
        refuse = reject
      })
    )
    renderPage()
    const box = await screen.findByLabelText(
      'Wt Customer Sample vial and Septum'
    )
    expect(box).toHaveValue('5012.31')
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '6000' } })
    fireEvent.blur(box)
    await waitFor(() =>
      expect(patchHplcRow).toHaveBeenCalledWith(7, 311, {
        hplc_prep: { stock_vial_mg: 6000 },
      })
    )
    // optimistic: the sheet works from the new weighing at once
    expect(await screen.findByDisplayValue('6000')).toBe(box)
    await act(async () => {
      refuse(new Error('the row is promoted; its prep is final'))
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not saved: the row is promoted; its prep is final'
    )
    expect(box).toHaveValue('5012.31')
  })

  it('a saved cell shows what the server stored', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    vi.mocked(patchHplcRow).mockResolvedValue(
      makeRow({ hplc_prep: { vials: { '1': { vial_mg: 2500.1 } } } })
    )
    renderPage()
    const step3 = await screen.findByRole('region', {
      name: 'Step 3 Peptide dilution into the autosampler vial',
    })
    const box = within(step3).getByLabelText('Wt Autosampler vial and cap')
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '2500.1' } })
    fireEvent.blur(box)
    expect(await screen.findByDisplayValue('2500.1')).toBe(box)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a completed sheet is read-only on the page', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([makeRow()], 'completed')
    )
    renderPage()
    const box = await screen.findByLabelText(
      'Wt Customer Sample vial and Septum'
    )
    expect(box).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Add samples' })
    ).not.toBeInTheDocument()
  })
})
