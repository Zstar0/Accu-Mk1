import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  targetDilutionOf,
  waterOf,
  type EndoForm,
} from '@/lib/endo-prep-2ml'
import type { EndoPrepRule } from '@/lib/endo-prep-rules'
import {
  endoPrepFor,
  shortLabDate,
  type WorksheetItemRow,
} from '@/lib/endo-worksheet'
import {
  allowedCartridges,
  endoCtxFor,
  endoRowsFor,
} from '@/lib/endo-worksheet-2ml'
import { useLabCalendar } from '@/hooks/use-lab-calendar'
import { worksheetPageKey } from '@/hooks/use-worksheet-drawer'
import { useEndoPrepRules } from '@/services/endo-prep-rules'

// Radix Select holds no empty value: Form Auto and the inherited cartridge
// ride on these and go out as null, as the blank option did.
const AUTO = '__auto__'
const INHERIT = '__inherit__'
// The line's bare look (borderless until hovered) on the app's Select.
const LINE_TRIGGER =
  'gap-1 rounded border-transparent bg-transparent px-1 py-0 text-[11px] text-foreground shadow-none data-[size=default]:h-6 hover:border-border focus-visible:border-teal-500 focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent dark:focus-visible:border-teal-400 disabled:cursor-default disabled:opacity-100 [&>svg]:size-3'

/**
 * The endotoxin bench line under a worksheet item on a MIXED worksheet (an
 * endo vial sharing a Microbiology worksheet with PCR or sterility work).
 * Endo-only worksheets are worked in EndoWorksheetTable on their own page.
 * Everything derived comes from the same code the printed bench sheets use,
 * so screen and paper always agree: src/lib/endo-prep.ts on a stock run,
 * src/lib/endo-prep-2ml.ts on a 2 mL run. The due date is the SLA engine's.
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
  // Handed the list payload: nothing is typed until the method lands, so a
  // standard is never judged against Dennis's defaults by mistake.
  const pending = worksheet?.endo_method === undefined && full === undefined
  // The allowed list when no method resolves, or the method links no
  // cartridges (4.3), as the page reads it.
  const { data: catalog = [] } = useQuery({
    queryKey: ['consumables', 'endo_cartridge'],
    queryFn: () => listConsumables({ kind: 'endo_cartridge' }),
    enabled: twoMl,
    staleTime: 5 * 60_000,
  })
  // A row that is not locked follows the live rules (slice 5), as on the page.
  const { data: rules = [] } = useEndoPrepRules(twoMl)
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
          rules={rules}
          disabled={isCompleted || pending}
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
 * The 2 mL prep on a mixed worksheet's endo line (spec 6.3, the same prep
 * inputs as Box 1): Weight, Form, Water and the row's cartridge as Box 1 has
 * them, Box 2's Total, and what they give, with the tube and cartridge
 * warnings. A mixed worksheet has no page, so this line is the only place to
 * set them. The figures come from src/lib/endo-prep-2ml.ts, as on the
 * worksheet page and the 2 mL sheet.
 */
export function EndoPrep2mlFields({
  item,
  worksheet,
  catalog,
  rules,
  disabled,
  onUpdate,
}: {
  item: WorksheetItemRow
  worksheet: WorksheetListItem
  catalog: ConsumableType[]
  /** The live rule lines (slice 5). */
  rules: EndoPrepRule[]
  /** A completed worksheet, or the run settings still loading. */
  disabled: boolean
  onUpdate: (data: WorksheetItemPatch) => void
}) {
  const ctx = endoCtxFor(worksheet, catalog)
  const [row] = endoRowsFor([item], worksheet, catalog, rules)
  if (!row) return null
  const s = row.sample
  const form = formOf(s)
  // What Auto resolves to: the form with no hand-set pick, not the pick.
  const autoForm = formOf({ ...s, form: null })
  const bac = form === 'bac'
  const k = prep2Check(s, ctx)
  const plan = dilutionPlan(s, ctx)
  // The row's total without one of its own: its rule's, else the method's.
  const defaultTotal =
    targetDilutionOf({ ...s, totalDilution: null }, ctx) ??
    ctx.params.stdTotalDilution
  const cartridges = allowedCartridges(worksheet, catalog)
  const own = item.cartridge_type_id ?? null
  const unlisted = own != null && !cartridges.some(c => c.id === own)

  // Box 2's rule: the row's default total is stored as null, and a total
  // already stored is not sent again. On a ruled row the method's standard
  // is a value of its own, which beats the rule.
  function commitTotal(v: number | null) {
    const next = v === defaultTotal ? null : v
    if (next === (item.prep_total_dilution ?? null)) return
    onUpdate({ prep_total_dilution: next })
  }

  return (
    <>
      {!bac && (
        <PrepField
          label="Weight"
          unit="mg"
          value={s.weightMg}
          overridden={item.prep_weight_mg != null}
          computed={item.declared_weight_mg ?? null}
          disabled={disabled}
          onCommit={v => onUpdate({ prep_weight_mg: v })}
        />
      )}
      <span className="inline-flex items-center gap-1">
        <span className="uppercase tracking-wider text-[9px] font-semibold">
          Form
        </span>
        <Select
          disabled={disabled}
          value={item.prep_form ?? AUTO}
          onValueChange={v => {
            const next = v === AUTO ? null : (v as EndoForm)
            // The water cell means a different thing per form: a bench
            // override for a lyophilized vial, the customer's own volume for
            // a liquid. A value typed under one is never carried into the
            // other (Dennis, 2026-10-19). Only the liquid-ness matters, so
            // naming the form the row already resolved to leaves it alone.
            const nowLiquid = (next ?? autoForm) === 'liquid'
            onUpdate(
              (form === 'liquid') !== nowLiquid && item.prep_water_ml != null
                ? { prep_form: next, prep_water_ml: null }
                : { prep_form: next }
            )
          }}
        >
          <SelectTrigger aria-label="Form" className={LINE_TRIGGER}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO}>
              {`Auto (${FORMS.find(f => f[0] === autoForm)?.[1] ?? autoForm})`}
            </SelectItem>
            {FORMS.map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
      {!bac && (
        <PrepField
          label="Water"
          unit="mL"
          value={waterOf(s, ctx)}
          overridden={item.prep_water_ml != null}
          computed={form === 'liquid' ? null : ctx.params.reconWaterMl}
          disabled={disabled}
          onCommit={v => onUpdate({ prep_water_ml: v })}
        />
      )}
      {!bac && (
        <PrepField
          label="Total"
          unit="1:N"
          value={item.prep_total_dilution ?? null}
          overridden={item.prep_total_dilution != null}
          computed={defaultTotal}
          disabled={disabled}
          onCommit={commitTotal}
        />
      )}
      <span className="inline-flex items-center gap-1">
        <span className="uppercase tracking-wider text-[9px] font-semibold">
          Cartridge
        </span>
        <Select
          value={own == null ? INHERIT : String(own)}
          disabled={disabled}
          onValueChange={v =>
            onUpdate({ cartridge_type_id: v === INHERIT ? null : Number(v) })
          }
        >
          <SelectTrigger
            aria-label="Cartridge for this sample"
            className={`${LINE_TRIGGER} font-mono ${own == null ? 'text-muted-foreground' : ''}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>
              {`${bac ? 'bac water' : row.ruleCartridge ? 'rule' : 'run'} (${row.inherited ? fmt(row.inherited.sensitivity) : '-'})`}
            </SelectItem>
            {unlisted && (
              <SelectItem value={String(own)}>
                {`${fmt(item.cartridge_sensitivity_eu_ml)} (not in the list)`}
              </SelectItem>
            )}
            {cartridges.map(c => (
              <SelectItem key={c.id} value={String(c.id)} title={c.name}>
                {fmt(c.sensitivity_eu_ml)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[9px]">EU/mL</span>
      </span>
      {bac ? (
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
