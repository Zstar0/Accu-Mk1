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
import type { HplcSheetRow, WorksheetListItem } from '@/lib/api'
import type * as WorksheetDrawerHook from '@/hooks/use-worksheet-drawer'
import { getHplcSheet, patchHplcRow, updateWorksheetItem } from '@/lib/api'
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
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            // the app's default (src/lib/query-client.ts), without the wait
            mutations: { retry: 1, retryDelay: 0 },
          },
        })
      }
    >
      <HplcWorksheetPage worksheet={worksheet} />
    </QueryClientProvider>
  )
}

/** Every sheet save carries the 15 second abort signal. */
const SIGNAL = { signal: expect.any(AbortSignal) }

const S1 = 'P-0120-S01'
const VIAL = 'Wt Customer Sample vial and Septum (mg)'
const VIAL_DIL = 'Wt Customer Sample vial and Septum + Diluent (mg)'

function typeAndLeave(el: HTMLElement, text: string) {
  fireEvent.focus(el)
  fireEvent.change(el, { target: { value: text } })
  fireEvent.blur(el)
}

/** Each PATCH waits until the test answers it, by call number. */
function queueSaves() {
  const pending: {
    resolve: (row: HplcSheetRow) => void
    reject: (e: Error) => void
  }[] = []
  vi.mocked(patchHplcRow).mockImplementation(
    () =>
      new Promise<HplcSheetRow>((resolve, reject) => {
        pending.push({ resolve, reject })
      })
  )
  return {
    ok: (n: number, row: HplcSheetRow | undefined) => {
      if (!row) throw new Error('no row')
      pending[n]?.resolve(row)
    },
    fail: (n: number, reason: string) => pending[n]?.reject(new Error(reason)),
  }
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
    const saves = queueSaves()
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    expect(box).toHaveValue('5012.31')
    typeAndLeave(box, '6000')
    await waitFor(() =>
      expect(patchHplcRow).toHaveBeenCalledWith(
        7,
        311,
        {
          hplc_prep: { stock_vial_mg: 6000 },
        },
        SIGNAL
      )
    )
    // optimistic: the sheet works from the new weighing at once
    expect(await screen.findByDisplayValue('6000')).toBe(box)
    await act(async () =>
      saves.fail(0, 'the row is promoted; its prep is final')
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Not saved: ${S1}, ${VIAL}: the row is promoted; its prep is final`
    )
    expect(box).toHaveValue('5012.31')
  })

  it('a saved cell shows what the server stored', async () => {
    const saved = makeRow({
      hplc_prep: { vials: { '1': { vial_mg: 2500.1 } } },
    })
    // the sheet is read again once the last save settles
    vi.mocked(getHplcSheet)
      .mockResolvedValueOnce(makeSheet([makeRow()]))
      .mockResolvedValue(makeSheet([saved]))
    vi.mocked(patchHplcRow).mockResolvedValue(saved)
    renderPage()
    const box = await screen.findByRole('textbox', {
      name: `${S1}, Wt Autosampler vial and cap (mg)`,
    })
    typeAndLeave(box, '2500.1')
    expect(await screen.findByDisplayValue('2500.1')).toBe(box)
    await waitFor(() => expect(getHplcSheet).toHaveBeenCalledTimes(2))
    expect(box).toHaveValue('2500.1')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('two saves to one key reach the server in call order, the second after the first answered', async () => {
    const at = (mg: number) =>
      makeSheet([makeRow({ hplc_prep: { stock_vial_mg: mg } })])
    let readAgain: (s: ReturnType<typeof at>) => void = () => undefined
    vi.mocked(getHplcSheet)
      .mockResolvedValueOnce(at(5012.31))
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            readAgain = resolve
          })
      )
    const saves = queueSaves()
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '6000')
    typeAndLeave(box, '7000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    expect(patchHplcRow).toHaveBeenLastCalledWith(
      7,
      311,
      {
        hplc_prep: { stock_vial_mg: 6000 },
      },
      SIGNAL
    )
    expect(box).toHaveValue('7000')
    // the older answer never replaces the newer typing
    await act(async () => saves.ok(0, at(6000).rows[0]))
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(2))
    expect(patchHplcRow).toHaveBeenLastCalledWith(
      7,
      311,
      {
        hplc_prep: { stock_vial_mg: 7000 },
      },
      SIGNAL
    )
    expect(box).toHaveValue('7000')
    await act(async () => saves.ok(1, at(7000).rows[0]))
    await waitFor(() => expect(getHplcSheet).toHaveBeenCalledTimes(2))
    // the read-again is still open: the box shows what the last save stored
    expect(box).toHaveValue('7000')
    await act(async () => readAgain(at(7000)))
    expect(box).toHaveValue('7000')
  })

  it('a failed save is not retried', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    const saves = queueSaves()
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '6000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    await act(async () => saves.fail(0, 'timed out'))
    expect(await screen.findByRole('alert')).toHaveTextContent('timed out')
    await act(() => new Promise(r => setTimeout(r, 50)))
    expect(patchHplcRow).toHaveBeenCalledTimes(1)
  })

  it('a save that fails while a later one to the same key waits leaves the later value', async () => {
    const at = (mg: number) =>
      makeSheet([makeRow({ hplc_prep: { stock_vial_mg: mg } })])
    vi.mocked(getHplcSheet)
      .mockResolvedValueOnce(at(5012.31))
      .mockResolvedValue(at(7000))
    const saves = queueSaves()
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '6000')
    typeAndLeave(box, '7000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    await act(async () => saves.fail(0, 'timed out'))
    expect(box).toHaveValue('7000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(2))
    await act(async () => saves.ok(1, at(7000).rows[0]))
    await waitFor(() => expect(getHplcSheet).toHaveBeenCalledTimes(2))
    expect(box).toHaveValue('7000')
  })

  it('two saves where the first fails show an alert naming that sample and column', async () => {
    const before = makeRow({ hplc_prep: { stock_vial_mg: 5012.31 } })
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([before]))
    const saves = queueSaves()
    renderPage()
    const first = await screen.findByRole('textbox', {
      name: `${S1}, ${VIAL}`,
    })
    const second = screen.getByRole('textbox', { name: `${S1}, ${VIAL_DIL}` })
    typeAndLeave(first, '6000')
    typeAndLeave(second, '8003.6')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    await act(async () => saves.fail(0, 'weighing out of range'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      `Not saved: ${S1}, ${VIAL}: weighing out of range`
    )
    expect(first).toHaveValue('5012.31')
    expect(second).toHaveValue('8003.6')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(2))
    await act(async () =>
      saves.ok(
        1,
        makeRow({
          hplc_prep: { stock_vial_mg: 5012.31, stock_vial_diluent_mg: 8003.6 },
        })
      )
    )
    // a later save that lands keeps the failure up; it is dismissible
    expect(screen.getByRole('alert')).toBe(alert)
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a failed read-again keeps the sheet and a box being typed in, and says so', async () => {
    vi.mocked(getHplcSheet)
      .mockResolvedValueOnce(makeSheet([makeRow()]))
      .mockRejectedValue(new Error('network down'))
    const saves = queueSaves()
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '6000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    // the tech is typing in the next box, not yet left
    const next = screen.getByRole('textbox', { name: `${S1}, ${VIAL_DIL}` })
    fireEvent.focus(next)
    fireEvent.change(next, { target: { value: '80' } })
    await act(async () =>
      saves.ok(0, makeRow({ hplc_prep: { stock_vial_mg: 6000 } }))
    )
    await waitFor(() => expect(getHplcSheet).toHaveBeenCalledTimes(2))
    expect(
      await screen.findByText(
        'Could not refresh the sheet; what you see may be out of date'
      )
    ).toBeInTheDocument()
    // announced, without taking focus
    expect(screen.getByRole('status')).toHaveTextContent(
      'Could not refresh the sheet; what you see may be out of date'
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText(/Could not load the HPLC sheet/)).toBeNull()
    expect(next).toBeInTheDocument()
    expect(next).toHaveValue('80')
    expect(box).toHaveValue('6000')
  })

  it('a save that never answers times out after 15 seconds, says so, and the next save goes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const before = makeRow({ hplc_prep: { stock_vial_mg: 5012.31 } })
      vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([before]))
      // never answers, and ignores the abort: the queue must move on anyway
      queueSaves()
      renderPage()
      const first = await screen.findByRole('textbox', {
        name: `${S1}, ${VIAL}`,
      })
      const second = screen.getByRole('textbox', {
        name: `${S1}, ${VIAL_DIL}`,
      })
      typeAndLeave(first, '6000')
      typeAndLeave(second, '8003.6')
      await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
      await act(() => vi.advanceTimersByTimeAsync(14_000))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(patchHplcRow).toHaveBeenCalledTimes(1)
      await act(() => vi.advanceTimersByTimeAsync(1_500))
      expect(await screen.findByRole('alert')).toHaveTextContent(
        `Not saved: ${S1}, ${VIAL}: the save timed out; check the value and try again`
      )
      expect(first).toHaveValue('5012.31')
      await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(2))
      expect(patchHplcRow).toHaveBeenLastCalledWith(
        7,
        311,
        { hplc_prep: { stock_vial_diluent_mg: 8003.6 } },
        SIGNAL
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('the instrument save carries the 15 second abort signal', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    vi.mocked(updateWorksheetItem).mockResolvedValue({
      status: 'ok',
      item_id: 311,
    })
    renderPage()
    const select = await screen.findByRole('combobox', {
      name: `${S1}, Instrument`,
    })
    // the instruments list is empty here: the one choice left is not set
    fireEvent.change(select, { target: { value: '' } })
    await waitFor(() =>
      expect(updateWorksheetItem).toHaveBeenCalledWith(
        7,
        311,
        { instrument_id: null },
        SIGNAL
      )
    )
  })

  it('a number the server would refuse is never sent and is listed as too large', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '2e12')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Not saved: ${S1}, ${VIAL}: that number is too large`
    )
    expect(box).toHaveValue('2e12')
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(patchHplcRow).not.toHaveBeenCalled()
  })

  it('a completed sheet is read-only on the page', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([makeRow()], 'completed')
    )
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    expect(box).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Add samples' })
    ).not.toBeInTheDocument()
  })
})
