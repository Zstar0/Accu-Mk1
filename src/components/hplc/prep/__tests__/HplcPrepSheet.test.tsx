import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { HplcSheetRow } from '@/lib/api'
import type { HplcPrepRule } from '@/lib/hplc-prep-rules'
import { HplcPrepSheet } from '../HplcPrepSheet'
import {
  fixtureCase,
  INSTRUMENTS,
  makeRow,
  makeSheet,
  rowFromCase,
} from './hplc-sheet-fixtures'

function renderSheet(
  rows: HplcSheetRow[],
  { readOnly = false, status = 'open', rules = [] as HplcPrepRule[] } = {}
) {
  const onPatch = vi.fn()
  const onSetInstrument = vi.fn()
  render(
    <HplcPrepSheet
      sheet={makeSheet(rows, status)}
      rules={rules}
      readOnly={readOnly}
      instruments={INSTRUMENTS}
      onPatch={onPatch}
      onSetInstrument={onSetInstrument}
    />
  )
  return { onPatch, onSetInstrument }
}

const step2 = () =>
  screen.getByRole('region', {
    name: 'Step 2 Peptide sample stock preparation',
  })
const step3 = () =>
  screen.getByRole('region', {
    name: 'Step 3 Peptide dilution into the autosampler vial',
  })

// The boxes' accessible names: "<sample id>, <column label>".
const S1 = 'P-0120-S01'
const S2 = 'P-0121-S01'
const VIAL = 'Wt Customer Sample vial and Septum (mg)'
const VIAL_DIL = 'Wt Customer Sample vial and Septum + Diluent (mg)'
const AS_VIAL = 'Wt Autosampler vial and cap (mg)'
const box = (name: string) => screen.getByRole('textbox', { name })
const select = (name: string) => screen.getByRole('combobox', { name })

/** Types into a box and leaves it, as a tech tabs on. */
function typeAndLeave(el: HTMLElement, text: string) {
  fireEvent.focus(el)
  fireEvent.change(el, { target: { value: text } })
  fireEvent.blur(el)
}

const headers = (region: HTMLElement) =>
  within(region)
    .getAllByRole('columnheader')
    .map(h => h.textContent)

const twoRows = () => [
  makeRow({ hplc_prep: { stock_vial_mg: 5012.31 } }),
  makeRow({ item_id: 312, sample_id: S2, hplc_prep: { stock_vial_mg: 5100 } }),
]

function rule(over: Partial<HplcPrepRule>): HplcPrepRule {
  return {
    id: 1,
    peptide_id: 10,
    min_mg: null,
    max_mg: null,
    target_conc_ug_ml: null,
    blend_target_conc_ug_ml: null,
    lead_component_id: null,
    lead_priority: null,
    floor_ug_ml: null,
    diluent: null,
    default_instrument_id: null,
    status: 'validated',
    note: null,
    sort_order: 1,
    active: true,
    peptide_name: 'BPC-157',
    peptide_is_blend: false,
    lead_component_name: null,
    default_instrument_name: null,
    updated_at: null,
    ...over,
  }
}

describe('HplcPrepSheet', () => {
  it('renders Step 2 and Step 3 with the source labels, in the source order', () => {
    renderSheet([makeRow()])
    expect(headers(step2())).toEqual([
      'Sample ID',
      'Sample Identity',
      'Declared Peptide Wt (mg)',
      'Form',
      'Instrument',
      'Diluent',
      VIAL,
      'Diluent to add (uL)',
      VIAL_DIL,
      'Total Diluent added (mL)',
      'Peptide Stock Conc (ug/mL)',
      '2-step dilution',
    ])
    expect(
      within(step2()).getByRole('columnheader', {
        name: 'Peptide Stock Conc (ug/mL)',
      })
    ).toHaveAttribute(
      'title',
      "Declared Peptide Wt × 1000 ÷ Total Diluent added. For a blend: the lead component's weight (Step 2b) × 1000 ÷ Total Diluent added."
    )
    expect(headers(step3())).toEqual([
      'Sample ID',
      'Sample Identity',
      'Diluent',
      'Diluting from (ug/mL)',
      'Target Conc (ug/mL)',
      'Target Total Vol (uL)',
      AS_VIAL,
      'Diluent Vol to Add (uL), total',
      'half',
      'Wt Autosampler vial and cap + Diluent (mg)',
      'Stock Vol to Add (uL), total',
      'half',
      'Wt of Vial, cap, Diluent + Sample (mg)',
      'Actual Diluent Volume added (uL)',
      'Actual Stock Vol added (uL)',
      'Actual Total Volume (uL)',
      'Actual Conc (ug/mL)',
      'Total Dilution Factor',
    ])
    expect(
      screen.getByText(
        'What is in the customer sample vial and which instrument. Weigh that vial with its septum, add the diluent, weigh again.'
      )
    ).toBeInTheDocument()
    // the standard shows as each box's placeholder until something is typed
    expect(box(`${S1}, Target Conc (ug/mL)`)).toHaveAttribute(
      'placeholder',
      '200'
    )
    expect(box(`${S1}, Target Total Vol (uL)`)).toHaveAttribute(
      'placeholder',
      '1500'
    )
  })

  it('keeps the source arrows and leaves out the instrument-naming sentence', () => {
    renderSheet([makeRow()])
    const identity = within(step2()).getByRole('columnheader', {
      name: 'Sample Identity',
    })
    expect(identity.title).toContain('Lab rules → Blend shorthand')
    expect(identity.title).not.toContain('sets the dropdown')
    expect(
      within(step2()).getByRole('columnheader', { name: 'Diluent' }).title
    ).toContain('Lab rules → Diluent by peptide')
    expect(
      within(step3()).getByRole('columnheader', {
        name: 'Total Dilution Factor',
      }).title
    ).toMatch(/^Stock → final vial\./)
  })

  it('names every box with its sample id and column, and ties its hint to it', () => {
    renderSheet([
      makeRow({ form: 'capsule' }),
      makeRow({ item_id: 312, sample_id: S2 }),
    ])
    for (const s of [S1, S2]) {
      expect(box(`${s}, Declared Peptide Wt (mg)`)).toBeInTheDocument()
      expect(select(`${s}, Form`)).toBeInTheDocument()
      expect(select(`${s}, Instrument`)).toBeInTheDocument()
      expect(select(`${s}, Diluent`)).toBeInTheDocument()
      expect(box(`${s}, ${VIAL}`)).toBeInTheDocument()
      expect(box(`${s}, Diluent to add (uL)`)).toBeInTheDocument()
      expect(box(`${s}, ${VIAL_DIL}`)).toBeInTheDocument()
      expect(select(`${s}, 2-step dilution`)).toBeInTheDocument()
      expect(box(`${s}, ${AS_VIAL}`)).toBeInTheDocument()
    }
    expect(box(`${S1}, Declared Peptide Wt (mg)`)).toHaveAccessibleDescription(
      'per capsule'
    )
  })

  it('names a Step 3 box with its vial letter when the row has more than one vial', () => {
    renderSheet([
      makeRow({
        identity: 'Tesamorelin + Ipamorelin',
        peptide_id: 21,
        is_blend: true,
        components: [
          { peptide_id: 11, name: 'Tesamorelin', declared_mg: 5, vial: 1 },
          { peptide_id: 4, name: 'Ipamorelin', declared_mg: 5, vial: 2 },
        ],
      }),
    ])
    expect(box(`${S1}, ${AS_VIAL}, vial A`)).toBeInTheDocument()
    expect(box(`${S1}, ${AS_VIAL}, vial B`)).toBeInTheDocument()
  })

  it('shows peptide_name when the row has no identity', () => {
    renderSheet([makeRow({ identity: null, peptide_name: 'BPC-157 (named)' })])
    expect(within(step2()).getByText('BPC-157 (named)')).toBeInTheDocument()
  })

  it('shows the worked-out stock concentration and plan from the typed weighings', () => {
    const name = 'powder, fully weighed, one step'
    const exp = fixtureCase(name).expect as {
      stock: { total_diluent_ml: number }
      vials: [
        {
          stock_conc_ug_ml: number
          plan: Record<
            | 'diluent_vol_ul'
            | 'diluent_half_ul'
            | 'stock_vol_ul'
            | 'stock_half_ul',
            number
          >
          actual: Record<
            | 'actual_diluent_ul'
            | 'actual_stock_ul'
            | 'actual_total_ul'
            | 'actual_conc_ug_ml',
            number
          >
          dilution_factor_total: number
        },
      ]
    }
    const [v] = exp.vials
    renderSheet([rowFromCase(name)])
    const s2 = within(step2())
    expect(
      s2.getByText(exp.stock.total_diluent_ml.toFixed(4))
    ).toBeInTheDocument()
    expect(s2.getByText(v.stock_conc_ug_ml.toFixed(2))).toBeInTheDocument()
    const s3 = within(step3())
    for (const n of [
      v.stock_conc_ug_ml,
      v.plan.diluent_vol_ul,
      v.plan.diluent_half_ul,
      v.plan.stock_vol_ul,
      v.plan.stock_half_ul,
      v.actual.actual_diluent_ul,
      v.actual.actual_stock_ul,
      v.actual.actual_total_ul,
      v.actual.actual_conc_ug_ml,
    ])
      expect(s3.getByText(n.toFixed(2))).toBeInTheDocument()
    expect(s3.getByText(v.dilution_factor_total.toFixed(4))).toBeInTheDocument()
  })

  it('typing a weighing sends a merge patch for that one key', () => {
    const { onPatch } = renderSheet([makeRow()])
    typeAndLeave(box(`${S1}, ${VIAL}`), '5012.31')
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { stock_vial_mg: 5012.31 } },
      `${S1}, ${VIAL}`
    )
    typeAndLeave(box(`${S1}, ${AS_VIAL}`), '2500.1')
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { vials: { '1': { vial_mg: 2500.1 } } } },
      `${S1}, ${AS_VIAL}`
    )
    // a word is refused, never sent
    onPatch.mockClear()
    typeAndLeave(box(`${S1}, Target Conc (ug/mL)`), 'abc')
    expect(onPatch).not.toHaveBeenCalled()
    expect(box(`${S1}, Target Conc (ug/mL)`)).toHaveAttribute(
      'aria-invalid',
      'true'
    )
  })

  it('clearing a box sends null, never 0', () => {
    const { onPatch } = renderSheet([
      makeRow({
        hplc_prep: {
          stock_vial_mg: 5012.31,
          vials: { '1': { vial_mg: 2500.1 } },
        },
      }),
    ])
    typeAndLeave(box(`${S1}, ${VIAL}`), '')
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { stock_vial_mg: null } },
      `${S1}, ${VIAL}`
    )
    typeAndLeave(box(`${S1}, ${AS_VIAL}`), ' ')
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { vials: { '1': { vial_mg: null } } } },
      `${S1}, ${AS_VIAL}`
    )
  })

  it('a liquid row has its weighing and diluent boxes off and its volume box on', () => {
    renderSheet([rowFromCase('liquid, declared 3 mL')])
    expect(box(`${S1}, ${VIAL}`)).toBeDisabled()
    expect(box(`${S1}, ${VIAL_DIL}`)).toBeDisabled()
    expect(box(`${S1}, Diluent to add (uL)`)).toBeDisabled()
    const volume = box(`${S1}, Declared Liquid Vol (mL)`)
    expect(volume).toBeEnabled()
    expect(volume).toHaveValue('3')
    // the source's hints on a liquid row
    expect(within(step2()).getByText('the declared volume')).toBeInTheDocument()
    expect(
      within(step2()).getByText('in the declared 3.00 mL')
    ).toBeInTheDocument()
  })

  it('a liquid row with no volume says the total needs it', () => {
    renderSheet([
      makeRow({ form: 'liquid', prep_form: 'liquid', hplc_prep: {} }),
    ])
    expect(
      within(step2()).getByText('needs the declared volume')
    ).toBeInTheDocument()
  })

  it('the capsule and liquid columns appear only when a row needs them', () => {
    const { unmount } = render(
      <HplcPrepSheet
        sheet={makeSheet([makeRow()])}
        rules={[]}
        readOnly={false}
        instruments={INSTRUMENTS}
        onPatch={vi.fn()}
        onSetInstrument={vi.fn()}
      />
    )
    expect(
      screen.queryByRole('columnheader', { name: 'Declared Liquid Vol (mL)' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('columnheader', { name: 'Capsules used' })
    ).not.toBeInTheDocument()
    unmount()
    const capsule = 'capsule, 4 x 10 mg, weighed, neat'
    renderSheet([
      makeRow(),
      rowFromCase(capsule, { item_id: 312, sample_id: S2 }),
    ])
    expect(
      screen.getByRole('columnheader', { name: 'Capsules used' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('columnheader', { name: 'Declared Liquid Vol (mL)' })
    ).not.toBeInTheDocument()
    // only the capsule row has a count box, and its declared weight is per capsule
    expect(
      screen.getAllByRole('textbox', { name: /Capsules used/ })
    ).toHaveLength(1)
    expect(screen.getByText('per capsule')).toBeInTheDocument()
    const total = fixtureCase(capsule).expect.declared_total_mg as number
    expect(box(`${S2}, Capsules used`)).toHaveAccessibleDescription(
      `${total.toFixed(2)} mg of peptide in the stock`
    )
  })

  it('a bac row: full in the left box, its declared weight worked out and read-only', () => {
    const name = 'bac, weighed full then emptied'
    const exp = fixtureCase(name).expect as { declared_total_mg: number }
    const { onPatch } = renderSheet([rowFromCase(name, { sample_bac: true })])
    // the left cell, named for its column, holds the full weighing
    const left = box(`${S1}, ${VIAL}`)
    expect(left).toHaveAccessibleDescription('① full, as received: weigh first')
    expect(box(`${S1}, ${VIAL_DIL}`)).toHaveAccessibleDescription(
      '② emptied and dried: weigh after'
    )
    typeAndLeave(left, '36000')
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { stock_vial_diluent_mg: 36000 } },
      `${S1}, ${VIAL}`
    )
    // the declared weight is the worked-out one, not a box
    expect(
      screen.queryByRole('textbox', {
        name: `${S1}, Declared Peptide Wt (mg)`,
      })
    ).not.toBeInTheDocument()
    expect(
      within(step2()).getByText(exp.declared_total_mg.toFixed(2))
    ).toBeInTheDocument()
    expect(box(`${S1}, Diluent to add (uL)`)).toBeDisabled()
    expect(
      within(step2()).getByText('0.9% benzyl alcohol, fixed')
    ).toBeInTheDocument()
  })

  it('a row with no HPLC prep form shows its identity and the note', () => {
    renderSheet([
      makeRow({
        form: null,
        identity: 'Semaglutide Pen',
        sample_form: { id: 9, name: 'Pen', hplc_prep: null },
      }),
    ])
    const s2 = within(step2())
    expect(s2.getByText('Semaglutide Pen')).toBeInTheDocument()
    expect(s2.getByText('no HPLC prep for this form')).toBeInTheDocument()
    expect(
      screen.queryByRole('textbox', { name: `${S1}, ${VIAL}` })
    ).not.toBeInTheDocument()
    expect(within(step3()).queryByText(S1)).not.toBeInTheDocument()
  })

  it('a backwards weighing shows in the warnings panel with its sample id', () => {
    renderSheet([rowFromCase('powder, stock weighings backwards')])
    const panel = screen.getByRole('region', { name: 'Warnings' })
    expect(within(panel).getByRole('listitem').textContent).toMatch(
      /^P-0120-S01: \S/
    )
  })

  it('a completed worksheet is read-only', () => {
    renderSheet([makeRow()], { readOnly: true, status: 'completed' })
    for (const el of screen.getAllByRole('textbox')) expect(el).toBeDisabled()
    for (const el of screen.getAllByRole('combobox')) expect(el).toBeDisabled()
  })

  it('a promoted row is read-only, in Step 2 and Step 3', () => {
    renderSheet([
      makeRow({
        promoted: true,
        prep: { id: 9, sample_id: S1, status: 'draft' },
      }),
      makeRow({ item_id: 312, sample_id: S2 }),
    ])
    expect(box(`${S1}, ${VIAL}`)).toBeDisabled()
    expect(box(`${S2}, ${VIAL}`)).toBeEnabled()
    expect(select(`${S1}, Form`)).toBeDisabled()
    expect(select(`${S2}, Form`)).toBeEnabled()
    for (const label of [
      'Target Conc (ug/mL)',
      'Target Total Vol (uL)',
      AS_VIAL,
      'Wt Autosampler vial and cap + Diluent (mg)',
      'Wt of Vial, cap, Diluent + Sample (mg)',
    ]) {
      expect(box(`${S1}, ${label}`)).toBeDisabled()
      expect(box(`${S2}, ${label}`)).toBeEnabled()
    }
  })

  it('the selects send their one key, the first choice as null', () => {
    const { onPatch, onSetInstrument } = renderSheet([
      makeRow({ prep_form: 'liquid', form: 'liquid', instrument_id: null }),
    ])
    const form = select(`${S1}, Form`)
    expect(
      within(form).getByRole('option', {
        name: 'from the sample (Lyophilized Powder)',
      })
    ).toBeInTheDocument()
    fireEvent.change(form, { target: { value: '' } })
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { prep_form: null },
      `${S1}, Form`
    )
    fireEvent.change(select(`${S1}, Diluent`), {
      target: { value: 'Water + 0.1% TFA' },
    })
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { diluent: 'Water + 0.1% TFA' } },
      `${S1}, Diluent`
    )
    fireEvent.change(select(`${S1}, 2-step dilution`), {
      target: { value: 'false' },
    })
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { two_step: false } },
      `${S1}, 2-step dilution`
    )
    fireEvent.change(select(`${S1}, Instrument`), { target: { value: '3' } })
    expect(onSetInstrument).toHaveBeenLastCalledWith(
      311,
      3,
      `${S1}, Instrument`
    )
  })

  it('offers the usual instrument as a real choice that writes it', () => {
    const { onSetInstrument } = renderSheet(
      [makeRow({ instrument_id: null, instrument_name: null })],
      { rules: [rule({ default_instrument_id: 3 })] }
    )
    const instrument = select(`${S1}, Instrument`) as HTMLSelectElement
    expect(instrument.selectedOptions[0]?.textContent).toBe('not set')
    const usual = within(instrument).getByRole('option', {
      name: 'usually HPLC 1290b',
    }) as HTMLOptionElement
    expect(usual.value).toBe('3')
    fireEvent.change(instrument, { target: { value: '3' } })
    expect(onSetInstrument).toHaveBeenLastCalledWith(
      311,
      3,
      `${S1}, Instrument`
    )
  })

  it('shades rows on another instrument than the first one found, never a row with none', () => {
    renderSheet([
      makeRow({ instrument_id: null, instrument_name: null }),
      makeRow({ item_id: 312, sample_id: S2, instrument_id: 2 }),
      makeRow({ item_id: 313, sample_id: 'P-0122-S01', instrument_id: 3 }),
    ])
    const rowOf = (s: string) =>
      within(step2()).getByText(s).closest('tr') as HTMLElement
    expect(rowOf(S1).dataset.shaded).toBe('false')
    expect(rowOf(S2).dataset.shaded).toBe('false')
    expect(rowOf('P-0122-S01').dataset.shaded).toBe('true')
  })

  it('a row with no declared weight on file serves an empty box the tech types', () => {
    const { onPatch } = renderSheet([
      makeRow({
        declared_mg: null,
        components_source: 'analyses',
        components: [
          {
            peptide_id: 10,
            name: 'BPC-157',
            abbreviation: 'BPC-157',
            declared_mg: null,
            vial: 1,
          },
        ],
      }),
    ])
    const declared = box(`${S1}, Declared Peptide Wt (mg)`)
    expect(declared).toHaveValue('')
    expect(declared).not.toHaveAttribute('placeholder')
    expect(declared).toBeEnabled()
    expect(screen.queryByText(/components from the tests ordered/)).toBeNull()
    typeAndLeave(declared, '12.5')
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { declared_mg: 12.5 } },
      `${S1}, Declared Peptide Wt (mg)`
    )
  })

  it('a blend whose components came from the tests ordered says to type each weight', () => {
    const blend = [
      { peptide_id: 11, name: 'Tesamorelin', declared_mg: null, vial: 1 },
      { peptide_id: 4, name: 'Ipamorelin', declared_mg: null, vial: 1 },
    ]
    renderSheet([
      makeRow({
        identity: 'Tesamorelin + Ipamorelin',
        peptide_id: 21,
        is_blend: true,
        components_source: 'analyses',
        components: blend,
        declared_mg: null,
      }),
      makeRow({
        item_id: 312,
        sample_id: S2,
        identity: 'Tesamorelin + Ipamorelin',
        peptide_id: 21,
        is_blend: true,
        components_source: 'analytes',
        components: blend.map(c => ({ ...c, declared_mg: 5 })),
      }),
    ])
    expect(
      within(step2()).getAllByText(
        'components from the tests ordered; type each weight in Step 2b'
      )
    ).toHaveLength(1)
  })
})

describe('HplcPrepSheet keyboard (the source sheet: down the column)', () => {
  it('Enter in a Step 2 weighing box goes to the same box of the next row and saves the first', () => {
    const { onPatch } = renderSheet(twoRows())
    const first = box(`${S1}, ${VIAL}`)
    act(() => first.focus())
    fireEvent.change(first, { target: { value: '5020' } })
    fireEvent.keyDown(first, { key: 'Enter' })
    expect(document.activeElement).toBe(box(`${S2}, ${VIAL}`))
    // one patch: Enter commits, and the blur that follows does not again
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(onPatch).toHaveBeenCalledWith(
      311,
      { hplc_prep: { stock_vial_mg: 5020 } },
      `${S1}, ${VIAL}`
    )
  })

  it('Tab at the foot of a column goes to the next column top, past Diluent to add', () => {
    renderSheet(twoRows())
    const last = box(`${S2}, ${VIAL}`)
    act(() => last.focus())
    const moved = !fireEvent.keyDown(last, { key: 'Tab' })
    expect(moved).toBe(true)
    expect(document.activeElement).toBe(box(`${S1}, ${VIAL_DIL}`))
  })

  it('Shift+Tab moves up the column', () => {
    renderSheet(twoRows())
    const second = box(`${S2}, ${VIAL}`)
    act(() => second.focus())
    fireEvent.keyDown(second, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(box(`${S1}, ${VIAL}`))
  })

  it('ArrowDown on a Form select moves to the next row and sends nothing', () => {
    const { onPatch } = renderSheet(twoRows())
    const form = select(`${S1}, Form`)
    act(() => form.focus())
    const prevented = !fireEvent.keyDown(form, { key: 'ArrowDown' })
    expect(prevented).toBe(true)
    expect(document.activeElement).toBe(select(`${S2}, Form`))
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('ArrowUp in a number box moves up and never changes its value', () => {
    const { onPatch } = renderSheet(twoRows())
    const second = box(`${S2}, ${VIAL}`)
    act(() => second.focus())
    const prevented = !fireEvent.keyDown(second, { key: 'ArrowUp' })
    expect(prevented).toBe(true)
    expect(document.activeElement).toBe(box(`${S1}, ${VIAL}`))
    expect(box(`${S2}, ${VIAL}`)).toHaveValue('5100')
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('ArrowRight moves on from a box arrived in by keyboard, and stays in the text while editing', () => {
    renderSheet(twoRows())
    const second = box(`${S2}, ${VIAL}`)
    act(() => second.focus())
    // arrive by keyboard: the box is fresh, Right moves on
    fireEvent.keyDown(second, { key: 'ArrowUp' })
    const first = box(`${S1}, ${VIAL}`)
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(box(`${S1}, Diluent to add (uL)`))
    // editing: a typed key, the caret mid-text, Right stays put
    const next = box(`${S1}, Diluent to add (uL)`) as HTMLInputElement
    fireEvent.keyDown(next, { key: '5' })
    fireEvent.change(next, { target: { value: '55' } })
    next.setSelectionRange(1, 1)
    const prevented = !fireEvent.keyDown(next, { key: 'ArrowRight' })
    expect(prevented).toBe(false)
    expect(document.activeElement).toBe(next)
  })
})
