import { API_BASE_URL, getBearerHeaders, extractErrorMessage } from '@/lib/api'

export type PriorityIcon =
  | 'chevrons-up'
  | 'chevron-up'
  | 'minus'
  | 'chevron-down'
  | 'chevrons-down'
  | 'flame'
export type PriorityColor =
  | 'red'
  | 'amber'
  | 'emerald'
  | 'sky'
  | 'violet'
  | 'zinc'
export type PriorityLevel = 'customer' | 'order' | 'sample' | 'vial'
export type PrioritySource = PriorityLevel | 'default'

export interface Priority {
  key: string
  name: string
  rank: number
  icon: PriorityIcon
  color: PriorityColor
  pulse: boolean
  is_default: boolean
  is_active: boolean
  sla_tier_id: number | null
}
export interface EffectivePriority {
  key: string
  rank: number
  source_level: PrioritySource
  source_id: string | null
}
export interface AssignInput {
  level: PriorityLevel
  id: string
  priority_key: string | null
  note?: string
}
export interface AssignResult {
  level: PriorityLevel
  id: string
  old_key: string | null
  new_key: string | null
  affected_sample_pks: number[]
}
export interface CustomerPriority {
  wp_customer_user_id: number
  priority_key: string
  note: string | null
  updated_at: string | null
  customer_name: string | null
  customer_email: string | null
}
export interface CustomerSeen {
  wp_customer_user_id: number
  customer_name: string | null
  customer_email: string | null
  last_order_at: string | null
}

async function req<T>(
  path: string,
  init: RequestInit = {},
  fallback = 'Request failed'
): Promise<T> {
  const res = await fetch(`${API_BASE_URL()}${path}`, {
    ...init,
    headers: {
      ...(getBearerHeaders() as Record<string, string>),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...((init.headers ?? {}) as Record<string, string>),
    },
  })
  if (!res.ok)
    throw new Error(
      await extractErrorMessage(res, `${fallback}: ${res.status}`)
    )
  return res.json() as Promise<T>
}

export const getPriorities = () => req<Priority[]>('/priorities')
export const createPriority = (
  body: Pick<Priority, 'name' | 'rank' | 'icon' | 'color' | 'pulse'> & {
    sla_tier_id?: number | null
  }
) =>
  req<Priority>(
    '/priorities',
    { method: 'POST', body: JSON.stringify(body) },
    'Create priority failed'
  )
export const patchPriority = (
  key: string,
  body: Partial<
    Pick<
      Priority,
      'name' | 'rank' | 'icon' | 'color' | 'pulse' | 'is_active' | 'sla_tier_id'
    >
  >
) =>
  req<Priority>(
    `/priorities/${encodeURIComponent(key)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
    'Save priority failed'
  )
export const deactivatePriority = (key: string) =>
  req<{ key: string }>(`/priorities/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
export const setDefaultPriority = (key: string) =>
  req<Priority>(`/priorities/default/${encodeURIComponent(key)}`, {
    method: 'PUT',
  })
export const assignPriority = (body: AssignInput) =>
  req<AssignResult>(
    '/priorities/assign',
    { method: 'PUT', body: JSON.stringify(body) },
    'Set priority failed'
  )
export const assignPriorityBulk = (items: AssignInput[]) =>
  req<AssignResult[]>('/priorities/assign/bulk', {
    method: 'PUT',
    body: JSON.stringify({ items }),
  })
export const resolvePriorities = (body: {
  sample_pks?: number[]
  sub_sample_pks?: number[]
}) =>
  req<{
    samples: Record<string, EffectivePriority>
    sub_samples: Record<string, EffectivePriority>
  }>('/priorities/resolve', { method: 'POST', body: JSON.stringify(body) })
export const getCustomerPriorities = () =>
  req<CustomerPriority[]>('/priorities/customers')
export const getCustomersSeen = (q: string) =>
  req<CustomerSeen[]>(`/priorities/customers/seen?q=${encodeURIComponent(q)}`)
