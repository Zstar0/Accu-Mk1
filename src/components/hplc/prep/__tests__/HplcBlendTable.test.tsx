import { describe, it, expect } from 'vitest'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { HplcSheetRow } from '@/lib/api'
import { boxKey } from '@/services/hplc-worksheet'
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
    // each vial's radios are one named group for a screen reader
    const group = screen.getByRole('radiogroup', {
      name: `${S1}, Lead for vial A`,
    })
    expect(group.getAttribute('aria-owns')?.split(' ')).toEqual([
      tesa.id,
      ipa.id,
    ])
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

  it("a Lead save that did not land marks that vial's radios (X2)", () => {
    renderLive([tesaIpa()], {
      failed: new Map([
        [boxKey(311, 'hplc_prep.vials.1.lead_id'), 'timed out'],
      ]),
    })
    for (const name of ['Tesamorelin', 'Ipamorelin']) {
      const radio = line(name).getByRole('radio')
      expect(radio).toHaveAccessibleDescription('Not saved: timed out')
      expect(radio.className).toContain('ring-red-500')
    }
    cleanup()
    renderLive([tesaIpa()])
    const radio = line('Tesamorelin').getByRole('radio')
    expect(radio).not.toHaveAttribute('aria-describedby')
    expect(radio.className).not.toContain('ring-red-500')
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

  it('Tab and Enter never land on a Lead radio, and no arrow key changes a lead', () => {
    const { onPatch } = renderLive([tesaIpa()])
    const vialA = screen.getByRole('combobox', {
      name: `${S1}, Vial, Tesamorelin`,
    })
    const vialB = screen.getByRole('combobox', {
      name: `${S1}, Vial, Ipamorelin`,
    })
    const target = (c: string) =>
      screen.getByRole('textbox', { name: `${S1}, Own Target (ug/mL), ${c}` })
    const lead = (c: string) => line(c).getByRole('radio')
    act(() => vialA.focus())
    // A3: the arrow keys stop on the Lead radio on the way across
    fireEvent.keyDown(vialA, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(lead('Tesamorelin'))
    fireEvent.keyDown(lead('Tesamorelin'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(target('Tesamorelin'))
    fireEvent.keyDown(target('Tesamorelin'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(target('Ipamorelin'))
    fireEvent.keyDown(target('Ipamorelin'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(lead('Ipamorelin'))
    fireEvent.keyDown(lead('Ipamorelin'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(vialB)
    fireEvent.keyDown(vialB, { key: 'Tab' })
    expect(document.activeElement).toBe(target('Tesamorelin'))
    fireEvent.keyDown(target('Tesamorelin'), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(vialB)
    fireEvent.keyDown(vialB, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(vialA)
    const leads = onPatch.mock.calls.filter(([, p]) =>
      JSON.stringify(p).includes('lead_id')
    )
    expect(leads).toEqual([])
    expect(line('Tesamorelin').getByRole('radio')).toBeChecked()
  })

  it('A3: the arrow keys across the Lead radios never send a lead; Space sends exactly one', async () => {
    const user = userEvent.setup()
    const { onPatch } = renderLive([tesaIpa()])
    const leads = () =>
      onPatch.mock.calls.filter(([, p]) =>
        JSON.stringify(p).includes('lead_id')
      )
    const vialA = screen.getByRole('combobox', {
      name: `${S1}, Vial, Tesamorelin`,
    })
    act(() => vialA.focus())
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(line('Tesamorelin').getByRole('radio'))
    await user.keyboard('{ArrowDown}{ArrowUp}{ArrowDown}')
    expect(document.activeElement).toBe(line('Ipamorelin').getByRole('radio'))
    await user.keyboard('{ArrowRight}{ArrowLeft}')
    expect(document.activeElement).toBe(line('Ipamorelin').getByRole('radio'))
    expect(leads()).toEqual([])
    expect(line('Tesamorelin').getByRole('radio')).toBeChecked()
    await user.keyboard(' ')
    expect(leads()).toEqual([
      [
        311,
        { hplc_prep: { vials: { '1': { lead_id: 4 } } } },
        `${S1}, Lead, Ipamorelin`,
      ],
    ])
  })

  it('a share or own target of 0 goes back to the standard (sent as null)', () => {
    const { onPatch } = renderLive([
      tesaIpa({
        hplc_prep: {
          ...tesaIpa().hplc_prep,
          components: { '11': { target: 250 } },
        },
      }),
    ])
    const target = screen.getByRole('textbox', {
      name: `${S1}, Own Target (ug/mL), Tesamorelin`,
    })
    typeAndLeave(target, '0')
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { components: { '11': { target: null } } } },
      `${S1}, Own Target (ug/mL), Tesamorelin`
    )
    expect(target).toHaveValue('')
    expect(target).toHaveAttribute('placeholder', '200')
    const mg = screen.getByRole('textbox', {
      name: `${S1}, Declared Wt (mg), Ipamorelin`,
    })
    typeAndLeave(mg, '0')
    expect(onPatch).toHaveBeenLastCalledWith(
      311,
      { hplc_prep: { components: { '4': { mg: null } } } },
      `${S1}, Declared Wt (mg), Ipamorelin`
    )
    expect(mg).toHaveValue('')
  })

  it('a capsule blend checks its split against the per-capsule weight', () => {
    const capsule = (over: Partial<HplcSheetRow>) =>
      makeRow({
        identity: 'BPC-157 + Tesamorelin',
        peptide_id: 22,
        is_blend: true,
        form: 'capsule',
        declared_mg: 10,
        components: [
          { peptide_id: 10, name: 'BPC-157', declared_mg: 5, vial: 1 },
          { peptide_id: 11, name: 'Tesamorelin', declared_mg: 5, vial: 1 },
        ],
        hplc_prep: { capsules: 3 },
        ...over,
      })
    renderLive([
      capsule({}),
      capsule({
        item_id: 312,
        sample_id: 'P-0121-S01',
        hplc_prep: { capsules: 3, components: { '10': { mg: 4 } } },
      }),
    ])
    const r = within(region(STEP2B))
    expect(r.queryByText(/the weights add up to 10\b/)).toBeNull()
    expect(
      r.getByText('the weights add up to 9, the vial says 10')
    ).toBeInTheDocument()
  })

  it('a promoted blend row has every Step 2b control off and sends nothing', () => {
    const { onPatch } = renderLive([tesaIpa({ promoted: true })])
    const r = within(region(STEP2B))
    const controls = [
      ...r.getAllByRole('textbox'),
      ...r.getAllByRole('combobox'),
      ...r.getAllByRole('radio'),
    ]
    expect(controls).toHaveLength(8)
    for (const el of controls) expect(el).toBeDisabled()
    fireEvent.click(line('Ipamorelin').getByRole('radio'))
    expect(onPatch).not.toHaveBeenCalled()
  })
})
