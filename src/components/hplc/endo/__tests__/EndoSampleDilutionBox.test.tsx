import { describe, it, expect } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { EndoSampleDilutionBox } from '@/components/hplc/endo/EndoSampleDilutionBox'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import { endoBoxProps, endoItem } from './endo-fixtures'

function setup(items: WorksheetItemRow[], isCompleted = false) {
  const { props, onUpdateItem } = endoBoxProps(items, {}, isCompleted)
  render(<EndoSampleDilutionBox {...props} />)
  return { onUpdateItem }
}

function rowOf(sampleId: string): HTMLElement {
  const row = screen.getByText(sampleId).closest('tr')
  if (!row) throw new Error(`no row for ${sampleId}`)
  return row
}

function bodyRows(): HTMLElement[] {
  const body = screen.getAllByRole('rowgroup')[1]
  if (!body) throw new Error('no table body')
  return within(body).getAllByRole('row')
}

const cellText = (row: HTMLElement, i: number) =>
  within(row).getAllByRole('cell')[i]?.textContent

const TOTAL_REFUSAL =
  'prep_total_dilution must be at least 20 (the step 1 ratio x the fixed 1:2 step) or step 2 cannot be made'

function commit(row: HTMLElement, label: string, value: string) {
  const input = within(row).getByLabelText(label)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

describe('EndoSampleDilutionBox', () => {
  it('groups rows by total, a rule per group, each numbered as in Box 1', () => {
    setup([
      endoItem({ sample_id: 'P-0001-S02' }),
      endoItem({ sample_id: 'P-0002-S02', prep_total_dilution: 300 }),
      endoItem({ sample_id: 'P-0003-S02' }),
      endoItem({
        sample_id: 'BW-0114-S02',
        sample_identity: 'Bacteriostatic Water',
        sample_type: 'Bacteriostatic Water',
        declared_weight_mg: null,
      }),
    ])
    const rows = bodyRows()
    expect(rows.map(r => cellText(r, 1))).toEqual([
      'P-0001-S02',
      'P-0003-S02',
      'P-0002-S02',
      'BW-0114-S02',
    ])
    expect(rows.map(r => cellText(r, 0))).toEqual(['1', '3', '2', '4'])
    expect(rows.map(r => r.hasAttribute('data-group-start'))).toEqual([
      false,
      false,
      true,
      true,
    ])
    // bac water: one 20x step, 50 uL made to 1000 uL
    const bw = rowOf('BW-0114-S02')
    expect(
      within(bw).getByText('Bacteriostatic water · one step')
    ).toBeInTheDocument()
    expect(within(bw).getByText('+ 950')).toBeInTheDocument()
    // 10 mg in 2 mL at 1:250 loads 0.02 mg/mL on the MCS (fmtConc)
    expect(within(rowOf('P-0001-S02')).getByText('0.02')).toBeInTheDocument()
  })

  it('marks a value set by hand and keeps the standard as the placeholder', () => {
    setup([
      endoItem({ sample_id: 'P-0001-S02', prep_steps: [[30, 10], null, null] }),
    ])
    const row = rowOf('P-0001-S02')
    const s1 = within(row).getByLabelText(
      'Step 1 sample (µL)'
    ) as HTMLInputElement
    expect(s1.value).toBe('30')
    expect(s1.title).toMatch(/^Set by hand\. Computed: 20 µL/)
    const s2 = within(row).getByLabelText(
      'Step 2 sample (µL)'
    ) as HTMLInputElement
    expect(s2.value).toBe('')
    expect(s2.placeholder).toBe('20')
    // 30 uL at 1:10 takes 270 uL of Tris
    expect(within(row).getByText('+ 270')).toBeInTheDocument()
  })

  it('warns when a step overflows the 1.5 mL tube', () => {
    setup([
      endoItem({ sample_id: 'P-0001-S02', prep_steps: [null, null, [800]] }),
    ])
    expect(
      screen.getByText('over the 1.5 mL tube: 1600 µL, take less sample')
    ).toBeInTheDocument()
  })

  it('sends prep_steps as arrays: a ratio typed alone carries the sample volume', () => {
    const item = endoItem({ sample_id: 'P-0001-S02' })
    const { onUpdateItem } = setup([item])
    const ratio = within(rowOf('P-0001-S02')).getByLabelText(
      'Step 1 ratio (1 in N)'
    )
    fireEvent.change(ratio, { target: { value: '15' } })
    fireEvent.blur(ratio)
    expect(onUpdateItem).toHaveBeenCalledWith(item.id, {
      prep_steps: [[20, 15], null, null],
    })
  })

  it('sends null when a step goes back to the standard, and the total on its own field', () => {
    const item = endoItem({
      sample_id: 'P-0001-S02',
      prep_steps: [[20, 15], null, null],
    })
    const { onUpdateItem } = setup([item])
    const row = rowOf('P-0001-S02')
    const ratio = within(row).getByLabelText('Step 1 ratio (1 in N)')
    fireEvent.change(ratio, { target: { value: '' } })
    fireEvent.blur(ratio)
    expect(onUpdateItem).toHaveBeenCalledWith(item.id, { prep_steps: null })
    const total = within(row).getByLabelText('Total dilution (1 in N)')
    fireEvent.change(total, { target: { value: '300' } })
    fireEvent.blur(total)
    expect(onUpdateItem).toHaveBeenCalledWith(item.id, {
      prep_total_dilution: 300,
    })
  })

  it("shows the server's refusal on the row it was sent for", async () => {
    const refusal =
      'prep_total_dilution must be at least 20 (the step 1 ratio x the fixed 1:2 step) or step 2 cannot be made'
    const item = endoItem({ sample_id: 'P-0001-S02' })
    const { onUpdateItem } = setup([
      item,
      endoItem({ sample_id: 'P-0002-S02' }),
    ])
    onUpdateItem.mockResolvedValue(refusal)
    const total = within(rowOf('P-0001-S02')).getByLabelText(
      'Total dilution (1 in N)'
    )
    fireEvent.change(total, { target: { value: '15' } })
    fireEvent.blur(total)
    expect(onUpdateItem).toHaveBeenCalledWith(item.id, {
      prep_total_dilution: 15,
    })
    expect(
      await within(rowOf('P-0001-S02')).findByText(`Not saved: ${refusal}`)
    ).toBeInTheDocument()
    expect(
      within(rowOf('P-0002-S02')).queryByText(/Not saved/)
    ).not.toBeInTheDocument()
  })

  it('keeps a step 1 ratio that does not divide the total in its group, in bench order', () => {
    // 1:15 makes 15 x r6(250 / 30) x 2 = 249.99999, shown as 1:250
    setup([
      endoItem({ sample_id: 'P-0001-S02' }),
      endoItem({ sample_id: 'P-0002-S02', prep_steps: [[20, 15], null, null] }),
      endoItem({ sample_id: 'P-0003-S02' }),
    ])
    const rows = bodyRows()
    expect(rows.map(r => cellText(r, 1))).toEqual([
      'P-0001-S02',
      'P-0002-S02',
      'P-0003-S02',
    ])
    expect(rows.map(r => r.hasAttribute('data-group-start'))).toEqual([
      false,
      false,
      false,
    ])
  })

  it('sends a step 2 or step 3 sample volume as [sample_ul], keeping the other steps', () => {
    const item = endoItem({
      sample_id: 'P-0001-S02',
      prep_steps: [[20, 15], null, null],
    })
    const { onUpdateItem } = setup([item])
    const row = rowOf('P-0001-S02')
    commit(row, 'Step 2 sample (µL)', '40')
    expect(onUpdateItem).toHaveBeenLastCalledWith(item.id, {
      prep_steps: [[20, 15], [40], null],
    })
    commit(row, 'Step 3 sample (µL)', '100')
    expect(onUpdateItem).toHaveBeenLastCalledWith(item.id, {
      prep_steps: [[20, 15], null, [100]],
    })
  })

  it('a later save that succeeds clears the row refusal', async () => {
    const { onUpdateItem } = setup([endoItem({ sample_id: 'P-0001-S02' })])
    onUpdateItem
      .mockResolvedValueOnce(TOTAL_REFUSAL)
      .mockResolvedValueOnce(null)
    commit(rowOf('P-0001-S02'), 'Total dilution (1 in N)', '15')
    expect(
      await screen.findByText(`Not saved: ${TOTAL_REFUSAL}`)
    ).toBeInTheDocument()
    commit(rowOf('P-0001-S02'), 'Total dilution (1 in N)', '300')
    await waitFor(() =>
      expect(screen.queryByText(/Not saved/)).not.toBeInTheDocument()
    )
  })

  it('drops a refusal that lands after a later save on the same row', async () => {
    const { onUpdateItem } = setup([endoItem({ sample_id: 'P-0001-S02' })])
    let refuseFirst: (msg: string) => void = () => undefined
    onUpdateItem
      .mockReturnValueOnce(
        new Promise<string>(resolve => {
          refuseFirst = resolve
        })
      )
      .mockResolvedValueOnce(null)
    commit(rowOf('P-0001-S02'), 'Total dilution (1 in N)', '15')
    commit(rowOf('P-0001-S02'), 'Total dilution (1 in N)', '300')
    await act(async () => {
      refuseFirst(TOTAL_REFUSAL)
    })
    expect(screen.queryByText(/Not saved/)).not.toBeInTheDocument()
  })

  it('shows a refusal of a step field on its row', async () => {
    const item = endoItem({ sample_id: 'P-0001-S02' })
    const { onUpdateItem } = setup([
      item,
      endoItem({ sample_id: 'P-0002-S02' }),
    ])
    const refusal = 'prep_steps step 1: ratio must be at least 1'
    onUpdateItem.mockResolvedValue(refusal)
    commit(rowOf('P-0001-S02'), 'Step 1 ratio (1 in N)', '0.5')
    expect(onUpdateItem).toHaveBeenCalledWith(item.id, {
      prep_steps: [[20, 0.5], null, null],
    })
    expect(
      await within(rowOf('P-0001-S02')).findByText(`Not saved: ${refusal}`)
    ).toBeInTheDocument()
    expect(
      within(rowOf('P-0002-S02')).queryByText(/Not saved/)
    ).not.toBeInTheDocument()
  })

  it('renders no inputs on a completed worksheet', () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })], true)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
