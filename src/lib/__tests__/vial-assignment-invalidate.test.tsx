import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { invalidateVialAssignmentCaches } from '@/lib/vial-assignment'

// Behavioral contract: after a vial role re-assignment, every active query that
// renders assignment state must refetch — the parent page's sub-samples list,
// the parent AR-table overlay (parent-overlay-vial-analyses), and the quicklook
// dialog's per-vial analyses. Keys are asserted as literals on purpose: they
// must match what SampleDetails/VialsQuickLookDialog register. The foreign
// sub-samples key proves the list invalidation is scoped to the parent.

describe('invalidateVialAssignmentCaches', () => {
  it('refetches sub-samples, parent overlay, and quicklook queries for the parent only', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)

    const subsFn = vi.fn(async () => 'subs')
    const overlayFn = vi.fn(async () => [])
    const quicklookFn = vi.fn(async () => [])
    const foreignFn = vi.fn(async () => 'foreign')

    // Mount real useQuery hooks (staleTime Infinity → only an explicit
    // invalidation can refetch them), mirroring the app's surfaces.
    renderHook(
      () => {
        useQuery({ queryKey: ['sub-samples', 'P-0144'], queryFn: subsFn, staleTime: Infinity })
        useQuery({ queryKey: ['parent-overlay-vial-analyses', 21], queryFn: overlayFn, staleTime: Infinity })
        useQuery({ queryKey: ['quicklook-vial-analyses', 21], queryFn: quicklookFn, staleTime: Infinity })
        useQuery({ queryKey: ['sub-samples', 'P-9999'], queryFn: foreignFn, staleTime: Infinity })
      },
      { wrapper }
    )

    await waitFor(() => {
      expect(subsFn).toHaveBeenCalledTimes(1)
      expect(overlayFn).toHaveBeenCalledTimes(1)
      expect(quicklookFn).toHaveBeenCalledTimes(1)
      expect(foreignFn).toHaveBeenCalledTimes(1)
    })

    invalidateVialAssignmentCaches(qc, 'P-0144')

    await waitFor(() => {
      expect(subsFn).toHaveBeenCalledTimes(2)
      expect(overlayFn).toHaveBeenCalledTimes(2)
      expect(quicklookFn).toHaveBeenCalledTimes(2)
    })
    // scoped: a different parent's sub-samples list is untouched
    expect(foreignFn).toHaveBeenCalledTimes(1)

    qc.clear()
  })
})
