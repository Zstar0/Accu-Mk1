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

describe('CalculationVisuals with a weighing problem', () => {
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
