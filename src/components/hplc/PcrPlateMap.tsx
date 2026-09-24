import { Lock, Unlock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { plateGrid, PROTOCOL, type PcrPlate } from '@/lib/pcr-plate'
import { plateLabel } from '@/lib/pcr-worksheet'
import { useUIStore } from '@/store/ui-store'

// The workbook's fills: Office accent5 / accent4 tints for the two assay
// blocks, gray for the control. Dark mode keeps the same hues as deep tints
// (blue for 16S, amber for 18S) under light ink. The printed sheet is its own
// HTML (pcr-bench-sheet.ts) and stays on paper colours whatever the theme.
const FILL = {
  bac: 'bg-[#deeaf6] dark:bg-[#1d3a5c]',
  bacAlt: 'bg-[#bdd7ee] dark:bg-[#2b5582]',
  fun: 'bg-[#fff2cc] dark:bg-[#3f3510]',
  funAlt: 'bg-[#ffe699] dark:bg-[#5c4d12]',
  ctrl: 'bg-[#d9d9d9] dark:bg-zinc-600 font-bold',
  empty: 'bg-white dark:bg-zinc-900',
}
// The order outline is drawn with inline border styles (one edge at a time),
// so its colour is a CSS variable the theme can flip.
const GROUP = 'var(--pcr-group)'
const GROUP_VAR = '[--pcr-group:#44546a] dark:[--pcr-group:#9fb3cf]'
const TH =
  'border border-zinc-400 bg-zinc-100 px-0.5 py-0.5 text-center font-sans text-[11px] font-bold text-zinc-800 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200'
const BLOCK = 'border-l-[3px] border-l-zinc-900 dark:border-l-zinc-300'
const RED_TEXT = 'text-[#c00000] dark:text-red-300'
const RED_CORNER =
  'border-r-[#c00000] border-t-[#c00000] dark:border-r-red-400 dark:border-t-red-400'
const MUTED_INK = 'text-zinc-600 dark:text-zinc-300'
const COLS = Array.from({ length: PROTOCOL.cols }, (_, i) => i + 1)

/**
 * One 96-well plate as Dennis draws it: the bacterial block in columns 1 to
 * 6, its fungal mirror in 7 to 12, each well labelled with the sample id, the
 * order number and the due date; each order outlined as one region with
 * alternating tints; a red corner on a priority well. Locked wells (printed
 * or exported) are announced in the header and can be released on purpose.
 */
export function PcrPlateMap({
  plate,
  plateCount,
  outlineGroups,
  frozenCount,
  isCompleted,
  onUnfreeze,
}: {
  plate: PcrPlate
  plateCount: number
  outlineGroups: boolean
  /** Locked wells across the run (the badge is per run, not per plate). */
  frozenCount: number
  isCompleted: boolean
  onUnfreeze: () => void
}) {
  const map = plateGrid(plate)
  const groupAt = (ri: number, c: number): number | null =>
    ri < 0 || ri > 7 || c < 1 || c > PROTOCOL.cols
      ? null
      : (map.get(`${PROTOCOL.rows[ri]}${c}`)?.placement.group ?? null)

  return (
    <section
      className={`overflow-hidden rounded-[5px] border bg-card shadow-sm ${GROUP_VAR}`}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-muted/60 px-3.5 py-2">
        <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
          Plate map
          {plateCount > 1 ? `: plate ${plate.plate} of ${plateCount}` : ''}
        </h3>
        <Legend />
        <span className="flex-1" />
        {frozenCount > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-[3px] border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
            title="Printed or exported: these wells never move. Late additions take the wells after them; the NPC stays last."
          >
            <Lock className="h-3 w-3" />
            {frozenCount} well{frozenCount === 1 ? '' : 's'} locked
          </span>
        )}
        {frozenCount > 0 && !isCompleted && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            title="Release every locked well and lay the plate out again. Only for a plate that was printed too early: a loaded plate would no longer match."
            onClick={onUnfreeze}
          >
            <Unlock className="h-3 w-3" />
            Unlock wells
          </Button>
        )}
      </header>
      <div className="overflow-x-auto p-3">
        <table className="w-full min-w-[760px] table-fixed border-collapse font-mono text-[11px] text-zinc-900 dark:text-zinc-100">
          <thead>
            <tr>
              <th className={`${TH} w-7`} />
              {COLS.map(c => (
                <th key={c} className={`${TH} ${c === 7 ? BLOCK : ''}`}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PROTOCOL.rows.map((r, ri) => (
              <tr key={r}>
                <th className={`${TH} w-7`}>{r}</th>
                {COLS.map(c => {
                  const cell = map.get(`${r}${c}`)
                  const base = `relative h-[52px] overflow-hidden border border-zinc-400 px-0.5 py-0.5 text-center dark:border-zinc-600 align-middle ${c === 7 ? BLOCK : ''}`
                  if (!cell)
                    return <td key={c} className={`${base} ${FILL.empty}`} />
                  const p = cell.placement
                  const g = p.group
                  const fill = p.isControl
                    ? FILL.ctrl
                    : cell.assay === 'bac'
                      ? outlineGroups && g % 2 === 1
                        ? FILL.bacAlt
                        : FILL.bac
                      : outlineGroups && g % 2 === 1
                        ? FILL.funAlt
                        : FILL.fun
                  const edges = outlineGroups
                    ? {
                        borderTopColor:
                          groupAt(ri - 1, c) !== g ? GROUP : undefined,
                        borderTopWidth:
                          groupAt(ri - 1, c) !== g ? 2 : undefined,
                        borderBottomColor:
                          groupAt(ri + 1, c) !== g ? GROUP : undefined,
                        borderBottomWidth:
                          groupAt(ri + 1, c) !== g ? 2 : undefined,
                        borderLeftColor:
                          c !== 7 && (c === 1 || groupAt(ri, c - 1) !== g)
                            ? GROUP
                            : undefined,
                        borderLeftWidth:
                          c !== 7 && (c === 1 || groupAt(ri, c - 1) !== g)
                            ? 2
                            : undefined,
                        borderRightColor:
                          c === 6 || c === 12 || groupAt(ri, c + 1) !== g
                            ? GROUP
                            : undefined,
                        borderRightWidth:
                          c === 6 || c === 12 || groupAt(ri, c + 1) !== g
                            ? 2
                            : undefined,
                      }
                    : undefined
                  const a = p.assessment
                  const dueClass =
                    a?.urgency === 'overdue'
                      ? `font-bold ${RED_TEXT}`
                      : a?.urgency === 'today'
                        ? 'font-bold text-[#bf6a00] dark:text-orange-300'
                        : MUTED_INK
                  const title = [
                    `${r}${c}`,
                    p.id,
                    p.identity,
                    p.order ? `Order ${p.order}` : '',
                    a?.due ? `Due ${a.due}` : '',
                    ...(a?.reasons ?? []),
                    cell.assay === 'bac' ? '16S' : '18S',
                    p.frozen ? 'Locked' : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <td
                      key={c}
                      className={`${base} ${fill} ${p.sample ? 'cursor-pointer hover:brightness-95 dark:hover:brightness-125' : ''}`}
                      style={edges}
                      title={title}
                      onClick={
                        p.sample
                          ? () => useUIStore.getState().navigateToSample(p.id)
                          : undefined
                      }
                    >
                      {a?.flagged && (
                        <span
                          aria-hidden
                          className={`absolute right-0 top-0 h-0 w-0 border-[0.4rem] border-transparent ${RED_CORNER}`}
                        />
                      )}
                      <span
                        className={`block truncate leading-[1.4] ${a?.urgency === 'overdue' && a.flagged ? `font-bold ${RED_TEXT}` : ''}`}
                      >
                        {plateLabel(p.id)}
                      </span>
                      {p.order && (
                        <span
                          className={`block text-[9.5px] leading-tight ${MUTED_INK}`}
                        >
                          {p.order}
                        </span>
                      )}
                      {a?.due && (
                        <span
                          className={`block text-[9.5px] leading-tight ${dueClass}`}
                        >
                          {a.due
                            .slice(5)
                            .replace(/^0/, '')
                            .replace('-0', '/')
                            .replace('-', '/')}
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Legend() {
  const sw = (cls: string, extra = '') => (
    <i
      className={`inline-block h-2.5 w-5 border border-zinc-400 dark:border-zinc-600 ${cls} ${extra}`}
    />
  )
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-muted-foreground">
      <span className="flex items-center gap-1">
        {sw(FILL.bac)} 16S, cols 1 to 6
      </span>
      <span className="flex items-center gap-1">
        {sw(FILL.fun)} 18S, cols 7 to 12
      </span>
      <span className="flex items-center gap-1">{sw(FILL.ctrl)} Control</span>
      <span className="flex items-center gap-1">
        {sw(FILL.bac, 'border-2 border-[var(--pcr-group)]')}
        {sw(FILL.bacAlt, 'border-2 border-[var(--pcr-group)]')} one order per
        box
      </span>
      <span className="flex items-center gap-1">
        <i
          className={`inline-block h-0 w-0 border-[5px] border-transparent ${RED_CORNER}`}
        />
        priority, overdue or due today
      </span>
    </span>
  )
}

export default PcrPlateMap
