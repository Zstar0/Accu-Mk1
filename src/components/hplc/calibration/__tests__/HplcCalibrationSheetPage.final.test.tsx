// The final frontend fix wave: the whole-branch review (Part A) and the
// save hook re-review (Part B). The regression tests for I1, I2 and M3 run in
// the app-shaped wrapper (renderInApp): the page keyed on navigationKey, with
// the app's own query defaults.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import { queryClient as appQueryClient } from '@/lib/query-client'
import { HplcCalibrationSheetPage } from '../HplcCalibrationSheetPage'
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
  type CalSheetListItem,
  type CalSheetSave,
} from '@/lib/api'
import type { CalInputs, CalReplicateInputs } from '@/lib/hplc-calibration'
import {
  CAL_SHEET_KEY,
  RELOADED,
  RELOADED_NOTHING_LOST,
  SAVE_TIMEOUT_MS,
  resetCalSaves,
} from '@/services/hplc-calibration-sheets'
import { useUIStore } from '@/store/ui-store'
import {
  fixtureCase,
  makeSheet,
  renderInApp,
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

const NAME = '1290C-20260205-RETA'
const WARN = `Curve ${NAME} was changed on the Peptides page since it was filed, and filing replaced those changes: the points excluded there are back in the fit.`
const COPY_LINE = `Opened a copy of ${NAME}: the same vials. Choose its Instrument (it files as ${NAME}-Inj2 on the 1290C), type its peak areas in Step 4, then File curve.`
const PEPTIDES = [
  { id: 11, name: 'Retatrutide', abbreviation: 'RETA' },
  { id: 12, name: 'BPC-157', abbreviation: 'BPC' },
] as Awaited<ReturnType<typeof getPeptides>>

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

/** A promise the test answers by hand. */
function held<T>() {
  let resolve: (v: T) => void = () => undefined
  let reject: (e: Error) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const body = (n: number) =>
  vi.mocked(saveCalSheet).mock.calls[n]?.[1] as CalSheetSave
const inputsOf = (n: number) => body(n).inputs as CalInputs
const page = () =>
  screen.getByTestId('hplc-calibration-page').firstElementChild as HTMLElement
const saved = () => page().dataset.saved
const box = (l: string) => screen.getByLabelText(l) as HTMLInputElement
const picker = () => screen.getByLabelText('Compound') as HTMLSelectElement
const later = async (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const checking = () =>
  screen.queryByText('Checking that the last save went through...')
const stale409 = () =>
  new CalSheetError('Someone else saved this sheet. It has been reloaded.', 409)
const fileBtn = () =>
  screen.getByRole('button', { name: /^(File curve|Filing\.\.\.)$/ })
const dupBtn = () =>
  screen.getByRole('button', {
    name: /^(Duplicate for another injection|Duplicating\.\.\.)$/,
  })
const listLink = () =>
  screen.getByRole('button', { name: 'Calibration worksheets' })
const notice = () => screen.getByTestId('cal-notice')
const why = (b: HTMLElement) =>
  (b.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map(id => document.getElementById(id)?.textContent ?? '')
    .join(' ')
const filedMark = () =>
  screen.queryByRole('img', { name: 'Filed: this sheet is filed as a curve' })

function filedAs(
  sheet: CalSheet,
  reason: CalFileResult['activation']['reason'],
  over: Partial<CalFileResult> = {}
): CalFileResult {
  return {
    sheet: {
      ...sheet,
      curve_id: 70,
      curve_name: sheet.curve_name ?? NAME,
      curve_is_active: true,
      filed_at: '2026-11-13T10:00:00',
      changed_since_filed: false,
    },
    curve: { id: 70, source_filename: NAME } as CalibrationCurve,
    activation: {
      active: true,
      reason,
      deactivated_ids: [],
      other_active_ids: [],
    },
    refiled_curve_ids: [],
    warnings: [],
    ...over,
  }
}

/** Another injection of sheet 5 (fixture case 20). */
function copySheet(over: Partial<CalSheet> = {}) {
  const c20 = fixtureCase(20)
  return makeSheet(c20.inputs as CalReplicateInputs, {
    id: 9,
    effective_inputs: c20.replicate_of as CalInputs,
    replicate_of_sheet_id: 5,
    replicate_of_name: NAME,
    proposed_name: `${NAME}-Inj2`,
    ...over,
  })
}

function listRow(s: CalSheet): CalSheetListItem {
  const { inputs: _i, effective_inputs: _e, ...item } = s
  return item
}

async function openCase1(over: Partial<CalSheet> = {}) {
  const sheet = makeSheet(fixtureCase(1).inputs as CalInputs, over)
  vi.mocked(getCalSheet).mockResolvedValue(sheet)
  const view = renderSheet()
  await screen.findByText('Curve name:', { exact: false })
  return { sheet, view }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetCalSaves()
  vi.mocked(getPeptides).mockResolvedValue(PEPTIDES)
  vi.mocked(getInstruments).mockResolvedValue([])
  vi.mocked(listCalSheets).mockResolvedValue([])
})
afterEach(() => {
  vi.useRealTimers()
  act(() => useUIStore.setState({ calibrationSheetPageId: null }))
})

describe('Part A: in the app shell', () => {
  it('I1 (probe F1): Duplicate that files first keeps its message, the warning and the copy line on the copy, with focus on the notice', async () => {
    const sheet = makeSheet(fixtureCase(1).inputs as CalInputs, {
      curve_id: 70,
      curve_name: NAME,
      changed_since_filed: true,
    })
    const copy = copySheet()
    vi.mocked(fileCalSheet).mockResolvedValue(
      filedAs(sheet, 'refiled', { warnings: [WARN] })
    )
    vi.mocked(duplicateCalSheet).mockResolvedValue(copy)
    vi.mocked(getCalSheet).mockImplementation(async id =>
      id === 9 ? copy : sheet
    )
    renderInApp()
    await screen.findByText('Curve name:', { exact: false })
    fireEvent.click(dupBtn())
    await waitFor(() =>
      expect(useUIStore.getState().calibrationSheetPageId).toBe(9)
    )
    await screen.findByTestId('replicate-note')
    expect(fileCalSheet).toHaveBeenCalledTimes(1)
    const text = notice().textContent ?? ''
    expect(text).toContain(`Updated ${NAME}.`)
    expect(text).toContain(WARN)
    expect(text).toContain(COPY_LINE)
    await waitFor(() => expect(document.activeElement).toBe(notice()))
  })

  it('I2 (probe F3): back on an injection through the list after its original was filed, the sheet is read again and shows the corrected preparation before File', async () => {
    const original = makeSheet(fixtureCase(1).inputs as CalInputs, {
      curve_name: NAME,
    })
    const rep = copySheet()
    const corrected = structuredClone(rep.effective_inputs as CalInputs)
    corrected.stock = { ...(corrected.stock ?? {}), vial_mg: 1234.5 }
    let repNow = rep
    vi.mocked(getCalSheet).mockImplementation(async id =>
      id === 9 ? repNow : original
    )
    vi.mocked(listCalSheets).mockImplementation(async () => [
      listRow(repNow),
      listRow(original),
    ])
    renderInApp(9)
    await screen.findByTestId('replicate-note')
    const stock = () =>
      box('Stock, Stock Vial + cap (mg)').getAttribute('value') ?? ''
    expect(stock()).not.toBe('1234.5')
    // to the original, file it (the server re-files the injection)
    fireEvent.click(
      within(screen.getByTestId('replicate-note')).getByRole('button', {
        name: `Open ${NAME}`,
      })
    )
    await waitFor(() =>
      expect(screen.queryByTestId('replicate-note')).toBeNull()
    )
    await waitFor(() => expect(fileBtn()).not.toBeDisabled())
    vi.mocked(fileCalSheet).mockResolvedValue(filedAs(original, 'first_active'))
    repNow = { ...rep, effective_inputs: corrected }
    fireEvent.click(fileBtn())
    await waitFor(() => expect(notice().textContent).toContain('Filed'))
    // back through the list
    fireEvent.click(listLink())
    await screen.findByText(`${NAME}-Inj2`)
    const reads = vi
      .mocked(getCalSheet)
      .mock.calls.filter(([id]) => id === 9).length
    fireEvent.click(screen.getByRole('button', { name: `Open ${NAME}-Inj2` }))
    await screen.findByTestId('replicate-note')
    await waitFor(() => expect(stock()).toBe('1234.5'))
    expect(
      vi.mocked(getCalSheet).mock.calls.filter(([id]) => id === 9).length
    ).toBeGreaterThan(reads)
    expect(fileCalSheet).toHaveBeenCalledTimes(1)
  })

  it('I2: with nothing filed from this page, a sheet reopened through the list is read again (staleTime 0)', async () => {
    const rep = copySheet()
    const corrected = structuredClone(rep.effective_inputs as CalInputs)
    corrected.stock = { ...(corrected.stock ?? {}), vial_mg: 1234.5 }
    vi.mocked(getCalSheet).mockResolvedValue(rep)
    vi.mocked(listCalSheets).mockResolvedValue([listRow(rep)])
    renderInApp(9)
    await screen.findByTestId('replicate-note')
    const stock = () =>
      box('Stock, Stock Vial + cap (mg)').getAttribute('value') ?? ''
    expect(stock()).not.toBe('1234.5')
    // the original is corrected and filed elsewhere
    vi.mocked(getCalSheet).mockResolvedValue({
      ...rep,
      effective_inputs: corrected,
    })
    fireEvent.click(listLink())
    await screen.findByText(`${NAME}-Inj2`)
    fireEvent.click(screen.getByRole('button', { name: `Open ${NAME}-Inj2` }))
    await screen.findByTestId('replicate-note')
    await waitFor(() => expect(stock()).toBe('1234.5'))
  })

  it('I1: File, then Duplicate the filed sheet: the copy gets its own notice, the copy line', async () => {
    const sheet = makeSheet(fixtureCase(1).inputs as CalInputs)
    const filed = filedAs(sheet, 'first_active').sheet
    const copy = copySheet()
    vi.mocked(getCalSheet).mockImplementation(async id =>
      id === 9 ? copy : filed
    )
    vi.mocked(fileCalSheet).mockResolvedValue(filedAs(sheet, 'first_active'))
    vi.mocked(duplicateCalSheet).mockResolvedValue(copy)
    renderInApp()
    await screen.findByText('Curve name:', { exact: false })
    fireEvent.click(fileBtn())
    await waitFor(() => expect(notice().textContent).toContain('Filed'))
    await waitFor(() => expect(dupBtn()).not.toBeDisabled())
    fireEvent.click(dupBtn())
    await waitFor(() =>
      expect(useUIStore.getState().calibrationSheetPageId).toBe(9)
    )
    await screen.findByTestId('replicate-note')
    expect(fileCalSheet).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(notice().textContent).toContain(COPY_LINE))
    expect(notice().textContent).not.toContain('now the active curve')
  })

  it('I1: a notice stays with its sheet: away to the list and back, it is gone', async () => {
    const sheet = makeSheet(fixtureCase(1).inputs as CalInputs)
    vi.mocked(getCalSheet).mockResolvedValue(sheet)
    vi.mocked(listCalSheets).mockResolvedValue([listRow(sheet)])
    vi.mocked(fileCalSheet).mockResolvedValue(filedAs(sheet, 'first_active'))
    renderInApp()
    await screen.findByText('Curve name:', { exact: false })
    fireEvent.click(fileBtn())
    await waitFor(() => expect(notice().textContent).toContain('Filed'))
    fireEvent.click(listLink())
    await screen.findByRole('heading', { name: 'Calibration worksheets' })
    act(() => useUIStore.getState().navigateToCalibrationSheet(5))
    await screen.findByText('Curve name:', { exact: false })
    expect(screen.queryByTestId('cal-notice')).toBeNull()
  })

  it('M2: the sheet page links back to the list', async () => {
    vi.mocked(getCalSheet).mockResolvedValue(
      makeSheet(fixtureCase(1).inputs as CalInputs)
    )
    renderInApp()
    await screen.findByText('Curve name:', { exact: false })
    fireEvent.click(listLink())
    expect(useUIStore.getState().calibrationSheetPageId).toBeNull()
    expect(
      await screen.findByRole('heading', { name: 'Calibration worksheets' })
    ).toBeInTheDocument()
  })

  it('M3: a slow Duplicate that answers after the chemist went to the list leaves them there, with a toast naming the copy', async () => {
    const sheet = makeSheet(fixtureCase(1).inputs as CalInputs, {
      curve_id: 70,
      curve_name: NAME,
    })
    vi.mocked(getCalSheet).mockResolvedValue(sheet)
    const dup = held<CalSheet>()
    vi.mocked(duplicateCalSheet).mockReturnValue(dup.promise)
    renderInApp()
    await screen.findByText('Curve name:', { exact: false })
    fireEvent.click(dupBtn())
    await waitFor(() => expect(duplicateCalSheet).toHaveBeenCalled())
    fireEvent.click(listLink())
    await screen.findByRole('heading', { name: 'Calibration worksheets' })
    await act(async () => dup.resolve(copySheet()))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(useUIStore.getState().calibrationSheetPageId).toBeNull()
    expect(String(vi.mocked(toast.success).mock.calls[0]?.[0])).toContain(
      `${NAME}-Inj2`
    )
  })

  it('M3: a slow Duplicate that answers after the chemist left the section does not bring them back', async () => {
    const sheet = makeSheet(fixtureCase(1).inputs as CalInputs, {
      curve_id: 70,
      curve_name: NAME,
    })
    vi.mocked(getCalSheet).mockResolvedValue(sheet)
    const dup = held<CalSheet>()
    vi.mocked(duplicateCalSheet).mockReturnValue(dup.promise)
    renderInApp()
    await screen.findByText('Curve name:', { exact: false })
    fireEvent.click(dupBtn())
    await waitFor(() => expect(duplicateCalSheet).toHaveBeenCalled())
    act(() => useUIStore.getState().navigateToPeptide(11))
    await act(async () => dup.resolve(copySheet()))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(useUIStore.getState().activeSubSection).toBe('peptide-config')
  })

  it('M3: a File answer for sheet A that lands while sheet B is open leaves B notice alone', async () => {
    const a = makeSheet(fixtureCase(1).inputs as CalInputs)
    const b = makeSheet(fixtureCase(1).inputs as CalInputs, {
      id: 6,
      proposed_name: 'B-SHEET',
    })
    vi.mocked(getCalSheet).mockImplementation(async id => (id === 6 ? b : a))
    const fileA = held<CalFileResult>()
    const refusedB = 'Type the peak areas of at least two levels first.'
    vi.mocked(fileCalSheet).mockImplementation(id =>
      id === 5
        ? fileA.promise
        : Promise.reject(new CalSheetError(refusedB, 400))
    )
    renderInApp()
    await screen.findByText('Curve name:', { exact: false })
    fireEvent.click(fileBtn())
    act(() => useUIStore.getState().navigateToCalibrationSheet(6))
    await screen.findByText('B-SHEET')
    await waitFor(() => expect(fileBtn()).not.toBeDisabled())
    fireEvent.click(fileBtn())
    await waitFor(() => expect(notice().textContent).toContain(refusedB))
    await act(async () => fileA.resolve(filedAs(a, 'first_active')))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(notice().textContent).toContain(refusedB)
    expect(notice().textContent).not.toContain('Filed')
  })

  it('M3: New from the list that answers after a sheet was opened leaves that sheet open', async () => {
    const other = makeSheet(fixtureCase(1).inputs as CalInputs, { id: 2 })
    vi.mocked(listCalSheets).mockResolvedValue([listRow(other)])
    vi.mocked(getCalSheet).mockResolvedValue(other)
    const made = held<CalSheet>()
    vi.mocked(createCalSheet).mockReturnValue(made.promise)
    renderInApp(null)
    await screen.findByRole('heading', { name: 'Calibration worksheets' })
    fireEvent.click(
      screen.getByRole('button', { name: 'New calibration worksheet' })
    )
    fireEvent.click(
      screen.getByRole('button', { name: `Open ${other.proposed_name}` })
    )
    await screen.findByText('Curve name:', { exact: false })
    await act(async () =>
      made.resolve(
        makeSheet(fixtureCase(21).inputs as CalInputs, {
          id: 12,
          proposed_name: 'NEW-SHEET',
        })
      )
    )
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(useUIStore.getState().calibrationSheetPageId).toBe(2)
    expect(String(vi.mocked(toast.success).mock.calls[0]?.[0])).toContain(
      'NEW-SHEET'
    )
  })
})

describe('Part A: Duplicate and the File reasons', () => {
  it('M1 (probe F2): a changed sheet whose curve is in use is copied anyway, with the refusal and the copy line', async () => {
    const sheet = makeSheet(fixtureCase(1).inputs as CalInputs, {
      curve_id: 70,
      curve_name: NAME,
      changed_since_filed: true,
    })
    const copy = copySheet()
    vi.mocked(getCalSheet).mockImplementation(async id =>
      id === 9 ? copy : sheet
    )
    const said = `Curve ${NAME} has been used by 1 analysis and 0 prep sessions, so its numbers are part of their record. Start a new worksheet to file a corrected curve.`
    vi.mocked(fileCalSheet).mockRejectedValue(new CalSheetError(said, 409))
    vi.mocked(duplicateCalSheet).mockResolvedValue(copy)
    renderInApp()
    await screen.findByText('Curve name:', { exact: false })
    fireEvent.click(dupBtn())
    await waitFor(() =>
      expect(useUIStore.getState().calibrationSheetPageId).toBe(9)
    )
    expect(duplicateCalSheet).toHaveBeenCalledWith(5)
    await screen.findByTestId('replicate-note')
    const lines = within(notice())
      .getAllByText(/./, { selector: 'p' })
      .map(p => p.textContent)
    expect(lines).toEqual([said, COPY_LINE])
  })

  it('M1: with no curve, a 409 on the file-first step still stops Duplicate', async () => {
    await openCase1()
    const said =
      'Someone changed one of these curves at the same moment, so nothing was filed. Try again.'
    vi.mocked(fileCalSheet).mockRejectedValue(new CalSheetError(said, 409))
    fireEvent.click(dupBtn())
    await waitFor(() => expect(notice().textContent).toContain(said))
    expect(duplicateCalSheet).not.toHaveBeenCalled()
  })

  it('M1: with a curve, a refusal that is not a 409 still stops Duplicate', async () => {
    await openCase1({
      curve_id: 70,
      curve_name: NAME,
      changed_since_filed: true,
    })
    const said = 'Type the peak areas of at least two levels first.'
    vi.mocked(fileCalSheet).mockRejectedValue(new CalSheetError(said, 400))
    fireEvent.click(dupBtn())
    await waitFor(() => expect(notice().textContent).toContain(said))
    expect(duplicateCalSheet).not.toHaveBeenCalled()
  })

  it('M7: an injection whose original has no compound names the original, not the disabled picker', async () => {
    vi.mocked(getCalSheet).mockResolvedValue(
      copySheet({ id: 5, peptide_id: null, replicate_of_sheet_id: 4 })
    )
    renderSheet()
    await screen.findByTestId('replicate-note')
    expect(why(fileBtn())).toContain(
      `The original worksheet, ${NAME}, has no compound. An injection is filed under its original's compound.`
    )
    expect(why(fileBtn())).not.toContain('Pick the compound first')
  })
})

describe('Part B: the save hook', () => {
  it('I-N1 (probe P1): a 400 about a typed box leaves a valid compound pick alone; once the box is fixed, the new compound saves', async () => {
    const saves = queueSaves()
    const { sheet } = await openCase1()
    await waitFor(() => expect(picker().options.length).toBeGreaterThan(2))
    typeAndLeave(box('Lot #'), 'BAD') // save 0
    await waitFor(() => expect(saves.count()).toBe(1))
    await saves.fail(0, new CalSheetError('Lot is too long.', 400))
    await waitFor(() => expect(screen.getByTestId('save-line')).toBeTruthy())
    fireEvent.change(picker(), { target: { value: '12' } }) // save 1
    await waitFor(() => expect(saves.count()).toBe(2))
    expect(body(1).peptide_id).toBe(12)
    await saves.fail(1, new CalSheetError('Lot is too long.', 400))
    await waitFor(() =>
      expect(screen.getByTestId('save-line').textContent).toContain(
        'Lot is too long'
      )
    )
    expect(picker().value).toBe('12')
    expect(saves.count()).toBe(2)
    typeAndLeave(box('Lot #'), 'L7') // save 2: the new compound and the lot
    await waitFor(() => expect(saves.count()).toBe(3))
    expect(body(2).peptide_id).toBe(12)
    expect(inputsOf(2).lot).toBe('L7')
    await saves.ok(
      2,
      makeSheet(
        { ...(sheet.inputs as CalInputs), lot: 'L7' },
        { version: 2, peptide_id: 12 }
      )
    )
    await waitFor(() => expect(saved()).toBe('true'))
    expect(picker().value).toBe('12')
  })

  it('I-N1 (b): a refused pick sent with unchanged inputs is put back, with its sentence', async () => {
    const saves = queueSaves()
    await openCase1()
    await waitFor(() => expect(picker().options.length).toBeGreaterThan(2))
    const said = 'BPC-157 is a blend. A curve is for one peptide.'
    fireEvent.change(picker(), { target: { value: '12' } })
    await waitFor(() => expect(saves.count()).toBe(1))
    await saves.fail(0, new CalSheetError(said, 400))
    await waitFor(() => expect(picker().value).toBe('11'))
    expect(screen.getByText(said)).toBeInTheDocument()
    expect(screen.queryByTestId('save-line')).toBeNull()
    await waitFor(() => expect(saved()).toBe('true'))
    expect(saves.count()).toBe(1)
  })

  it('M-N1: a filed sheet shows a Filed mark beside the curve name; an unfiled one does not', async () => {
    const { view } = await openCase1({ curve_id: 70, curve_name: NAME })
    expect(filedMark()).not.toBeNull()
    view.unmount()
    resetCalSaves()
    await openCase1()
    expect(filedMark()).toBeNull()
  })

  it('M-N1: after a File with no answer, the re-read that finds the filing shows the Filed mark, and the sentence points at it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { sheet } = await openCase1()
    expect(filedMark()).toBeNull()
    vi.mocked(fileCalSheet).mockImplementation(
      () => new Promise(() => undefined)
    )
    vi.mocked(getCalSheet).mockResolvedValue({
      ...sheet,
      curve_id: 70,
      curve_name: NAME,
    })
    fireEvent.click(fileBtn())
    await later(SAVE_TIMEOUT_MS + 10)
    await waitFor(() =>
      expect(notice().textContent).toContain(
        'a Filed mark beside the curve name means it was'
      )
    )
    await waitFor(() => expect(filedMark()).not.toBeNull())
    expect(screen.getByText('Curve name:', { exact: false })).toBeTruthy()
  })

  it('M-N2: an answer that settles after the page closed raises one toast, not two', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const saves = queueSaves()
    const { sheet } = await openCase1()
    const base = sheet.inputs as CalInputs
    typeAndLeave(box('Weight from COA (mg)'), '6') // A, never answered
    await waitFor(() => expect(saves.count()).toBe(1))
    await later(SAVE_TIMEOUT_MS + 10)
    act(() => useUIStore.setState({ calibrationSheetPageId: null }))
    // leaving sends the last save; someone else saved meanwhile
    await waitFor(() => expect(saves.count()).toBe(2))
    vi.mocked(getCalSheet).mockResolvedValue(
      makeSheet({ ...base, lot: 'THEIRS' }, { version: 2 })
    )
    vi.mocked(toast.error).mockClear()
    await saves.fail(1, stale409())
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(toast.error).mock.calls[0]?.[0])).toContain(
      'your last changes were not saved'
    )
  })

  describe('M-N3: the three untested parts of the round 1 I1 fix', () => {
    /** Type A (the weight) on v1; it is never answered and is cleared as
     *  lost 60 s later. */
    async function clearAsLost() {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const saves = queueSaves()
      const { sheet, view } = await openCase1()
      typeAndLeave(box('Weight from COA (mg)'), '6')
      await waitFor(() => expect(saves.count()).toBe(1))
      await later(SAVE_TIMEOUT_MS + 10)
      await waitFor(() => expect(checking()).not.toBeNull())
      await later(50_000)
      await waitFor(() => expect(checking()).toBeNull())
      return { saves, view, base: sheet.inputs as CalInputs }
    }

    it('a server copy equal to the local inputs is the page own: no line, its version taken', async () => {
      const saves = queueSaves()
      const { sheet } = await openCase1()
      const base = sheet.inputs as CalInputs
      typeAndLeave(box('Weight from COA (mg)'), '6') // A, held
      await waitFor(() => expect(saves.count()).toBe(1))
      typeAndLeave(box('Lot #'), 'C9') // typed while A is out, not sent
      // the server holds exactly what is on screen, as v2
      vi.mocked(getCalSheet).mockResolvedValue(
        makeSheet({ ...base, coa_weight_mg: 6, lot: 'C9' }, { version: 2 })
      )
      await saves.fail(0, stale409())
      await waitFor(() => expect(saved()).toBe('true'))
      expect(screen.queryByText(RELOADED)).toBeNull()
      expect(screen.queryByText(RELOADED_NOTHING_LOST)).toBeNull()
      expect(box('Lot #').value).toBe('C9')
      expect(saves.count()).toBe(1)
    })

    it('a 200 that moves the version empties lost: a later foreign save equal to A is announced', async () => {
      const { saves, view, base } = await clearAsLost()
      typeAndLeave(box('Lot #'), 'C9') // A and C9 on v1
      await waitFor(() => expect(saves.count()).toBe(2))
      await saves.ok(
        1,
        makeSheet({ ...base, coa_weight_mg: 6, lot: 'C9' }, { version: 2 })
      )
      await waitFor(() => expect(saved()).toBe('true'))
      // someone else saves exactly A as v3
      act(() =>
        view.qc.setQueryData(
          CAL_SHEET_KEY(5),
          makeSheet({ ...base, coa_weight_mg: 6 }, { version: 3 })
        )
      )
      expect(await screen.findByText(RELOADED_NOTHING_LOST)).toBeTruthy()
    })

    it('the own-or-foreign match empties lost: a later foreign save equal to A is announced', async () => {
      const { view, base } = await clearAsLost()
      act(() =>
        view.qc.setQueryData(
          CAL_SHEET_KEY(5),
          makeSheet({ ...base, lot: 'THEIRS' }, { version: 2 })
        )
      )
      const line = await screen.findByText(RELOADED)
      fireEvent.click(
        within(line.closest('[role="alert"]') as HTMLElement).getByRole(
          'button',
          { name: 'Dismiss' }
        )
      )
      // someone else then saves exactly A as v3
      act(() =>
        view.qc.setQueryData(
          CAL_SHEET_KEY(5),
          makeSheet({ ...base, coa_weight_mg: 6 }, { version: 3 })
        )
      )
      expect(await screen.findByText(RELOADED_NOTHING_LOST)).toBeTruthy()
    })
  })
})

// --- Round 2: the re-review's N1 to N3 and the browser pass ---

const DUP_CHANGED =
  'Duplicate did not go: this sheet was saved again since the page last read it. Check it and try again.'
const NOT_TAKEN_LINE =
  'Not saved: the server did not answer or could not take the save. Your changes are still on this page.'
const KEYS =
  'Tab and Enter go down a column, then to the top of the next one; Shift+Tab and Shift+Enter go back up. The arrow keys move along a row (Left, Right) and between rows (Up, Down); while you edit a value, Left and Right first move through its text.'
const WORKED_OUT =
  'This sheet cannot be worked out as stored. Check the values below.'

describe('Round 2: N1, a 409 from the file-first step of Duplicate', () => {
  const filedChanged = () =>
    makeSheet(fixtureCase(1).inputs as CalInputs, {
      curve_id: 70,
      curve_name: NAME,
      changed_since_filed: true,
    })

  it('a stale-version 409 (someone else saved) stops with the changed sentence and makes no copy (probe PR1, stale)', async () => {
    const sheet = filedChanged()
    const copy = copySheet()
    let now = sheet
    vi.mocked(getCalSheet).mockImplementation(async id =>
      id === 9 ? copy : now
    )
    vi.mocked(fileCalSheet).mockImplementation(async () => {
      now = { ...sheet, version: 2, inputs: { ...sheet.inputs, lot: 'B2' } }
      throw stale409()
    })
    vi.mocked(duplicateCalSheet).mockResolvedValue(copy)
    renderInApp()
    await screen.findByText('Curve name:', { exact: false })
    fireEvent.click(dupBtn())
    await waitFor(() => expect(notice().textContent).toContain(DUP_CHANGED))
    expect(duplicateCalSheet).not.toHaveBeenCalled()
    expect(useUIStore.getState().calibrationSheetPageId).toBe(5)
  })

  it('any other 409 on the page own version (a deadlock) still makes the copy, with both lines (probe PR1, deadlock, as ruled)', async () => {
    const sheet = filedChanged()
    const copy = copySheet()
    vi.mocked(getCalSheet).mockImplementation(async id =>
      id === 9 ? copy : sheet
    )
    const said =
      'Someone changed one of these curves at the same moment, so nothing was filed. Try again.'
    vi.mocked(fileCalSheet).mockRejectedValue(new CalSheetError(said, 409))
    vi.mocked(duplicateCalSheet).mockResolvedValue(copy)
    renderInApp()
    await screen.findByText('Curve name:', { exact: false })
    fireEvent.click(dupBtn())
    await waitFor(() =>
      expect(useUIStore.getState().calibrationSheetPageId).toBe(9)
    )
    await screen.findByTestId('replicate-note')
    const lines = within(notice())
      .getAllByText(/./, { selector: 'p' })
      .map(p => p.textContent)
    expect(lines).toEqual([said, COPY_LINE])
  })
})

describe('Round 2: N2, a read sent before a write never puts the older copy back', () => {
  function inAppWith(cached: CalSheet) {
    const qc = new QueryClient({
      defaultOptions: appQueryClient.getDefaultOptions(),
    })
    qc.setQueryData(CAL_SHEET_KEY(5), cached)
    const read = held<CalSheet>()
    vi.mocked(getCalSheet).mockReturnValue(read.promise)
    useUIStore.setState({
      activeSection: 'hplc-analysis',
      activeSubSection: 'hplc-calibration',
      calibrationSheetPageId: 5,
    })
    render(
      <QueryClientProvider client={qc}>
        <HplcCalibrationSheetPage />
      </QueryClientProvider>
    )
    return { qc, read }
  }

  it('the save 200 (probe PR2): the mount read answering last leaves the saved copy in the cache', async () => {
    const v1 = makeSheet(fixtureCase(1).inputs as CalInputs, {
      blocking: ['cannot_be_worked_out'],
    })
    const v2 = makeSheet(
      { ...(fixtureCase(1).inputs as CalInputs), lot: 'L7' },
      { version: 2, blocking: [] }
    )
    vi.mocked(saveCalSheet).mockResolvedValue(v2)
    const { qc, read } = inAppWith(v1)
    await screen.findByText('Curve name:', { exact: false })
    expect(getCalSheet).toHaveBeenCalledTimes(1) // the mount read is out
    expect(screen.queryByText(WORKED_OUT)).not.toBeNull()
    typeAndLeave(box('Lot #'), 'L7')
    await waitFor(() =>
      expect(qc.getQueryData<CalSheet>(CAL_SHEET_KEY(5))?.version).toBe(2)
    )
    await waitFor(() => expect(screen.queryByText(WORKED_OUT)).toBeNull())
    await act(async () => read.resolve(v1))
    await act(async () => {
      await new Promise(r => setTimeout(r, 20))
    })
    expect(qc.getQueryData<CalSheet>(CAL_SHEET_KEY(5))?.version).toBe(2)
    expect(screen.queryByText(WORKED_OUT)).toBeNull()
  })

  it('the File success: the mount read answering last leaves the filed copy in the cache', async () => {
    const v1 = makeSheet(fixtureCase(1).inputs as CalInputs)
    vi.mocked(fileCalSheet).mockResolvedValue(filedAs(v1, 'first_active'))
    const { qc, read } = inAppWith(v1)
    await screen.findByText('Curve name:', { exact: false })
    await waitFor(() => expect(fileBtn()).not.toBeDisabled())
    fireEvent.click(fileBtn())
    await waitFor(() => expect(notice().textContent).toContain('Filed'))
    expect(qc.getQueryData<CalSheet>(CAL_SHEET_KEY(5))?.curve_id).toBe(70)
    await act(async () => read.resolve(v1))
    await act(async () => {
      await new Promise(r => setTimeout(r, 20))
    })
    expect(qc.getQueryData<CalSheet>(CAL_SHEET_KEY(5))?.curve_id).toBe(70)
  })
})

describe('Round 2: N3, the way back from every state of the sheet', () => {
  it('a sheet that could not be opened shows the link back to the list', async () => {
    vi.mocked(getCalSheet).mockRejectedValue(
      new CalSheetError('Calibration sheet not found', 404)
    )
    renderSheet()
    await screen.findByText(/This sheet could not be opened/)
    fireEvent.click(listLink())
    expect(useUIStore.getState().calibrationSheetPageId).toBeNull()
  })

  it('a sheet still loading shows the link back to the list', async () => {
    vi.mocked(getCalSheet).mockReturnValue(new Promise(() => undefined))
    renderSheet()
    await screen.findByText('Loading the sheet...')
    expect(listLink()).toBeInTheDocument()
  })
})

describe('Round 2: the browser pass', () => {
  it('I-1: one line above each of the Step 3 and Step 4 tables says what Tab, Enter and the arrows do', async () => {
    await openCase1()
    const hints = screen.getAllByTestId('keys-hint')
    expect(hints.map(h => h.textContent)).toEqual([KEYS, KEYS])
    expect(
      screen.queryByText(/Enter goes down a column\./, { exact: false })
    ).toBeNull()
  })

  it('I-2: a 5xx answer to a save reads as no answer, never the raw status, and still counts as may have landed', async () => {
    const saves = queueSaves()
    await openCase1()
    typeAndLeave(box('Lot #'), 'L7')
    await waitFor(() => expect(saves.count()).toBe(1))
    await saves.fail(
      0,
      new CalSheetError('Save calibration sheet failed: 500', 500)
    )
    const line = await screen.findByTestId('save-line')
    expect(line.textContent).toContain(NOT_TAKEN_LINE)
    expect(line.textContent).not.toContain('500')
    expect(within(line).getByRole('button', { name: 'Retry' })).toBeTruthy()
    // the body may have landed: the page checks, as for no answer
    expect(checking()).not.toBeNull()
  })

  it('I-2: a 4xx keeps the server sentence', async () => {
    const saves = queueSaves()
    await openCase1()
    typeAndLeave(box('Lot #'), 'L7')
    await waitFor(() => expect(saves.count()).toBe(1))
    await saves.fail(0, new CalSheetError('Lot is too long.', 400))
    expect((await screen.findByTestId('save-line')).textContent).toContain(
      'Not saved: Lot is too long. Your changes are still on this page.'
    )
  })

  it('a quiet Saved shows while saved, announced politely, and gives way to Saving', async () => {
    const saves = queueSaves()
    const { sheet } = await openCase1()
    const savedLine = () => screen.queryByText('Saved', { exact: true })
    await waitFor(() => expect(savedLine()).not.toBeNull())
    expect(savedLine()?.closest('[role="status"]')).not.toBeNull()
    expect(savedLine()?.closest('[role="alert"]')).toBeNull()
    typeAndLeave(box('Lot #'), 'L7')
    await waitFor(() => expect(saves.count()).toBe(1))
    expect(savedLine()).toBeNull()
    expect(screen.getByTestId('save-line').textContent).toContain('Saving...')
    await saves.ok(
      0,
      makeSheet({ ...(sheet.inputs as CalInputs), lot: 'L7' }, { version: 2 })
    )
    await waitFor(() => expect(savedLine()).not.toBeNull())
  })

  it('the bar with the toolbar and the save status sticks to the top of the page', async () => {
    await openCase1()
    const bar = screen.getByTestId('status-bar')
    expect(bar.className).toContain('sticky')
    expect(bar.className).toContain('top-0')
    expect(within(bar).getByRole('group', { name: 'Worksheet' })).toBeTruthy()
    expect(within(bar).getByText('Saved', { exact: true })).toBeTruthy()
  })

  describe('an injection says what its original needs before File', () => {
    async function openInjection(original: Partial<CalSheet>) {
      const orig = makeSheet(fixtureCase(1).inputs as CalInputs, {
        curve_name: NAME,
        ...original,
      })
      vi.mocked(getCalSheet).mockImplementation(async id =>
        id === 9 ? copySheet() : orig
      )
      renderSheet(9)
      await screen.findByTestId('replicate-note')
    }

    it('an original changed since filing', async () => {
      await openInjection({ curve_id: 70, changed_since_filed: true })
      const line = await screen.findByTestId('original-state')
      expect(line.textContent).toBe(
        `The original worksheet, ${NAME}, has been changed since it was filed. If its preparation changed, file it before this one.`
      )
      expect(
        within(screen.getByTestId('replicate-note')).getByRole('button', {
          name: `Open ${NAME}`,
        })
      ).toBeTruthy()
    })

    it('an original that is not filed', async () => {
      await openInjection({ curve_id: null })
      expect((await screen.findByTestId('original-state')).textContent).toBe(
        `The original worksheet, ${NAME}, is not filed. File it first, then file this one.`
      )
    })

    it('an original filed as it stands: no line', async () => {
      await openInjection({ curve_id: 70, changed_since_filed: false })
      await waitFor(() => expect(getCalSheet).toHaveBeenCalledWith(5))
      await act(async () => {
        await new Promise(r => setTimeout(r, 20))
      })
      expect(screen.queryByTestId('original-state')).toBeNull()
    })
  })

  it('File with no answer on a sheet that already had a curve: says pressing File again updates the same curve, not the Filed mark', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await openCase1({ curve_id: 70, curve_name: NAME })
    vi.mocked(fileCalSheet).mockImplementation(
      () => new Promise(() => undefined)
    )
    fireEvent.click(fileBtn())
    await later(SAVE_TIMEOUT_MS + 10)
    await waitFor(() =>
      expect(notice().textContent).toBe(
        'File curve: the server did not answer, so the curve may or may not have been updated. Pressing File curve again is safe: it updates the same curve.Dismiss'
      )
    )
  })

  it('the injection File sentence names the Set Active button', async () => {
    const sheet = makeSheet(fixtureCase(1).inputs as CalInputs)
    vi.mocked(getCalSheet).mockResolvedValue(sheet)
    vi.mocked(fileCalSheet).mockResolvedValue(filedAs(sheet, 'replicate'))
    renderSheet()
    await screen.findByText('Curve name:', { exact: false })
    await waitFor(() => expect(fileBtn()).not.toBeDisabled())
    fireEvent.click(fileBtn())
    await waitFor(() =>
      expect(notice().textContent).toContain(
        `Filed ${NAME}, another injection of the same vials. To use it, press Set Active on its curve on the Peptides page.`
      )
    )
    expect(notice().textContent).not.toContain('Star')
  })

  it('New from the list page puts focus on the new sheet heading, as from the toolbar', async () => {
    const made = makeSheet(fixtureCase(21).inputs as CalInputs, {
      id: 12,
      proposed_name: 'NEW-SHEET',
    })
    vi.mocked(createCalSheet).mockResolvedValue(made)
    vi.mocked(getCalSheet).mockResolvedValue(made)
    renderInApp(null)
    await screen.findByRole('heading', { name: 'Calibration worksheets' })
    fireEvent.click(
      screen.getByRole('button', { name: 'New calibration worksheet' })
    )
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Calibration Curve Worksheet' })
      )
    )
  })
})
