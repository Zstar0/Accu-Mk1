import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AnalysisResults } from '../AnalysisResults'
import type { HPLCAnalysisResult } from '@/lib/api'

// The summary card under Quantity. A row whose weighings were flagged has a null
// dilution factor and stock volume; the line must say so, not print bare units.
function result(over: Partial<HPLCAnalysisResult>): HPLCAnalysisResult {
  return {
    id: 1,
    sample_id_label: 'P-0001',
    peptide_id: 1,
    peptide_abbreviation: 'RETA',
    purity_percent: 99.8821,
    quantity_mg: null,
    identity_conforms: true,
    identity_rt_delta: 0.05,
    dilution_factor: null,
    stock_volume_ml: null,
    avg_main_peak_area: 1125.3809,
    concentration_ug_ml: 73.4453,
    calculation_trace: null,
    ...over,
  } as HPLCAnalysisResult
}

describe('AnalysisResults quantity summary', () => {
  it('says the dilution factor and stock volume are not determined when they are null', () => {
    render(<AnalysisResults result={result({})} hideTrace />)
    expect(
      screen.getByText('DF: not determined | Stock: not determined')
    ).toBeInTheDocument()
  })

  it('still prints the numbers when they exist', () => {
    render(
      <AnalysisResults
        result={result({
          quantity_mg: 8.645,
          dilution_factor: 48.988911,
          stock_volume_ml: 3.030498,
        })}
        hideTrace
      />
    )
    expect(
      screen.getByText('DF: 48.99× | Stock: 3.0305 mL')
    ).toBeInTheDocument()
  })
})
