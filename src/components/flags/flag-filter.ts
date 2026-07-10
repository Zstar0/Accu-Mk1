/**
 * Client-side flag filtering for the flyout.
 *
 * Pure predicate over an already-fetched list — the flyout layers these
 * ephemeral filters on top of whatever the current tab/scope returns, so no
 * new API call is needed. Text matches the title OR the flag's sample id;
 * status/entity narrow by exact match (or `'all'` to pass everything).
 */

import type { FlagResponse, FlagStatus } from '@/lib/flags-api'
import { OPEN_STATUSES } from '@/components/flags/flag-status'

export interface FlagFilterState {
  text: string
  /** A `FlagStatus` slug, `'all_open'` (open ∪ in_progress ∪ blocked), or `'all'`. */
  status: string
  /** An entity-type slug (e.g. `sample`), or `'all'`. */
  entityType: string
  /** A flag-type slug (e.g. `blocker`), or `'all'`. */
  type: string
  /** `'all'`, `'none'` (unassigned), or a user id as a decimal string. */
  assignee: string
}

export const EMPTY_FLAG_FILTER: FlagFilterState = {
  text: '',
  status: 'all',
  entityType: 'all',
  type: 'all',
  assignee: 'all',
}

/** The best "Sample ID"-ish token to match free text against. Empty for a
 *  null-anchor general task. */
function sampleToken(flag: FlagResponse): string {
  return flag.entity?.sample_id ?? flag.entity?.label ?? flag.entity_id ?? ''
}

/** Filter a flag list by free text (title OR sample id), status, entity type,
 *  and flag type. Empty/`'all'` filters are no-ops; the returned array preserves
 *  order. */
export function filterFlags(
  flags: FlagResponse[],
  filter: FlagFilterState
): FlagResponse[] {
  const text = filter.text.trim().toLowerCase()
  const { status, entityType, type, assignee } = filter

  if (
    !text &&
    status === 'all' &&
    entityType === 'all' &&
    type === 'all' &&
    assignee === 'all'
  )
    return flags

  return flags.filter(flag => {
    if (status === 'all_open') {
      if (!OPEN_STATUSES.includes(flag.status as FlagStatus)) return false
    } else if (status !== 'all' && flag.status !== status) return false
    if (entityType !== 'all' && flag.entity_type !== entityType) return false
    if (type !== 'all' && flag.type !== type) return false
    if (assignee === 'none') {
      if (flag.assignee_id != null) return false
    } else if (assignee !== 'all' && String(flag.assignee_id) !== assignee) {
      return false
    }
    if (text) {
      const haystack = `${flag.title} ${sampleToken(flag)}`.toLowerCase()
      if (!haystack.includes(text)) return false
    }
    return true
  })
}
