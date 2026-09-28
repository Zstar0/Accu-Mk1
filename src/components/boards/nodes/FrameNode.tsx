import { NodeResizer } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import { usePatchNode } from '@/services/boards'
import { resizePatch, type BoardFlowNode } from '../board-mapping'

const COLOR: Record<string, string> = {
  slate: 'border-slate-400/70 bg-slate-500/5',
  red: 'border-red-400/70 bg-red-500/5',
  orange: 'border-orange-400/70 bg-orange-500/5',
  amber: 'border-amber-400/70 bg-amber-500/5',
  green: 'border-green-400/70 bg-green-500/5',
  teal: 'border-teal-400/70 bg-teal-500/5',
  blue: 'border-blue-400/70 bg-blue-500/5',
  purple: 'border-purple-400/70 bg-purple-500/5',
}

export function FrameNode({ data, selected }: NodeProps<BoardFlowNode>) {
  const patchNode = usePatchNode(data.slug ?? '')
  const color = String(
    (data.row.data as { color?: string } | null)?.color ?? 'slate'
  )
  return (
    <div
      className={cn(
        'h-full w-full rounded-xl border-2 border-dashed',
        COLOR[color] ?? COLOR.slate
      )}
    >
      {data.canEdit && (
        <NodeResizer
          minWidth={160}
          minHeight={100}
          isVisible={selected}
          onResizeEnd={(_, p) => {
            if (data.slug) patchNode.mutate(resizePatch(data.row, p))
          }}
        />
      )}
      <div className="px-3 py-2 text-sm font-medium">{data.row.label}</div>
    </div>
  )
}
