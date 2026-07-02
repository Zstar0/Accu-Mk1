/**
 * Client-side flag filtering for the flyout.
 *
 * Pure predicate over an already-fetched list — the flyout layers these
 * ephemeral filters on top of whatever the current tab/scope returns, so no
 * new API call is needed. Text matches the title OR the flag's sample id;
 * status/entity narrow by exact match (or `'all'` to pass everything).
 */

import type { FlagResponse } from '@/lib/flags-api'

export interface FlagFilterState {
  text: string
  /** A `FlagStatus` slug, or `'all'`. */
  status: string
  /** An entity-type slug (e.g. `sample`), or `'all'`. */
  entityType: string
  /** A flag-type slug (e.g. `blocker`), or `'all'`. */
  type: string
}

export const EMPTY_FLAG_FILTER: FlagFilterState = {
  text: '',
  status: 'all',
  entityType: 'all',
  type: 'all',
}

/** The best "Sample ID"-ish token to match free text against. */
function sampleToken(flag: FlagResponse): string {
  return flag.entity?.sample_id ?? flag.entity?.label ?? flag.entity_id
}

/** Filter a flag list by free text (title OR sample id), status, entity type,
 *  and flag type. Empty/`'all'` filters are no-ops; the returned array preserves
 *  order. */
export function filterFlags(
  flags: FlagResponse[],
  filter: FlagFilterState
): FlagResponse[] {
  const text = filter.text.trim().toLowerCase()
  const { status, entityType, type } = filter

  if (!text && status === 'all' && entityType === 'all' && type === 'all')
    return flags

  return flags.filter(flag => {
    if (status !== 'all' && flag.status !== status) return false
    if (entityType !== 'all' && flag.entity_type !== entityType) return false
    if (type !== 'all' && flag.type !== type) return false
    if (text) {
      const haystack = `${flag.title} ${sampleToken(flag)}`.toLowerCase()
      if (!haystack.includes(text)) return false
    }
    return true
  })
}
