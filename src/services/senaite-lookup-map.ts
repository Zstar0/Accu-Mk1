import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { ExplorerOrder, SenaiteLookupResult } from '@/lib/api'
import { enqueueSenaiteLookup } from '@/components/explorer/senaite-queue'

export interface SenaiteLookupEntry {
  data?: SenaiteLookupResult
  isLoading: boolean
  isError: boolean
}

export interface SenaiteLookupMapResult {
  /** senaiteId → lookup query state. Keyed by senaite_id (human sample id). */
  sampleLookupMap: Map<string, SenaiteLookupEntry>
  /** Unique senaite_ids collected from the orders (failed/empty skipped). */
  sampleIds: string[]
  /** True while any underlying per-sample lookup is still loading. */
  isLoading: boolean
  /** True if any underlying per-sample lookup errored. */
  isError: boolean
  /** True while any lookup is re-fetching (isFetching) — distinct from
   *  isLoading; stays true during a background refresh that has cached data. */
  isFetching: boolean
  /** Oldest `cached_at` across resolved lookups (ISO string), or null. Drives
   *  a "last updated" timestamp. */
  lastCachedAt: string | null
}

/**
 * Per-sample SENAITE lookup map for a list of orders. Extracts the chain that
 * was duplicated inline in OrderStatusPage and CustomerStatusPage: collect the
 * unique senaite_ids referenced by the orders' sample_results, fire one
 * serialized SENAITE lookup per id (via enqueueSenaiteLookup, which throttles
 * to avoid overwhelming Zope), and expose a Map keyed by senaite_id.
 *
 * The query key `['senaite','lookup',id]` is shared across every surface that
 * uses this hook, so a lookup fetched on one page is reused warm on another.
 * Feed the returned `sampleLookupMap` to `useOrderSlaStatuses(orders, map)`.
 */
export function useSenaiteLookupMap(orders: ExplorerOrder[]): SenaiteLookupMapResult {
  // Collect unique sample IDs from the orders (skip failed/empty ones).
  const sampleIds = useMemo(() => {
    const ids: string[] = []
    for (const order of orders) {
      if (!order.sample_results) continue
      for (const entry of Object.values(order.sample_results)) {
        if (
          entry.senaite_id &&
          entry.status !== 'failed' &&
          !ids.includes(entry.senaite_id)
        ) {
          ids.push(entry.senaite_id)
        }
      }
    }
    return ids
  }, [orders])

  // Fetch sample details from SENAITE — serialized to avoid overwhelming Zope.
  const sampleQueries = useQueries({
    queries: sampleIds.map(id => ({
      queryKey: ['senaite', 'lookup', id],
      queryFn: () => enqueueSenaiteLookup(id),
      staleTime: 15 * 60_000,
      retry: 1,
    })),
  })

  const sampleLookupMap = useMemo(() => {
    const map = new Map<string, SenaiteLookupEntry>()
    // `sampleQueries[idx]` is always defined (useQueries returns one result per
    // input synchronously); the `?? true`/`?? false` fallbacks are defensive
    // carryovers from the inline chains this hook replaces.
    sampleIds.forEach((id, idx) => {
      map.set(id, {
        data: sampleQueries[idx]?.data,
        isLoading: sampleQueries[idx]?.isLoading ?? true,
        isError: sampleQueries[idx]?.isError ?? false,
      })
    })
    return map
  }, [sampleIds, sampleQueries])

  const isLoading = sampleQueries.some(q => q.isLoading)
  const isError = sampleQueries.some(q => q.isError)
  const isFetching = sampleQueries.some(q => q.isFetching)
  const lastCachedAt = useMemo(() => {
    let oldest: string | null = null
    for (const q of sampleQueries) {
      const ts = q.data?.cached_at
      if (ts && (!oldest || ts < oldest)) oldest = ts
    }
    return oldest
  }, [sampleQueries])

  return { sampleLookupMap, sampleIds, isLoading, isError, isFetching, lastCachedAt }
}
