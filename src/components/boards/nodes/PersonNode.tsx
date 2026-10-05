import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { FlagAvatar } from '@/components/flags/FlagAvatar'
import { displayName } from '@/lib/user-display'
import { useDirectoryUsers } from '@/services/groups'
import type { BoardFlowNode } from '../board-mapping'

/** `data` keys a person node stores (backend PersonData); rows made before `show` existed have only `user_id`. */
export interface PersonNodeData extends Record<string, unknown> {
  user_id?: number
  show?: 'name' | 'email'
  show_title?: boolean
}

export function PersonNode({ data }: Pick<NodeProps<BoardFlowNode>, 'data'>) {
  const d = (data.row.data ?? {}) as PersonNodeData
  const directory = useDirectoryUsers()
  const u = directory.data?.find(x => x.id === Number(d.user_id))
  const name = u ? displayName(u) : data.row.label
  const line = d.show === 'email' && u ? u.email : name
  const title = d.show_title !== false ? u?.title : null
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
      <div className="flex flex-col leading-tight">
        <span className="font-medium">{line}</span>
        {title && (
          <span className="text-[10px] text-muted-foreground">{title}</span>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-muted-foreground"
      />
    </div>
  )
}
