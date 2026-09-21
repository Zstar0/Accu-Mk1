/**
 * Glue between worksheet items and the endotoxin bench: which items are endo
 * work, their computed prep, and the bench-sheet document built from a
 * worksheet. Due dates arrive from the SLA engine (`due_at` on /sla/status)
 * keyed by item id; this module only reads them in lab time.
 * Spec: docs/superpowers/specs/2026-09-18-endo-worksheet-design.md
 */
import type { WorksheetListItem } from '@/lib/api'
import type { EndoSheetDoc, EndoSheetRow } from '@/lib/endo-bench-sheet'
import {
  calcEndoPrep,
  fmt,
  fmtUl,
  holidaysBetween,
  labDate,
  orderForBench,
  type EndoPrep,
  type LabCalendar,
} from '@/lib/endo-prep'
import { benchKindForItem } from '@/lib/worksheet-kind'
import type { WorksheetItemRow } from '@/lib/worksheet-sla-subjects'

export type { WorksheetItemRow }

export function isEndoWorksheetItem(
  item: Pick<WorksheetItemRow, 'assignment_role' | 'analyses'>
): boolean {
  return benchKindForItem(item) === 'endo'
}

export function endoPrepFor(item: WorksheetItemRow): EndoPrep {
  return calcEndoPrep({
    sampleId: item.sample_id,
    sampleType: item.sample_type,
    identity: endoIdentityFor(item),
    declaredWeightMg: item.declared_weight_mg,
    prepWeightMg: item.prep_weight_mg,
    prepVolumeMl: item.prep_volume_ml,
    prepDilutionFactor: item.prep_dilution_factor,
    prepTargetMgPerMl: item.prep_target_mg_ml,
  })
}

/** Identity for the sheet: the parent's analyte names, else the analyses' peptide names. */
export function endoIdentityFor(item: WorksheetItemRow): string {
  if (item.sample_identity) return item.sample_identity
  const names = new Set<string>()
  for (const a of item.analyses) if (a.peptide_name) names.add(a.peptide_name)
  return [...names].join(', ')
}

/** "Sep 16" from a YYYY-MM-DD lab date, without touching time zones. */
export function shortLabDate(iso: string | null): string {
  if (!iso) return '-'
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/** Order numbers show without the WP- prefix: the column is narrow and the
 *  bench only ever quotes the number. */
export function shortOrder(order: string | null | undefined): string {
  return (order ?? '').replace(/^WP-/i, '')
}

/** Due date (lab day) of an item from its SLA snapshot's `due_at`. */
export function endoDueFor(
  dueAt: string | null | undefined,
  cal: LabCalendar | null
): string | null {
  return cal ? labDate(dueAt, cal) : null
}

/** Endo items in bench order: due date, then priority, then the worksheet's own order. */
export function endoItemsInBenchOrder(
  items: WorksheetItemRow[],
  dueAtByItemId: Map<number, string | null>,
  cal: LabCalendar | null
): WorksheetItemRow[] {
  return orderForBench(items.filter(isEndoWorksheetItem), item => ({
    due: endoDueFor(dueAtByItemId.get(item.id), cal),
    priority: item.priority,
  }))
}

export interface EndoSheetOptions {
  analystName: string
  calendar: LabCalendar | null
  printedAt: string
  /** SLA `due_at` per item id (null when the item has no received date). */
  dueAtByItemId: Map<number, string | null>
}

/**
 * The bench-sheet document for a worksheet: its endo items in bench order,
 * each with the prep worked out. Without a calendar the dates are blank
 * rather than wrong.
 */
export function buildEndoSheetDoc(
  ws: WorksheetListItem,
  opts: EndoSheetOptions
): EndoSheetDoc {
  const cal = opts.calendar
  const holidays = new Map<string, string>()
  const orders = new Set<string>()
  const rows: EndoSheetRow[] = endoItemsInBenchOrder(
    ws.items,
    opts.dueAtByItemId,
    cal
  ).map(item => {
    const prep = endoPrepFor(item)
    const received = cal ? labDate(item.date_received, cal) : null
    const due = endoDueFor(opts.dueAtByItemId.get(item.id), cal)
    const skipped = cal ? holidaysBetween(received, due, cal) : []
    for (const h of skipped) holidays.set(h.iso, h.name)
    const order = shortOrder(item.client_order_number)
    if (order) orders.add(order)
    return {
      due,
      dueHoliday: skipped.length > 0,
      priority: item.priority,
      order,
      sampleId: item.sample_id,
      identity: endoIdentityFor(item),
      received,
      weightMg: fmt(prep.weightMg),
      volumeMl: fmt(prep.volumeMl),
      dilution: prep.dilution,
      sampleUl: fmtUl(prep.sampleUl),
      lalUl: fmtUl(prep.lalUl),
      vialConc: fmt(prep.vialConc),
    }
  })
  return {
    title: ws.title,
    runName: `worksheet ${ws.id}`,
    analyst: opts.analystName,
    dateMade: (cal ? labDate(ws.created_at, cal) : null) ?? '',
    orders: [...orders].join(', '),
    printedAt: opts.printedAt,
    rows,
    holidayNotes: [...holidays].map(([iso, name]) => ({ iso, name })),
  }
}
