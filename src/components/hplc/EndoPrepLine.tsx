import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  getWorksheet,
  listConsumables,
  type ConsumableType,
  type WorksheetItemPatch,
  type WorksheetListItem,
} from '@/lib/api'
import { fmt, fmtUl, holidaysBetween, labDate } from '@/lib/endo-prep'
import {
  FORMS,
  dilutionPlan,
  fmtConc,
  formOf,
  prep2Check,
  type EndoForm,
} from '@/lib/endo-prep-2ml'
import {
  endoPrepFor,
  shortLabDate,
  type WorksheetItemRow,
} from '@/lib/endo-worksheet'
import { endoCtxFor, endoSampleFor } from '@/lib/endo-worksheet-2ml'
import { useLabCalendar } from '@/hooks/use-lab-calendar'
import { worksheetPageKey } from '@/hooks/use-worksheet-drawer'

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
  /** The worksheet the item is on. On a 2 mL worksheet the line shows the
   *  2 mL prep (spec 6.3); without it, or on stock, the stock line. */
  worksheet?: WorksheetListItem
}

export function EndoPrepLine({
  item,
  isCompleted,
  dueAt,
  onUpdate,
  worksheet,
}: EndoPrepLineProps) {
  const { calendar } = useLabCalendar()
  const twoMl = worksheet?.endo_prep === '2ml'
  // The list payload has no endo_method; the 2 mL figures need the run's
  // method and cartridges, which only GET /worksheets/{id} carries.
  const { data: full } = useQuery({
    queryKey: worksheetPageKey(worksheet?.id ?? 0),
    queryFn: () => getWorksheet(worksheet?.id ?? 0),
    enabled: twoMl && worksheet?.endo_method === undefined,
    staleTime: 30_000,
  })
  const runWs = full ?? worksheet
  // With no method resolved, every active endo cartridge is allowed (4.3).
  const { data: catalog = [] } = useQuery({
    queryKey: ['consumables', 'endo_cartridge'],
    queryFn: () => listConsumables({ kind: 'endo_cartridge' }),
    enabled: twoMl && runWs?.endo_method === null,
    staleTime: 5 * 60_000,
  })
  const prep = endoPrepFor(item)
  const received = calendar ? labDate(item.date_received, calendar) : null
  const due = calendar ? labDate(dueAt, calendar) : null
  const skipped = calendar ? holidaysBetween(received, due, calendar) : []

  if (twoMl && runWs) {
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
        <EndoPrep2mlFields
          item={item}
          worksheet={runWs}
          catalog={catalog}
          isCompleted={isCompleted}
          onUpdate={onUpdate}
        />
      </div>
    )
  }

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
        value={fmtUl(prep.sampleUl) || '-'}
        unit="µL"
        strong
      />
      <Stat label="LAL" value={fmtUl(prep.lalUl) || '-'} unit="µL" strong />
      {!prep.isWater && (
        <Stat label="Vial" value={fmt(prep.vialConc) || '-'} unit="mg/mL" />
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

/**
 * The 2 mL prep on a mixed worksheet's endo line (spec 6.3): Box 1's prep
 * inputs (Weight, Form, Water) and Box 2's Total, what they give, the row's
 * cartridge and what lands on it, with the tube and cartridge warnings. A
 * mixed worksheet has no page, so this line is the only place to edit them.
 * The figures come from
 * src/lib/endo-prep-2ml.ts, as on the worksheet page and the 2 mL sheet. The
 * row's cartridge is shown, not picked (the picker is on the worksheet page).
 */
export function EndoPrep2mlFields({
  item,
  worksheet,
  catalog,
  isCompleted,
  onUpdate,
}: {
  item: WorksheetItemRow
  worksheet: WorksheetListItem
  catalog: ConsumableType[]
  isCompleted: boolean
  onUpdate: (data: WorksheetItemPatch) => void
}) {
  const ctx = endoCtxFor(worksheet, catalog)
  const s = endoSampleFor(item, worksheet, catalog)
  const form = formOf(s)
  const k = prep2Check(s, ctx)
  const plan = dilutionPlan(s, ctx)
  const stdTotal = ctx.params.stdTotalDilution
  return (
    <>
      {form !== 'bac' && (
        <PrepField
          label="Weight"
          unit="mg"
          value={s.weightMg}
          overridden={item.prep_weight_mg != null}
          computed={item.declared_weight_mg ?? null}
          disabled={isCompleted}
          onCommit={v => onUpdate({ prep_weight_mg: v })}
        />
      )}
      <span className="inline-flex items-center gap-1">
        <span className="uppercase tracking-wider text-[9px] font-semibold">
          Form
        </span>
        <select
          aria-label="Form"
          disabled={isCompleted}
          value={item.prep_form ?? ''}
          onChange={e =>
            onUpdate({
              prep_form: (e.target.value || null) as EndoForm | null,
            })
          }
          className="h-6 rounded border border-transparent bg-transparent px-1 text-[11px] text-foreground hover:border-border focus:border-teal-500 focus:outline-none disabled:opacity-100 dark:focus:border-teal-400"
        >
          <option value="">
            {`Auto (${FORMS.find(f => f[0] === form)?.[1] ?? form})`}
          </option>
          {FORMS.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </span>
      {form !== 'bac' && (
        <PrepField
          label="Water"
          unit="mL"
          value={item.prep_water_ml ?? null}
          overridden={item.prep_water_ml != null}
          computed={form === 'liquid' ? null : ctx.params.reconWaterMl}
          disabled={isCompleted}
          onCommit={v => onUpdate({ prep_water_ml: v })}
        />
      )}
      {form !== 'bac' && (
        <PrepField
          label="Total"
          unit="1:N"
          value={item.prep_total_dilution ?? null}
          overridden={item.prep_total_dilution != null}
          computed={stdTotal}
          disabled={isCompleted}
          onCommit={v =>
            onUpdate({ prep_total_dilution: v === stdTotal ? null : v })
          }
        />
      )}
      <Stat
        label="Cartridge"
        value={s.lambda === null ? '-' : fmt(s.lambda)}
        unit="EU/mL"
        strong
      />
      {form === 'bac' ? (
        <Stat label="Dilution" value={`1:${fmt(plan.total)}`} />
      ) : (
        <Stat label="Loaded" value={fmtConc(k.loaded) || '-'} unit="mg/mL" />
      )}
      {!plan.fits && (
        <span className="rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:border-red-400/45 dark:bg-red-400/15 dark:text-red-400">
          Over the 1.5 mL tube
        </span>
      )}
      {k.valid === false && (
        <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:border-amber-400/45 dark:bg-amber-400/15 dark:text-amber-400">
          {k.needs !== null
            ? `Needs the ${fmt(k.needs)} cartridge`
            : 'No cartridge holds this'}
        </span>
      )}
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
  // These figures drive what gets pipetted, so an entry that was refused
  // ("1,5", "0", stray text) must not quietly snap back to the old number:
  // it stays in the cell, marked, until it is corrected or Escape is pressed.
  const [rejected, setRejected] = useState(false)

  function commit() {
    if (draft === null) return
    const text = draft.trim()
    if (text === '') {
      setDraft(null)
      setRejected(false)
      if (overridden) onCommit(null)
      return
    }
    const n = Number(text)
    if (!Number.isFinite(n) || n <= 0) {
      setRejected(true)
      return
    }
    setDraft(null)
    setRejected(false)
    if (fmt(n) === shown) return
    onCommit(n)
  }
  function cancel() {
    setDraft(null)
    setRejected(false)
  }

  if (disabled) {
    return bare ? (
      <span
        className="font-mono tabular-nums"
        title={overridden ? 'Entered by the analyst' : undefined}
      >
        {shown || '-'}
      </span>
    ) : (
      <Stat
        label={label}
        value={shown || '-'}
        unit={unit}
        title={overridden ? 'Entered by the analyst' : undefined}
      />
    )
  }

  if (bare) {
    // Dennis's cell: borderless until hovered or focused, a dot when the
    // value was set by hand; emptying the cell goes back to the computed one.
    return (
      <span className="relative block">
        <input
          type="text"
          inputMode="decimal"
          aria-label={`${label} (${unit})`}
          aria-invalid={rejected || undefined}
          title={
            rejected
              ? `Not a number above zero: "${draft ?? ''}" was not saved. Fix it, or press Escape to go back.`
              : overridden
                ? `Set by hand. Computed: ${computed == null ? '-' : fmt(computed)} ${unit}. Clear the cell to use it.`
                : undefined
          }
          className={`h-7 w-full rounded-[3px] border bg-transparent px-1.5 text-right font-mono text-[12.5px] tabular-nums placeholder:text-muted-foreground/50 focus:bg-background focus:outline-none focus:ring-2 ${rejected ? 'border-red-500 bg-red-500/10 text-red-600 focus:ring-red-500/25' : 'border-transparent text-foreground hover:border-border focus:border-teal-500 focus:ring-teal-500/20'}`}
          value={draft ?? shown}
          placeholder={computed == null ? '' : fmt(computed)}
          onChange={e => {
            setDraft(e.target.value)
            setRejected(false)
          }}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') cancel()
          }}
        />
        {overridden && (
          <i className="pointer-events-none absolute right-0.5 top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-teal-500" />
        )}
      </span>
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
        aria-invalid={rejected || undefined}
        title={
          rejected
            ? `Not a number above zero: "${draft ?? ''}" was not saved. Fix it, or press Escape to go back.`
            : overridden
              ? `Entered by the analyst; computed ${computed == null ? '-' : fmt(computed)} ${unit}`
              : undefined
        }
        className={`h-6 w-16 px-1 text-[11px] font-mono tabular-nums ${rejected ? 'border-red-500 bg-red-500/10 text-red-600' : overridden ? 'border-primary/60 text-foreground' : 'border-transparent bg-transparent shadow-none hover:border-border'}`}
        value={draft ?? shown}
        placeholder={computed == null ? '' : fmt(computed)}
        onChange={e => {
          setDraft(e.target.value)
          setRejected(false)
        }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') cancel()
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
