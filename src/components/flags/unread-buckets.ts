import type { FlagResponse } from '@/lib/flags-api'

const CLOSED = new Set(['resolved', 'closed'])
const isOpen = (status: string) => !CLOSED.has(status)

/** Which flyout tabs contain ≥1 unread flag (all inputs are already relevant to
 *  `me`; a flag that's neither mine-assigned nor mine-created is participant-only
 *  → the Watching tab). */
export function unreadBuckets(
  unread: FlagResponse[],
  me: number | null
): { assigned: boolean; raised: boolean; watching: boolean; allOpen: boolean } {
  return {
    assigned: unread.some(fl => fl.assignee_id === me && isOpen(fl.status)),
    raised: unread.some(fl => fl.created_by === me),
    watching: unread.some(fl => fl.assignee_id !== me && fl.created_by !== me),
    allOpen: unread.some(fl => isOpen(fl.status)),
  }
}
