import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { entityMeta, navigateToDeepLink } from '@/components/flags/flag-entity'
import type { BoardFlowNode } from '../board-mapping'

export function EntityNode({ data }: NodeProps<BoardFlowNode>) {
  const { row } = data
  const meta = entityMeta(row.entity_type)
  const Icon = meta.Icon
  const label = row.context?.label ?? row.label
  const deep = row.context?.deep_link
  return (
    <div
      className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs shadow-sm"
      onDoubleClick={() => {
        if (deep) navigateToDeepLink(deep)
      }}
      title={deep ? 'Double-click to open' : undefined}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-muted-foreground"
      />
      <Icon className="h-3.5 w-3.5 text-teal-600" />
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-muted-foreground">{meta.label}</div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-muted-foreground"
      />
    </div>
  )
}
