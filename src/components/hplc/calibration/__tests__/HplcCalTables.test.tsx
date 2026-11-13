import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type * as ApiModule from '@/lib/api'
import {
  getCalSheet,
  getInstruments,
  getPeptides,
  saveCalSheet,
} from '@/lib/api'
import type { CalInputs } from '@/lib/hplc-calibration'
import { resetCalSaves } from '@/services/hplc-calibration-sheets'
import {
  DILUTION_COLUMNS,
  PEAK_COLUMNS,
  STOCK_COLUMNS,
} from '../cal-sheet-columns'
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

function open(inputs: CalInputs) {
  vi.mocked(getCalSheet).mockResolvedValue(makeSheet(inputs))
  renderSheet()
}

/** The text of a worked-out cell, by its table and column label and row. */
function cell(table: HTMLElement, label: string, row: number) {
  const heads = within(table)
    .getAllByRole('columnheader')
    .map(h => h.textContent)
  const col = heads.indexOf(label)
  const tr = within(table).getAllByRole('row')[row + 1] as HTMLElement
  return (tr.children[col] as HTMLElement).textContent
}

const tables = () => screen.getAllByRole('table')

describe('HplcCalTables', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetCalSaves()
    vi.mocked(getPeptides).mockResolvedValue([])
    vi.mocked(getInstruments).mockResolvedValue([])
    vi.mocked(saveCalSheet).mockImplementation(
      () => new Promise(() => undefined)
    )
  })

  it('lays out Steps 1, 1b, 2, 3 and 4 with the source labels in order', async () => {
    open(fixtureCase(1).inputs as CalInputs)
    await screen.findByText('Curve name:', { exact: false })
    const heads = screen
      .getAllByRole('heading', { level: 3 })
      .map(h => h.textContent)
    expect(heads).toEqual([
      'Step 1The standard',
      'Step 1bNet peptide weight',
      'Step 2Stock',
      'Step 3Serial dilution',
      'Step 4Peak areas and the curve',
      'Notes',
    ])
    const [t2, t3, t4] = tables() as HTMLElement[]
    for (const [t, cols] of [
      [t2, STOCK_COLUMNS],
      [t3, DILUTION_COLUMNS],
      [t4, PEAK_COLUMNS],
    ] as const)
      expect(
        within(t as HTMLElement)
          .getAllByRole('columnheader')
          .map(h => h.textContent)
      ).toEqual(cols.map(c => c.label))
    expect(STOCK_COLUMNS.map(c => c.label)).toEqual([
      'Stock Vial + cap (mg)',
      'Stock Vial + cap + Standard (mg)',
      'Stock weight (mg)',
      'Diluent to add (uL)',
      'Stock Vial + cap + Standard + Diluent (mg)',
      'Actual Diluent (uL)',
      'Stock, as weighed (ug/mL)',
      'Net peptide weight (mg)',
      'Stock, net peptide (ug/mL)',
    ])
    for (const label of [
      'Compound',
      'Instrument',
      'LIMS Sample # / Standard',
      'CAS number',
      'Standard Supplier',
      'Lot #',
      'Weight from COA (mg)',
      'Diluent density (mg/mL)',
      'Level volume (uL)',
      'Counterion',
      'Equivalents (n)',
      'Free-peptide MW (g/mol)',
      'Stated FW on the CoA (g/mol)',
      'Mass spec on the CoA (m/z)',
      'Ion',
      'CoA assay (%)',
      'Water, Karl Fischer (%)',
      'Counterion assumption, in words',
      'Use a different factor',
      'Why',
    ])
      expect(screen.getByLabelText(label)).toBeInTheDocument()
    expect(screen.getByLabelText('Diluent density (mg/mL)')).toHaveAttribute(
      'placeholder',
      '997.1'
    )
    expect(screen.getByLabelText('Level volume (uL)')).toHaveAttribute(
      'placeholder',
      '1500'
    )
    expect(screen.getByLabelText('CoA assay (%)')).toHaveAttribute(
      'placeholder',
      '100'
    )
    // no em dash anywhere on the page
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014))
  })

  it('works out the stock and every level live from the typed weighings', async () => {
    open(fixtureCase(1).inputs as CalInputs)
    await screen.findByText('Curve name:', { exact: false })
    const [t2, t3] = tables() as HTMLElement[]
    expect(cell(t2 as HTMLElement, 'Stock, net peptide (ug/mL)', 0)).toBe(
      '2047.95'
    )
    expect(cell(t3 as HTMLElement, 'Actual (ug/mL)', 0)).toBe('1003.6205')
    // a weighing typed: worked out at once, before any save answers
    typeAndLeave(
      screen.getByLabelText('Stock, Stock Vial + cap + Standard (mg)'),
      '15731.14'
    )
    expect(cell(t2 as HTMLElement, 'Stock weight (mg)', 0)).toBe('4.05')
    expect(cell(t2 as HTMLElement, 'Stock, net peptide (ug/mL)', 0)).not.toBe(
      '2047.95'
    )
  })

  it('applies the net factor before the stock concentration', async () => {
    open(fixtureCase(4).inputs as CalInputs)
    await screen.findByText('Curve name:', { exact: false })
    expect(
      cell(tables()[0] as HTMLElement, 'Stock, net peptide (ug/mL)', 0)
    ).toBe('1860.30')
    expect(screen.getByTestId('net-summary').textContent).toMatch(/^Stated FW/)
  })

  it('an override shows both factors and needs a reason', async () => {
    const c7 = fixtureCase(7).inputs as CalInputs
    open(c7)
    await screen.findByText('Curve name:', { exact: false })
    const factors = screen.getByTestId('net-factors').textContent
    expect(factors).toContain('Worked out: 0.9084')
    expect(factors).toContain('Used for the stock: 0.8500')
    expect(screen.queryByText('Must be fixed before filing')).toBeNull()
    // case 8: the same override with its reason cleared
    typeAndLeave(screen.getByLabelText('Why'), '')
    const warnings = screen.getByTestId('warnings')
    const first = within(warnings).getAllByRole('listitem')[0] as HTMLElement
    expect(first.textContent).toContain('Must be fixed before filing')
    expect(first.textContent).toContain('the factor is entered by hand')
  })

  it('marks a weighing that goes backwards and blanks the levels below', async () => {
    open(fixtureCase(14).inputs as CalInputs)
    await screen.findByText('Curve name:', { exact: false })
    const t3 = tables()[1] as HTMLElement
    const bad = within(t3)
      .getAllByRole('row')
      .slice(1)
      .findIndex(r => r.getAttribute('data-problem') === 'diluent')
    expect(bad).toBeGreaterThanOrEqual(0)
    const rows = within(t3).getAllByRole('row').slice(1)
    const box = within(rows[bad] as HTMLElement).getByLabelText(
      /Vial, cap and Diluent \(mg\)/
    )
    expect(box).toHaveAttribute('data-flagged', 'true')
    expect(box).toHaveAccessibleDescription(/weighings go backwards/)
    expect(box).toHaveAttribute('title', expect.stringMatching(/backwards/))
    for (let i = bad; i < rows.length; i++)
      expect(cell(t3, 'Actual (ug/mL)', i)).toBe('-')
    // several warnings, one per line
    expect(
      within(screen.getByTestId('warnings')).getAllByRole('listitem').length
    ).toBe(4)
  })

  it('disables the top level weighings when the stock is the top level', async () => {
    open(fixtureCase(17).inputs as CalInputs)
    await screen.findByText('Curve name:', { exact: false })
    expect(
      screen.getByLabelText('Stock is the top level', { exact: false })
    ).toBeChecked()
    expect(screen.getByLabelText('Aliquot (uL)')).toBeInTheDocument()
    const row0 = within(tables()[1] as HTMLElement).getAllByRole(
      'row'
    )[1] as HTMLElement
    for (const label of [
      'Vial and cap (mg)',
      'Vial, cap and Diluent (mg)',
      'Vial, cap, Diluent and Std (mg)',
    ]) {
      const box = within(row0).getByLabelText(
        new RegExp(`, ${label.replace(/[()]/g, '\\$&')}$`)
      )
      expect(box).toBeDisabled()
      expect(box).toHaveAttribute('placeholder', 'stock')
    }
    expect(within(row0).getByLabelText(/Target/)).not.toBeDisabled()
  })

  it('Enter goes down a column, as on the prep sheet', async () => {
    open(fixtureCase(1).inputs as CalInputs)
    await screen.findByText('Curve name:', { exact: false })
    const t3 = tables()[1] as HTMLElement
    const vials = within(t3).getAllByLabelText(/, Vial and cap \(mg\)$/)
    ;(vials[0] as HTMLElement).focus()
    fireEvent.keyDown(vials[0] as HTMLElement, { key: 'Enter' })
    expect(document.activeElement).toBe(vials[1])
    fireEvent.keyDown(vials[1] as HTMLElement, { key: 'Tab' })
    expect(document.activeElement).toBe(vials[2])
  })

  it('the counterion select offers None, the five table entries and Other', async () => {
    open(fixtureCase(1).inputs as CalInputs)
    await screen.findByText('Curve name:', { exact: false })
    const sel = screen.getByLabelText('Counterion')
    expect(
      within(sel)
        .getAllByRole('option')
        .map(o => o.textContent)
    ).toEqual([
      'None',
      'Acetate (60.05)',
      'TFA (114.02)',
      'HCl (36.46)',
      'Iodide (126.90)',
      'Sodium (21.98)',
      'Other, type the mass',
    ])
    expect(screen.queryByLabelText('Counterion mass (g/mol per eq)')).toBeNull()
    fireEvent.change(sel, { target: { value: 'Other' } })
    await waitFor(() =>
      expect(
        screen.getByLabelText('Counterion mass (g/mol per eq)')
      ).toBeInTheDocument()
    )
  })
})
