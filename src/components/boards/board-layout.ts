import dagre from '@dagrejs/dagre'
import type { XYPosition } from '@xyflow/react'

// Kept apart from board-mapping so dagre ships in the lazy canvas chunk only. Type-only
// xyflow import, like preferences/panes/workflow/layout.ts, so the unit test stays cheap.

export interface LayoutBox {
  id: string
  parentId?: string
  position: XYPosition
  width: number
  height: number
}

/** Room a laid-out frame keeps around its items; `top` clears the frame title. */
const PAD = { side: 16, top: 40 }

/**
 * Top-down dagre layout (spec §8.3) of the connected items in one scope: a frame's children
 * (positions relative to the frame), or the top-level items when `frameId` is null, where a
 * line to an item inside a frame counts as a line to that frame. Unconnected items stay
 * put, and the block keeps its current top-left corner so nothing jumps across the board.
 * `size` is what the frame needs to hold the moved items (frame scope only).
 */
export function layoutScope(
  boxes: LayoutBox[],
  edges: { source: string; target: string }[],
  frameId: string | null
): {
  moved: { id: string; position: XYPosition }[]
  size: { width: number; height: number } | null
} {
  const byId = new Map(boxes.map(b => [b.id, b]))
  const inScope = (id?: string) => {
    const b = id == null ? undefined : byId.get(id)
    return b != null && (b.parentId ?? null) === frameId
  }
  const lift = (id: string) => (inScope(id) ? id : byId.get(id)?.parentId)

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 32, ranksep: 64 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const e of edges) {
    const s = lift(e.source)
    const t = lift(e.target)
    if (!s || !t || s === t || !inScope(s) || !inScope(t)) continue
    for (const id of [s, t]) {
      const b = byId.get(id)
      if (b) g.setNode(id, { width: b.width, height: b.height })
    }
    g.setEdge(s, t)
  }
  const ids = g.nodes()
  if (!ids.length) return { moved: [], size: null }
  dagre.layout(g)

  // dagre positions by centre; the board positions by top-left.
  const laid = ids.map(id => {
    const { x, y, width, height } = g.node(id)
    return { id, x: x - width / 2, y: y - height / 2, width, height }
  })
  const min = (vs: number[]) => Math.min(...vs)
  const was = ids.flatMap(id => byId.get(id)?.position ?? [])
  const floor =
    frameId == null
      ? { x: -Infinity, y: -Infinity }
      : { x: PAD.side, y: PAD.top }
  const dx = Math.max(min(was.map(p => p.x)), floor.x) - min(laid.map(n => n.x))
  const dy = Math.max(min(was.map(p => p.y)), floor.y) - min(laid.map(n => n.y))
  const moved = laid.map(n => ({
    ...n,
    x: Math.round(n.x + dx),
    y: Math.round(n.y + dy),
  }))
  return {
    moved: moved.map(n => ({ id: n.id, position: { x: n.x, y: n.y } })),
    size:
      frameId == null
        ? null
        : {
            width: Math.max(...moved.map(n => n.x + n.width)) + PAD.side,
            height: Math.max(...moved.map(n => n.y + n.height)) + PAD.side,
          },
  }
}
