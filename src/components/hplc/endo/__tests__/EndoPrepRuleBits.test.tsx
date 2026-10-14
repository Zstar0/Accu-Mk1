import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EndoSampleDilutionBox } from '@/components/hplc/endo/EndoSampleDilutionBox'
import type {
  PrepRulesReapplyCandidate,
  PrepRulesReapplyResult,
} from '@/lib/api'
import type {
  EndoPrepRule,
  PrepHistoryEntry,
  PrepRuleLock,
} from '@/lib/endo-prep-rules'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import { endoBoxProps, endoItem } from './endo-fixtures'

// Box 2 under method rules (slice 5, spec 9). endoWorksheet: run cartridge
// 3 (0.05); the method allows 3 and 4 (0.01). endoItem: Retatrutide, 10 mg.

function rule(over: Partial<EndoPrepRule> = {}): EndoPrepRule {
  return {
    id: 1,
    peptide_id: 7,
    min_mg: null,
    max_mg: null,
    total_dilution: 300,
    step1_ratio: null,
    cartridge_type_id: null,
    status: 'trial',
    note: '60 mg PPC low at 1:250',
    sort_order: 0,
    active: true,
    ...over,
  }
}

function lock(r: EndoPrepRule | null): PrepRuleLock {
  return {
    rule: r,
    locked_at: '2026-10-14T15:00:00Z',
    locked_by: 'print',
    user_id: 5,
  }
}

const pep = (over: Partial<WorksheetItemRow> = {}) =>
  endoItem({ sample_peptide_id: 7, ...over })

function setup(
  items: WorksheetItemRow[],
  rules: EndoPrepRule[],
  extra: {
    isCompleted?: boolean
    candidates?: PrepRulesReapplyCandidate[]
    onReapply?: (ids: number[]) => Promise<PrepRulesReapplyResult[]>
    rulesFailed?: boolean
  } = {}
) {
  const { props, onUpdateItem } = endoBoxProps(
    items,
    {},
    extra.isCompleted ?? false,
    rules
  )
  render(
    <EndoSampleDilutionBox
      {...props}
      reapplyCandidates={extra.candidates}
      onReapply={extra.onReapply}
      rulesFailed={extra.rulesFailed}
    />
  )
  return { onUpdateItem }
}

function rowOf(sampleId: string): HTMLElement {
  const row = screen.getByText(sampleId).closest('tr')
  if (!row) throw new Error(`no row for ${sampleId}`)
  return row
}

function commit(row: HTMLElement, label: string, value: string) {
  const input = within(row).getByLabelText(label)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

describe('Box 2 under method rules', () => {
  it('tags a ruled row, a locked one and a special prep; a row no rule reaches has none', () => {
    setup(
      [
        pep({ sample_id: 'P-0001-S02' }),
        pep({
          sample_id: 'P-0002-S02',
          prep_rule: lock(rule({ id: 2, status: 'validated' })),
        }),
        pep({
          sample_id: 'P-0003-S02',
          prep_rules_off: true,
          prep_note: 'dissolved in 4 mL',
        }),
        pep({ sample_id: 'P-0004-S02', sample_peptide_id: 8 }),
      ],
      [rule()]
    )
    const one = rowOf('P-0001-S02')
    expect(within(one).getByText('rule (trial)')).toBeInTheDocument()
    expect(within(one).queryByText('locked')).not.toBeInTheDocument()
    const two = rowOf('P-0002-S02')
    expect(within(two).getByText('rule')).toBeInTheDocument()
    expect(within(two).getByText('locked')).toBeInTheDocument()
    expect(
      within(rowOf('P-0003-S02')).getByText('special prep')
    ).toBeInTheDocument()
    // nothing but its id in the Sample ID cell
    expect(
      within(rowOf('P-0004-S02')).getAllByRole('cell')[1]?.textContent
    ).toBe('P-0004-S02')
  })

  it('hovers the line, its status, its note and the lock', async () => {
    setup([pep({ sample_id: 'P-0001-S02' })], [rule()])
    await userEvent.setup().hover(screen.getByText('rule (trial)'))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Retatrutide any weight · 1:300 total')
    expect(tip).toHaveTextContent('Status: trial')
    expect(tip).toHaveTextContent('Note: 60 mg PPC low at 1:250')
    expect(tip).toHaveTextContent('Not locked: it follows edits to the rule')
  })

  it("defaults to the rule's total and step 1 ratio without marking them set by hand", () => {
    const item = pep({ sample_id: 'P-0001-S02' })
    const { onUpdateItem } = setup(
      [item],
      [rule({ total_dilution: 300, step1_ratio: 5 })]
    )
    const row = rowOf('P-0001-S02')
    const total = within(row).getByLabelText('Total dilution (1 in N)')
    expect(total).toHaveAttribute('placeholder', '300')
    expect(total).toHaveValue('')
    const ratio = within(row).getByLabelText(
      'Step 1 ratio (1 in N)'
    ) as HTMLInputElement
    expect(ratio.placeholder).toBe('5')
    expect(ratio.value).toBe('')
    expect(ratio.title).toBe('')
    // 20 uL at the rule's 1:5 takes 80 uL of Tris
    expect(within(row).getByText('+ 80')).toBeInTheDocument()
    // a sample volume typed on a ruled ratio never pins the rule's ratio
    fireEvent.change(within(row).getByLabelText('Step 1 sample (µL)'), {
      target: { value: '30' },
    })
    fireEvent.blur(within(row).getByLabelText('Step 1 sample (µL)'))
    expect(onUpdateItem).toHaveBeenLastCalledWith(item.id, {
      prep_steps: [[30, null], null, null],
    })
    // the method's 1:250 typed over the rule is the row's own value (D6)
    fireEvent.change(total, { target: { value: '250' } })
    fireEvent.blur(total)
    expect(onUpdateItem).toHaveBeenLastCalledWith(item.id, {
      prep_total_dilution: 250,
    })
  })

  it("keeps a typed 1:250 over a 1:300 rule, and the rule's total or a cleared cell goes back to the rule (D6)", () => {
    const item = pep({ sample_id: 'P-0001-S02', prep_total_dilution: 250 })
    const { onUpdateItem } = setup([item], [rule({ total_dilution: 300 })])
    const row = rowOf('P-0001-S02')
    const total = within(row).getByLabelText(
      'Total dilution (1 in N)'
    ) as HTMLInputElement
    // the typed 250 shows as set by hand, over the rule's 300
    expect(total.value).toBe('250')
    expect(total.placeholder).toBe('300')
    expect(total.title).toMatch(/^Set by hand\. Computed: 300 /)
    commit(row, 'Total dilution (1 in N)', '300')
    expect(onUpdateItem).toHaveBeenLastCalledWith(item.id, {
      prep_total_dilution: null,
    })
    commit(row, 'Total dilution (1 in N)', '')
    expect(onUpdateItem).toHaveBeenLastCalledWith(item.id, {
      prep_total_dilution: null,
    })
    expect(onUpdateItem).toHaveBeenCalledTimes(2)
  })

  it('switches a row to no rule and saves its note through the item PATCH', () => {
    const on = pep({ sample_id: 'P-0001-S02' })
    const off = pep({ sample_id: 'P-0002-S02', prep_rules_off: true })
    const { onUpdateItem } = setup([on, off], [rule()])
    fireEvent.click(
      within(rowOf('P-0001-S02')).getByRole('switch', {
        name: 'No rule (special prep)',
      })
    )
    expect(onUpdateItem).toHaveBeenLastCalledWith(on.id, {
      prep_rules_off: true,
    })
    expect(
      within(rowOf('P-0001-S02')).queryByLabelText('Special prep note')
    ).not.toBeInTheDocument()
    const note = within(rowOf('P-0002-S02')).getByLabelText('Special prep note')
    fireEvent.change(note, { target: { value: 'dissolved in 4 mL' } })
    fireEvent.blur(note)
    expect(onUpdateItem).toHaveBeenLastCalledWith(off.id, {
      prep_note: 'dissolved in 4 mL',
    })
  })

  it("shows the server's 409 on a promoted row through the row's refusal", async () => {
    const promoted = 'the row is promoted; its prep is final'
    const item = pep({ sample_id: 'P-0001-S02' })
    const { onUpdateItem } = setup([item], [rule()])
    onUpdateItem.mockResolvedValue(promoted)
    commit(rowOf('P-0001-S02'), 'Total dilution (1 in N)', '400')
    expect(onUpdateItem).toHaveBeenLastCalledWith(item.id, {
      prep_total_dilution: 400,
    })
    expect(
      await within(rowOf('P-0001-S02')).findByText(`Not saved: ${promoted}`)
    ).toBeInTheDocument()
    // the switch is a prep field too, and saves through the same refusal
    fireEvent.click(
      within(rowOf('P-0001-S02')).getByRole('switch', {
        name: 'No rule (special prep)',
      })
    )
    expect(onUpdateItem).toHaveBeenLastCalledWith(item.id, {
      prep_rules_off: true,
    })
    expect(
      await within(rowOf('P-0001-S02')).findByText(`Not saved: ${promoted}`)
    ).toBeInTheDocument()
  })

  it('has no switch on a completed worksheet', () => {
    setup([pep({ sample_id: 'P-0001-S02' })], [rule()], { isCompleted: true })
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('says so when the rules did not load', () => {
    setup([pep({ sample_id: 'P-0001-S02' })], [], { rulesFailed: true })
    expect(
      screen.getByText('Prep rules did not load; rows show the standard.')
    ).toBeInTheDocument()
  })

  it("opens a row's past runs with EU per vial and the verdict worked out again", async () => {
    const past = (over: Partial<PrepHistoryEntry>): PrepHistoryEntry => ({
      at: '2026-10-13T15:00:00Z',
      by: 5,
      why: 'reapply',
      lock: lock(rule()),
      total_dilution: 300,
      step1_ratio: 10,
      cartridge_type_id: 3,
      result_reading: '0.8',
      reader_test_id: 'T1',
      result_entered_at: '2026-10-12T18:00:00Z',
      ...over,
    })
    setup(
      [
        pep({
          sample_id: 'P-0001-S02',
          prep_history: [
            past({
              at: '2026-10-12T15:00:00Z',
              lock: lock(null),
              total_dilution: 250,
              result_reading: '<0.05',
              why: 'override',
            }),
            past({}),
          ],
        }),
      ],
      []
    )
    fireEvent.click(screen.getByRole('button', { name: 'History (2)' }))
    const dialog = await screen.findByRole('dialog')
    const [, newest, oldest] = within(dialog).getAllByRole('row')
    if (!newest || !oldest) throw new Error('two past runs')
    // 0.8 x 300 x 2 mL = 480 EU per vial: over 350, a fail
    expect(newest).toHaveTextContent('Re-apply')
    expect(newest).toHaveTextContent(
      'Retatrutide any weight · 1:300 total (trial)'
    )
    expect(newest).toHaveTextContent('480')
    expect(newest).toHaveTextContent('Fail')
    // <0.05 x 250 x 2 mL = <25: a pass, run on the standard
    expect(oldest).toHaveTextContent('override')
    expect(oldest).toHaveTextContent('the standard')
    expect(oldest).toHaveTextContent('<25')
    expect(oldest).toHaveTextContent('Pass')
  })

  it("lists exactly the preview's candidates, with old against new for each (A.0 item 2)", async () => {
    const old = rule({ id: 1, total_dilution: 300 })
    const next = rule({ id: 2, total_dilution: 400 })
    const ruled = pep({
      sample_id: 'P-0001-S02',
      prep_rule: lock(old),
      cartridge_type_id: 3,
      cartridge_sensitivity_eu_ml: 0.05,
      result_reading: '<0.05',
    })
    // a typed 1:500 beats both lines: only its line moves
    const typed = pep({
      sample_id: 'P-0002-S02',
      prep_rule: lock(old),
      prep_total_dilution: 500,
    })
    // locked to the standard, and a line matches it now
    const standard = pep({ sample_id: 'P-0003-S02', prep_rule: lock(null) })
    const candidates = [
      { item: ruled, was: old },
      { item: typed, was: old },
      { item: standard, was: null },
    ].map(({ item, was }) => ({
      item_id: item.id,
      sample_id: item.sample_id,
      old: lock(was),
      new_rule: next,
    }))
    const onReapply = vi.fn().mockResolvedValue(
      [ruled, typed, standard].map(it => ({
        item_id: it.id,
        applied: true,
        reason: null,
      }))
    )
    setup([ruled, typed, standard], [next], { candidates, onReapply })
    fireEvent.click(screen.getByRole('button', { name: 'Re-apply rules (3)' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(3)
    const inDialog = (sampleId: string) => {
      const tr = within(dialog).getByText(sampleId).closest('tr')
      if (!tr) throw new Error(`no dialog row for ${sampleId}`)
      return tr
    }
    // old against new: 0.05 x 300 x 2 = 30, x 400 x 2 = 40
    const one = inDialog('P-0001-S02')
    expect(one).toHaveTextContent('1:300 to 1:400')
    expect(one).toHaveTextContent('30 to 40')
    expect(one).toHaveTextContent('<30 to <40')
    // figures that do not change still show, with the old and new line
    const two = inDialog('P-0002-S02')
    expect(two).toHaveTextContent(
      'Retatrutide any weight · 1:300 total (trial)to Retatrutide any weight · 1:400 total (trial)'
    )
    expect(two).toHaveTextContent('1:500')
    expect(two).not.toHaveTextContent('1:500 to')
    const three = inDialog('P-0003-S02')
    expect(three).toHaveTextContent(
      'the standardto Retatrutide any weight · 1:400 total (trial)'
    )
    expect(three).toHaveTextContent('1:250 to 1:400')
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Re-apply 3 rows' })
    )
    expect(onReapply).toHaveBeenCalledWith([ruled.id, typed.id, standard.id])
    expect(await within(dialog).findAllByText('Re-applied')).toHaveLength(3)
  })

  it('lists a candidate whose row is not on the page yet, by its sample id', async () => {
    const ruled = pep({ sample_id: 'P-0001-S02', prep_rule: lock(rule()) })
    setup([ruled], [], {
      candidates: [
        {
          item_id: 999_999,
          sample_id: 'P-0009-S02',
          old: lock(rule()),
          new_rule: null,
        },
      ],
      onReapply: vi.fn(),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Re-apply rules (1)' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('P-0009-S02')).toBeInTheDocument()
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1)
  })

  it('shows a row the server refused, with its reason', async () => {
    const old = rule({ total_dilution: 300 })
    const ruled = pep({ sample_id: 'P-0001-S02', prep_rule: lock(old) })
    const onReapply = vi.fn().mockResolvedValue([
      {
        item_id: ruled.id,
        applied: false,
        reason: 'already promoted',
      },
    ])
    setup([ruled], [], {
      candidates: [
        {
          item_id: ruled.id,
          sample_id: ruled.sample_id,
          old: lock(old),
          new_rule: null,
        },
      ],
      onReapply,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Re-apply rules (1)' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('to the standard')).toBeInTheDocument()
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Re-apply 1 row' })
    )
    expect(
      await within(dialog).findByText('Not re-applied: already promoted')
    ).toBeInTheDocument()
  })

  it('has no Re-apply without candidates or on a completed worksheet', () => {
    const old = rule()
    const ruled = pep({ sample_id: 'P-0001-S02', prep_rule: lock(old) })
    const candidates = [
      {
        item_id: ruled.id,
        sample_id: ruled.sample_id,
        old: lock(old),
        new_rule: rule({ total_dilution: 400 }),
      },
    ]
    setup([ruled], [], { candidates: [], onReapply: vi.fn() })
    expect(screen.queryByRole('button', { name: /Re-apply rules/ })).toBeNull()
    setup([ruled], [], {
      isCompleted: true,
      candidates,
      onReapply: vi.fn(),
    })
    expect(screen.queryByRole('button', { name: /Re-apply rules/ })).toBeNull()
  })
})
