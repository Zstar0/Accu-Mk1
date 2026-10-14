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
import type { ConsumableType, EndoPrepRuleOut, PeptideRecord } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getEndoPrepRules: vi.fn(),
  getPeptides: vi.fn(),
  listConsumables: vi.fn(),
  createEndoPrepRule: vi.fn(),
  updateEndoPrepRule: vi.fn(),
  reorderEndoPrepRules: vi.fn(),
}))

import {
  createEndoPrepRule,
  getEndoPrepRules,
  getPeptides,
  listConsumables,
  reorderEndoPrepRules,
  updateEndoPrepRule,
} from '@/lib/api'
import { EndoPrepRulesPage } from '@/components/hplc/endo/EndoPrepRulesPage'

function rule(over: Partial<EndoPrepRuleOut> = {}): EndoPrepRuleOut {
  return {
    id: 1,
    peptide_id: 1,
    min_mg: null,
    max_mg: 30,
    total_dilution: null,
    step1_ratio: null,
    cartridge_type_id: null,
    status: 'validated',
    note: '1:250 fine to 30 mg',
    sort_order: 0,
    active: true,
    peptide_name: 'Retatrutide',
    cartridge_name: null,
    updated_at: '2026-10-14T15:00:00Z',
    ...over,
  }
}

const RETA_30 = rule()
const RETA_OVER_30 = rule({
  id: 2,
  min_mg: 30,
  max_mg: null,
  total_dilution: 300,
  status: 'trial',
  note: '60 mg PPC low at 1:250',
  sort_order: 1,
})

const peptide = (id: number, name: string, abbreviation: string) =>
  ({
    id,
    name,
    abbreviation,
    active: true,
    is_blend: false,
  }) as PeptideRecord

const cartridge: ConsumableType = {
  id: 4,
  kind: 'endo_cartridge',
  name: 'Endosafe 0.01',
  manufacturer: null,
  part_number: null,
  instrument_id: null,
  specs: { sensitivity_eu_ml: 0.01 },
  active: true,
  in_use: false,
}

// Review Focus 5: the server's step 1 floor refusal, word for word (Task 2).
const FLOOR =
  'total_dilution 1:15 is below 2 x the step 1 ratio 1:10, so step 2 cannot be made'
const OVERLAP =
  'overlaps rule 1 (up to 30 mg) for this peptide; where both match, the narrower band wins (an open band is the widest) and a tie goes to the line listed first'
// A PATCH that turns a line back on runs every save check (Task 2).
const RETIRED_CARTRIDGE = 'cartridge 4 is not an active endotoxin cartridge'

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const view = render(<EndoPrepRulesPage />, { wrapper })
  return { qc, view }
}

/** A line's table row (the new one is "new"). */
function rowOf(id: number | 'new'): HTMLElement {
  const row = document.querySelector<HTMLElement>(`tr[data-rule="${id}"]`)
  if (!row) throw new Error(`no row for rule ${id}`)
  return row
}

describe('EndoPrepRulesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getEndoPrepRules).mockResolvedValue([RETA_30, RETA_OVER_30])
    vi.mocked(getPeptides).mockResolvedValue([
      peptide(1, 'Retatrutide', 'RETA'),
      peptide(2, 'Tesamorelin', 'TESA'),
      { ...peptide(3, 'BPC-157 + TB-500', 'BLEND'), is_blend: true },
    ])
    vi.mocked(listConsumables).mockResolvedValue([cartridge])
  })

  it('lists the lines in order with their values, and counts them', async () => {
    setup()
    expect(await screen.findByText('2 rules, 1 on trial')).toBeInTheDocument()
    const second = rowOf(2)
    expect(
      within(second).getByRole('combobox', { name: 'Peptide' })
    ).toHaveTextContent('Retatrutide')
    expect(within(second).getByLabelText('Above mg')).toHaveValue('30')
    expect(within(second).getByLabelText('Total 1:N')).toHaveValue('300')
    expect(within(second).getByLabelText('Status')).toHaveValue('trial')
    expect(within(second).getByLabelText('Note')).toHaveValue(
      '60 mg PPC low at 1:250'
    )
    expect(within(rowOf(1)).getByText('1')).toBeInTheDocument()
    expect(within(second).getByText('2')).toBeInTheDocument()
  })

  it('adds a line from the catalog search and saves it with every field', async () => {
    const created = rule({
      id: 3,
      peptide_id: 2,
      max_mg: null,
      total_dilution: 300,
      cartridge_type_id: 4,
      status: 'trial',
      note: null,
      sort_order: 2,
      peptide_name: 'Tesamorelin',
      cartridge_name: 'Endosafe 0.01',
    })
    vi.mocked(createEndoPrepRule).mockResolvedValue({
      rule: created,
      warnings: [],
    })
    setup()
    await screen.findByText('2 rules, 1 on trial')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add rule' }))
    const row = rowOf('new')
    await user.click(within(row).getByRole('combobox', { name: 'Peptide' }))
    await user.type(screen.getByPlaceholderText('Search the catalog…'), 'tesa')
    // a blend is never offered: it can never match (spec D2)
    expect(screen.queryByText('BPC-157 + TB-500')).not.toBeInTheDocument()
    await user.click(await screen.findByText('Tesamorelin'))
    fireEvent.change(within(row).getByLabelText('Total 1:N'), {
      target: { value: '300' },
    })
    fireEvent.change(within(row).getByLabelText('Cartridge'), {
      target: { value: '4' },
    })
    await user.click(within(row).getByRole('button', { name: 'Save' }))
    expect(createEndoPrepRule).toHaveBeenCalledWith({
      peptide_id: 2,
      min_mg: null,
      max_mg: null,
      total_dilution: 300,
      step1_ratio: null,
      cartridge_type_id: 4,
      status: 'trial',
      note: null,
      active: true,
    })
    expect(await screen.findByText('3 rules, 2 on trial')).toBeInTheDocument()
    expect(
      within(rowOf(3)).getByRole('combobox', { name: 'Peptide' })
    ).toHaveTextContent('Tesamorelin')
  })

  it("shows the server's 400 text on the row, then a save's warning as a chip (Review Focus 5)", async () => {
    vi.mocked(updateEndoPrepRule)
      .mockRejectedValueOnce(new Error(FLOOR))
      .mockResolvedValueOnce({
        rule: { ...RETA_OVER_30, min_mg: 20 },
        warnings: [OVERLAP],
      })
    setup()
    await screen.findByText('2 rules, 1 on trial')
    const row = rowOf(2)
    fireEvent.change(within(row).getByLabelText('Total 1:N'), {
      target: { value: '15' },
    })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    // only the changed field is sent
    expect(updateEndoPrepRule).toHaveBeenLastCalledWith(2, {
      total_dilution: 15,
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Not saved: ${FLOOR}`
    )
    fireEvent.change(within(row).getByLabelText('Total 1:N'), {
      target: { value: '300' },
    })
    fireEvent.change(within(row).getByLabelText('Above mg'), {
      target: { value: '20' },
    })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(OVERLAP)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the cartridge 400 when a line is turned back on with a retired cartridge', async () => {
    vi.mocked(getEndoPrepRules).mockResolvedValue([
      rule({
        cartridge_type_id: 4,
        cartridge_name: 'Endosafe 0.01',
        active: false,
      }),
    ])
    vi.mocked(updateEndoPrepRule).mockRejectedValue(
      new Error(RETIRED_CARTRIDGE)
    )
    setup()
    await screen.findByText('1 rule, 0 on trial')
    const row = rowOf(1)
    fireEvent.click(within(row).getByRole('switch', { name: 'Active' }))
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    // the server re-checks every field, so only the switch is sent
    expect(updateEndoPrepRule).toHaveBeenLastCalledWith(1, { active: true })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `Not saved: ${RETIRED_CARTRIDGE}`
    )
  })

  it('refuses a value that is not a number on the row, without sending it', async () => {
    setup()
    await screen.findByText('2 rules, 1 on trial')
    const row = rowOf(1)
    fireEvent.change(within(row).getByLabelText('Step 1 1:N'), {
      target: { value: '1,5' },
    })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not saved: Step 1 1:N must be a number'
    )
    expect(updateEndoPrepRule).not.toHaveBeenCalled()
  })

  it('moves a line down with the whole order, and shows the order the server returns', async () => {
    vi.mocked(reorderEndoPrepRules).mockResolvedValue([
      { ...RETA_OVER_30, sort_order: 0 },
      { ...RETA_30, sort_order: 1 },
    ])
    setup()
    await screen.findByText('2 rules, 1 on trial')
    expect(
      within(rowOf(1)).getByRole('button', { name: 'Move up' })
    ).toBeDisabled()
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: 'Move down' }))
    expect(reorderEndoPrepRules).toHaveBeenCalledWith([2, 1])
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('tr[data-rule]')].map(r =>
          r.getAttribute('data-rule')
        )
      ).toEqual(['2', '1'])
    )
  })
})
