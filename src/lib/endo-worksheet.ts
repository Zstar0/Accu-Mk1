/**
 * Glue between worksheet items and the endotoxin bench: which items are endo
 * work, their computed prep, and the bench-sheet document built from a
 * worksheet. Spec: docs/superpowers/specs/2026-09-18-endo-worksheet-design.md
 */
import type { WorksheetListItem } from '@/lib/api'
import type { EndoSheetDoc, EndoSheetRow } from '@/lib/endo-bench-sheet'
import {
  calcEndoPrep,
  endoDueDate,
  fmt,
  fmtUl,
  labDate,
  orderForBench,
  type EndoPrep,
  type LabCalendar,
} from '@/lib/endo-prep'

export type WorksheetItemRow = WorksheetListItem['items'][number]

/** Endo vials by catalog role, or any item whose analyses are endotoxin
 *  (legacy "<order> E" worksheets hold parent ids with an ENDO-LAL line). */
export function isEndoWorksheetItem(
  item: Pick<WorksheetItemRow, 'assignment_role' | 'analyses'>
): boolean {
  const role = item.assignment_role ?? ''
  if (role === 'endo' || role === 'endo85') return true
  return item.analyses.some(a => a.keyword != null && /ENDO/i.test(a.keyword))
}

export function endoPrepFor(item: WorksheetItemRow): EndoPrep {
  return calcEndoPrep({
    sampleId: item.sample_id,
    sampleType: item.sample_type,
    declaredWeightMg: item.declared_weight_mg,
    prepWeightMg: item.prep_weight_mg,
    prepVolumeMl: item.prep_volume_ml,
    prepDilutionFactor: item.prep_dilution_factor,
  })
}

/** Identity for the sheet: the parent's analyte names, else the analyses' peptide names. */
export function endoIdentityFor(item: WorksheetItemRow): string {
  if (item.sample_identity) return item.sample_identity
  const names = new Set<string>()
  for (const a of item.analyses) if (a.peptide_name) names.add(a.peptide_name)
  return [...names].join(', ')
}

/** Order numbers print without the WP- prefix: the column is narrow and the
 *  bench only ever quotes the number. */
function shortOrder(order: string | null | undefined): string {
  return (order ?? '').replace(/^WP-/i, '')
}

export interface EndoSheetOptions {
  analystName: string
  calendar: LabCalendar | null
  printedAt: string
}

/**
 * The bench-sheet document for a worksheet: its endo items in bench order
 * (due date, then priority, then the worksheet's own order), each with the
 * prep worked out. Without a calendar the due dates are blank rather than
 * wrong.
 */
export function buildEndoSheetDoc(
  ws: WorksheetListItem,
  opts: EndoSheetOptions
): EndoSheetDoc {
  const cal = opts.calendar
  const withDue = ws.items.filter(isEndoWorksheetItem).map(item => ({
    item,
    due: cal ? endoDueDate(item.date_received, cal) : null,
  }))
  const ordered = orderForBench(withDue, x => ({
    due: x.due?.iso ?? null,
    priority: x.item.priority,
  }))
  const holidays = new Map<string, string>()
  const orders = new Set<string>()
  const rows: EndoSheetRow[] = ordered.map(({ item, due }) => {
    const prep = endoPrepFor(item)
    for (const h of due?.holidaysSkipped ?? []) holidays.set(h.iso, h.name)
    const order = shortOrder(item.client_order_number)
    if (order) orders.add(order)
    return {
      due: due?.iso ?? null,
      dueHoliday: (due?.holidaysSkipped.length ?? 0) > 0,
      priority: item.priority,
      order,
      sampleId: item.sample_id,
      identity: endoIdentityFor(item),
      received: cal ? labDate(item.date_received, cal) : null,
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
