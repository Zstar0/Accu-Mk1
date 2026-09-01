import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import {
  buildMatrixRows,
  type MatrixCell,
  type MatrixCellStatus,
} from '@/lib/vial-board'
import type { BoardVial } from '@/lib/api'

const CELL_STATUS_CLASS: Record<MatrixCellStatus, string> = {
  not_ordered: 'text-muted-foreground/40',
  not_started:
    'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-500/15 dark:text-zinc-400 dark:border-zinc-500/20',
  in_progress:
    'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/20',
  complete:
    'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-500/15 dark:text-teal-400 dark:border-teal-500/20',
  rejected:
    'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-400 dark:border-red-500/20',
}

const CELL_STATUS_LABEL: Record<
  Exclude<MatrixCellStatus, 'not_ordered'>,
  string
> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  complete: 'Complete',
  rejected: 'Rejected',
}

const OVERALL_CLASS: Record<'complete' | 'in_progress' | 'issue', string> = {
  complete:
    'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-500/15 dark:text-teal-400 dark:border-teal-500/20',
  in_progress:
    'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/20',
  issue:
    'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-400 dark:border-red-500/20',
}

const OVERALL_LABEL: Record<'complete' | 'in_progress' | 'issue', string> = {
  complete: 'Complete',
  in_progress: 'In Progress',
  issue: 'Issue',
}

// Fallback cell shape for a role code that (in principle) has no entry in
// row.cells — buildMatrixRows always populates one cell per `roleCodes`
// entry, so this only guards `noUncheckedIndexedAccess`'s
// `Record<string, MatrixCell>` widening to `MatrixCell | undefined`; it is
// not expected to render in practice (deviation from the brief's snippet,
// which indexes unguarded).
const NOT_ORDERED_CELL: MatrixCell = {
  status: 'not_ordered',
  done: 0,
  submitted: 0,
  total: 0,
}

function MatrixCellView({ cell }: { cell: MatrixCell }) {
  if (cell.status === 'not_ordered') {
    // "not ordered ≠ not started": an empty cell must never read as
    // forgotten work (spec §5).
    return (
      <span className={cn('text-xs', CELL_STATUS_CLASS.not_ordered)}>
        — not ordered
      </span>
    )
  }
  const subline =
    cell.status === 'in_progress'
      ? cell.done > 0
        ? `${cell.done}/${cell.total} promoted`
        : `${cell.submitted}/${cell.total} submitted`
      : null
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span
        className={cn(
          'inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium',
          CELL_STATUS_CLASS[cell.status]
        )}
      >
        {CELL_STATUS_LABEL[cell.status]}
      </span>
      {subline && (
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {subline}
        </span>
      )}
    </div>
  )
}

export function VialBoardMatrix({
  vials,
  laneVials,
  roleCodes,
  roleLabel,
}: {
  vials: BoardVial[]
  laneVials: BoardVial[]
  roleCodes: string[]
  roleLabel: (code: string) => string
}) {
  const rows = buildMatrixRows(vials, laneVials, roleCodes)
  return (
    <div className="overflow-x-auto rounded-lg border border-border/50">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/50 bg-muted/30 text-left">
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Sample
            </th>
            {roleCodes.map(code => (
              <th
                key={code}
                className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {roleLabel(code)}
              </th>
            ))}
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Overall
            </th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Tech
            </th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Worksheet
            </th>
            <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Received
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr
              key={row.parentSampleId}
              onClick={() =>
                useUIStore.getState().navigateToSample(row.parentSampleId)
              }
              className="border-b border-border/30 last:border-b-0 hover:bg-muted/20 cursor-pointer"
            >
              <td className="px-3 py-2">
                <div className="font-mono text-[13px] font-semibold text-primary">
                  {row.parentSampleId}
                </div>
                {row.label && (
                  <div className="text-xs text-muted-foreground truncate max-w-[180px]">
                    {row.label}
                  </div>
                )}
              </td>
              {roleCodes.map(code => (
                <td key={code} className="px-3 py-2 align-top">
                  <MatrixCellView cell={row.cells[code] ?? NOT_ORDERED_CELL} />
                </td>
              ))}
              <td className="px-3 py-2 align-top">
                <span
                  className={cn(
                    'inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium',
                    OVERALL_CLASS[row.overall]
                  )}
                >
                  {OVERALL_LABEL[row.overall]}
                </span>
              </td>
              <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                {row.techs.length === 0
                  ? '—'
                  : row.techs.length <= 2
                    ? row.techs.join(', ')
                    : `${row.techs.slice(0, 2).join(', ')} +${row.techs.length - 2}`}
              </td>
              <td className="px-3 py-2 align-top">
                {row.worksheets.length === 0 ? (
                  <span className="text-xs text-muted-foreground">—</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {row.worksheets.map(t => (
                      <span
                        key={t}
                        className="font-mono text-[10px] rounded border border-border/60 bg-muted/40 px-1.5 py-0.5"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 align-top font-mono text-xs tabular-nums text-muted-foreground">
                {row.earliestReceived ? row.earliestReceived.slice(0, 10) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
