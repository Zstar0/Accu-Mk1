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

// The dilution trace calculate_dilution_factor stores when the calibration curve has no
// diluent density (problem "no_density"), captured from the engine on a prod-shaped row
// with the density None, not hand-built. A volume needs the density, so the three
// volumes are null while the masses stay numbers. isDilutionTrace only checks that the
// keys are present, so the block renders; before the volumes were read null-safely this
// threw on `null.toFixed`.
const NO_DENSITY_DILUTION = {
  diluent_mass_mg: 1234.66,
  diluent_vol_ul: null,
  sample_mass_mg: 219.93,
  sample_vol_ul: null,
  total_vol_ul: null,
  dilution_factor: null,
  stock_mass_mg: 2959.75,
  stock_volume_ml: null,
  problem: 'no_density',
  dilution_factor_total: null,
  intermediate: null,
}

const NO_DENSITY_QUANTITY = {
  quantity_mg: null,
  error: 'no_density',
  individual_areas: [7456.6389],
  avg_main_peak_area: 7456.6389,
  concentration_ug_ml: 822.9454,
  calibration_slope: 9.038015,
  calibration_intercept: 18.846082,
}

describe('CalculationVisuals with no diluent density', () => {
  it('shows the three volumes as not determined and keeps the masses', () => {
    expect(() =>
      render(<CalculationVisuals trace={{ dilution: NO_DENSITY_DILUTION }} />)
    ).not.toThrow()
    // Diluent, sample and total volume, then the dilution factor and the stock volume.
    expect(screen.getAllByText('not determined')).toHaveLength(5)
    expect(screen.getByText('1234.66 mg')).toBeInTheDocument()
    expect(screen.getByText('219.93 mg')).toBeInTheDocument()
    expect(screen.getByText('2959.75 mg')).toBeInTheDocument()
    // The raw code is pinned as it prints TODAY. It is not the wanted wording: Task 6
    // supplies the copy for no_density, and this line should change with it.
    expect(screen.getByText(/not determined: no_density/)).toBeInTheDocument()
  })

  it('renders the whole trace of a no_density row without throwing', () => {
    expect(() =>
      render(
        <CalculationVisuals
          trace={{
            dilution: NO_DENSITY_DILUTION,
            quantity: NO_DENSITY_QUANTITY,
          }}
        />
      )
    ).not.toThrow()
    // Five in the dilution panel; undiluted concentration and mass in the quantity panel.
    expect(screen.getAllByText('not determined')).toHaveLength(7)
    expect(screen.getByText('822.95 µg/mL')).toBeInTheDocument()
  })

  it('still prints the volumes when the density is there', () => {
    render(<CalculationVisuals trace={{ dilution: PROBLEM_DILUTION }} />)
    expect(screen.getByText('1238.2 µL')).toBeInTheDocument()
    expect(screen.getByText('220.6 µL')).toBeInTheDocument()
    expect(screen.getByText('1458.8 µL')).toBeInTheDocument()
  })
})

// Masses are null too: a non-finite weighing nulls the masses and volumes that need
// it, and a liquid row's stock vial is never weighed, so it has no mass. Both traces
// are captured from calculate_dilution_factor, not hand-built.
const NON_FINITE_WEIGHING_DILUTION = {
  diluent_mass_mg: null,
  diluent_vol_ul: null,
  sample_mass_mg: null,
  sample_vol_ul: null,
  total_vol_ul: null,
  dilution_factor: null,
  stock_mass_mg: 2959.75,
  stock_volume_ml: 2.968358,
  problem: 'diluent',
  dilution_factor_total: null,
  intermediate: null,
}

const LIQUID_DILUTION = {
  diluent_mass_mg: 1234.66,
  diluent_vol_ul: 1238.2509,
  sample_mass_mg: 219.93,
  sample_vol_ul: 220.5697,
  total_vol_ul: 1458.8206,
  dilution_factor: 6.613877,
  stock_mass_mg: null,
  stock_volume_ml: 3.0,
  problem: null,
  dilution_factor_total: 6.613877,
  intermediate: null,
}

describe('CalculationVisuals with null masses', () => {
  it('shows the masses and volumes a non-finite weighing nulled as not determined', () => {
    expect(() =>
      render(
        <CalculationVisuals
          trace={{ dilution: NON_FINITE_WEIGHING_DILUTION }}
        />
      )
    ).not.toThrow()
    // Two masses, three volumes and the dilution factor; the stock vial is fine.
    expect(screen.getAllByText('not determined')).toHaveLength(6)
    expect(screen.getByText('2959.75 mg')).toBeInTheDocument()
    expect(screen.getByText('2.9684 mL')).toBeInTheDocument()
  })

  it('renders a liquid row, whose stock vial was never weighed, without a stock mass', () => {
    expect(() =>
      render(<CalculationVisuals trace={{ dilution: LIQUID_DILUTION }} />)
    ).not.toThrow()
    // Only the stock vial mass is undetermined; the declared volume is the stock volume.
    expect(screen.getAllByText('not determined')).toHaveLength(1)
    expect(screen.getByText('3.0000 mL')).toBeInTheDocument()
    expect(screen.getByText('6.61×')).toBeInTheDocument()
  })

  it('captions the stock volume as mass over density, not over 1000', () => {
    render(<CalculationVisuals trace={{ dilution: LIQUID_DILUTION }} />)
    expect(screen.getByText(/Stock vol = mass \/ density/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('mass / 1000')
  })
})
