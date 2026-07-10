import { useState } from 'react'
import { ArrowUpRight, ArrowUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import type { FlagResponse, FlagStatus } from '@/lib/flags-api'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import { useFlagTypesMap } from '@/services/flag-types'
import { useItemKindLabels } from '@/services/item-kinds'
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
  avatarUrlForUser,
} from '@/components/flags/flag-users'
import { relativeTime, dueLabel } from '@/components/flags/flag-format'
import {
  STATUS_LABELS,
  STATUS_DOT,
  OPEN_STATUSES,
} from '@/components/flags/flag-status'
import { FlagAvatar } from '@/components/flags/FlagAvatar'
import type { UserMap } from '@/components/flags/flag-users'
import type { FlagTypeDef } from '@/components/flags/flag-catalog'
import type { FlagSearchMeta } from '@/components/flags/flag-search'

/**
 * ONE column template shared by the header row and every data row so the
 * columns line up regardless of chip/pill/label width. A leading fixed accent
 * column keeps the type-color bar in the grid (header cell is empty) so nothing
 * shifts. Title is the ONLY flexible column (`minmax(0,1fr)`); everything else
 * is fixed-width and every cell truncates — content never wraps or misaligns.
 *
 * Columns: accent · Entity · Type · Title · Assignee · Status · Due · Age
 */
const GRID_TEMPLATE =
  'grid grid-cols-[3px_130px_104px_minmax(0,1fr)_120px_108px_88px_44px] items-center gap-x-2'

/** Due sort key: ascending by due date, nulls (no due date) last. */
function dueSortKey(f: FlagResponse): number {
  if (!f.due_at) return Number.POSITIVE_INFINITY
  const ms = new Date(f.due_at).getTime()
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms
}

/**
 * The aligned-columns table view for the flyout list (Plan 8). `highlightIds`
 * are the flags the user was just pinged about — their rows pulse (see FlagCard
 * for the same treatment in list view).
 */
export function FlagTable({
  flags,
  highlightIds,
  unreadIds,
  searchMeta,
}: {
  flags: FlagResponse[]
  highlightIds?: Set<number>
  unreadIds?: Set<number>
  searchMeta?: Map<number, FlagSearchMeta>
}) {
  const users = useFlagUsers()
  const typesMap = useFlagTypesMap()
  const kindLabels = useItemKindLabels()
  const currentUserId = useAuthStore(state => state.user?.id ?? null)
  // Optional due-ascending sort (nulls last); off by default so the server's
  // updated_at order is preserved.
  const [sortByDue, setSortByDue] = useState(false)
  const rows = sortByDue
    ? [...flags].sort((a, b) => dueSortKey(a) - dueSortKey(b))
    : flags

  return (
    <div role="table" aria-label="Flags" className="text-sm">
      <FlagTableHeader
        sortByDue={sortByDue}
        onToggleDueSort={() => setSortByDue(s => !s)}
      />
      <div role="rowgroup">
        {rows.map(flag => (
          <FlagTableRow
            key={flag.id}
            flag={flag}
            users={users}
            typesMap={typesMap}
            kindLabels={kindLabels}
            currentUserId={currentUserId}
            highlight={highlightIds?.has(flag.id) ?? false}
            unread={unreadIds?.has(flag.id) ?? false}
            search={searchMeta?.get(flag.id)}
          />
        ))}
      </div>
    </div>
  )
}

/** Muted label row, sticky under the (out-of-scroll) filter bar. */
function FlagTableHeader({
  sortByDue,
  onToggleDueSort,
}: {
  sortByDue: boolean
  onToggleDueSort: () => void
}) {
  return (
    <div
      role="row"
      className={cn(
        GRID_TEMPLATE,
        'sticky top-0 z-10 border-b bg-background px-1.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground'
      )}
    >
      <span aria-hidden />
      <span className="truncate">Item</span>
      <span className="truncate">Type</span>
      <span className="truncate">Title</span>
      <span className="truncate">Assignee</span>
      <span className="truncate">Status</span>
      <button
        type="button"
        onClick={onToggleDueSort}
        aria-pressed={sortByDue}
        className={cn(
          'inline-flex items-center gap-1 truncate uppercase tracking-wide hover:text-foreground',
          sortByDue && 'text-foreground'
        )}
      >
        Due <ArrowUpDown className="h-2.5 w-2.5" />
      </button>
      <span className="truncate text-end">Age</span>
    </div>
  )
}

function FlagTableRow({
  flag,
  users,
  typesMap,
  kindLabels,
  currentUserId,
  highlight = false,
  unread = false,
  search,
}: {
  flag: FlagResponse
  users: UserMap
  typesMap: Record<string, FlagTypeDef>
  kindLabels: Record<string, string>
  currentUserId: number | null
  highlight?: boolean
  unread?: boolean
  search?: FlagSearchMeta
}) {
  const def = typesMap[flag.type] ?? flagTypeDef(flag.type)
  const { Icon } = entityMeta(flag.entity_type)
  const label = entityDisplayLabel(flag, kindLabels)
  const canNavigate = flagCanNavigate(flag)
  const assigneeName =
    flag.assignee_id == null
      ? 'Unassigned'
      : nameForUser(users, flag.assignee_id)

  const status = flag.status as FlagStatus
  const statusLabel = STATUS_LABELS[status] ?? flag.status
  const statusColor = STATUS_DOT[status] ?? '#94a3b8'
  const due = dueLabel(flag.due_at)
  const isOverdue = (due?.overdue ?? false) && OPEN_STATUSES.includes(status)

  return (
    <div
      role="row"
      tabIndex={0}
      onClick={() => useUIStore.getState().openFlagThread(flag.id)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          useUIStore.getState().openFlagThread(flag.id)
        }
      }}
      className={cn(
        GRID_TEMPLATE,
        'group cursor-pointer rounded-md px-1.5 py-1.5 transition-colors hover:bg-muted/60',
        highlight && 'flag-row-pulse'
      )}
    >
      {/* Unread accent (dedicated color when unread, else transparent) */}
      <span
        className="h-6 w-full rounded-full"
        style={{
          backgroundColor: unread ? 'var(--flag-unread)' : 'transparent',
        }}
        aria-hidden
      />

      {/* Entity chip → deep-link */}
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

      {/* Type pill */}
      <div className="min-w-0">
        <span
          className="inline-block max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
          style={{ backgroundColor: def.color }}
          title={def.label}
        >
          {def.label}
        </span>
      </div>

      {/* Title */}
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

      {/* Assignee */}
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

      {/* Status */}
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

      {/* Due */}
      <span
        className={cn(
          'truncate text-[11px] tabular-nums',
          isOverdue ? 'font-medium text-destructive' : 'text-muted-foreground'
        )}
        title={due?.text}
      >
        {due?.text ?? '—'}
      </span>

      {/* Age */}
      <span className="truncate text-end text-[11px] tabular-nums text-muted-foreground">
        {relativeTime(flag.updated_at)}
      </span>
    </div>
  )
}

export default FlagTable
