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
