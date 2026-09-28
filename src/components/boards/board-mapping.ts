import type { Edge, Node, XYPosition } from '@xyflow/react'
import type {
  BoardEdge,
  BoardNode,
  NodePatch,
  PositionItem,
} from '@/lib/api-boards'

export const FRAME_DEFAULT = { width: 360, height: 220 }
export const NODE_DEFAULT = { width: 180, height: 56 }

export interface BoardNodeData extends Record<string, unknown> {
  row: BoardNode
  canEdit: boolean
  /** Board slug, so a frame can persist its own resize. */
  slug?: string
}
export type BoardFlowNode = Node<BoardNodeData>

export function toFlowNodes(
  rows: BoardNode[],
  canEdit: boolean,
  slug?: string
): BoardFlowNode[] {
  return [...rows]
    .sort(
      (a, b) =>
        (a.kind === 'frame' ? 0 : 1) - (b.kind === 'frame' ? 0 : 1) ||
        a.z - b.z ||
        a.id - b.id
    )
    .map(row => {
      const isFrame = row.kind === 'frame'
      const node: BoardFlowNode = {
        id: String(row.id),
        type: row.kind,
        position: { x: row.x, y: row.y },
        data: { row, canEdit, slug },
        draggable: canEdit,
        selectable: true,
        zIndex: isFrame ? 0 : 1,
      }
      if (isFrame) {
        node.style = {
          width: row.w ?? FRAME_DEFAULT.width,
          height: row.h ?? FRAME_DEFAULT.height,
        }
      } else if (row.w != null || row.h != null) {
        node.style = {
          width: row.w ?? NODE_DEFAULT.width,
          height: row.h ?? NODE_DEFAULT.height,
        }
      }
      if (row.parent_id != null) {
        node.parentId = String(row.parent_id)
        node.extent = 'parent'
      }
      return node
    })
}

const EDGE_LABEL: Record<BoardEdge['kind'], string | undefined> = {
  related: undefined,
  reports_to: 'reports to',
  depends_on: 'depends on',
  next: 'next',
}

export function toFlowEdges(rows: BoardEdge[]): Edge[] {
  return rows.map(e => ({
    id: String(e.id),
    source: String(e.source_id),
    target: String(e.target_id),
    type: 'default',
    label: e.label ?? EDGE_LABEL[e.kind],
    markerEnd: { type: 'arrowclosed' as const },
    data: { kind: e.kind },
  }))
}

export interface FrameRect {
  id: string
  position: XYPosition
  width: number
  height: number
}

/** A parentless node whose centre lands inside a frame joins it with a RELATIVE position. */
export function resolveParentOnDrop(
  node: {
    id: string
    position: XYPosition
    parentId?: string
    width?: number
    height?: number
  },
  frames: FrameRect[]
): { parentId: string | null; position: XYPosition } {
  if (node.parentId) return { parentId: node.parentId, position: node.position }
  const cx = node.position.x + (node.width ?? NODE_DEFAULT.width) / 2
  const cy = node.position.y + (node.height ?? NODE_DEFAULT.height) / 2
  for (const f of frames) {
    if (f.id === node.id) continue
    if (
      cx >= f.position.x &&
      cx <= f.position.x + f.width &&
      cy >= f.position.y &&
      cy <= f.position.y + f.height
    ) {
      return {
        parentId: f.id,
        position: {
          x: node.position.x - f.position.x,
          y: node.position.y - f.position.y,
        },
      }
    }
  }
  return { parentId: null, position: node.position }
}

export function toPositionItems(
  rows: Map<number, BoardNode>,
  moved: { id: string; position: XYPosition; parentId?: string }[]
): PositionItem[] {
  const out: PositionItem[] = []
  for (const m of moved) {
    const row = rows.get(Number(m.id))
    if (!row) continue
    const item: PositionItem = {
      id: row.id,
      x: m.position.x,
      y: m.position.y,
      version: row.version,
    }
    const newParent = m.parentId ? Number(m.parentId) : null
    if (newParent !== row.parent_id) item.parent_id = newParent
    out.push(item)
  }
  return out
}

/** Frames resize from the bottom-right corner only, so the origin never moves: size is all that persists. */
export function resizePatch(
  row: BoardNode,
  p: { width: number; height: number }
): { id: number; data: NodePatch } {
  return {
    id: row.id,
    data: { w: p.width, h: p.height, version: row.version },
  }
}
