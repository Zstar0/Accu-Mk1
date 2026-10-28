import { Handle, NodeResizeControl, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { renderCommentHtml } from '@/components/flags/comment-markdown'
import { usePatchNode } from '@/services/boards'
import { resizePatch, type BoardFlowNode } from '../board-mapping'
import { useCompact } from './use-compact'

export function NoteNode({
  data,
  selected,
}: Pick<NodeProps<BoardFlowNode>, 'data' | 'selected'>) {
  const patchNode = usePatchNode(data.slug ?? '')
  const compact = useCompact()
  const md = String(
    (data.row.data as { markdown?: string } | null)?.markdown ?? ''
  )
  return (
    <div
      data-compact={compact || undefined}
      className="h-full w-full min-w-[160px] overflow-hidden rounded-md border bg-amber-50 p-2 text-xs shadow-sm dark:bg-amber-950/40"
    >
      {data.canEdit && selected && (
        <NodeResizeControl
          position="bottom-right"
          minWidth={160}
          minHeight={60}
          className="!h-3 !w-3 !rounded-sm !border-2 !border-background !bg-muted-foreground"
          onResizeEnd={(_, p) => {
            if (data.slug) patchNode.mutate(resizePatch(data.row, p))
          }}
        />
      )}
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-muted-foreground"
      />
      <div className="mb-1 font-medium">{data.row.label}</div>
      {/* Sanitised by renderCommentHtml (markdown-it + DOMPurify). No typography plugin, so plain utilities. */}
      {!compact && (
        <div
          className="leading-snug [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-4"
          dangerouslySetInnerHTML={{ __html: renderCommentHtml(md, []) }}
        />
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-muted-foreground"
      />
    </div>
  )
}
