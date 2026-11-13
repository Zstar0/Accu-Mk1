import type { NodeProps } from '@xyflow/react'
import type { BoardFlowNode } from '../board-mapping'

const SIZE: Record<string, string> = {
  sm: 'text-sm',
  md: 'text-lg',
  lg: 'text-2xl',
}

export function TextNode({ data }: NodeProps<BoardFlowNode>) {
  const size = String((data.row.data as { size?: string } | null)?.size ?? 'md')
  return (
    <div className={`px-2 py-1 font-semibold ${SIZE[size] ?? SIZE.md}`}>
      {data.row.label}
    </div>
  )
}
