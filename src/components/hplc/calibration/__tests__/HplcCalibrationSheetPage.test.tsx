import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  act,
  fireEvent,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import type * as ApiModule from '@/lib/api'
import {
  CalSheetError,
  createCalSheet,
  duplicateCalSheet,
  fileCalSheet,
  getCalSheet,
  getInstruments,
  getPeptides,
  listCalSheets,
  saveCalSheet,
  type CalFileResult,
  type CalibrationCurve,
  type CalSheet,
  type CalSheetSave,
  type Instrument,
} from '@/lib/api'
import type { CalInputs, CalReplicateInputs } from '@/lib/hplc-calibration'
import {
  CAL_SHEET_KEY,
  NO_ANSWER,
  RELOADED,
  RELOADED_NOTHING_LOST,
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
  fileCalSheet: vi.fn(),
  duplicateCalSheet: vi.fn(),
  createCalSheet: vi.fn(),
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
/** react-query notifies on a setTimeout(0): let the page re-render. */
const flush = async () =>
  act(async () => {
    await new Promise(r => setTimeout(r, 20))
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
    // fix round 2 ruling: the refused picker goes back to the stored value
    // (it agrees with the filed sheet, so it locks), and the sentence stays
    await screen.findByText('This curve is filed on 1290C.')
    expect(pick().value).toBe('2')
    await waitFor(() => expect(pick()).toBeDisabled())
    expect(screen.getByLabelText('Compound')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
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

// --- Task 7: File curve, Duplicate for another injection, New ---

const NAME = '1290C-20260205-RETA'
type Reason = CalFileResult['activation']['reason']

/** What the file route answers (task-5-report, fix round 2). */
function filedAs(
  sheet: CalSheet,
  reason: Reason,
  over: Partial<CalFileResult> = {},
  active = reason === 'first_active' || reason === 'replaced'
): CalFileResult {
  return {
    sheet: {
      ...sheet,
      curve_id: 70,
      curve_name: sheet.curve_name ?? NAME,
      curve_is_active: active,
      filed_at: '2026-11-13T10:00:00',
      changed_since_filed: false,
    },
    curve: { id: 70, source_filename: NAME } as CalibrationCurve,
    activation: { active, reason, deactivated_ids: [], other_active_ids: [] },
    refiled_curve_ids: [],
    warnings: [],
    ...over,
  }
}

const fileBtn = () =>
  screen.getByRole('button', { name: /^(File curve|Filing\.\.\.)$/ })
const dupBtn = () =>
  screen.getByRole('button', {
    name: /^(Duplicate for another injection|Duplicating\.\.\.)$/,
  })
/** A button's accessible description: its reasons, then its help. */
const why = (b: HTMLElement) =>
  (b.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map(id => document.getElementById(id)?.textContent ?? '')
    .join(' ')
const notice = () => screen.getByTestId('cal-notice')
/** Another injection of sheet 5 (fixture case 20). */
const copySheet = (over: Partial<CalSheet>) => {
  const c20 = fixtureCase(20)
  return makeSheet(c20.inputs as CalReplicateInputs, {
    effective_inputs: c20.replicate_of as CalInputs,
    ...over,
  })
}

describe('Task 7: File, Duplicate and New', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetCalSaves()
    vi.mocked(getPeptides).mockResolvedValue([])
    vi.mocked(getInstruments).mockResolvedValue([])
    vi.mocked(listCalSheets).mockResolvedValue([])
  })
  afterEach(() => {
    vi.useRealTimers()
    act(() => useUIStore.setState({ calibrationSheetPageId: null }))
  })

  it('File curve is disabled with the reason while the sheet has a blocking warning', async () => {
    vi.mocked(getCalSheet).mockResolvedValue(
      makeSheet(fixtureCase(8).inputs as CalInputs)
    )
    renderSheet()
    await screen.findByText('Curve name:', { exact: false })
    const blockingLine = screen
      .getByTestId('warnings')
      .querySelector('li.font-medium') as HTMLElement
    const text = blockingLine.textContent?.replace(
      'Must be fixed before filing',
      ''
    )
    expect(text).toBeTruthy()
    expect(fileBtn()).toBeDisabled()
    expect(why(fileBtn())).toContain(text)
    expect(dupBtn()).toBeDisabled()
    expect(why(dupBtn())).toContain(text)
    // the help is there too, from the source's tooltip
    expect(why(fileBtn())).toContain(
      'Saves this worksheet as the curve, under its curve name. Filing again updates it.'
    )
  })

  it('File curve is disabled until a compound and an instrument are picked', async () => {
    await openCase1({ peptide_id: null, instrument_id: null })
    expect(fileBtn()).toBeDisabled()
    expect(why(fileBtn())).toContain(
      'Pick the compound first. The curve is filed under it.'
    )
    expect(why(fileBtn())).toContain(
      'Pick the instrument. A curve belongs to the instrument that ran it.'
    )
  })

  it('rule 1: File and Duplicate wait while saving, after a failed save, and while a box holds a refused value', async () => {
    const saves = queueSaves()
    const { sheet } = await openCase1()
    expect(fileBtn()).not.toBeDisabled()
    typeAndLeave(box('Weight from COA (mg)'), '6')
    await waitFor(() => expect(saves.count()).toBe(1))
    expect(fileBtn()).toBeDisabled()
    expect(dupBtn()).toBeDisabled()
    expect(why(fileBtn())).toContain('Still saving.')
    await saves.fail(0, new CalSheetError('refused', 400))
    await waitFor(() => expect(why(fileBtn())).toContain('Not saved yet'))
    expect(fileBtn()).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(saves.count()).toBe(2))
    await saves.ok(1, { ...sheet, version: 2, inputs: inputsOf(1) })
    await waitFor(() => expect(fileBtn()).not.toBeDisabled())
    typeAndLeave(box('Water, Karl Fischer (%)'), '100')
    expect(fileBtn()).toBeDisabled()
    expect(why(fileBtn())).toContain(
      'A box holds a value that was not accepted: Water, Karl Fischer (%).'
    )
    expect(saves.count()).toBe(2)
  })

  it('rule 6: a sheet that cannot be worked out keeps File and Duplicate off', async () => {
    await openCase1({ blocking: ['cannot_be_worked_out'] })
    expect(fileBtn()).toBeDisabled()
    expect(dupBtn()).toBeDisabled()
    expect(why(fileBtn())).toContain(
      'These numbers cannot be worked out as stored, so nothing can be filed from them.'
    )
  })

  it.each<[Reason, Partial<CalFileResult>, string]>([
    ['first_active', {}, `Filed ${NAME}, now the active curve on 1290C.`],
    [
      'replaced',
      {},
      `Filed ${NAME}. It replaces curve 61 as the active curve on 1290C.`,
    ],
    [
      'several_active',
      {},
      `Filed ${NAME}, not starred: 1290C already has 2 active curves for this peptide (81, 90). The lab has to choose which stays first: press Set Active on that one on the Peptides page.`,
    ],
    [
      'replicate',
      {},
      `Filed ${NAME}, another injection of the same vials. To use it, press Set Active on its curve on the Peptides page.`,
    ],
    [
      'poor_fit',
      {},
      `Filed ${NAME}, not made active: no curve on 1290C was switched on or off.`,
    ],
    [
      'refiled',
      { refiled_curve_ids: [71, 72] },
      `Updated ${NAME} and its 2 injections. It is still the active curve on 1290C.`,
    ],
  ])(
    'says what filing did to the active curve: %s',
    async (reason, over, said) => {
      const { sheet } = await openCase1()
      const res = filedAs(sheet, reason, over, reason !== 'poor_fit')
      if (reason === 'replaced') res.activation.deactivated_ids = [61]
      if (reason === 'several_active' || reason === 'poor_fit')
        res.activation.other_active_ids = [81, 90]
      if (reason === 'several_active' || reason === 'poor_fit')
        res.activation.active = false
      if (reason === 'replicate') res.activation.active = false
      vi.mocked(fileCalSheet).mockResolvedValue(res)
      fireEvent.click(fileBtn())
      await waitFor(() => expect(notice().textContent).toContain(said))
      expect(fileCalSheet).toHaveBeenCalledWith(5, 1)
    }
  )

  it('a refiled curve that is not active says so, with one injection', async () => {
    const { sheet } = await openCase1({ curve_id: 70, curve_name: NAME })
    vi.mocked(fileCalSheet).mockResolvedValue(
      filedAs(sheet, 'refiled', { refiled_curve_ids: [71] }, false)
    )
    fireEvent.click(fileBtn())
    await waitFor(() =>
      expect(notice().textContent).toContain(
        `Updated ${NAME} and its 1 injection. It is still not the active curve on 1290C.`
      )
    )
  })

  it('every warning the server sends stays on the page, one per line, until dismissed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { sheet } = await openCase1()
    const warnings = [
      'R squared is 0.9898, below 0.99, so this curve was filed but not made active. Check the peak areas against their levels. If the curve is right, star it on the Peptides page.',
      "This curve is filed with a diluent density of 1000 mg/mL. The prep worksheet works with its method's density (997.1 unless the method sets another) and refuses to promote a prep while the curve's differs.",
    ]
    vi.mocked(fileCalSheet).mockResolvedValue(
      filedAs(sheet, 'poor_fit', { warnings }, false)
    )
    fireEvent.click(fileBtn())
    await waitFor(() =>
      expect(within(notice()).getByText(warnings[0] as string)).toBeTruthy()
    )
    expect(within(notice()).getByText(warnings[1] as string).tagName).toBe('LI')
    // no timer takes it away: well past a toast's five seconds
    await later(6_000)
    expect(within(notice()).getByText(warnings[0] as string)).toBeTruthy()
    expect(within(notice()).getByText(warnings[1] as string)).toBeTruthy()
    fireEvent.click(within(notice()).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('cal-notice')).toBeNull()
  })

  it('shows the server sentence on a 409 for a curve that analyses used, and reads the sheet again', async () => {
    await openCase1({ curve_id: 70, curve_name: NAME })
    const said = `Curve ${NAME} has been used by 2 analyses and 0 prep sessions, so its numbers are part of their record. Start a new worksheet to file a corrected curve.`
    vi.mocked(fileCalSheet).mockRejectedValue(new CalSheetError(said, 409))
    const reads = vi.mocked(getCalSheet).mock.calls.length
    fireEvent.click(fileBtn())
    await waitFor(() => expect(notice().textContent).toContain(said))
    expect(notice().getAttribute('role')).toBe('alert')
    await waitFor(() =>
      expect(vi.mocked(getCalSheet).mock.calls.length).toBeGreaterThan(reads)
    )
  })

  it('rule 2: File sends the version the hook holds, not a lagging query copy', async () => {
    const saves = queueSaves()
    const { sheet, view } = await openCase1()
    typeAndLeave(box('Lot #'), 'L2')
    await waitFor(() => expect(saves.count()).toBe(1))
    await saves.ok(0, { ...sheet, version: 2, inputs: inputsOf(0) })
    await waitFor(() => expect(fileBtn()).not.toBeDisabled())
    // a lagging copy in the cache (an older refetch landing late)
    act(() => view.qc.setQueryData(CAL_SHEET_KEY(5), sheet))
    // react-query notifies on a setTimeout(0): let the page re-render with it
    await flush()
    expect((view.qc.getQueryData(CAL_SHEET_KEY(5)) as CalSheet).version).toBe(1)
    vi.mocked(fileCalSheet).mockResolvedValue(
      filedAs({ ...sheet, version: 2 }, 'first_active')
    )
    fireEvent.click(fileBtn())
    await waitFor(() => expect(fileCalSheet).toHaveBeenCalledWith(5, 2))
  })

  it('rule 3 and 4: one filing at a time, then the pickers lock and focus comes back', async () => {
    const { sheet } = await openCase1()
    let answer: (r: CalFileResult) => void = () => undefined
    vi.mocked(fileCalSheet).mockImplementation(
      () =>
        new Promise<CalFileResult>(r => {
          answer = r
        })
    )
    const btn = fileBtn()
    btn.focus()
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(fileCalSheet).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Filing...' })).toBeDisabled()
    )
    expect(dupBtn()).toBeDisabled()
    expect(why(dupBtn())).toContain('Filing...')
    await act(async () => answer(filedAs(sheet, 'first_active')))
    await waitFor(() =>
      expect(screen.getByLabelText('Instrument')).toBeDisabled()
    )
    expect(screen.queryByText(RELOADED)).toBeNull()
    expect(page().dataset.saved).toBe('true')
    expect(document.activeElement).toBe(fileBtn())
    expect(fileCalSheet).toHaveBeenCalledTimes(1)
  })

  it('Duplicate files first when there are unfiled changes, then opens the copy', async () => {
    const { sheet } = await openCase1({
      curve_id: 70,
      curve_name: NAME,
      changed_since_filed: true,
    })
    vi.mocked(fileCalSheet).mockResolvedValue(filedAs(sheet, 'refiled'))
    const copy = copySheet({
      id: 9,
      replicate_of_sheet_id: 5,
      replicate_of_name: NAME,
      proposed_name: `${NAME}-Inj2`,
    })
    vi.mocked(duplicateCalSheet).mockResolvedValue(copy)
    vi.mocked(getCalSheet).mockImplementation(async id =>
      id === 9 ? copy : sheet
    )
    fireEvent.click(dupBtn())
    await waitFor(() =>
      expect(useUIStore.getState().calibrationSheetPageId).toBe(9)
    )
    expect(fileCalSheet).toHaveBeenCalledWith(5, 1)
    expect(duplicateCalSheet).toHaveBeenCalledWith(5)
    expect(vi.mocked(fileCalSheet).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(duplicateCalSheet).mock.invocationCallOrder[0] ?? 0
    )
    await waitFor(() =>
      expect(notice().textContent).toContain(`Updated ${NAME}.`)
    )
    expect(notice().textContent).toContain(
      `Opened a copy of ${NAME}: the same vials. Choose its Instrument (it files as ${NAME}-Inj2 on the 1290C), type its peak areas in Step 4, then File curve.`
    )
  })

  it('Duplicate on a filed sheet with no changes does not file again', async () => {
    const { sheet } = await openCase1({ curve_id: 70, curve_name: NAME })
    vi.mocked(duplicateCalSheet).mockResolvedValue(
      copySheet({
        id: 9,
        replicate_of_sheet_id: 5,
      })
    )
    vi.mocked(getCalSheet).mockResolvedValue(sheet)
    fireEvent.click(dupBtn())
    await waitFor(() =>
      expect(useUIStore.getState().calibrationSheetPageId).toBe(9)
    )
    expect(fileCalSheet).not.toHaveBeenCalled()
  })

  it('Duplicate on a never-filed draft files it first, and stops with the reason if filing is refused', async () => {
    await openCase1()
    const said =
      'Type the peak areas of at least two levels first. The sheet is saved; file it once they are in.'
    vi.mocked(fileCalSheet).mockRejectedValue(new CalSheetError(said, 400))
    fireEvent.click(dupBtn())
    await waitFor(() => expect(notice().textContent).toContain(said))
    expect(fileCalSheet).toHaveBeenCalledWith(5, 1)
    expect(duplicateCalSheet).not.toHaveBeenCalled()
    expect(useUIStore.getState().calibrationSheetPageId).toBe(5)
  })

  it('rule 5: Duplicate still opens the copy after a poor fit, with the filing message and warnings', async () => {
    const { sheet } = await openCase1()
    const warning =
      'R squared is 0.9898, below 0.99, so this curve was filed but not made active. Check the peak areas against their levels. If the curve is right, star it on the Peptides page.'
    vi.mocked(fileCalSheet).mockResolvedValue(
      filedAs(sheet, 'poor_fit', { warnings: [warning] }, false)
    )
    const copy = copySheet({
      id: 9,
      replicate_of_sheet_id: 5,
      replicate_of_name: NAME,
    })
    vi.mocked(duplicateCalSheet).mockResolvedValue(copy)
    vi.mocked(getCalSheet).mockImplementation(async id =>
      id === 9 ? copy : sheet
    )
    fireEvent.click(dupBtn())
    await waitFor(() =>
      expect(useUIStore.getState().calibrationSheetPageId).toBe(9)
    )
    await waitFor(() =>
      expect(notice().textContent).toContain(`Filed ${NAME}, not made active`)
    )
    expect(within(notice()).getByText(warning)).toBeTruthy()
  })

  it('New asks twice', async () => {
    await openCase1()
    vi.useFakeTimers()
    const first = screen.getByRole('button', {
      name: 'New calibration worksheet',
    })
    fireEvent.click(first)
    expect(
      screen.getByRole('button', { name: 'Start a blank one? Click again' })
    ).toBe(first)
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(first).toHaveAccessibleName('New calibration worksheet')
    expect(createCalSheet).not.toHaveBeenCalled()
    vi.useRealTimers()
    vi.mocked(createCalSheet).mockResolvedValue(
      makeSheet(fixtureCase(21).inputs as CalInputs, { id: 12 })
    )
    fireEvent.click(first)
    fireEvent.click(first)
    await waitFor(() =>
      expect(useUIStore.getState().calibrationSheetPageId).toBe(12)
    )
    expect(createCalSheet).toHaveBeenCalledTimes(1)
  })
})

// --- H1 (task-6 re-review, Critical 1): a same-version answer never forgets a
// save still in the air (probes J3 hazard and J3 silent, now as tests) ---

describe('H1: a save that changes nothing does not forget one that can still land', () => {
  const saved = () => page().dataset.saved
  const checking = () =>
    screen.queryByText('Checking that the last save went through...')
  const stale409 = () =>
    new CalSheetError(
      'Someone else saved this sheet. It has been reloaded.',
      409
    )

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

  /** Steps 1 to 3: A (weight 6) times out on v1; the weight is typed back,
   *  and that no-op save is answered on v1. A may still land. */
  async function noOpAfterTimeout() {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const saves = queueSaves()
    const { sheet, view } = await openCase1()
    const base = sheet.inputs as CalInputs
    const w0 = String(base.coa_weight_mg)
    typeAndLeave(box('Weight from COA (mg)'), '6') // A on v1
    await waitFor(() => expect(saves.count()).toBe(1))
    await later(SAVE_TIMEOUT_MS + 10) // A unanswered
    typeAndLeave(box('Weight from COA (mg)'), w0) // X0 on v1
    await waitFor(() => expect(saves.count()).toBe(2))
    expect(body(1).version).toBe(1)
    await saves.ok(1, sheet) // the server had not seen A: a no-op on v1
    return { saves, sheet, base, w0, view }
  }

  it('the four steps leave saved false and the checking line up', async () => {
    const { w0 } = await noOpAfterTimeout()
    await waitFor(() => expect(checking()).not.toBeNull())
    expect(saved()).toBe('false')
    expect(box('Weight from COA (mg)').value).toBe(w0)
    expect(fileBtn()).toBeDisabled()
    expect(why(fileBtn())).toContain(
      'Checking that the last save went through.'
    )
  })

  it("J3 hazard: the next edit meets A on v2, which is read as the page's own", async () => {
    const { saves, base, w0 } = await noOpAfterTimeout()
    typeAndLeave(box('Lot #'), 'L9') // next edit, on v1
    await waitFor(() => expect(saves.count()).toBe(3))
    vi.mocked(getCalSheet).mockResolvedValue(
      makeSheet({ ...base, coa_weight_mg: 6 }, { version: 2 })
    )
    await saves.fail(2, stale409())
    await waitFor(() => expect(saves.count()).toBe(4))
    expect(screen.queryByText(RELOADED)).toBeNull()
    expect(box('Lot #').value).toBe('L9')
    expect(box('Weight from COA (mg)').value).toBe(w0)
    expect(body(3).version).toBe(2)
    expect(inputsOf(3).lot).toBe('L9')
    expect(String(inputsOf(3).coa_weight_mg)).toBe(w0)
  })

  it("J3 silent: A arriving through a refetch is the page's own; the typed-back value is kept and sent on v2", async () => {
    const { saves, base, w0, view } = await noOpAfterTimeout()
    act(() =>
      view.qc.setQueryData(
        CAL_SHEET_KEY(5),
        makeSheet({ ...base, coa_weight_mg: 6 }, { version: 2 })
      )
    )
    await waitFor(() => expect(saves.count()).toBe(3))
    expect(box('Weight from COA (mg)').value).toBe(w0)
    expect(screen.queryByText(RELOADED)).toBeNull()
    expect(body(2).version).toBe(2)
    expect(String(inputsOf(2).coa_weight_mg)).toBe(w0)
    await saves.ok(2, makeSheet({ ...base }, { version: 3 }))
    await waitFor(() => expect(saved()).toBe('true'))
    expect(checking()).toBeNull()
  })

  it('the re-read finds A landed: the same, with no refetch from elsewhere', async () => {
    const { saves, base, w0 } = await noOpAfterTimeout()
    vi.mocked(getCalSheet).mockResolvedValue(
      makeSheet({ ...base, coa_weight_mg: 6 }, { version: 2 })
    )
    await later(5_000 + 10)
    await waitFor(() => expect(saves.count()).toBe(3))
    expect(body(2).version).toBe(2)
    expect(String(inputsOf(2).coa_weight_mg)).toBe(w0)
    expect(screen.queryByText(RELOADED)).toBeNull()
  })

  it('nothing lands: 60 seconds after A was sent the list is cleared and the sheet reads saved', async () => {
    await noOpAfterTimeout()
    const reads = vi.mocked(getCalSheet).mock.calls.length
    await later(10_000)
    expect(vi.mocked(getCalSheet).mock.calls.length).toBeGreaterThan(reads)
    expect(saved()).toBe('false')
    await later(40_000)
    await waitFor(() => expect(saved()).toBe('true'))
    expect(checking()).toBeNull()
  })

  it('a real foreign save arriving through a refetch gets the reload line', async () => {
    const { base, view } = await noOpAfterTimeout()
    act(() =>
      view.qc.setQueryData(
        CAL_SHEET_KEY(5),
        makeSheet(
          { ...base, coa_weight_mg: 6, analyst: 'OTHER' },
          { version: 2 }
        )
      )
    )
    expect(await screen.findByText(RELOADED)).toBeInTheDocument()
    expect(box('Weight from COA (mg)').value).toBe('6')
  })

  it('a foreign save reaching a saved page is still announced, and its values shown', async () => {
    const { sheet, view } = await openCase1()
    expect(saved()).toBe('true')
    act(() =>
      view.qc.setQueryData(
        CAL_SHEET_KEY(5),
        makeSheet(
          { ...(sheet.inputs as CalInputs), coa_weight_mg: 9 },
          { version: 2 }
        )
      )
    )
    expect(await screen.findByText(RELOADED_NOTHING_LOST)).toBeInTheDocument()
    expect(box('Weight from COA (mg)').value).toBe('9')
    expect(screen.queryByText(RELOADED)).toBeNull()
    expect(saved()).toBe('true')
  })
  it('leaving and coming back with a save in the air keeps the entry', async () => {
    const { w0 } = await noOpAfterTimeout()
    act(() => useUIStore.setState({ calibrationSheetPageId: null }))
    act(() => useUIStore.setState({ calibrationSheetPageId: 5 }))
    expect(screen.queryByText('Loading the sheet...')).toBeNull()
    expect(box('Weight from COA (mg)').value).toBe(w0)
    expect(saved()).toBe('false')
  })
})

// --- Task 7, fix round 1 (task-7-fix1-brief.md) ---

describe('fix round 1: the save hook (I1, I2, M2, M7)', () => {
  const saved = () => page().dataset.saved
  const checking = () =>
    screen.queryByText('Checking that the last save went through...')
  const stale409 = () =>
    new CalSheetError(
      'Someone else saved this sheet. It has been reloaded.',
      409
    )
  const noLine = () => {
    expect(screen.queryByText(RELOADED)).toBeNull()
    expect(screen.queryByText(RELOADED_NOTHING_LOST)).toBeNull()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetCalSaves()
    vi.mocked(getPeptides).mockResolvedValue([])
    vi.mocked(getInstruments).mockResolvedValue([])
    vi.mocked(listCalSheets).mockResolvedValue([])
  })
  afterEach(() => {
    vi.useRealTimers()
    act(() => useUIStore.setState({ calibrationSheetPageId: null }))
  })

  it('I1 (probe R1): an edit typed after the 60 s clear survives the late landing of the cleared save', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const saves = queueSaves()
    const { sheet } = await openCase1()
    const base = sheet.inputs as CalInputs
    typeAndLeave(box('Weight from COA (mg)'), '6') // A on v1
    await waitFor(() => expect(saves.count()).toBe(1))
    await later(SAVE_TIMEOUT_MS + 10)
    await waitFor(() => expect(checking()).not.toBeNull())
    await later(50_000) // past 60 s after A went out: A is cleared as lost
    await waitFor(() => expect(checking()).toBeNull())
    expect(saved()).toBe('false') // the Not saved line stays: A is still typed
    // A lands now, as v2
    vi.mocked(getCalSheet).mockResolvedValue(
      makeSheet({ ...base, coa_weight_mg: 6 }, { version: 2 })
    )
    typeAndLeave(box('Lot #'), 'C9') // A and C9, on v1
    await waitFor(() => expect(saves.count()).toBe(2))
    expect(body(1).version).toBe(1)
    await saves.fail(1, stale409())
    // the 409's re-read finds A: the page's own, so C9 goes again on v2
    await waitFor(() => expect(saves.count()).toBe(3))
    expect(body(2).version).toBe(2)
    expect(inputsOf(2).lot).toBe('C9')
    expect(String(inputsOf(2).coa_weight_mg)).toBe('6')
    expect(box('Lot #').value).toBe('C9')
    noLine()
    await saves.ok(
      2,
      makeSheet({ ...base, coa_weight_mg: 6, lot: 'C9' }, { version: 3 })
    )
    await waitFor(() => expect(saved()).toBe('true'))
    noLine()
  })

  it('I2 (probe R6): with 12 s re-reads, a save landing at second 55 is the page own, and re-reads never overlap', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const saves = queueSaves()
    const { sheet } = await openCase1()
    const base = sheet.inputs as CalInputs
    const t0 = Date.now()
    typeAndLeave(box('Weight from COA (mg)'), '6') // A on v1
    await waitFor(() => expect(saves.count()).toBe(1))
    const landed = makeSheet({ ...base, coa_weight_mg: 6 }, { version: 2 })
    let out = 0
    let most = 0
    vi.mocked(getCalSheet).mockImplementation(() => {
      const copy = Date.now() - t0 >= 55_000 ? landed : sheet
      most = Math.max(most, ++out)
      return new Promise(r =>
        setTimeout(() => {
          out--
          r(copy)
        }, 12_000)
      )
    })
    await later(SAVE_TIMEOUT_MS + 10)
    for (let i = 0; i < 20; i++) await later(5_000)
    expect(most).toBe(1)
    expect(checking()).toBeNull()
    expect(saved()).toBe('true')
    noLine()
    expect(box('Weight from COA (mg)').value).toBe('6')
    expect(saves.count()).toBe(1) // A landed: nothing to send again
  })

  // M2, RULED (fix round 1): accepted, not fixed. Someone else reverting the
  // sheet to exactly the page's confirmed inputs, while a body of this page is
  // unanswered, is taken as the page's own: no line, and what is on this page
  // is sent over the revert.
  it('M2 (probe R5, ruled): a revert equal to the confirmed inputs is taken as own, and A is sent again over it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const saves = queueSaves()
    const { sheet } = await openCase1()
    typeAndLeave(box('Weight from COA (mg)'), '6') // A
    await waitFor(() => expect(saves.count()).toBe(1))
    await later(SAVE_TIMEOUT_MS + 10)
    vi.mocked(getCalSheet).mockResolvedValue({ ...sheet, version: 3 })
    await later(5_010)
    await waitFor(() => expect(saves.count()).toBe(2))
    expect(body(1).version).toBe(3)
    expect(String(inputsOf(1).coa_weight_mg)).toBe('6')
    noLine()
  })

  // RULED, documented: a save by someone else whose values equal a body this
  // page sent and never heard back about cannot be told from that body
  // landing, so it is taken as the page's own.
  it('a foreign save equal to an unanswered body is taken as own (ruled)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const saves = queueSaves()
    const { sheet, view } = await openCase1()
    const base = sheet.inputs as CalInputs
    typeAndLeave(box('Weight from COA (mg)'), '6') // A, never answered
    await waitFor(() => expect(saves.count()).toBe(1))
    await later(SAVE_TIMEOUT_MS + 10)
    act(() =>
      view.qc.setQueryData(
        CAL_SHEET_KEY(5),
        makeSheet({ ...base, coa_weight_mg: 6 }, { version: 2 })
      )
    )
    await waitFor(() => expect(saved()).toBe('true'))
    noLine()
    expect(box('Weight from COA (mg)').value).toBe('6')
    expect(saves.count()).toBe(1)
  })

  it('probe R3: no re-reads while the page is closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const saves = queueSaves()
    await openCase1()
    typeAndLeave(box('Weight from COA (mg)'), '6')
    await waitFor(() => expect(saves.count()).toBe(1))
    await later(SAVE_TIMEOUT_MS + 10)
    await waitFor(() => expect(checking()).not.toBeNull())
    act(() => useUIStore.setState({ calibrationSheetPageId: null }))
    const n = vi.mocked(getCalSheet).mock.calls.length
    await later(30_000)
    expect(vi.mocked(getCalSheet).mock.calls.length).toBe(n)
  })

  it('probe R4: A then B time out on v1, B lands: own, kept, saved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const saves = queueSaves()
    const { sheet } = await openCase1()
    const base = sheet.inputs as CalInputs
    typeAndLeave(box('Weight from COA (mg)'), '6') // A
    await waitFor(() => expect(saves.count()).toBe(1))
    await later(SAVE_TIMEOUT_MS + 10)
    typeAndLeave(box('Lot #'), 'B1') // B = A and the lot, on v1
    await waitFor(() => expect(saves.count()).toBe(2))
    expect(body(1).version).toBe(1)
    await later(SAVE_TIMEOUT_MS + 10)
    vi.mocked(getCalSheet).mockResolvedValue(
      makeSheet({ ...base, coa_weight_mg: 6, lot: 'B1' }, { version: 2 })
    )
    await later(5_010)
    await waitFor(() => expect(saved()).toBe('true'))
    noLine()
    expect(box('Lot #').value).toBe('B1')
    expect(saves.count()).toBe(2)
  })

  it('the 60 s clock counts from the newest unanswered body', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const saves = queueSaves()
    await openCase1()
    typeAndLeave(box('Weight from COA (mg)'), '6') // A at 0 s
    await waitFor(() => expect(saves.count()).toBe(1))
    await later(SAVE_TIMEOUT_MS + 10)
    await later(20_000)
    typeAndLeave(box('Lot #'), 'B1') // B at about 35 s
    await waitFor(() => expect(saves.count()).toBe(2))
    await later(SAVE_TIMEOUT_MS + 10)
    await later(20_000) // about 70 s: past A's 60, not B's
    expect(checking()).not.toBeNull()
    await later(30_000) // about 100 s: past B's 60
    await waitFor(() => expect(checking()).toBeNull())
  })

  it('no re-read while a save is out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const saves = queueSaves()
    await openCase1()
    typeAndLeave(box('Weight from COA (mg)'), '6') // A, unanswered
    await waitFor(() => expect(saves.count()).toBe(1))
    await later(SAVE_TIMEOUT_MS + 10)
    await waitFor(() => expect(checking()).not.toBeNull())
    typeAndLeave(box('Lot #'), 'B1') // B goes out
    await waitFor(() => expect(saves.count()).toBe(2))
    const n = vi.mocked(getCalSheet).mock.calls.length
    await later(12_000) // B is still out (15 s)
    expect(vi.mocked(getCalSheet).mock.calls.length).toBe(n)
    expect(checking()).toBeNull()
  })
})

describe('fix round 1: File, Duplicate and New (M1, M3, M4)', () => {
  const saved = () => page().dataset.saved
  const newBtn = () =>
    screen.getByRole('button', {
      name: /^(New calibration worksheet|Start a blank one\? Click again|Opening a new one\.\.\.)$/,
    })
  const FILE_NO_ANSWER =
    'File curve: the server did not answer, so the curve may or may not have been filed. This page has read the sheet again once: a Filed mark beside the curve name means it was. Pressing File curve again is safe: it files the sheet if it was not filed, and updates the same curve if it was.'
  const DUP_NO_ANSWER =
    'Duplicate: the server did not answer, so the copy may have been made. Look under Calibration worksheets before trying again.'
  const NEW_NO_ANSWER =
    'New calibration worksheet: the server did not answer, so it may have been made. Look under Calibration worksheets before trying again.'

  beforeEach(() => {
    vi.clearAllMocks()
    resetCalSaves()
    vi.mocked(getPeptides).mockResolvedValue([])
    vi.mocked(getInstruments).mockResolvedValue([])
    vi.mocked(listCalSheets).mockResolvedValue([])
  })
  afterEach(() => {
    vi.useRealTimers()
    act(() => useUIStore.setState({ calibrationSheetPageId: null }))
  })

  /** Filed on v1; a save makes it v2 with changes since filing; then an
   *  older refetch puts the filed, unchanged v1 back in the cache. */
  async function laggingCopy() {
    const saves = queueSaves()
    const { sheet, view } = await openCase1({ curve_id: 70, curve_name: NAME })
    typeAndLeave(box('Lot #'), 'L2')
    await waitFor(() => expect(saves.count()).toBe(1))
    const v2: CalSheet = {
      ...sheet,
      version: 2,
      inputs: inputsOf(0),
      changed_since_filed: true,
    }
    await saves.ok(0, v2)
    await waitFor(() => expect(saved()).toBe('true'))
    act(() => view.qc.setQueryData(CAL_SHEET_KEY(5), sheet))
    await flush()
    expect(
      (view.qc.getQueryData(CAL_SHEET_KEY(5)) as CalSheet).changed_since_filed
    ).toBe(false)
    return { sheet, v2, view }
  }

  it('M1 (probe R2): Duplicate reads a lagging copy again and files first when the fresh one changed since filing', async () => {
    const { v2 } = await laggingCopy()
    const copy = copySheet({ id: 9, replicate_of_sheet_id: 5 })
    vi.mocked(getCalSheet).mockImplementation(async id =>
      id === 9 ? copy : v2
    )
    vi.mocked(fileCalSheet).mockResolvedValue(filedAs(v2, 'refiled'))
    vi.mocked(duplicateCalSheet).mockResolvedValue(copy)
    const reads = vi.mocked(getCalSheet).mock.calls.length
    fireEvent.click(dupBtn())
    await waitFor(() =>
      expect(useUIStore.getState().calibrationSheetPageId).toBe(9)
    )
    expect(vi.mocked(getCalSheet).mock.calls[reads]?.[0]).toBe(5)
    expect(fileCalSheet).toHaveBeenCalledWith(5, 2)
    expect(vi.mocked(fileCalSheet).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(duplicateCalSheet).mock.invocationCallOrder[0] ?? 0
    )
  })

  it('M1: when the fresh copy still differs from the version held, Duplicate stops and asks to try again', async () => {
    const { v2 } = await laggingCopy()
    vi.mocked(getCalSheet).mockResolvedValue({ ...v2, version: 3 })
    fireEvent.click(dupBtn())
    await waitFor(() =>
      expect(notice().textContent).toContain(
        'Duplicate did not go: this sheet was saved again since the page last read it. Check it and try again.'
      )
    )
    expect(fileCalSheet).not.toHaveBeenCalled()
    expect(duplicateCalSheet).not.toHaveBeenCalled()
    expect(useUIStore.getState().calibrationSheetPageId).toBe(5)
    await waitFor(() => expect(document.activeElement).toBe(dupBtn()))
  })

  it('M3: a File with no answer in 15 s says so and reads the sheet again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await openCase1()
    vi.mocked(fileCalSheet).mockImplementation(
      () => new Promise(() => undefined)
    )
    const reads = vi.mocked(getCalSheet).mock.calls.length
    fireEvent.click(fileBtn())
    await later(SAVE_TIMEOUT_MS + 10)
    await waitFor(() => expect(notice().textContent).toContain(FILE_NO_ANSWER))
    await waitFor(() =>
      expect(vi.mocked(getCalSheet).mock.calls.length).toBeGreaterThan(reads)
    )
    await waitFor(() => expect(document.activeElement).toBe(fileBtn()))
  })

  it('M3: a File answered with a 502 is no answer, never the raw status', async () => {
    await openCase1()
    vi.mocked(fileCalSheet).mockRejectedValue(
      new CalSheetError('File curve failed: 502', 502)
    )
    const reads = vi.mocked(getCalSheet).mock.calls.length
    fireEvent.click(fileBtn())
    await waitFor(() => expect(notice().textContent).toContain(FILE_NO_ANSWER))
    expect(notice().textContent).not.toContain('502')
    await waitFor(() =>
      expect(vi.mocked(getCalSheet).mock.calls.length).toBeGreaterThan(reads)
    )
  })

  it('M3 and M4: a Duplicate answered with a 503 may have gone through; focus comes back to Duplicate', async () => {
    await openCase1({ curve_id: 70, curve_name: NAME })
    vi.mocked(duplicateCalSheet).mockRejectedValue(
      new CalSheetError('Duplicate calibration sheet failed: 503', 503)
    )
    fireEvent.click(dupBtn())
    await waitFor(() => expect(notice().textContent).toContain(DUP_NO_ANSWER))
    expect(notice().textContent).not.toContain('503')
    await waitFor(() => expect(document.activeElement).toBe(dupBtn()))
  })

  it('M3: a Duplicate with no answer in 15 s may have gone through', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await openCase1({ curve_id: 70, curve_name: NAME })
    vi.mocked(duplicateCalSheet).mockImplementation(
      () => new Promise(() => undefined)
    )
    fireEvent.click(dupBtn())
    await later(SAVE_TIMEOUT_MS + 10)
    await waitFor(() => expect(notice().textContent).toContain(DUP_NO_ANSWER))
  })

  it('M4: a refused Duplicate puts focus back on Duplicate', async () => {
    await openCase1()
    vi.mocked(fileCalSheet).mockRejectedValue(
      new CalSheetError(
        'Type the peak areas of at least two levels first.',
        400
      )
    )
    fireEvent.click(dupBtn())
    await waitFor(() =>
      expect(notice().textContent).toContain('Type the peak areas')
    )
    await waitFor(() => expect(document.activeElement).toBe(dupBtn()))
  })

  it('M3 and M4: a New answered with a 500 may have gone through; focus comes back to New', async () => {
    await openCase1()
    vi.mocked(createCalSheet).mockRejectedValue(
      new CalSheetError('Create calibration sheet failed: 500', 500)
    )
    fireEvent.click(newBtn())
    fireEvent.click(newBtn())
    await waitFor(() => expect(notice().textContent).toContain(NEW_NO_ANSWER))
    expect(notice().textContent).not.toContain('500')
    await waitFor(() => expect(document.activeElement).toBe(newBtn()))
  })

  it('M3: a New with no answer in 15 s may have gone through', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await openCase1()
    vi.mocked(createCalSheet).mockImplementation(
      () => new Promise(() => undefined)
    )
    fireEvent.click(newBtn())
    fireEvent.click(newBtn())
    await later(SAVE_TIMEOUT_MS + 10)
    await waitFor(() => expect(notice().textContent).toContain(NEW_NO_ANSWER))
  })

  it('M4: a Duplicate that opens the copy puts focus on its notice', async () => {
    const { sheet } = await openCase1({ curve_id: 70, curve_name: NAME })
    const copy = copySheet({ id: 9, replicate_of_sheet_id: 5 })
    vi.mocked(duplicateCalSheet).mockResolvedValue(copy)
    vi.mocked(getCalSheet).mockImplementation(async id =>
      id === 9 ? copy : sheet
    )
    fireEvent.click(dupBtn())
    await waitFor(() =>
      expect(useUIStore.getState().calibrationSheetPageId).toBe(9)
    )
    await waitFor(() => expect(document.activeElement).toBe(notice()))
  })

  it('backend wave: an injection refused until its original is filed shows the sentence and links to the original', async () => {
    const said = `File the original worksheet, ${NAME}, first. Filing it also re-files its injections.`
    vi.mocked(getCalSheet).mockResolvedValue(
      copySheet({ id: 5, replicate_of_sheet_id: 4, replicate_of_name: NAME })
    )
    renderSheet()
    await screen.findByText('Curve name:', { exact: false })
    vi.mocked(fileCalSheet).mockRejectedValue(new CalSheetError(said, 409))
    fireEvent.click(fileBtn())
    await waitFor(() => expect(notice().textContent).toContain(said))
    const link = within(screen.getByTestId('replicate-note')).getByRole(
      'button',
      { name: `Open ${NAME}` }
    )
    fireEvent.click(link)
    expect(useUIStore.getState().calibrationSheetPageId).toBe(4)
  })

  it('fix round 2: a refused compound change puts the picker back, keeps the sentence, and saves the rest', async () => {
    const saves = queueSaves()
    vi.mocked(getPeptides).mockResolvedValue([
      { id: 11, name: 'Retatrutide', abbreviation: 'RETA' },
      { id: 12, name: 'BPC-157', abbreviation: 'BPC' },
    ] as Awaited<ReturnType<typeof getPeptides>>)
    const { sheet } = await openCase1()
    const base = sheet.inputs as CalInputs
    const said =
      'Injections duplicated from this sheet carry the same compound, so the compound cannot change here. Start a new calibration worksheet for the other compound.'
    const picker = () => screen.getByLabelText('Compound') as HTMLSelectElement
    await waitFor(() => expect(picker().options.length).toBeGreaterThan(2))
    typeAndLeave(box('Lot #'), 'L1') // save 0, held open
    await waitFor(() => expect(saves.count()).toBe(1))
    typeAndLeave(box('Weight from COA (mg)'), '6') // typed just before
    fireEvent.change(picker(), { target: { value: '12' } })
    const v2 = makeSheet({ ...base, lot: 'L1' }, { version: 2 })
    await saves.ok(0, v2)
    // save 1: the weight and the compound together, on v2
    await waitFor(() => expect(saves.count()).toBe(2))
    expect(body(1).peptide_id).toBe(12)
    expect(String(inputsOf(1).coa_weight_mg)).toBe('6')
    vi.mocked(getCalSheet).mockResolvedValue(v2) // the same version: refused
    await saves.fail(1, new CalSheetError(said, 409))
    // the picker is back on the stored compound; the weight goes on its own
    await waitFor(() => expect(saves.count()).toBe(3))
    expect(picker().value).toBe('11')
    expect(body(2).peptide_id).toBe(11)
    expect(body(2).version).toBe(2)
    expect(String(inputsOf(2).coa_weight_mg)).toBe('6')
    expect(box('Weight from COA (mg)').value).toBe('6')
    expect(screen.getByText(said)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    await saves.ok(
      2,
      makeSheet({ ...base, lot: 'L1', coa_weight_mg: 6 }, { version: 3 })
    )
    await waitFor(() => expect(fileBtn()).not.toBeDisabled())
    expect(page().dataset.saved).toBe('true')
    // the sentence outlives the revert and the save, until dismissed
    const line = screen.getByText(said).closest('[role="alert"]') as HTMLElement
    expect(screen.queryByText(RELOADED)).toBeNull()
    fireEvent.click(within(line).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(said)).toBeNull()
  })

  it('fix round 2: a refused typed box keeps its value and the Not saved line', async () => {
    const saves = queueSaves()
    await openCase1()
    typeAndLeave(box('Lot #'), 'BAD')
    await waitFor(() => expect(saves.count()).toBe(1))
    await saves.fail(0, new CalSheetError('Lot is too long.', 400))
    await waitFor(() =>
      expect(screen.getByTestId('save-line').textContent).toContain(
        'Lot is too long'
      )
    )
    expect(box('Lot #').value).toBe('BAD')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(fileBtn()).toBeDisabled()
  })
  it('backend wave: the curve deadlock 409 is shown and File stays on', async () => {
    await openCase1({ curve_id: 70, curve_name: NAME })
    const said =
      'Someone changed one of these curves at the same moment, so nothing was filed. Try again.'
    vi.mocked(fileCalSheet).mockRejectedValue(new CalSheetError(said, 409))
    fireEvent.click(fileBtn())
    await waitFor(() => expect(notice().textContent).toContain(said))
    await waitFor(() => expect(fileBtn()).not.toBeDisabled())
  })

  it('M4: a New that opens a sheet puts focus on its heading', async () => {
    await openCase1()
    const fresh = makeSheet(fixtureCase(21).inputs as CalInputs, { id: 12 })
    vi.mocked(createCalSheet).mockResolvedValue(fresh)
    vi.mocked(getCalSheet).mockResolvedValue(fresh)
    fireEvent.click(newBtn())
    fireEvent.click(newBtn())
    await waitFor(() =>
      expect(useUIStore.getState().calibrationSheetPageId).toBe(12)
    )
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Calibration Curve Worksheet' })
      )
    )
  })
})

describe('fix round 1: the changed-since-filed lines', () => {
  const CHANGED =
    'Changed since filed: the curve still has the numbers it was filed with. File curve updates it.'
  const ELSEWHERE =
    'The filed curve was changed on the Peptides page after this sheet was filed. Filing again replaces those changes.'

  beforeEach(() => {
    vi.clearAllMocks()
    resetCalSaves()
    vi.mocked(getPeptides).mockResolvedValue([])
    vi.mocked(getInstruments).mockResolvedValue([])
    vi.mocked(listCalSheets).mockResolvedValue([])
  })
  afterEach(() => {
    act(() => useUIStore.setState({ calibrationSheetPageId: null }))
  })

  it('a filed sheet changed since filing says so politely, until it is filed again', async () => {
    const { sheet } = await openCase1({
      curve_id: 70,
      curve_name: NAME,
      changed_since_filed: true,
    })
    const line = screen.getByText(CHANGED)
    expect(line.closest('[role="status"]')).not.toBeNull()
    vi.mocked(fileCalSheet).mockResolvedValue(filedAs(sheet, 'refiled'))
    fireEvent.click(fileBtn())
    await waitFor(() => expect(screen.queryByText(CHANGED)).toBeNull())
  })

  it('a draft, or a filed sheet with no changes, has no such line', async () => {
    await openCase1({ changed_since_filed: true })
    expect(screen.queryByText(CHANGED)).toBeNull()
    act(() => useUIStore.setState({ calibrationSheetPageId: null }))
    resetCalSaves()
    await openCase1({ curve_id: 70, curve_name: NAME })
    expect(screen.queryByText(CHANGED)).toBeNull()
    expect(screen.queryByText(ELSEWHERE)).toBeNull()
  })

  it('the line follows the save answer, not a lagging copy', async () => {
    const saves = queueSaves()
    const { sheet, view } = await openCase1({ curve_id: 70, curve_name: NAME })
    expect(screen.queryByText(CHANGED)).toBeNull()
    typeAndLeave(box('Lot #'), 'L2')
    await waitFor(() => expect(saves.count()).toBe(1))
    await saves.ok(0, {
      ...sheet,
      version: 2,
      inputs: inputsOf(0),
      changed_since_filed: true,
    })
    expect(await screen.findByText(CHANGED)).toBeInTheDocument()
    act(() => view.qc.setQueryData(CAL_SHEET_KEY(5), sheet))
    await flush()
    expect(screen.getByText(CHANGED)).toBeInTheDocument()
  })

  it('a curve changed on the Peptides page after filing says so politely, until filed again', async () => {
    const { sheet } = await openCase1({
      curve_id: 70,
      curve_name: NAME,
      curve_changed_since_filed: true,
    })
    const line = screen.getByText(ELSEWHERE)
    expect(line.closest('[role="status"]')).not.toBeNull()
    vi.mocked(fileCalSheet).mockResolvedValue(
      filedAs({ ...sheet, curve_changed_since_filed: false }, 'refiled')
    )
    fireEvent.click(fileBtn())
    await waitFor(() => expect(screen.queryByText(ELSEWHERE)).toBeNull())
  })

  it('only true counts: null leaves the line off', async () => {
    await openCase1({
      curve_id: 70,
      curve_name: NAME,
      curve_changed_since_filed: null,
    })
    expect(screen.queryByText(ELSEWHERE)).toBeNull()
  })
})
