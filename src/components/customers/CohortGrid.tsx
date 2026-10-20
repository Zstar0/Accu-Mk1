import { cn } from '@/lib/utils'
import type { CustomerCohorts } from '@/lib/api'
import { cohortTint, fmtPct } from './insights-utils'

const PRESSED = 'ring-2 ring-primary'

export function CohortGrid({
  months,
  rows,
  selectedCohort,
  selectedMonth,
  onSelect,
}: {
  months: string[]
  rows: CustomerCohorts['rows']
  selectedCohort: string | null
  selectedMonth: string | null
  onSelect: (cohort: string | null, month: string | null) => void
}) {
  // A second click on the selected row label or cell clears the selection.
  const pick = (cohort: string, month: string | null) =>
    cohort === selectedCohort && month === selectedMonth
      ? onSelect(null, null)
      : onSelect(cohort, month)
  return (
    <table className="w-full text-xs tabular-nums">
      <thead>
        <tr className="text-muted-foreground">
          <th className="py-1 text-start font-medium">Cohort</th>
          <th className="font-medium">n</th>
          {months.map(m => (
            <th key={m} className="font-medium">
              {m}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(r => {
          const rowPressed =
            r.cohort === selectedCohort && selectedMonth == null
          return (
            <tr key={r.cohort}>
              <td className="py-0.5">
                <button
                  type="button"
                  aria-pressed={rowPressed}
                  onClick={() => pick(r.cohort, null)}
                  className={cn(
                    'cursor-pointer rounded px-1 hover:underline',
                    rowPressed && PRESSED
                  )}
                >
                  {r.cohort}
                </button>
              </td>
              <td className="text-center">{r.size}</td>
              {months.map((m, i) => {
                const c = r.cells[i]
                const pressed =
                  r.cohort === selectedCohort && m === selectedMonth
                const pct = c == null ? '' : fmtPct(c, c < 0.2 ? 1 : 0)
                return (
                  <td
                    key={m}
                    className={cn('rounded text-center', cohortTint(c ?? null))}
                  >
                    {c != null && (
                      <button
                        type="button"
                        aria-pressed={pressed}
                        aria-label={`${r.cohort} ${m} ${pct}`}
                        onClick={() => pick(r.cohort, m)}
                        className={cn(
                          'w-full cursor-pointer rounded hover:underline',
                          pressed && PRESSED
                        )}
                      >
                        {pct}
                      </button>
                    )}
                  </td>
                )
              })}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
