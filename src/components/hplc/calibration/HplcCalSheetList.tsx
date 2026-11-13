import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Star } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { createCalSheet, getPeptides, type CalSheetListItem } from '@/lib/api'
import {
  CAL_SHEETS_KEY,
  CAL_SHEET_KEY,
  useCalSheets,
} from '@/services/hplc-calibration-sheets'
import { useUIStore } from '@/store/ui-store'
import { CalSelect } from './CalCells'

const open = (id: number) =>
  useUIStore.getState().navigateToCalibrationSheet(id)

/** Draft, Filed, or Changed since filed. */
function statusOf(s: CalSheetListItem) {
  if (s.curve_id === null) return 'Draft'
  return s.changed_since_filed ? 'Changed since filed' : 'Filed'
}

function dateOf(s: CalSheetListItem) {
  const at = s.updated_at ?? s.filed_at
  return at
    ? new Date(at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '-'
}

/** Every calibration worksheet, newest save first (the server's order), with
 *  a compound filter and New. */
export function HplcCalSheetList() {
  const [peptideId, setPeptideId] = useState<number | undefined>(undefined)
  const { data: sheets = [], error, isLoading } = useCalSheets(peptideId)
  const { data: peptides = [] } = useQuery({
    queryKey: ['peptides'],
    queryFn: () => getPeptides(),
    staleTime: 5 * 60 * 1000,
  })
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  async function create() {
    setBusy(true)
    setFailed(null)
    try {
      const s = await createCalSheet({})
      qc.setQueryData(CAL_SHEET_KEY(s.id), s)
      void qc.invalidateQueries({ queryKey: [...CAL_SHEETS_KEY, 'list'] })
      open(s.id)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'the server did not answer')
    } finally {
      setBusy(false)
    }
  }

  const options: [string, string][] = [
    ['', 'All compounds'],
    ...peptides
      .filter(p => !p.is_blend)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(p => [String(p.id), p.name] as [string, string]),
  ]
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-[23px] font-semibold tracking-tight">
          Calibration worksheets
        </h2>
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Compound</span>
            <CalSelect
              label="Compound"
              value={peptideId === undefined ? '' : String(peptideId)}
              options={options}
              disabled={false}
              minWidth="min-w-44"
              onChange={v => setPeptideId(v ? Number(v) : undefined)}
            />
          </label>
          <Button onClick={() => void create()} disabled={busy}>
            New calibration worksheet
          </Button>
        </div>
      </div>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {`A new worksheet could not be made: ${failed}`}
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {!isLoading && !error && sheets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No calibration worksheets yet.
        </p>
      ) : (
        <ul className="divide-y rounded-md border bg-card">
          {sheets.map(s => {
            const status = statusOf(s)
            return (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {s.curve_is_active ? (
                    <Star
                      role="img"
                      aria-label="Active curve"
                      className="h-4 w-4 shrink-0 fill-amber-500 text-amber-500"
                    />
                  ) : (
                    <span className="w-4 shrink-0" />
                  )}
                  <span data-testid="sheet-name" className="truncate font-mono">
                    {s.curve_name ?? s.proposed_name}
                  </span>
                </span>
                <span className="w-36 truncate">
                  {s.peptide_name ?? (
                    <span className="text-muted-foreground">No compound</span>
                  )}
                </span>
                <span className="w-20 truncate font-mono text-xs">
                  {s.instrument_name ?? (
                    <span className="text-muted-foreground">-</span>
                  )}
                </span>
                <Badge
                  variant={status === 'Filed' ? 'default' : 'outline'}
                  className={`px-1.5 py-0 text-[10px] ${status === 'Changed since filed' ? 'border-amber-500/60 text-amber-700 dark:text-amber-300' : ''}`}
                >
                  {status}
                </Badge>
                <span className="w-24 text-xs text-muted-foreground">
                  {dateOf(s)}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Open ${s.curve_name ?? s.proposed_name}`}
                  onClick={() => open(s.id)}
                >
                  Open
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
