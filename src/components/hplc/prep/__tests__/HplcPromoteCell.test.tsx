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
  getHplcPrepRules,
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
    // never retried: a refused promote is sent once
    await act(() => new Promise(r => setTimeout(r, 30)))
    expect(promoteHplcRow).toHaveBeenCalledTimes(1)
    // announced, and kept through the next press into its confirm
    expect(within(step2()).getByRole('alert')).toHaveTextContent(density)
    fireEvent.click(promoteButton())
    const again = await screen.findByRole('dialog')
    expect(again).toHaveTextContent('Last time the server said:')
    expect(within(again).getByText(density)).toBeInTheDocument()
    // the list under the button is still there behind the dialog
    expect(screen.getAllByText(density)).toHaveLength(2)
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

  it('a promote that never answers gives up after 15 seconds without saying the row was not promoted, and the queue moves on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([ready()]))
      vi.mocked(promoteHplcRow).mockImplementation(
        () => new Promise(() => undefined)
      )
      vi.mocked(patchHplcRow).mockResolvedValue(ready())
      renderPage()
      const box = await screen.findByRole('textbox', {
        name: `${S1}, ${VIAL}`,
      })
      fireEvent.click(promoteButton())
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Promote' }))
      await waitFor(() => expect(promoteHplcRow).toHaveBeenCalledTimes(1))
      // a save typed meanwhile waits behind the promote
      typeAndLeave(box, '5001')
      await act(() => vi.advanceTimersByTimeAsync(14_000))
      expect(patchHplcRow).not.toHaveBeenCalled()
      const reads = vi.mocked(getHplcSheet).mock.calls.length
      await act(() => vi.advanceTimersByTimeAsync(1_500))
      expect(
        await within(step2()).findByText(
          'The promote did not answer. If the row now shows its prep it was promoted; otherwise press Promote again.'
        )
      ).toBeInTheDocument()
      await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
      // read again once the queued save has answered
      await waitFor(() =>
        expect(vi.mocked(getHplcSheet).mock.calls.length).toBeGreaterThan(reads)
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('a save started while the press reads the sheet again stops the press quietly', async () => {
    let reread: (s: ReturnType<typeof makeSheet>) => void = () => undefined
    vi.mocked(getHplcSheet)
      .mockResolvedValueOnce(makeSheet([ready()]))
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            reread = resolve
          })
      )
      .mockResolvedValue(makeSheet([ready()]))
    vi.mocked(patchHplcRow).mockImplementation(
      () => new Promise(() => undefined)
    )
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    fireEvent.click(promoteButton())
    await waitFor(() => expect(getHplcSheet).toHaveBeenCalledTimes(2))
    typeAndLeave(box, '5001')
    await act(async () => reread(makeSheet([ready()])))
    await act(() => new Promise(r => setTimeout(r, 30)))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      within(step2()).getByRole('button', { name: 'Saving...' })
    ).toBeDisabled()
    expect(promoteHplcRow).not.toHaveBeenCalled()
  })

  it('a press reads the prep rules again and works the row out with the new ones', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([ready()]))
    vi.mocked(getHplcPrepRules)
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          id: 4,
          peptide_id: 10,
          min_mg: null,
          max_mg: null,
          target_conc_ug_ml: 300,
          blend_target_conc_ug_ml: null,
          lead_component_id: null,
          lead_priority: null,
          floor_ug_ml: null,
          diluent: null,
          default_instrument_id: null,
          status: 'validated',
          note: null,
          sort_order: 1,
          active: true,
          peptide_name: 'BPC-157',
          peptide_is_blend: false,
          lead_component_name: null,
          default_instrument_name: null,
          updated_at: null,
        },
      ])
    renderPage()
    await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    expect(
      screen.getByRole('textbox', { name: `${S1}, Target Conc (ug/mL)` })
    ).toHaveAttribute('placeholder', '200')
    fireEvent.click(promoteButton())
    const dialog = await screen.findByRole('dialog')
    expect(getHplcPrepRules).toHaveBeenCalledTimes(2)
    expect(dialog).toHaveTextContent('Target Conc 300 ug/mL')
  })

  it('the confirm starts on Cancel: Enter and Escape close it and promote nothing', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([ready()]))
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    fireEvent.click(promoteButton())
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    fireEvent.click(promoteButton())
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(promoteHplcRow).not.toHaveBeenCalled()
  })

  it('a disabled Promote names its reasons for a screen reader', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([ready({ instrument_id: null, instrument_name: null })])
    )
    renderPage()
    await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    const wrapper = promoteButton().parentElement as HTMLElement
    const id = wrapper.getAttribute('aria-describedby')
    expect(id).toBeTruthy()
    expect(document.getElementById(id as string)).toHaveTextContent(
      'pick the instrument first'
    )
  })

  it('A1: a row with a save that did not land refuses Promote before reading again; row B still promotes; dismissing frees row A', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([ready(), ready({ item_id: 312, sample_id: S2 })])
    )
    vi.mocked(patchHplcRow).mockRejectedValue(
      new Error('weighing out of range')
    )
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '5001')
    const alert = await screen.findByRole('alert')
    // the read-again after the failed save
    await waitFor(() => expect(getHplcSheet).toHaveBeenCalledTimes(2))
    await act(() => new Promise(r => setTimeout(r, 30)))
    const reads = vi.mocked(getHplcSheet).mock.calls.length
    const buttons = () =>
      within(step2()).getAllByRole('button', { name: 'Promote' })
    fireEvent.click(buttons()[0] as HTMLElement)
    expect(
      await within(step2()).findByText(
        `A change to this row was not saved: ${S1}, ${VIAL}: weighing out of range. Type it again or dismiss it, then promote.`
      )
    ).toBeInTheDocument()
    await act(() => new Promise(r => setTimeout(r, 30)))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(getHplcSheet).toHaveBeenCalledTimes(reads)
    // a failure on row A does not stop row B
    fireEvent.click(buttons()[1] as HTMLElement)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(`Promote ${S2}`)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    // dismissed: row A goes ahead
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    fireEvent.click(buttons()[0] as HTMLElement)
    expect(await screen.findByRole('dialog')).toHaveTextContent(`Promote ${S1}`)
    expect(promoteHplcRow).not.toHaveBeenCalled()
  })

  it('A1: a word left in a weighed box blocks Promote until it is put right', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([ready()]))
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    // a letter O for a zero, then a mouse click on Promote
    typeAndLeave(box, '5O12')
    fireEvent.click(promoteButton())
    expect(
      await within(step2()).findByText(
        `A change to this row was not saved: ${S1}, ${VIAL}: Type a number. Type it again or dismiss it, then promote.`
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(getHplcSheet).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.click(promoteButton())
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('A1: a save that fails while the promote waits behind it stops the promote', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([ready()]))
    let refuse: (e: Error) => void = () => undefined
    vi.mocked(patchHplcRow).mockImplementation(
      () =>
        new Promise((_, reject) => {
          refuse = reject
        })
    )
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    fireEvent.click(promoteButton())
    const dialog = await screen.findByRole('dialog')
    typeAndLeave(box, '5001')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote' }))
    await act(async () => refuse(new Error('weighing out of range')))
    expect(
      await within(step2()).findByText(
        `A change to this row was not saved: ${S1}, ${VIAL}: weighing out of range. Type it again or dismiss it, then promote.`
      )
    ).toBeInTheDocument()
    await act(() => new Promise(r => setTimeout(r, 30)))
    expect(promoteHplcRow).not.toHaveBeenCalled()
  })

  it('A3: from the last typed box of a row ArrowRight reaches Promote, and Enter opens the flow', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([ready()]))
    const user = userEvent.setup()
    renderPage()
    const last = await screen.findByRole('combobox', {
      name: `${S1}, 2-step dilution`,
    })
    act(() => last.focus())
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(promoteButton())
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog')).toHaveTextContent(CONFIRM)
  })

  it('A2: a rules read-again that fails keeps the sheet and says it may be out of date', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([ready()]))
    vi.mocked(getHplcPrepRules)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('network down'))
    renderPage()
    await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    // a press reads the rules again; that read fails
    fireEvent.click(promoteButton())
    expect(
      await screen.findByText(
        'Could not refresh the sheet; what you see may be out of date'
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: `${S1}, ${VIAL}` })
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('A5: a press stopped by a save says so under the button', async () => {
    let reread: (s: ReturnType<typeof makeSheet>) => void = () => undefined
    vi.mocked(getHplcSheet)
      .mockResolvedValueOnce(makeSheet([ready()]))
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            reread = resolve
          })
      )
      .mockResolvedValue(makeSheet([ready()]))
    vi.mocked(patchHplcRow).mockImplementation(
      () => new Promise(() => undefined)
    )
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    fireEvent.click(promoteButton())
    await waitFor(() => expect(getHplcSheet).toHaveBeenCalledTimes(2))
    typeAndLeave(box, '5001')
    await act(async () => reread(makeSheet([ready()])))
    expect(
      await within(step2()).findByText(
        'Still saving. Press Promote again when it has finished.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('A9: a save that starts and finishes during the read-again stops the press', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([ready()]))
    let rulesAgain: (r: []) => void = () => undefined
    vi.mocked(getHplcPrepRules)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            rulesAgain = resolve
          })
      )
    vi.mocked(patchHplcRow).mockResolvedValue(ready())
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    fireEvent.click(promoteButton())
    await waitFor(() => expect(getHplcPrepRules).toHaveBeenCalledTimes(2))
    // the sheet read is done; the rules read is still out: a save goes
    // and lands meanwhile
    typeAndLeave(box, '5001')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    await act(() => new Promise(r => setTimeout(r, 30)))
    await act(async () => rulesAgain([]))
    expect(
      await within(step2()).findByText(
        'Still saving. Press Promote again when it has finished.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it("A10: a press that finds the row ready clears the last press's own reasons", async () => {
    vi.mocked(getHplcSheet)
      .mockResolvedValueOnce(makeSheet([ready()]))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(makeSheet([ready()]))
    renderPage()
    await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    fireEvent.click(promoteButton())
    expect(
      await within(step2()).findByText(
        'could not read the sheet again: network down'
      )
    ).toBeInTheDocument()
    fireEvent.click(promoteButton())
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(
      within(step2()).queryByText(
        'could not read the sheet again: network down'
      )
    ).toBeNull()
  })

  it('A11: the reasons under the button are announced and stay a list', async () => {
    vi.mocked(getHplcSheet)
      .mockResolvedValueOnce(makeSheet([ready()]))
      .mockResolvedValue(
        makeSheet([ready({ instrument_id: null, instrument_name: null })])
      )
    renderPage()
    await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    fireEvent.click(promoteButton())
    const alert = await within(step2()).findByRole('alert')
    expect(alert.tagName).toBe('DIV')
    expect(within(alert).getByRole('list')).toBeInTheDocument()
    expect(within(alert).getAllByRole('listitem').length).toBeGreaterThan(0)
  })

  it('A12: a promote that answers after the 15 second cut reads the sheet again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([ready()]))
      let answer: (r: HplcPromoteResult) => void = () => undefined
      vi.mocked(promoteHplcRow).mockImplementation(
        () =>
          new Promise(resolve => {
            answer = resolve
          })
      )
      renderPage()
      await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
      fireEvent.click(promoteButton())
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Promote' }))
      await waitFor(() => expect(promoteHplcRow).toHaveBeenCalledTimes(1))
      await act(() => vi.advanceTimersByTimeAsync(15_500))
      await within(step2()).findByText(/The promote did not answer/)
      await act(() => vi.advanceTimersByTimeAsync(100))
      const reads = vi.mocked(getHplcSheet).mock.calls.length
      await act(async () => answer({ prep: PREP, already: false, row: null }))
      await waitFor(() =>
        expect(vi.mocked(getHplcSheet).mock.calls.length).toBeGreaterThan(reads)
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('A13: while one row is being pressed, the other rows cannot be', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([ready(), ready({ item_id: 312, sample_id: S2 })])
    )
    renderPage()
    await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    // the open confirm hides the page from the accessibility tree
    const buttons = () =>
      within(
        screen.getByRole('region', {
          name: 'Step 2 Peptide sample stock preparation',
          hidden: true,
        })
      ).getAllByRole('button', { name: 'Promote', hidden: true })
    fireEvent.click(buttons()[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog')
    expect(buttons()[1]).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    await waitFor(() => expect(buttons()[1]).toBeEnabled())
  })

  it('A7: Cancel and Escape put focus back on Promote; a finished promote puts it on the prep link', async () => {
    vi.mocked(getHplcSheet)
      .mockResolvedValueOnce(makeSheet([ready()]))
      .mockResolvedValueOnce(makeSheet([ready()]))
      .mockResolvedValueOnce(makeSheet([ready()]))
      .mockResolvedValueOnce(makeSheet([ready()]))
      .mockResolvedValue(makeSheet([promoted()]))
    vi.mocked(promoteHplcRow).mockResolvedValue({
      prep: PREP,
      already: false,
      row: null,
    } as HplcPromoteResult)
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    fireEvent.click(promoteButton())
    let dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(promoteButton()).toHaveFocus())
    fireEvent.click(promoteButton())
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(promoteButton()).toHaveFocus())
    fireEvent.click(promoteButton())
    dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Promote' }))
    const link = await screen.findByRole('button', { name: PREP.sample_id })
    await waitFor(() => expect(link).toHaveFocus())
  })

  it('the read-again after a promote waits for the saves queued behind it', async () => {
    let answerPromote: (r: HplcPromoteResult) => void = () => undefined
    let answerSave: (row: HplcSheetRow) => void = () => undefined
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([ready()]))
    vi.mocked(promoteHplcRow).mockImplementation(
      () =>
        new Promise(resolve => {
          answerPromote = resolve
        })
    )
    vi.mocked(patchHplcRow).mockImplementation(
      () =>
        new Promise(resolve => {
          answerSave = resolve
        })
    )
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    fireEvent.click(promoteButton())
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Promote' }))
    await waitFor(() => expect(promoteHplcRow).toHaveBeenCalledTimes(1))
    typeAndLeave(box, '5001')
    const reads = vi.mocked(getHplcSheet).mock.calls.length
    await act(async () =>
      answerPromote({ prep: PREP, already: false, row: null })
    )
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    // the typed value is not overwritten by a read taken before it saved
    expect(getHplcSheet).toHaveBeenCalledTimes(reads)
    expect(box).toHaveValue('5001')
    await act(async () => answerSave(ready()))
    await waitFor(() => expect(getHplcSheet).toHaveBeenCalledTimes(reads + 1))
  })
})
