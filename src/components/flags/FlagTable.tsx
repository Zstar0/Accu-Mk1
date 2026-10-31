import { useState } from 'react'
import { ArrowUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import type { FlagResponse } from '@/lib/flags-api'
import { flagTypeDef } from '@/components/flags/flag-catalog'
import { useFlagTypesMap } from '@/services/flag-types'
import { useItemKindLabels } from '@/services/item-kinds'
import { useFlagUsers } from '@/components/flags/flag-users'
import {
  UnreadAccentCell,
  EntityCell,
  TypePillCell,
  TitleCell,
  AssigneeCell,
  StatusCell,
  DueCell,
  DateTimeCell,
} from '@/components/flags/flag-table-cells'
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
  'grid grid-cols-[3px_130px_104px_minmax(0,1fr)_120px_108px_88px_118px] items-center gap-x-2'

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
      <span className="truncate text-end">Created</span>
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
      <UnreadAccentCell unread={unread} />
      <EntityCell flag={flag} kindLabels={kindLabels} />
      <TypePillCell def={def} />
      <TitleCell flag={flag} search={search} />
      <AssigneeCell flag={flag} users={users} currentUserId={currentUserId} />
      <StatusCell status={flag.status} />
      <DueCell flag={flag} />
      <DateTimeCell iso={flag.created_at} align="end" />
    </div>
  )
}

export default FlagTable
