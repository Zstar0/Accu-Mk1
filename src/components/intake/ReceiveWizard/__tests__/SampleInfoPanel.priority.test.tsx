import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { SampleInfoPanel } from '@/components/intake/ReceiveWizard/SampleInfoPanel'

describe('SampleInfoPanel priority', () => {
  it('renders the Priority row with the effective source when the sample is native', async () => {
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <SampleInfoPanel
          loading={false}
          error={null}
          details={
            {
              client: 'Acme',
              contact: 'J',
              sample_type: 'Peptide',
              client_order_number: '3291',
              profiles: [],
              analytes: [],
              registry_pk: 42,
              explicit_priority_key: null,
              priority: {
                key: 'high',
                rank: 10,
                source_level: 'customer',
                source_id: 'Acme',
              },
            } as never
          }
        />
      </QueryClientProvider>
    )
    // The trigger's label needs the priority catalog (react-query) to resolve
    // before it can name the effective priority — it reads "Default" for one
    // render while the catalog is in flight.
    const trigger = await screen.findByRole('combobox', { name: 'Priority' })
    await waitFor(() =>
      expect(trigger).toHaveTextContent('Inherit (High via customer (Acme))')
    )
  })
})
