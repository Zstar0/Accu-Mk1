import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { invalidateVialAssignmentCaches, invalidateParentVialOverlay } from '@/lib/vial-assignment'

// Behavioral contract: after a vial role re-assignment, every active query that
// renders assignment state must refetch — the parent page's sub-samples list,
// the parent AR-table overlay (parent-overlay-vial-analyses), the quicklook
// dialog's per-vial analyses, and the order-scoped vials list that feeds the
// Boxing tab (['order-vials', orderKey, sampleIds]). Keys are asserted as
// literals on purpose: they must match what SampleDetails/VialsQuickLookDialog/
// BoxStep register. The foreign sub-samples key proves the list invalidation is
// scoped to the parent.

describe('invalidateVialAssignmentCaches', () => {
  it('refetches sub-samples, parent overlay, quicklook, and order-vials queries for the parent only', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)

    const subsFn = vi.fn(async () => 'subs')
    const overlayFn = vi.fn(async () => [])
    const quicklookFn = vi.fn(async () => [])
    const orderVialsFn = vi.fn(async () => [])
    const foreignFn = vi.fn(async () => 'foreign')

    // Mount real useQuery hooks (staleTime Infinity → only an explicit
    // invalidation can refetch them), mirroring the app's surfaces. The
    // order-vials probe mirrors BoxStep's ['order-vials', orderKey, sampleIds]
    // shape so the partial-prefix invalidation is what catches it.
    renderHook(
      () => {
        useQuery({ queryKey: ['sub-samples', 'P-0144'], queryFn: subsFn, staleTime: Infinity })
        useQuery({ queryKey: ['parent-overlay-vial-analyses', 21], queryFn: overlayFn, staleTime: Infinity })
        useQuery({ queryKey: ['quicklook-vial-analyses', 21], queryFn: quicklookFn, staleTime: Infinity })
        useQuery({ queryKey: ['order-vials', 'ORD-42', ['P-0144-S02']], queryFn: orderVialsFn, staleTime: Infinity })
        useQuery({ queryKey: ['sub-samples', 'P-9999'], queryFn: foreignFn, staleTime: Infinity })
      },
      { wrapper }
    )

    await waitFor(() => {
      expect(subsFn).toHaveBeenCalledTimes(1)
      expect(overlayFn).toHaveBeenCalledTimes(1)
      expect(quicklookFn).toHaveBeenCalledTimes(1)
      expect(orderVialsFn).toHaveBeenCalledTimes(1)
      expect(foreignFn).toHaveBeenCalledTimes(1)
    })

    invalidateVialAssignmentCaches(qc, 'P-0144')

    await waitFor(() => {
      expect(subsFn).toHaveBeenCalledTimes(2)
      expect(overlayFn).toHaveBeenCalledTimes(2)
      expect(quicklookFn).toHaveBeenCalledTimes(2)
      // Boxing refreshes: the order-scoped vials list picks up the new role
      // without a page reload.
      expect(orderVialsFn).toHaveBeenCalledTimes(2)
    })
    // scoped: a different parent's sub-samples list is untouched
    expect(foreignFn).toHaveBeenCalledTimes(1)

    qc.clear()
  })
})

// Light tier: a single vial-analysis edit inside QuickLook (result, method, or
// instrument) changes what the parent AR overlay shows for THAT vial only
// (analyst, state, method, instrument). It must refetch only that vial's
// overlay query — not every vial, and not the heavier sub-samples/quicklook
// caches (those stay optimistic / untouched to avoid flicker on every cell save).
describe('invalidateParentVialOverlay', () => {
  function mountProbes(qc: QueryClient) {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
    const overlay21 = vi.fn(async () => [])
    const overlay22 = vi.fn(async () => [])
    const subsFn = vi.fn(async () => 'subs')
    const quicklookFn = vi.fn(async () => [])
    renderHook(
      () => {
        useQuery({ queryKey: ['parent-overlay-vial-analyses', 21], queryFn: overlay21, staleTime: Infinity })
        useQuery({ queryKey: ['parent-overlay-vial-analyses', 22], queryFn: overlay22, staleTime: Infinity })
        useQuery({ queryKey: ['sub-samples', 'P-0144'], queryFn: subsFn, staleTime: Infinity })
        useQuery({ queryKey: ['quicklook-vial-analyses', 21], queryFn: quicklookFn, staleTime: Infinity })
      },
      { wrapper }
    )
    return { overlay21, overlay22, subsFn, quicklookFn }
  }

  it('refetches only the given vial overlay, leaving siblings and other caches alone', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { overlay21, overlay22, subsFn, quicklookFn } = mountProbes(qc)

    await waitFor(() => {
      expect(overlay21).toHaveBeenCalledTimes(1)
      expect(overlay22).toHaveBeenCalledTimes(1)
      expect(subsFn).toHaveBeenCalledTimes(1)
      expect(quicklookFn).toHaveBeenCalledTimes(1)
    })

    invalidateParentVialOverlay(qc, 21)

    await waitFor(() => {
      expect(overlay21).toHaveBeenCalledTimes(2)
    })
    // surgical: sibling vial + the cheaper caches are untouched
    expect(overlay22).toHaveBeenCalledTimes(1)
    expect(subsFn).toHaveBeenCalledTimes(1)
    expect(quicklookFn).toHaveBeenCalledTimes(1)

    qc.clear()
  })

  it('refetches every vial overlay when no pk is given (parent-wide refresh)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { overlay21, overlay22, subsFn } = mountProbes(qc)

    await waitFor(() => {
      expect(overlay21).toHaveBeenCalledTimes(1)
      expect(overlay22).toHaveBeenCalledTimes(1)
    })

    invalidateParentVialOverlay(qc)

    await waitFor(() => {
      expect(overlay21).toHaveBeenCalledTimes(2)
      expect(overlay22).toHaveBeenCalledTimes(2)
    })
    // overlay-only: sub-samples list is not part of this helper's job
    expect(subsFn).toHaveBeenCalledTimes(1)

    qc.clear()
  })
})
