/**
 * Endotoxin (LAL) sample prep: calculations, lab dates and bench order.
 *
 * Ported from tools-dennis/tools/endotoxin-log/calc.js (Dennis's run log, in
 * daily production since 2026-09-01). Every formula names its source; the
 * workbook cells refer to the TEMPLATE tab of September_2026_Endotoxin.xlsx.
 * Pure: no DOM, no fetch, no storage. The derived figures are never stored:
 * the worksheet item carries the analyst's overrides and the parent's declared
 * weight, and this module computes the rest wherever it is shown (drawer,
 * bench sheet, CSV), so the three can never disagree.
 *
 * Due dates are NOT computed here (Handler ruling 2026-09-18): they come from
 * the SLA engine (`due_at` on /sla/status, the instant the business clock
 * reaches the sample's resolved target), so priority tiers and calendar
 * changes flow through automatically.
 *
 * Spec: docs/superpowers/specs/2026-09-18-endo-worksheet-design.md
 */

/** The 1 EU/mL cartridge is filled to 1000 uL (sample + LAL water). */
export const CARTRIDGE_UL = 1000
/** Physical limit: some vials hold no more than 10 mL of diluent. */
export const MAX_VOLUME_ML = 10
/** Workbook col E; every production row uses 1 mg/mL. */
export const DEFAULT_TARGET_MG_PER_ML = 1
/** Bacteriostatic water is a 20x dilution per the LAL SOP. */
export const DEFAULT_DILUTION = 20

/** Anything non-numeric becomes null rather than NaN. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
    return Number(v)
  return null
}

/**
 * Reconstitution volume. Excel: =MIN(10, 1 + FLOOR(F2/50, 1)): 1 mL of
 * diluent, plus 1 more mL for every whole 50 mg, capped at the vial limit.
 */
export function autoVolumeMl(
  weightMg: number | null | undefined
): number | null {
  const w = num(weightMg)
  if (w === null || w <= 0) return null
  return Math.min(MAX_VOLUME_ML, 1 + Math.floor(w / 50))
}

/**
 * Bac water is identified by a BW- sample id, or by its sample type or its
 * identity saying so. The reference tool (tools-dennis dilutionOf) reads the
 * identity; Mk1 usually says it in the sample type, where the identity is the
 * analyte ("Benzyl Alcohol"). Either counts: missing a water sample would
 * hand the bench a weight-prep figure for it.
 */
export function isBacWater(
  sampleId: string,
  sampleType?: string | null,
  identity?: string | null
): boolean {
  const says = /bacteriostatic|bac\.?\s*water/i
  return (
    /^BW-/i.test(sampleId ?? '') ||
    says.test(sampleType ?? '') ||
    says.test(identity ?? '')
  )
}

export interface EndoPrepInput {
  sampleId: string
  sampleType?: string | null
  /** Sample identity text; a bac-water identity makes it a dilution prep. */
  identity?: string | null
  /** The order's declared quantity (lims_samples.declared_total_quantity). */
  declaredWeightMg?: number | null
  /** Analyst overrides from worksheet_items; null/undefined = computed. */
  prepWeightMg?: number | null
  prepVolumeMl?: number | null
  prepDilutionFactor?: number | null
  prepTargetMgPerMl?: number | null
}

export interface EndoPrep {
  isWater: boolean
  /** Dilution factor for bac water; null for a weight prep. */
  dilution: number | null
  /** Target concentration in the cartridge; 1 mg/mL unless the analyst set it. */
  targetMgPerMl: number
  targetOverridden: boolean
  weightMg: number | null
  weightOverridden: boolean
  /** What the rule would give, regardless of any override. */
  autoVolumeMl: number | null
  volumeMl: number | null
  volumeOverridden: boolean
  vialConc: number | null
  sampleUl: number | null
  lalUl: number | null
  /** over_cartridge: sample > 1000 uL will not fit; no_diluent: LAL <= 0. */
  warning: 'over_cartridge' | 'no_diluent' | null
}

/**
 * The per-sample prep. Any value that cannot be worked out is null, never
 * NaN: a half-filled row renders as blank cells.
 */
export function calcEndoPrep(input: EndoPrepInput): EndoPrep {
  const targetOverride = num(input.prepTargetMgPerMl)
  const targetMgPerMl =
    targetOverride !== null && targetOverride > 0
      ? targetOverride
      : DEFAULT_TARGET_MG_PER_ML
  const targetOverridden = targetMgPerMl !== DEFAULT_TARGET_MG_PER_ML
  if (isBacWater(input.sampleId, input.sampleType, input.identity)) {
    // Not a weight prep: a straight dilution with LAL water, 50 uL at 20x.
    const factor = num(input.prepDilutionFactor)
    const dilution = factor !== null && factor > 0 ? factor : DEFAULT_DILUTION
    const sampleUl = CARTRIDGE_UL / dilution
    return {
      isWater: true,
      dilution,
      targetMgPerMl,
      targetOverridden,
      weightMg: null,
      weightOverridden: false,
      autoVolumeMl: null,
      volumeMl: null,
      volumeOverridden: false,
      vialConc: null,
      sampleUl,
      lalUl: CARTRIDGE_UL - sampleUl,
      warning: null,
    }
  }

  const weightOverride = num(input.prepWeightMg)
  const declared = num(input.declaredWeightMg)
  const weightMg = weightOverride ?? declared
  const weightOverridden =
    weightOverride !== null && weightOverride !== declared

  // An explicitly entered volume wins over the rule: the September rows were
  // pipetted at their frozen workbook volumes, and those stand.
  const auto = autoVolumeMl(weightMg)
  const volumeOverride = num(input.prepVolumeMl)
  const volumeMl = volumeOverride ?? auto
  const volumeOverridden = volumeOverride !== null && volumeOverride !== auto

  const blank: EndoPrep = {
    isWater: false,
    dilution: null,
    targetMgPerMl,
    targetOverridden,
    weightMg,
    weightOverridden,
    autoVolumeMl: auto,
    volumeMl,
    volumeOverridden,
    vialConc: null,
    sampleUl: null,
    lalUl: null,
    warning: null,
  }
  if (weightMg === null || volumeMl === null || volumeMl === 0) return blank

  const vialConc = weightMg / volumeMl // Excel: =F2/G2
  if (!vialConc) return blank
  const sampleUl = (targetMgPerMl / vialConc) * CARTRIDGE_UL // Excel: =(E2/J2)*1000
  const lalUl = CARTRIDGE_UL - sampleUl // Excel: =1000-H2
  return {
    ...blank,
    vialConc,
    sampleUl,
    lalUl,
    warning:
      sampleUl > CARTRIDGE_UL
        ? 'over_cartridge'
        : lalUl <= 0
          ? 'no_diluent'
          : null,
  }
}

/* ---------------- calendar ---------------- */

/**
 * The lab's working calendar, from /business-hours-config and /lab-holidays
 * (see useLabCalendar). `workingDays` uses Python weekday numbering,
 * Mon=0..Sun=6, exactly as business_hours_config stores it.
 */
export interface LabCalendar {
  timezone: string
  workingDays: number[]
  /** YYYY-MM-DD -> holiday name */
  holidays: Map<string, string>
}

/**
 * Clock time ("4:30 PM") of an ISO timestamp in the lab's time zone, read
 * the same way as labDate. A bare date carries no time, so it gives null.
 */
export function labTime(
  iso: string | null | undefined,
  cal: LabCalendar
): string | null {
  if (!iso || /^\d{4}-\d{2}-\d{2}$/.test(iso)) return null
  const withZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`
  const d = new Date(withZone)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-US', {
    timeZone: cal.timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(d)
}

/**
 * YYYY-MM-DD of an ISO timestamp in the lab's time zone. Mk1 serialises its
 * naive-UTC datetimes with a trailing Z (or none); a bare date passes through.
 */
export function labDate(
  iso: string | null | undefined,
  cal: LabCalendar
): string | null {
  if (!iso) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  const withZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`
  const d = new Date(withZone)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: cal.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/**
 * The lab holidays the SLA clock stepped over between the received date
 * (exclusive) and the due date (inclusive), so the bench sheet can say why a
 * date moved.
 */
export function holidaysBetween(
  receivedIso: string | null,
  dueIso: string | null,
  cal: LabCalendar
): { iso: string; name: string }[] {
  if (!receivedIso || !dueIso) return []
  return [...cal.holidays]
    .filter(([iso]) => iso > receivedIso && iso <= dueIso)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([iso, name]) => ({ iso, name }))
}

/* ---------------- bench order ---------------- */

/** expedited 0, high 1, everything else (default / normal / unknown) 2. */
export function priorityRank(priority: string | null | undefined): number {
  const p = (priority ?? '').toLowerCase()
  if (p === 'expedited') return 0
  if (p === 'high') return 1
  return 2
}

/**
 * Due date ascending, then priority, then the caller's order (stable).
 * Rows with no due date sort last. Applied identically to the drawer, the
 * bench sheet and the CSV so the three always agree.
 */
export function orderForBench<T>(
  items: T[],
  key: (t: T) => { due: string | null; priority: string | null | undefined }
): T[] {
  return items
    .map((t, i) => ({ t, i, k: key(t) }))
    .sort((a, b) => {
      const da = a.k.due ?? '9999-99-99'
      const db = b.k.due ?? '9999-99-99'
      if (da !== db) return da < db ? -1 : 1
      const pa = priorityRank(a.k.priority)
      const pb = priorityRank(b.k.priority)
      if (pa !== pb) return pa - pb
      return a.i - b.i
    })
    .map(x => x.t)
}

/* ---------------- display rounding ---------------- */

/** Microlitres: one decimal is as fine as anyone pipettes; trailing .0 dropped. */
export function fmtUl(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return ''
  return String(Math.round(v * 10) / 10)
}

/** Concentrations and millilitres: 3 decimals, trailing zeros dropped. */
export function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return ''
  return String(Math.round(v * 1000) / 1000)
}
