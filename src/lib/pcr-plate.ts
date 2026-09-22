/**
 * qPCR plate builder: the 96-well 16S / 18S layout, reagent prep and export
 * layouts for a rapid-sterility PCR run.
 *
 * Ported from tools-dennis/tools/qpcr-plate-builder/calc.js (Dennis's plate
 * builder, in daily use since 2026-09-14). Every constant names the workbook
 * cell it came from (qPCR_PlateMap_09-11-2026.xlsx, Template tab). Pure: no
 * DOM, no fetch, no storage. Not ported: the CSV intake (the inbox is the
 * intake), the holiday calendar (the SLA engine owns due dates), run ids (the
 * worksheet id) and the hand-added NTC (never used in a filed run).
 *
 * Frozen wells (ruling 2026-09-22): once a plate has been printed or exported
 * for the QuantStudio it is loaded at the bench, so the wells it was printed
 * with never move. A sample carries its frozen (plate, pos); the layout keeps
 * every frozen sample where it is, deals the rest into the wells after the
 * last frozen one, and puts the NPC after the last sample on every plate.
 *
 * Spec: docs/superpowers/specs/2026-09-22-pcr-worksheet-design.md
 */
import { csvField } from '@/lib/endo-bench-sheet'
import { shortLabDate } from '@/lib/endo-worksheet'

export const PROTOCOL = {
  /** Per-well reaction, uL. Template!K20:N20 (20 uL total, Reagent List!L6). */
  rxn: { mm: 10, assayMix: 1, ipcMix: 2.4, template: 6.6 },
  /** Assay mix (16S and 18S alike), parts by volume. Template!Q36:T36. */
  assayMixParts: { 'F Primer': 9, 'R Primer': 9, Probe: 5, H2O: 77 },
  /** IPC mix, parts by volume. Template!K36:M36; run at 0.6x (Template!P14). */
  ipcMixParts: { IPC: 20, 'IPC DNA': 4, H2O: 16 },
  /** Well counts carry a fixed buffer over the wells on the plate. Template!D39:G39. */
  wellCounts: (n: number) => ({
    mm: 2 * n + 4,
    bac: n + 2,
    fun: n + 2,
    ipc: 2 * n + 4,
  }),
  /** Plate geometry: Template!C5:C12 (A..H) by Template!D4:O4 (1..12). */
  rows: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  cols: 12,
  /** Reagent List!B4:C13, printed for reference. */
  reagents: [
    ['16S-F', '200 µM'],
    ['16S-R', '200 µM'],
    ['18S-F', '200 µM'],
    ['18S-R', '200 µM'],
    ['16S Probe', '100 µM'],
    ['18S Probe', '100 µM'],
    ['Master Mix', '2x'],
    ['10x exo IPC mix', '10x'],
    ['50x exo IPC DNA', '50x'],
    ['10x block-exp IPC', '10x'],
  ] as [string, string][],
}

/** 8 rows x 6 bacterial columns: 48 wells per assay block. */
export const CAPACITY = 48
/** One well on every plate is the NPC's, after the last sample. */
export const SAMPLE_CAPACITY = CAPACITY - 1
/** Plate Map!E16 = K44 * 1.4: the filled run's factor on the mix components. */
export const DEFAULT_OVERAGE = 1.4
export const NPC_ID = 'NPC'
export const NPC_IDENTITY = 'No-template control'

const sum = (o: Record<string, number>) =>
  Object.values(o).reduce((a, b) => a + b, 0)

/** Parts by volume to fractions of the whole. Template!Q37:T37 and K37:M37. */
export function fractions(
  parts: Record<string, number>
): Record<string, number> {
  const total = sum(parts)
  return Object.fromEntries(
    Object.entries(parts).map(([k, v]) => [k, v / total])
  )
}

/** Two decimals, float noise trimmed: 6.300000000000001 -> "6.3". */
export function fmt2(v: number): string {
  return String(Math.round(v * 100) / 100)
}

export interface MixRow {
  name: string
  base: number
  pipette: number
}

export interface PrepCalc {
  wells: { mm: number; bac: number; fun: number; ipc: number }
  perWell: {
    mm: number
    assayMix: number
    ipcMix: number
    template: number
    total: number
  }
  bulk: { mm: number; bac: number; fun: number; ipc: number }
  bac: MixRow[]
  fun: MixRow[]
  ipc: MixRow[]
}

/**
 * Full prep for one plate of n wells at the given overage. Bulk = per-well
 * volume x wells of that kind (Template!D32:G32); each mix is split into its
 * components by the fractions (K32:N32, Q32:T32, D36:F36) and scaled by the
 * overage for the pipetting column (E16:H16, K16:M16, E20:H20). Master mix
 * is not scaled, matching the workbook. Volumes in uL.
 */
export function calculatePrep(n: number, overage: number): PrepCalc {
  const wells = PROTOCOL.wellCounts(n)
  const { rxn } = PROTOCOL
  const bulk = {
    mm: rxn.mm * wells.mm,
    bac: rxn.assayMix * wells.bac,
    fun: rxn.assayMix * wells.fun,
    ipc: rxn.ipcMix * wells.ipc,
  }
  const split = (frac: Record<string, number>, volume: number): MixRow[] =>
    Object.entries(frac).map(([name, f]) => ({
      name,
      base: f * volume,
      pipette: f * volume * overage,
    }))
  const assayFrac = fractions(PROTOCOL.assayMixParts)
  const ipcFrac = fractions(PROTOCOL.ipcMixParts)
  return {
    wells,
    perWell: { ...rxn, total: sum(rxn) },
    bulk,
    bac: split(assayFrac, bulk.bac),
    fun: split(assayFrac, bulk.fun),
    ipc: split(ipcFrac, bulk.ipc),
  }
}

/* ---------------- priority and turnaround ---------------- */

export type Urgency = 'overdue' | 'today' | 'later' | ''

export interface PcrAssessment {
  /** YYYY-MM-DD lab date from the SLA engine, or null. */
  due: string | null
  urgency: Urgency
  flagged: boolean
  reasons: string[]
}

/** A sample against the run date: overdue, due today, or marked priority. */
export function assess(
  due: string | null,
  runDate: string | null,
  priority: string | null | undefined
): PcrAssessment {
  let urgency: Urgency = ''
  if (due && runDate)
    urgency = due < runDate ? 'overdue' : due === runDate ? 'today' : 'later'
  const reasons: string[] = []
  const p = (priority ?? '').toLowerCase()
  if (p === 'expedited') reasons.push('Expedited')
  else if (p === 'high') reasons.push('High priority')
  if (urgency === 'overdue')
    reasons.push(`Overdue, was due ${shortLabDate(due)}`)
  if (urgency === 'today') reasons.push('Due today')
  return { due, urgency, flagged: reasons.length > 0, reasons }
}

/* ---------------- samples and layout ---------------- */

export interface PcrSample {
  itemId: number
  id: string
  /** Order number without the WP- prefix; '' when unknown. */
  order: string
  identity: string
  /** YYYY-MM-DD lab date, or null. */
  received: string | null
  priority: string
  assessment: PcrAssessment
  /** Set once the plate was printed or exported: this well never moves. */
  frozen: { plate: number; pos: number } | null
}

export interface PcrPlacement {
  /** null for the NPC. */
  sample: PcrSample | null
  id: string
  identity: string
  order: string
  /** 1-based plate number. */
  plate: number
  /** 0..47, column-major within the bacterial block. */
  pos: number
  row: string
  /** Bacterial column 1..6; the fungal mirror is col + 6. */
  col: number
  /** Contiguous run of one order number; the NPC trails as its own group. */
  group: number
  isControl: boolean
  frozen: boolean
  assessment: PcrAssessment | null
}

export interface PcrPlate {
  plate: number
  /** Samples by well, then the NPC. */
  placements: PcrPlacement[]
  sampleCount: number
  /** Wells used on this plate, NPC included: the N of the reagent prep. */
  n: number
}

export interface PcrListRow {
  sample: PcrSample | null
  isControl: boolean
  group: number
  /** One placement for a sample; one per plate for the NPC. */
  placements: PcrPlacement[]
}

export interface PcrLayout {
  plates: PcrPlate[]
  plateCount: number
  /** Samples in run order (plate, then well), then the NPC once. */
  list: PcrListRow[]
  frozenCount: number
}

/** Numeric where possible, else the raw text; null when blank. */
export function orderKey(order: string): number | string | null {
  const raw = order.trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : raw
}

/**
 * Ordering rule with "Order wells by order #" on: samples carrying an order
 * number first, ascending; samples with no order number after them; the
 * worksheet's own order within one order number (the lab's practice, asked
 * for by Dennis 2026-09-15).
 */
function compareByOrder(
  a: { s: PcrSample; i: number },
  b: { s: PcrSample; i: number }
): number {
  const ka = orderKey(a.s.order)
  const kb = orderKey(b.s.order)
  if ((ka === null) !== (kb === null)) return ka === null ? 1 : -1
  if (ka !== null && kb !== null && ka !== kb) {
    if (typeof ka === 'number' && typeof kb === 'number') return ka - kb
    return String(ka).localeCompare(String(kb), undefined, { numeric: true })
  }
  return a.i - b.i
}

/** Row letter A..H of a column-major position. */
export const rowOf = (pos: number): string =>
  String.fromCharCode(65 + (pos % 8))

export const wellName = (pos: number): string =>
  `${rowOf(pos)}${Math.floor(pos / 8) + 1}`

/**
 * Deal a run's samples onto plates. Frozen samples keep their wells. The next
 * free well on a plate is one past its highest frozen well (a well once
 * issued is never re-issued, even after its sample was removed), and a plate
 * takes samples up to SAMPLE_CAPACITY so the NPC always has the last well.
 * Loose samples fill plate 1's free wells, then plate 2's, then new plates.
 * Within a plate the fill is column-major, A1..H1 then A2..H2 (Template!D5
 * = B10, D6 = B11 ... E5 = B18); every well mirrors into the fungal block at
 * col + 6 (Template!J5 = B10 ...).
 */
export function layoutPlates(
  samples: PcrSample[],
  opts: { sortByOrder?: boolean } = {}
): PcrLayout {
  const sortByOrder = opts.sortByOrder !== false
  const wells = new Map<number, Map<number, PcrSample>>()
  const place = (plate: number, pos: number, s: PcrSample) => {
    let m = wells.get(plate)
    if (!m) {
      m = new Map()
      wells.set(plate, m)
    }
    m.set(pos, s)
  }
  let frozenCount = 0
  for (const s of samples)
    if (s.frozen) {
      place(s.frozen.plate, s.frozen.pos, s)
      frozenCount++
    }
  const nextFree = (plate: number) => {
    const m = wells.get(plate)
    return m ? Math.max(-1, ...m.keys()) + 1 : 0
  }
  const loose = samples.map((s, i) => ({ s, i })).filter(x => !x.s.frozen)
  if (sortByOrder) loose.sort(compareByOrder)
  let plate = 1
  let next = nextFree(plate)
  for (const { s } of loose) {
    while (next >= SAMPLE_CAPACITY) {
      plate++
      next = nextFree(plate)
    }
    place(plate, next, s)
    next++
  }

  const plateCount = Math.max(1, ...wells.keys())
  const plates: PcrPlate[] = []
  let group = -1
  let prevKey: number | string | null | undefined
  for (let p = 1; p <= plateCount; p++) {
    const m = wells.get(p) ?? new Map<number, PcrSample>()
    const positions = [...m.keys()].sort((a, b) => a - b)
    const placements: PcrPlacement[] = positions.map(pos => {
      const s = m.get(pos) as PcrSample
      const key = orderKey(s.order)
      if (group < 0 || key !== prevKey) group++
      prevKey = key
      return {
        sample: s,
        id: s.id,
        identity: s.identity,
        order: s.order,
        plate: p,
        pos,
        row: rowOf(pos),
        col: Math.floor(pos / 8) + 1,
        group,
        isControl: false,
        frozen: !!s.frozen,
        assessment: s.assessment,
      }
    })
    plates.push({
      plate: p,
      placements,
      sampleCount: positions.length,
      n: positions.length,
    })
  }
  // The NPC: one trailing group for the whole run, the well after the last
  // sample on every plate that has one (H6 / H12 on a full plate).
  const ctrlGroup = group + 1
  const npcs: PcrPlacement[] = []
  for (const pl of plates) {
    if (!pl.sampleCount) continue
    const pos = Math.max(...pl.placements.map(x => x.pos)) + 1
    const npc: PcrPlacement = {
      sample: null,
      id: NPC_ID,
      identity: NPC_IDENTITY,
      order: '',
      plate: pl.plate,
      pos,
      row: rowOf(pos),
      col: Math.floor(pos / 8) + 1,
      group: ctrlGroup,
      isControl: true,
      frozen: false,
      assessment: null,
    }
    pl.placements.push(npc)
    pl.n = pl.placements.length
    npcs.push(npc)
  }
  const list: PcrListRow[] = []
  for (const pl of plates)
    for (const pc of pl.placements)
      if (!pc.isControl)
        list.push({
          sample: pc.sample,
          isControl: false,
          group: pc.group,
          placements: [pc],
        })
  if (npcs.length)
    list.push({
      sample: null,
      isControl: true,
      group: ctrlGroup,
      placements: npcs,
    })
  return { plates, plateCount, list, frozenCount }
}

/** "A1 / A7" for a placement; with the plate when the run has several. */
export function wellsOf(p: PcrPlacement, plateCount: number): string {
  const w = `${p.row}${p.col} / ${p.row}${p.col + 6}`
  return plateCount > 1 ? `P${p.plate} ${w}` : w
}

export interface PlateCell {
  placement: PcrPlacement
  assay: 'bac' | 'fun'
}

/** "A1" -> cell, for both the bacterial block and its mirror at col + 6. */
export function plateGrid(plate: PcrPlate): Map<string, PlateCell> {
  const map = new Map<string, PlateCell>()
  for (const p of plate.placements) {
    map.set(`${p.row}${p.col}`, { placement: p, assay: 'bac' })
    map.set(`${p.row}${p.col + 6}`, { placement: p, assay: 'fun' })
  }
  return map
}

export interface OrderGroup {
  plate: number
  group: number
  order: string
  isControl: boolean
  count: number
  flagged: number
  from: string
  to: string
}

/** Contiguous order groups per plate, with the well span each one occupies. */
export function orderGroups(plates: PcrPlate[]): OrderGroup[] {
  const groups: OrderGroup[] = []
  for (const pl of plates)
    for (const p of pl.placements) {
      const well = `${p.row}${p.col}`
      const flagged = p.assessment?.flagged ? 1 : 0
      const last = groups[groups.length - 1]
      if (last && last.plate === pl.plate && last.group === p.group) {
        last.count++
        last.flagged += flagged
        last.to = well
      } else {
        groups.push({
          plate: pl.plate,
          group: p.group,
          order: p.order,
          isControl: p.isControl,
          count: 1,
          flagged,
          from: well,
          to: well,
        })
      }
    }
  return groups
}

export interface PcrSummary {
  /** Rows on the run list: samples plus the NPC. */
  n: number
  samples: number
  plateCount: number
  overdue: number
  today: number
  marked: number
  flagged: number
  earliestDue: string | null
  prioText: string
}

/** Run-wide figures, shared by the header readouts and the printed run strip. */
export function summarize(L: PcrLayout): PcrSummary {
  const real = L.list.filter(r => !r.isControl).map(r => r.sample as PcrSample)
  const dues = real
    .map(s => s.assessment.due)
    .filter((d): d is string => !!d)
    .sort()
  const overdue = real.filter(s => s.assessment.urgency === 'overdue').length
  const today = real.filter(s => s.assessment.urgency === 'today').length
  const marked = real.filter(s => /^(expedited|high)$/i.test(s.priority)).length
  const flagged = real.filter(s => s.assessment.flagged).length
  const parts: string[] = []
  if (marked) parts.push(`${marked} marked`)
  if (overdue) parts.push(`${overdue} overdue`)
  if (today) parts.push(`${today} due today`)
  return {
    n: L.list.length,
    samples: real.length,
    plateCount: L.plateCount,
    overdue,
    today,
    marked,
    flagged,
    earliestDue: dues[0] ?? null,
    prioText: flagged
      ? `${flagged}: ${parts.join(', ')}`
      : real.length
        ? 'none'
        : '-',
  }
}

/** The wells to pin: every sample not frozen yet, where the layout put it. */
export function freezePayload(
  L: PcrLayout
): { item_id: number; plate_no: number; well_pos: number }[] {
  return L.plates.flatMap(pl =>
    pl.placements
      .filter(p => p.sample && !p.frozen)
      .map(p => ({
        item_id: (p.sample as PcrSample).itemId,
        plate_no: p.plate,
        well_pos: p.pos,
      }))
  )
}

/* ---------------- exports ---------------- */

export interface PcrRunMeta {
  /** "WS-24": the worksheet id stands in for Dennis's R-YYYYMMDD-n. */
  runId: string
  runName: string
  /** YYYY-MM-DD lab date the run was made. */
  date: string
  analyst: string
  curve: string
  plateType: string
  instrument: string
  overage: number
}

/** The run header that leads the plate map CSV. */
export function metaHeaderRows(meta: PcrRunMeta, L: PcrLayout): string[][] {
  return [
    ['Run ID', meta.runId],
    ['Run name', meta.runName],
    ['Date', meta.date],
    ['Analyst', meta.analyst],
    ['Curve', meta.curve],
    ['Plate type', meta.plateType],
    ['QuantStudio', meta.instrument],
    ['Samples', String(L.list.filter(r => !r.isControl).length)],
    ['Plates', String(L.plateCount)],
    ['Overage', `${meta.overage}x`],
    [],
  ]
}

/** Two 8 x 12 grids per plate: sample ids, then sample identities. */
export function plateMapRows(L: PcrLayout): string[][] {
  const rows: string[][] = []
  const colHead = [
    '',
    ...Array.from({ length: PROTOCOL.cols }, (_, i) => String(i + 1)),
  ]
  const grid = (
    map: Map<string, PlateCell>,
    pick: (c: PlateCell | undefined) => string
  ) =>
    PROTOCOL.rows.map(r => [
      r,
      ...Array.from({ length: PROTOCOL.cols }, (_, i) =>
        pick(map.get(`${r}${i + 1}`))
      ),
    ])
  for (const pl of L.plates) {
    const map = plateGrid(pl)
    const label = `Plate ${pl.plate} of ${L.plateCount}`
    rows.push(
      [`${label}: Sample ID`],
      colHead,
      ...grid(map, c => c?.placement.id ?? ''),
      []
    )
    rows.push(
      [`${label}: Sample identity`],
      colHead,
      ...grid(map, c => c?.placement.identity ?? ''),
      []
    )
  }
  return rows
}

export const WELL_LIST_HEADER = [
  'Plate',
  'Well',
  'Sample Name',
  'Order',
  'Identity',
  'Received',
  'Due',
  'Priority',
  'Assay',
  'Target',
  'Task',
]

/** One row per occupied well, both assay blocks. Task NTC for the control. */
export function wellListRows(L: PcrLayout): string[][] {
  const rows: string[][] = [WELL_LIST_HEADER]
  for (const pl of L.plates) {
    const map = plateGrid(pl)
    for (const r of PROTOCOL.rows)
      for (let c = 1; c <= PROTOCOL.cols; c++) {
        const cell = map.get(`${r}${c}`)
        if (!cell) continue
        const p = cell.placement
        const a = p.assessment
        rows.push([
          String(pl.plate),
          `${r}${c}`,
          p.id,
          p.order,
          p.identity,
          p.sample?.received ?? '',
          a?.due ?? '',
          a?.flagged ? a.reasons.join('; ') : '',
          cell.assay === 'bac' ? 'Bacterial' : 'Fungal',
          cell.assay === 'bac' ? '16S' : '18S',
          p.isControl ? 'NTC' : 'UNKNOWN',
        ])
      }
  }
  return rows
}

/** The calculation cards as rows, one block per plate. */
export function prepRows(L: PcrLayout, overage: number): string[][] {
  const rows: string[][] = [
    ['Plate', 'Table', 'Item', 'Calculated (uL)', `Pipette x${overage} (uL)`],
  ]
  for (const pl of L.plates) {
    const p = String(pl.plate)
    const c = calculatePrep(pl.n, overage)
    rows.push([p, 'Wells', 'Wells on plate (N)', String(pl.n), ''])
    rows.push([p, 'Wells', 'Master mix wells', String(c.wells.mm), ''])
    rows.push([p, 'Wells', 'BAC wells', String(c.wells.bac), ''])
    rows.push([p, 'Wells', 'FUN wells', String(c.wells.fun), ''])
    rows.push([p, 'Wells', 'IPC wells', String(c.wells.ipc), ''])
    rows.push([p, 'Per well', 'Master mix', fmt2(c.perWell.mm), ''])
    rows.push([p, 'Per well', 'Assay mix', fmt2(c.perWell.assayMix), ''])
    rows.push([p, 'Per well', 'IPC mix', fmt2(c.perWell.ipcMix), ''])
    rows.push([p, 'Per well', 'Template', fmt2(c.perWell.template), ''])
    rows.push([p, 'Per well', 'Total per well', fmt2(c.perWell.total), ''])
    rows.push([p, 'Bulk', 'Master mix', fmt2(c.bulk.mm), ''])
    rows.push([p, 'Bulk', 'BAC mix', fmt2(c.bulk.bac), ''])
    rows.push([p, 'Bulk', 'FUN mix', fmt2(c.bulk.fun), ''])
    rows.push([p, 'Bulk', 'IPC mix', fmt2(c.bulk.ipc), ''])
    const tables: [string, MixRow[]][] = [
      ['BAC mix', c.bac],
      ['FUN mix', c.fun],
      ['IPC mix', c.ipc],
    ]
    for (const [table, comps] of tables) {
      for (const r of comps)
        rows.push([p, table, r.name, fmt2(r.base), fmt2(r.pipette)])
      rows.push([
        p,
        table,
        'Total',
        fmt2(comps.reduce((a, r) => a + r.base, 0)),
        fmt2(comps.reduce((a, r) => a + r.pipette, 0)),
      ])
    }
  }
  return rows
}

/* QuantStudio 6/7 Flex "Import Sample File": tab-delimited, header row first,
 * the first column named exactly `Sample Name`, at most 32 attribute columns
 * after it, attribute names under 256 characters, no tabs or line breaks in a
 * value. One file per plate (each plate is its own experiment), every sample
 * listed once (the fungal mirror is the same sample in another well). The
 * NPC rides as a sample named NPC; the task is set on the instrument. */
export const QS_ATTRIBUTES = [
  'Order',
  'Identity',
  'Received',
  'Due',
  'Priority',
  'Plate',
  'Wells',
]

export interface QuantStudioFile {
  plate: number
  label: string
  filename: string
  text: string
}

export function quantStudioFiles(
  L: PcrLayout,
  meta: { runId: string; date: string }
): QuantStudioFile[] {
  const clean = (v: string | null | undefined) =>
    String(v ?? '')
      .replace(/[\t\r\n]+/g, ' ')
      .trim()
  return L.plates.map(pl => {
    const rows = [['Sample Name', ...QS_ATTRIBUTES]]
    for (const p of pl.placements) {
      const a = p.assessment
      rows.push([
        clean(p.id),
        clean(p.order),
        clean(p.identity),
        clean(p.sample?.received),
        clean(a?.due),
        clean(a?.flagged ? a.reasons.join('; ') : ''),
        String(pl.plate),
        `${p.row}${p.col}; ${p.row}${p.col + 6}`,
      ])
    }
    const suffix = L.plateCount > 1 ? `-plate${pl.plate}` : ''
    return {
      plate: pl.plate,
      label:
        L.plateCount > 1
          ? `Plate ${pl.plate} of ${L.plateCount} (${pl.n} wells)`
          : `Plate (${pl.n} wells)`,
      filename:
        `quantstudio-${meta.runId || 'run'}${suffix}-${meta.date || 'undated'}.txt`.replace(
          /[^\w.-]+/g,
          '-'
        ),
      text: rows.map(r => r.join('\t')).join('\r\n') + '\r\n',
    }
  })
}

/** Rows to CSV: CRLF, quoted where needed, formula cells defused (csvField). */
export function toCsv(rows: string[][]): string {
  return rows.map(r => r.map(csvField).join(',')).join('\r\n') + '\r\n'
}
