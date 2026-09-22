/**
 * Glue between worksheet items and the PCR bench: which items are PCR work,
 * the run's settings, the samples the plate builder lays out, and the run
 * document the screen, the printed sheet and the exports all build from.
 * Due dates arrive from the SLA engine (`due_at` on /sla/status) keyed by
 * item id, as on the endo sheet.
 * Spec: docs/superpowers/specs/2026-09-22-pcr-worksheet-design.md
 */
import type { WorksheetListItem } from '@/lib/api'
import { labDate, type LabCalendar } from '@/lib/endo-prep'
import {
  endoIdentityFor,
  shortOrder,
  type WorksheetItemRow,
} from '@/lib/endo-worksheet'
import {
  assess,
  DEFAULT_OVERAGE,
  layoutPlates,
  summarize,
  type PcrLayout,
  type PcrRunMeta,
  type PcrSample,
  type PcrSummary,
} from '@/lib/pcr-plate'
import { benchKindForItem } from '@/lib/worksheet-kind'

export type { WorksheetItemRow }

export function isPcrWorksheetItem(
  item: Pick<WorksheetItemRow, 'assignment_role' | 'analyses'>
): boolean {
  return benchKindForItem(item) === 'pcr'
}

/** The well shows the base id: a vial suffix carries no meaning at the bench
 *  (Dennis, 2026-09-16). The full id stays in the list and every export. */
export function plateLabel(id: string): string {
  return id.replace(/-S\d+$/i, '')
}

export interface PcrConfig {
  overage: number
  curve: string
  plateType: string
  sortByOrder: boolean
}

export const DEFAULT_PCR_CONFIG: PcrConfig = {
  overage: DEFAULT_OVERAGE,
  curve: '',
  plateType: '',
  sortByOrder: true,
}

/** The run's settings from worksheets.bench_config (free-form JSON shared by
 *  every bench kind); anything missing or malformed falls back to the default. */
export function pcrConfigOf(
  ws: Pick<WorksheetListItem, 'bench_config'>
): PcrConfig {
  const c = (ws.bench_config ?? {}) as Record<string, unknown>
  const overage = Number(c.overage)
  return {
    overage:
      Number.isFinite(overage) && overage > 0 ? overage : DEFAULT_OVERAGE,
    curve: typeof c.curve === 'string' ? c.curve : '',
    plateType: typeof c.plate_type === 'string' ? c.plate_type : '',
    sortByOrder: c.sort_by_order !== false,
  }
}

export function pcrConfigToWire(c: PcrConfig): Record<string, unknown> {
  return {
    overage: c.overage,
    curve: c.curve,
    plate_type: c.plateType,
    sort_by_order: c.sortByOrder,
  }
}

/** The date a run is judged against for overdue / due today: today in lab
 *  time while the worksheet is open, its completion day once completed. */
export function pcrRunDate(
  ws: Pick<WorksheetListItem, 'status' | 'completed_at'>,
  cal: LabCalendar | null
): string | null {
  if (!cal) return null
  return ws.status === 'completed' && ws.completed_at
    ? labDate(ws.completed_at, cal)
    : labDate(new Date().toISOString(), cal)
}

/** PCR items in worksheet order as plate-builder samples. */
export function pcrSamplesFor(
  items: WorksheetItemRow[],
  dueAtByItemId: Map<number, string | null>,
  cal: LabCalendar | null,
  runDate: string | null
): PcrSample[] {
  return items.filter(isPcrWorksheetItem).map(item => {
    const due = cal ? labDate(dueAtByItemId.get(item.id), cal) : null
    return {
      itemId: item.id,
      id: item.sample_id,
      order: shortOrder(item.client_order_number),
      identity: endoIdentityFor(item),
      received: cal ? labDate(item.date_received, cal) : null,
      priority: item.priority,
      assessment: assess(due, runDate, item.priority),
      frozen:
        item.plate_no != null && item.well_pos != null
          ? { plate: item.plate_no, pos: item.well_pos }
          : null,
    }
  })
}

/** The instrument the Ran tick stamped on the run's rows ('' until then). */
export function stampedInstrument(items: WorksheetItemRow[]): string {
  const names = new Set(
    items
      .map(i => i.stamped_instrument_name)
      .filter((n): n is string => !!n && n !== 'mixed')
  )
  return [...names].join(', ')
}

export interface PcrRunDoc {
  title: string
  meta: PcrRunMeta
  layout: PcrLayout
  summary: PcrSummary
  printedAt: string
  /** Run status: rows Made / Ran out of the PCR rows. */
  status: { made: number; ran: number; total: number }
  notes: string
  sortByOrder: boolean
}

export interface PcrRunOptions {
  analystName: string
  calendar: LabCalendar | null
  printedAt: string
  /** SLA `due_at` per item id (null when the item has no received date). */
  dueAtByItemId: Map<number, string | null>
  notes: string
}

/** The run document: the worksheet's PCR items laid out on plates with the
 *  run's settings. Without a calendar the dates are blank rather than wrong. */
export function buildPcrRunDoc(
  ws: WorksheetListItem,
  opts: PcrRunOptions
): PcrRunDoc {
  const cal = opts.calendar
  const cfg = pcrConfigOf(ws)
  const items = ws.items.filter(isPcrWorksheetItem)
  const samples = pcrSamplesFor(
    items,
    opts.dueAtByItemId,
    cal,
    pcrRunDate(ws, cal)
  )
  const layout = layoutPlates(samples, { sortByOrder: cfg.sortByOrder })
  return {
    title: ws.title,
    meta: {
      runId: `WS-${ws.id}`,
      runName: ws.title,
      date: (cal ? labDate(ws.created_at, cal) : null) ?? '',
      analyst: opts.analystName,
      curve: cfg.curve,
      plateType: cfg.plateType,
      instrument: stampedInstrument(items),
      overage: cfg.overage,
    },
    layout,
    summary: summarize(layout),
    printedAt: opts.printedAt,
    status: {
      made: items.filter(i => i.made_at).length,
      ran: items.filter(i => i.ran_at).length,
      total: items.length,
    },
    notes: opts.notes,
    sortByOrder: cfg.sortByOrder,
  }
}
