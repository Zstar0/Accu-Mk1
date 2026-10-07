/** Planning boards API client (spec 2026-09-26 §7.2, §7.3). Sibling of api-groups.ts. */
import { apiFetch } from '@/lib/api'

export type NodeKind =
  | 'frame'
  | 'text'
  | 'note'
  | 'link'
  | 'entity'
  | 'person'
  | 'widget'
export type EdgeKind = 'related' | 'reports_to' | 'depends_on' | 'next'
export type BoardKind = 'map' | 'org' | 'training' | 'custom'
export type BoardVisibility = 'company' | 'restricted'

export interface Board {
  id: number
  slug: string
  name: string
  kind: BoardKind
  visibility: BoardVisibility
  created_by: number | null
  default_viewport: { x: number; y: number; zoom: number } | null
  node_count: number
  can_edit: boolean
  created_at: string
  updated_at: string
}

export interface EntityContextLite {
  entity_type: string
  entity_id: string
  label: string
  deep_link?: { kind: string; id: string }
  board_slug?: string | null
  node_kind?: string | null
}

export interface BoardNode {
  id: number
  board_id: number
  kind: NodeKind
  label: string
  parent_id: number | null
  x: number
  y: number
  w: number | null
  h: number | null
  z: number
  entity_type: string | null
  entity_id: string | null
  data: Record<string, unknown> | null
  version: number
  created_by: number | null
  updated_by: number | null
  created_at: string
  updated_at: string
  context?: EntityContextLite | null
}

export interface BoardEdge {
  id: number
  board_id: number
  source_id: number
  target_id: number
  kind: EdgeKind
  label: string | null
}

export interface Grant {
  group_id: number
  group_slug: string
  group_name: string
  can_edit: boolean
}

export interface BoardDetail extends Board {
  nodes: BoardNode[]
  edges: BoardEdge[]
  grants: Grant[]
}

export interface BoardCreate {
  slug: string
  name: string
  kind?: BoardKind
  visibility?: BoardVisibility
}

export interface BoardPatch {
  name?: string
  kind?: BoardKind
  visibility?: BoardVisibility
  default_viewport?: { x: number; y: number; zoom: number } | null
}

export interface NodeCreate {
  kind: NodeKind
  label?: string
  parent_id?: number | null
  x?: number
  y?: number
  w?: number | null
  h?: number | null
  z?: number
  entity_type?: string
  entity_id?: string
  data?: Record<string, unknown>
}

export interface NodePatch {
  version: number
  label?: string
  parent_id?: number | null
  x?: number
  y?: number
  w?: number | null
  h?: number | null
  z?: number
  data?: Record<string, unknown>
}

export interface PositionItem {
  id: number
  x: number
  y: number
  parent_id?: number | null
  version: number
}

export interface EdgeCreate {
  source_id: number
  target_id: number
  kind?: EdgeKind
  label?: string | null
}

export interface EdgePatch {
  kind?: EdgeKind
  label?: string | null
}

export interface EntityBoardRef {
  board_id: number
  board_slug: string
  board_name: string
  node_id: number
  node_label: string
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
})

export function listBoards(): Promise<Board[]> {
  return apiFetch<Board[]>('/api/boards')
}
export function getBoard(slug: string): Promise<BoardDetail> {
  return apiFetch<BoardDetail>(`/api/boards/${encodeURIComponent(slug)}`)
}
export function createBoard(data: BoardCreate): Promise<Board> {
  return apiFetch<Board>('/api/boards', json('POST', data))
}
export function patchBoard(slug: string, data: BoardPatch): Promise<Board> {
  return apiFetch<Board>(
    `/api/boards/${encodeURIComponent(slug)}`,
    json('PATCH', data)
  )
}
export function deleteBoard(slug: string): Promise<void> {
  return apiFetch<undefined>(`/api/boards/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  })
}
export function replaceGrants(
  slug: string,
  grants: { group_id: number; can_edit: boolean }[]
): Promise<Grant[]> {
  return apiFetch<Grant[]>(
    `/api/boards/${encodeURIComponent(slug)}/grants`,
    json('PUT', grants)
  )
}
export function boardsForEntity(
  entityType: string,
  entityId: string
): Promise<EntityBoardRef[]> {
  const q = new URLSearchParams({
    entity_type: entityType,
    entity_id: entityId,
  })
  return apiFetch<EntityBoardRef[]>(`/api/boards/for-entity?${q.toString()}`)
}
export function createNode(slug: string, data: NodeCreate): Promise<BoardNode> {
  return apiFetch<BoardNode>(
    `/api/boards/${encodeURIComponent(slug)}/nodes`,
    json('POST', data)
  )
}
export function patchNode(
  slug: string,
  id: number,
  data: NodePatch
): Promise<BoardNode> {
  return apiFetch<BoardNode>(
    `/api/boards/${encodeURIComponent(slug)}/nodes/${id}`,
    json('PATCH', data)
  )
}
export function patchPositions(
  slug: string,
  items: PositionItem[]
): Promise<BoardNode[]> {
  return apiFetch<BoardNode[]>(
    `/api/boards/${encodeURIComponent(slug)}/nodes/positions`,
    json('PATCH', items)
  )
}
export function deleteNode(slug: string, id: number): Promise<void> {
  return apiFetch<undefined>(
    `/api/boards/${encodeURIComponent(slug)}/nodes/${id}`,
    { method: 'DELETE' }
  )
}
export function createEdge(slug: string, data: EdgeCreate): Promise<BoardEdge> {
  return apiFetch<BoardEdge>(
    `/api/boards/${encodeURIComponent(slug)}/edges`,
    json('POST', data)
  )
}
export function patchEdge(
  slug: string,
  id: number,
  data: EdgePatch
): Promise<BoardEdge> {
  return apiFetch<BoardEdge>(
    `/api/boards/${encodeURIComponent(slug)}/edges/${id}`,
    json('PATCH', data)
  )
}
export function deleteEdge(slug: string, id: number): Promise<void> {
  return apiFetch<undefined>(
    `/api/boards/${encodeURIComponent(slug)}/edges/${id}`,
    { method: 'DELETE' }
  )
}

/** apiFetch throws `Error("<METHOD> <path> failed: <status>")`; 409 is the optimistic-lock miss. */
export function isStale(err: unknown): boolean {
  return err instanceof Error && /failed: 409$/.test(err.message)
}
