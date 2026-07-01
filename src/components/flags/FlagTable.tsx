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
import type { UserMap } from '@/components/flags/flag-users'
import type { FlagTypeDef } from '@/components/flags/flag-catalog'

/**
 * ONE column template shared by the header row and every data row so the
 * columns line up regardless of chip/pill/label width. A leading fixed accent
 * column keeps the type-color bar in the grid (header cell is empty) so nothing
 * shifts. Title is the ONLY flexible column (`minmax(0,1fr)`); everything else
 * is fixed-width and every cell truncates — content never wraps or misaligns.
 *
 * Columns: accent · Entity · Type · Title · Sample/context · Assignee · Status · Age
 */
const GRID_TEMPLATE =
  'grid grid-cols-[3px_130px_104px_minmax(0,1fr)_150px_120px_108px_44px] items-center gap-x-2'

/** The aligned-columns table view for the flyout list (Plan 8). */
export function FlagTable({ flags }: { flags: FlagResponse[] }) {
  const users = useFlagUsers()
  const typesMap = useFlagTypesMap()
  const currentUserId = useAuthStore(state => state.user?.id ?? null)

  return (
    <div role="table" aria-label="Flags" className="text-sm">
      <FlagTableHeader />
      <div role="rowgroup">
        {flags.map(flag => (
          <FlagTableRow
            key={flag.id}
            flag={flag}
            users={users}
            typesMap={typesMap}
            currentUserId={currentUserId}
          />
        ))}
      </div>
    </div>
  )
}

/** Muted label row, sticky under the (out-of-scroll) filter bar. */
function FlagTableHeader() {
  return (
    <div
      role="row"
      className={cn(
        GRID_TEMPLATE,
        'sticky top-0 z-10 border-b bg-background px-1.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground'
      )}
    >
      <span aria-hidden />
      <span className="truncate">Entity</span>
      <span className="truncate">Type</span>
      <span className="truncate">Title</span>
      <span className="truncate">Sample</span>
      <span className="truncate">Assignee</span>
      <span className="truncate">Status</span>
      <span className="truncate text-end">Age</span>
    </div>
  )
}

function FlagTableRow({
  flag,
  users,
  typesMap,
  currentUserId,
}: {
  flag: FlagResponse
  users: UserMap
  typesMap: Record<string, FlagTypeDef>
  currentUserId: number | null
}) {
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
  // sample id when it would just repeat the entity chip label (sample rows).
  const sampleId = flag.entity?.sample_id ?? null
  const analyses = flag.entity?.analyses ?? []
  const showSample = sampleId != null && sampleId !== label
  const contextText = [showSample ? sampleId : null, analyses.join(', ')]
    .filter(Boolean)
    .join(' · ')

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
        'group cursor-pointer rounded-md px-1.5 py-1.5 transition-colors hover:bg-muted/60'
      )}
    >
      {/* Type-color accent */}
      <span
        className="h-6 w-full rounded-full"
        style={{ backgroundColor: def.color }}
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
        className="min-w-0 truncate font-semibold text-foreground"
        title={flag.title}
      >
        {flag.title}
      </span>

      {/* Sample / context */}
      <span
        className="min-w-0 truncate text-[11px] text-muted-foreground"
        title={contextText || undefined}
      >
        {contextText || '—'}
      </span>

      {/* Assignee */}
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <FlagAvatar
          initials={initialsForUser(users, flag.assignee_id, currentUserId)}
          color={avatarColor(flag.assignee_id)}
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

      {/* Age */}
      <span className="truncate text-end text-[11px] tabular-nums text-muted-foreground">
        {relativeTime(flag.updated_at)}
      </span>
    </div>
  )
}

export default FlagTable
