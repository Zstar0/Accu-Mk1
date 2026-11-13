import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import type * as ApiModule from '@/lib/api'
import {
  CalSheetError,
  getCalSheet,
  getInstruments,
  getPeptides,
  saveCalSheet,
  type CalSheet,
  type CalSheetSave,
} from '@/lib/api'
import type { CalInputs, CalReplicateInputs } from '@/lib/hplc-calibration'
import {
  NO_ANSWER,
  RELOADED,
  SAVE_TIMEOUT_MS,
  resetCalSaves,
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
      '1000 ug/mL level, Peak Area'
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
