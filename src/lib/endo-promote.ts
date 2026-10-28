/**
 * Promote to Parent from Box 3 (spec 2026-10-12 sections 5.2 and 5.3): may
 * this row be promoted, and the numbers it sends. The server re-checks every
 * rule from stored data and stays the authority; this mirrors the rules the
 * browser can know, so a row it would refuse is not ticked. The reason texts
 * are the server's (backend/worksheets_endo_promote.py), byte for byte. The
 * server alone knows whether the parent already holds a result, and whether
 * an active spec exists for the unit; those come back per row after Promote.
 * Pure.
 */
import type { EndoPromoteRowIn, WorksheetListItem } from '@/lib/api'
import { fmt } from '@/lib/endo-prep'
import {
  BW_LIMIT_EU_PER_ML,
  LIMIT_EU_PER_VIAL,
  fmtEu,
  formOf,
  isBacWaterSample,
  prep2Check,
  prep2Result,
  type EndoCtx,
} from '@/lib/endo-prep-2ml'
import type { EndoRow } from '@/lib/endo-worksheet-2ml'

export type PromoteCheck =
  | { eligible: true; payload: EndoPromoteRowIn }
  | { eligible: false; reason: string }
  | { promoted: true }

/** The Mk1-native endotoxin service; SENAITE-born ENDO-LAL keeps manual entry (D2). */
const NATIVE_ENDO_KEYWORD = 'ENDOTOXIN-USP85LAL'
const OPEN_STATES = ['unassigned', 'assigned', 'to_be_verified']
/** Box 3 shows no checkbox at all for these rows (spec 5.1). */
export const SENAITE_BORN = 'manual entry: SENAITE-born endotoxin'
/** worksheets_endo_promote.REASON_GT, byte for byte. */
const REASON_GT =
  "a '>' reading reports only when the floor itself already fails, so " +
  're-run the vial at a higher dilution for a number'

const no = (reason: string): PromoteCheck => ({ eligible: false, reason })

/** The number as Box 3 shows it (3 decimals): what the analyst sees is sent (D6). */
const shown = (v: number): number => Number(fmt(v))

/**
 * Spec 5.2's rules: one live native endotoxin analysis, an open state, a
 * reading, not Invalid, not inconclusive, a "<" reading on the row's floor,
 * the unit the sample's form allows, then usable numbers. A "<" result sends
 * its LOQ as its value (the same number, so the server's value == loq check
 * holds exactly); `lod` is the row's cartridge sensitivity as stored, never
 * rounded. A ">" reading sends the floor with `result_floor`, and only when
 * it already fails: an inconclusive floor is refused here and by the server.
 */
export function promoteCheck(
  row: EndoRow,
  ctx: EndoCtx,
  endoPrep: WorksheetListItem['endo_prep']
): PromoteCheck {
  if (endoPrep !== '2ml') return no('promote is for 2 mL worksheets')
  const a = row.item.endo_analysis
  if (!a) return no('the vial has no endotoxin analysis')
  if (!a.native || a.keyword !== NATIVE_ENDO_KEYWORD) return no(SENAITE_BORN)
  if (a.state === 'promoted') return { promoted: true }
  if (!OPEN_STATES.includes(a.state))
    return no(`the vial's endotoxin analysis is ${a.state}`)
  const s = row.sample
  const rs = prep2Result(s, ctx)
  if (rs.value === null) return no('no reading')
  if (rs.verdict === 'invalid')
    return no(`Invalid: ${(s.reader?.why ?? []).join('; ')}`)
  const k = prep2Check(s, ctx)
  const bac = formOf(s) === 'bac'
  const unit = bac ? 'EU/mL' : 'EU/vial'
  const raw = bac ? rs.value : rs.euPerVial
  const value = raw === null ? null : shown(raw)
  const loqRaw = bac ? k.loqMl : k.loqVial
  const loq = rs.lt ? value : loqRaw === null ? null : shown(loqRaw)
  const limit = bac ? BW_LIMIT_EU_PER_ML : LIMIT_EU_PER_VIAL
  if (rs.verdict === 'inconclusive')
    return no(
      rs.gt
        ? // A floor reports only when it already fails, so there is nothing to
          // say about one that stops short of the limit.
          `inconclusive: a floor of ${fmt(value)} ${unit} does not reach the ${fmt(limit)} limit; ${REASON_GT}`
        : `inconclusive: LOQ ${fmt(loq)} ${unit} is above the ${fmt(limit)} limit`
    )
  if (rs.floorMismatch)
    return no(
      `the reading ${fmtEu(true, rs.value)} is not this cartridge's ${bac ? 'floor for bac water' : 'sensitivity'} (${fmt(rs.expectedFloor)})`
    )
  if (bac !== isBacWaterSample(s))
    return no(
      bac ? 'peptides promote in EU/vial' : 'bac water promotes in EU/mL'
    )
  const lod = row.cartridge?.sensitivity ?? null
  if (lod === null) return no('the row has no cartridge')
  if (
    (rs.verdict !== 'pass' && rs.verdict !== 'fail') ||
    value === null ||
    loq === null ||
    !(value >= 0 && loq > 0 && lod > 0)
  )
    return no('the value, LOQ or LOD does not match the worksheet row')
  // The server re-checks value and LOQ against the stored reading, within
  // 0.0005 + 1e-6 relative (final review I-3), so a stale tab is refused.
  return {
    eligible: true,
    payload: {
      item_id: row.item.id,
      value,
      unit,
      loq,
      lod,
      lod_unit: 'EU/mL',
      // The value is a floor, not a measurement: the certificate prints
      // "> value" and the spec engine judges it as "at least this much". The
      // server checks this against the stored reading, as it does the value.
      // Sent only when true, so an ordinary result's body is unchanged.
      ...(rs.gt ? { result_floor: true } : {}),
    },
  }
}
