/** User groups API client (spec 2026-09-26 §7.1). Sibling of api-documents.ts. */
import { apiFetch } from '@/lib/api'

export interface Group {
  id: number
  slug: string
  name: string
  description: string | null
  is_active: boolean
  member_count: number
  created_at: string
}

export interface GroupRef {
  id: number
  slug: string
  name: string
}

export interface GroupCreate {
  slug: string
  name: string
  description?: string | null
}

export interface GroupUpdate {
  name?: string
  description?: string | null
  is_active?: boolean
}

export function listGroups(includeInactive = false): Promise<Group[]> {
  return apiFetch<Group[]>(
    `/api/groups${includeInactive ? '?include_inactive=true' : ''}`
  )
}

export function listMyGroups(): Promise<GroupRef[]> {
  return apiFetch<GroupRef[]>('/api/groups/mine')
}

export function createGroup(data: GroupCreate): Promise<Group> {
  return apiFetch<Group>('/api/groups', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function updateGroup(id: number, data: GroupUpdate): Promise<Group> {
  return apiFetch<Group>(`/api/groups/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export function deleteGroup(id: number): Promise<void> {
  // apiFetch returns undefined on 204 (same idiom as deleteDocumentCategory).
  return apiFetch<undefined>(`/api/groups/${id}`, { method: 'DELETE' })
}

export async function getGroupMembers(id: number): Promise<number[]> {
  const out = await apiFetch<{ group_id: number; user_ids: number[] }>(
    `/api/groups/${id}/members`
  )
  return out.user_ids
}

export async function replaceGroupMembers(
  id: number,
  userIds: number[]
): Promise<number[]> {
  const out = await apiFetch<{ group_id: number; user_ids: number[] }>(
    `/api/groups/${id}/members`,
    {
      method: 'PUT',
      body: JSON.stringify({ user_ids: userIds }),
    }
  )
  return out.user_ids
}
