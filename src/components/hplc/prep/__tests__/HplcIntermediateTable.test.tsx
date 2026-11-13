import { describe, it, expect } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { computeRow } from '@/lib/hplc-prep'
import { fmtDp } from '../HplcSheetCells'
import { fixtureCase, makeRow, rowFromCase } from './hplc-sheet-fixtures'
import { region, renderLive, STEP3, STEP3A } from './hplc-sheet-live'

const S1 = 'P-0120-S01'
const box = (name: string) => screen.getByRole('textbox', { name })

function typeAndLeave(el: HTMLElement, text: string) {
  fireEvent.focus(el)
  fireEvent.change(el, { target: { value: text } })
  fireEvent.blur(el)
}

const headers = (r: HTMLElement) =>
  within(r)
    .getAllByRole('columnheader')
    .map(h => h.textContent)

/** The 500 mg case with its stock weighed and nothing in the intermediate. */
const heavyRow = () =>
  rowFromCase('powder, declared 500 mg, unweighed', {
    hplc_prep: { stock_vial_mg: 5012.31, stock_vial_diluent_mg: 8003.6 },
  })

describe('Step 3a, the intermediate dilution', () => {
  it('0 or less in the intermediate target or volume clears the box, as the source does', () => {
    const { onPatch } = renderLive([heavyRow()])
    for (const [label, key] of [
      ['Intermediate Target (ug/mL)', 'int_target_ug_ml'],
      ['Intermediate Target Vol (uL)', 'int_volume_ul'],
    ] as const) {
      const what = `${S1}, ${label}`
      typeAndLeave(box(what), '0')
      expect(onPatch).toHaveBeenLastCalledWith(
        311,
        { hplc_prep: { vials: { '1': { [key]: null } } } },
        what
      )
      expect(box(what)).toHaveValue('')
    }
  })

  it('the intermediate target shows 5000 as its placeholder until one is typed', () => {
    const { onPatch } = renderLive([heavyRow()])
    expect(headers(region(STEP3A))).toEqual([
      'Sample ID',
      'Sample Identity',
      'Diluent',
      'Intermediate Target (ug/mL)',
      'Intermediate Target Vol (uL)',
      'Wt Intermediate vial and cap (mg)',
      'Diluent Vol to Add (uL), total',
      'half',
      'Wt Intermediate vial and cap + Diluent (mg)',
      'Stock Vol to Add (uL), total',
      'half',
      'Wt Intermediate vial, cap, Diluent + Stock (mg)',
      'Actual Diluent added (uL)',
      'Actual Stock added (uL)',
      'Actual Intermediate Conc (ug/mL)',
    ])
    expect(
      within(region(STEP3A)).getByText('samples declared at 500 mg or more')
    ).toBeInTheDocument()
    const what = `${S1}, Intermediate Target (ug/mL)`
    expect(box(what)).toHaveAttribute('placeholder', '5000')
    expect(box(`${S1}, Intermediate Target Vol (uL)`)).toHaveAttribute(
      'placeholder',
      '1500'
    )
    const r = within(region(STEP3A))
    expect(r.getByText('45.00')).toBeInTheDocument() // stock to add for 5000
    typeAndLeave(box(what), '4000')
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { vials: { '1': { int_target_ug_ml: 4000 } } } },
      what
    )
    expect(box(what)).toHaveValue('4000')
    expect(r.getByText('36.00')).toBeInTheDocument() // re-planned for 4000
    expect(r.queryByText('45.00')).toBeNull()
  })

  it('typing the three intermediate weighings shows the actual intermediate concentration and re-plans Step 3 from it', () => {
    const exp = fixtureCase(
      'powder, declared 500 mg, intermediate and final weighed'
    ).expect as {
      vials: [
        {
          intermediate: {
            actual: Record<
              'actual_diluent_ul' | 'actual_stock_ul' | 'actual_conc_ug_ml',
              number
            >
          }
          plan: { stock_vol_ul: number }
        },
      ]
    }
    const [v] = exp.vials
    const { onPatch } = renderLive([heavyRow()])
    const s3a = within(region(STEP3A))
    const s3 = within(region(STEP3))
    // until weighed, Step 3 dilutes from the intermediate's target
    expect(s3.getByText('5000.00')).toBeInTheDocument()
    const weighings: [string, string, number][] = [
      ['Wt Intermediate vial and cap (mg)', 'int_vial_mg', 2400],
      [
        'Wt Intermediate vial and cap + Diluent (mg)',
        'int_vial_diluent_mg',
        3836.2,
      ],
      [
        'Wt Intermediate vial, cap, Diluent + Stock (mg)',
        'int_vial_all_mg',
        3881,
      ],
    ]
    for (const [label, key, value] of weighings) {
      typeAndLeave(box(`${S1}, ${label}`), String(value))
      expect(onPatch).toHaveBeenLastCalledWith(
        311,
        { hplc_prep: { vials: { '1': { [key]: value } } } },
        `${S1}, ${label}`
      )
    }
    const conc = v.intermediate.actual.actual_conc_ug_ml.toFixed(2)
    expect(s3a.getByText(conc)).toBeInTheDocument()
    expect(
      s3a.getByText(v.intermediate.actual.actual_diluent_ul.toFixed(2))
    ).toBeInTheDocument()
    expect(
      s3a.getByText(v.intermediate.actual.actual_stock_ul.toFixed(2))
    ).toBeInTheDocument()
    // Step 3 now dilutes from the actual intermediate
    expect(s3.getByText(conc)).toBeInTheDocument()
    expect(s3.queryByText('5000.00')).toBeNull()
    expect(s3.getByText(v.plan.stock_vol_ul.toFixed(2))).toBeInTheDocument()
    expect(
      s3.getByText('two-step: dilutes from its intermediate vial (Step 3a)')
    ).toBeInTheDocument()
  })

  it('an intermediate volume off its plan is marked, with the numbers', () => {
    renderLive([
      rowFromCase('powder, intermediate and final stock 20 % over plan'),
    ])
    const marked = within(region(STEP3A))
      .getAllByRole('cell')
      .filter(td => td.className.includes('bg-amber'))
    expect(marked).toHaveLength(1)
    expect(marked[0]?.title).toMatch(
      /^Vial 1: the stock added to the intermediate is .* uL against .* uL planned/
    )
  })

  it('a Step 3 final volume off its plan shows the warning on hover', () => {
    renderLive([rowFromCase('powder, pipetted volume 20 % off plan')])
    const marked = within(region(STEP3))
      .getAllByRole('cell')
      .filter(td => td.className.includes('bg-amber'))
    expect(marked).toHaveLength(1)
    expect(marked[0]?.title).toMatch(
      /^Vial 1: the stock added to the final vial is .* uL against .* uL planned/
    )
  })

  it('the intermediate volume box sends its own key', () => {
    const { onPatch } = renderLive([heavyRow()])
    const what = `${S1}, Intermediate Target Vol (uL)`
    typeAndLeave(box(what), '1000')
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { vials: { '1': { int_volume_ul: 1000 } } } },
      what
    )
    // 5000 x 1000 / the stock: the plan follows the typed volume
    expect(within(region(STEP3A)).getByText('30.00')).toBeInTheDocument()
  })

  it('a promoted two-step row has every Step 3a box off and sends nothing', () => {
    const { onPatch } = renderLive([{ ...heavyRow(), promoted: true }])
    const boxes = within(region(STEP3A)).getAllByRole('textbox')
    expect(boxes).toHaveLength(5)
    for (const b of boxes) expect(b).toBeDisabled()
    typeAndLeave(boxes[0] as HTMLElement, '4000')
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('a blend split across two vials with one vial two-step: one Step 3a line, two Step 3 lines', () => {
    const row = makeRow({
      identity: 'NAD+ + Tesamorelin',
      peptide_id: 23,
      is_blend: true,
      declared_mg: 610,
      components: [
        { peptide_id: 2, name: 'NAD+', declared_mg: 600, vial: 1 },
        { peptide_id: 11, name: 'Tesamorelin', declared_mg: 10, vial: 2 },
      ],
      hplc_prep: { stock_vial_mg: 5012.31, stock_vial_diluent_mg: 8003.6 },
    })
    const c = computeRow(row, row.hplc_prep, [], row.params)
    const [a, b] = c.vials
    expect(a?.two_step).toBe(true)
    expect(b?.two_step).toBe(false)
    renderLive([row])
    const s3a = within(region(STEP3A))
    expect(s3a.getAllByRole('row')).toHaveLength(2) // head + vial A
    expect(s3a.getByText(`${S1} A`)).toBeInTheDocument()
    expect(s3a.getByText('NAD+')).toBeInTheDocument()
    expect(
      s3a.getByText(fmtDp(a?.intermediate?.plan.stock_vol_ul, 2))
    ).toBeInTheDocument()
    expect(
      box(`${S1}, Intermediate Target (ug/mL), vial A`)
    ).toBeInTheDocument()
    const s3 = within(region(STEP3))
    expect(s3.getAllByRole('row')).toHaveLength(3)
    for (const v of [a, b]) {
      const id = within(
        s3
          .getByText(`${S1} ${v?.vial === 1 ? 'A' : 'B'}`, {
            exact: false,
          })
          .closest('tr') as HTMLElement
      )
      expect(id.getByText(fmtDp(v?.stock_for_final, 2))).toBeInTheDocument()
      expect(id.getByText(fmtDp(v?.plan.stock_vol_ul, 2))).toBeInTheDocument()
    }
  })
})
