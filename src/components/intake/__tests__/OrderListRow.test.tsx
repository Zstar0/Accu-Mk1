import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { OrderListRow } from '@/components/intake/OrderListRow'
import type { EnrichedOrderGroup } from '@/lib/inbox-orders'
import type { ExplorerOrder, SenaiteSample } from '@/lib/api'

// OrderExpectedVials fetches the box-label summary lazily — stub it so the row
// renders without a real backend. The SLA cell pulls in i18n + tooltip; replace
// it with a sentinel so the test stays focused on the email-link branch.
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getOrderBoxLabelSummary: vi
      .fn()
      .mockResolvedValue({ counts: { hplc: 0, endo: 0, ster: 0 } }),
  }
})

vi.mock('@/components/explorer/OrderSlaCell', () => ({
  OrderSlaCell: () => <span data-testid="sla-cell" />,
}))

function makeGroup(
  customerId: number | null,
  email: string | null
): EnrichedOrderGroup {
  const order = {
    order_number: 'WP-1042',
    customer_id: customerId,
    payload: email ? { billing: { email } } : {},
    created_at: '2026-06-24T15:00:00Z',
  } as unknown as ExplorerOrder
  return {
    orderKey: 'WP-1042',
    orderLabel: 'WP-1042',
    clientId: 'acme',
    samples: [
      { id: 'S-1', sample_type: 'Peptide', review_state: 'sample_due' },
    ] as unknown as SenaiteSample[],
    order,
  }
}

function renderRow(group: EnrichedOrderGroup) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <table>
        <tbody>{children}</tbody>
      </table>
    </QueryClientProvider>
  )
  return render(<OrderListRow group={group} onProcess={vi.fn()} />, { wrapper })
}

describe('OrderListRow', () => {
  it('renders a linked email when customer_id is set', () => {
    renderRow(makeGroup(7, 'a@b.com'))
    const link = screen.getByRole('link', { name: 'a@b.com' })
    expect(link).toHaveAttribute(
      'href',
      '#accumark-tools/customer-detail?id=7'
    )
  })

  it('renders plain email text (no link) when customer_id is null', () => {
    renderRow(makeGroup(null, 'a@b.com'))
    expect(screen.getByText('a@b.com')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders the Created date for the order', () => {
    renderRow(makeGroup(7, 'a@b.com'))
    // formatDate renders a localized "Jun …" string for the 2026-06-24 created_at.
    expect(screen.getByText(/Jun/)).toBeInTheDocument()
  })
})
