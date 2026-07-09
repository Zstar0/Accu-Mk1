/**
 * Watcher row for the flag thread: avatar cluster + count, expandable list
 * with remove, a self Watch/Unwatch toggle, and an add-watcher picker.
 * Names resolve client-side via the shared user directory (module purity —
 * the backend ships ids only). Watchers get no live toasts (Phase 1 LOCKED).
 *
 * Mutations ride the shared useAddWatcher/useRemoveWatcher hooks, which already
 * invalidate the flag-detail + Watching-list query keys.
 */
import { useState } from 'react'
import { Eye, EyeOff, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { type Watcher } from '@/lib/flags-api'
import { useAddWatcher, useRemoveWatcher } from '@/hooks/use-flags'
import {
  useFlagUsers,
  nameForUser,
  initialsForUser,
  avatarColor,
} from '@/components/flags/flag-users'
import { displayName } from '@/lib/user-display'

export function FlagWatchers({
  flagId,
  watchers,
  currentUserId,
}: {
  flagId: number
  watchers: Watcher[]
  currentUserId: number | null
}) {
  const users = useFlagUsers()
  const add = useAddWatcher(flagId)
  const remove = useRemoveWatcher(flagId)
  const [expanded, setExpanded] = useState(false)
  const [adding, setAdding] = useState(false)

  const watcherIds = new Set(watchers.map(w => w.user_id))
  const meWatching = currentUserId != null && watcherIds.has(currentUserId)
  const busy = add.isPending || remove.isPending
  const candidates = [...users.values()]
    .filter(u => !watcherIds.has(u.id))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)))

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <button
        type="button"
        className="flex items-center gap-1 hover:text-foreground"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        <span className="flex -space-x-1.5">
          {watchers.slice(0, 4).map(w => (
            <span
              key={w.user_id}
              className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white ring-1 ring-background"
              style={{ backgroundColor: avatarColor(w.user_id) }}
              title={nameForUser(users, w.user_id)}
            >
              {initialsForUser(users, w.user_id, currentUserId)}
            </span>
          ))}
        </span>
        {watchers.length} watching
      </button>

      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        disabled={busy || currentUserId == null}
        onClick={() =>
          currentUserId != null &&
          (meWatching
            ? remove.mutate(currentUserId)
            : add.mutate(currentUserId))
        }
      >
        {meWatching ? (
          <EyeOff className="h-3 w-3" />
        ) : (
          <Eye className="h-3 w-3" />
        )}
        {meWatching ? 'Unwatch' : 'Watch'}
      </Button>

      {adding ? (
        <Select
          onValueChange={v => {
            add.mutate(Number(v))
            setAdding(false)
          }}
          onOpenChange={open => {
            if (!open) setAdding(false)
          }}
          defaultOpen
        >
          <SelectTrigger
            size="sm"
            aria-label="Add watcher"
            className="h-6 w-40 text-xs"
          >
            <SelectValue placeholder="Add watcher…" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map(u => (
              <SelectItem key={u.id} value={String(u.id)}>
                {displayName(u)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3 w-3" /> Add watcher
        </Button>
      )}

      {expanded && (
        <ul className="w-full space-y-1 pl-1">
          {watchers.map(w => (
            <li key={w.user_id} className="flex items-center gap-2">
              <span className="text-foreground">
                {nameForUser(users, w.user_id)}
              </span>
              <button
                type="button"
                aria-label={`Remove ${nameForUser(users, w.user_id)}`}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => remove.mutate(w.user_id)}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default FlagWatchers
