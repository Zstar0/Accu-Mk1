import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

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
  assignPriority: vi.fn(async (b: unknown) => ({
    ...(b as object),
    old_key: null,
    new_key: 'high',
    affected_sample_pks: [1],
  })),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { assignPriority } from '@/lib/api-priorities'
import { PrioritySelect } from '@/components/common/PrioritySelect'

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('PrioritySelect', () => {
  it('labels the inherit option with the effective source and assigns on change', async () => {
    wrap(
      <PrioritySelect
        level="sample"
        id="42"
        explicitKey={null}
        effective={{
          key: 'high',
          rank: 10,
          source_level: 'customer',
          source_id: 'Acme',
        }}
      />
    )
    const trigger = await screen.findByRole('combobox', { name: 'Priority' })
    // The label resolves the effective name from the loaded list, so wait for
    // the query (which also un-disables the trigger) before interacting.
    await waitFor(() =>
      expect(trigger).toHaveTextContent('Inherit (High via customer (Acme))')
    )
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('option', { name: 'High' }))
    await waitFor(() =>
      expect(assignPriority).toHaveBeenCalledWith({
        level: 'sample',
        id: '42',
        priority_key: 'high',
      })
    )
  })

  it('sends null when the explicit value is cleared back to inherit', async () => {
    wrap(
      <PrioritySelect
        level="order"
        id="ORD-7"
        explicitKey="high"
        effective={{
          key: 'high',
          rank: 10,
          source_level: 'order',
          source_id: 'ORD-7',
        }}
        compact
      />
    )
    const trigger = await screen.findByRole('combobox', { name: 'Priority' })
    await waitFor(() => expect(trigger).toHaveTextContent('High'))
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('option', { name: /^Inherit/ }))
    await waitFor(() =>
      expect(assignPriority).toHaveBeenCalledWith({
        level: 'order',
        id: 'ORD-7',
        priority_key: null,
      })
    )
  })
})
