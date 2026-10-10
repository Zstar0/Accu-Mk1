import { crmFetch } from '@/lib/api-crm'

export interface IntegrationKeyStatus {
  name: string
  label: string
  source: 'settings' | 'env' | 'none'
  last4: string | null
  updated_by_name: string | null
  updated_at: string | null
  undecryptable: boolean
}

export interface IntegrationKeyList {
  configured: boolean
  keys: IntegrationKeyStatus[]
}

export interface IntegrationKeyTest {
  ok: boolean
  outcome: 'ok' | 'rejected' | 'unavailable' | 'not_set'
}

const path = (name: string) => `/admin/integrations/${encodeURIComponent(name)}`
const none = () => new URLSearchParams()

export function getIntegrationKeys(): Promise<IntegrationKeyList> {
  return crmFetch('/admin/integrations', none())
}

export function saveIntegrationKey(
  name: string,
  value: string
): Promise<IntegrationKeyStatus> {
  return crmFetch(path(name), none(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
}

export function testIntegrationKey(name: string): Promise<IntegrationKeyTest> {
  return crmFetch(`${path(name)}/test`, none(), { method: 'POST' })
}

export function clearIntegrationKey(
  name: string
): Promise<IntegrationKeyStatus> {
  return crmFetch(path(name), none(), { method: 'DELETE' })
}
