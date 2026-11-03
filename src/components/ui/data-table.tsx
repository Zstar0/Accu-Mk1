'use client'

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type SortingState,
  getSortedRowModel,
  type ColumnResizeMode,
  type ColumnSizingState,
  type TableOptions,
} from '@tanstack/react-table'
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  onRowClick?: (row: TData) => void
  selectedRowId?: string | number
  getRowId?: (row: TData) => string
  enableColumnResizing?: boolean
  /** Controlled sorting: pass `sorting` and `onSortingChange` together.
   *  Absent: DataTable keeps its own. Pick one mode for the table's lifetime;
   *  never switch between controlled and uncontrolled. */
  sorting?: SortingState
  onSortingChange?: (next: SortingState) => void
  /** Controlled column widths: pass `columnSizing` and
   *  `onColumnSizingChange` together. Absent: TanStack keeps its own. Pick one
   *  mode for the table's lifetime; never switch between controlled and
   *  uncontrolled. */
  columnSizing?: ColumnSizingState
  onColumnSizingChange?: (next: ColumnSizingState) => void
  /** Fires once when a resize drag ends, with the widths after it. */
  onColumnSizingCommit?: (sizing: ColumnSizingState) => void
  getRowClassName?: (row: TData) => string | undefined
  /** Rows take focus; Enter or Space calls onRowClick. */
  keyboardRowActivation?: boolean
}

export function DataTable<TData, TValue>({
  columns,
  data,
  onRowClick,
  selectedRowId,
  getRowId,
  enableColumnResizing = true,
  sorting: sortingProp,
  onSortingChange,
  columnSizing,
  onColumnSizingChange,
  onColumnSizingCommit,
  getRowClassName,
  keyboardRowActivation = false,
}: DataTableProps<TData, TValue>) {
  'use no memo'
  const [innerSorting, setInnerSorting] = useState<SortingState>([])
  const [columnResizeMode] = useState<ColumnResizeMode>('onChange')
  const sorting = sortingProp ?? innerSorting

  // Only add the sizing keys when controlled: an explicit `undefined` would
  // override TanStack's own state and updater and break resizing.
  // TanStack's resize handler fills the new width inside its sizing-info
  // updater and reads it in the sizing updater. React may defer the first, so
  // run it now; otherwise the controlled width lags or comes back empty.
  const sizingOptions: Partial<TableOptions<TData>> =
    columnSizing === undefined
      ? {}
      : {
          onColumnSizingInfoChange: u => {
            const next =
              typeof u === 'function' ? u(table.getState().columnSizingInfo) : u
            table.setState(old => ({ ...old, columnSizingInfo: next }))
          },
          onColumnSizingChange: u =>
            onColumnSizingChange?.(
              typeof u === 'function' ? u(columnSizing) : u
            ),
        }

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table known issue with React Compiler
  const table = useReactTable({
    data,
    columns,
    defaultColumn: {
      minSize: 30,
      size: 100,
      maxSize: 500,
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange:
      sortingProp === undefined
        ? setInnerSorting
        : u => onSortingChange?.(typeof u === 'function' ? u(sortingProp) : u),
    state: {
      sorting,
      ...(columnSizing !== undefined && { columnSizing }),
    },
    columnResizeMode,
    enableColumnResizing,
    ...sizingOptions,
  })

  // A drag ends when isResizingColumn goes from a column id to false. Checked
  // after render so a controlled columnSizing already holds the final width.
  const wasResizing = useRef<string | false>(false)
  useEffect(() => {
    const { columnSizingInfo, columnSizing: sizing } = table.getState()
    if (wasResizing.current && !columnSizingInfo.isResizingColumn) {
      onColumnSizingCommit?.(sizing)
    }
    wasResizing.current = columnSizingInfo.isResizingColumn
  })

  return (
    <div className="overflow-auto rounded-md border">
      <Table
        className="w-full"
        style={{
          width: table.getCenterTotalSize(),
          tableLayout: 'fixed',
        }}
      >
        <TableHeader>
          {table.getHeaderGroups().map(headerGroup => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map(header => (
                <TableHead
                  key={header.id}
                  style={{
                    width: header.getSize(),
                    position: 'relative',
                  }}
                  className="relative overflow-hidden"
                >
                  {header.isPlaceholder ? null : header.column.getCanSort() ? (
                    <button
                      type="button"
                      className="flex items-center gap-1 truncate hover:text-foreground transition-colors -ml-1 px-1 rounded"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                      {{
                        asc: <ArrowUp className="h-3 w-3 shrink-0" />,
                        desc: <ArrowDown className="h-3 w-3 shrink-0" />,
                      }[header.column.getIsSorted() as string] ?? (
                        <ArrowUpDown className="h-3 w-3 shrink-0 opacity-40" />
                      )}
                    </button>
                  ) : (
                    <div className="truncate">
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                    </div>
                  )}
                  {/* Resize handle - wider for easier interaction */}
                  {enableColumnResizing && header.column.getCanResize() && (
                    <div
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      className={cn(
                        'absolute right-0 top-0 h-full w-2 cursor-col-resize select-none touch-none',
                        'bg-transparent hover:bg-primary/50 transition-colors',
                        header.column.getIsResizing() && 'bg-primary'
                      )}
                      style={{ transform: 'translateX(50%)' }}
                    />
                  )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map(row => {
              const rowId = getRowId
                ? getRowId(row.original)
                : (row.original as Record<string, unknown>).id
              const isSelected =
                selectedRowId !== undefined && rowId === selectedRowId

              return (
                <TableRow
                  key={row.id}
                  data-state={isSelected ? 'selected' : undefined}
                  className={cn(
                    onRowClick && 'cursor-pointer hover:bg-muted/50',
                    isSelected && 'bg-muted',
                    getRowClassName?.(row.original)
                  )}
                  onClick={() => onRowClick?.(row.original)}
                  tabIndex={keyboardRowActivation ? 0 : undefined}
                  onKeyDown={
                    keyboardRowActivation
                      ? e => {
                          // Keys aimed at a control inside the row stay there.
                          if (e.target !== e.currentTarget) return
                          if (e.key !== 'Enter' && e.key !== ' ') return
                          e.preventDefault()
                          onRowClick?.(row.original)
                        }
                      : undefined
                  }
                >
                  {row.getVisibleCells().map(cell => (
                    <TableCell
                      key={cell.id}
                      style={{ width: cell.column.getSize() }}
                      className="overflow-hidden truncate"
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              )
            })
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
                No results.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
