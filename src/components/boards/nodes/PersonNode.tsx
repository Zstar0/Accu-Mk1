import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { FlagAvatar } from '@/components/flags/FlagAvatar'
import { useDirectoryUsers } from '@/services/groups'
import type { BoardFlowNode } from '../board-mapping'

export function PersonNode({ data }: NodeProps<BoardFlowNode>) {
  const userId = Number((data.row.data as { user_id?: number } | null)?.user_id)
  const directory = useDirectoryUsers()
  const u = directory.data?.find(x => x.id === userId)
  const name = u
    ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
    : data.row.label
  const initials =
    name
      .split(/\s+/)
      .map(p => p[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  return (
    <div className="flex items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3 text-xs shadow-sm">
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-muted-foreground"
      />
      <FlagAvatar
        initials={initials}
        color="#7F77DD"
        size={22}
        avatarUrl={u?.avatar_url ?? null}
      />
      <span className="font-medium">{name}</span>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-muted-foreground"
      />
    </div>
  )
}
