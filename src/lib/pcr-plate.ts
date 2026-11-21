/**
 * qPCR plate builder: the 96-well 16S / 18S layout, reagent prep and export
 * layouts for a rapid-sterility PCR run.
 *
 * Ported from tools-dennis/tools/qpcr-plate-builder/calc.js (Dennis's plate
 * builder, in daily use since 2026-09-14) and brought up to his 2026-11-12
 * handoff (ACCMK1-HANDOFF.md beside calc.js): reagent maths by SOP-MICRO2601
 * Rev E, the middle-out fill, elution water. Every constant names its SOP
 * section, workbook cell or the day Dennis gave it. Pure: no DOM, no fetch,
 * no storage. Not ported: the CSV intake (the inbox is the intake), the
 * holiday calendar (the SLA engine owns due dates), run ids (the worksheet
 * id), the hand-added NTC (never used in a filed run), and Rearrange / Fill
 * gaps (Mk1 locks wells at print instead; ruling 2026-09-22).
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
import { priorityRank } from '@/lib/endo-prep'
import { shortLabDate } from '@/lib/endo-worksheet'

export const PROTOCOL = {
  /** Per-well reaction, uL. SOP-MICRO2601 Rev E 8.1 table: Master Mix 2.0
   *  (2X) 10, duplex assay mix (10X) 1, IPC mix 2.4 = premix 13.4; 8.2: 6.6 uL
   *  template, "bring to 20 uL total". (8 also says 30 uL; its own table and
   *  8.2 sum to 20, which is what the lab runs. Flagged to Dennis 2026-10-14.) */
  rxn: { mm: 10, assayMix: 1, ipcMix: 2.4, template: 6.6 },
  /** SOP 8.1 "Total Premix". */
  premixUl: 13.4,
  /** Part 1 elution water per extraction, uL. The bench elutes with 100
   *  (Dennis, 2026-11-09); Rev E step 17 says 50 and its graphic 20, both
   *  flagged for the next revision and not followed. */
  elutionUl: 100,
  /** Assay mix (16S and 18S alike), parts by volume. Not in the SOP; from the
   *  workbook, Template!Q36:T36. */
  assayMixParts: { 'F Primer': 9, 'R Primer': 9, Probe: 5, H2O: 77 },
  /** IPC mix, parts by volume. Not in the SOP; workbook Template!K36:M36. */
  ipcMixParts: { IPC: 20, 'IPC DNA': 4, H2O: 16 },
  /** SOP 8.1: reactions per well set = the samples and controls on the plate;
   *  the two sets double it. (The workbook padded MM and IPC to 2N+4 and BAC
   *  and FUN to N+2; Rev E counts reactions and adds the overage instead.) */
  reactions: (n: number) => ({ perSet: n, total: 2 * n }),
  /** Plate geometry: rows A..H by columns 1..12; Well Set A (16S/IPC) in
   *  columns 1 to 6, Well Set B (18S/IPC) in 7 to 12. */
  rows: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  cols: 12,
  /** SOP 6 materials (PCR), printed for reference. */
  reagents: [
    ['Master Mix 2.0', '2X, Standard mode'],
    ['16S assay mix', '10X, FAM'],
    ['18S assay mix', '10X, FAM'],
    ['IPC assay mix', '10X, VIC'],
    ['Template', '6.6 µL DNA or NPC'],
    ['NTC', 'nuclease-free water'],
  ] as [string, string][],
}

/** 8 rows x 6 bacterial columns: 48 wells per assay block. */
export const CAPACITY = 48
/** One well on every plate is the NPC's, after the last sample. */
export const SAMPLE_CAPACITY = CAPACITY - 1
/** SOP 8.1: each well set's premix is scaled to its reactions "plus 10%
 *  overage", master mix included. */
export const DEFAULT_OVERAGE = 1.1
/** The workbook's factor (Plate Map!E16), the default until Rev E. A saved
 *  1.4 with no Rev E mark was never a choice; see pcrConfigOf. */
export const WORKBOOK_OVERAGE = 1.4
export const NPC_ID = 'NPC'
/** The NTC is the no-template control; the NPC went through extraction. */
export const NPC_IDENTITY = 'Negative process control'

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

export interface PremixVolumes {
  mm: number
  assayMix: number
  ipcMix: number
  total: number
}

export interface PrepCalc {
  reactions: { perSet: number; total: number }
  perWell: {
    mm: number
    assayMix: number
    ipcMix: number
    premix: number
    template: number
    total: number
  }
  /** One well set's premix tube; the run makes two (Set A, Set B). */
  premix: { base: PremixVolumes; pipette: PremixVolumes }
  bac: MixRow[]
  fun: MixRow[]
  ipc: MixRow[]
}

/**
 * Full prep for one plate of n reactions per well set (SOP-MICRO2601 Rev E
 * 8.1). Premix per set = 13.4 uL x n, and the overage scales the whole
 * premix, master mix included. The assay and IPC mixes are split into their
 * components by the workbook recipes. Volumes in uL. Ported from calc.js
 * `calculate` (tools-dennis, 2026-10-14).
 */
export function calculatePrep(n: number, overage: number): PrepCalc {
  const { rxn } = PROTOCOL
  const reactions = PROTOCOL.reactions(n)
  const per = reactions.perSet
  const base: PremixVolumes = {
    mm: rxn.mm * per,
    assayMix: rxn.assayMix * per,
    ipcMix: rxn.ipcMix * per,
    total: PROTOCOL.premixUl * per,
  }
  const pipette: PremixVolumes = {
    mm: base.mm * overage,
    assayMix: base.assayMix * overage,
    ipcMix: base.ipcMix * overage,
    total: base.total * overage,
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
    reactions,
    perWell: { ...rxn, premix: PROTOCOL.premixUl, total: sum(rxn) },
    premix: { base, pipette },
    bac: split(assayFrac, base.assayMix),
    fun: split(assayFrac, base.assayMix),
    ipc: split(ipcFrac, base.ipcMix),
  }
}

/** The premix card's rows: one well set's tube. */
export function premixRows(c: PrepCalc): MixRow[] {
  const { base: b, pipette: p } = c.premix
  return [
    { name: 'Master mix 2.0', base: b.mm, pipette: p.mm },
    { name: 'Duplex assay mix', base: b.assayMix, pipette: p.assayMix },
    { name: 'IPC mix', base: b.ipcMix, pipette: p.ipcMix },
  ]
}

/**
 * Water to warm at 65 C before elution (SOP Part 1, steps 13 and 17): 100 uL
 * per extraction at the premix's overage, so the last column is not short.
 * Extractions are the samples and the NPC, which is every well on a Mk1
 * plate (an NTC is not extracted, and Mk1 places none).
 */
export function extractionWater(extractions: number, overage: number) {
  const base = PROTOCOL.elutionUl * extractions
  return {
    extractions,
    perExtraction: PROTOCOL.elutionUl,
    base,
    pipette: base * overage,
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

/**
 * A well placed by hand before the plate is printed (Rearrange; Dennis,
 * 2026-10-26, asked for in Mk1 2026-11-20). `held` marks a well that was
 * only frozen where the layout had it when the analyst moved something else,
 * so the rest of the plate does not slide into the gap. Ported from calc.js
 * `pin` (tools-dennis). A printed plate's wells are locked instead (`frozen`),
 * and a lock always wins over a pin.
 */
export interface PcrPin {
  plate: number
  pos: number
  held?: boolean
}

export interface PcrPins {
  /** By worksheet item id. */
  samples: Record<number, PcrPin>
  /** The NPC sits on every plate, so it carries one pin per plate: by plate. */
  npc: Record<number, { pos: number; held?: boolean }>
}

export const NO_PINS: PcrPins = { samples: {}, npc: {} }

export const hasPins = (p: PcrPins): boolean =>
  Object.keys(p.samples).length > 0 || Object.keys(p.npc).length > 0

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
  /** Well Set A (bacterial) column 1..6. */
  col: number
  /** The same sample's Well Set B (fungal) column 7..12. */
  funCol: number
  /** Contiguous run of one order number; the NPC trails as its own group. */
  group: number
  isControl: boolean
  frozen: boolean
  /** Moved to this well by hand (not merely held there). */
  pinned: boolean
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
  /** Samples sitting where a pin put them, moved or held. */
  pinnedCount: number
  kind: PcrLayoutKind
}

/** Numeric where possible, else the raw text; null when blank. */
export function orderKey(order: string): number | string | null {
  const raw = order.trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : raw
}

/** The samples-list column the plate is dealt by; 'listed' = worksheet order. */
export type PcrSortKey =
  | 'listed'
  | 'order'
  | 'sampleId'
  | 'identity'
  | 'received'
  | 'due'
  | 'priority'
export interface PcrSort {
  key: PcrSortKey
  dir: 'asc' | 'desc'
}
export const PCR_SORT_KEYS: readonly PcrSortKey[] = [
  'listed',
  'order',
  'sampleId',
  'identity',
  'received',
  'due',
  'priority',
]
export const DEFAULT_PCR_SORT: PcrSort = { key: 'order', dir: 'asc' }

/** A header click: a new column starts ascending, the same one flips;
 *  worksheet order has no direction. */
export function nextSort(cur: PcrSort, key: PcrSortKey): PcrSort {
  if (key === 'listed') return { key, dir: 'asc' }
  return cur.key === key
    ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'asc' }
}

const SORT_VALUE: Record<
  Exclude<PcrSortKey, 'listed'>,
  (s: PcrSample) => number | string | null
> = {
  order: s => orderKey(s.order),
  sampleId: s => s.id || null,
  identity: s => s.identity || null,
  received: s => s.received,
  due: s => s.assessment.due,
  priority: s => priorityRank(s.priority),
}

/**
 * The deal order for the loose samples (Handler, 2026-09-24): by the list
 * column the worksheet is sorted on. Blanks go last in both directions so a
 * flip never buries the real rows; ties keep the worksheet's own order, which
 * with Order # ascending is Dennis's rule (order numbers ascending, the
 * worksheet's order within one order, 2026-09-15).
 */
function compareBy(
  sort: PcrSort
): (a: { s: PcrSample; i: number }, b: { s: PcrSample; i: number }) => number {
  if (sort.key === 'listed') return (a, b) => a.i - b.i
  const value = SORT_VALUE[sort.key]
  const sign = sort.dir === 'asc' ? 1 : -1
  return (a, b) => {
    const va = value(a.s)
    const vb = value(b.s)
    if ((va === null) !== (vb === null)) return va === null ? 1 : -1
    if (va !== null && vb !== null && va !== vb) {
      const c =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb), undefined, {
              numeric: true,
              sensitivity: 'base',
            })
      if (c !== 0) return c * sign
    }
    return a.i - b.i
  }
}

/**
 * How a fill position (0..47, the order wells are issued in) maps to a well.
 *  - 'mid' (Dennis, 2026-10-26): start in the middle and fan out, since the
 *    centre of the block gives the best data. Set A runs column 6 first
 *    (A6..H6), then 5 ... 1; Set B is the mirror at column 13 - c, so A6
 *    pairs with A7 and A1 with A12.
 *  - 'legacy': the workbook's fill, column 1 first, Set B at column + 6.
 *    Kept because `worksheet_items.well_pos` stores the fill position: a
 *    plate locked under this map is on the bench in these wells and must
 *    keep drawing there.
 */
export type PcrLayoutKind = 'mid' | 'legacy'

/** Row letter A..H of a fill position. */
export const rowOf = (pos: number): string =>
  String.fromCharCode(65 + (pos % 8))

/** Well Set A column of a fill position. */
export const colOf = (pos: number, kind: PcrLayoutKind): number =>
  kind === 'mid' ? 6 - Math.floor(pos / 8) : Math.floor(pos / 8) + 1

/** The Well Set B column that pairs with a Well Set A column. */
export const mirrorCol = (col: number, kind: PcrLayoutKind): number =>
  kind === 'mid' ? PROTOCOL.cols + 1 - col : col + 6

export const wellName = (pos: number, kind: PcrLayoutKind): string =>
  `${rowOf(pos)}${colOf(pos, kind)}`

/** The fill position of a grid cell in either block; null off the plate. */
export function posOf(
  row: string,
  col: number,
  kind: PcrLayoutKind
): number | null {
  const ri = PROTOCOL.rows.indexOf(row)
  if (ri < 0 || !Number.isInteger(col) || col < 1 || col > PROTOCOL.cols)
    return null
  const a = col <= 6 ? col : kind === 'mid' ? PROTOCOL.cols + 1 - col : col - 6
  return (kind === 'mid' ? 6 - a : a - 1) * 8 + ri
}

/**
 * Deal a run's samples onto plates. Frozen samples keep their wells. A well
 * once frozen stays spent even after its sample is removed (its liquid is
 * still in the plate), so the next free well on a plate is one past the
 * highest well ever issued there: the worksheet's record (`highWater`, plate
 * -> well) or, where it has none, the highest frozen well. A plate takes
 * samples up to SAMPLE_CAPACITY so the NPC always has the last well, which is
 * the one after both the last sample and the record.
 * Loose samples fill plate 1's free wells, then plate 2's, then new plates.
 * Positions are issued in order, 0 upward; which well a position is depends
 * on the plate's map (`kind`, see PcrLayoutKind).
 */
export function layoutPlates(
  samples: PcrSample[],
  opts: {
    sort?: PcrSort
    /** calc.js's switch: false = worksheet order. `sort` wins when given. */
    sortByOrder?: boolean
    highWater?: Record<number, number>
    kind?: PcrLayoutKind
    pins?: PcrPins
  } = {}
): PcrLayout {
  // The worksheet decides (pcrLayoutKindOf). Untold, the map is the old one, so
  // a caller that forgets can never redraw a locked plate on other wells.
  const kind = opts.kind ?? 'legacy'
  const cols = (pos: number) => {
    const col = colOf(pos, kind)
    return { col, funCol: mirrorCol(col, kind) }
  }
  const sort: PcrSort =
    opts.sort ??
    (opts.sortByOrder === false
      ? { key: 'listed', dir: 'asc' }
      : DEFAULT_PCR_SORT)
  const issuedUpTo = (plate: number) => opts.highWater?.[plate] ?? -1
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
  // Loose samples go above this: the highest well ever issued on the plate,
  // or the highest locked one where there is no record.
  const floor = new Map<number, number>()
  const floorOf = (plate: number) =>
    Math.max(issuedUpTo(plate), floor.get(plate) ?? -1)
  for (const s of samples)
    if (s.frozen) {
      place(s.frozen.plate, s.frozen.pos, s)
      floor.set(
        s.frozen.plate,
        Math.max(floor.get(s.frozen.plate) ?? -1, s.frozen.pos)
      )
      frozenCount++
    }
  // Wells placed by hand. A lock wins; two pins on one well keep the first
  // and let the second flow; a pin off the plate is ignored.
  const pins = opts.pins ?? NO_PINS
  const byPin = new Set<PcrSample>()
  const byHand = new Set<PcrSample>()
  for (const s of samples) {
    const pin = s.frozen ? undefined : pins.samples[s.itemId]
    if (!pin || !validWell(pin.plate, pin.pos)) continue
    if (wells.get(pin.plate)?.has(pin.pos)) continue
    place(pin.plate, pin.pos, s)
    byPin.add(s)
    if (!pin.held) byHand.add(s)
  }
  // The rest flow into the first open well above the floor, leaving the
  // block's last well for the NPC. With nothing moved by hand that is simply
  // the well after the last one.
  const firstOpen = (plate: number) => {
    const m = wells.get(plate)
    for (let pos = floorOf(plate) + 1; pos < SAMPLE_CAPACITY; pos++)
      if (!m?.has(pos)) return pos
    return -1
  }
  const loose = samples
    .map((s, i) => ({ s, i }))
    .filter(x => !x.s.frozen && !byPin.has(x.s))
  loose.sort(compareBy(sort))
  let plate = 1
  for (const { s } of loose) {
    let pos = firstOpen(plate)
    while (pos < 0) pos = firstOpen(++plate)
    place(plate, pos, s)
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
        ...cols(pos),
        group,
        isControl: false,
        frozen: !!s.frozen,
        pinned: byHand.has(s),
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
  // sample on every plate that has one (the block's last well when full).
  const ctrlGroup = group + 1
  const npcs: PcrPlacement[] = []
  for (const pl of plates) {
    if (!pl.sampleCount) continue
    const taken = new Set(pl.placements.map(x => x.pos))
    const pin = pins.npc[pl.plate]
    const pinOk = !!pin && validWell(pl.plate, pin.pos) && !taken.has(pin.pos)
    let pos = pinOk ? pin.pos : Math.max(issuedUpTo(pl.plate), ...taken) + 1
    // A sample pinned to the block's last well leaves the NPC the first open one.
    if (pos >= CAPACITY)
      pos = Array.from({ length: CAPACITY }, (_, i) => i).find(
        i => !taken.has(i)
      ) as number
    if (pos === undefined) continue
    const npc: PcrPlacement = {
      sample: null,
      id: NPC_ID,
      identity: NPC_IDENTITY,
      order: '',
      plate: pl.plate,
      pos,
      row: rowOf(pos),
      ...cols(pos),
      group: ctrlGroup,
      isControl: true,
      frozen: false,
      pinned: pinOk && !pin.held,
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
  return {
    plates,
    plateCount,
    list,
    frozenCount,
    pinnedCount: byPin.size,
    kind,
  }
}

const validWell = (plate: number, pos: number): boolean =>
  Number.isInteger(plate) &&
  plate >= 1 &&
  Number.isInteger(pos) &&
  pos >= 0 &&
  pos < CAPACITY

/* ---------------- Rearrange: wells moved by hand ---------------- */

export interface WellMove {
  from: number
  to: number
}

export interface WellMovePlan {
  ok: boolean
  /** Why nothing moves, in the analyst's words; '' when it fits. */
  reason: string
  moves: WellMove[]
}

/**
 * Shift the selected wells of one plate by the same number of fill
 * positions, so a run of four stays a run of four. `toPos` is where
 * `anchor` lands (the well being dragged; the lowest selected well for a
 * click). If any target is off the plate or holds a sample outside the
 * selection, nothing moves and the reason says why. Never on a printed
 * plate: its wells are locked. Ported from calc.js `planWellMove`; a move
 * to another plate is not ported.
 */
export function planWellMove(
  L: PcrLayout,
  plateNo: number,
  selected: number[],
  toPos: number,
  anchor: number = Math.min(...selected)
): WellMovePlan {
  const no = (reason: string): WellMovePlan => ({
    ok: false,
    reason,
    moves: [],
  })
  if (L.frozenCount > 0)
    return no('This plate is printed: unlock the wells before moving any.')
  const pl = L.plates.find(p => p.plate === plateNo)
  if (!pl || !selected.length) return no('Select a well first.')
  const at = new Map(pl.placements.map(p => [p.pos, p]))
  const sel = new Set(selected.filter(p => at.has(p)))
  if (!sel.size) return no('Select a well first.')
  const delta = toPos - anchor
  const moves = [...sel]
    .sort((a, b) => a - b)
    .map(from => ({ from, to: from + delta }))
  for (const m of moves) {
    if (m.to < 0 || m.to >= CAPACITY)
      return no('That would run off the plate; nothing moved.')
    const there = at.get(m.to)
    if (there && !sel.has(m.to))
      return no(
        `${wellName(m.to, L.kind)} is taken by ${there.id}; nothing moved.`
      )
  }
  return { ok: true, reason: '', moves }
}

/** Every well of the layout as a pin where it stands now: the moved ones
 *  by hand, the rest held, so nothing slides into a gap. */
function pinsOfLayout(L: PcrLayout): PcrPins {
  const pins: PcrPins = { samples: {}, npc: {} }
  for (const pl of L.plates)
    for (const p of pl.placements) {
      const pin = p.pinned ? { pos: p.pos } : { pos: p.pos, held: true }
      if (p.sample) pins.samples[p.sample.itemId] = { plate: pl.plate, ...pin }
      else pins.npc[pl.plate] = pin
    }
  return pins
}

/** The pins after a planned move: the moved wells by hand, every other well
 *  held where it was (Dennis, 2026-10-26: a move must not rearrange wells he
 *  did not touch). */
export function applyWellMoves(
  L: PcrLayout,
  plateNo: number,
  moves: WellMove[]
): PcrPins {
  const pins = pinsOfLayout(L)
  const pl = L.plates.find(p => p.plate === plateNo)
  if (!pl) return pins
  const to = new Map(moves.map(m => [m.from, m.to]))
  for (const p of pl.placements) {
    const pos = to.get(p.pos)
    if (pos === undefined) continue
    if (p.sample) pins.samples[p.sample.itemId] = { plate: plateNo, pos }
    else pins.npc[plateNo] = { pos }
  }
  return pins
}

/** A plate has an empty well before its last sample. */
export const hasGaps = (pl: PcrPlate): boolean => {
  const at = pl.placements.filter(p => !p.isControl).map(p => p.pos)
  return at.length > 0 && Math.max(...at) + 1 > at.length
}

/** Pack every plate from its first well in the order it is in now: the
 *  sequence is kept, only the holes close, and the NPC goes back to the well
 *  after the last sample. Hand-placed wells keep their mark. */
export function fillGaps(L: PcrLayout): PcrPins {
  const pins: PcrPins = { samples: {}, npc: {} }
  for (const pl of L.plates)
    pl.placements
      .filter(p => p.sample)
      .sort((a, b) => a.pos - b.pos)
      .forEach((p, pos) => {
        pins.samples[(p.sample as PcrSample).itemId] = p.pinned
          ? { plate: pl.plate, pos }
          : { plate: pl.plate, pos, held: true }
      })
  return pins
}

/** "A6 / A7" for a placement; with the plate when the run has several. */
export function wellsOf(p: PcrPlacement, plateCount: number): string {
  const w = `${p.row}${p.col} / ${p.row}${p.funCol}`
  return plateCount > 1 ? `P${p.plate} ${w}` : w
}

export interface PlateCell {
  placement: PcrPlacement
  assay: 'bac' | 'fun'
}

/** "A6" -> cell, for both the bacterial well and its fungal pair. */
export function plateGrid(plate: PcrPlate): Map<string, PlateCell> {
  const map = new Map<string, PlateCell>()
  for (const p of plate.placements) {
    map.set(`${p.row}${p.col}`, { placement: p, assay: 'bac' })
    map.set(`${p.row}${p.funCol}`, { placement: p, assay: 'fun' })
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
    const w = extractionWater(pl.n, overage)
    const { base: pb, pipette: pp } = c.premix
    const set = 'Premix per well set'
    rows.push([p, 'Reactions', 'Samples on plate', String(pl.sampleCount), ''])
    rows.push([p, 'Reactions', 'Controls', String(pl.n - pl.sampleCount), ''])
    rows.push([
      p,
      'Reactions',
      'Reactions per well set (N)',
      String(c.reactions.perSet),
      '',
    ])
    rows.push([
      p,
      'Reactions',
      'Reactions total (2N)',
      String(c.reactions.total),
      '',
    ])
    rows.push([
      p,
      'Extraction',
      'Extractions (samples + NPC)',
      String(w.extractions),
      '',
    ])
    rows.push([
      p,
      'Extraction',
      `Elution water at 65 C (${w.perExtraction} uL each)`,
      fmt2(w.base),
      fmt2(w.pipette),
    ])
    rows.push([p, 'Per well', 'Master mix', fmt2(c.perWell.mm), ''])
    rows.push([p, 'Per well', 'Duplex assay mix', fmt2(c.perWell.assayMix), ''])
    rows.push([p, 'Per well', 'IPC mix', fmt2(c.perWell.ipcMix), ''])
    rows.push([p, 'Per well', 'Premix', fmt2(c.perWell.premix), ''])
    rows.push([p, 'Per well', 'Template', fmt2(c.perWell.template), ''])
    rows.push([p, 'Per well', 'Total per well', fmt2(c.perWell.total), ''])
    rows.push([p, set, 'Master mix', fmt2(pb.mm), fmt2(pp.mm)])
    rows.push([
      p,
      set,
      'Duplex assay mix',
      fmt2(pb.assayMix),
      fmt2(pp.assayMix),
    ])
    rows.push([p, set, 'IPC mix', fmt2(pb.ipcMix), fmt2(pp.ipcMix)])
    rows.push([p, set, 'Total', fmt2(pb.total), fmt2(pp.total)])
    const tables: [string, MixRow[]][] = [
      ['Set A assay mix (16S)', c.bac],
      ['Set B assay mix (18S)', c.fun],
      ['IPC mix (per set)', c.ipc],
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
        `${p.row}${p.col}; ${p.row}${p.funCol}`,
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
