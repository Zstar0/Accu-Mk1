import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type * as ApiModule from '@/lib/api'
import type { Instrument, PeptideRecord } from '@/lib/api'
import type { HplcPrepRule } from '@/lib/hplc-prep-rules'
import { Table, TableBody } from '@/components/ui/table'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  createHplcPrepRule: vi.fn(),
  updateHplcPrepRule: vi.fn(),
}))

import { createHplcPrepRule, updateHplcPrepRule } from '@/lib/api'
import { RuleRow } from '@/components/hplc/prep/HplcPrepRuleBits'

// One rules-page row, rendered alone. Peptide 1 and 2 are single peptides,
// 3 is their blend.

function rule(over: Partial<HplcPrepRule> = {}): HplcPrepRule {
  return {
    id: 1,
    peptide_id: 1,
    min_mg: null,
    max_mg: null,
    target_conc_ug_ml: null,
    blend_target_conc_ug_ml: null,
    lead_component_id: null,
    lead_priority: null,
    floor_ug_ml: null,
    diluent: null,
    default_instrument_id: null,
    status: 'trial',
    note: null,
    sort_order: 0,
    active: true,
    peptide_name: 'BPC-157',
    peptide_is_blend: false,
    lead_component_name: null,
    default_instrument_name: null,
    updated_at: null,
    ...over,
  }
}

const PEPTIDES = [
  { id: 1, name: 'BPC-157', abbreviation: 'BPC', components: [] },
  { id: 2, name: 'TB-500', abbreviation: 'TB', components: [] },
  {
    id: 3,
    name: 'BPC-157 + TB-500',
    abbreviation: 'BLEND',
    is_blend: true,
    components: [
      { id: 1, name: 'BPC-157', abbreviation: 'BPC' },
      { id: 2, name: 'TB-500', abbreviation: 'TB' },
    ],
  },
].map(p => ({ active: true, is_blend: false, ...p }) as PeptideRecord)

const INSTRUMENTS = [{ id: 5, name: 'HPLC 1', active: true } as Instrument]

const BLEND = rule({
  id: 7,
  peptide_id: 3,
  peptide_name: 'BPC-157 + TB-500',
  peptide_is_blend: true,
})

function setup(r: HplcPrepRule | null) {
  const onSaved = vi.fn()
  render(
    <Table>
      <TableBody>
        <RuleRow
          n={r ? 1 : null}
          rule={r}
          peptides={PEPTIDES}
          instruments={INSTRUMENTS}
          warnings={[]}
          canUp={false}
          canDown={false}
          moving={false}
          onMove={() => undefined}
          onSaved={onSaved}
        />
      </TableBody>
    </Table>
  )
  const row = document.querySelector<HTMLElement>('tr[data-rule]')
  if (!row) throw new Error('no row')
  return { row, onSaved }
}

const selected = (el: HTMLElement) =>
  (el as HTMLSelectElement).selectedOptions[0]?.textContent

describe('HPLC prep rule row', () => {
  beforeEach(() => vi.clearAllMocks())

  it('offers the blend components as the lead on a blend line and a rank box otherwise', () => {
    const blend = setup(BLEND).row
    const lead = within(blend).getByRole('combobox', { name: 'Lead' })
    expect(
      within(lead)
        .getAllByRole('option')
        .map(o => o.textContent)
    ).toEqual(['by the usual rule', 'BPC-157', 'TB-500'])
    expect(selected(lead)).toBe('by the usual rule')
    // a blend line has no target of its own as a blend component
    expect(
      within(blend).queryByLabelText('Target in a blend (ug/mL)')
    ).not.toBeInTheDocument()
    expect(
      within(blend).queryByLabelText('leads blends, rank')
    ).not.toBeInTheDocument()
    // column 4 is Target in a blend: a dash
    expect(blend.querySelectorAll('td')[4]).toHaveTextContent(/^-$/)
    cleanup()

    const solo = setup(rule()).row
    expect(
      within(solo).queryByRole('combobox', { name: 'Lead' })
    ).not.toBeInTheDocument()
    expect(within(solo).getByLabelText('leads blends, rank')).toHaveValue('')
    expect(
      within(solo).getByLabelText('Target in a blend (ug/mL)')
    ).toBeInTheDocument()
  })

  it('saves a lead on a blend line and a whole-number rank on a component line', async () => {
    vi.mocked(updateHplcPrepRule).mockResolvedValue({
      rule: { ...BLEND, lead_component_id: 2, lead_component_name: 'TB-500' },
      warnings: [],
    })
    const blend = setup(BLEND).row
    fireEvent.change(within(blend).getByRole('combobox', { name: 'Lead' }), {
      target: { value: '2' },
    })
    fireEvent.click(within(blend).getByRole('button', { name: 'Save' }))
    expect(updateHplcPrepRule).toHaveBeenLastCalledWith(7, {
      lead_component_id: 2,
    })
    await waitFor(() =>
      expect(within(blend).getByRole('button', { name: 'Save' })).toBeEnabled()
    )
    cleanup()

    const solo = setup(rule()).row
    fireEvent.change(within(solo).getByLabelText('leads blends, rank'), {
      target: { value: '1.5' },
    })
    fireEvent.click(within(solo).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not saved: leads blends, rank must be a whole number'
    )
    expect(updateHplcPrepRule).toHaveBeenCalledTimes(1)
  })

  it('shows the method default as the placeholder of a blank target, floor and diluent', () => {
    const { row } = setup(null)
    expect(within(row).getByLabelText('Target Conc (ug/mL)')).toHaveAttribute(
      'placeholder',
      '200'
    )
    expect(within(row).getByLabelText('Floor (ug/mL)')).toHaveAttribute(
      'placeholder',
      '60'
    )
    const diluent = within(row).getByLabelText('Diluent')
    expect(diluent).toHaveValue('')
    expect(selected(diluent)).toMatch(/^Water\b/)
  })

  it('sends an explicit null when a value is cleared, never 0', async () => {
    const stored = rule({
      target_conc_ug_ml: 125,
      blend_target_conc_ug_ml: 350,
      lead_priority: 2,
      floor_ug_ml: 50,
      diluent: 'Water + 0.1% TFA',
      default_instrument_id: 5,
      default_instrument_name: 'HPLC 1',
    })
    vi.mocked(updateHplcPrepRule).mockResolvedValue({
      rule: rule(),
      warnings: [],
    })
    const { row, onSaved } = setup(stored)
    for (const label of [
      'Target Conc (ug/mL)',
      'Target in a blend (ug/mL)',
      'leads blends, rank',
      'Floor (ug/mL)',
    ])
      fireEvent.change(within(row).getByLabelText(label), {
        target: { value: '' },
      })
    for (const label of ['Diluent', 'Instrument'])
      fireEvent.change(within(row).getByLabelText(label), {
        target: { value: '' },
      })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    expect(updateHplcPrepRule).toHaveBeenCalledWith(1, {
      target_conc_ug_ml: null,
      blend_target_conc_ug_ml: null,
      lead_priority: null,
      floor_ug_ml: null,
      diluent: null,
      default_instrument_id: null,
    })
    expect(createHplcPrepRule).not.toHaveBeenCalled()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    await waitFor(() =>
      expect(within(row).getByRole('button', { name: 'Save' })).toBeEnabled()
    )
  })
})
