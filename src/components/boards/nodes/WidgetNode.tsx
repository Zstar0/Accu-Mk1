import type { NodeProps } from '@xyflow/react'
import type { BoardFlowNode } from '../board-mapping'

export function WidgetNode({ data }: NodeProps<BoardFlowNode>) {
  return (
    <div className="rounded-md border border-dashed bg-card px-3 py-2 text-xs text-muted-foreground">
      {data.row.label} (widgets arrive in a later release)
    </div>
  )
}
