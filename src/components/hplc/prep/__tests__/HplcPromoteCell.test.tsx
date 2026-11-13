import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import type {
  HplcPromoteResult,
  HplcSheetRow,
  WorksheetListItem,
} from '@/lib/api'
import type * as WorksheetDrawerHook from '@/hooks/use-worksheet-drawer'
import {
  getHplcSheet,
  HplcPromoteRefused,
  patchHplcRow,
  promoteHplcRow,
} from '@/lib/api'
import { useWorksheetDrawer } from '@/hooks/use-worksheet-drawer'
import { useUIStore } from '@/store/ui-store'
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
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: 1, retryDelay: 0 },
          },
        })
      }
    >
      <HplcWorksheetPage worksheet={worksheet} />
    </QueryClientProvider>
  )
}

const S1 = 'P-0120-S01'
const S2 = 'P-0121-S01'
const VIAL = 'Wt Customer Sample vial and Septum (mg)'
const CONFIRM =
  'Promote this row? Its prep becomes final and can only be corrected by a retest.'

/** A powder row with every weighing in: nothing stops its promote. */
const ready = (over: Partial<HplcSheetRow> = {}) =>
  makeRow({
    hplc_prep: {
      stock_vial_mg: 5000,
      stock_vial_diluent_mg: 7991.3,
      vials: {
        '1': { vial_mg: 2500, vial_diluent_mg: 3906, vial_all_mg: 3996 },
      },
    },
    ...over,
  })

const PREP = { id: 41, sample_id: 'SP-20261113-0004', status: 'awaiting_hplc' }
const promoted = (over: Partial<HplcSheetRow> = {}) =>
  ready({ promoted: true, prep: PREP, ...over })

const step2 = () =>
  screen.getByRole('region', {
    name: 'Step 2 Peptide sample stock preparation',
  })
const promoteButton = () =>
  within(step2()).getByRole('button', { name: 'Promote' })

function typeAndLeave(el: HTMLElement, text: string) {
  fireEvent.focus(el)
  fireEvent.change(el, { target: { value: text } })
  fireEvent.blur(el)
}

describe('Promote on the HPLC worksheet page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }
    vi.mocked(useWorksheetDrawer).mockReturnValue({
      updateMutation: mutation,
      completeMutation: mutation,
      addItemMutation: mutation,
    } as unknown as ReturnType<typeof useWorksheetDrawer>)
  })

  it('a row that is not ready shows why on its disabled button', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([makeRow({ instrument_id: null, instrument_name: null })])
    )
    renderPage()
    await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    const button = promoteButton()
    expect(button).toBeDisabled()
    // a disabled button fires no hover: its wrapper carries the tooltip
    await userEvent.setup().hover(button.parentElement as HTMLElement)
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent(
      "pick the instrument first: a curve is checked against the run's instrument, and a prep without one cannot be checked"
    )
    expect(tip).toHaveTextContent(
      'weigh the stock vial: Step 2 needs both of its weighings'
    )
  })

  it('promoting asks once and then shows the prep number as a link', async () => {
    vi.mocked(getHplcSheet)
      .mockResolvedValueOnce(makeSheet([ready()]))
      .mockResolvedValueOnce(makeSheet([ready()]))
      .mockResolvedValue(makeSheet([promoted()]))
    vi.mocked(promoteHplcRow).mockResolvedValue({
      prep: PREP,
      already: false,
      row: null,
    } as HplcPromoteResult)
    renderPage()
    await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    fireEvent.click(promoteButton())
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(CONFIRM)
    // the press read the sheet again before it asked
    expect(getHplcSheet).toHaveBeenCalledTimes(2)
    expect(promoteHplcRow).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote' }))
    await waitFor(() => expect(promoteHplcRow).toHaveBeenCalledWith(7, 311))
    expect(promoteHplcRow).toHaveBeenCalledTimes(1)
    // read again afterwards, whatever the answer: the row is now final
    const link = await screen.findByRole('button', { name: PREP.sample_id })
    expect(within(step2()).getByText('final')).toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: `${S1}, ${VIAL}` })
    ).toBeDisabled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(link)
    expect(useUIStore.getState().activeSection).toBe('hplc-analysis')
    expect(useUIStore.getState().activeSubSection).toBe('sample-preps')
  })

  it('a 409 from the server shows its reasons and leaves the row editable', async () => {
    const density =
      'The sheet worked this row out with a diluent density of 997.1 mg/mL (from the method).'
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([ready()]))
    vi.mocked(promoteHplcRow).mockRejectedValue(
      new HplcPromoteRefused('This row cannot be promoted yet.', [density])
    )
    renderPage()
    await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    fireEvent.click(promoteButton())
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote' }))
    expect(await within(step2()).findByText(density)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: `${S1}, ${VIAL}` })
    ).toBeEnabled()
    // the sheet is read after the refusal too
    await waitFor(() => expect(getHplcSheet).toHaveBeenCalledTimes(3))
  })

  it('a promoted row shows its prep and has no button', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([promoted(), makeRow({ item_id: 312, sample_id: S2 })])
    )
    renderPage()
    expect(
      await screen.findByRole('button', { name: PREP.sample_id })
    ).toBeInTheDocument()
    expect(
      within(step2()).getAllByRole('button', { name: 'Promote' })
    ).toHaveLength(1)
    expect(screen.getByText('1 of 2 promoted')).toBeInTheDocument()
  })

  it('the header counts only rows that can have a prep', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([
        promoted(),
        makeRow({ item_id: 312, sample_id: S2 }),
        makeRow({ item_id: 313, sample_id: 'P-0122-S01', rider_only: true }),
      ])
    )
    renderPage()
    expect(await screen.findByText('1 of 2 promoted')).toBeInTheDocument()
  })

  it('the button is off while a save is pending, and says so', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([ready()]))
    let answer: (row: HplcSheetRow) => void = () => undefined
    vi.mocked(patchHplcRow).mockImplementation(
      () =>
        new Promise(resolve => {
          answer = resolve
        })
    )
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    expect(promoteButton()).toBeEnabled()
    typeAndLeave(box, '5001')
    const saving = await within(step2()).findByRole('button', {
      name: 'Saving...',
    })
    expect(saving).toBeDisabled()
    await act(async () =>
      answer(
        ready({ hplc_prep: { ...ready().hplc_prep, stock_vial_mg: 5001 } })
      )
    )
    expect(
      await within(step2()).findByRole('button', { name: 'Promote' })
    ).toBeEnabled()
  })

  it('a row the read-again shows as not ready gets its reasons and no dialog', async () => {
    vi.mocked(getHplcSheet)
      .mockResolvedValueOnce(makeSheet([ready()]))
      .mockResolvedValue(
        makeSheet([ready({ instrument_id: null, instrument_name: null })])
      )
    renderPage()
    await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    fireEvent.click(promoteButton())
    expect(
      await within(step2()).findByText(
        "pick the instrument first: a curve is checked against the run's instrument, and a prep without one cannot be checked"
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(promoteHplcRow).not.toHaveBeenCalled()
  })

  it('the promote request is not sent until a queued save has answered', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([ready()]))
    let answer: (row: HplcSheetRow) => void = () => undefined
    vi.mocked(patchHplcRow).mockImplementation(
      () =>
        new Promise(resolve => {
          answer = resolve
        })
    )
    vi.mocked(promoteHplcRow).mockResolvedValue({
      prep: PREP,
      already: false,
      row: null,
    } as HplcPromoteResult)
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    fireEvent.click(promoteButton())
    const dialog = await screen.findByRole('dialog')
    // a save leaves while the dialog is up (the box was found before it opened)
    typeAndLeave(box, '5001')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote' }))
    await act(() => new Promise(r => setTimeout(r, 30)))
    expect(promoteHplcRow).not.toHaveBeenCalled()
    await act(async () => answer(ready()))
    await waitFor(() => expect(promoteHplcRow).toHaveBeenCalledTimes(1))
  })
})
