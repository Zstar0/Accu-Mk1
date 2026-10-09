import { API_BASE_URL, getBearerHeaders } from '@/lib/api'

export type CrmItemType = 'email' | 'call' | 'sms' | 'meeting' | 'note'

export interface CrmLead {
  id: string
  name: string
  status: string | null
  owner: string | null
  url: string
  contacts: { name: string; emails: string[]; phones: string[] }[]
  opportunities: {
    status: string | null
    value: number
    value_period: string | null
    confidence: number | null
    expected_date: string | null
  }[]
}

export interface CrmItem {
  id: string
  type: CrmItemType
  at: string | null
  direction: 'inbound' | 'outbound' | null
  who: string
  title: string
  preview: string
  lead_id: string | null
  lead_name: string
  automated: boolean
  support_thread_url: string | null
}

export interface CustomerCrm {
  configured: boolean
  emails_tried: string[]
  leads: CrmLead[]
  items: CrmItem[]
  total: number
  page: number
  page_size: number
  counts: Record<CrmItemType | 'automated', number>
  fetched_at: string
  stale: boolean
  refresh_throttled: boolean
}

export interface CrmEmailMessage {
  id: string
  at: string | null
  direction: string | null
  sender: string
  to: string[]
  cc: string[]
  subject: string
  body: string
}

export interface CrmActivityDetail extends CrmItem {
  messages?: CrmEmailMessage[] | null
  duration?: number | null
  disposition?: string | null
  note?: string | null
  recording_url?: string | null
  phone?: string | null
  text?: string | null
  remote_phone?: string | null
  starts_at?: string | null
  ends_at?: string | null
  attendees?: string[] | null
}

export class CrmError extends Error {
  constructor(
    public status: number,
    public code: string | null
  ) {
    super(`crm ${status}${code ? ` ${code}` : ''}`)
  }
}

export async function crmFetch<T>(
  path: string,
  qs: URLSearchParams,
  init: RequestInit = {}
): Promise<T> {
  const suffix = qs.toString() ? `?${qs}` : ''
  const r = await fetch(`${API_BASE_URL()}${path}${suffix}`, {
    ...init,
    headers: { ...getBearerHeaders(), ...(init.headers ?? {}) },
  })
  if (!r.ok) {
    let code: string | null = null
    try {
      code = (await r.json())?.detail?.code ?? null
    } catch {
      code = null
    }
    throw new CrmError(r.status, code)
  }
  return r.json() as Promise<T>
}

export interface CrmQuery {
  types?: CrmItemType[]
  includeAutomated?: boolean
  page?: number
  refresh?: boolean
}

export function getCustomerCrm(
  key: string,
  q: CrmQuery = {}
): Promise<CustomerCrm> {
  const qs = new URLSearchParams()
  for (const t of q.types ?? []) qs.append('types', t)
  if (q.includeAutomated) qs.set('include_automated', 'true')
  if (q.page && q.page > 1) qs.set('page', String(q.page))
  if (q.refresh) qs.set('refresh', 'true')
  return crmFetch(`/crm/customers/${encodeURIComponent(key)}`, qs)
}

export function getCrmActivity(
  key: string,
  id: string,
  type: CrmItemType
): Promise<CrmActivityDetail> {
  return crmFetch(
    `/crm/customers/${encodeURIComponent(key)}/activities/${encodeURIComponent(id)}`,
    new URLSearchParams({ type })
  )
}
