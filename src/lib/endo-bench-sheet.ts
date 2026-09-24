/**
 * The endotoxin bench sheet: a complete, standalone HTML document the analyst
 * carries to the instrument, plus the matching CSV.
 *
 * Ported from buildPrintDoc in tools-dennis/tools/endotoxin-log/endotoxin.html.
 * The layout is the one the endo bench iterated to legibility on paper, so it
 * is kept rather than redesigned: landscape Letter, exactly ten samples per
 * page (a CSS-only break gave 9 on page one because the title block eats a
 * row), figures in a slashed-zero monospace, priority as a filled pill, no
 * vertical rules, and a summary sheet last. The Made / Ran boxes print empty
 * for the pen: the completion of record is lims_analyses.review_state.
 *
 * Pure string building; every value goes through escapeHtml. Printed through
 * printHtmlDocument (an isolated iframe) so the app's label print CSS never
 * applies. Spec: docs/superpowers/specs/2026-09-18-endo-worksheet-design.md
 */

export interface EndoSheetRow {
  /** YYYY-MM-DD, or null when the item has no received date. */
  due: string | null
  /** True when a lab holiday pushed the due date (prints a * on the date). */
  dueHoliday: boolean
  /** expedited | high | default (any other value prints as default). */
  priority: string
  order: string
  sampleId: string
  identity: string
  /** YYYY-MM-DD in lab time, or null. CSV only; the sheet does not print it. */
  received: string | null
  /** Already formatted with fmt/fmtUl; empty string when not applicable. */
  weightMg: string
  volumeMl: string
  /** Bac-water dilution factor; null for a weight prep. */
  dilution: number | null
  sampleUl: string
  lalUl: string
  vialConc: string
}

export interface EndoSheetDoc {
  /** Worksheet title (the run's name on paper). */
  title: string
  /** A second identifier printed small: e.g. the worksheet id. */
  runName: string
  analyst: string
  /** YYYY-MM-DD the run was made (worksheet created_at in lab time). */
  dateMade: string
  /** Comma-joined distinct order numbers. */
  orders: string
  /** Free-text print stamp. */
  printedAt: string
  /** Rows already in bench order (orderForBench). */
  rows: EndoSheetRow[]
  /** Holidays that pushed any due date on the sheet, for the footnote. */
  holidayNotes: { iso: string; name: string }[]
}

export const ENDO_SHEET_ROWS_PER_PAGE = 10

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const PRIORITY_LABEL: Record<string, string> = {
  expedited: 'Expedited',
  high: 'High',
  default: 'Default',
}

function priorityKey(p: string): 'expedited' | 'high' | 'default' {
  const k = (p ?? '').toLowerCase()
  return k === 'expedited' || k === 'high' ? k : 'default'
}

/** "Sep 16" style short date from YYYY-MM-DD, without touching time zones. */
function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/** "Wednesday, September 16, 2026" from YYYY-MM-DD. */
function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

// Kept as one string so the sheet is a single self-contained document.
// 4mm at the sides is about as close to the edge as a laser printer can image.
const SHEET_CSS = [
  '@page{size:letter landscape;margin:11mm 4mm}',
  '*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
  // Figures: Consolas first: ships with every Windows install, slashed zero,
  // footed 1 and an open 6/9, so 0/O, 1/7 and 5/6 stay distinct on paper.
  ":root{--num:Consolas,'Cascadia Mono','DejaVu Sans Mono',ui-monospace,Menlo,'Liberation Mono',monospace}",
  "body{margin:0;padding:0;background:#fff;color:#1A2A2E;font:14pt/1.4 'Segoe UI',system-ui,-apple-system,Arial,sans-serif}",
  '.top{display:flex;align-items:baseline;justify-content:space-between;gap:12pt;border-bottom:2pt solid #0D6E70;padding-bottom:4pt;margin-bottom:5pt}',
  'h1{margin:0;font-size:19pt;font-weight:600;letter-spacing:-.012em}',
  '.stamp{margin:0;font:10.5pt var(--num);color:#76898E}',
  '.meta{display:flex;flex-wrap:wrap;gap:2pt 24pt;margin:0 0 6pt}',
  '.meta div{display:flex;align-items:baseline;gap:6pt}',
  '.meta dt{font-size:9pt;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#7C9095}',
  '.meta dd{margin:0;font-size:13pt;font-weight:600}',
  'table{border-collapse:collapse;width:100%;margin:0 auto;table-layout:fixed}',
  'thead{display:table-header-group}',
  'tr{page-break-inside:avoid;break-inside:avoid}',
  // One rule in the whole table: under the column headings.
  'th{font-size:9pt;font-weight:700;letter-spacing:.04em;text-transform:uppercase;text-align:center;color:#41595F;background:none;border:0;border-bottom:1.5pt solid #1A2A2E;padding:2pt 3pt 6pt;line-height:1.15;vertical-align:bottom}',
  'th.c{font-size:8.5pt;letter-spacing:0;padding-left:2pt;padding-right:2pt}',
  'th .u{display:block;font-weight:400;text-transform:none;letter-spacing:0;font:8pt var(--num);color:#8DA0A5}',
  'td{border:0;padding:7pt 5pt;font-size:14pt;line-height:1.22;text-align:center;vertical-align:middle;overflow-wrap:break-word}',
  'tbody tr:nth-child(even) td{background:#F2F6F6}',
  // Dates and figures never wrap: a wrapped date doubles a row's height.
  'td.m{font-family:var(--num);font-variant-numeric:tabular-nums slashed-zero;white-space:nowrap;letter-spacing:.01em}',
  'td.c{padding-left:1pt;padding-right:1pt;line-height:1}',
  'td.n{text-align:center;color:#A2B3B7;font-family:var(--num);font-size:12pt;white-space:nowrap}',
  // Identity a size down so a combination name holds in two lines, not three.
  'td.idn{font-size:11pt;line-height:1.15}',
  // Sample ids carry suffixes (PB-0544-S02): a size down, wrapping at hyphens.
  'td.sid{font-size:12.5pt;white-space:normal;overflow-wrap:break-word;line-height:1.15}',
  'td.due{font-weight:600}',
  'td.prio{font-size:10.5pt;white-space:nowrap}',
  '.pill{display:inline-block;padding:1.5pt 5pt;border-radius:3pt;border:.75pt solid;line-height:1.12;letter-spacing:.01em}',
  '.pill.expedited{background:#F7E0DD;border-color:#BE554E;color:#8C2822;font-weight:700}',
  '.pill.high{background:#FAEBD3;border-color:#BD8930;color:#7A4B05;font-weight:700}',
  '.pill.default{background:#EFF4F4;border-color:#C6D3D3;color:#6A7E83;font-weight:500}',
  'td.due sup{color:#0D6E70;font-size:.62em;line-height:0;vertical-align:.5em}',
  '.pagefoot{display:flex;justify-content:space-between;align-items:baseline;gap:12pt;border-top:.5pt solid #D7E0E0;margin-top:4pt;padding-top:3pt;font-size:9.5pt;color:#8DA0A5}',
  '.pagefoot b{font-weight:600;color:#41595F}',
  '.note{margin:8pt 0 0;font-size:10pt;color:#7C9095;page-break-inside:avoid}',
  '.bx{display:inline-block;width:18pt;height:18pt;border:.75pt solid #7A8E93;border-radius:2pt;vertical-align:middle}',
  '.chip{border:.5pt solid #A8BCC0;border-radius:2pt;padding:1pt 5pt;font-size:9.5pt;color:#5A737A;font-family:var(--num)}',
  // Summary sheet
  '.tiles{display:flex;gap:14pt;margin:14pt 0 18pt}',
  '.tiles .tile{flex:1;border:.75pt solid #CFDCDC;border-top:3pt solid #0D6E70;border-radius:3pt;background:#FAFCFC;padding:9pt 12pt 11pt}',
  '.tiles dt{font-size:8.5pt;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#7C9095}',
  '.tiles dd{margin:5pt 0 0;font:26pt/1 var(--num);font-weight:700;color:#12262A}',
  '.tunit{font:12pt var(--num);font-weight:400;color:#7C9095;margin-left:4pt}',
  '.cols{display:flex;gap:26pt;margin:0 0 18pt;page-break-inside:avoid}',
  '.col{flex:1;min-width:0}',
  '.col h2{margin:0 0 9pt;font-size:9pt;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#41595F;border-bottom:1pt solid #1A2A2E;padding-bottom:4pt}',
  '.colnote{margin:9pt 0 0;font-size:10pt;color:#7C9095;line-height:1.35}',
  '.priorow{display:flex;align-items:center;gap:8pt;margin:0 0 9pt}',
  '.duerow{display:flex;align-items:baseline;gap:8pt;font-size:11pt;color:#41595F;margin:0 0 7pt}',
  '.priorow .cnt,.duerow .cnt{font:12pt var(--num);font-weight:700;color:#12262A}',
  '.dots{flex:1;border-bottom:.75pt dotted #C6D3D3;transform:translateY(-3pt)}',
  '.ruleshead{margin:0 0 9pt;font-size:9pt;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#41595F;border-bottom:1pt solid #1A2A2E;padding-bottom:4pt}',
  '.rules{display:flex;flex-wrap:wrap;gap:11pt 20pt;margin:0;page-break-inside:avoid}',
  '.rules div{flex:1 1 118pt}',
  '.rules dt{font-size:8.5pt;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#7C9095}',
  '.rules dd{margin:3pt 0 0;font:11.5pt var(--num);color:#26424A;line-height:1.45}',
  ".rules i{font:10pt 'Segoe UI',system-ui,sans-serif;font-style:normal;color:#8DA0A5}",
  '.top,.cont,.meta,table,.tiles,.cols,.ruleshead,.rules,.note,.pagefoot{width:100%;margin-left:auto;margin-right:auto}',
  '.page{page-break-after:always;break-after:page}',
  '.page:last-of-type{page-break-after:auto;break-after:auto}',
  '.page.summary{display:flex;flex-direction:column;min-height:180mm}',
  '.page.summary .pagefoot{margin-top:auto}',
  '.cont{display:flex;align-items:baseline;justify-content:space-between;gap:12pt;border-bottom:2pt solid #0D6E70;padding-bottom:5pt;margin-bottom:8pt;font-size:13.5pt;font-weight:600}',
  '.cont span{font:10pt var(--num);font-weight:400;color:#76898E}',
].join('')

// Twelve columns, fixed width. Sample identity stays deliberately narrow and
// wraps; the rest are sized to hold their widest real value whole.
const COLGROUP =
  '<colgroup>' +
  '<col style="width:3.8%"><col style="width:11.5%"><col style="width:10.5%">' +
  '<col style="width:6.5%"><col style="width:12.5%"><col style="width:17.7%">' +
  '<col style="width:7.5%"><col style="width:7.5%"><col style="width:7.5%">' +
  '<col style="width:5%"><col style="width:5%"><col style="width:5%">' +
  '</colgroup>'

const THEAD =
  COLGROUP +
  '<thead><tr><th></th>' +
  '<th>Due<span class="u">SLA</span></th>' +
  '<th>Priority</th><th>Order #</th><th>Sample ID</th><th>Sample identity</th>' +
  '<th>Volume to add<span class="u">mL</span></th>' +
  '<th>Sample<span class="u">&micro;L</span></th>' +
  '<th>LAL<span class="u">&micro;L</span></th>' +
  '<th class="c">Made</th><th class="c">MCS</th><th class="c">Flag</th>' +
  '</tr></thead>'

function rowHtml(r: EndoSheetRow, n: number): string {
  const pk = priorityKey(r.priority)
  return (
    '<tr>' +
    `<td class="n">${n}</td>` +
    `<td class="m due">${r.due ? escapeHtml(shortDate(r.due)) : ''}${r.dueHoliday ? '<sup>*</sup>' : ''}</td>` +
    `<td class="prio"><span class="pill ${pk}">${PRIORITY_LABEL[pk]}</span></td>` +
    `<td class="m">${escapeHtml(r.order)}</td>` +
    `<td class="m sid">${escapeHtml(r.sampleId)}</td>` +
    `<td class="idn">${escapeHtml(r.identity)}</td>` +
    `<td class="m">${r.dilution ? `<span class="chip">${escapeHtml(r.dilution)}&times;</span>` : escapeHtml(r.volumeMl)}</td>` +
    `<td class="m">${escapeHtml(r.sampleUl)}</td>` +
    `<td class="m">${escapeHtml(r.lalUl)}</td>` +
    '<td class="c"><span class="bx"></span></td>' +
    '<td class="c"><span class="bx"></span></td>' +
    '<td class="c"><span class="bx"></span></td>' +
    '</tr>'
  )
}

function num(s: string): number {
  const v = Number(s)
  return Number.isFinite(v) ? v : 0
}

function fmt1(v: number): string {
  return String(Math.round(v * 10) / 10)
}

// Preview: the very document Print hands over, shown as paper. Each section
// is sized to a landscape Letter sheet with the @page margins as padding, so
// what shows is what comes out.
const PREVIEW_CSS =
  'body{background:#E7ECEC;padding:16px 0}' +
  '.page{width:1056px;min-height:816px;padding:41.6px 15.1px;background:#fff;' +
  'margin:0 auto 16px;box-shadow:0 1px 8px rgba(0,0,0,.28);' +
  'page-break-after:auto;break-after:auto}'

export function buildEndoBenchSheetHtml(
  doc: EndoSheetDoc,
  opts: { preview?: boolean } = {}
): string {
  const rows = doc.rows
  const title = escapeHtml(doc.title)
  const name = escapeHtml(doc.runName)
  const stamp = escapeHtml(doc.printedAt)
  const analyst = escapeHtml(doc.analyst || '-')

  const pages: EndoSheetRow[][] = []
  for (let i = 0; i < rows.length; i += ENDO_SHEET_ROWS_PER_PAGE)
    pages.push(rows.slice(i, i + ENDO_SHEET_ROWS_PER_PAGE))
  if (!pages.length) pages.push([])
  const totalPages = pages.length + 1 // the table pages, plus the summary

  const meta =
    '<dl class="meta">' +
    `<div><dt>Analyst</dt><dd>${analyst}</dd></div>` +
    `<div><dt>Date made</dt><dd>${escapeHtml(doc.dateMade ? longDate(doc.dateMade) : '-')}</dd></div>` +
    `<div><dt>Samples</dt><dd>${rows.length}</dd></div>` +
    `<div><dt>Orders</dt><dd>${escapeHtml(doc.orders || '-')}</dd></div>` +
    '</dl>'

  let out =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<title>${title} endotoxin prep</title><style>${SHEET_CSS}${opts.preview ? PREVIEW_CSS : ''}</style></head><body>`

  pages.forEach((chunk, pageIx) => {
    const of = `page ${pageIx + 1} of ${totalPages}`
    const header =
      pageIx === 0
        ? `<div class="top"><h1>${title}: endotoxin prep</h1>` +
          `<p class="stamp">${name}  &middot;  printed ${stamp}  &middot;  ${of}</p></div>` +
          meta
        : `<div class="cont">${title}: continued<span>${name}  &middot;  ${of}</span></div>`
    const first = pageIx * ENDO_SHEET_ROWS_PER_PAGE + 1
    const last = pageIx * ENDO_SHEET_ROWS_PER_PAGE + chunk.length
    const footer =
      `<div class="pagefoot"><span>${title} &middot; ${name}${doc.analyst ? ` &middot; ${analyst}` : ''}</span>` +
      `<span>${chunk.length ? `Samples <b>${first}&ndash;${last}</b> of ${rows.length} &middot; ` : ''}` +
      `<b>Page ${pageIx + 1} of ${totalPages}</b></span></div>`
    const body = chunk.map((r, i) => rowHtml(r, first + i)).join('')
    out += `<section class="page">${header}<table>${THEAD}<tbody>${body}</tbody></table>${footer}</section>`
  })

  // ---------- the summary sheet: what you draw reagents against ----------
  let sumSample = 0
  let sumLal = 0
  let nWater = 0
  const prio = { expedited: 0, high: 0, default: 0 }
  const dueGroups = new Map<string, number>()
  for (const r of rows) {
    sumSample += num(r.sampleUl)
    sumLal += num(r.lalUl)
    if (r.dilution) nWater++
    prio[priorityKey(r.priority)]++
    if (r.due) dueGroups.set(r.due, (dueGroups.get(r.due) ?? 0) + 1)
  }
  const tile = (label: string, value: string, unit: string) =>
    `<div class="tile"><dt>${label}</dt><dd>${escapeHtml(value)}${unit ? `<span class="tunit">${unit}</span>` : ''}</dd></div>`
  const prioRow = (key: string, label: string, count: number) =>
    `<div class="priorow"><span class="pill ${key}">${label}</span><span class="dots"></span><span class="cnt">${count}</span></div>`
  const dueList = [...dueGroups.keys()]
    .sort()
    .map(
      k =>
        `<div class="duerow"><span>${escapeHtml(longDate(k))}</span><span class="dots"></span><span class="cnt">${dueGroups.get(k)}</span></div>`
    )
    .join('')
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
    '<section class="page summary">' +
    `<div class="cont">${title}: run summary<span>${name}  &middot;  printed ${stamp}</span></div>` +
    '<dl class="meta">' +
    `<div><dt>Analyst</dt><dd>${analyst}</dd></div>` +
    `<div><dt>Date made</dt><dd>${escapeHtml(doc.dateMade ? longDate(doc.dateMade) : '-')}</dd></div>` +
    `<div><dt>Orders</dt><dd>${escapeHtml(doc.orders || '-')}</dd></div>` +
    '</dl>' +
    '<dl class="tiles">' +
    tile('Samples', String(rows.length), '') +
    tile('Sample volume', fmt1(sumSample), '&micro;L') +
    tile('LAL volume', fmt1(sumLal), '&micro;L') +
    '</dl>' +
    '<div class="cols">' +
    '<section class="col"><h2>Priority</h2>' +
    prioRow('expedited', 'Expedited', prio.expedited) +
    prioRow('high', 'High', prio.high) +
    prioRow('default', 'Default', prio.default) +
    (nWater
      ? `<p class="colnote">${nWater} ${nWater === 1 ? 'sample is' : 'samples are'} bacteriostatic water, prepped as a dilution.</p>`
      : '') +
    '</section>' +
    `<section class="col"><h2>Due</h2>${dueList || '<p class="colnote">No due dates set.</p>'}</section>` +
    '</div>' +
    '<h2 class="ruleshead">How each figure is worked out</h2>' +
    '<dl class="rules">' +
    '<div><dt>Due date</dt><dd>received + 3 business days<br><i>weekends and lab holidays skipped</i></dd></div>' +
    '<div><dt>Volume to add</dt><dd>MIN(10, 1 + FLOOR(wt &divide; 50))<br><i>1 mL, plus 1 more per 50 mg</i></dd></div>' +
    '<div><dt>Sample needed</dt><dd>volume to add &divide; declared wt &times; 1000<br><i>at a target of 1 mg/mL</i></dd></div>' +
    '<div><dt>LAL needed</dt><dd>1000 &minus; sample needed<br><i>to fill a 1 mL cartridge</i></dd></div>' +
    '<div><dt>Bacteriostatic water</dt><dd>20&times; dilution: 50 &micro;L<br><i>made to 1000 &micro;L with LAL water</i></dd></div>' +
    '</dl>' +
    holidayNote +
    `<div class="pagefoot"><span>${title} &middot; ${name}${doc.analyst ? ` &middot; ${analyst}` : ''}</span>` +
    `<span><b>Summary &middot; page ${totalPages} of ${totalPages}</b></span></div>` +
    '</section>'

  return out + '</body></html>'
}

/* ---------------- CSV ---------------- */

const CSV_COLUMNS: [string, (r: EndoSheetRow) => string][] = [
  ['Received', r => r.received ?? ''],
  ['Due', r => r.due ?? ''],
  ['Priority', r => priorityKey(r.priority)],
  ['Order #', r => r.order],
  ['Sample ID', r => r.sampleId],
  ['Sample identity', r => r.identity],
  ['Declared wt (mg)', r => r.weightMg],
  ['Volume to add (mL)', r => r.volumeMl],
  ['Sample (uL)', r => r.sampleUl],
  ['LAL (uL)', r => r.lalUl],
  ['Vial conc (mg/mL)', r => r.vialConc],
  ['Dilution', r => (r.dilution ? String(r.dilution) : '')],
]

/**
 * Quote when needed, and defuse a cell a spreadsheet would run as a formula
 * (=, +, -, @ or a control character first): a leading apostrophe keeps it as
 * text in Excel and Sheets, and such cells are always quoted.
 */
export function csvField(v: string): string {
  const defused = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  const mustQuote = defused !== v || /[",\r\n]/.test(defused)
  return mustQuote ? `"${defused.replace(/"/g, '""')}"` : defused
}

/** One row per sample in the given order, CRLF line endings (Excel-safe). */
export function buildEndoCsv(doc: EndoSheetDoc): string {
  const lines = [CSV_COLUMNS.map(c => csvField(c[0])).join(',')]
  for (const r of doc.rows)
    lines.push(CSV_COLUMNS.map(c => csvField(c[1](r))).join(','))
  return lines.join('\r\n') + '\r\n'
}
