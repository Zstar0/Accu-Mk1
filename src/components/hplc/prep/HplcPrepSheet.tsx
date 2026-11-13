import { useMemo, type ComponentType, type ReactNode } from 'react'
import type {
  HplcRowPatch,
  HplcSheet,
  HplcSheetRow,
  Instrument,
} from '@/lib/api'
import { computeRow, type HplcRowComputed } from '@/lib/hplc-prep'
import type { HplcPrepRule } from '@/lib/hplc-prep-rules'
import { HplcStockTable } from './HplcStockTable'
import { HplcDilutionTable } from './HplcDilutionTable'
import { HplcBlendTable } from './HplcBlendTable'
import { HplcIntermediateTable } from './HplcIntermediateTable'
import { SheetSavesContext, type SheetSaves } from './HplcSheetCells'
import {
  STEP2_SUB,
  STEP2_TITLE,
  STEP2B_NOTE,
  STEP2B_SUB,
  STEP2B_TITLE,
  STEP3_SUB,
  STEP3_TITLE,
  STEP3A_NOTE,
  STEP3A_SUB,
  STEP3A_TITLE,
} from './hplc-sheet-columns'

/** One row as the sheet shows it: its facts, what computeRow made of them
 *  (null when the row cannot be planned), and whether it can be edited. */
export interface SheetRowView {
  row: HplcSheetRow
  computed: HplcRowComputed | null
  locked: boolean
  /** On another instrument than the first one found on the sheet: shaded,
   *  as the source shades its 1290B rows. */
  shaded: boolean
}

export interface HplcPrepSheetProps {
  sheet: HplcSheet
  rules: HplcPrepRule[]
  readOnly: boolean
  instruments: Pick<Instrument, 'id' | 'name'>[]
  /** One cell's merge patch; `what` names the box ("<sample id>, <column>"). */
  onPatch: (itemId: number, patch: HplcRowPatch, what: string) => void
  onSetInstrument: (
    itemId: number,
    instrumentId: number | null,
    what: string
  ) => void
  /** A column after Step 2's last (the Sample prep column). */
  step2Trailing?: { header: string; cell: (v: SheetRowView) => ReactNode }
  /** A box refused a number the server would refuse (`reason`), or holds
   *  one it takes again (null); `what` names it, `key` is its boxKey. */
  onNumberRefused?: SheetSaves['refused']
  /** The boxes whose save did not land, by boxKey, with the failure
   *  sentence: each is marked until it saves or is dismissed. */
  failed?: ReadonlyMap<string, string>
}

const NONE_FAILED: ReadonlyMap<string, string> = new Map()

/** What every step table takes. */
export type SheetSectionProps = HplcPrepSheetProps & {
  rowViews: SheetRowView[]
}

/** computeRow throws on a row with a form and no components; a rider (a
 *  fentanyl vial) has no prep of its own. */
const plannable = (row: HplcSheetRow) =>
  row.form !== null && row.components.length > 0 && !row.rider_only

// Task 8's Step 2b and 3a tables read the same rows; Fast Refresh on this
// file only.
// eslint-disable-next-line react-refresh/only-export-components
export function sheetRowViews(
  sheet: HplcSheet,
  rules: HplcPrepRule[],
  readOnly: boolean
): SheetRowView[] {
  const first = sheet.rows.find(r => r.instrument_id !== null)?.instrument_id
  return sheet.rows.map(row => ({
    row,
    computed: plannable(row)
      ? computeRow(row, row.hplc_prep, rules, row.params)
      : null,
    locked: readOnly || row.promoted,
    shaded: row.instrument_id !== null && row.instrument_id !== first,
  }))
}

/** The step sections in the source's order; Step 2b and Step 3a show only
 *  when a row on the sheet needs them. */
const SECTIONS: {
  step: string
  title: string
  note?: string
  sub: string
  Table: ComponentType<SheetSectionProps>
  show?: (views: SheetRowView[]) => boolean
}[] = [
  { step: 'Step 2', title: STEP2_TITLE, sub: STEP2_SUB, Table: HplcStockTable },
  {
    step: 'Step 2b',
    title: STEP2B_TITLE,
    note: STEP2B_NOTE,
    sub: STEP2B_SUB,
    Table: HplcBlendTable,
    // the same rows HplcBlendTable lists
    show: views => views.some(v => v.row.is_blend && !v.row.rider_only),
  },
  {
    step: 'Step 3a',
    title: STEP3A_TITLE,
    note: STEP3A_NOTE,
    sub: STEP3A_SUB,
    Table: HplcIntermediateTable,
    show: views =>
      views.some(v => v.computed?.vials.some(x => x.intermediate !== null)),
  },
  {
    step: 'Step 3',
    title: STEP3_TITLE,
    sub: STEP3_SUB,
    Table: HplcDilutionTable,
  },
]

/**
 * The HPLC prep sheet: the warnings, then the step sections. Presentational:
 * every figure comes from computeRow, every edit goes out through onPatch
 * (one merge patch per cell) or onSetInstrument.
 */
export function HplcPrepSheet(props: HplcPrepSheetProps) {
  const { sheet, rules, readOnly, onNumberRefused } = props
  const failed = props.failed ?? NONE_FAILED
  const rowViews = useMemo(
    () => sheetRowViews(sheet, rules, readOnly),
    [sheet, rules, readOnly]
  )
  const saves = useMemo(
    () => ({ refused: onNumberRefused, failed }),
    [onNumberRefused, failed]
  )
  return (
    <SheetSavesContext.Provider value={saves}>
      <div className="space-y-6">
        <WarningsPanel views={rowViews} />
        {SECTIONS.filter(s => !s.show || s.show(rowViews)).map(
          ({ step, title, note, sub, Table }) => (
            <Section key={step} step={step} title={title} note={note} sub={sub}>
              <Table {...props} rowViews={rowViews} />
            </Section>
          )
        )}
      </div>
    </SheetSavesContext.Provider>
  )
}

function WarningsPanel({ views }: { views: SheetRowView[] }) {
  const lines = views.flatMap(v =>
    (v.computed?.warnings ?? []).map(w => `${v.row.sample_id}: ${w.text}`)
  )
  if (!lines.length) return null
  return (
    <section
      aria-label="Warnings"
      className="rounded-[5px] border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-800 dark:text-amber-200"
    >
      <ul className="list-disc space-y-1 pl-4">
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </section>
  )
}

function Section({
  step,
  title,
  note,
  sub,
  children,
}: {
  step: string
  title: string
  note?: string
  sub: string
  children: ReactNode
}) {
  return (
    <section
      aria-label={`${step} ${title}`}
      className="overflow-hidden rounded-[5px] border bg-card shadow-sm"
    >
      <div className="border-b px-4 py-3">
        <h3 className="text-[15px] font-semibold">
          <span className="mr-2 text-teal-600 dark:text-teal-400">{step}</span>
          {title}
          {note && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {note}
            </span>
          )}
        </h3>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
      {/* the sticky Sample ID column is about 7rem wide ("P-0120-S01 A" in
          12.5px mono plus the cell padding): a box the walk scrolls to is
          kept clear of it */}
      <div className="overflow-x-auto scroll-pl-28">{children}</div>
    </section>
  )
}

export default HplcPrepSheet
