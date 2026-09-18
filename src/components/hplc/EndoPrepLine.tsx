import { useState } from 'react'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import type { WorksheetItemPatch } from '@/lib/api'
import { fmt, fmtUl, holidaysBetween, labDate } from '@/lib/endo-prep'
import {
  endoPrepFor,
  shortLabDate,
  type WorksheetItemRow,
} from '@/lib/endo-worksheet'
import { useLabCalendar } from '@/hooks/use-lab-calendar'

/**
 * The endotoxin bench line under a worksheet item on a MIXED worksheet (an
 * endo vial sharing a Microbiology worksheet with PCR or sterility work).
 * Endo-only worksheets render EndoWorksheetTable instead. Everything derived
 * comes from src/lib/endo-prep.ts, the same code the printed bench sheet
 * uses, so screen and paper always agree; the due date is the SLA engine's.
 */
interface EndoPrepLineProps {
  item: WorksheetItemRow
  isCompleted: boolean
  /** SLA `due_at` for this item, or null. */
  dueAt: string | null
  onUpdate: (data: WorksheetItemPatch) => void
}

export function EndoPrepLine({
  item,
  isCompleted,
  dueAt,
  onUpdate,
}: EndoPrepLineProps) {
  const { calendar } = useLabCalendar()
  const prep = endoPrepFor(item)
  const received = calendar ? labDate(item.date_received, calendar) : null
  const due = calendar ? labDate(dueAt, calendar) : null
  const skipped = calendar ? holidaysBetween(received, due, calendar) : []

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2 pl-[52px] text-[11px] text-muted-foreground">
      <Stat label="Received" value={shortLabDate(received)} />
      <Stat
        label="Due"
        value={`${shortLabDate(due)}${skipped.length ? '*' : ''}`}
        title={
          skipped.length
            ? `Pushed past ${skipped.map(h => h.name).join(', ')}`
            : undefined
        }
        strong
      />
      <EndoPrepFields
        item={item}
        prep={prep}
        isCompleted={isCompleted}
        onUpdate={onUpdate}
      />
      <Stat
        label="Sample"
        value={fmtUl(prep.sampleUl) || '—'}
        unit="µL"
        strong
      />
      <Stat label="LAL" value={fmtUl(prep.lalUl) || '—'} unit="µL" strong />
      {!prep.isWater && (
        <Stat label="Vial" value={fmt(prep.vialConc) || '—'} unit="mg/mL" />
      )}
      <EndoWarning warning={prep.warning} />
    </div>
  )
}

/** Weight + volume (or the bac-water dilution factor) as editable overrides. */
export function EndoPrepFields({
  item,
  prep,
  isCompleted,
  onUpdate,
}: {
  item: WorksheetItemRow
  prep: ReturnType<typeof endoPrepFor>
  isCompleted: boolean
  onUpdate: (data: WorksheetItemPatch) => void
}) {
  if (prep.isWater) {
    return (
      <PrepField
        label="Dilution"
        unit="×"
        value={prep.dilution}
        overridden={item.prep_dilution_factor != null}
        computed={20}
        disabled={isCompleted}
        onCommit={v => onUpdate({ prep_dilution_factor: v })}
      />
    )
  }
  return (
    <>
      <PrepField
        label="Weight"
        unit="mg"
        value={prep.weightMg}
        overridden={prep.weightOverridden}
        computed={item.declared_weight_mg ?? null}
        disabled={isCompleted}
        onCommit={v => onUpdate({ prep_weight_mg: v })}
      />
      <PrepField
        label="Volume"
        unit="mL"
        value={prep.volumeMl}
        overridden={prep.volumeOverridden}
        computed={prep.autoVolumeMl}
        disabled={isCompleted}
        onCommit={v => onUpdate({ prep_volume_ml: v })}
      />
    </>
  )
}

export function EndoWarning({
  warning,
}: {
  warning: 'over_cartridge' | 'no_diluent' | null
}) {
  if (warning === 'over_cartridge')
    return (
      <span className="rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-600">
        Won&apos;t fit the cartridge
      </span>
    )
  if (warning === 'no_diluent')
    return (
      <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600">
        No LAL diluent
      </span>
    )
  return null
}

function Stat({
  label,
  value,
  unit,
  strong,
  title,
}: {
  label: string
  value: string
  unit?: string
  strong?: boolean
  title?: string
}) {
  return (
    <span className="inline-flex items-baseline gap-1" title={title}>
      <span className="uppercase tracking-wider text-[9px] font-semibold">
        {label}
      </span>
      <span
        className={`font-mono tabular-nums ${strong ? 'text-foreground font-semibold' : ''}`}
      >
        {value}
      </span>
      {unit && <span className="text-[9px]">{unit}</span>}
    </span>
  )
}

/**
 * A number the analyst may override. Commits on blur or Enter, Escape
 * restores the draft, and the × next to an overridden value clears it back
 * to the computed figure (an explicit null on the wire). `bare` drops the
 * label and unit for use inside a table cell.
 */
export function PrepField({
  label,
  unit,
  value,
  overridden,
  computed,
  disabled,
  onCommit,
  bare,
}: {
  label: string
  unit: string
  value: number | null
  overridden: boolean
  computed: number | null
  disabled: boolean
  onCommit: (value: number | null) => void
  bare?: boolean
}) {
  const shown = value == null ? '' : fmt(value)
  const [draft, setDraft] = useState<string | null>(null)

  function commit() {
    if (draft === null) return
    const text = draft.trim()
    setDraft(null)
    if (text === '') {
      if (overridden) onCommit(null)
      return
    }
    const n = Number(text)
    if (!Number.isFinite(n) || n <= 0) return
    if (fmt(n) === shown) return
    onCommit(n)
  }

  if (disabled) {
    return bare ? (
      <span
        className="font-mono tabular-nums"
        title={overridden ? 'Entered by the analyst' : undefined}
      >
        {shown || '—'}
      </span>
    ) : (
      <Stat
        label={label}
        value={shown || '—'}
        unit={unit}
        title={overridden ? 'Entered by the analyst' : undefined}
      />
    )
  }

  return (
    <span className="inline-flex items-center gap-1">
      {!bare && (
        <span className="uppercase tracking-wider text-[9px] font-semibold">
          {label}
        </span>
      )}
      <Input
        type="number"
        inputMode="decimal"
        step="any"
        min={0}
        aria-label={`${label} (${unit})`}
        title={
          overridden
            ? `Entered by the analyst; computed ${computed == null ? '—' : fmt(computed)} ${unit}`
            : undefined
        }
        className={`h-6 w-16 px-1 text-[11px] font-mono tabular-nums ${overridden ? 'border-primary/60 text-foreground' : 'border-transparent bg-transparent shadow-none hover:border-border'}`}
        value={draft ?? shown}
        placeholder={computed == null ? '' : fmt(computed)}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setDraft(null)
        }}
      />
      {!bare && <span className="text-[9px]">{unit}</span>}
      {overridden && (
        <button
          type="button"
          className="h-4 w-4 inline-flex items-center justify-center rounded text-muted-foreground hover:text-destructive"
          aria-label={`Use the computed ${label.toLowerCase()}`}
          title="Back to the computed value"
          onClick={() => onCommit(null)}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

export default EndoPrepLine
