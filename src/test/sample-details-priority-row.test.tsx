import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
import { SamplePriorityRow } from '@/components/senaite/SamplePriorityRow'

describe('SamplePriorityRow', () => {
  it('shows the select for a native sample and the read-only hint otherwise', async () => {
    const qc = new QueryClient()
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <SamplePriorityRow
          registryPk={42}
          explicitKey={null}
          effective={{
            key: 'high',
            rank: 10,
            source_level: 'customer',
            source_id: 'Acme',
          }}
        />
      </QueryClientProvider>
    )
    expect(
      await screen.findByRole('combobox', { name: 'Priority' })
    ).toBeInTheDocument()
    rerender(
      <QueryClientProvider client={qc}>
        <SamplePriorityRow
          registryPk={null}
          explicitKey={null}
          effective={null}
        />
      </QueryClientProvider>
    )
    expect(
      screen.getByText('No registry record for this sample yet')
    ).toBeInTheDocument()
  })
})
