/** Settings > Agents (spec 2026-10-12 section 4). Keys appear only in create and rotate responses. */
import { crmFetch } from '@/lib/api-crm'

export interface Agent {
  id: number
  username: string
  display_name: string
  is_active: boolean
  lab_tools: boolean
  coa_publishing: boolean
  key_hint: string
  created_at: string
  created_by_name: string | null
  rotated_at: string | null
  last_used_at: string | null
  group_ids: number[]
}

export interface AgentWithKey {
  agent: Agent
  key: string
}

export interface AgentCreate {
  username: string
  display_name: string
  lab_tools: boolean
  coa_publishing: boolean
}

export type AgentPatch = Partial<
  Pick<Agent, 'display_name' | 'is_active' | 'lab_tools' | 'coa_publishing'>
>

const none = () => new URLSearchParams()
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const listAgents = () => crmFetch<Agent[]>('/admin/agents', none())
export const createAgent = (body: AgentCreate) =>
  crmFetch<AgentWithKey>('/admin/agents', none(), send('POST', body))
export const updateAgent = (id: number, patch: AgentPatch) =>
  crmFetch<Agent>(`/admin/agents/${id}`, none(), send('PATCH', patch))
export const rotateAgentKey = (id: number) =>
  crmFetch<AgentWithKey>(`/admin/agents/${id}/rotate-key`, none(), send('POST'))
export const setAgentGroups = (id: number, groupIds: number[]) =>
  crmFetch<Agent>(
    `/admin/agents/${id}/groups`,
    none(),
    send('PUT', { group_ids: groupIds })
  )
