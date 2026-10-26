/**
 * The endotoxin reader's export (EndoScan-V), parsed in the browser.
 *
 * Ported from tools-dennis/tools/endotoxin-log/calc.js at 5ef2a62
 * (parseEndoScan, baseSampleId, matchReaderTests, readerCartridge,
 * splitIdentity). Validity is judged against the worksheet method's run
 * parameters (spec 4.4), not the limits printed in the file; the record keeps
 * the file's limits beside that verdict. The cartridge is a sensitivity
 * matched against the consumables catalog by the caller (spec 8.3).
 * The file is untrusted input: anything that is not this export throws a
 * readable Error.
 */
import type { EndoReaderRecord, EndoRunParams } from '@/lib/endo-prep-2ml'

export interface ReaderTest {
  testId: string
  sampleId: string
  identity: string
  sampleType: string
  result: string
  lt: boolean
  /** The reader showed ">": above its top standard, so a floor not a value. */
  gt: boolean
  value: number | null
  sampleCv: number | null
  spikeCv: number | null
  cvLimit: number | null
  recovery: number | null
  recMin: number | null
  recMax: number | null
  spikeLevel: number | null
  readerPass: boolean | null
  operator: string | null
  testedAt: string | null
  reader: string | null
  slot: number | null
  tempStart: number | null
  tempEnd: number | null
  cartLot: string | null
  cartExpiry: string | null
  cartRange: string | null
  software: string | null
}

/**
 * The columns (0-based) the sheet reads, decoded by Dennis from his export of
 * 2026-10-09 (PTS150 V11.1.x): four rows per test, channels 1 and 3 the sample
 * (SPL1), 2 and 4 the spike (SPK1), then a "_Cartridge" line.
 */
const ES = {
  channel: 0,
  recMin: 6, // spike recovery acceptance, % (on the spike rows)
  recMax: 7,
  kind: 10, // "SPL1" sample, "SPK1" spike
  // 11-13 are the operator's free-text fields; see idFields for their order
  identity: 11,
  sampleType: 12,
  sampleId: 13,
  spikeLevel: 16, // EU/mL spiked, on the spike rows
  recovery: 18, // spike recovery, %, on the spike rows
  cv: 22, // CV of the two channels' onset times, %
  cvLimit: 24,
  resultQual: 26, // "<"
  result: 27, // EU/mL; the spike's reading on spike rows
  samplePass: 28, // the reader's own pass flags, 1 / 0
  spikePass: 29,
  cartRange: 31,
  software: 39,
  cartLot: 44,
  operator: 66,
  testedAt: 67,
  reader: 70, // the reader's serial
  tempStart: 71,
  tempEnd: 72,
  testId: 73,
  slot: 75,
} as const

/** Comma CSV: quotes and doubled quotes, CR tolerated, cells trimmed, blank rows dropped. */
function splitCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (inQuote) {
      if (ch !== '"') cur += ch
      else if (text.charAt(i + 1) === '"') {
        cur += '"'
        i++
      } else inQuote = false
    } else if (ch === '"') inQuote = true
    else if (ch === ',') {
      row.push(cur)
      cur = ''
    } else if (ch === '\n') {
      row.push(cur)
      rows.push(row)
      row = []
      cur = ''
    } else if (ch !== '\r') cur += ch
  }
  row.push(cur)
  rows.push(row)
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''))
}

const cell = (r: string[], i: number): string => r[i] ?? ''
const text = (r: string[], i: number): string | null => cell(r, i) || null

function num(v: string): number | null {
  return v !== '' && Number.isFinite(Number(v)) ? Number(v) : null
}

/**
 * The slot is the number after the last "/" of its cell ("9999 - MCS
 * 0000001/1" is slot 1), or a bare number; else null.
 */
function slotOf(v: string): number | null {
  const m = /\/\s*(\d+)$/.exec(v) ?? /^(\d+)$/.exec(v)
  return m ? Number(m[1]) : null
}

/**
 * A lab sample ID: P-5309, PB-1075-S02, BW-0156-S02, P-5309-R01. Only the
 * lab's prefixes and 4+ digits, so a peptide name (BPC-157, PT-141, AOD-9604,
 * CJC-1295) is never taken for one.
 */
const LAB_ID = /^(?:P|PB|BW)-\d{4,}(?:-[SR]\d{1,3})*$/i

/**
 * The Sample ID, identity and sample type from the operator's three free-text
 * fields (11-13). Their order depends on how the run was typed in: Dennis's
 * 2026-10-09 export has the identity, "Peptide", then the Sample ID; a
 * 2026-10-14 export has the Sample ID, the product, then a short name. The
 * Sample ID is the field shaped like a lab ID; with none, the third field, as
 * in the 10-09 layout.
 */
function idFields(r: string[]): {
  sampleId: string
  identity: string
  sampleType: string
} {
  const f = [cell(r, ES.identity), cell(r, ES.sampleType), cell(r, ES.sampleId)]
  const at = f.findIndex(v => LAB_ID.test(v))
  if (at === -1 || at === 2)
    return {
      sampleId: f[2] ?? '',
      identity: f[0] ?? '',
      sampleType: f[1] ?? '',
    }
  const rest = f.filter((_, i) => i !== at)
  return {
    sampleId: f[at] ?? '',
    identity: rest[0] ?? '',
    sampleType: rest[1] ?? '',
  }
}

const NOT_A_READER_EXPORT =
  'This is not a reader export: no test rows (channel 1-4, 79 columns) were found.'

export function parseEndoScan(input: string): {
  tests: ReaderTest[]
  cartridges: { range: string; lot: string; expiry: string; code: string }[]
} {
  const rows = splitCsv(input.replace(/^\uFEFF/, ''))
  // the "_Cartridge" line repeats after every test: one entry per lot
  const cartridges: {
    range: string
    lot: string
    expiry: string
    code: string
  }[] = []
  for (const r of rows) {
    if (cell(r, 0) !== '_Cartridge') continue
    const lot = cell(r, 2)
    if (!cartridges.some(c => c.lot === lot))
      cartridges.push({
        range: cell(r, 1),
        lot,
        expiry: cell(r, 3).slice(0, 10),
        code: cell(r, 4),
      })
  }
  const data = rows.filter(
    r => /^[1-4]$/.test(cell(r, ES.channel)) && r.length > ES.slot
  )
  if (!data.length) throw new Error(NOT_A_READER_EXPORT)
  const byTest = new Map<string, string[][]>()
  for (const r of data) {
    const id = cell(r, ES.testId)
    const list = byTest.get(id)
    if (list) list.push(r)
    else byTest.set(id, [r])
  }
  const tests: ReaderTest[] = []
  for (const [testId, rs] of byTest) {
    const spl = rs.find(r => cell(r, ES.kind) === 'SPL1')
    const spk = rs.find(r => cell(r, ES.kind) === 'SPK1')
    if (!spl || !spk) continue
    const qual = cell(spl, ES.resultQual)
    const raw = cell(spl, ES.result)
    const lt = qual === '<'
    const gt = qual === '>'
    // "" (a number), "<" and ">" are understood; anything else stays in the
    // reading verbatim and is never a number. A ">" keeps its number: the
    // worksheet judges it as "at least this much" (Handler ruling 2026-10-26).
    const understood = qual === '' || lt || gt
    const value = understood ? num(raw) : null
    const lot = cell(spl, ES.cartLot)
    const cart = cartridges.find(c => c.lot === lot)
    tests.push({
      testId,
      ...idFields(spl),
      result: understood && value === null ? '' : qual + raw,
      lt,
      gt,
      value,
      sampleCv: num(cell(spl, ES.cv)),
      spikeCv: num(cell(spk, ES.cv)),
      cvLimit: num(cell(spl, ES.cvLimit)),
      recovery: num(cell(spk, ES.recovery)),
      recMin: num(cell(spk, ES.recMin)),
      recMax: num(cell(spk, ES.recMax)),
      spikeLevel: num(cell(spk, ES.spikeLevel)),
      readerPass:
        cell(spl, ES.samplePass) === '1' && cell(spk, ES.spikePass) === '1',
      operator: text(spl, ES.operator),
      testedAt: text(spl, ES.testedAt),
      reader: text(spl, ES.reader),
      slot: slotOf(cell(spl, ES.slot)),
      tempStart: num(cell(spl, ES.tempStart)),
      tempEnd: num(cell(spl, ES.tempEnd)),
      cartLot: lot || null,
      cartExpiry: cart?.expiry || null,
      cartRange: text(spl, ES.cartRange),
      software: text(spl, ES.software),
    })
  }
  // channel rows without a sample/spike pair are a wrong or shifted file too
  if (!tests.length) throw new Error(NOT_A_READER_EXPORT)
  return { tests, cartridges }
}

/**
 * Valid when the spike recovery is inside the METHOD's range and both CVs are
 * within the METHOD's limit (spec 4.4). A missing recovery or CV fails closed,
 * the same rule and wording as the server's reader_validity
 * (backend/worksheets_endo.py), which decides on import. The reader's own
 * flags stay in readerPass, so a disagreement shows.
 */
export function readerValidity(
  t: ReaderTest,
  params: EndoRunParams
): { valid: boolean; why: string[] } {
  const min = params.spikeRecoveryMinPct
  const max = params.spikeRecoveryMaxPct
  const cv = params.cvLimitPct
  const why: string[] = []
  if (t.recovery === null) why.push('no spike recovery')
  else if (t.recovery < min || t.recovery > max)
    why.push(`spike recovery ${t.recovery} % outside ${min}-${max} %`)
  if (t.sampleCv === null) why.push('no sample CV')
  else if (t.sampleCv > cv) why.push(`sample CV ${t.sampleCv} % over ${cv} %`)
  if (t.spikeCv === null) why.push('no spike CV')
  else if (t.spikeCv > cv) why.push(`spike CV ${t.spikeCv} % over ${cv} %`)
  return { valid: why.length === 0, why }
}

/** The record stored on the item (spec 8.4); the server adds imported_at and _by. */
export function toReaderRecord(
  t: ReaderTest,
  params: EndoRunParams,
  fileName: string
): EndoReaderRecord {
  const { valid, why } = readerValidity(t, params)
  return {
    test_id: t.testId,
    result: t.result,
    reader: t.reader,
    slot: t.slot,
    operator: t.operator,
    tested_at: t.testedAt,
    temp_start: t.tempStart,
    temp_end: t.tempEnd,
    software: t.software,
    cartridge_lot: t.cartLot,
    cartridge_expiry: t.cartExpiry,
    cartridge_range: t.cartRange,
    spike_level: t.spikeLevel,
    recovery: t.recovery,
    rec_min: t.recMin, // the file's limits, kept beside the method's verdict
    rec_max: t.recMax,
    sample_cv: t.sampleCv,
    spike_cv: t.spikeCv,
    cv_limit: t.cvLimit,
    reader_pass: t.readerPass,
    valid,
    why,
    file_name: fileName,
  }
}

/** The cartridge range ("5 - 0.05") as its sensitivity, the lower bound; else null. */
export function readerCartridgeLambda(range: string | null): number | null {
  const nums = (range ?? '').match(/\d+(?:\.\d+)?|\.\d+/g)
  if (!nums) return null
  const low = Math.min(...nums.map(Number))
  return low > 0 ? low : null
}

/**
 * A sample ID without its vial suffix: "P-5309-S02" -> "P-5309". Only a vial
 * (-S<NN>) comes off; a retest (-R<NN>) is a sample of its own, never a vial
 * of its parent.
 */
export function baseSampleId(id: string): string {
  return id
    .trim()
    .toUpperCase()
    .replace(/-S\d{1,3}$/, '')
}

type Found =
  | { test: ReaderTest; via: 'exact' | 'parent'; itemId: number }
  | { test: ReaderTest; via: 'none' | 'ambiguous'; itemId: null }

function findRow(
  test: ReaderTest,
  rows: { itemId: number; sampleId: string }[]
): Found {
  const id = test.sampleId.trim().toUpperCase()
  if (!id) return { test, via: 'none', itemId: null }
  const sids = rows.map(r => ({ ...r, sid: r.sampleId.trim().toUpperCase() }))
  const exact = sids.filter(r => r.sid === id)
  if (exact.length > 1) return { test, via: 'ambiguous', itemId: null }
  if (exact[0]) return { test, via: 'exact', itemId: exact[0].itemId }
  const base = baseSampleId(id)
  // the parent ID, when one side is the bare parent: two different vials of
  // one parent are never paired
  const loose = sids.filter(
    r =>
      r.sid && baseSampleId(r.sid) === base && (r.sid === base || id === base)
  )
  if (loose.length > 1) return { test, via: 'ambiguous', itemId: null }
  if (loose[0]) return { test, via: 'parent', itemId: loose[0].itemId }
  return { test, via: 'none', itemId: null }
}

/**
 * Pairs each reader test with a worksheet row by Sample ID (Dennis
 * 2026-10-09): an exact ID first; otherwise the parent ID when exactly one
 * row fits; never a guess between two vials. A row tested twice takes an
 * exact-ID test over a parent-ID one, then the latest test (a tie goes to the
 * later one in the file; a time that does not parse ranks below any that
 * does); the other tests are listed in `superseded`.
 */
export function matchReaderTests(
  tests: ReaderTest[],
  rows: { itemId: number; sampleId: string }[]
): {
  matched: { test: ReaderTest; itemId: number; via: 'exact' | 'parent' }[]
  unmatched: ReaderTest[]
  ambiguous: ReaderTest[]
  superseded: ReaderTest[]
} {
  const found = tests.map(t => findRow(t, rows))
  const at = (t: ReaderTest): number => {
    const ms = Date.parse(t.testedAt ?? '')
    return Number.isNaN(ms) ? -Infinity : ms
  }
  const rank = (f: Found): number => (f.via === 'exact' ? 1 : 0)
  const latest = new Map<number, Found>()
  for (const f of found) {
    if (f.itemId === null) continue
    const prev = latest.get(f.itemId)
    const keep =
      prev &&
      (rank(prev) !== rank(f)
        ? rank(prev) > rank(f)
        : at(prev.test) > at(f.test))
    if (!keep) latest.set(f.itemId, f)
  }
  const matched: {
    test: ReaderTest
    itemId: number
    via: 'exact' | 'parent'
  }[] = []
  const unmatched: ReaderTest[] = []
  const ambiguous: ReaderTest[] = []
  const superseded: ReaderTest[] = []
  for (const f of found) {
    if (f.itemId === null) {
      if (f.via === 'none') unmatched.push(f.test)
      else ambiguous.push(f.test)
    } else if (latest.get(f.itemId) === f)
      matched.push({ test: f.test, itemId: f.itemId, via: f.via })
    else superseded.push(f.test)
  }
  return { matched, unmatched, ambiguous, superseded }
}

/**
 * Mk1's inbox export writes a vial's identity as "<product> - <the vial's
 * test>" ("Retatrutide - Identity (HPLC)"). Cuts a trailing spaced dash plus
 * a bracketed assay off; "CJC-1295 no DAC" and "BPC-157, TB500 (Thymosin
 * Beta 4)" stay whole.
 */
export function splitIdentity(raw: string): {
  product: string
  label: string | null
} {
  const s = raw.trim()
  const m =
    /^(.*\S)\s+[-\u2013]\s+([A-Za-z][A-Za-z /&+]*\((?:HPLC|UPLC|LC-?MS|MS|LAL|PCR|qPCR|KF|GC|ICP-?MS|Endo[^)]*|[A-Z][A-Za-z0-9-]{1,7})\))\s*$/.exec(
      s
    )
  return m?.[1] && m[2]
    ? { product: m[1], label: m[2] }
    : { product: s, label: null }
}
