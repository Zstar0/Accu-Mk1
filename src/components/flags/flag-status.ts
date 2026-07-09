/**
 * Shared status presentation for flags — labels + dot colors, one source of
 * truth for the thread's status control and the flyout's status filter.
 *
 * The dot hexes are the validated dark-mode accents from the approved mockup
 * (amber `#f59e0b` for `blocked` — an active-but-stuck state, distinct from the
 * blue in-progress). Kept as semantic accents, matching flag-catalog's pills.
 */

import type { FlagStatus } from '@/lib/flags-api'

export const STATUS_LABELS: Record<FlagStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  resolved: 'Resolved',
  closed: 'Closed',
}

export const STATUS_DOT: Record<FlagStatus, string> = {
  open: '#e8730a',
  in_progress: '#3b82f6',
  // Amber — an active state that's stuck. Distinct from in-progress (blue).
  blocked: '#f59e0b',
  resolved: '#22c55e',
  closed: '#94a3b8',
}

/** Lifecycle order for pickers/filters. */
export const STATUS_ORDER: FlagStatus[] = [
  'open',
  'in_progress',
  'blocked',
  'resolved',
  'closed',
]

/** Statuses that count as "open" for the composite All-Open filter.
 *  Mirrors backend OPEN_STATES (catalog.py). */
export const OPEN_STATUSES: FlagStatus[] = ['open', 'in_progress', 'blocked']
