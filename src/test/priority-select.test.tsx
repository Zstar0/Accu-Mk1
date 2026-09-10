import { describe, it, expect, vi } from 'vitest'
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react'
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
      key: 'rush',
      name: 'Rush',
      rank: 20,
      icon: 'flame',
      color: 'red',
      pulse: true,
      is_default: false,
      is_active: false,
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
  it('defaults to the bare "Priority" label and takes a per-entity override', async () => {
    // List surfaces mount one control per row, so a shared name would make
    // every trigger ambiguous; single-control surfaces keep the bare default.
    const { unmount } = wrap(
      <PrioritySelect
        level="order"
        id="3291"
        explicitKey={null}
        effective={null}
      />
    )
    expect(
      await screen.findByRole('combobox', { name: 'Priority' })
    ).toBeVisible()
    unmount()
    wrap(
      <PrioritySelect
        level="order"
        id="3291"
        explicitKey={null}
        effective={null}
        ariaLabel="Priority for order 3291"
      />
    )
    expect(
      await screen.findByRole('combobox', { name: 'Priority for order 3291' })
    ).toBeVisible()
  })

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
    // The explicit value wins the trigger: no inherit label leaks through.
    expect(trigger).not.toHaveTextContent(/Inherit/)
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

  it('calls onAssigned after a successful assign', async () => {
    const onAssigned = vi.fn()
    wrap(
      <PrioritySelect
        level="sample"
        id="42"
        explicitKey={null}
        effective={null}
        onAssigned={onAssigned}
      />
    )
    const trigger = await screen.findByRole('combobox', { name: 'Priority' })
    await waitFor(() => expect(trigger).toHaveTextContent('Inherit (Default)'))
    expect(onAssigned).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('option', { name: 'High' }))
    await waitFor(() => expect(assignPriority).toHaveBeenCalled())
    // Fires only once the mutation resolves — surfaces whose data is not in
    // react-query refetch off this.
    await waitFor(() => expect(onAssigned).toHaveBeenCalledTimes(1))
  })

  it('keeps a deactivated explicit priority visible and selectable', async () => {
    wrap(
      <PrioritySelect
        level="sample"
        id="42"
        explicitKey="rush"
        effective={{
          key: 'rush',
          rank: 20,
          source_level: 'sample',
          source_id: '42',
        }}
      />
    )
    const trigger = await screen.findByRole('combobox', { name: 'Priority' })
    await waitFor(() => expect(trigger).toHaveTextContent('Rush (inactive)'))
    fireEvent.click(trigger)
    const list = within(await screen.findByRole('listbox'))
    expect(
      list.getAllByRole('option', { name: 'Rush (inactive)' })
    ).toHaveLength(1)
    expect(list.getByRole('option', { name: 'High' })).toBeInTheDocument()
  })
})
