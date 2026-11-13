import type { ReactNode } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import type { FlagResponse, FlagStatus } from '@/lib/flags-api'
import { flagTypeDef, type FlagTypeDef } from '@/components/flags/flag-catalog'
import { entityDisplayLabel } from '@/components/flags/flag-entity'
import type { FlagSearchMeta } from '@/components/flags/flag-search'
import { STATUS_ORDER } from '@/components/flags/flag-status'
import { nameForUser, type UserMap } from '@/components/flags/flag-users'
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
import {
  TASK_COLUMN_LIMITS,
  type TaskColumnId,
} from '@/components/tasks/tasks-page-settings'

export interface TaskColumnContext {
  users: UserMap
  typesMap: Record<string, FlagTypeDef>
  kindLabels: Record<string, string>
  currentUserId: number | null
  unreadIds: Set<number>
  searchMeta: Map<number, FlagSearchMeta>
}

/**
 * One sortable, resizable data column. `sortingFn` is explicit because
 * TanStack's 'auto' guesses from the data, so the order would change with the
 * row count. Undefined sort values sort last only where `sortUndefined` says.
 */
function column(
  id: TaskColumnId,
  header: string,
  sortingFn: 'alphanumeric' | 'basic',
  sortValue: (flag: FlagResponse) => string | number | undefined,
  cell: (flag: FlagResponse) => ReactNode
): ColumnDef<FlagResponse> {
  const { size, min, max } = TASK_COLUMN_LIMITS[id]
  return {
    id,
    header,
    accessorFn: sortValue,
    cell: ({ row }) => cell(row.original),
    sortingFn,
    sortDescFirst: false,
    enableMultiSort: false,
    size,
    minSize: min,
    maxSize: max,
  }
}

function epochMs(iso: string | null): number | undefined {
  if (!iso) return undefined
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? undefined : ms
}

export function buildTaskColumns(
  ctx: TaskColumnContext
): ColumnDef<FlagResponse>[] {
  const typeDef = (flag: FlagResponse) =>
    ctx.typesMap[flag.type] ?? flagTypeDef(flag.type)

  return [
    {
      id: 'accent',
      header: '',
      enableSorting: false,
      enableResizing: false,
      size: 6,
      minSize: 6,
      maxSize: 6,
      // UnreadAccentCell is an inline span; inside a td it needs a sized box.
      cell: ({ row }) => (
        <div className="flex h-6 w-[3px]">
          <UnreadAccentCell unread={ctx.unreadIds.has(row.original.id)} />
        </div>
      ),
    },
    column(
      'item',
      'Item',
      'alphanumeric',
      f => entityDisplayLabel(f, ctx.kindLabels).toLowerCase(),
      f => <EntityCell flag={f} kindLabels={ctx.kindLabels} />
    ),
    column(
      'type',
      'Type',
      'alphanumeric',
      f => typeDef(f).label.toLowerCase(),
      f => <TypePillCell def={typeDef(f)} />
    ),
    column(
      'title',
      'Title',
      'alphanumeric',
      f => f.title.toLowerCase(),
      f => <TitleCell flag={f} search={ctx.searchMeta.get(f.id)} />
    ),
    {
      ...column(
        'assignee',
        'Assignee',
        'alphanumeric',
        f =>
          f.assignee_id == null
            ? undefined
            : nameForUser(ctx.users, f.assignee_id).toLowerCase(),
        f => (
          <AssigneeCell
            flag={f}
            users={ctx.users}
            currentUserId={ctx.currentUserId}
          />
        )
      ),
      sortUndefined: 'last',
    },
    column(
      'status',
      'Status',
      'basic',
      f => STATUS_ORDER.indexOf(f.status as FlagStatus),
      f => <StatusCell status={f.status} />
    ),
    {
      ...column(
        'due',
        'Due',
        'basic',
        f => epochMs(f.due_at),
        f => <DueCell flag={f} empty="" />
      ),
      sortUndefined: 'last',
    },
    column(
      'last_activity',
      'Last activity',
      'basic',
      f => epochMs(f.updated_at),
      f => <DateTimeCell iso={f.updated_at} />
    ),
    column(
      'created',
      'Created',
      'basic',
      f => epochMs(f.created_at),
      f => <DateTimeCell iso={f.created_at} />
    ),
  ]
}
