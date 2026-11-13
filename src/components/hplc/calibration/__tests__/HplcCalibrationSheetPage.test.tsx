import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  act,
  fireEvent,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import type * as ApiModule from '@/lib/api'
import {
  CalSheetError,
  getCalSheet,
  getInstruments,
  getPeptides,
  listCalSheets,
  saveCalSheet,
  type CalSheet,
  type CalSheetSave,
  type Instrument,
} from '@/lib/api'
import type { CalInputs, CalReplicateInputs } from '@/lib/hplc-calibration'
import {
  CAL_SHEET_KEY,
  NO_ANSWER,
  RELOADED,
  SAVE_TIMEOUT_MS,
  resetCalSaves,
  useSaveCalSheet,
} from '@/services/hplc-calibration-sheets'
import { useUIStore } from '@/store/ui-store'
import {
  fixtureCase,
  makeSheet,
  renderSheet,
  typeAndLeave,
} from './cal-test-helpers'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getCalSheet: vi.fn(),
  saveCalSheet: vi.fn(),
  getPeptides: vi.fn(),
  getInstruments: vi.fn(),
  listCalSheets: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

/** Each save waits until the test answers it, by call number. */
function queueSaves() {
  const pending: {
    resolve: (s: CalSheet) => void
    reject: (e: Error) => void
  }[] = []
  vi.mocked(saveCalSheet).mockImplementation(
    () =>
      new Promise<CalSheet>((resolve, reject) => {
        pending.push({ resolve, reject })
      })
  )
  return {
    count: () => pending.length,
    ok: async (n: number, s: CalSheet) => {
      await act(async () => pending[n]?.resolve(s))
    },
    fail: async (n: number, e: Error) => {
      await act(async () => pending[n]?.reject(e))
    },
  }
}

const body = (n: number) =>
  vi.mocked(saveCalSheet).mock.calls[n]?.[1] as CalSheetSave
const inputsOf = (n: number) => body(n).inputs as CalInputs
const page = () =>
  screen.getByTestId('hplc-calibration-page').firstElementChild as HTMLElement

async function openCase1(over: Partial<CalSheet> = {}) {
  const sheet = makeSheet(fixtureCase(1).inputs as CalInputs, over)
  vi.mocked(getCalSheet).mockResolvedValue(sheet)
  const view = renderSheet()
  await screen.findByText('Curve name:', { exact: false })
  return { sheet, view }
}

describe('HplcCalibrationSheetPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetCalSaves()
    vi.mocked(getPeptides).mockResolvedValue([])
    vi.mocked(getInstruments).mockResolvedValue([])
    vi.mocked(listCalSheets).mockResolvedValue([])
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the list when no sheet is open', async () => {
    useUIStore.setState({ calibrationSheetPageId: null })
    vi.mocked(getCalSheet).mockResolvedValue(makeSheet({}))
    renderSheet()
    act(() => useUIStore.setState({ calibrationSheetPageId: null }))
    expect(
      await screen.findByText('Calibration worksheets')
    ).toBeInTheDocument()
  })

  it('a replicate sheet locks everything but its instrument, notes and Step 4', async () => {
    const c20 = fixtureCase(20)
    const own = c20.inputs as CalReplicateInputs
    const original = c20.replicate_of as CalInputs
    vi.mocked(getCalSheet).mockResolvedValue(
      makeSheet(own, {
        replicate_of_sheet_id: 4,
        replicate_of_name: '1290C-20260205-RETA',
        effective_inputs: original,
      })
    )
    const saves = queueSaves()
    renderSheet()
    await screen.findByTestId('replicate-note')
    expect(screen.getByTestId('replicate-note').textContent).toContain(
      'Another injection of the same vials as 1290C-20260205-RETA'
    )
    const live = [
      ...document.querySelectorAll('input, select, textarea'),
    ].filter(el => !(el as HTMLInputElement).disabled)
    const names = live.map(el => el.getAttribute('aria-label'))
    expect(names).toContain('Instrument')
    expect(names).toContain('Notes')
    for (const n of names)
      expect(
        n === 'Instrument' ||
          n === 'Notes' ||
          /(Peak Area|Purity \(%\)|RT \(min\))$/.test(n ?? '')
      ).toBe(true)
    expect(names.filter(n => /Peak Area$/.test(n ?? '')).length).toBe(6)
    // Step 4 shows the replicate's own areas over the original's weighings
    const area = screen.getByLabelText(
      'Level 1, 1000 ug/mL, Peak Area'
    ) as HTMLInputElement
    expect(area.value).toBe('8760.2649')
    typeAndLeave(area, '8800')
    await waitFor(() => expect(saves.count()).toBe(1))
    const sent = body(0)
    expect('peptide_id' in sent).toBe(false)
    expect(sent.inputs).toEqual({
      ...own,
      levels: own.levels?.map((l, i) =>
        i === 0 ? { ...l, peak_area: 8800 } : l
      ),
    })
  })

  it('a cleared box saves null, never 0', async () => {
    const saves = queueSaves()
    await openCase1()
    typeAndLeave(screen.getByLabelText('Weight from COA (mg)'), '')
    await waitFor(() => expect(saves.count()).toBe(1))
    expect(inputsOf(0).coa_weight_mg).toBeNull()
    expect(inputsOf(0).levels?.[0]?.vial_mg).toBe(2794.62) // the WHOLE inputs go
    expect(body(0).version).toBe(1)
  })

  it('a 409 on save reloads the sheet and says why', async () => {
    const saves = queueSaves()
    const { sheet } = await openCase1()
    typeAndLeave(screen.getByLabelText('Weight from COA (mg)'), '6')
    await waitFor(() => expect(saves.count()).toBe(1))
    const theirs = makeSheet(
      { ...(sheet.inputs as CalInputs), coa_weight_mg: 9 },
      { version: 3 }
    )
    vi.mocked(getCalSheet).mockResolvedValue(theirs)
    await saves.fail(
      0,
      new CalSheetError(
        'Someone else saved this sheet. It has been reloaded.',
        409
      )
    )
    expect(await screen.findByText(RELOADED)).toBeInTheDocument()
    expect(
      (screen.getByLabelText('Weight from COA (mg)') as HTMLInputElement).value
    ).toBe('9')
    expect(toast.error).toHaveBeenCalledWith(
      'Someone else saved this sheet. It has been reloaded.'
    )
    expect(page().dataset.saved).toBe('true')
    // it stays until dismissed
    typeAndLeave(screen.getByLabelText('Lot #'), 'L2')
    expect(screen.getByText(RELOADED)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(RELOADED)).toBeNull()
    // the next save carries the reloaded version
    await waitFor(() => expect(saves.count()).toBe(2))
    expect(body(1).version).toBe(3)
  })

  it("a 409 that is not someone else's save keeps the typed values (rule 5)", async () => {
    const saves = queueSaves()
    const { sheet } = await openCase1({ curve_id: 70 })
    typeAndLeave(screen.getByLabelText('Weight from COA (mg)'), '6')
    await waitFor(() => expect(saves.count()).toBe(1))
    vi.mocked(getCalSheet).mockResolvedValue(sheet) // same version
    await saves.fail(0, new CalSheetError('This curve is filed on 1290C.', 409))
    expect(
      await screen.findByText(/Not saved: This curve is filed on 1290C\./)
    ).toBeInTheDocument()
    expect(
      (screen.getByLabelText('Weight from COA (mg)') as HTMLInputElement).value
    ).toBe('6')
    expect(screen.queryByText(RELOADED)).toBeNull()
  })

  describe('saving', () => {
    it('rule 1 and 3: a failed save keeps the typed value and the Not saved line stays', async () => {
      const saves = queueSaves()
      await openCase1()
      const box = screen.getByLabelText(
        'Weight from COA (mg)'
      ) as HTMLInputElement
      typeAndLeave(box, '6')
      expect(await screen.findByText('Saving...')).toBeInTheDocument()
      await saves.fail(
        0,
        new CalSheetError('Weight from COA (mg): check it.', 400)
      )
      const line = await screen.findByText(
        /^Not saved: Weight from COA \(mg\): check it\. Your changes are still on this page\./
      )
      expect(line).toBeInTheDocument()
      expect(box.value).toBe('6')
      // a later re-render (another sheet field from the server) and typing elsewhere
      typeAndLeave(screen.getByLabelText('Lot #'), 'L9')
      await waitFor(() => expect(saves.count()).toBe(2))
      expect(
        screen.getByText(/^Not saved: Weight from COA/)
      ).toBeInTheDocument()
      await saves.fail(1, new CalSheetError('still refused', 400))
      expect(
        await screen.findByText(/^Not saved: still refused\./)
      ).toBeInTheDocument()
      expect(box.value).toBe('6')
      expect((screen.getByLabelText('Lot #') as HTMLInputElement).value).toBe(
        'L9'
      )
      expect(page().dataset.saved).toBe('false')
    })

    it('rule 3: Retry sends the current inputs, and only a confirmed save clears the line', async () => {
      const saves = queueSaves()
      const { sheet } = await openCase1()
      typeAndLeave(screen.getByLabelText('Weight from COA (mg)'), '6')
      await waitFor(() => expect(saves.count()).toBe(1))
      await saves.fail(0, new Error(NO_ANSWER))
      await screen.findByRole('button', { name: 'Retry' })
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(saves.count()).toBe(2))
      expect(inputsOf(1).coa_weight_mg).toBe(6)
      expect(screen.getByText(/^Not saved:/)).toBeInTheDocument()
      await saves.ok(1, { ...sheet, version: 2, inputs: inputsOf(1) })
      await waitFor(() => expect(screen.queryByText(/^Not saved:/)).toBeNull())
      expect(page().dataset.saved).toBe('true')
    })

    it("rule 2: two quick edits make two requests in order, the second on the first one's version", async () => {
      const saves = queueSaves()
      const { sheet } = await openCase1()
      typeAndLeave(screen.getByLabelText('Weight from COA (mg)'), '6')
      typeAndLeave(screen.getByLabelText('Lot #'), 'L2')
      await waitFor(() => expect(saves.count()).toBe(1))
      expect(inputsOf(0).lot).toBe('39747') // never two at once
      await saves.ok(0, { ...sheet, version: 2, inputs: inputsOf(0) })
      await waitFor(() => expect(saves.count()).toBe(2))
      expect(body(1).version).toBe(2)
      expect(inputsOf(1)).toMatchObject({ coa_weight_mg: 6, lot: 'L2' })
    })

    it('rule 2: a save unanswered for 15 seconds counts as failed', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      queueSaves()
      await openCase1()
      typeAndLeave(screen.getByLabelText('Weight from COA (mg)'), '6')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS + 10)
      })
      expect(
        screen.getByText(
          `Not saved: ${NO_ANSWER}. Your changes are still on this page.`
        )
      ).toBeInTheDocument()
    })

    it('rule 4: saved is false from the first commit until the server confirms', async () => {
      const saves = queueSaves()
      const { sheet } = await openCase1()
      expect(page().dataset.saved).toBe('true')
      typeAndLeave(screen.getByLabelText('Weight from COA (mg)'), '6')
      expect(page().dataset.saved).toBe('false')
      await waitFor(() => expect(saves.count()).toBe(1))
      expect(page().dataset.saved).toBe('false')
      await saves.ok(0, { ...sheet, version: 2, inputs: inputsOf(0) })
      await waitFor(() => expect(page().dataset.saved).toBe('true'))
    })

    it('rule 6: leaving asks the browser while unsaved, and sends one last save on unmount', async () => {
      const saves = queueSaves()
      const { view } = await openCase1()
      const ev = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(false)
      typeAndLeave(screen.getByLabelText('Weight from COA (mg)'), '6')
      await saves.fail(0, new Error(NO_ANSWER))
      const ev2 = new Event('beforeunload', {
        cancelable: true,
      }) as BeforeUnloadEvent
      window.dispatchEvent(ev2)
      expect(ev2.defaultPrevented).toBe(true)
      view.unmount()
      await waitFor(() => expect(saves.count()).toBe(2))
      expect(inputsOf(1).coa_weight_mg).toBe(6)
      await saves.fail(1, new Error(NO_ANSWER))
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          expect.stringContaining(
            'Calibration sheet 1290C-20260205-RETA: your last changes were not saved.'
          )
        )
      )
    })

    it('rule 7: a value the server would refuse stays in its box and is never sent', async () => {
      const saves = queueSaves()
      await openCase1()
      const mw = screen.getByLabelText(
        'Free-peptide MW (g/mol)'
      ) as HTMLInputElement
      typeAndLeave(mw, '0.5')
      expect(screen.getByText('must be at least 1')).toBeInTheDocument()
      expect(mw.value).toBe('0.5')
      expect(mw).toHaveAttribute('aria-invalid', 'true')
      expect(saves.count()).toBe(0)
      expect(page().dataset.saved).toBe('false')
      // Escape gives the stored value back
      fireEvent.keyDown(mw, { key: 'Escape' })
      expect(mw.value).toBe('')
      expect(page().dataset.saved).toBe('true')
      typeAndLeave(screen.getByLabelText('Water, Karl Fischer (%)'), '100')
      expect(
        screen.getByText('must be 0 or more and less than 100')
      ).toBeInTheDocument()
      expect(saves.count()).toBe(0)
    })
  })
})

const instrument = (id: number, name: string): Instrument => ({
  id,
  name,
  senaite_id: null,
  senaite_uid: null,
  instrument_type: null,
  brand: null,
  model: null,
  active: true,
  department_id: null,
  origin: 'mk1',
  created_at: '',
  updated_at: '',
})
const box = (l: string) => screen.getByLabelText(l) as HTMLInputElement
const later = async (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

describe('HplcCalibrationSheetPage, fix round 1', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetCalSaves()
    vi.mocked(getPeptides).mockResolvedValue([])
    vi.mocked(getInstruments).mockResolvedValue([])
    vi.mocked(listCalSheets).mockResolvedValue([])
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('C1: a 409 after saves that went unanswered', () => {
    it('P1: two timeouts, only the first landed: the typed values stay and go on the new version', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const saves = queueSaves()
      const { sheet } = await openCase1()
      typeAndLeave(box('Weight from COA (mg)'), '6')
      await later(SAVE_TIMEOUT_MS + 10)
      typeAndLeave(box('Lot #'), 'L2')
      await waitFor(() => expect(saves.count()).toBe(2))
      await later(SAVE_TIMEOUT_MS + 10)
      typeAndLeave(box('Standard Supplier'), 'S3')
      await waitFor(() => expect(saves.count()).toBe(3))
      expect(body(2).version).toBe(1)
      vi.mocked(getCalSheet).mockResolvedValue(
        makeSheet(
          { ...(sheet.inputs as CalInputs), coa_weight_mg: 6 },
          { version: 2 }
        )
      )
      await saves.fail(2, new CalSheetError('stale', 409))
      await waitFor(() => expect(saves.count()).toBe(4))
      expect(screen.queryByText(RELOADED)).toBeNull()
      expect(box('Lot #').value).toBe('L2')
      expect(box('Standard Supplier').value).toBe('S3')
      expect(body(3).version).toBe(2)
      expect(inputsOf(3)).toMatchObject({
        coa_weight_mg: 6,
        lot: 'L2',
        supplier: 'S3',
      })
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('three timeouts in a row where the SECOND landed: nothing is lost', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const saves = queueSaves()
      const { sheet } = await openCase1()
      typeAndLeave(box('Weight from COA (mg)'), '6')
      await later(SAVE_TIMEOUT_MS + 10)
      typeAndLeave(box('Lot #'), 'L2')
      await waitFor(() => expect(saves.count()).toBe(2))
      await later(SAVE_TIMEOUT_MS + 10)
      typeAndLeave(box('Standard Supplier'), 'S3')
      await waitFor(() => expect(saves.count()).toBe(3))
      await later(SAVE_TIMEOUT_MS + 10)
      typeAndLeave(box('CAS number'), 'C4')
      await waitFor(() => expect(saves.count()).toBe(4))
      // the second body (weight and lot) is what the server holds
      vi.mocked(getCalSheet).mockResolvedValue(
        makeSheet(
          { ...(sheet.inputs as CalInputs), coa_weight_mg: 6, lot: 'L2' },
          { version: 2 }
        )
      )
      await saves.fail(3, new CalSheetError('stale', 409))
      await waitFor(() => expect(saves.count()).toBe(5))
      expect(screen.queryByText(RELOADED)).toBeNull()
      expect(body(4).version).toBe(2)
      expect(inputsOf(4)).toMatchObject({
        coa_weight_mg: 6,
        lot: 'L2',
        supplier: 'S3',
        cas: 'C4',
      })
      await saves.ok(4, { ...sheet, version: 3, inputs: inputsOf(4) })
      await waitFor(() => expect(page().dataset.saved).toBe('true'))
      expect(screen.queryByTestId('save-line')).toBeNull()
    })

    it('after a timeout, a save that is someone else still reloads and says so', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const saves = queueSaves()
      const { sheet } = await openCase1()
      typeAndLeave(box('Weight from COA (mg)'), '6')
      await later(SAVE_TIMEOUT_MS + 10)
      typeAndLeave(box('Lot #'), 'L2')
      await waitFor(() => expect(saves.count()).toBe(2))
      vi.mocked(getCalSheet).mockResolvedValue(
        makeSheet(
          { ...(sheet.inputs as CalInputs), coa_weight_mg: 9 },
          { version: 2 }
        )
      )
      await saves.fail(1, new CalSheetError('stale', 409))
      expect(await screen.findByText(RELOADED)).toBeInTheDocument()
      expect(box('Weight from COA (mg)').value).toBe('9')
      expect(box('Lot #').value).toBe('39747')
      expect(toast.error).toHaveBeenCalledWith('stale')
    })

    it('I4 (P2): a 409 whose re-read never answers fails after 15 seconds with Retry', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const saves = queueSaves()
      await openCase1()
      typeAndLeave(box('Weight from COA (mg)'), '6')
      await waitFor(() => expect(saves.count()).toBe(1))
      vi.mocked(getCalSheet).mockImplementation(
        () => new Promise<CalSheet>(() => undefined)
      )
      await saves.fail(0, new CalSheetError('stale', 409))
      await later(SAVE_TIMEOUT_MS + 10)
      expect(screen.getByTestId('save-line').textContent).toContain(
        `Not saved: ${NO_ANSWER}. Your changes are still on this page.`
      )
      expect(screen.getByRole('button', { name: 'Retry' })).not.toBeDisabled()
      expect(box('Weight from COA (mg)').value).toBe('6')
    })
  })

  it('(a) and P4: A fails while B was typed; B waits for Retry, then A and B go on the old version', async () => {
    const saves = queueSaves()
    await openCase1()
    typeAndLeave(box('Weight from COA (mg)'), '6')
    await waitFor(() => expect(saves.count()).toBe(1))
    typeAndLeave(box('Lot #'), 'L2')
    await saves.fail(0, new TypeError('Failed to fetch'))
    expect(
      await screen.findByText(
        `Not saved: ${NO_ANSWER}. Your changes are still on this page.`
      )
    ).toBeInTheDocument()
    await act(async () => {
      await new Promise(r => setTimeout(r, 30))
    })
    expect(saves.count()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(saves.count()).toBe(2))
    expect(body(1).version).toBe(1)
    expect(inputsOf(1)).toMatchObject({ coa_weight_mg: 6, lot: 'L2' })
  })

  it('P4, the next edit: A fails while B was typed; C carries A, B and C on the old version', async () => {
    const saves = queueSaves()
    await openCase1()
    typeAndLeave(box('Weight from COA (mg)'), '6')
    await waitFor(() => expect(saves.count()).toBe(1))
    typeAndLeave(box('Lot #'), 'L2')
    await saves.fail(0, new TypeError('Failed to fetch'))
    await screen.findByRole('button', { name: 'Retry' })
    expect(saves.count()).toBe(1)
    typeAndLeave(box('Standard Supplier'), 'S3')
    await waitFor(() => expect(saves.count()).toBe(2))
    expect(body(1).version).toBe(1)
    expect(inputsOf(1)).toMatchObject({
      coa_weight_mg: 6,
      lot: 'L2',
      supplier: 'S3',
    })
  })

  it('a value typed back after a timeout is not "saved" while its save also fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const saves = queueSaves()
    await openCase1()
    const w = box('Weight from COA (mg)')
    const before = w.value
    typeAndLeave(w, '6')
    await later(SAVE_TIMEOUT_MS + 10)
    // typed back: the server may still hold 6, so it is sent all the same
    typeAndLeave(w, before)
    await waitFor(() => expect(saves.count()).toBe(2))
    await later(SAVE_TIMEOUT_MS + 10)
    expect(page().dataset.saved).toBe('false')
    expect(screen.getByTestId('save-line').textContent).toContain(
      `Not saved: ${NO_ANSWER}.`
    )
    const ev = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('a refused value under one box survives another box being saved', async () => {
    const saves = queueSaves()
    const { sheet } = await openCase1()
    typeAndLeave(box('Free-peptide MW (g/mol)'), '0.5')
    typeAndLeave(box('Lot #'), 'L2')
    await waitFor(() => expect(saves.count()).toBe(1))
    await saves.ok(0, { ...sheet, version: 2, inputs: inputsOf(0) })
    await waitFor(() => expect(screen.queryByText('Saving...')).toBeNull())
    expect(screen.getByText('must be at least 1')).toBeInTheDocument()
    expect(box('Free-peptide MW (g/mol)').value).toBe('0.5')
    expect(page().dataset.saved).toBe('false')
  })

  it('a sheet that cannot be worked out as stored says so, and every box stays editable', async () => {
    await openCase1({ blocking: ['cannot_be_worked_out'] })
    expect(
      screen.getByText(
        'This sheet cannot be worked out as stored. Check the values below.'
      )
    ).toBeInTheDocument()
    const off = [
      ...document.querySelectorAll('input, select, textarea'),
    ].filter(el => (el as HTMLInputElement).disabled)
    expect(off).toEqual([])
  })

  it('the leave-page handler sets returnValue', async () => {
    queueSaves()
    await openCase1()
    typeAndLeave(box('Weight from COA (mg)'), '6')
    const ev = new Event('beforeunload', { cancelable: true })
    let set: unknown = 'untouched'
    Object.defineProperty(ev, 'returnValue', {
      configurable: true,
      get: () => set,
      set: (v: unknown) => {
        set = v
      },
    })
    window.dispatchEvent(ev)
    expect(set).toBe('')
    expect(ev.defaultPrevented).toBe(true)
  })

  it('(b) coming back to a fully saved sheet shows loading until the server answers', async () => {
    const saves = queueSaves()
    const { sheet } = await openCase1()
    typeAndLeave(box('Weight from COA (mg)'), '6')
    await waitFor(() => expect(saves.count()).toBe(1))
    await saves.ok(0, { ...sheet, version: 2, inputs: inputsOf(0) })
    await waitFor(() => expect(page().dataset.saved).toBe('true'))
    act(() => useUIStore.setState({ calibrationSheetPageId: null }))
    let answer: (s: CalSheet) => void = () => undefined
    vi.mocked(getCalSheet).mockImplementation(
      () =>
        new Promise<CalSheet>(r => {
          answer = r
        })
    )
    act(() => useUIStore.setState({ calibrationSheetPageId: 5 }))
    expect(screen.getByText('Loading the sheet...')).toBeInTheDocument()
    expect(screen.queryByLabelText('Weight from COA (mg)')).toBeNull()
    await act(async () =>
      answer(
        makeSheet(
          { ...(sheet.inputs as CalInputs), coa_weight_mg: 7 },
          { version: 4 }
        )
      )
    )
    expect(await screen.findByLabelText('Weight from COA (mg)')).toHaveValue(
      '7'
    )
    typeAndLeave(box('Lot #'), 'L2')
    await waitFor(() => expect(saves.count()).toBe(2))
    expect(body(1).version).toBe(4)
  })

  it('coming back to a sheet with unsaved values keeps them', async () => {
    const saves = queueSaves()
    await openCase1()
    typeAndLeave(box('Weight from COA (mg)'), '6')
    await waitFor(() => expect(saves.count()).toBe(1))
    await saves.fail(0, new CalSheetError('refused', 400))
    act(() => useUIStore.setState({ calibrationSheetPageId: null }))
    act(() => useUIStore.setState({ calibrationSheetPageId: 5 }))
    expect(await screen.findByLabelText('Weight from COA (mg)')).toHaveValue(
      '6'
    )
  })

  it('I2: a picker stays open while it differs from the filed sheet, and locks when it agrees', async () => {
    vi.mocked(getInstruments).mockResolvedValue([
      instrument(2, '1290C'),
      instrument(3, '1290A'),
    ])
    const saves = queueSaves()
    const { sheet } = await openCase1()
    const pick = () => screen.getByLabelText('Instrument') as HTMLSelectElement
    await waitFor(() => expect(pick().options.length).toBe(3))
    fireEvent.change(pick(), { target: { value: '3' } })
    await waitFor(() => expect(saves.count()).toBe(1))
    // filed meanwhile: the save is refused and the sheet now has a curve
    vi.mocked(getCalSheet).mockResolvedValue({ ...sheet, curve_id: 70 })
    await saves.fail(0, new CalSheetError('This curve is filed on 1290C.', 409))
    await screen.findByText(/Not saved: This curve is filed on 1290C/)
    expect(pick().value).toBe('3')
    expect(pick()).not.toBeDisabled()
    expect(screen.getByLabelText('Compound')).toBeDisabled()
    fireEvent.change(pick(), { target: { value: '2' } })
    await waitFor(() => expect(pick()).toBeDisabled())
  })

  it('Task 7: setQueryData with the filed sheet (same version) is not a foreign change', async () => {
    const saves = queueSaves()
    const { sheet, view } = await openCase1()
    act(() =>
      view.qc.setQueryData(CAL_SHEET_KEY(5), {
        ...sheet,
        curve_id: 70,
        curve_name: '1290C-20260205-RETA',
      })
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Instrument')).toBeDisabled()
    )
    expect(screen.queryByText(RELOADED)).toBeNull()
    expect(page().dataset.saved).toBe('true')
    typeAndLeave(box('Lot #'), 'L2')
    await waitFor(() => expect(saves.count()).toBe(1))
    expect(body(0).version).toBe(1)
  })

  it('the hook exports the version it holds', async () => {
    const saves = queueSaves()
    const sheet = makeSheet(fixtureCase(1).inputs as CalInputs)
    vi.mocked(getCalSheet).mockResolvedValue(sheet)
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const { result } = renderHook(() => useSaveCalSheet(5), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    })
    await waitFor(() => expect(result.current.state?.version).toBe(1))
    act(() =>
      result.current.edit(d => ({
        ...d,
        inputs: { ...(d.inputs as CalInputs), lot: 'L2' },
      }))
    )
    await waitFor(() => expect(saves.count()).toBe(1))
    await saves.ok(0, { ...sheet, version: 2, inputs: inputsOf(0) })
    await waitFor(() => expect(result.current.state?.version).toBe(2))
  })

  it('I5: the Date box commits once on blur, Escape restores, and a part-typed date is refused', async () => {
    const saves = queueSaves()
    await openCase1()
    const date = box('Date')
    fireEvent.focus(date)
    fireEvent.change(date, { target: { value: '2026-03-01' } })
    expect(saves.count()).toBe(0)
    fireEvent.blur(date)
    await waitFor(() => expect(saves.count()).toBe(1))
    expect(inputsOf(0).date).toBe('2026-03-01')
    fireEvent.focus(date)
    fireEvent.change(date, { target: { value: '2026-04-02' } })
    fireEvent.keyDown(date, { key: 'Escape' })
    expect(date.value).toBe('2026-03-01')
    fireEvent.blur(date)
    // a date the browser holds only part of reads as '' with badInput
    fireEvent.focus(date)
    Object.defineProperty(date, 'validity', {
      configurable: true,
      value: { badInput: true },
    })
    fireEvent.change(date, { target: { value: '' } })
    fireEvent.blur(date)
    expect(
      screen.getByText('use the date picker or YYYY-MM-DD')
    ).toBeInTheDocument()
    expect(page().dataset.saved).toBe('false')
    await act(async () => {
      await new Promise(r => setTimeout(r, 30))
    })
    expect(saves.count()).toBe(1)
  })

  it('(d) the replicate note names the original instrument when it differs', async () => {
    const c20 = fixtureCase(20)
    const original = c20.replicate_of as CalInputs
    const rep = makeSheet(c20.inputs as CalReplicateInputs, {
      replicate_of_sheet_id: 4,
      replicate_of_name: '1290A-20260205-RETA',
      effective_inputs: original,
    })
    vi.mocked(getCalSheet).mockImplementation(async id =>
      id === 4
        ? makeSheet(original, {
            id: 4,
            instrument_id: 3,
            instrument_name: '1290A',
          })
        : rep
    )
    renderSheet()
    await waitFor(() =>
      expect(screen.getByTestId('replicate-note').textContent).toContain(
        'Another injection of the same vials as 1290A-20260205-RETA, on the 1290C (the original ran on the 1290A).'
      )
    )
  })

  it('(e) two levels with the same target have distinct names', async () => {
    const inputs = fixtureCase(1).inputs as CalInputs
    const levels = [...(inputs.levels ?? [])]
    levels[1] = { ...levels[1], target: levels[0]?.target }
    vi.mocked(getCalSheet).mockResolvedValue(makeSheet({ ...inputs, levels }))
    renderSheet()
    await screen.findByText('Curve name:', { exact: false })
    expect(
      screen.getByLabelText('Level 1, 1000 ug/mL, Peak Area')
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText('Level 2, 1000 ug/mL, Peak Area')
    ).toBeInTheDocument()
  })
})
