import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import type { FlagResponse, FlagStatus } from '@/lib/flags-api'
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
import { STATUS_LABELS, STATUS_DOT } from '@/components/flags/flag-status'
import { FlagAvatar } from '@/components/flags/FlagAvatar'

/**
 * One dense flag row in the flyout list — everything on a single line:
 * `[color bar] [entity chip → deep-link] [type pill] [title, flex-1 truncate]
 * [Sample ID · analytes, muted] [assignee] [status badge] [relative time]`.
 * The title takes the flex space and truncates; the secondary context and
 * assignee name drop off first on narrow widths. Clicking the row opens the
 * thread; clicking the entity chip deep-links (and stops propagation).
 *
 * Note: the list API (`FlagResponse`) exposes neither a comment count nor a
 * read/unread flag, so `unread` is a forward-looking prop, off by default.
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

  const status = flag.status as FlagStatus
  const statusLabel = STATUS_LABELS[status] ?? flag.status
  const statusColor = STATUS_DOT[status] ?? '#94a3b8'

  // Secondary context (vials/samples): "P-0071 · PEPT-Total, …". Omit the
  // sample id when it would just repeat the chip label (sample rows).
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
      className="group flex cursor-pointer items-center gap-2.5 rounded-lg py-2 pl-1.5 pr-2.5 transition-colors hover:bg-muted/60"
    >
      <div
        className="h-7 w-[3px] shrink-0 rounded-full"
        style={{ backgroundColor: def.color }}
        aria-hidden
      />

      {unread && (
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-blue-500"
          aria-label="unread"
        />
      )}

      <button
        type="button"
        disabled={!canNavigate}
        title={canNavigate ? `Open ${label}` : undefined}
        onClick={e => {
          e.stopPropagation()
          navigateForFlag(flag)
        }}
        onKeyDown={e => {
          // Keep Enter/Space from also reaching the row's open-thread handler.
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
        }}
        className="inline-flex max-w-[9rem] shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-bold text-foreground/80 transition-colors enabled:hover:bg-muted/80 disabled:cursor-default"
      >
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
        {canNavigate && (
          <ArrowUpRight className="h-3 w-3 shrink-0 opacity-50 transition-opacity group-hover:opacity-80" />
        )}
      </button>

      <span
        className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
        style={{ backgroundColor: def.color }}
      >
        {def.label}
      </span>

      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
        {flag.title}
      </span>

      {hasContext && (
        <span className="hidden max-w-[13rem] shrink-0 items-center gap-1 truncate text-[11px] text-muted-foreground lg:flex">
          {showSample && (
            <span className="font-medium text-foreground/70">{sampleId}</span>
          )}
          {showSample && analyses.length > 0 && <span aria-hidden>·</span>}
          {analyses.length > 0 && (
            <span className="truncate">{analyses.join(', ')}</span>
          )}
        </span>
      )}

      <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
        <FlagAvatar
          initials={initialsForUser(users, flag.assignee_id, currentUserId)}
          color={avatarColor(flag.assignee_id)}
          isYou={flag.assignee_id != null && flag.assignee_id === currentUserId}
        />
        <span
          className={cn(
            'hidden max-w-[7rem] truncate xl:inline',
            flag.assignee_id == null && 'italic'
          )}
        >
          {assigneeName}
        </span>
      </span>

      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium text-foreground/80"
        title={`Status: ${statusLabel}`}
      >
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: statusColor }}
          aria-hidden
        />
        {statusLabel}
      </span>

      <span className="w-9 shrink-0 text-end text-[11px] tabular-nums text-muted-foreground">
        {relativeTime(flag.updated_at)}
      </span>
    </div>
  )
}

export default FlagCard
