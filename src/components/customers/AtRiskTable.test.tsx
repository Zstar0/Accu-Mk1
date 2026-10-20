import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AtRiskRow, CrmTouch } from '@/lib/api'
import { AtRiskTable } from './AtRiskTable'
import { row, touch } from './insights-test-fixtures'

const atRisk = (over: Partial<AtRiskRow> = {}): AtRiskRow => ({
  ...row({
    key: 'wc:1',
    name: 'Halcyon Research Supply',
    rep: 'Scott Joseph',
    orders: 31,
    usual_gap_days: 9,
    last_order_at: '2026-08-21T15:00:00Z',
  }),
  spend_12m: '84210.00',
  overdue: 5.2,
  ...over,
})
const crm: CrmTouch = {
  state: 'ok',
  at: '2026-10-12T15:00:00Z',
  type: 'email',
  direction: 'outbound',
  who: 'Scott',
  title: 'Checking in',
  preview: '',
  lead_name: 'Halcyon',
  lead_url: null,
  stale: false,
  reason: null,
}

describe('AtRiskTable', () => {
  it('renders the row and the gated touch column, and opens the customer or its CRM tab', async () => {
    const onOpen = vi.fn()
    render(
      <AtRiskTable
        rows={[atRisk()]}
        tz="America/Los_Angeles"
        touch={touch({
          crmVisible: true,
          supportVisible: false,
          rows: { 'wc:1': { crm, support: null } },
        })}
        onOpenCustomer={onOpen}
      />
    )
    const tr = screen
      .getByText('Halcyon Research Supply')
      .closest('tr') as HTMLElement
    for (const text of ['Scott Joseph', '$84,210', '31', '9 d', 'Aug 21'])
      expect(tr).toHaveTextContent(text)
    expect(tr).toHaveTextContent('5.2× gap')
    expect(tr).toHaveTextContent('Oct 12')
    expect(
      screen.getByRole('columnheader', { name: 'Last CRM' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('columnheader', { name: 'Last support' })
    ).toBeNull()
    await userEvent.click(within(tr).getByRole('button'))
    expect(onOpen).toHaveBeenCalledWith('wc:1', 'crm')
    await userEvent.click(within(tr).getByText('Halcyon Research Supply'))
    expect(onOpen).toHaveBeenLastCalledWith('wc:1')
  })

  it('shows loading cells in both columns while the touch row is still absent', () => {
    render(
      <AtRiskTable
        rows={[atRisk()]}
        tz="UTC"
        touch={touch({ crmVisible: true, supportVisible: true })}
        onOpenCustomer={vi.fn()}
      />
    )
    const loading = screen.getAllByLabelText(/loading/i)
    expect(loading).toHaveLength(2)
    expect(loading[0]).toHaveAttribute('aria-busy', 'true')
  })
})
