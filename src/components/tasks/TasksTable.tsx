import type { ColumnSizingState, SortingState } from '@tanstack/react-table'
import { DataTable } from '@/components/ui/data-table'
import type { FlagResponse } from '@/lib/flags-api'
import type { FlagSearchMeta } from '@/components/flags/flag-search'
import { useFlagUsers } from '@/components/flags/flag-users'
import { useFlagTypesMap } from '@/services/flag-types'
import { useItemKindLabels } from '@/services/item-kinds'
import { useAuthStore } from '@/store/auth-store'
import { useUIStore } from '@/store/ui-store'
import { buildTaskColumns } from '@/components/tasks/task-columns'

// `group` drives the Item chip's hover arrow. The ring is inset so the
// table's scroll container does not clip it at the edges.
const ROW_CLASS =
  'group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'

/**
 * The Tasks page table. Sorting and widths are always controlled by the page,
 * which saves them; a row (click, Enter or Space) opens the task's thread.
 */
export function TasksTable({
  flags,
  unreadIds,
  searchMeta,
  sorting,
  onSortingChange,
  columnSizing,
  onColumnSizingChange,
  onColumnSizingCommit,
}: {
  flags: FlagResponse[]
  unreadIds: Set<number>
  searchMeta: Map<number, FlagSearchMeta>
  sorting: SortingState
  onSortingChange: (s: SortingState) => void
  columnSizing: ColumnSizingState
  onColumnSizingChange: (s: ColumnSizingState) => void
  onColumnSizingCommit: (s: ColumnSizingState) => void
}) {
  const users = useFlagUsers()
  const typesMap = useFlagTypesMap()
  const kindLabels = useItemKindLabels()
  const currentUserId = useAuthStore(state => state.user?.id ?? null)
  const columns = buildTaskColumns({
    users,
    typesMap,
    kindLabels,
    currentUserId,
    unreadIds,
    searchMeta,
  })

  return (
    <DataTable
      columns={columns}
      data={flags}
      sorting={sorting}
      onSortingChange={onSortingChange}
      columnSizing={columnSizing}
      onColumnSizingChange={onColumnSizingChange}
      onColumnSizingCommit={onColumnSizingCommit}
      onRowClick={flag =>
        useUIStore.getState().openFlagThread(flag.id, { returnTo: 'page' })
      }
      getRowClassName={() => ROW_CLASS}
      keyboardRowActivation
    />
  )
}
