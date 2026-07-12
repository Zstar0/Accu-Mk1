import dagre from '@dagrejs/dagre'
import type { Node, Edge } from '@xyflow/react'
import type { WorkflowGraph, WorkflowState } from '@/lib/workflow-api'

// This module intentionally takes ONLY type-only imports from
// `@xyflow/react` (erased at compile time, zero runtime cost) so it never
// pulls in the real xyflow runtime (`ReactFlow`, its CSS, its worker/DOM
// setup cost) just to unit-test this pure dagre layout. See GraphCanvas.tsx,
// which imports the actual xyflow runtime for rendering.
//
// `MarkerType.ArrowClosed` (xyflow's own enum) is therefore not imported as
// a value here — its runtime value is the string literal 'arrowclosed'
// (verified against @xyflow/system's `edges.d.ts`: `enum MarkerType {
// Arrow = "arrow", ArrowClosed = "arrowclosed" }`), which is assignable to
// `EdgeMarker['type']` (`MarkerType | \`${MarkerType}\``) without importing
// the enum.
const MARKER_TYPE_ARROW_CLOSED = 'arrowclosed'

export const NODE_WIDTH = 180
export const NODE_HEIGHT = 64

// `Node<>`'s NodeData generic requires `Record<string, unknown>` — a plain
// `interface Foo { ... }` doesn't structurally satisfy that constraint (TS
// wants an index signature), so this extends it explicitly rather than
// falling back to an object-literal `type`.
export interface StateNodeData extends Record<string, unknown> {
  state: WorkflowState
}
export type StateFlowNode = Node<StateNodeData, 'state'>

/**
 * dagre `rankdir: 'LR'` layout of the workflow catalog. Pure — no React
 * dependency, no `@xyflow/react` runtime import — so it's cheap to
 * unit-test independent of the canvas render.
 *
 * Inactive states/transitions are dropped entirely unless `showInactive`;
 * when shown, `StateNode` renders them at reduced opacity (ghosted) rather
 * than filtering happening twice.
 */
export function layoutGraph(
  graph: WorkflowGraph,
  showInactive: boolean
): { nodes: StateFlowNode[]; edges: Edge[] } {
  const states = graph.states.filter(s => showInactive || s.is_active)
  const visibleIds = new Set(states.map(s => s.id))
  const transitions = graph.transitions.filter(
    t =>
      (showInactive || t.is_active) &&
      visibleIds.has(t.from_state_id) &&
      visibleIds.has(t.to_state_id)
  )

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 96 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const state of states) {
    g.setNode(String(state.id), { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const transition of transitions) {
    g.setEdge(String(transition.from_state_id), String(transition.to_state_id))
  }

  dagre.layout(g)

  const nodes: StateFlowNode[] = states.map(state => {
    const pos = g.node(String(state.id))
    return {
      id: String(state.id),
      type: 'state',
      // dagre positions by center; React Flow positions by top-left.
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      data: { state },
      style: { width: NODE_WIDTH, height: NODE_HEIGHT },
    }
  })

  const edges: Edge[] = transitions.map(transition => {
    const isSelfLoop = transition.from_state_id === transition.to_state_id
    return {
      id: String(transition.id),
      source: String(transition.from_state_id),
      target: String(transition.to_state_id),
      type: 'default',
      label: transition.label || transition.verb,
      markerEnd: { type: MARKER_TYPE_ARROW_CLOSED },
      style: transition.is_active
        ? undefined
        : { opacity: 0.5, strokeDasharray: '4 4' },
      // Self-loops (e.g. analysis 'retest' verified -> verified) render with
      // the default edge type and just an offset label — acceptable v1 per
      // the task brief, full loop-path geometry is out of scope.
      ...(isSelfLoop ? { labelStyle: { transform: 'translateY(-18px)' } } : {}),
    }
  })

  return { nodes, edges }
}
