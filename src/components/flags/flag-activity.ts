/**
 * Pure event → phrase mapping for the activity feed. Returns the action phrase
 * only (the row supplies the actor prefix — "You"/name — and the flag title).
 */
import type { ActivityItem } from '@/lib/flags-api'

export function activityVerb(
  item: ActivityItem,
  me: number | null,
  opts: {
    nameOf: (id: number | null) => string
    statusLabelOf: (slug: string) => string
  }
): string {
  const to = item.to_value
  switch (item.event_type) {
    case 'raised':
      return 'raised this flag'
    case 'assigned': {
      const toId = to != null ? Number(to) : null
      if (toId != null && me != null && toId === me)
        return 'assigned this to you'
      return `assigned this to ${opts.nameOf(toId)}`
    }
    case 'unassigned':
      return 'unassigned this'
    case 'commented':
      return 'commented'
    case 'status_changed':
      return `moved this to ${opts.statusLabelOf(to ?? '')}`
    case 'watcher_added':
      return 'started watching'
    case 'watcher_removed':
      return 'stopped watching'
    default:
      return 'updated this'
  }
}

/** Personalization filter for the Activity tab. `'mine'` = assigned ∪ raised;
 *  `'forme'` = the "notifications I received" lens (see {@link filterActivity}). */
export type ActivityChip =
  | 'all'
  | 'forme'
  | 'actor'
  | 'mine'
  | 'watching'
  | 'mentioned'

/** Relevance markers that mean "this event touches a flag I'm tied to". */
const INVOLVES_ME = ['assigned', 'raised', 'watching', 'mentioned'] as const

/** Pure client-side narrow of the already-fetched feed by relevance marker. */
export function filterActivity(
  items: ActivityItem[],
  chip: ActivityChip
): ActivityItem[] {
  if (chip === 'all') return items
  if (chip === 'mine')
    return items.filter(
      i => i.relevance.includes('assigned') || i.relevance.includes('raised')
    )
  // "For me" = notifications I received: something someone ELSE did (no 'actor',
  // which encodes actor===me — same self-suppression as the Slack DM path) on a
  // flag I'm tied to. The feed is already newest-first, so it reads chronologically.
  if (chip === 'forme')
    return items.filter(
      i =>
        !i.relevance.includes('actor') &&
        INVOLVES_ME.some(m => i.relevance.includes(m))
    )
  return items.filter(i => i.relevance.includes(chip))
}
