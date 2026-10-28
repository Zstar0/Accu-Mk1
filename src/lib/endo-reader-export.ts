/**
 * The EndoScan-V Sample Database CSV: the file the reader imports before a
 * 2 mL run, so every vial is already set up with its limit when the plate is
 * read. The mirror of `endo-reader.ts`, which reads the reader's results back.
 *
 * Ported from Dennis's `tools/endotoxin-log/calc.js` (ValenceAnalytical/
 * tools-dennis @ ab866a2, the 10-14 to 10-19 export work). The field list,
 * the 40-character caps and the comma rule are his, learned from what the
 * real importer rejected; the prep numbers come from Mk1's own `prep2Check`
 * and `dilutionPlan`, so the file and the worksheet can never disagree.
 */
import { fmt, fmtUl } from './endo-prep'
import { splitIdentity } from './endo-reader'
import {
  BW_DILUTION,
  BW_LIMIT_EU_PER_ML,
  dilutionPlan,
  formOf,
  prep2Check,
  type EndoCtx,
  type EndoSample,
} from './endo-prep-2ml'

/** The 13 columns the importer reads, in its order (manual 4.3.1). */
export const ENDOSCAN_FIELDS = [
  'Product Family',
  'Sample Name',
  'Sample ID',
  'Max. Dosage',
  'Units',
  'Dil./Conc.',
  'Endotoxin Limit',
  'EU Criteria',
  'Alert Limit',
  'Auto Spike',
  'Spike Conc.',
  'Performed With',
  'Comments',
] as const

export type EndoscanField = (typeof ENDOSCAN_FIELDS)[number]
export type EndoscanRow = Record<EndoscanField, string>

/** The bac water tube: 1000 uL loaded, sample plus LAL water. */
const CARTRIDGE_UL = 1000

/**
 * The manual gives Product Family 40 and Sample ID 120, but the importer
 * rejected a 45-character Sample ID (2026-10-16) as it had 48-character
 * families (2026-10-14), so both are capped at 40.
 */
const ENDOSCAN_FAMILY_MAX = 40

/** The lab's own short names for the two blends it runs most. */
const BLEND_NICKNAMES: { name: string; parts: string[] }[] = [
  { name: 'KLOW', parts: ['kpv', 'ghk-cu', 'bpc-157', 'tb500'] },
  { name: 'GLOW', parts: ['ghk-cu', 'bpc-157', 'tb500'] },
]

/** The reader's text is ASCII: the micro sign becomes a plain "u". */
export function noMicro(s: string | null | undefined): string {
  return String(s ?? '').replace(/µ|μ/g, 'u')
}

function normProduct(text: string | null | undefined): string {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/**
 * "KLOW" or "GLOW" when the identity names exactly that blend's parts, in any
 * order and with any bracketed descriptors; null for anything else.
 */
export function blendNickname(identity: string | null | undefined): string | null {
  const parts = String(identity ?? '')
    .split(/,|\s\+\s/)
    .map(p => normProduct(p.replace(/\([^)]*\)/g, '')).replace(/\s+/g, ''))
    .filter(Boolean)
    .sort()
  for (const b of BLEND_NICKNAMES) {
    const want = b.parts.slice().sort()
    if (parts.length === want.length && parts.every((p, i) => p === want[i])) {
      return b.name
    }
  }
  return null
}

/** Cut to 40 characters at a word, never ending on an open bracket. */
export function endoscanFamily(product: string | null | undefined): string {
  // Measured as it will be WRITTEN, not as it arrives. endoscanCsvField turns
  // each ", " into " + ", one character longer, so a 39 or 40 character comma
  // blend reached the reader at 41+ and was rejected: the very thing this cap
  // exists to stop. Flattening first also makes the later endoscanCsvField a
  // no-op on this field, since no comma is left and the apostrophe guard does
  // not fire on its own output.
  const p = endoscanCsvField(product)
  if (p.length <= ENDOSCAN_FAMILY_MAX) return p
  const cut = p.slice(0, ENDOSCAN_FAMILY_MAX)
  const at = Math.max(cut.lastIndexOf(' + '), cut.lastIndexOf(', '), cut.lastIndexOf(' '))
  let out = at > 10 ? cut.slice(0, at) : cut
  if (out.split('(').length > out.split(')').length) {
    out = out.slice(0, out.lastIndexOf('('))
  }
  return out.replace(/[\s,+]+$/, '')
}

/**
 * EndoScan-V splits on every comma and ignores quotes (a blend
 * "Pinealon - Identity (HPLC), DSIP" pushed every later column one place,
 * 2026-10-15), so a comma inside a field becomes " +", the lab's other blend
 * separator, and nothing is quoted.
 */
export function endoscanCsvField(v: string | null | undefined): string {
  const flat = noMicro(v)
    .replace(/\s*,\s*/g, ' + ')
    .replace(/["\r\n]/g, ' ')
    .trim()
  // Defused as `csvField` in endo-bench-sheet.ts does, in case the file is
  // opened in a spreadsheet on the way to the reader. The apostrophe, not a
  // quote: EndoScan-V ignores quotes. No vial ID, product or number we write
  // starts with one of these, so this never fires on a real row.
  return /^[=+\-@\t\r]/.test(flat) ? `'${flat}` : flat
}

export interface EndoscanSkip {
  sampleId: string
  why: string
}

/**
 * One row per vial, in worksheet order. A row the reader could not use is
 * left out and named in `skipped` rather than written wrong.
 */
/**
 * The limit as the reader must read it: never ABOVE the real cut. `fmt` rounds
 * to nearest, so 350 / (3 mL x 250) = 0.46667 was written "0.467" and the
 * instrument, told "<= 0.467", passed a vial Mk1 fails at 350.25 EU/vial.
 * Rounding down can only make the reader stricter than Mk1, never laxer, which
 * is the safe direction: a false fail costs a re-run, a false pass ships.
 * This is a deliberate divergence from Dennis's tool, which rounds to nearest.
 */
function endoscanLimit(failAt: number): string {
  return fmt(Math.floor(failAt * 1000) / 1000)
}

export function endoscanSampleRows(
  samples: EndoSample[],
  ctx: EndoCtx
): { rows: EndoscanRow[]; skipped: EndoscanSkip[] } {
  const rows: EndoscanRow[] = []
  const skipped: EndoscanSkip[] = []
  const seen = new Set<string>()
  for (const s of samples) {
    const id = String(s.sampleId ?? '').trim()
    if (!id) {
      skipped.push({ sampleId: '', why: 'no Sample ID' })
      continue
    }
    // Sample Name is the database key: EndoScan-V rejects a second row with
    // the same vial ID as a duplicate, so it is left out here and named.
    if (seen.has(id.toUpperCase())) {
      skipped.push({
        sampleId: id,
        why: 'already in the file - EndoScan-V rejects a second row with the same vial ID',
      })
      continue
    }
    // seen.add is deliberately NOT here: a row that is skipped below must not
    // take the ID, or a later writable row for the same vial is dropped too
    // and told, wrongly, that it is "already in the file".
    const k = prep2Check(s, ctx)
    const base: EndoscanRow = {
      'Product Family': '',
      'Sample Name': id,
      'Sample ID': '',
      'Max. Dosage': '0',
      Units: 'mL/mL',
      'Dil./Conc.': '1:1',
      'Endotoxin Limit': '',
      'EU Criteria': '≤',
      'Alert Limit': '',
      'Auto Spike': 'Yes',
      'Spike Conc.': '',
      'Performed With': 'LAL',
      Comments: '',
    }
    if (formOf(s) === 'bac') {
      const f = BW_DILUTION
      const sampleUl = CARTRIDGE_UL / f
      rows.push({
        ...base,
        'Product Family': 'Bacteriostatic Water',
        'Sample ID': 'Bacteriostatic Water',
        'Dil./Conc.': '1:' + fmt(f),
        'Endotoxin Limit': fmt(BW_LIMIT_EU_PER_ML),
        Comments:
          fmtUl(sampleUl) + ' + ' + fmtUl(CARTRIDGE_UL - sampleUl) + ' uL LAL water',
      })
      seen.add(id.toUpperCase())
      continue
    }
    if (k.failAt === null) {
      skipped.push({
        sampleId: id,
        why:
          k.water === null
            ? 'a liquid vial with no volume typed'
            : 'the dilution cannot be made as typed',
      })
      continue
    }
    const plan = dilutionPlan(s, ctx)
    // Comments take 60 characters: the product, its total and the water (the
    // steps are on the worksheet and the printout).
    const steps =
      plan && plan.total !== null ? '1:' + fmt(plan.total) + ' in ' + fmt(k.water) + ' mL' : ''
    // An identity stored before the blend fix may still carry its assay label.
    const clean = splitIdentity(String(s.identity ?? '')).product
    const product = blendNickname(clean) ?? noMicro(clean)
    rows.push({
      ...base,
      'Product Family': 'Peptides',
      'Sample ID': endoscanFamily(product),
      'Endotoxin Limit': endoscanLimit(k.failAt),
      Comments: steps,
    })
    seen.add(id.toUpperCase())
  }
  return { rows, skipped }
}

/** UTF-8 with a byte-order mark (Excel's "CSV UTF-8"), CRLF, comma. */
export function endoscanSampleCsv(
  samples: EndoSample[],
  ctx: EndoCtx
): { csv: string; count: number; skipped: EndoscanSkip[] } {
  const { rows, skipped } = endoscanSampleRows(samples, ctx)
  const lines = [ENDOSCAN_FIELDS.join(',')].concat(
    rows.map(r => ENDOSCAN_FIELDS.map(f => endoscanCsvField(r[f])).join(','))
  )
  return { csv: '﻿' + lines.join('\r\n') + '\r\n', count: rows.length, skipped }
}
