import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import type { FlagResponse } from '@/lib/flags-api'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import {
  entityMeta,
  entityLabel,
  navigateToEntity,
} from '@/components/flags/flag-entity'
import {
  useFlagUsers,
  nameForUser,
  initialsForUser,
  avatarColor,
} from '@/components/flags/flag-users'
import { relativeTime } from '@/components/flags/flag-format'
import { FlagAvatar } from '@/components/flags/FlagAvatar'

/**
 * One flag row in the flyout list. Color bar + entity chip + type pill + title
 * + assignee avatar + relative time. Clicking opens the thread.
 *
 * Note: the list API (`FlagResponse`) exposes neither a comment count nor a
 * read/unread flag, so those mockup affordances are omitted here (would need a
 * count field on the API or per-flag detail). `unread` is a forward-looking
 * prop, off by default.
 */
export function FlagCard({
  flag,
  unread = false,
}: {
  flag: FlagResponse
  unread?: boolean
}) {
  const users = useFlagUsers()
  const currentUserId = useAuthStore(state => state.user?.id ?? null)

  const def = flagTypeDef(flag.type)
  const { Icon, canDeepLink } = entityMeta(flag.entity_type)
  const assigneeName =
    flag.assignee_id == null
      ? 'Unassigned'
      : nameForUser(users, flag.assignee_id)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => useUIStore.getState().openFlagThread(flag.id)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          useUIStore.getState().openFlagThread(flag.id)
        }
      }}
      className="group relative flex gap-3 rounded-lg p-2.5 hover:bg-muted/60 cursor-pointer transition-colors"
    >
      <div
        className="w-[3px] shrink-0 rounded-full"
        style={{ backgroundColor: def.color }}
        aria-hidden
      />

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-bold text-foreground/80">
            <Icon className="h-3 w-3" />
            {entityLabel(flag.entity_type, flag.entity_id)}
            {canDeepLink && (
              <ArrowUpRight
                className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-70 hover:!opacity-100"
                onClick={e => {
                  e.stopPropagation()
                  navigateToEntity(flag.entity_type, flag.entity_id)
                }}
              />
            )}
          </span>
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
            style={{ backgroundColor: def.color }}
          >
            {def.label}
          </span>
        </div>

        <div className="truncate text-sm font-semibold text-foreground">
          {flag.title}
        </div>

        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <FlagAvatar
            initials={initialsForUser(users, flag.assignee_id, currentUserId)}
            color={avatarColor(flag.assignee_id)}
            isYou={
              flag.assignee_id != null && flag.assignee_id === currentUserId
            }
          />
          <span className={cn(flag.assignee_id == null && 'italic')}>
            {assigneeName}
          </span>
          <span aria-hidden>·</span>
          <span>{relativeTime(flag.updated_at)}</span>
        </div>
      </div>

      {unread && (
        <span
          className="absolute right-2.5 top-3 h-2 w-2 rounded-full bg-blue-500"
          aria-label="unread"
        />
      )}
    </div>
  )
}

export default FlagCard
