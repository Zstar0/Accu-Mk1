import { NodeResizeControl } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import { useBoard, useBoardFlags, usePatchNode } from '@/services/boards'
import { useFlagTypes } from '@/services/flag-types'
import { blockingTypeSet, frameRollup } from '../board-flags'
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

export function FrameNode({
  data,
  selected,
}: Pick<NodeProps<BoardFlowNode>, 'data' | 'selected'>) {
  const patchNode = usePatchNode(data.slug ?? '')
  const flags = useBoardFlags(data.slug ?? null)
  const board = useBoard(data.slug ?? null)
  const types = useFlagTypes({})
  const roll = frameRollup(
    flags.data ?? [],
    board.data?.nodes ?? [],
    data.row.id,
    blockingTypeSet(types.data)
  )
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
      {/* Corner-only resize: the origin never moves, so children keep their relative positions (edge resizes would need a child re-save). */}
      {data.canEdit && selected && (
        <NodeResizeControl
          position="bottom-right"
          minWidth={160}
          minHeight={100}
          className="!h-3 !w-3 !rounded-sm !border-2 !border-background !bg-muted-foreground"
          onResizeEnd={(_, p) => {
            if (data.slug) patchNode.mutate(resizePatch(data.row, p))
          }}
        />
      )}
      <div className="flex items-center gap-2 px-3 py-2 text-sm font-medium">
        <span className="truncate">{data.row.label}</span>
        {roll.blocking > 0 && (
          <span
            data-testid="frame-pill-blocking"
            className="rounded-full bg-red-600 px-1.5 text-[10px] font-semibold text-white"
          >
            {roll.blocking} blocking
          </span>
        )}
        {roll.other > 0 && (
          <span
            data-testid="frame-pill-open"
            className="rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white"
          >
            {roll.other} open
          </span>
        )}
      </div>
    </div>
  )
}
