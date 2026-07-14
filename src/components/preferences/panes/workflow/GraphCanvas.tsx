import { useMemo } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type NodeProps,
} from '@xyflow/react'
// Kept local to this module (not the pane's global CSS) so it only ships in
// the lazy chunk — the whole point of Task 10's React.lazy split.
import '@xyflow/react/dist/style.css'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { WorkflowCategory, WorkflowGraph } from '@/lib/workflow-api'
import { layoutGraph, type StateFlowNode } from './layout'

/** category → color strip, overridden per-state by `state.color`. */
const CATEGORY_COLOR: Record<WorkflowCategory, string> = {
  active: '#3b82f6', // blue
  terminal: '#22c55e', // green
  exception: '#f59e0b', // amber
}

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
