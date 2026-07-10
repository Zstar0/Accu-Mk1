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
import { relativeTime, dueLabel } from '@/components/flags/flag-format'
import {
  STATUS_LABELS,
  STATUS_DOT,
  OPEN_STATUSES,
} from '@/components/flags/flag-status'
import { FlagAvatar } from '@/components/flags/FlagAvatar'
import type { FlagSearchMeta } from '@/components/flags/flag-search'

/**
 * One flag in the flyout's stacked LIST view (Plan 8 restored the pre-Plan-7
 * card): a left accent bar, then a meta row (entity chip → deep-link, type
 * pill, status badge), the title, an optional Sample-context line, and an
 * assignee + relative-time footer. Clicking the card opens the thread; clicking
 * the entity chip deep-links (and stops propagation). The aligned-columns
 * TABLE view is a separate renderer (`FlagTable`).
 *
 * `unread` drives the left bar: the dedicated `--flag-unread` color when this
 * flag has unread changes for the user (from `useFlagUnread`), transparent when
 * read. Type is conveyed by the type pill, not the bar.
 *
 * `highlight` briefly pulses the card when the flyout opens onto a flag the user
 * was just pinged about (driven by the `justOpened` snapshot). Keyed by flag id
 * at the call site, so a data refetch won't replay the animation.
 */
export function FlagCard({
  flag,
  unread = false,
  highlight = false,
  search,
}: {
  flag: FlagResponse
  unread?: boolean
  highlight?: boolean
  /** Set when a comment body matched the flyout search — adds a badge + snippet. */
  search?: FlagSearchMeta
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

  // Due-date treatment: overdue only "counts" while the flag is still open.
  const due = dueLabel(flag.due_at)
  const isOverdue = (due?.overdue ?? false) && OPEN_STATUSES.includes(status)

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
      className={cn(
        'group relative flex gap-3 rounded-lg p-2.5 hover:bg-muted/60 cursor-pointer transition-colors',
        highlight && 'flag-row-pulse'
      )}
    >
      <div
        className="w-[3px] shrink-0 rounded-full"
        style={{
          backgroundColor: unread
            ? 'var(--flag-unread)'
            : isOverdue
              ? '#e5484d'
              : 'transparent',
        }}
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
          <span
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium text-foreground/80"
            title={`Status: ${statusLabel}`}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: statusColor }}
              aria-hidden
            />
            {statusLabel}
          </span>
          {due && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                isOverdue
                  ? 'bg-destructive/10 text-destructive'
                  : 'text-muted-foreground'
              )}
            >
              {due.text}
            </span>
          )}
          {search && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--flag-unread)]/15 px-2 py-0.5 text-[10px] font-medium text-foreground/70">
              matched in comments
            </span>
          )}
        </div>

        <div className="truncate text-sm font-semibold text-foreground">
          {flag.title}
        </div>

        {search && (
          <div className="mt-0.5 truncate text-[11px] italic text-muted-foreground">
            {search.snippet}
          </div>
        )}

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
    </div>
  )
}

export default FlagCard
