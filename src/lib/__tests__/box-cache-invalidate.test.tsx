import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { invalidateBoxCaches } from '@/lib/box-cache'

// Behavioral contract: after a box mutation (create/assign/unassign/delete/
// print/close), every active query that renders box state must refetch — the
// Boxing tab's boxes+vials, the Active Boxes page, the sample-header box chip
// (sub-samples), and the worksheet Box column. Keys are asserted as literals
// on purpose: they must match what BoxStep/ActiveBoxesPage/SampleDetails/
// worksheets register.

function mountProbes(qc: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
  const orderBoxesFn = vi.fn(async () => [])
  const orderVialsFn = vi.fn(async () => [])
  const activeBoxesFn = vi.fn(async () => [])
  const subsFn = vi.fn(async () => 'subs')
  const worksheetsFn = vi.fn(async () => [])
  const foreignOrderBoxesFn = vi.fn(async () => [])
  renderHook(
    () => {
      useQuery({ queryKey: ['order-boxes', 'WP-1042'], queryFn: orderBoxesFn, staleTime: Infinity })
      // Mirrors BoxStep's ['order-vials', orderKey, sampleIds] shape — the
      // prefix invalidation is what must catch it.
      useQuery({ queryKey: ['order-vials', 'WP-1042', ['P-1']], queryFn: orderVialsFn, staleTime: Infinity })
      useQuery({ queryKey: ['active-boxes'], queryFn: activeBoxesFn, staleTime: Infinity })
      useQuery({ queryKey: ['sub-samples', 'P-1'], queryFn: subsFn, staleTime: Infinity })
      useQuery({ queryKey: ['worksheets'], queryFn: worksheetsFn, staleTime: Infinity })
      useQuery({ queryKey: ['order-boxes', 'WP-9999'], queryFn: foreignOrderBoxesFn, staleTime: Infinity })
    },
    { wrapper },
  )
  return { orderBoxesFn, orderVialsFn, activeBoxesFn, subsFn, worksheetsFn, foreignOrderBoxesFn }
}

async function settle(fns: Record<string, ReturnType<typeof vi.fn>>) {
  await waitFor(() => {
    for (const fn of Object.values(fns)) expect(fn).toHaveBeenCalledTimes(1)
  })
}

describe('invalidateBoxCaches', () => {
  it('with an orderKey: refetches every box surface, scoping the order-level keys', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const fns = mountProbes(qc)
    await settle(fns)

    await invalidateBoxCaches(qc, 'WP-1042')

    await waitFor(() => {
      expect(fns.orderBoxesFn).toHaveBeenCalledTimes(2)
      expect(fns.orderVialsFn).toHaveBeenCalledTimes(2)
      expect(fns.activeBoxesFn).toHaveBeenCalledTimes(2)
      expect(fns.subsFn).toHaveBeenCalledTimes(2)
      expect(fns.worksheetsFn).toHaveBeenCalledTimes(2)
    })
    // Scoped: another order's box list is untouched.
    expect(fns.foreignOrderBoxesFn).toHaveBeenCalledTimes(1)

    qc.clear()
  })

  it('without an orderKey: the order-level keys invalidate broadly (order unknown)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const fns = mountProbes(qc)
    await settle(fns)

    await invalidateBoxCaches(qc)

    await waitFor(() => {
      expect(fns.orderBoxesFn).toHaveBeenCalledTimes(2)
      expect(fns.orderVialsFn).toHaveBeenCalledTimes(2)
      expect(fns.foreignOrderBoxesFn).toHaveBeenCalledTimes(2)
      expect(fns.activeBoxesFn).toHaveBeenCalledTimes(2)
      expect(fns.subsFn).toHaveBeenCalledTimes(2)
      expect(fns.worksheetsFn).toHaveBeenCalledTimes(2)
    })

    qc.clear()
  })
})
