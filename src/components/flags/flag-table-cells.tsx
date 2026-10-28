import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FlagResponse, FlagStatus } from '@/lib/flags-api'
import type { FlagTypeDef } from '@/components/flags/flag-catalog'
import type { FlagSearchMeta } from '@/components/flags/flag-search'
import {
  entityMeta,
  entityDisplayLabel,
  navigateForFlag,
  flagCanNavigate,
} from '@/components/flags/flag-entity'
import {
  nameForUser,
  initialsForUser,
  avatarColor,
  avatarUrlForUser,
} from '@/components/flags/flag-users'
import type { UserMap } from '@/components/flags/flag-users'
import { formatDateTime, dueLabel } from '@/components/flags/flag-format'
import {
  STATUS_LABELS,
  STATUS_DOT,
  OPEN_STATUSES,
} from '@/components/flags/flag-status'
import { FlagAvatar } from '@/components/flags/FlagAvatar'

/**
 * Cell renderers shared by the flyout's FlagTable and the Tasks page table, so
 * both render the same chips. Each returns ONE element that sits directly in
 * its grid or table cell.
 */

/** Unread accent (dedicated color when unread, else transparent). */
export function UnreadAccentCell({ unread }: { unread: boolean }) {
  return (
    <span
      className="h-6 w-full rounded-full"
      style={{
        backgroundColor: unread ? 'var(--flag-unread)' : 'transparent',
      }}
      aria-hidden
    />
  )
}

/**
 * Entity chip with the deep-link button. The button stops propagation so a
 * click (or Enter/Space) navigates instead of activating the row.
 */
export function EntityCell({
  flag,
  kindLabels,
}: {
  flag: FlagResponse
  kindLabels: Record<string, string>
}) {
  const { Icon } = entityMeta(flag.entity_type)
  const label = entityDisplayLabel(flag, kindLabels)
  const canNavigate = flagCanNavigate(flag)
  return (
    <div className="min-w-0">
      <button
        type="button"
        disabled={!canNavigate}
        title={canNavigate ? `Open ${label}` : undefined}
        onClick={e => {
          e.stopPropagation()
          navigateForFlag(flag)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
        }}
        className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-bold text-foreground/80 transition-colors enabled:hover:bg-muted/80 disabled:cursor-default"
      >
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
        {canNavigate && (
          <ArrowUpRight className="h-3 w-3 shrink-0 opacity-50 transition-opacity group-hover:opacity-80" />
        )}
      </button>
    </div>
  )
}

export function TypePillCell({ def }: { def: FlagTypeDef }) {
  return (
    <div className="min-w-0">
      <span
        className="inline-block max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
        style={{ backgroundColor: def.color }}
        title={def.label}
      >
        {def.label}
      </span>
    </div>
  )
}

/** Title plus the search-hit marker when the match came from a comment. */
export function TitleCell({
  flag,
  search,
}: {
  flag: FlagResponse
  search?: FlagSearchMeta
}) {
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 font-semibold text-foreground"
      title={search ? search.snippet : flag.title}
    >
      <span className="truncate">{flag.title}</span>
      {search && (
        <span
          className="shrink-0 rounded-full bg-[var(--flag-unread)]/15 px-1.5 text-[9px] font-medium text-foreground/70"
          title={search.snippet}
        >
          💬
        </span>
      )}
    </span>
  )
}

export function AssigneeCell({
  flag,
  users,
  currentUserId,
}: {
  flag: FlagResponse
  users: UserMap
  currentUserId: number | null
}) {
  const assigneeName =
    flag.assignee_id == null
      ? 'Unassigned'
      : nameForUser(users, flag.assignee_id)
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      <FlagAvatar
        initials={initialsForUser(users, flag.assignee_id, currentUserId)}
        color={avatarColor(flag.assignee_id)}
        avatarUrl={avatarUrlForUser(users, flag.assignee_id)}
        isYou={flag.assignee_id != null && flag.assignee_id === currentUserId}
      />
      <span
        className={cn('truncate', flag.assignee_id == null && 'italic')}
        title={assigneeName}
      >
        {assigneeName}
      </span>
    </div>
  )
}

export function StatusCell({ status }: { status: string }) {
  const statusLabel = STATUS_LABELS[status as FlagStatus] ?? status
  const statusColor = STATUS_DOT[status as FlagStatus] ?? '#94a3b8'
  return (
    <div className="min-w-0">
      <span
        className="inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium text-foreground/80"
        title={`Status: ${statusLabel}`}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: statusColor }}
          aria-hidden
        />
        <span className="truncate">{statusLabel}</span>
      </span>
    </div>
  )
}

/** Due label; overdue (on an open status) renders in the destructive color. */
export function DueCell({ flag }: { flag: FlagResponse }) {
  const due = dueLabel(flag.due_at)
  const isOverdue =
    (due?.overdue ?? false) && OPEN_STATUSES.includes(flag.status as FlagStatus)
  return (
    <span
      className={cn(
        'truncate text-[11px] tabular-nums',
        isOverdue ? 'font-medium text-destructive' : 'text-muted-foreground'
      )}
      title={due?.text}
    >
      {due?.text ?? '—'}
    </span>
  )
}

/** Absolute date+time; the tooltip carries the full locale string. */
export function DateTimeCell({
  iso,
  align = 'start',
}: {
  iso: string
  align?: 'start' | 'end'
}) {
  return (
    <span
      className={cn(
        'truncate',
        align === 'end' && 'text-end',
        'text-[11px] tabular-nums text-muted-foreground'
      )}
      title={new Date(iso).toLocaleString()}
    >
      {formatDateTime(iso)}
    </span>
  )
}
