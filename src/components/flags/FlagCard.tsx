import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import type { FlagResponse } from '@/lib/flags-api'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import { useFlagTypesMap } from '@/services/flag-types'
import {
  entityMeta,
  entityDisplayLabel,
  navigateForFlag,
  flagCanNavigate,
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
  const typesMap = useFlagTypesMap()
  const currentUserId = useAuthStore(state => state.user?.id ?? null)

  const def = typesMap[flag.type] ?? flagTypeDef(flag.type)
  const { Icon } = entityMeta(flag.entity_type)
  const label = entityDisplayLabel(flag)
  const canNavigate = flagCanNavigate(flag)
  const assigneeName =
    flag.assignee_id == null
      ? 'Unassigned'
      : nameForUser(users, flag.assignee_id)

  // Secondary context line (vials/samples): "Sample P-0071 · PEPT-Total, …".
  // Omit the "Sample {id}" prefix when it would just repeat the chip label
  // (sample cards, where label === sample_id).
  const sampleId = flag.entity?.sample_id ?? null
  const analyses = flag.entity?.analyses ?? []
  const showSample = sampleId != null && sampleId !== label
  const hasContext = showSample || analyses.length > 0

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
          <button
            type="button"
            disabled={!canNavigate}
            title={canNavigate ? `Open ${label}` : undefined}
            onClick={e => {
              e.stopPropagation()
              navigateForFlag(flag)
            }}
            onKeyDown={e => {
              // Keep Enter/Space from also reaching the card's open-thread handler.
              if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
            }}
            className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-bold text-foreground/80 transition-colors enabled:hover:bg-muted/80 disabled:cursor-default"
          >
            <Icon className="h-3 w-3 shrink-0" />
            <span className="truncate">{label}</span>
            {canNavigate && (
              <ArrowUpRight className="h-3 w-3 shrink-0 opacity-50 transition-opacity group-hover:opacity-80" />
            )}
          </button>
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

        {hasContext && (
          <div className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            {showSample && (
              <span className="shrink-0">
                Sample{' '}
                <span className="font-medium text-foreground/70">
                  {sampleId}
                </span>
              </span>
            )}
            {showSample && analyses.length > 0 && <span aria-hidden>·</span>}
            {analyses.length > 0 && (
              <span className="truncate">{analyses.join(', ')}</span>
            )}
          </div>
        )}

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
