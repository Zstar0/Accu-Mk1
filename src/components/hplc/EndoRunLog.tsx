import { useQuery } from '@tanstack/react-query'
import { getWorksheetBenchLog, type WorksheetUser } from '@/lib/api'
import { shortName } from '@/lib/user-display'

/**
 * Dennis's run log, as the endo bench's worksheet history: the newest
 * endotoxin worksheets (open and completed), one button each, with the
 * analyst, the sample count and a two-bar meter that fills when every row is
 * Made / ran on the MCS. Lean summaries from /worksheets/bench-log; the full
 * worksheet loads only when one is picked.
 */
export function EndoRunLog({
  activeId,
  users,
  onSelect,
}: {
  activeId: number | null
  users: WorksheetUser[]
  onSelect: (worksheetId: number) => void
}) {
  // Under the 'worksheets-list' prefix on purpose: every worksheet mutation
  // already invalidates that prefix, so ticks and completions refresh the log.
  const { data: runs = [], isLoading } = useQuery({
    queryKey: ['worksheets-list', 'bench-log', 'endo'],
    queryFn: () => getWorksheetBenchLog('endo'),
    staleTime: 30_000,
  })

  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r bg-card">
      <div className="flex flex-col gap-0.5 border-b px-4 pb-3 pt-4">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-teal-700 dark:text-teal-300">
          Endotoxin
        </span>
        <h2 className="text-lg font-semibold leading-tight">Run log</h2>
        <span className="text-xs text-muted-foreground">
          {isLoading
            ? 'Loading…'
            : `${runs.length} ${runs.length === 1 ? 'worksheet' : 'worksheets'}`}
        </span>
      </div>
      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {runs.map(run => {
          const analyst = users.find(u => u.id === run.assigned_analyst)
          const full = (n: number) => run.item_count > 0 && n === run.item_count
          return (
            <li key={run.id}>
              <button
                type="button"
                aria-current={run.id === activeId}
                onClick={() => onSelect(run.id)}
                className={`grid w-full grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-[5px] border px-2.5 py-2 text-left ${
                  run.id === activeId
                    ? 'border-teal-500/30 bg-teal-500/10'
                    : 'border-transparent hover:bg-muted/60'
                }`}
              >
                <span
                  className={`truncate text-[13px] font-medium ${run.status === 'completed' ? 'text-muted-foreground' : ''}`}
                  title={run.title}
                >
                  {run.title}
                </span>
                <span
                  className="row-span-2 flex gap-0.5"
                  title={`Made ${run.made_count}/${run.item_count} · MCS ${run.ran_count}/${run.item_count}`}
                >
                  {[run.made_count, run.ran_count].map((n, i) => (
                    <i
                      key={i}
                      className={`block h-4 w-1 rounded-[1px] ${full(n) ? 'bg-emerald-500' : 'bg-border'}`}
                    />
                  ))}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {analyst ? shortName(analyst) : 'unassigned'} ·{' '}
                  {run.item_count} {run.item_count === 1 ? 'sample' : 'samples'}
                  {run.status === 'completed' ? ' · done' : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

export default EndoRunLog
