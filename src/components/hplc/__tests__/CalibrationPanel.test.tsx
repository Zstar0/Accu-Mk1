import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type * as ApiModule from '@/lib/api'
import {
  createCalSheet,
  getCalibration,
  getCalibrations,
  getInstruments,
  type CalibrationCurve,
  type CalSheet,
  type Instrument,
  type PeptideRecord,
} from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { CalibrationPanel } from '../CalibrationPanel'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getCalibrations: vi.fn(),
  getCalibration: vi.fn(),
  getInstruments: vi.fn(),
  createCalSheet: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
// the chart libraries are not what this file tests
vi.mock('../CalibrationChart', () => ({ CalibrationChart: () => null }))

const PEPTIDE = {
  id: 11,
  name: 'Retatrutide',
  abbreviation: 'RETA',
  is_blend: false,
  analytes: [],
} as unknown as PeptideRecord

function curve(over: Partial<CalibrationCurve>): CalibrationCurve {
  return {
    id: 1,
    peptide_id: 11,
    slope: 12.3456,
    intercept: 0.5,
    r_squared: 0.999912,
    standard_data: null,
    chromatogram_data: null,
    source_filename: null,
    sharepoint_url: null,
    source_date: '2026-10-01T00:00:00',
    created_at: '2026-10-01T00:00:00',
    is_active: true,
    instrument: '1290C',
    instrument_id: 2,
    peptide_analyte_id: null,
    source_sample_id: null,
    reference_rt: null,
    rt_tolerance: 0.5,
    diluent_density: 997.1,
    notes: null,
    vendor: null,
    created_by_email: null,
    updated_by_email: null,
    calibration_sheet_id: null,
    injection: null,
    net_basis: 'entered_by_hand',
    ...over,
  } as unknown as CalibrationCurve
}

const instrument = (id: number, name: string, active = true) =>
  ({ id, name, active }) as Instrument

/** A row's header: the button that toggles it. */
const header = async (text: string) =>
  (await screen.findByText(text)).closest('button') as HTMLElement

describe('CalibrationPanel: the way into the worksheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUIStore.setState({ calibrationSheetPageId: null })
    vi.mocked(getInstruments).mockResolvedValue([
      instrument(2, '1290C'),
      instrument(3, '1290A', false),
    ])
    vi.mocked(getCalibration).mockImplementation(async (_p, id) =>
      curve({ id })
    )
  })

  it('a curve with no worksheet renders as today apart from its badge', async () => {
    vi.mocked(getCalibrations).mockResolvedValue([curve({})])
    render(
      <CalibrationPanel
        peptide={PEPTIDE}
        onUpdated={vi.fn()}
        instrumentFilter="all"
      />
    )
    const row = await header('y = 12.3456x + 0.5000')
    const badges = [
      ...row.querySelectorAll(
        '[data-slot="badge"], [data-slot="tooltip-trigger"]'
      ),
    ].map(b => b.textContent)
    expect(badges).toEqual(['Active', '1290C', 'net, entered by hand'])
    expect(within(row).queryByText('worksheet')).toBeNull()
    expect(within(row).queryByText(/^Inj/)).toBeNull()
    expect(
      within(row).queryByRole('button', { name: 'Open worksheet' })
    ).toBeNull()
    // the tag explains itself to a screen reader
    const tag = within(row).getByText('net, entered by hand')
    expect(tag).toHaveAccessibleDescription(
      'This curve was entered before the Calibration Curve Worksheet, with the net peptide weight already applied by hand. Its numbers are left as they were.'
    )
  })

  it('the Peptides page tags a hand-entered curve and links a worksheet curve to its sheet', async () => {
    vi.mocked(getCalibrations).mockResolvedValue([
      curve({
        id: 7,
        slope: 2,
        intercept: 1,
        net_basis: 'worksheet',
        calibration_sheet_id: 5,
        injection: 2,
      }),
      curve({ id: 6, is_active: false }),
    ])
    render(
      <CalibrationPanel
        peptide={PEPTIDE}
        onUpdated={vi.fn()}
        instrumentFilter="all"
      />
    )
    const mine = await header('y = 2.0000x + 1.0000')
    expect(within(mine).getByText('worksheet')).toBeInTheDocument()
    expect(within(mine).getByText('Inj2')).toBeInTheDocument()
    expect(within(mine).queryByText('net, entered by hand')).toBeNull()
    const legacy = await header('y = 12.3456x + 0.5000')
    expect(within(legacy).getByText('net, entered by hand')).toBeInTheDocument()
    // opening the sheet does not fold the row
    const expanded = screen.getAllByText('Curve Settings').length
    fireEvent.click(
      within(mine).getByRole('button', { name: 'Open worksheet' })
    )
    expect(useUIStore.getState().calibrationSheetPageId).toBe(5)
    expect(useUIStore.getState().activeSubSection).toBe('hplc-calibration')
    expect(screen.getAllByText('Curve Settings').length).toBe(expanded)
  })

  it('Calibration worksheet on the Peptides page opens a new sheet for that peptide', async () => {
    vi.mocked(getCalibrations).mockResolvedValue([])
    vi.mocked(createCalSheet).mockResolvedValue({ id: 21 } as CalSheet)
    render(
      <CalibrationPanel
        peptide={PEPTIDE}
        onUpdated={vi.fn()}
        instrumentFilter="2"
      />
    )
    await screen.findByText('No calibration curves yet')
    await waitFor(() => expect(getInstruments).toHaveBeenCalled())
    fireEvent.click(
      screen.getByRole('button', { name: 'Calibration worksheet' })
    )
    await waitFor(() =>
      expect(useUIStore.getState().calibrationSheetPageId).toBe(21)
    )
    expect(createCalSheet).toHaveBeenCalledWith({
      peptide_id: 11,
      instrument_id: 2,
    })
  })

  it('a filter on all instruments, or on a retired one, leaves the instrument to pick', async () => {
    vi.mocked(getCalibrations).mockResolvedValue([])
    vi.mocked(createCalSheet).mockResolvedValue({ id: 22 } as CalSheet)
    const { rerender } = render(
      <CalibrationPanel
        peptide={PEPTIDE}
        onUpdated={vi.fn()}
        instrumentFilter="all"
      />
    )
    await screen.findByText('No calibration curves yet')
    fireEvent.click(
      screen.getByRole('button', { name: 'Calibration worksheet' })
    )
    await waitFor(() =>
      expect(createCalSheet).toHaveBeenLastCalledWith({ peptide_id: 11 })
    )
    rerender(
      <CalibrationPanel
        peptide={PEPTIDE}
        onUpdated={vi.fn()}
        instrumentFilter="3"
      />
    )
    await waitFor(() => expect(getInstruments).toHaveBeenCalled())
    fireEvent.click(
      screen.getByRole('button', { name: 'Calibration worksheet' })
    )
    await waitFor(() => expect(createCalSheet).toHaveBeenCalledTimes(2))
    expect(createCalSheet).toHaveBeenLastCalledWith({ peptide_id: 11 })
  })

  it('a blend has no worksheet of its own', async () => {
    vi.mocked(getCalibrations).mockResolvedValue([])
    render(
      <CalibrationPanel
        peptide={{ ...PEPTIDE, is_blend: true }}
        onUpdated={vi.fn()}
        instrumentFilter="all"
      />
    )
    await screen.findByText('No calibration curves yet')
    const btn = screen.getByRole('button', { name: 'Calibration worksheet' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAccessibleDescription(
      "A curve is for one peptide. A blend's components each have their own."
    )
    // M6: the disabled button's reason shows on hover, through a wrapper
    const wrapper = btn.parentElement as HTMLElement
    expect(wrapper.dataset.slot).toBe('tooltip-trigger')
    expect(wrapper.tabIndex).toBe(0)
    fireEvent.focus(wrapper)
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      "A curve is for one peptide. A blend's components each have their own."
    )
  })

  it('M6: a single peptide has no hover wrapper in the tab order', async () => {
    vi.mocked(getCalibrations).mockResolvedValue([])
    render(
      <CalibrationPanel
        peptide={PEPTIDE}
        onUpdated={vi.fn()}
        instrumentFilter="all"
      />
    )
    await screen.findByText('No calibration curves yet')
    const btn = screen.getByRole('button', { name: 'Calibration worksheet' })
    expect(btn).not.toBeDisabled()
    expect(btn.parentElement?.tabIndex).not.toBe(0)
  })
})
