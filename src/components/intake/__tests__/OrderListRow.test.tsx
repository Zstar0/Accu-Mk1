import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { OrderListRow } from '@/components/intake/OrderListRow'
import type { EnrichedOrderGroup } from '@/lib/inbox-orders'
import type { ExplorerOrder, SenaiteSample } from '@/lib/api'

// OrderExpectedVials fetches the box-label summary lazily — stub it so the row
// renders without a real backend.
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getOrderBoxLabelSummary: vi
      .fn()
      .mockResolvedValue({ counts: { hplc: 0, endo: 0, ster: 0 } }),
  }
})

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
  return render(
    <OrderListRow
      group={group}
      selected={false}
      onToggle={vi.fn()}
      onProcess={vi.fn()}
      // Presentational now: the parent list supplies the batched summary
      // (per-row fetching melted the DB pool — prod brownout 2026-07-09).
      expectedVialsSummary={{
        order_number: '7',
        order_date: null,
        counts: { hplc: 2, endo: 1, ster: 0 },
      }}
    />,
    { wrapper }
  )
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

  it('renders a single row with the samples/vials sub-line under the order #', () => {
    const { container } = renderRow(makeGroup(7, 'a@b.com'))
    // Collapsed to one row — no spanning secondary row remains.
    expect(container.querySelectorAll('tr')).toHaveLength(1)
    expect(screen.getByText(/1 sample/)).toBeInTheDocument()
  })

  it('omits standalone "—" placeholders when client and email are present', async () => {
    renderRow(makeGroup(7, 'a@b.com'))
    expect(screen.getByText('acme')).toBeInTheDocument()
    // The batched summary is passed as a prop, so the cell renders
    // immediately — no query to settle.
    expect(screen.getByText(/expected vial/)).toBeInTheDocument()
    expect(screen.queryByText('—')).toBeNull()
  })

  it('toggles selection via the leading checkbox', () => {
    const onToggle = vi.fn()
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <table>
          <tbody>{children}</tbody>
        </table>
      </QueryClientProvider>
    )
    render(
      <OrderListRow
        group={makeGroup(7, 'a@b.com')}
        selected={false}
        onToggle={onToggle}
        onProcess={vi.fn()}
      />,
      { wrapper }
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /Select WP-1042/ }))
    expect(onToggle).toHaveBeenCalledWith('WP-1042')
  })

  it('renders no checkbox for the No-order group', () => {
    const group: EnrichedOrderGroup = {
      orderKey: null,
      orderLabel: 'No order',
      clientId: 'acme',
      samples: [
        { id: 'S-1', sample_type: 'Peptide', review_state: 'sample_due' },
      ] as unknown as SenaiteSample[],
      order: null,
    }
    renderRow(group)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})

// ── Tracking + Customer Note columns (2026-08-30) ───────────────────────────
// Tracking used to live inside the Order cell's subtitle, wedged after the
// sample count and expected-vials text. Both now have their own column, and
// the note column is customer-origin only (the backend query guarantees that).

describe('OrderListRow tracking + customer note columns', () => {
  function groupWith(over: Record<string, unknown>): EnrichedOrderGroup {
    const g = makeGroup(7, 'a@b.com')
    return {
      ...g,
      samples: [{ ...g.samples[0], ...over }] as unknown as SenaiteSample[],
    }
  }

  it('renders the customer note in its own cell', () => {
    renderRow(
      groupWith({ customer_note: 'Customer note (order #1042): ship cold' })
    )
    const note = screen.getByTestId('customer-note')
    expect(note).toHaveTextContent('Customer note (order #1042): ship cold')
    // Its own cell — not folded into the Order cell's subtitle line.
    expect(note.closest('td')).not.toHaveTextContent('WP-1042')
  })

  it('renders no note cell content when the sample has none', () => {
    renderRow(groupWith({}))
    expect(screen.queryByTestId('customer-note')).toBeNull()
  })

  it('renders the tracking number outside the order cell', () => {
    renderRow(groupWith({ tracking_number: '1Z999AA10123456784' }))
    const tracking = screen.getByText('1Z999AA10123456784')
    expect(tracking.closest('td')).not.toHaveTextContent('WP-1042')
  })
})
