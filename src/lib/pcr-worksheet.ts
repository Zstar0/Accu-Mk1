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
  DEFAULT_PCR_SORT,
  layoutPlates,
  NO_PINS,
  hasPins,
  PCR_SORT_KEYS,
  summarize,
  WORKBOOK_OVERAGE,
  type PcrLayout,
  type PcrLayoutKind,
  type PcrPins,
  type PcrRunMeta,
  type PcrSample,
  type PcrSort,
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
  /** The samples-list column the plate is dealt by (shared, saved on the
   *  worksheet so every analyst sees the plate that will be printed). */
  sort: PcrSort
  /** Wells placed by hand before the print (Rearrange). */
  pins: PcrPins
}

export const DEFAULT_PCR_CONFIG: PcrConfig = {
  overage: DEFAULT_OVERAGE,
  curve: '',
  plateType: '',
  sort: DEFAULT_PCR_SORT,
  pins: NO_PINS,
}

/** The highest well ever frozen per plate (worksheets.well_high_water), with
 *  its JSON string keys turned back into plate numbers. Anything malformed is
 *  skipped: the highest frozen well still stands in for a missing entry. */
export function highWaterOf(
  ws: Pick<WorksheetListItem, 'well_high_water'>
): Record<number, number> {
  const out: Record<number, number> = {}
  for (const [plate, pos] of Object.entries(ws.well_high_water ?? {})) {
    const p = Number(plate)
    const w = Number(pos)
    if (Number.isInteger(p) && p >= 1 && Number.isInteger(w) && w >= 0)
      out[p] = w
  }
  return out
}

/** The run's settings from worksheets.bench_config (free-form JSON shared by
 *  every bench kind); anything missing or malformed falls back to the default. */
export function pcrConfigOf(
  ws: Pick<WorksheetListItem, 'bench_config'>
): PcrConfig {
  const c = (ws.bench_config ?? {}) as Record<string, unknown>
  const overage = Number(c.overage)
  // Before Rev E every settings save wrote the then-default 1.4 beside
  // whatever was changed, so a 1.4 with no Rev E mark was never chosen: it
  // reads as the current default (calc.js does the same once, DEFAULTS_REV).
  const stale = c.rev !== 'E' && overage === WORKBOOK_OVERAGE
  return {
    overage:
      Number.isFinite(overage) && overage > 0 && !stale
        ? overage
        : DEFAULT_OVERAGE,
    curve: typeof c.curve === 'string' ? c.curve : '',
    plateType: typeof c.plate_type === 'string' ? c.plate_type : '',
    sort: sortOf(c),
    pins: pinsOf(c.pins),
  }
}

/** bench_config.pins, with anything malformed dropped: a bad pin must never
 *  put a sample on a well nobody chose. */
function pinsOf(raw: unknown): PcrPins {
  const pins: PcrPins = { samples: {}, npc: {} }
  if (!raw || typeof raw !== 'object') return pins
  const { samples, npc } = raw as Record<string, unknown>
  const int = (v: unknown) => (Number.isInteger(v) ? (v as number) : null)
  for (const [k, v] of Object.entries(samples ?? {})) {
    const p = (v ?? {}) as Record<string, unknown>
    const plate = int(p.plate)
    const pos = int(p.pos)
    if (!Number.isInteger(Number(k)) || plate === null || pos === null) continue
    pins.samples[Number(k)] = p.held
      ? { plate, pos, held: true }
      : { plate, pos }
  }
  for (const [k, v] of Object.entries(npc ?? {})) {
    const p = (v ?? {}) as Record<string, unknown>
    const pos = int(p.pos)
    if (!Number.isInteger(Number(k)) || pos === null) continue
    pins.npc[Number(k)] = p.held ? { pos, held: true } : { pos }
  }
  return pins
}

/** The saved column sort; before 2026-09-24 only the on/off order switch
 *  existed, so a worksheet without `sort_key` keeps what that switch meant. */
function sortOf(c: Record<string, unknown>): PcrSort {
  const key = PCR_SORT_KEYS.find(k => k === c.sort_key)
  if (key) return { key, dir: c.sort_dir === 'desc' ? 'desc' : 'asc' }
  if (c.sort_key !== undefined) return DEFAULT_PCR_SORT
  return c.sort_by_order === false
    ? { key: 'listed', dir: 'asc' }
    : DEFAULT_PCR_SORT
}

export function pcrConfigToWire(c: PcrConfig): Record<string, unknown> {
  return {
    // Marks the overage as set under SOP-MICRO2601 Rev E (see pcrConfigOf).
    rev: 'E',
    overage: c.overage,
    curve: c.curve,
    plate_type: c.plateType,
    sort_key: c.sort.key,
    sort_dir: c.sort.dir,
    // The older on/off switch, kept in step for any build that still reads it.
    sort_by_order: c.sort.key === 'order',
    ...(hasPins(c.pins) ? { pins: c.pins } : {}),
  }
}

/**
 * The well map this worksheet's plate is drawn with. The server stamps it at
 * the first lock (bench_config.layout). With no stamp: a plate locked or
 * completed before the stamp existed was loaded column 1 first ('legacy');
 * anything still unlocked takes the middle-out fill.
 */
export function pcrLayoutKindOf(
  ws: Pick<
    WorksheetListItem,
    'bench_config' | 'well_high_water' | 'status' | 'items'
  >
): PcrLayoutKind {
  const stamped = (ws.bench_config as Record<string, unknown> | null)?.layout
  if (stamped === 'mid' || stamped === 'legacy') return stamped
  const locked =
    ws.items.some(i => i.plate_no != null && i.well_pos != null) ||
    Object.keys(ws.well_high_water ?? {}).length > 0
  return locked || ws.status === 'completed' ? 'legacy' : 'mid'
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
  /** A sort just clicked but not yet saved; the saved one otherwise. */
  sort?: PcrSort
  /** Hand placements just made but not yet saved; the saved ones otherwise. */
  pins?: PcrPins
}

/** The run document: the worksheet's PCR items laid out on plates with the
 *  run's settings. Without a calendar the dates are blank rather than wrong. */
export function buildPcrRunDoc(
  ws: WorksheetListItem,
  opts: PcrRunOptions
): PcrRunDoc {
  const cal = opts.calendar
  const saved = pcrConfigOf(ws)
  const cfg = opts.sort ? { ...saved, sort: opts.sort } : saved
  const items = ws.items.filter(isPcrWorksheetItem)
  const samples = pcrSamplesFor(
    items,
    opts.dueAtByItemId,
    cal,
    pcrRunDate(ws, cal)
  )
  const layout = layoutPlates(samples, {
    sort: cfg.sort,
    highWater: highWaterOf(ws),
    kind: pcrLayoutKindOf(ws),
    pins: opts.pins ?? cfg.pins,
  })
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
    // Order boxes and tints only mean something when wells run by order.
    sortByOrder: cfg.sort.key === 'order',
  }
}
