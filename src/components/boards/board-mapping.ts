import type { Edge, Node, XYPosition } from '@xyflow/react'
import type {
  BoardEdge,
  BoardNode,
  NodeCreate,
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

/**
 * Edge ids a Delete key press should remove through the API. xyflow also hands over
 * every edge touching a selected node; only edges the user selected themselves count.
 */
export function edgeIdsToDelete(edges: Edge[]): number[] {
  return edges.filter(e => e.selected).map(e => Number(e.id))
}

/** A stored viewport, only when it is an object with finite x, y and zoom; else null. */
export function parseViewport(
  raw: string | null
): { x: number; y: number; zoom: number } | null {
  let v: unknown
  try {
    v = JSON.parse(raw ?? 'null')
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const { x, y, zoom } = v as Record<string, unknown>
  return typeof x === 'number' &&
    typeof y === 'number' &&
    typeof zoom === 'number' &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(zoom)
    ? { x, y, zoom }
    : null
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
  const w = node.width ?? NODE_DEFAULT.width
  const h = node.height ?? NODE_DEFAULT.height
  const cx = node.position.x + w / 2
  const cy = node.position.y + h / 2
  // Relative offset clamped so the whole body sits inside the frame, not just the centre.
  const clamp = (v: number, span: number) =>
    Math.min(Math.max(v, 0), Math.max(0, span))
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
          x: clamp(node.position.x - f.position.x, f.width - w),
          y: clamp(node.position.y - f.position.y, f.height - h),
        },
      }
    }
  }
  return { parentId: null, position: node.position }
}

/** Frame rectangles for the drop hit test, from what xyflow measured (or the stored size). */
export function toFrameRects(nodes: BoardFlowNode[]): FrameRect[] {
  return nodes
    .filter(n => n.type === 'frame')
    .map(n => ({
      id: n.id,
      position: n.position,
      width: Number(n.measured?.width ?? n.style?.width ?? FRAME_DEFAULT.width),
      height: Number(
        n.measured?.height ?? n.style?.height ?? FRAME_DEFAULT.height
      ),
    }))
}

/** Item types the tool drawer offers; also the drag payload under DRAWER_MIME. */
export const DRAWER_KINDS = [
  'frame',
  'text',
  'note',
  'link',
  'person',
  'document',
  'sample',
  'order',
  'worksheet',
] as const
export type DrawerKind = (typeof DRAWER_KINDS)[number]
export const DRAWER_MIME = 'application/x-board-kind'

export function isDrawerKind(v: string): v is DrawerKind {
  return (DRAWER_KINDS as readonly string[]).includes(v)
}

/** What the drawer and the palette create for the kinds that need no further input. */
export function defaultNodeCreate(kind: 'frame' | 'text' | 'note'): NodeCreate {
  if (kind === 'frame')
    return {
      kind: 'frame',
      label: 'New frame',
      w: FRAME_DEFAULT.width,
      h: FRAME_DEFAULT.height,
      data: { color: 'slate' },
    }
  if (kind === 'text')
    return { kind: 'text', label: 'Heading', data: { size: 'md' } }
  return { kind: 'note', label: 'Note', data: { markdown: '' } }
}

/**
 * Where a drawer item dropped at `at` (flow coordinates) lands: centred on the drop point,
 * inside the frame that contains that centre (relative position), else absolute. Frames
 * never nest.
 */
export function dropTargetFor(
  kind: DrawerKind,
  at: XYPosition,
  frames: FrameRect[]
): { position: XYPosition; parentId: number | null } {
  const size = kind === 'frame' ? FRAME_DEFAULT : NODE_DEFAULT
  const r = resolveParentOnDrop(
    {
      id: '',
      position: { x: at.x - size.width / 2, y: at.y - size.height / 2 },
      ...size,
    },
    kind === 'frame' ? [] : frames
  )
  return {
    position: r.position,
    parentId: r.parentId == null ? null : Number(r.parentId),
  }
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
