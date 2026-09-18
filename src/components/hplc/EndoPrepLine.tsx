import { useState } from 'react'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import type { WorksheetItemPatch } from '@/lib/api'
import { endoDueDate, fmt, fmtUl, labDate } from '@/lib/endo-prep'
import { endoPrepFor, type WorksheetItemRow } from '@/lib/endo-worksheet'
import { useLabCalendar } from '@/hooks/use-lab-calendar'

/**
 * The endotoxin bench line under a worksheet item: received, due, the weight
 * and reconstitution volume (both editable overrides), and the figures the
 * analyst pipettes. Everything derived comes from src/lib/endo-prep.ts, the
 * same code the printed bench sheet uses, so screen and paper always agree.
 */
interface EndoPrepLineProps {
  item: WorksheetItemRow
  isCompleted: boolean
  onUpdate: (data: WorksheetItemPatch) => void
}

function shortDate(iso: string | null): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function EndoPrepLine({
  item,
  isCompleted,
  onUpdate,
}: EndoPrepLineProps) {
  const { calendar } = useLabCalendar()
  const prep = endoPrepFor(item)
  const due = calendar ? endoDueDate(item.date_received, calendar) : null
  const received = calendar ? labDate(item.date_received, calendar) : null
  const holidayTitle = due?.holidaysSkipped.length
    ? `Pushed past ${due.holidaysSkipped.map(h => h.name).join(', ')}`
    : undefined

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2 pl-[52px] text-[11px] text-muted-foreground">
      <Stat label="Received" value={shortDate(received)} />
      <Stat
        label="Due"
        value={`${shortDate(due?.iso ?? null)}${due?.holidaysSkipped.length ? '*' : ''}`}
        title={holidayTitle}
        strong
      />
      {prep.isWater ? (
        <PrepField
          label="Dilution"
          unit="×"
          value={prep.dilution}
          overridden={item.prep_dilution_factor != null}
          computed={20}
          disabled={isCompleted}
          onCommit={v => onUpdate({ prep_dilution_factor: v })}
        />
      ) : (
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
      )}
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
      {prep.warning === 'over_cartridge' && (
        <span className="rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-600">
          Won&apos;t fit the cartridge
        </span>
      )}
      {prep.warning === 'no_diluent' && (
        <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600">
          No LAL diluent
        </span>
      )}
    </div>
  )
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
 * to the computed figure (an explicit null on the wire).
 */
function PrepField({
  label,
  unit,
  value,
  overridden,
  computed,
  disabled,
  onCommit,
}: {
  label: string
  unit: string
  value: number | null
  overridden: boolean
  computed: number | null
  disabled: boolean
  onCommit: (value: number | null) => void
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
    return (
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
      <span className="uppercase tracking-wider text-[9px] font-semibold">
        {label}
      </span>
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
      <span className="text-[9px]">{unit}</span>
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
