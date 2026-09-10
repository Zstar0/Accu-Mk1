import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import type { ReactNode } from 'react'

// The wizard is heavy and irrelevant here — the row under test lives in the
// session's own summary strip, not inside the wizard (which is rendered with
// hideSampleInfo).
vi.mock('@/components/intake/ReceiveWizard/ReceiveWizard', () => ({
  ReceiveWizard: () => <div data-testid="receive-wizard" />,
}))
vi.mock('@/lib/complete-checkin', () => ({
  completeCheckIn: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/api-priorities', () => ({
  getPriorities: vi.fn(async () => [
    {
      key: 'high',
      name: 'High',
      rank: 10,
      icon: 'chevron-up',
      color: 'amber',
      pulse: false,
      is_default: false,
      is_active: true,
      sla_tier_id: null,
    },
    {
      key: 'default',
      name: 'Default',
      rank: 0,
      icon: 'minus',
      color: 'zinc',
      pulse: false,
      is_default: true,
      is_active: true,
      sla_tier_id: null,
    },
  ]),
  assignPriority: vi.fn(),
}))

const refresh = vi.fn()
let refreshError: string | null = null
vi.mock('@/components/intake/ReceiveWizard/useParentSampleDetails', () => ({
  useParentSampleDetails: () => ({
    details: {
      client: 'Acme',
      contact: null,
      sample_type: null,
      client_order_number: 'WP-1',
      client_sample_id: null,
      client_lot: null,
      declared_weight_mg: null,
      analytes: [],
      registry_pk: 42,
      explicit_priority_key: null,
      priority: {
        key: 'high',
        rank: 10,
        source_level: 'customer',
        source_id: 'Acme',
      },
    },
    loading: false,
    error: null,
    refreshError,
    refresh,
  }),
}))

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    listSubSamples: vi.fn(async () =>
      Promise.resolve({ parent: { sub_sample_count: 0 } })
    ),
    getSenaiteSamples: vi.fn(async () => Promise.resolve({ items: [] })),
  }
})

import { OrderReceiveSession } from '@/components/intake/OrderReceiveSession'
import type { OrderGroup } from '@/lib/inbox-orders'
import type { SenaiteSample } from '@/lib/api'

const orders: OrderGroup[] = [
  {
    orderKey: 'WP-1',
    orderLabel: 'WP-1',
    clientId: 'acme',
    samples: [{ id: 'PB-1', uid: 'uid-PB-1' } as unknown as SenaiteSample],
  },
]

function renderSession() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return render(<OrderReceiveSession orders={orders} onClose={vi.fn()} />, {
    wrapper,
  })
}

describe('OrderReceiveSession priority row', () => {
  it('renders the sample priority control in the session summary strip', async () => {
    refreshError = null
    renderSession()
    expect(
      await screen.findByRole('combobox', { name: 'Priority' })
    ).toBeInTheDocument()
    expect(screen.queryByText(/values shown may be out of date/i)).toBeNull()
  })

  it('shows the stale-details line when a details refresh failed', async () => {
    refreshError = 'SENAITE 503'
    renderSession()
    expect(
      await screen.findByText(/values shown may be out of date/i)
    ).toBeInTheDocument()
  })
})
