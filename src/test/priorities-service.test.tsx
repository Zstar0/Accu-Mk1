import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('@/lib/api-priorities', () => ({
  getPriorities: vi.fn(async () => [
    { key: 'expedited', name: 'Expedited', rank: 20, icon: 'chevrons-up', color: 'red', pulse: true, is_default: false, is_active: true, sla_tier_id: null },
    { key: 'retired', name: 'Retired', rank: 5, icon: 'minus', color: 'zinc', pulse: false, is_default: false, is_active: false, sla_tier_id: null },
    { key: 'default', name: 'Default', rank: 0, icon: 'minus', color: 'zinc', pulse: false, is_default: true, is_active: true, sla_tier_id: null },
  ]),
  assignPriority: vi.fn(async () => ({ level: 'customer', id: '1', old_key: null, new_key: 'high', affected_sample_pks: [] })),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { useActivePriorities, useAssignPriority, priorityQueryKeys } from '@/services/priorities'

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useActivePriorities', () => {
  it('drops inactive rows and keeps rank order', async () => {
    const { result } = renderHook(() => useActivePriorities(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data?.map(p => p.key)).toEqual(['expedited', 'default'])
  })
})

describe('useAssignPriority', () => {
  it('invalidates the customer priorities query after a customer-level assign', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(priorityQueryKeys.customers, [])
    expect(qc.getQueryState(priorityQueryKeys.customers)?.isInvalidated).toBe(false)

    const { result } = renderHook(() => useAssignPriority(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    })
    await result.current.mutateAsync({ level: 'customer', id: '1', priority_key: 'high' })
    await waitFor(() =>
      expect(qc.getQueryState(priorityQueryKeys.customers)?.isInvalidated).toBe(true))
  })
})
