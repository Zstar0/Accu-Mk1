import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  samplePrioritiesLookup,
  type SamplePriorityLookupItem,
} from '@/lib/api'

/**
 * Dedup + drop empties + sort. The single normalization step shared by the
 * cache key hash and the request payload, so the two can never drift.
 * (E.g., if a future change adds whitespace trimming, both call sites get it
 * for free.)
 */
function normalizeUids(uids: string[]): string[] {
  return Array.from(new Set(uids.filter(Boolean))).sort()
}

/**
 * Sort + dedupe + drop-empties + join. A stable, order-independent hash of
 * the UID set — two calls with `['a','b']` and `['b','a','a']` produce the
 * same key, so navigation between pages that share samples reuses the
 * 5-minute-stale cache instead of refetching the entire set.
 *
 * Separator `'|'` is safe because SENAITE sample UIDs are alphanumeric — they
 * never contain a pipe. If that assumption ever changes, switch to a NUL
 * (`\x00`) separator.
 */
export function sortedUidsHash(uids: string[]): string {
  return normalizeUids(uids).join('|')
}

export const samplePrioritiesQueryKeys = {
  lookup: (hash: string) => ['sample-priorities', 'lookup', hash] as const,
}

export function useSamplePriorities(uids: string[]) {
  const normalized = normalizeUids(uids)
  const hash = normalized.join('|')
  return useQuery({
    queryKey: samplePrioritiesQueryKeys.lookup(hash),
    // Re-derive from `uids` inside the closure so the payload stays in lockstep
    // with the queryKey hash (both run through `normalizeUids` — single source
    // of truth).
    queryFn: () => samplePrioritiesLookup(normalizeUids(uids)),
    staleTime: 1000 * 60 * 5,
    enabled: normalized.length > 0,
    // Hold the previous result while a new UID set is in-flight so the
    // composite hook's isLoading doesn't flip back to true on every
    // sample-lookup arrival (which would flash OrderSlaCell to '…').
    placeholderData: keepPreviousData,
  })
}

export type { SamplePriorityLookupItem }
