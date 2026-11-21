import { useState, type CSSProperties } from 'react'
import { Lock, Move, Unlock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  applyWellMoves,
  fillGaps,
  hasGaps,
  NO_PINS,
  planWellMove,
  plateGrid,
  posOf,
  PROTOCOL,
  type PcrLayout,
  type PcrPins,
  type PcrPlate,
} from '@/lib/pcr-plate'
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
 *
 * Rearrange (Dennis, 2026-10-26; in Mk1 since 2026-11-20): until the plate is
 * printed, wells can be moved by hand. Select wells, then drag one or click
 * an empty well; the selection shifts together, the well it left stays empty
 * and every other well is held where it was. Fill gaps packs the plate again
 * and Reset layout forgets every hand placement. The rules live in
 * pcr-plate.ts (planWellMove, applyWellMoves, fillGaps).
 */
export function PcrPlateMap({
  plate,
  plateCount,
  outlineGroups,
  frozenCount,
  isCompleted,
  onUnfreeze,
  layout,
  onPins,
}: {
  plate: PcrPlate
  plateCount: number
  outlineGroups: boolean
  /** Locked wells across the run (the badge is per run, not per plate). */
  frozenCount: number
  isCompleted: boolean
  onUnfreeze: () => void
  /** The whole run's layout: a move holds every plate's wells. */
  layout: PcrLayout
  /** Save new hand placements; absent where the plate is read-only. */
  onPins?: (pins: PcrPins) => void
}) {
  const [arranging, setArranging] = useState(false)
  const [sel, setSel] = useState<number[]>([])
  const [hover, setHover] = useState<number | null>(null)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const locked = frozenCount > 0
  const active = arranging && !!onPins && !locked
  const anchorOf = () => dragFrom ?? Math.min(...sel)
  // Where the selection would land if dropped on the hovered well.
  const preview =
    active && sel.length && hover !== null
      ? {
          ok: planWellMove(layout, plate.plate, sel, hover, anchorOf()).ok,
          wells: new Set(sel.map(p => p + hover - anchorOf())),
        }
      : null
  function stop() {
    setArranging(false)
    setSel([])
    setHover(null)
    setDragFrom(null)
    setNote('')
  }
  function drop(toPos: number) {
    if (!onPins || !sel.length) return
    const plan = planWellMove(layout, plate.plate, sel, toPos, anchorOf())
    setDragFrom(null)
    if (!plan.ok) {
      setNote(plan.reason)
      return
    }
    setNote('')
    setSel([])
    setHover(null)
    if (plan.moves.some(m => m.from !== m.to))
      onPins(applyWellMoves(layout, plate.plate, plan.moves))
  }
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
        {onPins && !locked && layout.pinnedCount > 0 && hasGaps(plate) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            title="Close the empty wells: the samples keep the order they are in now and the NPC goes back after the last one."
            onClick={() => onPins(fillGaps(layout))}
          >
            Fill gaps
          </Button>
        )}
        {onPins && !locked && layout.pinnedCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            title="Forget every well placed by hand and deal the plate by the samples list again."
            onClick={() => {
              stop()
              onPins(NO_PINS)
            }}
          >
            Reset layout
          </Button>
        )}
        {onPins && (
          <Button
            variant={active ? 'default' : 'outline'}
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            disabled={locked}
            title={
              locked
                ? 'This plate is printed, so its wells are locked. Unlock wells to move any.'
                : 'Move wells by hand: click wells to select them, then drag one or click an empty well.'
            }
            onClick={() => (active ? stop() : setArranging(true))}
          >
            <Move className="h-3 w-3" />
            {active ? 'Done rearranging' : 'Rearrange'}
          </Button>
        )}
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
      {active && (
        <p
          role="status"
          className={`border-b px-3.5 py-1.5 text-xs ${note ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground'}`}
        >
          {note ||
            (sel.length
              ? 'Drag a selected well, or click an empty well: the lowest selected well lands there.'
              : 'Click wells to select them. A sample selects both of its wells.')}
        </p>
      )}
      <div className="overflow-x-auto p-3" onMouseLeave={() => setHover(null)}>
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
                  const pos = posOf(r, c, layout.kind) ?? -1
                  // An inset ring, so the order outlines (borders) stay as they are.
                  const ring: CSSProperties | undefined = !active
                    ? undefined
                    : preview?.wells.has(pos)
                      ? {
                          boxShadow: `inset 0 0 0 3px ${preview.ok ? '#10b981' : '#dc2626'}`,
                        }
                      : sel.includes(pos)
                        ? { boxShadow: 'inset 0 0 0 3px #f59e0b' }
                        : undefined
                  const arrange = active
                    ? {
                        onMouseEnter: () => setHover(pos),
                        onDragOver: (e: React.DragEvent) => {
                          e.preventDefault()
                          setHover(pos)
                        },
                        onDrop: (e: React.DragEvent) => {
                          e.preventDefault()
                          drop(pos)
                        },
                      }
                    : {}
                  if (!cell)
                    return (
                      <td
                        key={c}
                        className={`${base} ${FILL.empty} ${active && sel.length ? 'cursor-copy' : ''}`}
                        style={ring}
                        {...arrange}
                        onClick={active ? () => drop(pos) : undefined}
                      />
                    )
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
                    p.pinned ? 'Placed by hand' : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <td
                      key={c}
                      className={`${base} ${fill} ${active ? 'cursor-grab select-none' : p.sample ? 'cursor-pointer hover:brightness-95 dark:hover:brightness-125' : ''}`}
                      style={{ ...edges, ...ring }}
                      title={title}
                      {...arrange}
                      draggable={active}
                      onDragStart={
                        active
                          ? e => {
                              e.dataTransfer.effectAllowed = 'move'
                              e.dataTransfer.setData('text/plain', String(pos))
                              setDragFrom(pos)
                              setNote('')
                              if (!sel.includes(pos)) setSel([pos])
                            }
                          : undefined
                      }
                      onDragEnd={active ? () => setDragFrom(null) : undefined}
                      onClick={
                        active
                          ? () => {
                              setNote('')
                              setSel(
                                sel.includes(pos)
                                  ? sel.filter(x => x !== pos)
                                  : [...sel, pos]
                              )
                            }
                          : p.sample
                            ? () => useUIStore.getState().navigateToSample(p.id)
                            : undefined
                      }
                    >
                      {p.pinned && (
                        <span
                          aria-hidden
                          className="absolute left-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-blue-600 dark:bg-blue-400"
                        />
                      )}
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
