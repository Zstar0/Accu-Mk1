/**
 * Flag System REST client.
 *
 * Thin `apiFetch`-based wrappers over the Plan-1 backend endpoints
 * (`/api/flags*`). TS shapes mirror `backend/flags/schemas.py` exactly — keep
 * them in sync if the Pydantic models change.
 */

import { apiFetch } from './api'

// --- string unions (mirror schemas.py FlagType/FlagStatus/FlagTab) ---

export type FlagType =
  | 'blocker'
  | 'critical'
  | 'question'
  | 'waiting_on_customer'
  | 'ready_for_verification'

export type FlagStatus = 'open' | 'in_progress' | 'resolved' | 'closed'

export type FlagTab = 'assigned' | 'raised' | 'watching' | 'all_open'

// --- response shapes (mirror schemas.py) ---

/** Mirrors `CommentResponse`. */
export interface CommentResponse {
  id: number
  flag_id: number
  author_id: number
  body: string
  audience: string
  created_at: string
  edited_at: string | null
}

/** Mirrors `EventResponse` — one audit-trail entry. */
export interface EventResponse {
  id: number
  actor_id: number | null
  event_type: string
  from_value: string | null
  to_value: string | null
  details: Record<string, unknown> | null
  created_at: string
}

/** Mirrors `FlagResponse`. `type`/`status` are loose strings on the wire (the
 *  backend stores them as text); narrow to the unions at the UI boundary. */
export interface FlagResponse {
  id: number
  entity_type: string
  entity_id: string
  kind: string
  type: string
  status: string
  title: string
  created_by: number
  assignee_id: number | null
  created_at: string
  updated_at: string
  resolved_at: string | null
  resolved_by: number | null
}

/** Mirrors `FlagDetailResponse` (adds comments + events). */
export interface FlagDetailResponse extends FlagResponse {
  comments: CommentResponse[]
  events: EventResponse[]
}

/** Mirrors `SummaryResponse`. `by_type` maps a flag type → open count. */
export interface SummaryResponse {
  assigned_to_me: number
  by_type: Record<string, number>
}

// --- request bodies (mirror schemas.py request models) ---

/** Mirrors `CreateFlagRequest`. */
export interface CreateFlagBody {
  entity_type: string
  entity_id: string
  type: FlagType
  title: string
  assignee_id?: number | null
  first_comment?: string | null
}

/** Optional server-side narrowing filters for the list endpoint. The primary
 *  axis is `tab`; these scope further (e.g. one entity's flags). */
export interface ListFlagsParams {
  status?: FlagStatus
  entity_type?: string
  entity_id?: string
}

// --- endpoint functions ---

/** `GET /api/flags?tab=…` — the triage list for one tab. */
export const listFlags = (tab: FlagTab, params?: ListFlagsParams) => {
  const qs = new URLSearchParams({ tab })
  if (params?.status) qs.set('status', params.status)
  if (params?.entity_type) qs.set('entity_type', params.entity_type)
  if (params?.entity_id) qs.set('entity_id', params.entity_id)
  return apiFetch<FlagResponse[]>(`/api/flags?${qs.toString()}`)
}

/** `POST /api/flags` — raise a new flag. */
export const createFlag = (body: CreateFlagBody) =>
  apiFetch<FlagResponse>('/api/flags', {
    method: 'POST',
    body: JSON.stringify(body),
  })

/** `GET /api/flags/summary` — counts for the header button badge. */
export const getSummary = () => apiFetch<SummaryResponse>('/api/flags/summary')

/** `GET /api/flags/{id}` — one flag with its comments + events. */
export const getFlag = (id: number) =>
  apiFetch<FlagDetailResponse>(`/api/flags/${id}`)

/** `POST /api/flags/{id}/comments` — append a comment. */
export const addComment = (id: number, body: string) =>
  apiFetch<CommentResponse>(`/api/flags/${id}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })

/** `POST /api/flags/{id}/assign` — assign (or unassign with `null`). */
export const assignFlag = (id: number, assignee_id: number | null) =>
  apiFetch<FlagResponse>(`/api/flags/${id}/assign`, {
    method: 'POST',
    body: JSON.stringify({ assignee_id }),
  })

/** `POST /api/flags/{id}/status` — move the flag through its lifecycle. */
export const changeStatus = (id: number, to_status: FlagStatus) =>
  apiFetch<FlagResponse>(`/api/flags/${id}/status`, {
    method: 'POST',
    body: JSON.stringify({ to_status }),
  })

/** `POST /api/flags/{id}/watchers` — start watching a flag. */
export const addWatcher = (id: number, user_id: number) =>
  apiFetch<{ ok: boolean }>(`/api/flags/${id}/watchers`, {
    method: 'POST',
    body: JSON.stringify({ user_id }),
  })

/** `DELETE /api/flags/{id}/watchers/{user_id}` — stop watching (204). */
export const removeWatcher = (id: number, user_id: number) =>
  apiFetch<undefined>(`/api/flags/${id}/watchers/${user_id}`, {
    method: 'DELETE',
  })
