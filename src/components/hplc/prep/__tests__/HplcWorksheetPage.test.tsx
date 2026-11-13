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
import {
  getHplcPrepRules,
  getHplcSheet,
  getInstruments,
  patchHplcRow,
  updateWorksheetItem,
} from '@/lib/api'
import { toast } from 'sonner'
import { useWorksheetDrawer } from '@/hooks/use-worksheet-drawer'
import { hplcFailures } from '@/services/hplc-worksheet'
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
  return render(
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
    hplcFailures.reset()
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

  it('a negative number, a capsule count below 1 and a count past 2**53 - 1 are never sent', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([
        makeRow({
          form: 'capsule',
          sample_form: { id: 3, name: 'Capsule', hplc_prep: 'capsule' },
        }),
      ])
    )
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '-3')
    const count = screen.getByRole('textbox', { name: /^P-0120-S01, Capsules/ })
    typeAndLeave(count, '0')
    typeAndLeave(count, '9007199254740993')
    const alerts = await screen.findAllByRole('alert')
    expect(alerts.map(a => a.textContent)).toEqual([
      expect.stringContaining(
        `${S1}, ${VIAL}: a number here cannot be below 0`
      ),
      expect.stringMatching(/Capsules.*: type a whole number of 1 or more/),
      expect.stringMatching(/Capsules.*: that number is too large/),
    ])
    expect(patchHplcRow).not.toHaveBeenCalled()
  })

  it('A1: a failed save marks its box until that box saves, and its list entry goes with it', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([makeRow({ hplc_prep: { stock_vial_mg: 5012.31 } })])
    )
    const saves = queueSaves()
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    const other = screen.getByRole('textbox', { name: `${S1}, ${VIAL_DIL}` })
    typeAndLeave(box, '6000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    await act(async () => saves.fail(0, 'weighing out of range'))
    await screen.findByRole('alert')
    expect(box).toHaveAccessibleDescription(
      `Not saved: ${S1}, ${VIAL}: weighing out of range`
    )
    expect(box.className).toContain('border-red-500')
    expect(other).toHaveAccessibleDescription('')
    expect(other.className).not.toContain('border-red-500')
    typeAndLeave(box, '6000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(2))
    // still marked while the new save is out
    expect(box.className).toContain('border-red-500')
    await act(async () =>
      saves.ok(1, makeRow({ hplc_prep: { stock_vial_mg: 6000 } }))
    )
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    )
    expect(box).toHaveAccessibleDescription('')
    expect(box.className).not.toContain('border-red-500')
  })

  it('A1: dismissing a failure takes the mark off its box', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    const saves = queueSaves()
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '6000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    await act(async () => saves.fail(0, 'weighing out of range'))
    const alert = await screen.findByRole('alert')
    expect(box.className).toContain('border-red-500')
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(box.className).not.toContain('border-red-500')
    expect(box).toHaveAccessibleDescription('')
  })

  it('A1: the failure list stays in view while the sheet scrolls', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    const saves = queueSaves()
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '6000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    await act(async () => saves.fail(0, 'weighing out of range'))
    const holder = (await screen.findByRole('alert')).parentElement
    expect(holder?.className).toMatch(/\bsticky\b/)
    expect(holder?.className).toMatch(/\btop-0\b/)
    // above the sticky Sample ID cells (z-10)
    expect(holder?.className).toMatch(/\bz-20\b/)
  })

  it('A4: leaving the page asks first only while a save is out', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    const saves = queueSaves()
    renderPage()
    const leave = () => {
      const e = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(e)
      return e.defaultPrevented
    }
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    expect(leave()).toBe(false)
    typeAndLeave(box, '6000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    expect(leave()).toBe(true)
    await act(async () =>
      saves.ok(0, makeRow({ hplc_prep: { stock_vial_mg: 6000 } }))
    )
    await waitFor(() => expect(leave()).toBe(false))
  })

  it('A4: a save that fails after the page is left shows a toast naming the box', async () => {
    const error = vi.spyOn(toast, 'error')
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    const saves = queueSaves()
    const { unmount } = renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '6000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    unmount()
    await act(async () => saves.fail(0, 'weighing out of range'))
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        `Not saved: ${S1}, ${VIAL}: weighing out of range`
      )
    )
    error.mockRestore()
  })

  it('A8: a refused number leaves the list as soon as the box holds one it takes', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    vi.mocked(patchHplcRow).mockResolvedValue(makeRow())
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '-3')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'a number here cannot be below 0'
    )
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '-' } })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.change(box, { target: { value: '5' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(box).not.toHaveAttribute('aria-invalid')
  })

  it('A8: Escape on a refused number takes it off the list', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '2e12')
    await screen.findByRole('alert')
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(patchHplcRow).not.toHaveBeenCalled()
  })

  it('A14: picking an instrument goes through the save queue once and shows what the server stored', async () => {
    vi.mocked(getInstruments).mockResolvedValueOnce([
      { id: 3, name: 'HPLC 1290b', active: true },
    ] as Awaited<ReturnType<typeof getInstruments>>)
    vi.mocked(getHplcSheet)
      .mockResolvedValueOnce(
        makeSheet([makeRow({ instrument_id: null, instrument_name: null })])
      )
      .mockResolvedValue(
        makeSheet([
          makeRow({ instrument_id: 3, instrument_name: 'HPLC 1290b' }),
        ])
      )
    const saves = queueSaves()
    vi.mocked(updateWorksheetItem).mockResolvedValue({
      status: 'ok',
      item_id: 311,
    })
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    const select = await screen.findByRole('combobox', {
      name: `${S1}, Instrument`,
    })
    await screen.findByRole('option', { name: 'HPLC 1290b' })
    // a weighing goes out first: the instrument waits behind it
    typeAndLeave(box, '6000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    fireEvent.change(select, { target: { value: '3' } })
    await act(() => new Promise(r => setTimeout(r, 30)))
    expect(updateWorksheetItem).not.toHaveBeenCalled()
    await act(async () =>
      saves.ok(0, makeRow({ hplc_prep: { stock_vial_mg: 6000 } }))
    )
    await waitFor(() =>
      expect(updateWorksheetItem).toHaveBeenCalledWith(
        7,
        311,
        { instrument_id: 3 },
        SIGNAL
      )
    )
    await waitFor(() => expect(getHplcSheet).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(select).toHaveValue('3'))
    expect(updateWorksheetItem).toHaveBeenCalledTimes(1)
  })

  it('A2: while the prep rules load, the sheet is not shown', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    vi.mocked(getHplcPrepRules).mockImplementationOnce(
      () => new Promise(() => undefined)
    )
    renderPage()
    await waitFor(() => expect(getHplcSheet).toHaveBeenCalled())
    await act(() => new Promise(r => setTimeout(r, 30)))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('textbox', { name: `${S1}, ${VIAL}` })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('A2: a failed rules load shows Retry and no tables, and Retry brings the sheet', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    vi.mocked(getHplcPrepRules).mockRejectedValueOnce(new Error('down'))
    renderPage()
    expect(
      await screen.findByText(/Could not load the prep rules/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    ).toBeInTheDocument()
    expect(screen.queryByText(/Could not load the prep rules/)).toBeNull()
  })

  /** A box whose save failed: 6000 typed over 5012.31, refused by the server. */
  async function failedBox() {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([makeRow({ hplc_prep: { stock_vial_mg: 5012.31 } })])
    )
    const saves = queueSaves()
    const page = renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '6000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    await act(async () => saves.fail(0, 'weighing out of range'))
    await screen.findByRole('alert')
    return { box, page }
  }
  const SERVER_LINE = `Not saved: ${S1}, ${VIAL}: weighing out of range`

  it('Y1: Escape on a refused word keeps the failed save of the same box listed and marked', async () => {
    const { box } = await failedBox()
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: 'abc' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getAllByRole('alert')).toHaveLength(2)
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.blur(box)
    await act(() => new Promise(r => setTimeout(r, 30)))
    expect(box).toHaveValue('5012.31')
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent(SERVER_LINE)
    expect(box.className).toContain('border-red-500')
    expect(hplcFailures.get(7)).toHaveLength(1)
  })

  it('Y1: an acceptable value then Escape keeps the failed save listed and marked', async () => {
    const { box } = await failedBox()
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '-3' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getAllByRole('alert')).toHaveLength(2)
    fireEvent.change(box, { target: { value: '5' } })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.blur(box)
    await act(() => new Promise(r => setTimeout(r, 30)))
    expect(screen.getByRole('alert')).toHaveTextContent(SERVER_LINE)
    expect(box.className).toContain('border-red-500')
  })

  it('Y3: a refusal dismissed and typed again is listed again', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '-3')
    const alert = await screen.findByRole('alert')
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    typeAndLeave(box, '-3')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'a number here cannot be below 0'
    )
    // Enter and the blur after it list it once
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.blur(box)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('X1: a save that fails while the page is away is listed and marks its box when the page is back; Dismiss takes it out of the store', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([makeRow({ hplc_prep: { stock_vial_mg: 5012.31 } })])
    )
    const saves = queueSaves()
    const { unmount } = renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '6000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    unmount()
    await act(async () => saves.fail(0, 'weighing out of range'))
    await waitFor(() => expect(hplcFailures.get(7)).toHaveLength(1))
    renderPage()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(SERVER_LINE)
    const again = await screen.findByRole('textbox', {
      name: `${S1}, ${VIAL}`,
    })
    expect(again.className).toContain('border-red-500')
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(hplcFailures.get(7)).toHaveLength(0)
    expect(again.className).not.toContain('border-red-500')
  })

  it('P4: a weighing above 1e9 mg and a declared volume above 1e6 mL are refused in the box; the ceilings themselves are sent', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(
      makeSheet([makeRow({ form: 'liquid', prep_form: 'liquid' })])
    )
    vi.mocked(patchHplcRow).mockResolvedValue(makeRow())
    renderPage()
    const vol = await screen.findByRole('textbox', {
      name: `${S1}, Declared Liquid Vol (mL)`,
    })
    const vial = screen.getByRole('textbox', {
      name: `${S1}, Wt Autosampler vial and cap (mg)`,
    })
    typeAndLeave(vol, '1000001')
    typeAndLeave(vial, '1000000001')
    const alerts = await screen.findAllByRole('alert')
    expect(alerts.map(a => a.textContent)).toEqual([
      expect.stringContaining(
        'Declared Liquid Vol (mL): a declared volume cannot be more than 1,000,000 mL'
      ),
      expect.stringContaining(
        'Wt Autosampler vial and cap (mg): a weighing cannot be more than 1,000,000,000 mg'
      ),
    ])
    expect(patchHplcRow).not.toHaveBeenCalled()
    typeAndLeave(vol, '1000000')
    typeAndLeave(vial, '1000000000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(2))
  })

  it('Y6: leaving the page while saving sets a returnValue too', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    queueSaves()
    renderPage()
    const box = await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    typeAndLeave(box, '6000')
    await waitFor(() => expect(patchHplcRow).toHaveBeenCalledTimes(1))
    const e = new Event('beforeunload', { cancelable: true }) as Event & {
      returnValue: unknown
    }
    const set = vi.fn()
    Object.defineProperty(e, 'returnValue', { set, get: () => '' })
    window.dispatchEvent(e)
    expect(set).toHaveBeenCalledWith('')
  })

  it('Y5: a long failure list scrolls inside itself', async () => {
    await failedBox()
    const holder = screen.getByRole('alert').parentElement
    expect(holder?.className).toMatch(/\bmax-h-48\b/)
    expect(holder?.className).toMatch(/\boverflow-y-auto\b/)
  })

  it('the page root is its own stacking context, keeps to the width it is given, and darkens native controls (L2, L3)', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    renderPage()
    await screen.findByRole('textbox', { name: `${S1}, ${VIAL}` })
    const root = screen.getByTestId('hplc-worksheet-page')
    for (const c of [
      'isolate',
      '[contain:inline-size]',
      'dark:[color-scheme:dark]',
    ])
      expect(root.className.split(/\s+/)).toContain(c)
  })

  it('the header links to the HPLC Prep Rules page (T2)', async () => {
    vi.mocked(getHplcSheet).mockResolvedValue(makeSheet([makeRow()]))
    const navigateTo = vi.fn()
    const real = useUIStore.getState().navigateTo
    useUIStore.setState({ navigateTo })
    try {
      renderPage()
      fireEvent.click(
        await screen.findByRole('button', { name: 'HPLC Prep Rules' })
      )
      expect(navigateTo).toHaveBeenCalledWith(
        'hplc-analysis',
        'hplc-prep-rules'
      )
    } finally {
      useUIStore.setState({ navigateTo: real })
    }
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
