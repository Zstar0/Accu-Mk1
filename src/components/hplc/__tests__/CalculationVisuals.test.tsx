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

// The wording a tech reads for each problem code, exactly. Written out here on purpose,
// not imported: the component's copy is what is under test, so a typo in any sentence
// there fails its own case below instead of passing against itself. These are the nine
// codes a tech can meet. `dilution_incomplete` is deliberately absent: it prints raw
// (see the fallback test).
const PROBLEM_WORDING = {
  stock_diluent:
    'The stock vial weighings need checking: the empty vial and the vial with diluent must both be entered, and the vial with diluent must be heavier.',
  diluent:
    'The dilution vial weighings need checking: the empty vial and the vial with diluent must both be entered, and the vial with diluent must not be lighter.',
  stock:
    'The dilution vial weighings need checking: the vial with diluent and the vial with sample must both be entered, and the vial with sample must be heavier.',
  intermediate_unweighed:
    'The intermediate vial weighings need checking: the empty vial, the vial with diluent and the vial with sample must all be entered.',
  intermediate_diluent:
    'The intermediate vial weighings need checking: the vial with diluent must not be lighter than the empty vial.',
  intermediate_stock:
    'The intermediate vial weighings need checking: the vial with sample must be heavier than the vial with diluent.',
  no_density:
    'The calibration curve has no usable diluent density. This is not a weighing problem: the density needs setting on the curve.',
  no_declared_volume:
    'This liquid sample has no usable declared volume. This is not a weighing problem: record the volume the sample arrived in.',
  quantity_not_finite:
    'The calculation produced a number that is not valid. This is not something to fix at the bench; it needs looking at.',
}

// One row per code, captured from process_hplc_analysis (not hand-built): the dilution
// and quantity sections it stores. Each problem nulls only what it touches, so the
// dilution panel's label follows which of the dilution factor and the stock volume is
// null: stock_diluent and no_declared_volume keep the factor, diluent and stock keep
// the stock volume, the intermediate codes keep both and lose the total.
const CAPTURED_ROWS = {
  stock_diluent: {
    dilution: {
      diluent_mass_mg: 1234.66,
      diluent_vol_ul: 1238.2509,
      sample_mass_mg: 219.93,
      sample_vol_ul: 220.5697,
      total_vol_ul: 1458.8206,
      dilution_factor: 6.613877,
      stock_mass_mg: 0.0,
      stock_volume_ml: null,
      problem: 'stock_diluent',
      form: 'powder',
      dilution_factor_total: 6.613877,
      intermediate: null,
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
  },
  diluent: {
    dilution: {
      diluent_mass_mg: -1234.66,
      diluent_vol_ul: -1238.2509,
      sample_mass_mg: 1454.59,
      sample_vol_ul: 1458.8206,
      total_vol_ul: 220.5697,
      dilution_factor: null,
      stock_mass_mg: 2959.75,
      stock_volume_ml: 2.968358,
      problem: 'diluent',
      form: 'powder',
      dilution_factor_total: null,
      intermediate: null,
    },
    quantity: {
      quantity_mg: null,
      error: 'diluent',
      individual_areas: [1125.3809],
      avg_main_peak_area: 1125.3809,
      concentration_ug_ml: 73.4453,
      calibration_slope: 15.782452,
      calibration_intercept: -33.766783,
    },
  },
  stock: {
    dilution: {
      diluent_mass_mg: 1234.66,
      diluent_vol_ul: 1238.2509,
      sample_mass_mg: 0.0,
      sample_vol_ul: 0.0,
      total_vol_ul: 1238.2509,
      dilution_factor: null,
      stock_mass_mg: 2959.75,
      stock_volume_ml: 2.968358,
      problem: 'stock',
      form: 'powder',
      dilution_factor_total: null,
      intermediate: null,
    },
    quantity: {
      quantity_mg: null,
      error: 'stock',
      individual_areas: [1125.3809],
      avg_main_peak_area: 1125.3809,
      concentration_ug_ml: 73.4453,
      calibration_slope: 15.782452,
      calibration_intercept: -33.766783,
    },
  },
  no_density: {
    dilution: {
      diluent_mass_mg: 1234.66,
      diluent_vol_ul: null,
      sample_mass_mg: 219.93,
      sample_vol_ul: null,
      total_vol_ul: null,
      dilution_factor: null,
      stock_mass_mg: 2959.75,
      stock_volume_ml: null,
      problem: 'no_density',
      form: 'powder',
      dilution_factor_total: null,
      intermediate: null,
    },
    quantity: {
      quantity_mg: null,
      error: 'no_density',
      individual_areas: [1125.3809],
      avg_main_peak_area: 1125.3809,
      concentration_ug_ml: 73.4453,
      calibration_slope: 15.782452,
      calibration_intercept: -33.766783,
    },
  },
  no_declared_volume: {
    dilution: {
      diluent_mass_mg: 1234.66,
      diluent_vol_ul: 1238.2509,
      sample_mass_mg: 219.93,
      sample_vol_ul: 220.5697,
      total_vol_ul: 1458.8206,
      dilution_factor: 6.613877,
      stock_mass_mg: null,
      stock_volume_ml: null,
      problem: 'no_declared_volume',
      form: 'liquid',
      dilution_factor_total: 6.613877,
      intermediate: null,
    },
    quantity: {
      quantity_mg: null,
      error: 'no_declared_volume',
      individual_areas: [1125.3809],
      avg_main_peak_area: 1125.3809,
      concentration_ug_ml: 73.4453,
      calibration_slope: 15.782452,
      calibration_intercept: -33.766783,
    },
  },
  intermediate_unweighed: {
    dilution: {
      diluent_mass_mg: 1234.66,
      diluent_vol_ul: 1238.2509,
      sample_mass_mg: 219.93,
      sample_vol_ul: 220.5697,
      total_vol_ul: 1458.8206,
      dilution_factor: 6.613877,
      stock_mass_mg: 2959.75,
      stock_volume_ml: 2.968358,
      problem: 'intermediate_unweighed',
      form: 'powder',
      dilution_factor_total: null,
      intermediate: {
        diluent_vol_ul: null,
        stock_vol_ul: null,
        total_vol_ul: null,
        dilution_factor: null,
        problem: null,
      },
    },
    quantity: {
      quantity_mg: null,
      error: 'intermediate_unweighed',
      individual_areas: [1125.3809],
      avg_main_peak_area: 1125.3809,
      concentration_ug_ml: 73.4453,
      calibration_slope: 15.782452,
      calibration_intercept: -33.766783,
    },
  },
  intermediate_diluent: {
    dilution: {
      diluent_mass_mg: 1234.66,
      diluent_vol_ul: 1238.2509,
      sample_mass_mg: 219.93,
      sample_vol_ul: 220.5697,
      total_vol_ul: 1458.8206,
      dilution_factor: 6.613877,
      stock_mass_mg: 2959.75,
      stock_volume_ml: 2.968358,
      problem: 'intermediate_diluent',
      form: 'powder',
      dilution_factor_total: null,
      intermediate: {
        diluent_vol_ul: -100.2908,
        stock_vol_ul: 110.3199,
        total_vol_ul: null,
        dilution_factor: null,
        problem: 'diluent',
      },
    },
    quantity: {
      quantity_mg: null,
      error: 'intermediate_diluent',
      individual_areas: [1125.3809],
      avg_main_peak_area: 1125.3809,
      concentration_ug_ml: 73.4453,
      calibration_slope: 15.782452,
      calibration_intercept: -33.766783,
    },
  },
  intermediate_stock: {
    dilution: {
      diluent_mass_mg: 1234.66,
      diluent_vol_ul: 1238.2509,
      sample_mass_mg: 219.93,
      sample_vol_ul: 220.5697,
      total_vol_ul: 1458.8206,
      dilution_factor: 6.613877,
      stock_mass_mg: 2959.75,
      stock_volume_ml: 2.968358,
      problem: 'intermediate_stock',
      form: 'powder',
      dilution_factor_total: null,
      intermediate: {
        diluent_vol_ul: 100.2908,
        stock_vol_ul: 0.0,
        total_vol_ul: null,
        dilution_factor: null,
        problem: 'stock',
      },
    },
    quantity: {
      quantity_mg: null,
      error: 'intermediate_stock',
      individual_areas: [1125.3809],
      avg_main_peak_area: 1125.3809,
      concentration_ug_ml: 73.4453,
      calibration_slope: 15.782452,
      calibration_intercept: -33.766783,
    },
  },
  quantity_not_finite: {
    dilution: {
      diluent_mass_mg: 1234.66,
      diluent_vol_ul: 1238.2509,
      sample_mass_mg: 219.93,
      sample_vol_ul: 220.5697,
      total_vol_ul: 1458.8206,
      dilution_factor: 6.613877,
      stock_mass_mg: 2959.75,
      stock_volume_ml: 2.968358,
      problem: null,
      form: 'powder',
      dilution_factor_total: 6.613877,
      intermediate: null,
    },
    quantity: {
      quantity_mg: null,
      error: 'quantity_not_finite',
      individual_areas: [1e300],
      avg_main_peak_area: 1e300,
      concentration_ug_ml: null,
      calibration_slope: 1e-310,
      calibration_intercept: 0.0,
    },
  },
}

const NON_FINITE_STOCK_ROW = {
  dilution: {
    diluent_mass_mg: 1234.66,
    diluent_vol_ul: 1238.2509,
    sample_mass_mg: 219.93,
    sample_vol_ul: 220.5697,
    total_vol_ul: 1458.8206,
    dilution_factor: 6.613877,
    stock_mass_mg: null,
    stock_volume_ml: null,
    problem: 'stock_diluent',
    form: 'powder',
    dilution_factor_total: 6.613877,
    intermediate: null,
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
}

// What the dilution panel says it could not work out, per code. null: the code is only
// ever the quantity panel's reason (dilution.problem is null on its row).
const DILUTION_LABEL: [keyof typeof PROBLEM_WORDING, string | null][] = [
  ['stock_diluent', 'Stock volume'],
  ['diluent', 'Dilution factor'],
  ['stock', 'Dilution factor'],
  ['no_density', 'Dilution factor and stock volume'],
  ['no_declared_volume', 'Stock volume'],
  ['intermediate_unweighed', 'Total dilution factor'],
  ['intermediate_diluent', 'Total dilution factor'],
  ['intermediate_stock', 'Total dilution factor'],
  ['quantity_not_finite', null],
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
      document.body.textContent?.split(PROBLEM_WORDING.stock_diluent)
    ).toHaveLength(3)
  })

  // The whole visible message, not a fragment of it: the label before the colon and the
  // sentence after it, matched in full, so a typo that changes or appends text fails.
  it.each(DILUTION_LABEL)(
    'says %s in full in every panel it can reach',
    (code, label) => {
      const sentence = PROBLEM_WORDING[code]
      const { container } = render(
        <CalculationVisuals trace={CAPTURED_ROWS[code]} />
      )
      expect(
        screen.getByText(`Mass not determined: ${sentence}`)
      ).toBeInTheDocument()
      if (label) {
        expect(
          screen.getByText(`${label} not determined: ${sentence}`)
        ).toBeInTheDocument()
        expect(container.textContent?.split(sentence)).toHaveLength(3)
      } else {
        // quantity_not_finite is the quantity panel's reason only.
        expect(container.textContent?.split(sentence)).toHaveLength(2)
      }
    }
  )

  // dilution_incomplete is unreachable on any dilution the engine builds and has no copy
  // on purpose: it is the quantity gate failing closed if an engine invariant is broken,
  // and the raw code is the signal. Pinned so the omission reads as deliberate.
  it.each(['made_up_code', 'dilution_incomplete'])(
    'falls back to the raw code for %s, which has no wording',
    code => {
      const trace = {
        dilution: { ...FLAGGED_ROW_TRACE.dilution, problem: code },
      }
      const { container } = render(<CalculationVisuals trace={trace} />)
      expect(container.textContent).toContain(`not determined: ${code}`)
    }
  )

  it('shows the dilution factor and stock volume as not determined, with the reason', () => {
    expect(() =>
      render(<CalculationVisuals trace={{ dilution: PROBLEM_DILUTION }} />)
    ).not.toThrow()
    expect(screen.getAllByText('not determined')).toHaveLength(2)
    expect(
      screen.getByText(
        `Dilution factor and stock volume not determined: ${PROBLEM_WORDING.stock_diluent}`
      )
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
      screen.getByText(`Mass not determined: ${PROBLEM_WORDING.stock_diluent}`)
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
    expect(
      screen.getByText(
        `Dilution factor and stock volume not determined: ${PROBLEM_WORDING.no_density}`
      )
    ).toBeInTheDocument()
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
  form: 'liquid',
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
    // Nothing is undetermined: the stock vial mass does not exist for a liquid prep, and
    // the declared volume is the stock volume. A healthy row has no problem line at all.
    expect(screen.queryByText('not determined')).not.toBeInTheDocument()
    expect(screen.getByText('not applicable')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('not determined:')
    expect(screen.getByText('3.0000 mL')).toBeInTheDocument()
    expect(screen.getByText('6.61×')).toBeInTheDocument()
  })

  it('says not applicable for a liquid row with a problem, and not determined for what the problem stopped', () => {
    render(<CalculationVisuals trace={CAPTURED_ROWS.no_declared_volume} />)
    // The stock vial mass never existed; the stock volume is what the problem stopped.
    // The dilution factor is a number, and the undiluted concentration and mass are not.
    expect(screen.getByText('not applicable')).toBeInTheDocument()
    expect(screen.getAllByText('not determined')).toHaveLength(3)
    expect(screen.getByText('6.61×')).toBeInTheDocument()
  })

  it('says not determined for a powder stock mass that a non-finite weighing nulled', () => {
    render(<CalculationVisuals trace={NON_FINITE_STOCK_ROW} />)
    // The stock vial mass, the stock volume, the undiluted concentration and the mass.
    expect(screen.getAllByText('not determined')).toHaveLength(4)
    expect(screen.queryByText('not applicable')).not.toBeInTheDocument()
  })

  // The form is read from the trace, never guessed from which values are null. A powder
  // row whose stock mass is null under some code other than stock_diluent (a code that
  // does not exist today) must not start saying a measurement is inapplicable.
  it('says not determined for a powder row with a null stock mass, whatever the problem code', () => {
    const { dilution } = CAPTURED_ROWS.diluent
    render(
      <CalculationVisuals
        trace={{ dilution: { ...dilution, stock_mass_mg: null } }}
      />
    )
    // The dilution factor (this row's problem) and the stock vial mass.
    expect(screen.getAllByText('not determined')).toHaveLength(2)
    expect(screen.queryByText('not applicable')).not.toBeInTheDocument()
  })

  // A trace stored before the engine wrote the form was a powder row, so it stays "not
  // determined" instead of claiming a measurement is inapplicable.
  it('says not determined for a null stock mass on a trace that carries no form', () => {
    const legacy = { ...LIQUID_DILUTION, form: undefined }
    render(<CalculationVisuals trace={{ dilution: legacy }} />)
    expect(screen.getByText('not determined')).toBeInTheDocument()
    expect(screen.queryByText('not applicable')).not.toBeInTheDocument()
  })

  it('does not throw when the concentration itself overflowed', () => {
    // quantity_not_finite with concentration_ug_ml null: the Conc row cannot show a number.
    expect(() =>
      render(<CalculationVisuals trace={CAPTURED_ROWS.quantity_not_finite} />)
    ).not.toThrow()
    expect(screen.getAllByText('not determined').length).toBeGreaterThan(0)
  })

  it('captions the stock volume as mass over density, not over 1000', () => {
    render(<CalculationVisuals trace={{ dilution: LIQUID_DILUTION }} />)
    expect(screen.getByText(/Stock vol = mass \/ density/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('mass / 1000')
  })
})
