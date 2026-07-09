/**
 * Flag System REST client.
 *
 * Thin `apiFetch`-based wrappers over the Plan-1 backend endpoints
 * (`/api/flags*`). TS shapes mirror `backend/flags/schemas.py` exactly — keep
 * them in sync if the Pydantic models change.
 */

import { apiFetch } from './api'

// --- string unions (mirror schemas.py FlagStatus/FlagTab) ---

/** The 5 built-in type slugs. Types are now DB-managed (Plan 5), so a flag's
 *  `type` is any slug string on the wire — this union only documents the
 *  built-ins and keys the static fallback catalog. */
export type FlagTypeSlug =
  | 'blocker'
  | 'critical'
  | 'question'
  | 'waiting_on_customer'
  | 'ready_for_verification'

export type FlagStatus =
  | 'open'
  | 'in_progress'
  | 'blocked'
  | 'resolved'
  | 'closed'

export type FlagTab = 'assigned' | 'raised' | 'watching' | 'all_open'

// --- response shapes (mirror schemas.py) ---

/** Mirrors `CommentResponse`. `mentions` = user ids called out in the body. */
export interface CommentResponse {
  id: number
  flag_id: number
  author_id: number
  body: string
  audience: string
  mentions: number[]
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

/** Mirrors `DeepLink` — how the frontend navigates to a flagged entity.
 *  `kind` ∈ `sample` | `worksheet` | `none`; `id` is the navigator argument. */
export interface DeepLink {
  kind: string
  id: string
}

/** Mirrors `EntityContext` (Plan 4) — server-resolved presentation context for
 *  a flagged entity. Produced by the Mk1 registry closures; null when the
 *  registry can't resolve it. `lot` is an additive hook (deferred — always
 *  null this round). */
export interface EntityContext {
  entity_type: string
  entity_id: string
  label: string
  sample_id: string | null
  analyses: string[]
  lot: string | null
  deep_link: DeepLink
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
  /** Server-resolved entity context; absent when unresolvable (Plan 4). */
  entity?: EntityContext | null
}

/** Mirrors backend `WatcherOut` — a watcher participant (ids only; names
 *  resolve client-side via the shared user directory). */
export interface Watcher {
  user_id: number
  added_at: string
  added_by: number | null
}

/** Mirrors `FlagDetailResponse` (adds comments + events + watchers). */
export interface FlagDetailResponse extends FlagResponse {
  comments: CommentResponse[]
  events: EventResponse[]
  watchers: Watcher[]
}

/** Mirrors `ActivityItem` — one audit event + its (entity-resolved) flag.
 *  `relevance` marks why this event is in the requesting user's feed:
 *  a subset of `actor | assigned | raised | watching | mentioned`. */
export interface ActivityItem {
  id: number
  event_type: string
  actor_id: number | null
  from_value: string | null
  to_value: string | null
  created_at: string
  flag: FlagResponse
  relevance: string[]
}

/** Mirrors `ActivityPage` — one keyset page of the activity feed. */
export interface ActivityPage {
  items: ActivityItem[]
  next_cursor: string | null
}

/** Mirrors `SummaryResponse`. `by_type` maps a flag type → open count. */
export interface SummaryResponse {
  assigned_to_me: number
  by_type: Record<string, number>
}

// --- request bodies (mirror schemas.py request models) ---

/** Mirrors `CreateFlagRequest`. `type` is a DB-managed type slug (Plan 5). */
export interface CreateFlagBody {
  entity_type: string
  entity_id: string
  type: string
  title: string
  assignee_id?: number | null
  first_comment?: string | null
}

/** Mirrors `FlagTypeResponse` — a row of the user-managed flag-type catalog
 *  (Plan 5). `entity_types` empty = global; otherwise the entity-type slugs this
 *  type may be raised on. */
export interface FlagType {
  id: number
  slug: string
  label: string
  color: string
  kind: 'issue' | 'signal'
  is_blocking: boolean
  is_active: boolean
  sort_order: number
  entity_types: string[]
  is_builtin: boolean
}

/** Mirrors `FlagTypeCreate`. */
export interface FlagTypeCreate {
  label: string
  color: string
  kind: 'issue' | 'signal'
  slug?: string
  is_blocking?: boolean
  is_active?: boolean
  sort_order?: number
  entity_types?: string[]
}

/** Mirrors `FlagTypeUpdate` (all-optional; no slug — it's immutable). */
export interface FlagTypeUpdate {
  label?: string
  color?: string
  kind?: 'issue' | 'signal'
  is_blocking?: boolean
  is_active?: boolean
  sort_order?: number
  entity_types?: string[]
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

/** `GET /api/flags?entity_type&entity_id[&include_descendants=true]` — the open
 *  flags on one entity (optionally rolling up its descendants, e.g. a sample's
 *  vials). Drives the stateful `EntityFlagButton`. */
export const listEntityFlags = (
  entityType: string,
  entityId: string,
  includeDescendants = false
) => {
  const qs = new URLSearchParams({
    tab: 'all_open',
    entity_type: entityType,
    entity_id: entityId,
  })
  if (includeDescendants) qs.set('include_descendants', 'true')
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

/** `GET /api/flags/activity` — one keyset page of the user's relevance feed
 *  (newest first). Omit `cursor` for the first page. */
export const getActivity = (cursor?: string, limit = 25) => {
  const qs = new URLSearchParams({ limit: String(limit) })
  if (cursor) qs.set('cursor', cursor)
  return apiFetch<ActivityPage>(`/api/flags/activity?${qs.toString()}`)
}

/** `GET /api/flags/unread` — flags relevant to me with unread changes. */
export const getUnread = () => apiFetch<FlagResponse[]>('/api/flags/unread')

/** `POST /api/flags/{id}/read` — stamp this flag read for me (204). */
export const markRead = (id: number) =>
  apiFetch<undefined>(`/api/flags/${id}/read`, { method: 'POST' })

/** `GET /api/flags/{id}` — one flag with its comments + events. */
export const getFlag = (id: number) =>
  apiFetch<FlagDetailResponse>(`/api/flags/${id}`)

/** `POST /api/flags/{id}/comments` — append a comment, optionally @mentioning
 *  users (who get notified + added as watchers). */
export const addComment = (
  id: number,
  body: string,
  mentionIds: number[] = []
) =>
  apiFetch<CommentResponse>(`/api/flags/${id}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body, mention_ids: mentionIds }),
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

// --- flag types (Plan 5) -------------------------------------------------

/** Error carrying the HTTP status so callers can branch on 409 (in-use/built-in
 *  → offer deactivate instead of hard-delete). */
export class FlagTypeApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'FlagTypeApiError'
    this.status = status
  }
}

/** `GET /api/flags/types` — the managed type catalog. `active_only` is for the
 *  raise picker; omit it (the default) for color/label resolution so deactivated
 *  but still-referenced types resolve. `entity_type` scopes to types raisable on
 *  that entity (global + scoped). */
export const getFlagTypes = (params?: {
  entity_type?: string
  active_only?: boolean
}) => {
  const qs = new URLSearchParams()
  if (params?.entity_type) qs.set('entity_type', params.entity_type)
  if (params?.active_only) qs.set('active_only', 'true')
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return apiFetch<FlagType[]>(`/api/flags/types${suffix}`)
}

/** `POST /api/flags/types` — create a type (admin). */
export const createFlagType = (body: FlagTypeCreate) =>
  apiFetch<FlagType>('/api/flags/types', {
    method: 'POST',
    body: JSON.stringify(body),
  })

/** `PUT /api/flags/types/{id}` — edit a type (admin). */
export const updateFlagType = (id: number, body: FlagTypeUpdate) =>
  apiFetch<FlagType>(`/api/flags/types/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })

/** `DELETE /api/flags/types/{id}` — hard-delete an unused custom type (admin).
 *  Throws {@link FlagTypeApiError} with `status === 409` when the type is
 *  built-in or in use (the caller should deactivate instead). */
export const deleteFlagType = async (id: number): Promise<void> => {
  try {
    await apiFetch<undefined>(`/api/flags/types/${id}`, { method: 'DELETE' })
  } catch (e) {
    const match = e instanceof Error ? e.message.match(/(\d{3})$/) : null
    throw new FlagTypeApiError(
      match ? Number(match[1]) : 0,
      e instanceof Error ? e.message : 'delete failed'
    )
  }
}

/** `GET /api/flags/entity-types` — the registered entity-type slugs (display
 *  names resolved client-side via flag-entity.ts ENTITY_META). */
export const getFlagEntityTypes = () =>
  apiFetch<string[]>('/api/flags/entity-types')
