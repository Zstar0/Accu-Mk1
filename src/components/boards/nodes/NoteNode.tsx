import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { renderCommentHtml } from '@/components/flags/comment-markdown'
import type { BoardFlowNode } from '../board-mapping'

export function NoteNode({ data }: NodeProps<BoardFlowNode>) {
  const md = String(
    (data.row.data as { markdown?: string } | null)?.markdown ?? ''
  )
  return (
    <div className="w-[240px] rounded-md border bg-amber-50 p-2 text-xs shadow-sm dark:bg-amber-950/40">
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-muted-foreground"
      />
      <div className="mb-1 font-medium">{data.row.label}</div>
      {/* Sanitised by renderCommentHtml (markdown-it + DOMPurify). No typography plugin, so plain utilities. */}
      <div
        className="leading-snug [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-4"
        dangerouslySetInnerHTML={{ __html: renderCommentHtml(md, []) }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-muted-foreground"
      />
    </div>
  )
}
