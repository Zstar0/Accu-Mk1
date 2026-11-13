import { describe, it, expect } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import type { HplcSheetRow } from '@/lib/api'
import { makeRow, rowFromCase } from './hplc-sheet-fixtures'
import {
  queryRegion,
  region,
  renderLive,
  STEP2B,
  STEP3,
  STEP3A,
} from './hplc-sheet-live'

const S1 = 'P-0120-S01'

/** Tesamorelin 10 mg + Ipamorelin 5 mg, weighed (fixture case). */
const tesaIpa = (over: Partial<HplcSheetRow> = {}) =>
  rowFromCase('blend Tesamorelin + Ipamorelin, split', {
    identity: 'Tesamorelin + Ipamorelin',
    is_blend: true,
    ...over,
  })

const headers = (r: HTMLElement) =>
  within(r)
    .getAllByRole('columnheader')
    .map(h => h.textContent)

/** The Step 2b line of one component. */
const line = (component: string) => {
  const cell = within(region(STEP2B)).getByText(component, {
    selector: 'td',
  })
  return within(cell.closest('tr') as HTMLElement)
}

/** A component line's cells, by column position. */
const cells = (component: string) => line(component).getAllByRole('cell')

const PLANNED = 7 // Planned Final Conc (ug/mL)

function typeAndLeave(el: HTMLElement, text: string) {
  fireEvent.focus(el)
  fireEvent.change(el, { target: { value: text } })
  fireEvent.blur(el)
}

describe('Step 2b, blend components', () => {
  it('Step 2b appears only when a row is a blend, Step 3a only when a vial takes two steps', () => {
    renderLive([makeRow()])
    expect(queryRegion(STEP2B)).toBeNull()
    expect(queryRegion(STEP3A)).toBeNull()
    cleanup()

    renderLive([tesaIpa()])
    expect(queryRegion(STEP3A)).toBeNull()
    expect(headers(region(STEP2B))).toEqual([
      'Sample ID',
      'Component',
      'Declared Wt (mg)',
      'Vial',
      'Lead',
      'Component Stock Conc (ug/mL)',
      'Own Target (ug/mL)',
      'Planned Final Conc (ug/mL)',
      'Actual Final Conc (ug/mL)',
    ])
    expect(
      within(region(STEP2B)).getByText(
        /^One stock, one dilution per vial\. Split the declared weight/
      )
    ).toBeInTheDocument()
    expect(
      within(region(STEP2B)).getByText('samples with more than one peptide')
    ).toBeInTheDocument()
    // the sections run in the source's order
    const order = screen
      .getAllByRole('region')
      .map(r => r.getAttribute('aria-label'))
      .filter(n => n?.startsWith('Step'))
    expect(order).toEqual([
      'Step 2 Peptide sample stock preparation',
      STEP2B,
      STEP3,
    ])
    cleanup()

    renderLive([
      rowFromCase('powder, declared 500 mg, unweighed'),
      tesaIpa({ item_id: 312, sample_id: 'P-0121-S01' }),
    ])
    expect(
      screen
        .getAllByRole('region')
        .map(r => r.getAttribute('aria-label'))
        .filter(n => n?.startsWith('Step'))
    ).toEqual([
      'Step 2 Peptide sample stock preparation',
      STEP2B,
      STEP3A,
      STEP3,
    ])
  })

  it('moving a component to vial B gives Step 3 a second row for that sample', () => {
    const { onPatch } = renderLive([tesaIpa()])
    const what = `${S1}, Vial, Ipamorelin`
    const vial = screen.getByRole('combobox', { name: what })
    expect(vial).toHaveValue('A')
    expect(within(region(STEP3)).getAllByRole('row')).toHaveLength(2) // head + A
    fireEvent.change(vial, { target: { value: 'B' } })
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { components: { '4': { vial: 2 } } } },
      what
    )
    const s3 = within(region(STEP3))
    expect(s3.getAllByRole('row')).toHaveLength(3)
    expect(s3.getByText(`${S1} A`)).toBeInTheDocument()
    expect(s3.getByText(`${S1} B`)).toBeInTheDocument()
    // vial B leads with its only component, Ipamorelin, at its own target
    expect(line('Ipamorelin').getByRole('radio')).toBeChecked()
    expect(cells('Ipamorelin')[PLANNED]).toHaveTextContent('200.00')
    // back to A, the catalog's own vial: sent as null, not 1
    fireEvent.change(vial, { target: { value: 'A' } })
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { components: { '4': { vial: null } } } },
      what
    )
    expect(within(region(STEP3)).getAllByRole('row')).toHaveLength(2)
  })

  it('choosing a lead sends vials[n].lead_id and re-plans that vial', () => {
    const { onPatch } = renderLive([tesaIpa()])
    const tesa = line('Tesamorelin').getByRole('radio')
    const ipa = line('Ipamorelin').getByRole('radio')
    // by the usual rule the heaviest leads, shown checked, greyed, with why
    expect(tesa).toBeChecked()
    expect(tesa).toBeEnabled()
    expect(tesa.className).toContain('opacity-50')
    expect(line('Tesamorelin').getByText('heaviest')).toBeInTheDocument()
    expect(cells('Tesamorelin')[PLANNED]).toHaveTextContent('200.00')
    expect(cells('Ipamorelin')[PLANNED]).toHaveTextContent('100.00')
    expect(
      screen.queryByRole('button', { name: `${S1}, Lead, usual` })
    ).toBeNull()

    fireEvent.click(ipa)
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { vials: { '1': { lead_id: 4 } } } },
      `${S1}, Lead, Ipamorelin`
    )
    expect(line('Ipamorelin').getByRole('radio')).toBeChecked()
    expect(line('Ipamorelin').getByRole('radio').className).not.toContain(
      'opacity-50'
    )
    expect(line('Tesamorelin').getByRole('radio')).not.toBeChecked()
    expect(cells('Ipamorelin')[PLANNED]).toHaveTextContent('200.00')
    expect(cells('Tesamorelin')[PLANNED]).toHaveTextContent('400.00')

    fireEvent.click(screen.getByRole('button', { name: `${S1}, Lead, usual` }))
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { vials: { '1': { lead_id: null } } } },
      `${S1}, Lead, usual`
    )
    expect(line('Tesamorelin').getByRole('radio')).toBeChecked()

    // clicking the greyed rule lead makes it a chosen one
    fireEvent.click(line('Tesamorelin').getByRole('radio'))
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { vials: { '1': { lead_id: 11 } } } },
      `${S1}, Lead, Tesamorelin`
    )
    expect(line('Tesamorelin').queryByText('heaviest')).toBeNull()
  })

  it('typing a share or an own target sends that one key', () => {
    const { onPatch } = renderLive([tesaIpa()])
    const mg = screen.getByRole('textbox', {
      name: `${S1}, Declared Wt (mg), Ipamorelin`,
    })
    expect(mg).toHaveAttribute('placeholder', '5')
    typeAndLeave(mg, '4.5')
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { components: { '4': { mg: 4.5 } } } },
      `${S1}, Declared Wt (mg), Ipamorelin`
    )
    const target = screen.getByRole('textbox', {
      name: `${S1}, Own Target (ug/mL), Tesamorelin`,
    })
    expect(target).toHaveAttribute('placeholder', '200')
    typeAndLeave(target, '250')
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { components: { '11': { target: 250 } } } },
      `${S1}, Own Target (ug/mL), Tesamorelin`
    )
    // the lead's own target is its vial's target: the plan follows
    expect(cells('Tesamorelin')[PLANNED]).toHaveTextContent('250.00')
    typeAndLeave(target, '')
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { components: { '11': { target: null } } } },
      `${S1}, Own Target (ug/mL), Tesamorelin`
    )
  })

  it('a component under the floor is marked and nothing is disabled', () => {
    renderLive([
      rowFromCase('blend with a component under 60', {
        identity: 'BPC-157 + Tesamorelin',
        is_blend: true,
      }),
    ])
    const planned = cells('Tesamorelin')[PLANNED] as HTMLElement
    expect(planned).toHaveTextContent('20.00')
    expect(planned).toHaveAttribute(
      'title',
      'under the 60 ug/mL floor: it can go in its own vial, choose B'
    )
    expect(planned.className).toContain('bg-amber')
    expect(cells('BPC-157')[PLANNED]).not.toHaveAttribute('title')
    const r = within(region(STEP2B))
    for (const el of [
      ...r.getAllByRole('textbox'),
      ...r.getAllByRole('combobox'),
      ...r.getAllByRole('radio'),
    ])
      expect(el).toBeEnabled()
    expect(r.queryByRole('button', { name: /approv|sign/i })).toBeNull()
  })

  it('a split that does not add up says so under the sample id', () => {
    renderLive([
      rowFromCase(
        'blend of three, 0.3 + 0.6 + 0.1 against 1.005 (left-to-right sum, mismatch)',
        { is_blend: true }
      ),
      rowFromCase('blend of two, unsplit', {
        item_id: 312,
        sample_id: 'P-0121-S01',
        is_blend: true,
      }),
      rowFromCase('blend of two, unsplit', {
        item_id: 313,
        sample_id: 'P-0122-S01',
        is_blend: true,
        hplc_prep: { components: { '10': { mg: 12 } } },
      }),
    ])
    const r = within(region(STEP2B))
    expect(
      r.getByText('the weights add up to 1, the vial says 1.005')
    ).toBeInTheDocument()
    expect(r.getByText('split not typed yet')).toBeInTheDocument()
    expect(r.getByText('partly typed')).toBeInTheDocument()
    // the sample id is shown once per sample, on its first line
    expect(r.getAllByText('P-0121-S01')).toHaveLength(1)
  })

  it('a blend whose components come from its analyses asks for the split, with no placeholders', () => {
    renderLive([
      makeRow({
        identity: 'BPC-157 + GHK-Cu',
        peptide_id: 20,
        is_blend: true,
        declared_mg: 20,
        components_source: 'analyses',
        components: [
          { peptide_id: 10, name: 'BPC-157', declared_mg: null, vial: 1 },
          { peptide_id: 3, name: 'GHK-Cu', declared_mg: null, vial: 1 },
        ],
      }),
    ])
    const r = within(region(STEP2B))
    const state = r.getByText('split not typed yet')
    expect(state.closest('[role="alert"]')).toBeNull()
    for (const c of ['BPC-157', 'GHK-Cu'])
      expect(
        screen.getByRole('textbox', { name: `${S1}, Declared Wt (mg), ${c}` })
      ).not.toHaveAttribute('placeholder')
  })

  it('a blend that cannot be planned shows why in place of its components', () => {
    renderLive([
      makeRow({
        identity: 'Mystery blend',
        is_blend: true,
        components: [],
        problems: ['this blend is not in the catalog'],
      }),
    ])
    const r = within(region(STEP2B))
    expect(r.getByText('this blend is not in the catalog')).toBeInTheDocument()
    expect(r.queryAllByRole('textbox')).toHaveLength(0)
  })
})
