import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { OrderReceiveSession } from '@/components/intake/OrderReceiveSession'
import { completeCheckIn } from '@/lib/complete-checkin'
import type { OrderGroup } from '@/lib/inbox-orders'
import type { SenaiteSample } from '@/lib/api'

// Boxing is now an order-scoped tab inside the wizard, not a session stage.
// Capture the props the session hands the wizard so we can assert it passes the
// active order's boxing scope and the order-managed receive flag; render the
// sample id so the rail is testable.
const receiveWizardProps: Array<{
  boxing?: { orderKey: string; sampleIds: string[] }
  orderManaged?: boolean
}> = []
vi.mock('@/components/intake/ReceiveWizard/ReceiveWizard', () => ({
  ReceiveWizard: (props: {
    boxing?: { orderKey: string; sampleIds: string[] }
    orderManaged?: boolean
  }) => {
    receiveWizardProps.push(props)
    return <div data-testid="receive-wizard" />
  },
}))

// The header "Complete Check-In" button owns the order-level receive; spy on
// the helper so we can assert which samples (uid/sampleId/vialCount) it gets.
vi.mock('@/lib/complete-checkin', () => ({
  completeCheckIn: vi.fn().mockResolvedValue(undefined),
}))

// Per-sample header/rail enrichment hits the backend; stub to a stable empty
// shape so rows render without a real SENAITE lookup.
vi.mock('@/components/intake/ReceiveWizard/useParentSampleDetails', () => ({
  useParentSampleDetails: () => ({ details: null, loading: false }),
}))

// Per-sample vial counts drive both the rail ✓ and the header's N-of-M count.
// Default: no vials; individual tests override via `subCounts`.
const subCounts: Record<string, number> = {}
// The all-states order lookup feeding the boxing scope (already-received
// samples have left the due list the session was opened from). Default: none;
// individual tests push items.
const allStatesItems: Array<{ id: string; client_order_number: string }> = []
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    listSubSamples: vi.fn((id: string) =>
      Promise.resolve({ parent: { sub_sample_count: subCounts[id] ?? 0 } })
    ),
    getSenaiteSamples: vi.fn(() => Promise.resolve({ items: allStatesItems })),
  }
})

const sample = (id: string): SenaiteSample =>
  ({ id, uid: `uid-${id}` }) as unknown as SenaiteSample

const order = (orderKey: string, sampleIds: string[]): OrderGroup => ({
  orderKey,
  orderLabel: orderKey,
  clientId: 'acme',
  samples: sampleIds.map(sample),
})

function renderSession(orders: OrderGroup[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const onClose = vi.fn()
  const utils = render(
    <OrderReceiveSession orders={orders} onClose={onClose} />,
    { wrapper }
  )
  return { ...utils, onClose }
}

describe('OrderReceiveSession (orders[])', () => {
  beforeEach(() => {
    receiveWizardProps.length = 0
    vi.mocked(completeCheckIn).mockClear()
    for (const k of Object.keys(subCounts)) delete subCounts[k]
    allStatesItems.length = 0
  })

  const twoOrders = [
    order('WP-1042', ['P-1101', 'P-1102']),
    order('WP-1043', ['P-1108']),
  ]

  it('renders a rail separator per order and every sample', () => {
    renderSession(twoOrders)
    // Both order labels appear as rail separators.
    expect(screen.getByText('WP-1042')).toBeInTheDocument()
    expect(screen.getByText('WP-1043')).toBeInTheDocument()
    // Every sample across both orders renders in the rail. (P-1101 is also the
    // active sample, so it surfaces in the header too — hence getAllByText.)
    expect(screen.getAllByText('P-1101').length).toBeGreaterThan(0)
    expect(screen.getByText('P-1102')).toBeInTheDocument()
    expect(screen.getByText('P-1108')).toBeInTheDocument()
  })

  it('uses an N-orders header for a combined session', () => {
    renderSession(twoOrders)
    // Appears in both the visually-hidden DialogTitle and the visible header.
    expect(screen.getAllByText('Receive 2 orders').length).toBeGreaterThan(0)
  })

  it('hands the wizard the active order’s boxing scope (order-scoped tab)', () => {
    renderSession(twoOrders)
    // No standalone boxing stage anymore — no rail Boxing button.
    expect(
      screen.queryByRole('button', { name: /Boxing/i })
    ).not.toBeInTheDocument()
    // The wizard mounts for the active sample (P-1101, first order) and gets
    // that order's whole scope for its Boxing tab.
    const last = receiveWizardProps[receiveWizardProps.length - 1]
    expect(last?.boxing?.orderKey).toBe('WP-1042')
    expect(last?.boxing?.sampleIds).toEqual(['P-1101', 'P-1102'])
  })

  it('boxing scope unions already-received samples from the all-states order query', async () => {
    allStatesItems.push(
      { id: 'P-1101', client_order_number: 'WP-1042' }, // still due — deduped
      { id: 'P-1099', client_order_number: 'WP-1042' }, // received earlier, off the due list
      { id: 'P-9999', client_order_number: 'WP-9999' } // fuzzy-search noise from another order
    )
    renderSession(twoOrders)

    await waitFor(() => {
      const last = receiveWizardProps[receiveWizardProps.length - 1]
      expect(last?.boxing?.sampleIds).toEqual(['P-1101', 'P-1102', 'P-1099'])
    })
  })

  it('marks the embedded wizard order-managed so its finish does not receive', () => {
    renderSession(twoOrders)
    const last = receiveWizardProps[receiveWizardProps.length - 1]
    expect(last?.orderManaged).toBe(true)
  })

  it('uses a single-order header for length 1', () => {
    renderSession([order('WP-1042', ['P-1101'])])
    expect(screen.getAllByText(/Receive WP-1042/).length).toBeGreaterThan(0)
  })

  it('labels Complete Check-In with the vialed-of-total count', async () => {
    subCounts['P-1101'] = 2
    subCounts['P-1102'] = 0
    subCounts['P-1108'] = 1
    renderSession(twoOrders)
    // 2 of 3 samples have >=1 vial across both orders.
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: /Complete Check-In · 2 of 3 samples/i,
        })
      ).toBeInTheDocument()
    )
  })

  it('Complete Check-In receives the order’s samples then closes', async () => {
    subCounts['P-1101'] = 2
    subCounts['P-1102'] = 0
    subCounts['P-1108'] = 1
    const { onClose } = renderSession(twoOrders)

    const btn = await screen.findByRole('button', {
      name: /Complete Check-In/i,
    })
    await waitFor(() => expect(btn).not.toBeDisabled())
    fireEvent.click(btn)

    await waitFor(() => expect(completeCheckIn).toHaveBeenCalledTimes(1))
    expect(completeCheckIn).toHaveBeenCalledWith([
      { uid: 'uid-P-1101', sampleId: 'P-1101', vialCount: 2 },
      { uid: 'uid-P-1102', sampleId: 'P-1102', vialCount: 0 },
      { uid: 'uid-P-1108', sampleId: 'P-1108', vialCount: 1 },
    ])
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('re-fetches counts before receiving so a just-vialed sample is not skipped', async () => {
    subCounts['P-1101'] = 1
    renderSession(twoOrders)

    const btn = await screen.findByRole('button', {
      name: /Complete Check-In · 1 of 3 samples/i,
    })
    await waitFor(() => expect(btn).not.toBeDisabled())

    // A vial lands on P-1102 AFTER the initial fetch (the wizard's save path
    // hits the API directly) — the pre-receive refetch must pick it up.
    subCounts['P-1102'] = 2
    fireEvent.click(btn)

    await waitFor(() => expect(completeCheckIn).toHaveBeenCalledTimes(1))
    expect(completeCheckIn).toHaveBeenCalledWith([
      { uid: 'uid-P-1101', sampleId: 'P-1101', vialCount: 1 },
      { uid: 'uid-P-1102', sampleId: 'P-1102', vialCount: 2 },
      { uid: 'uid-P-1108', sampleId: 'P-1108', vialCount: 0 },
    ])
  })

  it('disables Complete Check-In when no sample has a vial', async () => {
    renderSession(twoOrders)
    const btn = await screen.findByRole('button', {
      name: /Complete Check-In · 0 of 3 samples/i,
    })
    expect(btn).toBeDisabled()
  })

  describe('sample-selection dropdown', () => {
    it('lists every sample; vialed rows checked, unvialed rows disabled', async () => {
      subCounts['P-1101'] = 2
      subCounts['P-1102'] = 0
      subCounts['P-1108'] = 1
      renderSession(twoOrders)
      await screen.findByRole('button', {
        name: /Complete Check-In · 2 of 3 samples/i,
      })

      fireEvent.pointerDown(
        screen.getByRole('button', { name: /select samples to check in/i })
      )

      const item1101 = await screen.findByRole('menuitemcheckbox', {
        name: /P-1101/,
      })
      const item1102 = screen.getByRole('menuitemcheckbox', { name: /P-1102/ })
      const item1108 = screen.getByRole('menuitemcheckbox', { name: /P-1108/ })
      expect(item1101).toHaveAttribute('aria-checked', 'true')
      expect(item1108).toHaveAttribute('aria-checked', 'true')
      expect(item1102).toHaveAttribute('aria-checked', 'false')
      expect(item1102).toHaveAttribute('aria-disabled', 'true')
      expect(item1102.textContent).toMatch(/no vials/i)
    })

    it('unchecking a sample excludes it from the receive and updates the count', async () => {
      subCounts['P-1101'] = 2
      subCounts['P-1108'] = 1
      const { onClose } = renderSession(twoOrders)
      await screen.findByRole('button', {
        name: /Complete Check-In · 2 of 3 samples/i,
      })

      fireEvent.pointerDown(
        screen.getByRole('button', { name: /select samples to check in/i })
      )
      const item1108 = await screen.findByRole('menuitemcheckbox', {
        name: /P-1108/,
      })
      // Radix menu items activate via keyboard in jsdom (pointer-event
      // sequences don't fully register); Enter toggles the checkbox item.
      fireEvent.keyDown(item1108, { key: 'Enter' })
      // The open menu is modal (rest of the app aria-hidden) — close it
      // before querying the button by role.
      fireEvent.keyDown(item1108, { key: 'Escape' })

      const btn = await screen.findByRole('button', {
        name: /Complete Check-In · 1 of 3 samples/i,
      })
      await waitFor(() => expect(btn).not.toBeDisabled())
      fireEvent.click(btn)

      await waitFor(() => expect(completeCheckIn).toHaveBeenCalledTimes(1))
      expect(completeCheckIn).toHaveBeenCalledWith([
        { uid: 'uid-P-1101', sampleId: 'P-1101', vialCount: 2 },
        { uid: 'uid-P-1102', sampleId: 'P-1102', vialCount: 0 },
      ])
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    })

    it('disables Complete Check-In when every vialed sample is unchecked', async () => {
      subCounts['P-1101'] = 2
      renderSession(twoOrders)
      await screen.findByRole('button', {
        name: /Complete Check-In · 1 of 3 samples/i,
      })

      fireEvent.pointerDown(
        screen.getByRole('button', { name: /select samples to check in/i })
      )
      const item1101 = await screen.findByRole('menuitemcheckbox', {
        name: /P-1101/,
      })
      fireEvent.keyDown(item1101, { key: 'Enter' })
      fireEvent.keyDown(item1101, { key: 'Escape' })

      const btn = await screen.findByRole('button', {
        name: /Complete Check-In · 0 of 3 samples/i,
      })
      expect(btn).toBeDisabled()
    })
  })
})
