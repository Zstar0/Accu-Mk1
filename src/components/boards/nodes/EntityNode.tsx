import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { entityMeta, navigateToDeepLink } from '@/components/flags/flag-entity'
import { useBoardFlags } from '@/services/boards'
import { useFlagTypes } from '@/services/flag-types'
import { blockingTypeSet, flagsByAnchor, nodeAnchor } from '../board-flags'
import type { BoardFlowNode } from '../board-mapping'
import { useCompact } from './use-compact'

export function EntityNode({ data }: NodeProps<BoardFlowNode>) {
  const { row } = data
  const compact = useCompact()
  const meta = entityMeta(row.entity_type)
  const Icon = meta.Icon
  const label = row.context?.label ?? row.label
  const deep = row.context?.deep_link
  const flags = useBoardFlags(data.slug ?? null)
  const types = useFlagTypes({})
  const mine = flagsByAnchor(flags.data ?? []).get(nodeAnchor(row)) ?? []
  const blocking = blockingTypeSet(types.data)
  const hasBlocking = mine.some(f => blocking.has(f.type))
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
        {!compact && <div className="text-muted-foreground">{meta.label}</div>}
      </div>
      {!compact && mine.length > 0 && (
        <span
          data-testid="entity-pill"
          className={`ml-1 rounded-full px-1.5 text-[10px] font-semibold text-white ${hasBlocking ? 'bg-red-600' : 'bg-amber-500'}`}
        >
          {mine.length} open
        </span>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-muted-foreground"
      />
    </div>
  )
}
