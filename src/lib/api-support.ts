import { crmFetch } from '@/lib/api-crm'

export type SupportStatus = 'open' | 'snoozed' | 'done'

export interface SupportThread {
  id: string
  ref: string
  title: string
  status: SupportStatus
  priority: 'urgent' | 'high' | 'normal' | 'low'
  labels: string[]
  assignee: string | null
  created_at: string | null
  updated_at: string | null
  preview: string
  waiting_since: string | null
  plain_url: string
  assignee_id?: string | null
  customer_plain_id?: string | null
  label_refs?: SupportLabelRef[]
}

export interface CustomerSupport {
  customer_key: string
  matched: number
  threads: SupportThread[]
  total: number
  page: number
  page_size: number
  counts: Record<SupportStatus | 'waiting', number>
  last_contact_at: string | null
  oldest_waiting_since: string | null
  fetched_at: string
  stale: boolean
  refresh_throttled: boolean
}

export interface SupportEntry {
  id: string
  at: string | null
  kind: 'email' | 'chat' | 'slack' | 'note' | 'discussion' | 'form' | 'event'
  author: string | null
  author_kind: 'customer' | 'agent' | 'system'
  internal: boolean
  subject: string | null
  text: string
}

export interface SupportThreadDetail {
  thread: SupportThread
  entries: SupportEntry[]
  fetched_at: string
  stale: boolean
}

export function getCustomerSupport(
  key: string,
  q: { statuses?: SupportStatus[]; page?: number; refresh?: boolean } = {}
): Promise<CustomerSupport> {
  const qs = new URLSearchParams()
  for (const s of q.statuses ?? []) qs.append('status', s)
  if (q.page && q.page > 1) qs.set('page', String(q.page))
  if (q.refresh) qs.set('refresh', 'true')
  return crmFetch(`/support/customers/${encodeURIComponent(key)}`, qs)
}

export function getSupportThread(
  key: string,
  id: string,
  q: { refresh?: boolean } = {}
): Promise<SupportThreadDetail> {
  const qs = new URLSearchParams()
  if (q.refresh) qs.set('refresh', 'true')
  return crmFetch(
    `/support/customers/${encodeURIComponent(key)}/threads/${encodeURIComponent(id)}`,
    qs
  )
}

export interface SupportLabelRef {
  id: string
  type_id: string
  name: string
}

export interface SupportMe {
  has_seat: boolean
  plain_user_id: string | null
  name: string | null
  email: string | null
  unavailable: boolean
}

export interface SupportWorkspace {
  teammates: { plain_user_id: string; name: string; email: string }[]
  label_types: { id: string; name: string; color: string | null }[]
}

export type SupportAction =
  | 'reply'
  | 'note'
  | 'status'
  | 'assign'
  | 'priority'
  | 'labels'

export function getSupportMe(): Promise<SupportMe> {
  return crmFetch('/support/me', new URLSearchParams())
}

export function getSupportWorkspace(): Promise<SupportWorkspace> {
  return crmFetch('/support/workspace', new URLSearchParams())
}

export function supportAction(
  key: string,
  threadId: string,
  action: SupportAction,
  body: Record<string, unknown>
): Promise<{ detail: SupportThreadDetail | null }> {
  return crmFetch(
    `/support/customers/${encodeURIComponent(key)}/threads/${encodeURIComponent(threadId)}/${action}`,
    new URLSearchParams(),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )
}
