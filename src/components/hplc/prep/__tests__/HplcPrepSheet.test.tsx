import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { HplcSheetRow } from '@/lib/api'
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
  { readOnly = false, status = 'open' } = {}
) {
  const onPatch = vi.fn()
  const onSetInstrument = vi.fn()
  render(
    <HplcPrepSheet
      sheet={makeSheet(rows, status)}
      rules={[]}
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

/** Types into a box and leaves it, as a tech tabs on. */
function typeAndLeave(box: HTMLElement, text: string) {
  fireEvent.focus(box)
  fireEvent.change(box, { target: { value: text } })
  fireEvent.blur(box)
}

describe('HplcPrepSheet', () => {
  it('renders Step 2 and Step 3 with the source labels', () => {
    renderSheet([makeRow()])
    const s2 = within(step2())
    for (const label of [
      'Sample ID',
      'Sample Identity',
      'Declared Peptide Wt (mg)',
      'Form',
      'Instrument',
      'Diluent',
      'Wt Customer Sample vial and Septum (mg)',
      'Diluent to add (uL)',
      'Wt Customer Sample vial and Septum + Diluent (mg)',
      'Total Diluent added (mL)',
      'Peptide Stock Conc (ug/mL)',
      '2-step dilution',
    ])
      expect(s2.getByRole('columnheader', { name: label })).toBeInTheDocument()
    expect(
      s2.getByRole('columnheader', { name: 'Peptide Stock Conc (ug/mL)' })
    ).toHaveAttribute(
      'title',
      "Declared Peptide Wt × 1000 ÷ Total Diluent added. For a blend: the lead component's weight (Step 2b) × 1000 ÷ Total Diluent added."
    )
    const s3 = within(step3())
    for (const label of [
      'Diluting from (ug/mL)',
      'Target Conc (ug/mL)',
      'Target Total Vol (uL)',
      'Wt Autosampler vial and cap (mg)',
      'Diluent Vol to Add (uL), total',
      'Wt Autosampler vial and cap + Diluent (mg)',
      'Stock Vol to Add (uL), total',
      'Wt of Vial, cap, Diluent + Sample (mg)',
      'Actual Diluent Volume added (uL)',
      'Actual Stock Vol added (uL)',
      'Actual Total Volume (uL)',
      'Actual Conc (ug/mL)',
      'Total Dilution Factor',
    ])
      expect(s3.getByRole('columnheader', { name: label })).toBeInTheDocument()
    expect(s3.getAllByRole('columnheader', { name: 'half' })).toHaveLength(2)
    expect(
      screen.getByText(
        'What is in the customer sample vial and which instrument. Weigh that vial with its septum, add the diluent, weigh again.'
      )
    ).toBeInTheDocument()
    // the standard shows as each box's placeholder until something is typed
    expect(s3.getByLabelText('Target Conc')).toHaveAttribute(
      'placeholder',
      '200'
    )
    expect(s3.getByLabelText('Target Total Vol')).toHaveAttribute(
      'placeholder',
      '1500'
    )
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
    typeAndLeave(
      within(step2()).getByLabelText('Wt Customer Sample vial and Septum'),
      '5012.31'
    )
    expect(onPatch).toHaveBeenLastCalledWith(311, {
      hplc_prep: { stock_vial_mg: 5012.31 },
    })
    const box = within(step3()).getByLabelText('Wt Autosampler vial and cap')
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: '2500.1' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onPatch).toHaveBeenLastCalledWith(311, {
      hplc_prep: { vials: { '1': { vial_mg: 2500.1 } } },
    })
    // a word is refused, never sent
    onPatch.mockClear()
    typeAndLeave(within(step3()).getByLabelText('Target Conc'), 'abc')
    expect(onPatch).not.toHaveBeenCalled()
    expect(within(step3()).getByLabelText('Target Conc')).toHaveAttribute(
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
    typeAndLeave(
      within(step2()).getByLabelText('Wt Customer Sample vial and Septum'),
      ''
    )
    expect(onPatch).toHaveBeenLastCalledWith(311, {
      hplc_prep: { stock_vial_mg: null },
    })
    typeAndLeave(
      within(step3()).getByLabelText('Wt Autosampler vial and cap'),
      ' '
    )
    expect(onPatch).toHaveBeenLastCalledWith(311, {
      hplc_prep: { vials: { '1': { vial_mg: null } } },
    })
  })

  it('a liquid row has its weighing boxes off and its volume box on', () => {
    renderSheet([rowFromCase('liquid, declared 3 mL')])
    const s2 = within(step2())
    expect(
      s2.getByLabelText('Wt Customer Sample vial and Septum')
    ).toBeDisabled()
    expect(
      s2.getByLabelText('Wt Customer Sample vial and Septum + Diluent')
    ).toBeDisabled()
    expect(s2.getByLabelText('Declared Liquid Vol')).toBeEnabled()
    expect(s2.getByLabelText('Declared Liquid Vol')).toHaveValue('3')
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
    renderSheet([
      makeRow(),
      rowFromCase('capsule, 4 x 10 mg, weighed, neat', {
        item_id: 312,
        sample_id: 'P-0121-S01',
      }),
    ])
    expect(
      screen.getByRole('columnheader', { name: 'Capsules used' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('columnheader', { name: 'Declared Liquid Vol (mL)' })
    ).not.toBeInTheDocument()
    // only the capsule row has a count box, and its declared weight is per capsule
    expect(screen.getAllByLabelText('Capsules used')).toHaveLength(1)
    expect(screen.getByText('per capsule')).toBeInTheDocument()
  })

  it('a bac row carries the weigh-full-first hints, full in the left box', () => {
    const { onPatch } = renderSheet([
      makeRow({ form: 'bac', sample_bac: true }),
    ])
    expect(
      screen.getByText('(1) full, as received: weigh first')
    ).toBeInTheDocument()
    expect(
      screen.getByText('(2) emptied and dried: weigh after')
    ).toBeInTheDocument()
    // the left cell holds the full weighing, as the source swaps them
    const [left] = within(step2()).getAllByRole('textbox', {
      name: /^Wt Customer Sample vial and Septum/,
    })
    if (!left) throw new Error('no weighing box')
    typeAndLeave(left, '35000')
    expect(onPatch).toHaveBeenLastCalledWith(311, {
      hplc_prep: { stock_vial_diluent_mg: 35000 },
    })
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
      s2.queryByLabelText('Wt Customer Sample vial and Septum')
    ).not.toBeInTheDocument()
    expect(within(step3()).queryByText('P-0120-S01')).not.toBeInTheDocument()
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
    for (const box of screen.getAllByRole('textbox')) expect(box).toBeDisabled()
    for (const select of screen.getAllByRole('combobox'))
      expect(select).toBeDisabled()
  })

  it('a promoted row is read-only', () => {
    renderSheet([
      makeRow({
        promoted: true,
        prep: { id: 9, sample_id: 'P-0120-S01', status: 'draft' },
      }),
      makeRow({ item_id: 312, sample_id: 'P-0121-S01' }),
    ])
    const [promotedBox, openBox] = within(step2()).getAllByLabelText(
      'Wt Customer Sample vial and Septum'
    )
    expect(promotedBox).toBeDisabled()
    expect(openBox).toBeEnabled()
    const [promotedForm, openForm] = within(step2()).getAllByLabelText('Form')
    expect(promotedForm).toBeDisabled()
    expect(openForm).toBeEnabled()
  })

  it('the selects send their one key, the first choice as null', () => {
    const { onPatch, onSetInstrument } = renderSheet([
      makeRow({ prep_form: 'liquid', form: 'liquid', instrument_id: null }),
    ])
    const s2 = within(step2())
    expect(
      within(s2.getByLabelText('Form')).getByRole('option', {
        name: 'from the sample (Lyophilized Powder)',
      })
    ).toBeInTheDocument()
    fireEvent.change(s2.getByLabelText('Form'), { target: { value: '' } })
    expect(onPatch).toHaveBeenLastCalledWith(311, { prep_form: null })
    fireEvent.change(s2.getByLabelText('Diluent'), {
      target: { value: 'Water + 0.1% TFA' },
    })
    expect(onPatch).toHaveBeenLastCalledWith(311, {
      hplc_prep: { diluent: 'Water + 0.1% TFA' },
    })
    fireEvent.change(s2.getByLabelText('2-step dilution'), {
      target: { value: 'false' },
    })
    expect(onPatch).toHaveBeenLastCalledWith(311, {
      hplc_prep: { two_step: false },
    })
    fireEvent.change(s2.getByLabelText('Instrument'), {
      target: { value: '3' },
    })
    expect(onSetInstrument).toHaveBeenLastCalledWith(311, 3)
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
    const box = within(step2()).getByLabelText('Declared Peptide Wt')
    expect(box).toHaveValue('')
    expect(box).not.toHaveAttribute('placeholder')
    expect(box).toBeEnabled()
    expect(screen.queryByText(/components from the tests ordered/)).toBeNull()
    typeAndLeave(box, '12.5')
    expect(onPatch).toHaveBeenLastCalledWith(311, {
      hplc_prep: { declared_mg: 12.5 },
    })
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
        sample_id: 'P-0121-S01',
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
