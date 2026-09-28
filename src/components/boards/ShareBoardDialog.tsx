import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useGroups } from '@/services/groups'
import { useBoard, useReplaceGrants } from '@/services/boards'
import type { Grant } from '@/lib/api-boards'

type Level = 'none' | 'view' | 'edit'

/**
 * Admin-only: which groups may view (restricted boards) or edit (any board).
 * Loads the board's current grants itself (only while open) so it never saves
 * from an empty starting state — a save with no prior grants would revoke
 * every group's access.
 */
export function ShareBoardDialog({
  slug,
  open,
  onOpenChange,
}: {
  slug: string
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const board = useBoard(open ? slug : null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share board</DialogTitle>
        </DialogHeader>
        {board.data ? (
          <ShareBoardForm
            key={slug}
            slug={slug}
            grants={board.data.grants}
            onOpenChange={onOpenChange}
          />
        ) : (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Keyed by slug so useState below initializes fresh per board, from loaded data, without an effect. */
function ShareBoardForm({
  slug,
  grants,
  onOpenChange,
}: {
  slug: string
  grants: Grant[]
  onOpenChange: (o: boolean) => void
}) {
  const groups = useGroups()
  const replace = useReplaceGrants(slug)
  const [levels, setLevels] = useState<Record<number, Level>>(() =>
    Object.fromEntries(
      grants.map(g => [g.group_id, g.can_edit ? 'edit' : 'view'])
    )
  )
  const levelOf = (id: number): Level => levels[id] ?? 'none'

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Groups with view access can see a restricted board. Groups with edit
        access can change any board they can see.
      </p>
      <div className="divide-y rounded-md border">
        {(groups.data ?? []).map(g => (
          <div
            key={g.id}
            className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
          >
            <span>
              <span className="font-mono text-xs">{g.slug}</span> {g.name}
            </span>
            <select
              aria-label={`${g.slug} access`}
              className="h-8 rounded-md border bg-background px-2 text-xs"
              value={levelOf(g.id)}
              onChange={e =>
                setLevels(prev => ({
                  ...prev,
                  [g.id]: e.target.value as Level,
                }))
              }
            >
              <option value="none">No access</option>
              <option value="view">View</option>
              <option value="edit">Edit</option>
            </select>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          disabled={replace.isPending}
          onClick={() =>
            replace.mutate(
              Object.entries(levels)
                .filter(([, lv]) => lv !== 'none')
                .map(([id, lv]) => ({
                  group_id: Number(id),
                  can_edit: lv === 'edit',
                })),
              { onSuccess: () => onOpenChange(false) }
            )
          }
        >
          Save
        </Button>
      </div>
    </>
  )
}
