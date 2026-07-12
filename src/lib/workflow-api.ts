/**
 * Workflow catalog REST client (phase-out slice 3, Task 9).
 *
 * Thin wrappers over `/api/workflow/*` (Task 2 backend — `backend/workflow/routes.py`).
 * Every route is `require_admin`-gated server-side; the FE additionally hides
 * mutating controls from non-admins (belt + suspenders, not the security
 * boundary). Catalog rows are DOCUMENTATION while SENAITE remains system of
 * record — nothing here reads or writes live sample/analysis state.
 */

import { apiFetch } from './api'
import { getApiBaseUrl } from '@/lib/config'
import { getAuthToken } from '@/store/auth-store'

export type WorkflowScope = 'sample' | 'analysis'
export type WorkflowCategory = 'active' | 'terminal' | 'exception'
export type RequirementKind =
  | 'all_analyses_in_state'
  | 'field_present'
  | 'role_at_least'
  | 'manual'

/** Mirrors backend requirement entry shape (`validate_requirements`,
 *  `backend/workflow/catalog.py`). Non-`manual` kinds require a non-empty
 *  `value` server-side (422 otherwise) — the FE should gate this client-side
 *  too, but always be ready to surface the 422 detail. */
export interface RequirementEntry {
  kind: RequirementKind
  value: string | null
  note: string | null
}

/** Mirrors `_state_out` / `graph_payload` state entries. */
export interface WorkflowState {
  id: number
  slug: string
  label: string
  description: string | null
  category: WorkflowCategory
  color: string | null
  sort_order: number
  is_builtin: boolean
  is_active: boolean
  usage_count: number
}

/** Mirrors `_transition_out` / `graph_payload` transition entries. No slug,
 *  category, or usage_count — those are state-only fields; don't try to
 *  render them for a transition row. */
export interface WorkflowTransition {
  id: number
  from_state_id: number
  to_state_id: number
  verb: string
  label: string | null
  description: string | null
  requirements: RequirementEntry[]
  is_builtin: boolean
  is_active: boolean
}

/** Mirrors `GET /api/workflow/graph?scope=` response. */
export interface WorkflowGraph {
  scope: WorkflowScope
  states: WorkflowState[]
  transitions: WorkflowTransition[]
}

/** Mirrors backend `StateCreate`. */
export interface WorkflowStateCreate {
  entity_scope: WorkflowScope
  slug: string
  label: string
  description?: string | null
  category?: WorkflowCategory
  color?: string | null
  sort_order?: number
  is_active?: boolean
}

/** Mirrors backend `StateUpdate` — slug/entity_scope are immutable by
 *  omission (the backend ignores unknown keys, but these aren't in the type
 *  at all so a caller can't even try). */
export interface WorkflowStateUpdate {
  label?: string
  description?: string | null
  category?: WorkflowCategory
  color?: string | null
  sort_order?: number
  is_active?: boolean
}

/** Mirrors backend `TransitionCreate`. `entity_scope` is derived server-side
 *  from the `from`/`to` states — never client-supplied. */
export interface WorkflowTransitionCreate {
  from_state_id: number
  to_state_id: number
  verb: string
  label?: string | null
  description?: string | null
  requirements?: RequirementEntry[]
  sort_order?: number
  is_active?: boolean
}

/** Mirrors backend `TransitionUpdate` — `entity_scope` is immutable. */
export interface WorkflowTransitionUpdate {
  from_state_id?: number
  to_state_id?: number
  verb?: string
  label?: string | null
  description?: string | null
  requirements?: RequirementEntry[]
  sort_order?: number
  is_active?: boolean
}

function bearerHeaders(contentType?: string): Record<string, string> {
  const token = getAuthToken()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (contentType) headers['Content-Type'] = contentType
  return headers
}

/**
 * Raw-fetch mutation helper. Unlike `apiFetch` (which throws a generic
 * "<method> <path> failed: <status>" Error), this reads the backend's
 * `detail` string off a non-2xx JSON body — the workflow routes return
 * meaningful 409 ("built-in state cannot be deleted", "N live row(s) —
 * deactivate instead") and 422 (missing requirement value, cross-scope edge)
 * detail text that the pane surfaces verbatim in a sonner toast. Mirrors
 * `addAnalysisToSample` in `src/lib/api.ts`.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasBody = init.body !== undefined && init.body !== null
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...bearerHeaders(hasBody ? 'application/json' : undefined),
      ...(init.headers ?? {}),
    },
  })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(
      (err && typeof err.detail === 'string' && err.detail) ||
        `${init.method ?? 'GET'} ${path} failed: ${response.status}`
    )
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

/** `GET /api/workflow/graph?scope=` — states + transitions + live usage
 *  counts for one scope. The settings-pane load payload. */
export const getWorkflowGraph = (scope: WorkflowScope) =>
  apiFetch<WorkflowGraph>(`/api/workflow/graph?scope=${scope}`)

/** `POST /api/workflow/states` (admin). 409 on a duplicate slug within the
 *  scope. */
export const createWorkflowState = (body: WorkflowStateCreate) =>
  request<WorkflowState>('/api/workflow/states', {
    method: 'POST',
    body: JSON.stringify(body),
  })

/** `PATCH /api/workflow/states/{id}` (admin). slug/entity_scope immutable. */
export const updateWorkflowState = (id: number, body: WorkflowStateUpdate) =>
  request<WorkflowState>(`/api/workflow/states/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })

/** `DELETE /api/workflow/states/{id}` (admin, 204). 409 when the state is
 *  built-in, has live rows, or is still referenced by a transition — the
 *  thrown Error carries the backend's `detail` text verbatim. */
export const deleteWorkflowState = (id: number) =>
  request<undefined>(`/api/workflow/states/${id}`, { method: 'DELETE' })

/** `POST /api/workflow/transitions` (admin). 422 on a cross-scope edge, a
 *  missing from/to state, or an invalid requirement entry; 409 on a
 *  duplicate verb from the same state. */
export const createWorkflowTransition = (body: WorkflowTransitionCreate) =>
  request<WorkflowTransition>('/api/workflow/transitions', {
    method: 'POST',
    body: JSON.stringify(body),
  })

/** `PATCH /api/workflow/transitions/{id}` (admin). entity_scope immutable —
 *  from/to may move within the transition's existing scope only. */
export const updateWorkflowTransition = (
  id: number,
  body: WorkflowTransitionUpdate
) =>
  request<WorkflowTransition>(`/api/workflow/transitions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })

/** `DELETE /api/workflow/transitions/{id}` (admin, 204). 409 when built-in. */
export const deleteWorkflowTransition = (id: number) =>
  request<undefined>(`/api/workflow/transitions/${id}`, { method: 'DELETE' })
