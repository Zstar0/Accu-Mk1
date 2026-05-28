import { useQuery } from '@tanstack/react-query'
import {
  samplePrioritiesLookup,
  type SamplePriorityLookupItem,
} from '@/lib/api'

/**
 * Sort + dedupe + join — a stable, order-independent hash. Two calls with
 * ['a','b'] and ['b','a','a'] produce the same key, so navigation between
 * pages that share samples reuses the 5-minute-stale cache instead of
 * refetching the entire set.
 */
export function sortedUidsHash(uids: string[]): string {
  return Array.from(new Set(uids)).sort().join('|')
}

export const samplePrioritiesQueryKeys = {
  lookup: (hash: string) => ['sample-priorities', 'lookup', hash] as const,
}

export function useSamplePriorities(uids: string[]) {
  const hash = sortedUidsHash(uids)
  return useQuery({
    queryKey: samplePrioritiesQueryKeys.lookup(hash),
    // Read sortedUids inside the queryFn so the closure stays stable across
    // renders that produce the same hash (TanStack identifies queries by key).
    queryFn: () => samplePrioritiesLookup(Array.from(new Set(uids)).sort()),
    staleTime: 1000 * 60 * 5,
    enabled: uids.length > 0,
  })
}

export type { SamplePriorityLookupItem }
