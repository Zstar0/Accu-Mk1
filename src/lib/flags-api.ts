/**
 * Flag System REST client.
 *
 * Thin `apiFetch`-based wrappers over the Plan-1 backend endpoints
 * (`/api/flags*`). TS shapes mirror `backend/flags/schemas.py` exactly — keep
 * them in sync if the Pydantic models change.
 */

import { apiFetch } from './api'
import { getApiBaseUrl } from '@/lib/config'
import { getAuthToken } from '@/store/auth-store'

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

/** Mirrors backend `ReactionAggregate`. */
export interface ReactionAggregate {
  emoji: string
  count: number
  user_ids: number[]
}

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
  /** Optional — backend always sends `[]`; older cached payloads may omit it. */
  reactions?: ReactionAggregate[]
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
  /** Nullable since Phase 2: a null anchor = a general task. */
  entity_type: string | null
  entity_id: string | null
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
  /** Optional deadline (Phase 2 slice 2); null when unset. */
  due_at: string | null
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

/** Mirrors backend `EntityLinkOut` — a navigational related-item reference. */
export interface EntityLink {
  id: number
  entity_type: string
  entity_id: string
  entity: EntityContext | null
}

/** Mirrors backend `FlagLinkOut` — a related flag, pre-resolved for the viewer
 *  (`flag_id` is THE OTHER flag). */
export interface FlagLink {
  id: number
  flag_id: number
  title: string
  status: string
  type: string
}

/** Mirrors `FlagDetailResponse` (adds comments + events + watchers + links). */
export interface FlagDetailResponse extends FlagResponse {
  comments: CommentResponse[]
  events: EventResponse[]
  watchers: Watcher[]
  entity_links: EntityLink[]
  flag_links: FlagLink[]
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

/** Mirrors `FlagSearchHit` (spec §7). `snippet` is a cleaned comment excerpt
 *  (empty on a title-only hit); `matched_in` ⊆ `['comment','title']`. */
export interface FlagSearchHit {
  flag_id: number
  snippet: string
  matched_in: string[]
}

// --- request bodies (mirror schemas.py request models) ---

/** Mirrors `CreateFlagRequest`. `type` is a DB-managed type slug (Plan 5).
 *  A null anchor (`entity_type`/`entity_id`) raises a general task (Phase 2). */
export interface CreateFlagBody {
  entity_type: string | null
  entity_id: string | null
  type: string
  title: string
  assignee_id?: number | null
  first_comment?: string | null
  due_at?: string | null
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

/** `GET /api/flags/search?q=` — flags whose title or a comment body matches `q`
 *  (comment matches carry a snippet). Caller gates at ≥3 chars + debounce. */
export const searchFlags = (q: string, limit = 50) => {
  const qs = new URLSearchParams({ q, limit: String(limit) })
  return apiFetch<FlagSearchHit[]>(`/api/flags/search?${qs.toString()}`)
}

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

/** `PUT /api/flags/{id}/due` — set, change, or clear (null) the due date. */
export const setDue = (id: number, due_at: string | null) =>
  apiFetch<FlagResponse>(`/api/flags/${id}/due`, {
    method: 'PUT',
    body: JSON.stringify({ due_at }),
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

// --- links (Phase 2 slice 2) ---------------------------------------------

/** `POST /api/flags/{id}/links/entities` — attach a related entity. */
export const addEntityLink = (
  id: number,
  entity_type: string,
  entity_id: string
) =>
  apiFetch<{ id: number }>(`/api/flags/${id}/links/entities`, {
    method: 'POST',
    body: JSON.stringify({ entity_type, entity_id }),
  })

/** `DELETE /api/flags/{id}/links/entities/{link_id}` — detach (204). */
export const removeEntityLink = (id: number, linkId: number) =>
  apiFetch<undefined>(`/api/flags/${id}/links/entities/${linkId}`, {
    method: 'DELETE',
  })

/** `POST /api/flags/{id}/links/flags` — link another flag as related. */
export const addFlagLink = (id: number, otherId: number) =>
  apiFetch<{ id: number }>(`/api/flags/${id}/links/flags`, {
    method: 'POST',
    body: JSON.stringify({ flag_id: otherId }),
  })

/** `DELETE /api/flags/{id}/links/flags/{link_id}` — unlink (204). */
export const removeFlagLink = (id: number, linkId: number) =>
  apiFetch<undefined>(`/api/flags/${id}/links/flags/${linkId}`, {
    method: 'DELETE',
  })

// --- attachments (Phase 2 slice 3) ---------------------------------------

/** Mirrors backend `AttachmentResponse`. */
export interface FlagAttachment {
  id: number
  flag_id: number
  comment_id: number | null
  filename: string
  content_type: string
  size_bytes: number
  created_at: string
}

function bearerHeaders(): Record<string, string> {
  const token = getAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** Upload an image to a flag (multipart). The browser sets the multipart
 *  boundary — do NOT set Content-Type. */
export async function addFlagAttachment(
  flagId: number,
  file: File
): Promise<FlagAttachment> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(
    `${getApiBaseUrl()}/api/flags/${flagId}/attachments`,
    {
      method: 'POST',
      headers: bearerHeaders(),
      body: form,
    }
  )
  if (!res.ok) throw new Error(`attachment upload failed: ${res.status}`)
  return res.json() as Promise<FlagAttachment>
}

const _flagAttachmentCache = new Map<number, string>()

/** Resolve an attachment's bytes to a renderable blob object URL. The serve
 *  endpoint requires Bearer auth, so a plain <img src> would 401; we fetch as a
 *  blob and wrap it. Mirrors fetchPackagingPhotoUrl. Cached per id. */
export async function fetchFlagAttachmentUrl(
  attachmentId: number
): Promise<string | null> {
  const cached = _flagAttachmentCache.get(attachmentId)
  if (cached) return cached
  const res = await fetch(
    `${getApiBaseUrl()}/api/flags/attachments/${attachmentId}`,
    { headers: bearerHeaders() }
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`fetchFlagAttachmentUrl failed: ${res.status}`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  _flagAttachmentCache.set(attachmentId, url)
  return url
}

export function invalidateFlagAttachment(attachmentId: number): void {
  const prev = _flagAttachmentCache.get(attachmentId)
  if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
  _flagAttachmentCache.delete(attachmentId)
}

// --- reactions (Phase 2 slice 3) -----------------------------------------

/** Curated reaction set (spec §6). BYTE-IDENTICAL to backend CURATED_EMOJI —
 *  VS16-carrying glyphs included, or the server 400s a reaction the UI sent. */
export const FLAG_REACTION_EMOJI = [
  '👍',
  '✅',
  '👀',
  '🎉',
  '❤️',
  '😂',
  '🤔',
  '🚨',
] as const
export type FlagReactionEmoji = (typeof FLAG_REACTION_EMOJI)[number]

/** `PUT /api/flags/comments/{id}/reactions/{emoji}` — idempotent add. */
export const addReaction = (commentId: number, emoji: string) =>
  apiFetch<ReactionAggregate[]>(
    `/api/flags/comments/${commentId}/reactions/${encodeURIComponent(emoji)}`,
    { method: 'PUT' }
  )

/** `DELETE /api/flags/comments/{id}/reactions/{emoji}` — remove own. */
export const removeReaction = (commentId: number, emoji: string) =>
  apiFetch<ReactionAggregate[]>(
    `/api/flags/comments/${commentId}/reactions/${encodeURIComponent(emoji)}`,
    { method: 'DELETE' }
  )

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

// --- recurring tasks (Slice 5, admin-only) ------------------------------

/** Mirrors backend FlagRecurringResponse. cadence: 'daily' | 'weekly:<0-6>' | 'monthly:<1-28>'. */
export interface FlagRecurring {
  id: number
  title: string
  body: string | null
  type: string
  assignee_id: number | null
  watchers: number[]
  entity_type: string | null
  entity_id: string | null
  cadence: string
  next_run_at: string
  active: boolean
  skip_if_open: boolean
  created_by: number
  created_at: string
  last_minted_flag_id: number | null
}
export type FlagRecurringCreate = Pick<
  FlagRecurring,
  'title' | 'type' | 'cadence'
> &
  Partial<
    Pick<
      FlagRecurring,
      | 'body'
      | 'assignee_id'
      | 'watchers'
      | 'entity_type'
      | 'entity_id'
      | 'skip_if_open'
    >
  >
export type FlagRecurringUpdate = Partial<
  Omit<
    FlagRecurring,
    'id' | 'created_by' | 'created_at' | 'last_minted_flag_id' | 'next_run_at'
  >
>

export const listRecurring = () =>
  apiFetch<FlagRecurring[]>('/api/flags/recurring')
export const createRecurring = (body: FlagRecurringCreate) =>
  apiFetch<FlagRecurring>('/api/flags/recurring', {
    method: 'POST',
    body: JSON.stringify(body),
  })
export const updateRecurring = (id: number, body: FlagRecurringUpdate) =>
  apiFetch<FlagRecurring>(`/api/flags/recurring/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
export const deleteRecurring = (id: number) =>
  apiFetch<undefined>(`/api/flags/recurring/${id}`, { method: 'DELETE' })
