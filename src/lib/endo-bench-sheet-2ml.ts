/**
 * The 2 mL endotoxin bench sheet, its summary page and its CSV (spec
 * 2026-10-10 section 7), beside the stock sheet in endo-bench-sheet.ts,
 * which is unchanged.
 *
 * Ported from buildPrintDoc and the 2 mL CSV export in
 * tools-dennis/tools/endotoxin-log/endotoxin.html at 5ef2a62: the columns
 * (#, Due with the priority pill under it, Cart., Order #, Sample ID,
 * Peptide with declared mg, Recon water, the three steps, Made, MCS), rows
 * grouped by total with a rule per group and numbered as Box 1, the marks
 * (a value set by hand bold and underlined, a non-standard step boxed in its
 * colour with its ratio, a step over the 1.5 mL tube or unmakeable boxed in
 * red, bac water one "50 + 950" cell), the summary page and his page fitter.
 * From 8fae7bb: neighbouring steps with the same non-standard volumes share
 * one outline. From efbc160 (slice 5): a ratio a method rule set prints
 * "1:15 · rule" ("rule (trial)" while the line is on trial), boxed as any
 * step off the standard is, a cartridge a rule set carries a small R, and
 * the summary lists the rules used; Mk1 adds a special-prep row's note under
 * its peptide.
 * Left out: his blend notes (a rule here keys on a catalog peptide, which a
 * blend never has), his print hint and auto-print script (Mk1 prints
 * through printHtmlDocument) and his em dashes. Made and MCS print empty
 * for the pen, as on the stock sheet.
 *
 * Pure string building; every value goes through escapeHtml.
 */
import type { ConsumableType, WorksheetListItem } from '@/lib/api'
import {
  ENDO_SHEET_ROWS_PER_PAGE,
  PREVIEW_CSS,
  PRIORITY_LABEL,
  SHEET_CSS,
  csvField,
  escapeHtml,
  longDate,
  priorityKey,
  shortDate,
} from '@/lib/endo-bench-sheet'
import { fmt, fmtUl, holidaysBetween, labDate } from '@/lib/endo-prep'
import {
  BW_DILUTION,
  TUBE_UL,
  dilutionPlan,
  fmtConc,
  fmtEu,
  formOf,
  mk1Value,
  waterRuled,
  orderByTotal,
  prep2Check,
  prep2Result,
  type EndoCheck,
  type EndoCtx,
  type EndoResult,
  type EndoSample,
  type EndoStepPlan,
} from '@/lib/endo-prep-2ml'
import { ruleTag, ruleText, type EndoPrepRule } from '@/lib/endo-prep-rules'
import { splitIdentity } from '@/lib/endo-reader'
import {
  BW_LAL_UL,
  BW_SAMPLE_UL,
  allowedCartridges,
  bacWaterLast,
  cartridgeLabel,
  endoCtxFor,
  endoRowsFor,
  runCartridgeFor,
  standardSteps,
  totalGroupKey,
} from '@/lib/endo-worksheet-2ml'
import {
  endoDueFor,
  endoIdentityFor,
  endoItemsInBenchOrder,
  shortOrder,
  type EndoSheetOptions,
} from '@/lib/endo-worksheet'

export interface EndoSheet2Row {
  /** The Box 1 row number, printed so a row can be found on screen. */
  n: number
  /** YYYY-MM-DD lab dates, or null. */
  due: string | null
  dueHoliday: boolean
  priority: string
  received: string | null
  order: string
  /** The identity as Mk1 holds it (CSV); the sheet prints `sample.identity`. */
  identityAsReceived: string
  /** The row as the 2 mL maths reads it, the identity cut to the product. */
  sample: EndoSample
  /** Slice 5: the row's rule is its lock (counted on the summary). */
  locked?: boolean
  /** Slice 5: a "no rule" row, and its special-prep note. */
  rulesOff?: boolean
  note?: string | null
  /** Slice 5: the cartridge came from the row's rule (its R). */
  cartridgeRuled?: boolean
}

export interface EndoSheet2Doc {
  title: string
  runName: string
  analyst: string
  dateMade: string
  orders: string
  printedAt: string
  /** The run cartridge's sensitivity (EU/mL), or null when none is set. */
  runLambda: number | null
  ctx: EndoCtx
  /** Rows in Box 1 (bench) order; the sheet regroups them by total. */
  rows: EndoSheet2Row[]
  holidayNotes: { iso: string; name: string }[]
  /** Slice 5: cartridge type id to its label, for the rules listed. */
  cartridgeLabels?: Record<number, string>
}

/** Text width in px for a CSS font shorthand (the fitter's ruler). */
export type TextMeasure = (text: string, font: string) => number

/**
 * Mk1's analyte names carry the " - Identity (HPLC)" service-title suffix
 * and the worksheet joins a blend's names with ", ", so the suffix is cut
 * from each analyte (splitIdentity on the whole string would cut only the
 * last one). Product names with their own dashes or brackets stay whole.
 */
export function productIdentity(raw: string): string {
  return raw
    .split(', ')
    .map(part => splitIdentity(part).product)
    .join(', ')
}

/**
 * The 2 mL sheet's document for a worksheet as GET /worksheets/{id} serves
 * it: its endo rows in Box 1 order through endoRowsFor (so paper and screen
 * resolve the same cartridge), each with its due date, and the run cartridge.
 * `catalog` is the allowed list's source when no method resolves; `rules`
 * the live rule lines, which reach the rows that are not locked yet.
 */
export function buildEndoSheet2Doc(
  ws: WorksheetListItem,
  opts: EndoSheetOptions,
  catalog: ConsumableType[] = [],
  rules: EndoPrepRule[] = []
): EndoSheet2Doc {
  const cal = opts.calendar
  const holidays = new Map<string, string>()
  const orders = new Set<string>()
  const bench = bacWaterLast(
    endoItemsInBenchOrder(ws.items, opts.dueAtByItemId, cal)
  )
  const resolved = endoRowsFor(bench, ws, catalog, rules)
  const rows: EndoSheet2Row[] = resolved.map(r => {
    const item = r.item
    const received = cal ? labDate(item.date_received, cal) : null
    const due = endoDueFor(opts.dueAtByItemId.get(item.id), cal)
    const skipped = cal ? holidaysBetween(received, due, cal) : []
    for (const h of skipped) holidays.set(h.iso, h.name)
    const order = shortOrder(item.client_order_number)
    if (order) orders.add(order)
    const raw = endoIdentityFor(item)
    return {
      n: r.n,
      due,
      dueHoliday: skipped.length > 0,
      priority: item.priority,
      received,
      order,
      identityAsReceived: raw,
      sample: { ...r.sample, identity: productIdentity(raw) },
      locked: item.prep_rule != null,
      rulesOff: item.prep_rules_off === true,
      note: item.prep_note ?? null,
      cartridgeRuled: !!r.ruleCartridge && item.cartridge_type_id == null,
    }
  })
  const allowed = allowedCartridges(ws, catalog)
  const label = cartridgeLabel(allowed)
  return {
    title: ws.title,
    runName: `worksheet ${ws.id}`,
    analyst: opts.analystName,
    dateMade: (cal ? labDate(ws.created_at, cal) : null) ?? '',
    orders: [...orders].join(', '),
    printedAt: opts.printedAt,
    runLambda: runCartridgeFor(ws, catalog)?.sensitivity ?? null,
    ctx: endoCtxFor(ws, catalog),
    rows,
    holidayNotes: [...holidays].map(([iso, name]) => ({ iso, name })),
    cartridgeLabels: Object.fromEntries(allowed.map(c => [c.id, label(c.id)])),
  }
}

/* ---------------- the sheet ---------------- */

// Dennis's 2 mL additions to the sheet CSS (buildPrintDoc at 5ef2a62), after
// the stock SHEET_CSS. td.step.bad.diff is Mk1's: spec 7 boxes an over-tube
// step in red even when it is also off the standard.
const SHEET2_CSS = [
  'td.r,th.r{text-align:center}',
  "td.pep2{font:10pt/1.15 'Segoe UI',system-ui,-apple-system,Arial,sans-serif;color:#1F2A2E;white-space:normal;overflow-wrap:anywhere}",
  'td.pep2 .mg{display:block;margin-top:1pt;font:600 10pt/1.15 var(--num);color:#33474C;white-space:nowrap}',
  "td.due{line-height:1.15} td.due .duepill{display:block;margin-top:1pt;font:9.5pt/1.1 'Segoe UI',system-ui,-apple-system,Arial,sans-serif;white-space:nowrap} td.due .duepill .pill{padding:.5pt 4pt}",
  'td.cart{text-align:center;padding-left:2pt;padding-right:2pt} td.cart.set{font-weight:700} td.cart .pill{font-size:9.5pt;padding:1pt 3pt}',
  'td.step{font-family:var(--num);white-space:nowrap;line-height:1.1}',
  'td.step .pair{display:inline-flex;align-items:flex-end;gap:5pt}',
  'td.step .pc{display:inline-flex;flex-direction:column;align-items:center}',
  "td.step .cap{font:7.5pt 'Segoe UI',system-ui,sans-serif;color:#7C9095;line-height:1.1;white-space:nowrap}",
  'td.step .num{font-size:13pt;font-variant-numeric:tabular-nums slashed-zero}',
  'td.step .plus{font-size:13pt;color:#41595F}',
  'td.step.own .num{font-weight:700;text-decoration:underline;text-decoration-thickness:.75pt;text-underline-offset:2pt}',
  'td.step .rat{display:block;font-size:8.5pt;color:#41595F;font-weight:700;margin-top:1pt;white-space:normal;line-height:1.15}',
  'td.step.bad .rat{color:#8C2822}',
  'th .ratio{font-family:var(--num);font-weight:400;letter-spacing:0;text-transform:none;color:#41595F}',
  "sup.lmark{font:700 7pt 'Segoe UI',system-ui,sans-serif;color:#7A4FB5;margin-left:1pt;line-height:0;vertical-align:.6em}",
  'th.stepcol,td.step{border-left:.75pt solid #B8C8C8}',
  'th.stepcol.s1{color:#2F6DB5;border-top:3pt solid #2F6DB5} th.stepcol.s2{color:#2D7D4F;border-top:3pt solid #2D7D4F} th.stepcol.s3{color:#A2620F;border-top:3pt solid #A2620F}',
  'tbody tr td.step.s1{background:#EAF1FB} tbody tr td.step.s2{background:#E7F4EB} tbody tr td.step.s3{background:#FCF1E1}',
  'tbody tr:nth-child(even) td.step.s1{background:#DFE9F7} tbody tr:nth-child(even) td.step.s2{background:#DCEEE2} tbody tr:nth-child(even) td.step.s3{background:#F8E8D0}',
  'td.step .cap.c1{color:#2F6DB5;font-weight:700} td.step .cap.c2{color:#2D7D4F;font-weight:700} td.step .cap.c3{color:#A2620F;font-weight:700}',
  'td.step.bwcell{background:#F2F6F6}',
  'td.step.bwcell .rat{display:inline;margin:0 0 0 10pt;vertical-align:baseline}',
  'td.step .cap.cv{color:#7A4FB5;font-weight:700} td.step .pc.kv .num{color:#7A4FB5;font-weight:600}',
  'th.vial{color:#7A4FB5} td.vial{color:#7A4FB5;font-weight:600}',
  'th.vial,td.vial{padding-left:2pt;padding-right:10pt}',
  'td.step .pc.k1 .num{color:#2F6DB5;font-weight:600} td.step .pc.k2 .num{color:#2D7D4F;font-weight:600} td.step .pc.k3 .num{color:#A2620F;font-weight:600}',
  '.rules dt.s1{color:#2F6DB5} .rules dt.s2{color:#2D7D4F} .rules dt.s3{color:#A2620F}',
  '.tiles .tile.s1{border-top-color:#2F6DB5} .tiles .tile.s2{border-top-color:#2D7D4F} .tiles .tile.s3{border-top-color:#A2620F}',
  'th.aftersteps,td.aftersteps{border-left:.75pt solid #B8C8C8}',
  'td.own{font-weight:700;text-decoration:underline;text-decoration-thickness:.75pt;text-underline-offset:2pt}',
  'td.bad{outline:1.5pt solid #8C2822;outline-offset:-3pt;color:#8C2822}',
  // One outline per run of the same non-standard volumes (Dennis 8fae7bb):
  // every cell draws its sides, the run's first its top, its last its
  // bottom. Inset shadows add no height. An over-tube step keeps its own red
  // box and is never part of a run.
  'td.step.diff.s1{--dc:#2F6DB5} td.step.diff.s2{--dc:#2D7D4F} td.step.diff.s3{--dc:#A2620F}',
  'td.step.diff:not(.bad){box-shadow:inset 1.5pt 0 0 var(--dc),inset -1.5pt 0 0 var(--dc)}',
  'td.step.diff.dtop{box-shadow:inset 1.5pt 0 0 var(--dc),inset -1.5pt 0 0 var(--dc),inset 0 1.5pt 0 var(--dc)}',
  'td.step.diff.dbot{box-shadow:inset 1.5pt 0 0 var(--dc),inset -1.5pt 0 0 var(--dc),inset 0 -1.5pt 0 var(--dc)}',
  'td.step.diff.dtop.dbot{box-shadow:inset 1.5pt 0 0 var(--dc),inset -1.5pt 0 0 var(--dc),inset 0 1.5pt 0 var(--dc),inset 0 -1.5pt 0 var(--dc)}',
  'td.step.diff .pc:last-child .num{font-weight:700;font-size:11.5pt}',
  'td.step.diff .rat{color:#1F2A2E}',
  'td.step.bad.diff{outline:1.5pt solid #8C2822;outline-offset:-1.5pt}',
  'tr.newtotal td{box-shadow:inset 0 2pt 0 #41595F}',
  // a box that starts on a total's first row: the group line, then its top just under it
  'tr.newtotal td.step.diff.dtop{box-shadow:inset 0 2pt 0 #41595F,inset 1.5pt 0 0 var(--dc),inset -1.5pt 0 0 var(--dc),inset 0 3.5pt 0 var(--dc)}',
  'tr.newtotal td.step.diff.dtop.dbot{box-shadow:inset 0 2pt 0 #41595F,inset 1.5pt 0 0 var(--dc),inset -1.5pt 0 0 var(--dc),inset 0 3.5pt 0 var(--dc),inset 0 -1.5pt 0 var(--dc)}',
  '.tiles.six{gap:10pt;margin:10pt 0 12pt}.tiles.six .tile{padding:8pt 10pt 9pt}.tiles.six dd{font-size:20pt}.tiles.six .tunit{font-size:10pt}',
  '.page.summary.two .cols{margin-bottom:10pt}.page.summary.two .ruleshead{margin-bottom:6pt}',
  '.note.readnote{margin:0 0 10pt;font-size:9.5pt}.note.readnote b{color:#41595F}',
  '.rules.seven{gap:11pt 14pt}.rules.seven div{flex:1 1 84pt}',
  '.rules.seven dd{font-size:10.5pt;line-height:1.35}',
].join('')

// Slice 5 (Dennis efbc160, on paper only, so no dark variants): the R on a
// ruled cartridge, a special prep's line under its peptide at the name's
// own 10pt (so the fitter measures it as a name line), and the "Method
// rules used" list. Added only to a sheet with a rule or a special prep, so
// a sheet without stays byte for byte as before. The summary is not fitted,
// so the list keeps a fixed height: two rows of one line each, cut at the
// end with an ellipsis (the note goes first, the status and the rule's
// text last), and a summary that lists rules (.used) closes up the space
// around the read note. Rendered in Chromium's print layout, a summary of up
// to six due dates, a holiday note and four rules or more stays on one
// sheet (724 of 733 px) while the read note is at most two lines, as it is
// with all four of its sentences (the rule one is kept short for that);
// a third line, or a seventh due date, spills.
const SHEET2_RULES_CSS = [
  "sup.rmark{font:700 7pt 'Segoe UI',system-ui,sans-serif;color:#8F5A06;margin-left:1pt;line-height:0;vertical-align:.6em}",
  'td.pep2 .sp{display:block;margin-top:1pt;color:#8F5A06}',
  '.page.summary.used .cols{margin-bottom:6pt}.page.summary.used .readnote{margin-bottom:6pt}',
  '.usedrules{width:100%;margin:0 auto 6pt;page-break-inside:avoid;display:grid;grid-template-columns:1fr 1fr;gap:2pt 18pt}',
  '.usedrules div{font-size:9.5pt;line-height:1.2;color:#26424A;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.usedrules .rl{font-family:var(--num);font-weight:600;margin-left:6pt}',
  '.usedrules .rn{color:#7C9095;margin-left:6pt}.usedrules .more{color:#7C9095}',
  '.usedrules .st{display:inline-block;line-height:1.1;font-size:8.5pt;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:0 4pt;border:.75pt solid;border-radius:2pt}',
  '.usedrules .st.trial{color:#8F5A06;border-color:#BD8930;background:#FAEBD3}.usedrules .st.validated{color:#0D6E70;border-color:#7FB8B9;background:#EAF4F4}',
].join('')

/** The list's cells, two rows of two: past this many rules, the last cell
 *  says how many more there are. */
const RULES_LISTED = 4

// Dennis's 2 mL colgroup (sums to 100%). The fitter's column fractions
// below must match the Sample ID and Peptide widths.
const COLGROUP2 =
  '<colgroup>' +
  '<col style="width:3.22%"><col style="width:11.5%">' +
  '<col style="width:5.65%"><col style="width:5.75%"><col style="width:9.44%"><col style="width:9.47%">' +
  '<col style="width:5.4%">' +
  '<col style="width:13.79%"><col style="width:13.79%"><col style="width:13.79%">' +
  '<col style="width:4.1%"><col style="width:4.1%">' +
  '</colgroup>'

function thead2(std: EndoStepPlan[]): string {
  const ratio = (i: number) => escapeHtml(fmt(std[i]?.ratio))
  return (
    COLGROUP2 +
    '<thead><tr><th></th>' +
    '<th>Due &middot; priority<span class="u">SLA</span></th>' +
    '<th>Cart.<span class="u">EU/mL</span></th><th>Order #</th><th>Sample ID</th>' +
    '<th>Peptide<span class="u">declared mg</span></th>' +
    '<th class="r vial">Recon water<span class="u">mL</span></th>' +
    `<th class="stepcol s1">Step 1 &middot; Tris <span class="ratio">1:${ratio(0)}</span><span class="u">&micro;L</span></th>` +
    `<th class="stepcol s2">Step 2 &middot; Water <span class="ratio">1:${ratio(1)}</span><span class="u">&micro;L</span></th>` +
    `<th class="stepcol s3">Step 3 &middot; BG600 <span class="ratio">1:${ratio(2)}</span><span class="u">&micro;L</span></th>` +
    '<th class="c aftersteps">Made</th><th class="c">MCS</th>' +
    '</tr></thead>'
  )
}

// The caption over each number: what is taken, then what is added. Steps 2
// and 3 take from the step before, captioned in that step's colour.
const STEP_CAPS: [string, string][] = [
  ['sample', 'Tris'],
  ['step 1', 'water'],
  ['step 2', 'BG600'],
]

/** "sample + diluent" with its caption over each number (Dennis's pairPrint). */
function pair(
  a: number | null,
  capA: string,
  b: number | null,
  capB: string,
  colA = '',
  colB = ''
): string {
  const pc = (col: string) => `pc${col ? ` k${col}` : ''}`
  const cap = (col: string) => `cap${col ? ` c${col}` : ''}`
  return (
    `<span class="pair"><span class="${pc(colA)}"><span class="${cap(colA)}">${capA}</span><span class="num">${escapeHtml(fmtUl(a))}</span></span>` +
    '<span class="plus">+</span>' +
    `<span class="${pc(colB)}"><span class="${cap(colB)}">${capB}</span><span class="num">${escapeHtml(fmtUl(b))}</span></span></span>`
  )
}

/** A step whose volumes are not the standard's (Dennis's `diff`). */
function stepDiffers(st: EndoStepPlan, d: EndoStepPlan | undefined): boolean {
  if (!d) return false
  return (
    st.sampleUl !== d.sampleUl ||
    st.diluentUl === null ||
    d.diluentUl === null ||
    Math.abs(st.diluentUl - d.diluentUl) > 1e-9
  )
}

/** A ruled step's mark after its ratio: "rule", or "rule (trial)" while
 *  its line is on trial; '' for any other step. */
function ruleMark(
  st: EndoStepPlan,
  rule: EndoPrepRule | null | undefined
): string {
  return st.ruled && rule ? ruleTag(rule) : ''
}

/** A "no rule" row's line under its peptide; null for any other row. */
function specialPrepOf(r: EndoSheet2Row): string | null {
  if (!r.rulesOff) return null
  return r.note ? `special prep: ${r.note}` : 'special prep'
}

/** The Cart. cell: the cartridge, or a pill when the prep cannot read the limit. */
function cartPrint(k: EndoCheck): string {
  if (k.lambda === null) return ''
  if (k.valid !== false) return escapeHtml(fmt(k.lambda))
  return `<span class="pill ${k.needs !== null ? 'high' : 'expedited'}">${
    k.needs !== null ? `&rarr;&nbsp;${escapeHtml(fmt(k.needs))}` : 'invalid'
  }</span>`
}

/* ---------------- the page fitter (Dennis's fitRowPadding, 2 mL) ---------------- */

const PAGE_CONTENT_W = 1026 // 11in landscape minus the 4mm side margins
const PAGE_CONTENT_H = 732 // 8.5in minus the 11mm top and bottom margins
const SID2_COL = 0.0944 // the Sample ID column, as in COLGROUP2
const PEP2_COL = 0.0947 // the Peptide column, as in COLGROUP2
// the fallbacks of --num in SHEET_CSS
const NUM_FONTS =
  "Consolas, 'Cascadia Mono', 'DejaVu Sans Mono', ui-monospace, Menlo, 'Liberation Mono', monospace"
const SID_FONT = `16.67px ${NUM_FONTS}`
const SID_LINE_PX = 19.2 // one line of Sample ID at 12.5pt / 1.15
const PEP_FONT =
  "13.33px 'Segoe UI', system-ui, -apple-system, Arial, sans-serif"
const PEP_LINE_PX = 15.4 // one line of peptide name at 10pt / 1.15
const MG_TOP_PX = 96 / 72 // the 1pt top margin of the declared mg line
const DUE2_PX = 41 // the Due cell: the date over the priority pill
// Mk1, measured in Chromium's print layout (2026-10-12): a step cell with its
// note line is 51.4 px, 64.4 px when an over-tube note wraps to two lines.
// Each carries the 1.6 px the 42 px standard row has over its 40.4 px.
// Dennis had 58 for both.
const STEP_NOTE_PX = 53
const STEP_NOTE2_PX = 66
const STEP_COL = 0.1379 // a step column, as in COLGROUP2
const NOTE_FONT = `700 11.33px ${NUM_FONTS}`
const CHROME_FIRST = 162 // title, a one-line meta, column heads, page footer
const CHROME_CONT = 125 // continuation heading, column heads, page footer
const FIT_SAFETY = 10
const META_DT_FONT =
  "700 12px 'Segoe UI', system-ui, -apple-system, Arial, sans-serif"
const META_DT_TRACK = 1.44 // .12em of tracking per letter on the 9pt label
const META_DD_FONT =
  "600 17.33px 'Segoe UI', system-ui, -apple-system, Arial, sans-serif"
const META_LINE_PX = 24.27 + 2.67
const META_GAP = 32 // 24pt between meta items on a line
const META_LABEL_GAP = 8 // 6pt between a label and its value
const H_PAD_PX = ((5 * 96) / 72) * 2 + 2 // 5pt of side padding each side, plus 2px

let canvas: OffscreenCanvasRenderingContext2D | null | undefined

/**
 * Canvas text width where the runtime has one (Chromium, the Tauri
 * WebView2); else half an em per character.
 * ponytail: the fallback only runs without a canvas (jsdom); tests pass
 * their own `measure`.
 */
function defaultMeasure(text: string, font: string): number {
  if (canvas === undefined) {
    try {
      canvas =
        typeof OffscreenCanvas === 'undefined'
          ? null
          : new OffscreenCanvas(1, 1).getContext('2d')
    } catch {
      canvas = null
    }
  }
  if (canvas) {
    canvas.font = font
    return canvas.measureText(text).width
  }
  const px = Number(/([\d.]+)px/.exec(font)?.[1] ?? 14)
  return text.length * px * 0.5
}

/**
 * Lines a text wraps to: at spaces, and after a hyphen or a slash, but not a
 * slash or hyphen after a digit (Chrome keeps "1295/Ipamorelin" whole). A
 * piece wider than the line breaks between any two characters (td.pep2's
 * overflow-wrap), filled character by character as Chrome fills it; its last
 * part stays on the line for what follows.
 */
function lineCount(
  text: string,
  maxW: number,
  font: string,
  measure: TextMeasure
): number {
  if (!text) return 1
  let lines = 1
  let cur = ''
  const start = (piece: string) => {
    cur = piece
    if (measure(piece, font) <= maxW) return
    cur = ''
    for (const ch of piece) {
      const next = cur + ch
      if (cur && measure(next, font) > maxW) {
        lines++
        cur = ch
      } else cur = next
    }
  }
  for (const word of text.split(/\s+/))
    word.split(/(?<=[^\d][-/])/).forEach((piece, k) => {
      if (!cur) return start(piece)
      const next = `${cur}${k ? '' : ' '}${piece}`
      if (measure(next, font) <= maxW) cur = next
      else {
        lines++
        start(piece)
      }
    })
  return lines
}

/** Sample IDs have no spaces but may break at their hyphens. */
function sidLineCount(
  text: string,
  maxW: number,
  measure: TextMeasure
): number {
  if (!text) return 1
  const w = measure(text, SID_FONT)
  return w <= maxW ? 1 : Math.min(3, Math.ceil(w / maxW))
}

/** How many lines page one's meta strip wraps to (Dennis's metaLineCount). */
function metaLineCount(
  items: [string, string][],
  measure: TextMeasure
): number {
  let lines = 1
  let used = 0
  const room = PAGE_CONTENT_W - 4
  for (const [label, value] of items) {
    const lab = label.toUpperCase()
    const labelW =
      measure(lab, META_DT_FONT) + lab.length * META_DT_TRACK + META_LABEL_GAP
    const w = labelW + measure(value, META_DD_FONT)
    if (used && used + META_GAP + w <= room) {
      used += META_GAP + w
      continue
    }
    if (used) lines++
    if (w <= room) {
      used = w
      continue
    }
    lines += lineCount(value, room - labelW, META_DD_FONT, measure) - 1
    used = room
  }
  return lines
}

/**
 * A row's minimum height: two lines for the step cells (units over the
 * numbers), three when a step is off the standard or over the tube (its note
 * adds a line); the Peptide cell (name plus the declared mg, and a special
 * prep's line) and the Due cell can be taller still.
 */
function rowMinFor(
  s: EndoSample,
  ctx: EndoCtx,
  std: EndoStepPlan[],
  measure: TextMeasure,
  special: string | null = null
): number {
  const w = PAGE_CONTENT_W * PEP2_COL - H_PAD_PX
  const bac = formOf(s) === 'bac'
  const mg = !bac && s.weightMg !== null
  const pepLines =
    (s.identity ? lineCount(s.identity, w, PEP_FONT, measure) : 0) +
    (mg ? 1 : 0) +
    (special ? lineCount(special, w, PEP_FONT, measure) : 0)
  // Mk1: Dennis's stack leaves out the mg line's margin, about 1 px a row,
  // which overran the sheet on a page of wrapping names; the special prep
  // line has the same 1pt margin
  const stack = Math.max(
    DUE2_PX,
    pepLines * PEP_LINE_PX + (mg ? MG_TOP_PX : 0) + (special ? MG_TOP_PX : 0)
  )
  if (bac) return Math.max(42, stack)
  const p = dilutionPlan(s, ctx)
  const odd =
    !p.fits ||
    p.steps.some(
      (st, si) => st.ratio !== std[si]?.ratio || stepDiffers(st, std[si])
    )
  if (!odd) return Math.max(42, stack)
  // an over-tube note, or a ruled one ("1:15 · rule (trial)"), as stepPrint
  // prints it, can wrap under its numbers
  const noteW = PAGE_CONTENT_W * STEP_COL - H_PAD_PX
  const wraps = p.steps.some((st, si) => {
    const mark = ruleMark(st, s.rule)
    const note = !st.fits
      ? st.diluentUl !== null && !!st.sampleUl
        ? `1:${fmt(st.ratio)} \u00b7 over ${fmt(TUBE_UL / 1000)} mL`
        : ''
      : mark && (st.ratio !== std[si]?.ratio || stepDiffers(st, std[si]))
        ? `1:${fmt(st.ratio)} \u00b7 ${mark}`
        : ''
    return note !== '' && lineCount(note, noteW, NOTE_FONT, measure) > 1
  })
  return Math.max(wraps ? STEP_NOTE2_PX : STEP_NOTE_PX, stack)
}

// Dennis: the floor was 7 px; grouping by total can put ten three-line rows
// on one page, so 4 px, reached only on such a page.
const PAD_MIN = 4

/** A row's height without its padding: the taller of its cells and its Sample ID. */
function rowHeight(
  r: EndoSheet2Row,
  ctx: EndoCtx,
  std: EndoStepPlan[],
  measure: TextMeasure
): number {
  const sidW = PAGE_CONTENT_W * SID2_COL - H_PAD_PX
  return Math.max(
    rowMinFor(r.sample, ctx, std, measure, specialPrepOf(r)),
    sidLineCount(r.sample.sampleId, sidW, measure) * SID_LINE_PX
  )
}

/** Page `pageIx`'s heading, column heads and footer (px). */
function chromePx(pageIx: number, metaLines: number): number {
  return pageIx === 0
    ? CHROME_FIRST + (metaLines - 1) * META_LINE_PX
    : CHROME_CONT
}

/** The padding (px) that makes page `pageIx`, holding these rows, just fill the sheet. */
function padFor(heights: number[], pageIx: number, metaLines: number): number {
  let content = 0
  for (const h of heights) content += h
  const base = chromePx(pageIx, metaLines)
  const budget = PAGE_CONTENT_H - FIT_SAFETY - content
  return (budget - base) / (2 * heights.length)
}

/**
 * Where each page starts: ENDO_SHEET_ROWS_PER_PAGE rows, or fewer when the
 * next row would need less than the floor padding. Mk1: Dennis cuts every
 * ten rows, and ten tall rows ran page one's foot onto a sheet of its own.
 */
function pageStarts(heights: number[], metaLines: number): number[] {
  const starts = [0]
  heights.forEach((_, i) => {
    const at = starts[starts.length - 1] ?? 0
    if (
      i > at &&
      (i - at === ENDO_SHEET_ROWS_PER_PAGE ||
        padFor(heights.slice(at, i + 1), starts.length - 1, metaLines) <
          PAD_MIN)
    )
      starts.push(i)
  })
  return starts
}

/** Vertical padding (px) that makes the tallest page just fill the sheet. */
function fitRowPadding(
  heights: number[],
  starts: number[],
  metaLines: number
): number {
  let best = Infinity
  starts.forEach((at, i) => {
    const page = heights.slice(at, starts[i + 1])
    if (page.length) best = Math.min(best, padFor(page, i, metaLines))
  })
  if (!Number.isFinite(best)) best = 12
  return Math.max(PAD_MIN, Math.min(22, best))
}

const cartridgeOf = (doc: EndoSheet2Doc) =>
  doc.runLambda === null ? '-' : `${fmt(doc.runLambda)} EU/mL`

/** Page one's meta strip, as printed and as the fitter measures it. */
function metaItemsOf(doc: EndoSheet2Doc): [string, string][] {
  return [
    ['Analyst', doc.analyst || '-'],
    ['Cartridge', cartridgeOf(doc)],
    ['Date made', doc.dateMade ? longDate(doc.dateMade) : '-'],
    ['Samples', String(doc.rows.length)],
    ['Orders', doc.orders || '-'],
  ]
}

/** The fitter's layout: rows in print order, where pages start, the printed padding. */
function fitSheet(doc: EndoSheet2Doc, measure: TextMeasure) {
  const { ctx } = doc
  const std = standardSteps(ctx)
  const ordered = orderByTotal(doc.rows, r => r.sample, ctx)
  const metaItems = metaItemsOf(doc)
  const metaLines = metaLineCount(metaItems, measure)
  const heights = ordered.map(r => rowHeight(r, ctx, std, measure))
  const starts = pageStarts(heights, metaLines)
  // rounded down, so the printed padding never exceeds the fitted one
  const pad = Math.floor(fitRowPadding(heights, starts, metaLines) * 10) / 10
  return { std, ordered, metaItems, metaLines, heights, starts, pad }
}

export interface EndoSheet2Plan {
  /** Each row's estimated height (px) without its padding, in print order. */
  rowHeights: number[]
  /** Rows on each table page. */
  rows: number[]
  /** The printed row padding (px). */
  pad: number
  /** Each table page's estimated height (px) at that padding. */
  pageHeights: number[]
  /** What a page may fill: the printable height less the fitter's safety. */
  budget: number
}

/** How the sheet's table pages are cut and padded, as the fitter plans them. */
export function planEndoSheet2(
  doc: EndoSheet2Doc,
  measure: TextMeasure = defaultMeasure
): EndoSheet2Plan {
  const { metaLines, heights, starts, pad } = fitSheet(doc, measure)
  const pages = starts.map((at, i) => heights.slice(at, starts[i + 1]))
  return {
    rowHeights: heights,
    rows: pages.map(p => p.length),
    pad,
    pageHeights: pages.map(
      (p, i) =>
        chromePx(i, metaLines) + p.reduce((sum, h) => sum + h + 2 * pad, 0)
    ),
    budget: PAGE_CONTENT_H - FIT_SAFETY,
  }
}

/* ---------------- the document ---------------- */

export function buildEndoBenchSheet2Html(
  doc: EndoSheet2Doc,
  opts: { preview?: boolean; measure?: TextMeasure } = {}
): string {
  const { ctx } = doc
  const measure = opts.measure ?? defaultMeasure
  // Page breaks come first: a run's box closes at a page edge.
  const { std, ordered, metaItems, starts, pad } = fitSheet(doc, measure)
  const edges = new Set(starts)
  const keys = ordered.map(r => totalGroupKey(r.sample, ctx))
  const title = escapeHtml(doc.title)
  const name = escapeHtml(doc.runName)
  const stamp = escapeHtml(doc.printedAt)
  const analyst = escapeHtml(doc.analyst || '-')
  const cartridge = cartridgeOf(doc)
  const reconMl = ctx.params.reconWaterMl
  const tally = {
    tubes: 0,
    own: 0,
    odd: 0,
    typed: 0,
    liquid: 0,
    bac: 0,
    tris: 0,
    water: 0,
    bg: 0,
    ruled: 0,
  }
  const prio = { expedited: 0, high: 0, default: 0 }
  const dueGroups = new Map<string, number>()

  // Each row's plan, once (bac water's has no steps).
  const printed = ordered.map(r => ({ r, plan: dilutionPlan(r.sample, ctx) }))

  /**
   * A step's box (off the standard: Dennis's `diff`) and its run key: its
   * total and its volumes as printed; '' when it cannot join a run (standard,
   * unmakeable or over the tube, which keeps its own red box). Neighbours on
   * one page with the same key share one outline, so a new total, a page
   * edge or other volumes start a new box. A step a rule set is boxed too
   * (slice 5, Dennis): the box marks a non-standard tube, whoever set it.
   */
  function boxOf(st: EndoStepPlan, si: number, i: number) {
    const diff = stepDiffers(st, std[si])
    const run =
      diff && st.fits && st.diluentUl !== null && st.sampleUl
        ? `${keys[i]}|${fmtUl(st.sampleUl)}+${fmtUl(st.diluentUl)}`
        : ''
    return { diff, run }
  }
  const runKeys = printed.map(({ plan }, i) =>
    plan.steps.map((st, si) => boxOf(st, si, i).run)
  )

  function stepPrint(st: EndoStepPlan, si: number, i: number): string {
    const sn = si + 1
    if (st.diluentUl === null || !st.sampleUl)
      return `<td class="step bad s${sn}">cannot be made</td>`
    const d = std[si]
    const odd = d !== undefined && st.ratio !== d.ratio
    const { diff, run } = boxOf(st, si, i)
    const top = run !== '' && (edges.has(i) || runKeys[i - 1]?.[si] !== run)
    const bot = run !== '' && (edges.has(i + 1) || runKeys[i + 1]?.[si] !== run)
    const cls = `step${st.own ? ' own' : ''}${st.fits ? '' : ' bad'}${odd ? ' odd' : ''}${diff ? ' diff' : ''}${top ? ' dtop' : ''}${bot ? ' dbot' : ''} s${sn}`
    const ratio = escapeHtml(fmt(st.ratio))
    // the note is the ratio alone (Dennis, eb4ee43); "over 1.5 mL" for a step
    // that does not fit its tube; " · rule" after a ratio a rule set (efbc160)
    const mark = ruleMark(st, printed[i]?.r.sample.rule)
    const note = !st.fits
      ? `1:${ratio} &middot; over ${fmt(TUBE_UL / 1000)} mL`
      : odd || diff
        ? `1:${ratio}${mark ? ` &middot; ${escapeHtml(mark)}` : ''}`
        : ''
    if (odd || diff) tally.odd++
    if (st.fits && (odd || diff) && mark) tally.ruled++
    const [capA, capB] = STEP_CAPS[si] ?? ['sample', '']
    return (
      `<td class="${cls}">${pair(st.sampleUl, capA, st.diluentUl, capB, si ? String(si) : 'v', String(sn))}` +
      `${note ? `<span class="rat">${note}</span>` : ''}</td>`
    )
  }

  function rowPrint(
    r: EndoSheet2Row,
    plan: ReturnType<typeof dilutionPlan>,
    i: number
  ): string {
    const s = r.sample
    const k = prep2Check(s, ctx)
    const pk = priorityKey(r.priority)
    prio[pk]++
    if (r.due) dueGroups.set(r.due, (dueGroups.get(r.due) ?? 0) + 1)
    const bac = formOf(s) === 'bac'
    const weight = bac || s.weightMg === null ? '' : `${fmt(s.weightMg)} mg`
    // bold when the row runs on a cartridge other than the run's (bac water's
    // 0.01 is its rule, not an exception)
    const cartOwn =
      !bac &&
      s.lambda !== null &&
      doc.runLambda !== null &&
      s.lambda !== doc.runLambda
    const cartR = r.cartridgeRuled && k.lambda !== null
    if (cartR) tally.ruled++
    const special = specialPrepOf(r)
    const lead =
      `<tr${i > 0 && keys[i] !== keys[i - 1] ? ' class="newtotal"' : ''}>` +
      `<td class="n">${r.n}</td>` +
      `<td class="m due">${r.due ? escapeHtml(shortDate(r.due)) : ''}${r.dueHoliday ? '<sup>*</sup>' : ''}` +
      `<span class="duepill"><span class="pill ${pk}">${PRIORITY_LABEL[pk]}</span></span></td>` +
      `<td class="cart${cartOwn ? ' set' : ''}">${cartPrint(k)}${cartR ? '<sup class="rmark">R</sup>' : ''}</td>` +
      `<td class="m">${escapeHtml(r.order)}</td>` +
      `<td class="m sid">${escapeHtml(s.sampleId)}</td>` +
      `<td class="pep2">${escapeHtml(s.identity)}${weight ? `<span class="mg">${escapeHtml(weight)}</span>` : ''}` +
      `${special ? `<span class="sp">${escapeHtml(special)}</span>` : ''}</td>`
    const ticks =
      '<td class="c aftersteps"><span class="bx"></span></td><td class="c"><span class="bx"></span></td></tr>'
    if (bac) {
      tally.bac++
      tally.tubes++
      tally.water += BW_LAL_UL
      return (
        lead +
        '<td class="m r">-</td>' +
        `<td class="step bwcell" colspan="3">${pair(BW_SAMPLE_UL, 'sample', BW_LAL_UL, 'LAL water')}` +
        `<span class="rat">bac water &middot; 1:${fmtUl(BW_DILUTION)} &middot; one tube</span></td>` +
        ticks
      )
    }
    tally.tubes += plan.steps.length
    if (plan.total !== null) {
      tally.tris += plan.steps[0]?.diluentUl ?? 0
      tally.water += plan.steps[1]?.diluentUl ?? 0
      tally.bg += plan.steps[2]?.diluentUl ?? 0
    }
    const liquid = formOf(s) === 'liquid'
    // The EFFECTIVE water, not just a typed one: a rule's volume is off the
    // standard too, and the tech reads this sheet to know what to add. The
    // summary tile counts the SAME predicate the row underlines, so a run
    // whose only deviation came from a rule does not read "Off the standard:
    // 0", and a liquid's customer volume or a powder typed at the standard
    // does not read 1 with nothing underlined to show for it.
    const waterR = waterRuled(s)
    const waterOwn = !liquid && k.water !== null && k.water !== reconMl
    if (waterR) tally.ruled++
    if (!plan.standard || waterOwn) tally.own++
    if (liquid) tally.liquid++
    if (waterOwn || plan.steps.some(st => st.own)) tally.typed++
    return (
      lead +
      `<td class="m r vial${waterOwn ? ' own' : ''}">${k.water === null ? '' : escapeHtml(fmt(k.water))}` +
      `${waterR ? '<sup class="rmark">R</sup>' : ''}` +
      `${liquid ? '<sup class="lmark">L</sup>' : ''}</td>` +
      plan.steps.map((st, si) => stepPrint(st, si, i)).join('') +
      ticks
    )
  }

  // Rows render first: the summary below reads what they counted.
  const body = printed.map(({ r, plan }, i) => rowPrint(r, plan, i))
  const pages = starts.map((at, k) => body.slice(at, starts[k + 1]))
  const totalPages = pages.length + 1 // the table pages, plus the summary

  const meta =
    '<dl class="meta">' +
    metaItems
      .map(([l, v]) => `<div><dt>${l}</dt><dd>${escapeHtml(v)}</dd></div>`)
      .join('') +
    '</dl>'
  const footRight = (pageIx: number, chunkLen: number) => {
    const first = (starts[pageIx] ?? 0) + 1
    const last = (starts[pageIx] ?? 0) + chunkLen
    return (
      `<span>${chunkLen ? `Samples <b>${first}&ndash;${last}</b> of ${doc.rows.length} &middot; ` : ''}` +
      `<b>Page ${pageIx + 1} of ${totalPages}</b></span>`
    )
  }
  const footLeft = `<span>${title} &middot; ${name}${doc.analyst ? ` &middot; ${analyst}` : ''}</span>`

  const withRules = doc.rows.some(r => r.sample.rule || r.rulesOff)
  let out =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<title>${title} endotoxin prep</title><style>${SHEET_CSS}${SHEET2_CSS}${withRules ? SHEET2_RULES_CSS : ''}` +
    `td{padding:${pad.toFixed(1)}px 5pt}${opts.preview ? PREVIEW_CSS : ''}</style></head><body>`

  pages.forEach((chunk, pageIx) => {
    const of = `page ${pageIx + 1} of ${totalPages}`
    const header =
      pageIx === 0
        ? `<div class="top"><h1>${title}: endotoxin prep</h1>` +
          `<p class="stamp">${name}  &middot;  printed ${stamp}  &middot;  ${of}</p></div>` +
          meta
        : `<div class="cont">${title}: continued<span>${name}  &middot;  ${of}</span></div>`
    out +=
      `<section class="page">${header}<table>${thead2(std)}<tbody>${chunk.join('')}</tbody></table>` +
      `<div class="pagefoot">${footLeft}${footRight(pageIx, chunk.length)}</div></section>`
  })

  // ---------- the summary sheet: what you draw reagents against ----------
  const tile = (label: string, value: string, unit: string, cls = '') =>
    `<div class="tile${cls ? ` ${cls}` : ''}"><dt>${label}</dt><dd>${escapeHtml(value)}${unit ? `<span class="tunit">${unit}</span>` : ''}</dd></div>`
  const prioRow = (key: string, label: string, count: number) =>
    `<div class="priorow"><span class="pill ${key}">${label}</span><span class="dots"></span><span class="cnt">${count}</span></div>`
  const dueList = [...dueGroups.keys()]
    .sort()
    .map(
      k =>
        `<div class="duerow"><span>${escapeHtml(longDate(k))}</span><span class="dots"></span><span class="cnt">${dueGroups.get(k)}</span></div>`
    )
    .join('')
  const stdVol = (i: number) => {
    const d = std[i]
    return d
      ? `${fmtUl(d.sampleUl)} + ${fmtUl(d.diluentUl)} &micro;L &middot; 1:${fmt(d.ratio)}`
      : ''
  }
  const readnote =
    tally.typed || tally.odd || tally.liquid || tally.ruled
      ? '<p class="note readnote">' +
        (tally.liquid
          ? "<b>L</b> after the recon water: the vial arrived reconstituted; that is the customer's water, add nothing. "
          : '') +
        (tally.typed
          ? '<b>Underlined</b> figures were set for that sample, not the standard. '
          : '') +
        (tally.odd
          ? `A <b>boxed step</b> is not the standard prep: read its numbers and the ratio under them rather than assuming ${fmtUl(std[1]?.diluentUl)}. A line across the table starts the next total.`
          : '') +
        (tally.ruled
          ? ' Marked <b>rule</b> or <b>R</b>: a method rule set it.'
          : '') +
        '</p>'
      : ''
  // The lines this run used (Dennis efbc160): each with its status, the
  // rows it covered and how many of those hold it as their lock, and its
  // note.
  const cartLabel = (id: number) =>
    doc.cartridgeLabels?.[id] ?? `cartridge #${id}`
  const used = new Map<
    string,
    { rule: EndoPrepRule; line: string; rows: number; locked: number }
  >()
  for (const r of doc.rows) {
    const rule = r.sample.rule
    if (!rule) continue
    const line = ruleText(rule, r.sample.identity, cartLabel)
    const key = `${rule.id}|${line}`
    const u = used.get(key) ?? { rule, line, rows: 0, locked: 0 }
    u.rows++
    if (r.locked) u.locked++
    used.set(key, u)
  }
  const usedList = [...used.values()]
  const listed =
    usedList.length > RULES_LISTED ? RULES_LISTED - 1 : usedList.length
  const rulesUsed = usedList.length
    ? '<h2 class="ruleshead">Method rules used in this run</h2><div class="usedrules">' +
      usedList
        .slice(0, listed)
        .map(
          u =>
            `<div><span class="st ${escapeHtml(u.rule.status)}">${escapeHtml(u.rule.status)}</span>` +
            `<span class="rl">${escapeHtml(u.line)}</span>` +
            `<span class="rn">${u.rows} ${u.rows === 1 ? 'sample' : 'samples'}${u.locked ? ` (${u.locked} locked)` : ''}` +
            `${u.rule.note ? ` &middot; ${escapeHtml(u.rule.note)}` : ''}</span></div>`
        )
        .join('') +
      // two or more, so always "rules"
      (listed < usedList.length
        ? `<div class="more">and ${usedList.length - listed} more rules (see the Prep rules page)</div>`
        : '') +
      '</div>'
    : ''
  const holidayNote = doc.holidayNotes.length
    ? `<p class="note">* Due date pushed past ${escapeHtml(
        doc.holidayNotes
          .slice()
          .sort((a, b) => (a.iso < b.iso ? -1 : 1))
          .map(h => `${h.name} (${shortDate(h.iso)})`)
          .join(', ')
      )}. Weekends and lab holidays are not counted.</p>`
    : ''

  out +=
    `<section class="page summary two${rulesUsed ? ' used' : ''}">` +
    `<div class="cont">${title}: run summary<span>${name}  &middot;  printed ${stamp}</span></div>` +
    '<dl class="meta">' +
    `<div><dt>Analyst</dt><dd>${analyst}</dd></div>` +
    `<div><dt>Cartridge</dt><dd>${escapeHtml(cartridge)}</dd></div>` +
    `<div><dt>Date made</dt><dd>${escapeHtml(doc.dateMade ? longDate(doc.dateMade) : '-')}</dd></div>` +
    `<div><dt>Orders</dt><dd>${escapeHtml(doc.orders || '-')}</dd></div>` +
    '</dl>' +
    '<dl class="tiles six">' +
    tile('Samples', String(doc.rows.length), '') +
    tile('Off the standard', String(tally.own), '') +
    tile('0.1 M Tris', fmtUl(tally.tris), '&micro;L', 's1') +
    tile('LAL water', fmtUl(tally.water), '&micro;L', 's2') +
    tile('BG600', fmtUl(tally.bg), '&micro;L', 's3') +
    tile('1.5 mL tubes', String(tally.tubes), '') +
    '</dl>' +
    '<div class="cols">' +
    '<section class="col"><h2>Priority</h2>' +
    prioRow('expedited', 'Expedited', prio.expedited) +
    prioRow('high', 'High', prio.high) +
    prioRow('default', 'Default', prio.default) +
    (tally.bac
      ? `<p class="colnote">${tally.bac} ${tally.bac === 1 ? 'sample is' : 'samples are'} bacteriostatic water, prepped as a dilution.</p>`
      : '') +
    '</section>' +
    `<section class="col"><h2>Due</h2>${dueList || '<p class="colnote">No due dates set.</p>'}</section>` +
    '</div>' +
    readnote +
    rulesUsed +
    '<h2 class="ruleshead">How each figure is worked out</h2>' +
    '<dl class="rules seven">' +
    '<div><dt>Due date</dt><dd>received + 3 business days<br><i>weekends and lab holidays skipped</i></dd></div>' +
    `<div><dt>Reconstitution water</dt><dd>${fmt(reconMl)} mL<br><i>underlined where a sample was given its own</i></dd></div>` +
    `<div><dt class="s1">Step 1 &middot; Tris</dt><dd>${stdVol(0)}<br><i>0.1 M Tris (BT103), first, per its insert</i></dd></div>` +
    `<div><dt class="s2">Step 2 &middot; LAL water</dt><dd>${stdVol(1)}<br><i>ratio = total &divide; (step 1 &times; 2)</i></dd></div>` +
    `<div><dt class="s3">Step 3 &middot; BG600</dt><dd>${stdVol(2)}<br><i>always 1:2: BG600 is half the final prep</i></dd></div>` +
    `<div><dt>Total &middot; MCS</dt><dd>1:${fmt(ctx.params.stdTotalDilution)}, factor 1 on the MCS<br><i>the sheet multiplies the reading by the total and the ${fmt(reconMl)} mL</i></dd></div>` +
    `<div><dt>Bacteriostatic water</dt><dd>${fmt(BW_DILUTION)}&times; dilution: ${fmtUl(BW_SAMPLE_UL)} &micro;L<br><i>made to ${fmtUl(BW_SAMPLE_UL + BW_LAL_UL)} &micro;L with LAL water</i></dd></div>` +
    '</dl>' +
    holidayNote +
    `<div class="pagefoot">${footLeft}<span><b>Summary &middot; page ${totalPages} of ${totalPages}</b></span></div>` +
    '</section>'

  return out + '</body></html>'
}

/* ---------------- CSV ---------------- */

interface Csv2Line {
  r: EndoSheet2Row
  k: EndoCheck
  rs: EndoResult
  mk: { value: string; unit: string } | null
  steps: EndoStepPlan[] | null
  total: number | null
  tris: number | null
  water: number | null
  bg: number | null
  tubes: number
}

function csv2Line(r: EndoSheet2Row, ctx: EndoCtx): Csv2Line {
  const s = r.sample
  const bac = formOf(s) === 'bac'
  const plan = bac ? null : dilutionPlan(s, ctx)
  const k = prep2Check(s, ctx)
  return {
    r,
    k,
    rs: prep2Result(s, ctx),
    mk: mk1Value(s, ctx),
    steps: plan ? plan.steps : null,
    total: plan ? plan.total : k.dilution,
    tris: plan ? (plan.steps[0]?.diluentUl ?? null) : null,
    // bac water: its LAL water
    water: plan ? (plan.steps[1]?.diluentUl ?? null) : BW_LAL_UL,
    bg: plan ? (plan.steps[2]?.diluentUl ?? null) : null,
    tubes: plan ? plan.steps.length : 1,
  }
}

const eu = (lt: boolean | null, v: number | null) => fmtEu(lt === true, v)
const plain = (v: number | null | undefined) => (v == null ? '' : String(v))
const step = (x: Csv2Line, i: number) => x.steps?.[i] ?? null

// Dennis's 2 mL CSV columns (5ef2a62) without his four tick columns, plus
// step 3's ratio (spec 7). The Run total line is placed by these names.
const CSV2_COLUMNS: [string, (x: Csv2Line) => string][] = [
  ['Received', x => x.r.received ?? ''],
  ['Due', x => x.r.due ?? ''],
  ['Priority', x => priorityKey(x.r.priority)],
  ['Order #', x => x.r.order],
  ['Sample ID', x => x.r.sample.sampleId],
  ['Sample identity', x => x.r.sample.identity],
  ['identity as received', x => x.r.identityAsReceived],
  ['Declared wt (mg)', x => fmt(x.r.sample.weightMg)],
  ['form', x => formOf(x.r.sample)],
  ['reconstitution water (mL)', x => fmt(x.k.water)],
  ['step 1 sample (uL)', x => fmtUl(step(x, 0)?.sampleUl)],
  ['step 1 ratio', x => fmt(step(x, 0)?.ratio)],
  ['step 1 Tris (uL)', x => fmtUl(x.tris)],
  ['step 2 sample (uL)', x => fmtUl(step(x, 1)?.sampleUl)],
  ['step 2 ratio', x => fmt(step(x, 1)?.ratio)],
  ['step 2 LAL water (uL)', x => (x.steps ? fmtUl(x.water) : '')],
  ['step 3 sample (uL)', x => fmtUl(step(x, 2)?.sampleUl)],
  ['step 3 ratio', x => fmt(step(x, 2)?.ratio)],
  ['step 3 BG600 (uL)', x => fmtUl(x.bg)],
  ['total dilution (x)', x => fmt(x.total)],
  ['cartridge (EU/mL)', x => fmt(x.k.lambda)],
  ['loaded (mg/mL)', x => fmtConc(x.k.loaded)],
  ['MVD (x)', x => fmt(x.k.mvd)],
  ['MVC (mg/mL)', x => fmtConc(x.k.mvc)],
  ['result as read (EU/mL on MCS, factor 1)', x => x.r.sample.reading ?? ''],
  ['EU/mL of vial solution', x => eu(x.rs.lt, x.rs.euPerMlVial)],
  ['LOD (EU/mL cartridge)', x => fmt(x.k.lod)],
  [
    'LOQ (EU/vial)',
    x =>
      formOf(x.r.sample) === 'bac'
        ? x.k.loqMl === null
          ? ''
          : `${fmt(x.k.loqMl)} EU/mL`
        : fmt(x.k.loqVial),
  ],
  ['EU/vial', x => eu(x.rs.lt, x.rs.euPerVial)],
  ['EU/mg', x => eu(x.rs.lt, x.rs.euPerMg)],
  ['limit (EU/vial)', x => fmt(x.rs.limitPerVial)],
  ['bac water limit (EU/mL)', x => fmt(x.rs.limitPerMl)],
  ['verdict', x => x.rs.verdict ?? ''],
  ['Accu-Mk1 value', x => x.mk?.value ?? ''],
  ['Accu-Mk1 unit', x => x.mk?.unit ?? ''],
  ['spike recovery (%)', x => plain(x.r.sample.reader?.recovery)],
  ['sample CV (%)', x => plain(x.r.sample.reader?.sample_cv)],
  ['spike CV (%)', x => plain(x.r.sample.reader?.spike_cv)],
  [
    'reader check',
    x => {
      const m = x.r.sample.reader
      return m ? (m.valid ? 'valid' : `invalid: ${m.why.join('; ')}`) : ''
    },
  ],
  ['reader test ID', x => x.r.sample.reader?.test_id ?? ''],
  [
    'reader',
    x => {
      const m = x.r.sample.reader
      return m ? [m.reader, m.slot].filter(v => v != null).join(' ') : ''
    },
  ],
  ['cartridge lot', x => x.r.sample.reader?.cartridge_lot ?? ''],
  ['cartridge expiry', x => x.r.sample.reader?.cartridge_expiry ?? ''],
  ['operator', x => x.r.sample.reader?.operator ?? ''],
  ['tested at', x => x.r.sample.reader?.tested_at ?? ''],
  ['Tris used (uL)', x => fmtUl(x.tris)],
  ['LAL water used (uL)', x => fmtUl(x.water)],
  ['BG600 used (uL)', x => fmtUl(x.bg)],
  ['tubes', x => String(x.tubes)],
]

/**
 * One row per sample in Box 1 order, then a Run total line with the
 * reagents and tubes for inventory (Dennis 2026-10-08); CRLF line endings
 * and formula-defused cells, as the stock CSV.
 */
export function buildEndoCsv2(doc: EndoSheet2Doc): string {
  const lines = [CSV2_COLUMNS.map(c => csvField(c[0])).join(',')]
  const sum = { tris: 0, water: 0, bg: 0, tubes: 0 }
  for (const r of doc.rows) {
    const x = csv2Line(r, doc.ctx)
    sum.tris += x.tris ?? 0
    sum.water += x.water ?? 0
    sum.bg += x.bg ?? 0
    sum.tubes += x.tubes
    lines.push(CSV2_COLUMNS.map(c => csvField(c[1](x))).join(','))
  }
  const total = CSV2_COLUMNS.map(() => '')
  const at = (header: string) => CSV2_COLUMNS.findIndex(c => c[0] === header)
  total[at('Sample ID')] = 'Run total'
  total[at('Tris used (uL)')] = fmtUl(sum.tris)
  total[at('LAL water used (uL)')] = fmtUl(sum.water)
  total[at('BG600 used (uL)')] = fmtUl(sum.bg)
  total[at('tubes')] = String(sum.tubes)
  lines.push(total.map(csvField).join(','))
  return lines.join('\r\n') + '\r\n'
}
