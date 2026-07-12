import { useMemo } from 'react'
import dagre from '@dagrejs/dagre'
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react'
// Kept local to this module (not the pane's global CSS) so it only ships in
// the lazy chunk — the whole point of Task 10's React.lazy split.
import '@xyflow/react/dist/style.css'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type {
  WorkflowCategory,
  WorkflowGraph,
  WorkflowState,
} from '@/lib/workflow-api'

const NODE_WIDTH = 180
const NODE_HEIGHT = 64

/** category → color strip, overridden per-state by `state.color`. */
const CATEGORY_COLOR: Record<WorkflowCategory, string> = {
  active: '#3b82f6', // blue
  terminal: '#22c55e', // green
  exception: '#f59e0b', // amber
}

// `Node<>`'s NodeData generic requires `Record<string, unknown>` — a plain
// `interface Foo { ... }` doesn't structurally satisfy that constraint (TS
// wants an index signature), so this extends it explicitly rather than
// falling back to an object-literal `type`.
interface StateNodeData extends Record<string, unknown> {
  state: WorkflowState
}
type StateFlowNode = Node<StateNodeData, 'state'>

function StateNode({ data }: NodeProps<StateFlowNode>) {
  const { state } = data
  const stripColor = state.color ?? CATEGORY_COLOR[state.category]

  return (
    <div
      className={cn(
        'flex h-full w-full items-stretch overflow-hidden rounded-md border bg-card text-card-foreground shadow-sm',
        !state.is_active && 'opacity-50'
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <span
        className="w-1.5 shrink-0"
        style={{ backgroundColor: stripColor }}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-2 py-1.5">
        <span className="truncate text-sm font-medium leading-tight">
          {state.label}
        </span>
        <Badge variant="secondary" className="w-fit text-[10px]">
          {state.usage_count} in use
        </Badge>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-muted-foreground"
      />
    </div>
  )
}

const nodeTypes = { state: StateNode }

/**
 * dagre `rankdir: 'LR'` layout of the workflow catalog. Pure — no React
 * dependency — so it's straightforward to unit-test independent of the
 * canvas render.
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
      markerEnd: { type: MarkerType.ArrowClosed },
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

export interface GraphCanvasProps {
  graph: WorkflowGraph
  showInactive: boolean
  onSelectState: (id: number) => void
  onSelectTransition: (id: number) => void
}

function GraphCanvas({
  graph,
  showInactive,
  onSelectState,
  onSelectTransition,
}: GraphCanvasProps) {
  const { nodes, edges } = useMemo(
    () => layoutGraph(graph, showInactive),
    [graph, showInactive]
  )

  return (
    <div className="h-[520px] w-full overflow-hidden rounded-lg border bg-background">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelectState(Number(node.id))}
        onEdgeClick={(_, edge) => onSelectTransition(Number(edge.id))}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

export default GraphCanvas
