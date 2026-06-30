/**
 * User-directory helpers for flag cards + threads.
 *
 * Reuses the existing `worksheet-users` query (shared cache key) to map the
 * numeric actor/author/assignee ids on flag payloads to display names, avatar
 * initials, and a stable avatar color. When a user isn't in the directory
 * (deleted account, legacy event) we fall back to "User N".
 */

import { useQuery } from '@tanstack/react-query'
import { getWorksheetUsers, type WorksheetUser } from '@/lib/api'
import { displayName, shortEmail } from '@/lib/user-display'

export type UserMap = Map<number, WorksheetUser>

/** Shared directory of lab users, keyed by id. */
export function useFlagUsers(): UserMap {
  const { data: users = [] } = useQuery({
    queryKey: ['worksheet-users'],
    queryFn: getWorksheetUsers,
    staleTime: 5 * 60 * 1000,
  })
  return new Map(users.map(u => [u.id, u]))
}

/** Display name for a user id, or "User N" when unknown. */
export function nameForUser(
  map: UserMap,
  id: number | null | undefined
): string {
  if (id == null) return 'Unassigned'
  const u = map.get(id)
  return u ? displayName(u) : `User ${id}`
}

/** Avatar initials — "YOU" for the current user, else up to two letters. */
export function initialsForUser(
  map: UserMap,
  id: number | null | undefined,
  currentUserId: number | null | undefined
): string {
  if (id == null) return '–'
  if (currentUserId != null && id === currentUserId) return 'YOU'
  const u = map.get(id)
  if (!u) return `U${id}`
  const first = (u.first_name ?? '').trim()
  const last = (u.last_name ?? '').trim()
  if (first || last) {
    return (
      `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase() ||
      shortEmail(u.email).slice(0, 2).toUpperCase()
    )
  }
  return shortEmail(u.email).slice(0, 2).toUpperCase()
}

// Avatar palette pulled from the mockup's varied chip colors.
const AVATAR_COLORS = [
  '#0ea5a5',
  '#8b5cf6',
  '#3b82f6',
  '#16a34a',
  '#e8730a',
  '#e5484d',
  '#0891b2',
  '#7c3aad',
]

/** Deterministic avatar color for a user id. */
export function avatarColor(id: number | null | undefined): string {
  if (id == null) return '#94a3b8'
  return AVATAR_COLORS[id % AVATAR_COLORS.length] ?? '#94a3b8'
}
