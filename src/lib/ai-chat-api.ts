/**
 * AI chat REST client and wire types.
 *
 * Every response type below mirrors a response model in `backend/ai_chat/routes.py`
 * (chats, messages, providers) or `backend/ai_chat/providers.py` (admin), key for
 * key. Paths carry no `/api`: the backend routers have none (nginx strips one).
 *
 * Errors are `CrmError(status, code)`. `code` is null when the body has no
 * `detail.code`, FastAPI's own 422 included, so callers must not assume one.
 */

import { CrmError, crmFetch } from '@/lib/api-crm'

// ---- chat routes (routes.py) ---------------------------------------------

/** `ProviderItem`: what any user may see of a provider. */
export interface AiProvider {
  id: number
  slug: string
  display_name: string
}

/** `PendingOut`: an approval card the browser was already told about. */
export interface PendingApproval {
  permission_id: string
  source: string
  title: string
  detail: string
  can_allow: boolean
}

/** `ChatOut`. */
export interface AiChat {
  id: number
  provider_id: number
  title: string
  archived: boolean
  created_at: string
  updated_at: string
  running_turn_id: string | null
  pending_approvals: PendingApproval[]
}

/** `MessageOut`. `role` is `user`, `assistant` or `permission`. */
export interface AiMessage {
  id: number
  seq: number
  role: string
  text: string
  meta: Record<string, unknown> | null
  created_at: string
}

/** What `context.clean_context` accepts: a bad section drops the whole thing. */
export interface PageContext {
  section: string
  subsection: string
  target_kind?:
    | 'sample'
    | 'order'
    | 'customer'
    | 'document'
    | 'worksheet'
    | null
  target_id?: string | null
}

// ---- the event stream ----------------------------------------------------

interface EventBase {
  /** Per user, strictly increasing; also the SSE `id:`. */
  seq: number
  /** Null only for `resync`. */
  chat_id: number | null
  turn_id: string | null
}

export type PermissionDecision = 'allow' | 'deny' | 'cancelled' | 'expired'

export type AiChatErrorCode =
  | 'agent_unreachable'
  | 'agent_exited'
  | 'tools_check_failed'
  | 'agent_error'

/** One SSE `data` payload, discriminated on `type`. */
export type AiChatEvent =
  | (EventBase & {
      type: 'turn_started'
      /** A new agent process is spawning. */
      starting: boolean
      /** A stored session id is being attached. */
      resuming: boolean
    })
  | (EventBase & { type: 'message_chunk'; text: string })
  | (EventBase & { type: 'thought_chunk'; text: string })
  | (EventBase & {
      type: 'tool_call'
      id: string
      title: string
      kind: string | null
      status: string | null
    })
  | (EventBase & {
      type: 'tool_call_update'
      id: string
      status: string | null
      /** Null when unchanged. */
      title: string | null
    })
  | (EventBase &
      PendingApproval & {
        type: 'permission_requested'
        /** Provider display name. */
        agent: string
      })
  | (EventBase & {
      type: 'permission_resolved'
      permission_id: string
      decision: PermissionDecision
    })
  | (EventBase & {
      type: 'turn_ended'
      /** The ACP stop reason, or `error`. */
      stop_reason: string
      message_seq: number | null
    })
  | (EventBase & { type: 'error'; code: AiChatErrorCode; message: string })
  | (EventBase & { type: 'resync' })

// ---- admin routes (providers.py) -----------------------------------------

/** `ProviderOut`. No field carries the private key. */
export interface AcpProvider {
  id: number
  slug: string
  display_name: string
  enabled: boolean
  ssh_host: string
  ssh_port: number
  ssh_user: string
  host_key: string | null
  host_key_fingerprint: string | null
  public_key: string | null
  key_created_at: string | null
  authorized_keys_line: string | null
  launcher_path: string
  authorized_from: string
  session_cwd: string
  allowed_roles: string[]
  inject_mk1_tools: boolean
  max_sessions: number
  idle_minutes: number
  permission_timeout_s: number
  agent_approval_timeout_s: number
  last_test_at: string | null
  last_test_ok: boolean | null
  last_test_error: string | null
  last_agent_info: Record<string, unknown> | null
  last_capabilities: Record<string, unknown> | null
  live_sessions: number
  updated_at: string
}

/**
 * `ProviderIn`. Omit a field to leave it alone: the backend treats null as
 * absent, so nothing can be cleared through here. `slug` counts on create only.
 */
export interface AcpProviderInput {
  slug?: string
  display_name?: string
  enabled?: boolean
  ssh_host?: string
  ssh_port?: number
  ssh_user?: string
  host_key?: string
  launcher_path?: string
  authorized_from?: string
  session_cwd?: string
  allowed_roles?: string[]
  inject_mk1_tools?: boolean
  max_sessions?: number
  idle_minutes?: number
  permission_timeout_s?: number
  agent_approval_timeout_s?: number
}

/** `ProviderList`. `configured` is false while the keys secret is unset. */
export interface AcpProviderList {
  configured: boolean
  providers: AcpProvider[]
}

/** `TestResult`. Steps not reached are null in `timings_ms`. */
export interface AcpTestResult {
  ok: boolean
  error: string | null
  /** Only when `ok` is false. */
  stderr_tail: string[] | null
  timings_ms: Record<string, number | null>
  agent_info: Record<string, unknown> | null
  capabilities: Record<string, unknown> | null
  tools: string[]
}

// ---- calls ---------------------------------------------------------------

const noQuery = () => new URLSearchParams()

/** Request options; the JSON body and its header only when there is a body. */
const json = (method: string, body?: unknown): RequestInit =>
  body === undefined
    ? { method }
    : {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }

export function listProviders(): Promise<AiProvider[]> {
  return crmFetch('/ai-chat/providers', noQuery())
}

export function listChats(): Promise<AiChat[]> {
  return crmFetch('/ai-chat/chats', noQuery())
}

export function createChat(providerId: number): Promise<AiChat> {
  return crmFetch(
    '/ai-chat/chats',
    noQuery(),
    json('POST', { provider_id: providerId })
  )
}

export function getMessages(
  chatId: number,
  afterSeq?: number
): Promise<AiMessage[]> {
  const qs = noQuery()
  if (afterSeq !== undefined) qs.set('after_seq', String(afterSeq))
  return crmFetch(`/ai-chat/chats/${chatId}/messages`, qs)
}

export function patchChat(
  chatId: number,
  patch: { title?: string; archived?: boolean }
): Promise<AiChat> {
  return crmFetch(`/ai-chat/chats/${chatId}`, noQuery(), json('PATCH', patch))
}

/** 202; the reply streams over the event stream. */
export function sendPrompt(
  chatId: number,
  text: string,
  pageContext: PageContext | null
): Promise<{ turn_id: string }> {
  return crmFetch(
    `/ai-chat/chats/${chatId}/prompt`,
    noQuery(),
    json('POST', { text, page_context: pageContext })
  )
}

export function cancelTurn(chatId: number): Promise<{ cancelled: boolean }> {
  return crmFetch(`/ai-chat/chats/${chatId}/cancel`, noQuery(), json('POST'))
}

/**
 * The response echoes what was asked for, not how the card ends: a Stop that
 * lands first still settles it as `cancelled`. Show the outcome from
 * `permission_resolved`, never from this.
 */
export function decidePermission(
  chatId: number,
  permissionId: string,
  decision: 'allow' | 'deny'
): Promise<{ decision: string }> {
  return crmFetch(
    `/ai-chat/chats/${chatId}/permissions/${encodeURIComponent(permissionId)}`,
    noQuery(),
    json('POST', { decision })
  )
}

export function listAcpProviders(): Promise<AcpProviderList> {
  return crmFetch('/admin/acp-providers', noQuery())
}

export function createAcpProvider(
  input: AcpProviderInput
): Promise<AcpProvider> {
  return crmFetch('/admin/acp-providers', noQuery(), json('POST', input))
}

export function updateAcpProvider(
  id: number,
  input: AcpProviderInput
): Promise<AcpProvider> {
  return crmFetch(`/admin/acp-providers/${id}`, noQuery(), json('PUT', input))
}

/** The route answers 204 with no body, and `crmFetch` always parses one. */
export async function deleteAcpProvider(id: number): Promise<void> {
  try {
    await crmFetch<unknown>(
      `/admin/acp-providers/${id}`,
      noQuery(),
      json('DELETE')
    )
  } catch (e) {
    // `crmFetch` throws `CrmError` for any non-2xx and `TypeError` for a
    // network failure, so a `SyntaxError` here is the empty body of a success.
    if (e instanceof CrmError || !(e instanceof SyntaxError)) throw e
  }
}

/** A new key replaces any old one; the response never carries the private half. */
export function generateAcpKey(id: number): Promise<AcpProvider> {
  return crmFetch(`/admin/acp-providers/${id}/key`, noQuery(), json('POST'))
}

/** Can take up to 90 s (the backend's test timeout). */
export function testAcpProvider(id: number): Promise<AcpTestResult> {
  return crmFetch(`/admin/acp-providers/${id}/test`, noQuery(), json('POST'))
}
