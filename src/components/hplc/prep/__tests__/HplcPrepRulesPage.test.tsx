import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import type { Instrument, PeptideRecord } from '@/lib/api'
import type { HplcPrepRule } from '@/lib/hplc-prep-rules'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getHplcPrepRules: vi.fn(),
  getPeptides: vi.fn(),
  getInstruments: vi.fn(),
  createHplcPrepRule: vi.fn(),
  updateHplcPrepRule: vi.fn(),
  reorderHplcPrepRules: vi.fn(),
}))

import {
  createHplcPrepRule,
  getHplcPrepRules,
  getInstruments,
  getPeptides,
  reorderHplcPrepRules,
  updateHplcPrepRule,
} from '@/lib/api'
import { HplcPrepRulesPage } from '@/components/hplc/prep/HplcPrepRulesPage'

function rule(over: Partial<HplcPrepRule> = {}): HplcPrepRule {
  return {
    id: 1,
    peptide_id: 1,
    min_mg: null,
    max_mg: 30,
    target_conc_ug_ml: null,
    blend_target_conc_ug_ml: null,
    lead_component_id: null,
    lead_priority: null,
    floor_ug_ml: null,
    diluent: null,
    default_instrument_id: null,
    status: 'validated',
    note: 'reads fine at 200 to 30 mg',
    sort_order: 0,
    active: true,
    peptide_name: 'Retatrutide',
    peptide_is_blend: false,
    lead_component_name: null,
    default_instrument_name: null,
    updated_at: '2026-11-12T15:00:00Z',
    ...over,
  }
}

const RETA_30 = rule()
const RETA_OVER_30 = rule({
  id: 2,
  min_mg: 30,
  max_mg: null,
  target_conc_ug_ml: 250,
  status: 'trial',
  note: '60 mg low at 200',
  sort_order: 1,
})

const peptide = (id: number, name: string, abbreviation: string) =>
  ({
    id,
    name,
    abbreviation,
    active: true,
    is_blend: false,
    components: [],
  }) as unknown as PeptideRecord

const instrument = (id: number, name: string, active = true) =>
  ({ id, name, active }) as Instrument

const OVERLAP =
  'overlaps rule 1 (up to 30 mg) for this peptide; where both match, the narrower band wins (an open band is the widest) and a tie goes to the line listed first'
const REFUSED = 'diluent must be one of Water, Water + 0.1% TFA'

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const view = render(<HplcPrepRulesPage />, { wrapper })
  return { qc, view }
}

/** Every query in: the count line (rules) and an instrument option
 *  (instruments; peptides resolve with them). */
async function loaded(count: string) {
  expect(await screen.findByText(count)).toBeInTheDocument()
  expect(
    (await screen.findAllByRole('option', { name: 'HPLC 1' })).length
  ).toBeGreaterThan(0)
}

/** A line's table row (the new one is "new"). */
function rowOf(id: number | 'new'): HTMLElement {
  const row = document.querySelector<HTMLElement>(`tr[data-rule="${id}"]`)
  if (!row) throw new Error(`no row for rule ${id}`)
  return row
}

describe('HplcPrepRulesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getHplcPrepRules).mockResolvedValue([RETA_30, RETA_OVER_30])
    vi.mocked(getPeptides).mockResolvedValue([
      peptide(1, 'Retatrutide', 'RETA'),
      peptide(2, 'Tesamorelin', 'TESA'),
      { ...peptide(3, 'BPC-157 + TB-500', 'BLEND'), is_blend: true },
      { ...peptide(4, 'Semaglutide', 'SEMA'), active: false },
    ])
    vi.mocked(getInstruments).mockResolvedValue([
      instrument(5, 'HPLC 1'),
      instrument(6, 'HPLC old', false),
    ])
  })

  it('shows the columns in the sheet order, and says once how blends work', async () => {
    setup()
    await loaded('2 rules, 1 on trial')
    const heads = screen.getAllByRole('columnheader').map(h => h.textContent)
    expect(heads).toEqual([
      '#',
      'Peptide',
      'Weight (mg)',
      'Target Conc (ug/mL)',
      'Target in a blend (ug/mL)',
      'Lead',
      'Diluent',
      'Floor (ug/mL)',
      'Instrument',
      'Status',
      'Note',
      'Active',
      'Order',
      '',
    ])
    expect(
      screen.getByText(/a blend is made to its lead's target/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/below the floor only warns/i)).toBeInTheDocument()
    expect(
      screen.getByText(/a floor is set on the blend's own line/i)
    ).toBeInTheDocument()
  })

  it('lists the lines in order with their values, and counts them', async () => {
    setup()
    await loaded('2 rules, 1 on trial')
    const second = rowOf(2)
    expect(
      within(second).getByRole('combobox', { name: 'Peptide' })
    ).toHaveTextContent('Retatrutide')
    expect(within(second).getByLabelText('Above mg')).toHaveValue('30')
    expect(within(second).getByLabelText('Target Conc (ug/mL)')).toHaveValue(
      '250'
    )
    expect(within(second).getByLabelText('Status')).toHaveValue('trial')
    expect(within(second).getByLabelText('Note')).toHaveValue(
      '60 mg low at 200'
    )
    expect(within(rowOf(1)).getByText('1')).toBeInTheDocument()
    expect(within(second).getByText('2')).toBeInTheDocument()
    // the retired instrument is not offered
    expect(
      within(second).queryByRole('option', { name: 'HPLC old' })
    ).not.toBeInTheDocument()
  })

  it('adds a line from the catalog search and saves it with every field', async () => {
    const created = rule({
      id: 3,
      peptide_id: 2,
      max_mg: null,
      target_conc_ug_ml: 125,
      diluent: 'Water + 0.1% TFA',
      default_instrument_id: 5,
      status: 'trial',
      note: null,
      sort_order: 2,
      peptide_name: 'Tesamorelin',
      default_instrument_name: 'HPLC 1',
    })
    vi.mocked(createHplcPrepRule).mockResolvedValue({
      rule: created,
      warnings: [],
    })
    setup()
    await loaded('2 rules, 1 on trial')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add rule' }))
    const row = rowOf('new')
    await user.click(within(row).getByRole('combobox', { name: 'Peptide' }))
    await user.type(screen.getByPlaceholderText('Search the catalog…'), 'tesa')
    await user.click(await screen.findByText('Tesamorelin'))
    fireEvent.change(within(row).getByLabelText('Target Conc (ug/mL)'), {
      target: { value: '125' },
    })
    fireEvent.change(within(row).getByLabelText('Diluent'), {
      target: { value: 'Water + 0.1% TFA' },
    })
    fireEvent.change(within(row).getByLabelText('Instrument'), {
      target: { value: '5' },
    })
    await user.click(within(row).getByRole('button', { name: 'Save' }))
    expect(createHplcPrepRule).toHaveBeenCalledWith({
      peptide_id: 2,
      min_mg: null,
      max_mg: null,
      target_conc_ug_ml: 125,
      blend_target_conc_ug_ml: null,
      lead_component_id: null,
      lead_priority: null,
      floor_ug_ml: null,
      diluent: 'Water + 0.1% TFA',
      default_instrument_id: 5,
      status: 'trial',
      note: null,
      active: true,
    })
    expect(await screen.findByText('3 rules, 2 on trial')).toBeInTheDocument()
    expect(
      within(rowOf(3)).getByRole('combobox', { name: 'Peptide' })
    ).toHaveTextContent('Tesamorelin')
  })

  it('offers active peptides and blends in the catalog search, never an inactive one', async () => {
    setup()
    await loaded('2 rules, 1 on trial')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add rule' }))
    await user.click(
      within(rowOf('new')).getByRole('combobox', { name: 'Peptide' })
    )
    const search = screen.getByPlaceholderText('Search the catalog…')
    // the search matches the excluded peptide's own text, so only the page's
    // filter can be hiding it (a search that matched nothing proves nothing)
    await user.type(search, 'glut')
    expect(await screen.findByText('No matching peptide.')).toBeInTheDocument()
    expect(screen.queryByText('Semaglutide')).not.toBeInTheDocument()
    // a blend has its own rules here, so it is offered
    await user.clear(search)
    await user.type(search, 'bpc')
    expect(await screen.findByText('BPC-157 + TB-500')).toBeInTheDocument()
  })

  it("shows the server's 400 text on the row, then a save's warning as a chip", async () => {
    vi.mocked(updateHplcPrepRule)
      .mockRejectedValueOnce(new Error(REFUSED))
      .mockResolvedValueOnce({
        rule: { ...RETA_OVER_30, min_mg: 20 },
        warnings: [OVERLAP],
      })
    setup()
    await loaded('2 rules, 1 on trial')
    const row = rowOf(2)
    fireEvent.change(within(row).getByLabelText('Target Conc (ug/mL)'), {
      target: { value: '300' },
    })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    // only the changed field is sent
    expect(updateHplcPrepRule).toHaveBeenLastCalledWith(2, {
      target_conc_ug_ml: 300,
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Not saved: ${REFUSED}`
    )
    fireEvent.change(within(row).getByLabelText('Target Conc (ug/mL)'), {
      target: { value: '250' },
    })
    fireEvent.change(within(row).getByLabelText('Above mg'), {
      target: { value: '20' },
    })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(OVERLAP)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the warnings a save returns', async () => {
    const warnings = [
      'BPC-157 at 50 ug/mL is below the floor 60 ug/mL; the prep still runs',
      OVERLAP,
    ]
    vi.mocked(updateHplcPrepRule).mockResolvedValue({
      rule: { ...RETA_30, target_conc_ug_ml: 150 },
      warnings,
    })
    setup()
    await loaded('2 rules, 1 on trial')
    const row = rowOf(1)
    fireEvent.change(within(row).getByLabelText('Target Conc (ug/mL)'), {
      target: { value: '150' },
    })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    expect(updateHplcPrepRule).toHaveBeenCalledWith(1, {
      target_conc_ug_ml: 150,
    })
    for (const w of warnings) expect(await screen.findByText(w)).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(within(rowOf(1)).getByLabelText('Target Conc (ug/mL)')).toHaveValue(
      '150'
    )
  })

  it('refuses a value that is not a number on the row, without sending it', async () => {
    setup()
    await loaded('2 rules, 1 on trial')
    const row = rowOf(1)
    fireEvent.change(within(row).getByLabelText('Target Conc (ug/mL)'), {
      target: { value: '1,5' },
    })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not saved: Target Conc (ug/mL) must be a number'
    )
    expect(updateHplcPrepRule).not.toHaveBeenCalled()
  })

  it('moves a line down with the whole order, and shows the order the server returns', async () => {
    vi.mocked(reorderHplcPrepRules).mockResolvedValue([
      { ...RETA_OVER_30, sort_order: 0 },
      { ...RETA_30, sort_order: 1 },
    ])
    setup()
    await loaded('2 rules, 1 on trial')
    expect(
      within(rowOf(1)).getByRole('button', { name: 'Move up' })
    ).toBeDisabled()
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: 'Move down' }))
    expect(reorderHplcPrepRules).toHaveBeenCalledWith([2, 1])
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('tr[data-rule]')].map(r =>
          r.getAttribute('data-rule')
        )
      ).toEqual(['2', '1'])
    )
  })

  it("rebases a row onto a colleague's change, keeping the user's own typing, so Save sends only what the user changed", async () => {
    // A colleague moved line 2's target from 250 to 225 after this page
    // loaded; the user's Move click brings the server's list in.
    const colleague = { ...RETA_OVER_30, target_conc_ug_ml: 225, sort_order: 0 }
    vi.mocked(reorderHplcPrepRules).mockResolvedValue([
      colleague,
      { ...RETA_30, sort_order: 1 },
    ])
    vi.mocked(updateHplcPrepRule).mockResolvedValue({
      rule: { ...colleague, note: 'my note' },
      warnings: [],
    })
    setup()
    await loaded('2 rules, 1 on trial')
    fireEvent.change(within(rowOf(2)).getByLabelText('Note'), {
      target: { value: 'my note' },
    })
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: 'Move up' }))
    expect(reorderHplcPrepRules).toHaveBeenCalledWith([2, 1])
    // the colleague's target shows, the user's note is still being typed
    await waitFor(() =>
      expect(
        within(rowOf(2)).getByLabelText('Target Conc (ug/mL)')
      ).toHaveValue('225')
    )
    expect(within(rowOf(2)).getByLabelText('Note')).toHaveValue('my note')
    // a line nobody edited stays clean
    expect(
      within(rowOf(1)).getByRole('button', { name: 'Save' })
    ).toBeDisabled()
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: 'Save' }))
    // the stale 250 is not sent back over the colleague's 225
    expect(updateHplcPrepRule).toHaveBeenCalledWith(2, { note: 'my note' })
    await waitFor(() =>
      expect(
        within(rowOf(2)).getByRole('button', { name: 'Save' })
      ).toBeDisabled()
    )
    expect(within(rowOf(2)).getByLabelText('Target Conc (ug/mL)')).toHaveValue(
      '225'
    )
  })
})
