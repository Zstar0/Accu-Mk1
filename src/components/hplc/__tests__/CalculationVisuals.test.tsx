import { cloneElement, type ReactElement } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type * as Recharts from 'recharts'
import { CalculationVisuals } from '../CalculationVisuals'

// jsdom has no layout, so give the chart a size (same idiom as AnalyteTrends.test).
vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof Recharts>()
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children: ReactElement<{ width?: number; height?: number }>
    }) => cloneElement(children, { width: 400, height: 200 }),
  }
})

// The trace process_hplc_analysis stores when the stock vial weighing was never
// entered (stock leg exactly 0): the engine refuses to compute from it, so the
// dilution factor and stock volume are null. Before the panel handled that,
// viewing such an analysis threw on `null.toFixed`.
const PROBLEM_DILUTION = {
  diluent_mass_mg: 1234.66,
  diluent_vol_ul: 1238.2,
  sample_mass_mg: 219.93,
  sample_vol_ul: 220.6,
  total_vol_ul: 1458.8,
  dilution_factor: null,
  stock_mass_mg: 0,
  stock_volume_ml: null,
  problem: 'stock_diluent',
}

// The quantity section keeps what does not depend on the weighings.
const PROBLEM_QUANTITY = {
  quantity_mg: null,
  error: 'stock_diluent',
  individual_areas: [1000],
  avg_main_peak_area: 1000,
  concentration_ug_ml: 321.4472,
  calibration_slope: 3.1,
  calibration_intercept: 0.5,
}

// The whole trace of a real flagged row: all four sections at once. Captured
// from process_hplc_analysis on a single-injection prod-shaped row with the
// stock vial weighing zeroed and a reference RT set, not hand-built.
const FLAGGED_ROW_TRACE = {
  dilution: {
    diluent_mass_mg: 1493.4127,
    diluent_vol_ul: 1497.7562,
    sample_mass_mg: 2.2373,
    sample_vol_ul: 2.2438,
    total_vol_ul: 1500.0,
    dilution_factor: null,
    stock_mass_mg: 0.0,
    stock_volume_ml: null,
    problem: 'stock_diluent',
  },
  purity: {
    purity_percent: 99.8821,
    individual_values: [99.8821],
    injection_names: [''],
    rsd_percent: null,
  },
  quantity: {
    quantity_mg: null,
    error: 'stock_diluent',
    individual_areas: [1125.3809],
    avg_main_peak_area: 1125.3809,
    concentration_ug_ml: 73.4453,
    calibration_slope: 15.782452,
    calibration_intercept: -33.766783,
  },
  identity: {
    conforms: true,
    sample_rt: 1.303,
    reference_rt: 1.253,
    rt_delta: 0.05,
    rt_tolerance: 0.5,
    individual_rts: [1.303],
    reference_source: 'calibration_curve',
    reference_source_id: null,
    calibration_curve_rt: 1.253,
  },
}

// The wording a tech reads for each problem code, exactly. A typo in any entry
// of WEIGHING_PROBLEM_TEXT, or a code that falls back to its raw name, fails here.
const PROBLEM_WORDING: [string, string][] = [
  [
    'stock_diluent',
    'The stock vial weighing is missing, or not heavier than the empty vial.',
  ],
  [
    'diluent',
    'The dilution vial with diluent weighs less than the empty vial.',
  ],
  [
    'stock',
    'The dilution vial with sample weighs no more than the vial with diluent.',
  ],
]

describe('CalculationVisuals with a weighing problem', () => {
  it('renders every section of a real flagged row without throwing', () => {
    expect(() =>
      render(<CalculationVisuals trace={FLAGGED_ROW_TRACE} />)
    ).not.toThrow()
    // Dilution factor, stock volume, undiluted concentration, mass.
    expect(screen.getAllByText('not determined')).toHaveLength(4)
    // The sections that do not depend on the weighings are all still there.
    expect(screen.getByText('Dilution & Stock Prep')).toBeInTheDocument()
    expect(screen.getByText('Sample on Calibration Curve')).toBeInTheDocument()
    expect(screen.getByText('73.45 µg/mL')).toBeInTheDocument()
    expect(screen.getByText('Purity per Injection')).toBeInTheDocument()
    expect(screen.getByText(/Retention Time Match/)).toBeInTheDocument()
    // One reason line per panel that cannot show a number.
    expect(
      document.body.textContent?.split('stock vial weighing is missing')
    ).toHaveLength(3)
  })

  it.each(PROBLEM_WORDING)(
    'explains %s in the dilution panel and the quantity panel',
    (code, sentence) => {
      const trace = {
        ...FLAGGED_ROW_TRACE,
        dilution: { ...FLAGGED_ROW_TRACE.dilution, problem: code },
        quantity: { ...FLAGGED_ROW_TRACE.quantity, error: code },
      }
      const { container } = render(<CalculationVisuals trace={trace} />)
      expect(container.textContent?.split(sentence)).toHaveLength(3)
    }
  )

  it('falls back to the raw code for a problem it has no wording for', () => {
    const trace = {
      dilution: { ...FLAGGED_ROW_TRACE.dilution, problem: 'made_up_code' },
    }
    const { container } = render(<CalculationVisuals trace={trace} />)
    expect(container.textContent).toContain('not determined: made_up_code')
  })

  it('shows the dilution factor and stock volume as not determined, with the reason', () => {
    expect(() =>
      render(<CalculationVisuals trace={{ dilution: PROBLEM_DILUTION }} />)
    ).not.toThrow()
    expect(screen.getAllByText('not determined')).toHaveLength(2)
    expect(
      screen.getByText(/stock vial weighing is missing/)
    ).toBeInTheDocument()
  })

  it('keeps the measured concentration and says the mass could not be determined', () => {
    expect(() =>
      render(<CalculationVisuals trace={{ quantity: PROBLEM_QUANTITY }} />)
    ).not.toThrow()
    expect(screen.getByText('321.45 µg/mL')).toBeInTheDocument()
    // Undiluted concentration and mass: both need the dilution factor and stock volume.
    expect(screen.getAllByText('not determined')).toHaveLength(2)
    expect(
      screen.getByText(/Mass not determined: .*stock vial weighing/)
    ).toBeInTheDocument()
  })

  it('still prints numbers when nothing is wrong', () => {
    render(
      <CalculationVisuals
        trace={{
          dilution: {
            ...PROBLEM_DILUTION,
            dilution_factor: 6.613877,
            stock_volume_ml: 2.9684,
            problem: null,
          },
        }}
      />
    )
    expect(screen.getByText('6.61×')).toBeInTheDocument()
    expect(screen.getByText('2.9684 mL')).toBeInTheDocument()
    expect(screen.queryByText('not determined')).not.toBeInTheDocument()
  })
})
