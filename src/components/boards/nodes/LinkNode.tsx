import { ExternalLink } from 'lucide-react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { isSafeHttpUrl, openExternal } from '../open-external'
import type { BoardFlowNode } from '../board-mapping'

export function LinkNode({ data }: Pick<NodeProps<BoardFlowNode>, 'data'>) {
  const url = String((data.row.data as { url?: string } | null)?.url ?? '')
  const safe = isSafeHttpUrl(url)
  let host = ''
  try {
    host = safe ? new URL(url).host : ''
  } catch {
    host = ''
  }
  return (
    <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs shadow-sm">
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-muted-foreground"
      />
      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
      <button
        type="button"
        className="text-left disabled:opacity-50"
        disabled={!safe}
        aria-label={`${data.row.label} ${host}`}
        onClick={() => openExternal(url)}
      >
        <div className="font-medium">{data.row.label}</div>
        <div className="text-muted-foreground">{host || 'invalid link'}</div>
      </button>
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-muted-foreground"
      />
    </div>
  )
}
