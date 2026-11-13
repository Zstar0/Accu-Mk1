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
import {
  STEP2_SUB,
  STEP2_TITLE,
  STEP3_SUB,
  STEP3_TITLE,
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
  /** Task 9's promote control. */
  onPromote?: (itemId: number) => void
  /** A column after Step 2's last (Task 9's promote control). */
  step2Trailing?: { header: ReactNode; cell: (v: SheetRowView) => ReactNode }
}

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

/** The step sections in the source's order; Task 8 adds Step 2b after
 *  Step 2 and Step 3a before Step 3. */
const SECTIONS: {
  step: string
  title: string
  sub: string
  Table: ComponentType<SheetSectionProps>
}[] = [
  { step: 'Step 2', title: STEP2_TITLE, sub: STEP2_SUB, Table: HplcStockTable },
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
  const { sheet, rules, readOnly } = props
  const rowViews = useMemo(
    () => sheetRowViews(sheet, rules, readOnly),
    [sheet, rules, readOnly]
  )
  return (
    <div className="space-y-6">
      <WarningsPanel views={rowViews} />
      {SECTIONS.map(({ step, title, sub, Table }) => (
        <Section key={step} step={step} title={title} sub={sub}>
          <Table {...props} rowViews={rowViews} />
        </Section>
      ))}
    </div>
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
  sub,
  children,
}: {
  step: string
  title: string
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
        </h3>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}

export default HplcPrepSheet
