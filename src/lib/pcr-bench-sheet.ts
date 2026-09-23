/**
 * The qPCR bench sheet: one landscape Letter page per plate, as Dennis's
 * builder prints it. A run strip across the top (title, plate number, the
 * run's fields and the two status boxes), the plate map on the left, that
 * plate's calculations in a 358 px column on the right, the internal notes
 * under the last plate's map. Widths are load-bearing on paper: 12 cells of
 * ~48 px cap the well id at ~0.70 rem; the calculations column holds two card
 * tracks of ~165 px min-content each. Nothing printed is below 7.7 pt.
 *
 * Pure string building; every value goes through escapeHtml. Printed through
 * printHtmlDocument (an isolated iframe) so the app's label print CSS never
 * applies. Spec: docs/superpowers/specs/2026-09-22-pcr-worksheet-design.md
 */
import { escapeHtml } from '@/lib/endo-bench-sheet'
import {
  calculatePrep,
  fmt2,
  metaHeaderRows,
  plateGrid,
  plateMapRows,
  PROTOCOL,
  toCsv,
  wellListRows,
  type MixRow,
  type PcrPlate,
} from '@/lib/pcr-plate'
import { plateLabel, type PcrRunDoc } from '@/lib/pcr-worksheet'

const SHEET_CSS = [
  '@page{size:letter landscape;margin:8mm}',
  '*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
  ":root{--mono:Consolas,'Cascadia Mono',ui-monospace,Menlo,monospace}",
  "body{margin:0;background:#fff;color:#000;font:13px/1.45 Aptos,Calibri,'Segoe UI',system-ui,sans-serif}",
  '.page{page-break-after:always;break-after:page}',
  '.page:last-of-type{page-break-after:auto;break-after:auto}',
  '.strip{display:grid;grid-template-columns:auto 1fr;grid-template-areas:"title status" "meta meta";align-items:baseline;column-gap:1rem;margin:0 0 .3rem;padding:.16rem .4rem .2rem;background:#e7e6e6;border:1px solid #000}',
  '.strip-title{grid-area:title;font-size:.84rem;font-weight:700;display:flex;gap:.6rem;align-items:baseline}',
  '.strip-name{font-weight:600;color:#595959}',
  '.strip-plate{background:#000;color:#fff;padding:0 .3rem;font-size:.72rem}',
  '.strip-status{grid-area:status;justify-self:end;display:flex;gap:0 .9rem;font-size:.68rem}',
  '.box{display:inline-flex;align-items:center;gap:.25rem}',
  '.box i{display:inline-block;width:.8em;height:.8em;border:1px solid #000;background:#fff;font-style:normal;font-size:.7em;line-height:.8em;text-align:center}',
  '.strip-meta{grid-area:meta;display:flex;flex-wrap:wrap;gap:0 .7rem;font-size:.68rem;line-height:1.4}',
  '.pair b{font-weight:700}.pair b::after{content:" "}',
  '.pair.overdue span,.pair.flagged span{color:#c00000;font-weight:700}.pair.today span{color:#bf6a00;font-weight:700}',
  '.body{display:grid;grid-template-columns:minmax(0,1fr) 358px;gap:.45rem;align-items:start}',
  '.panel{border:1px solid #000}',
  'h2{margin:0;background:#ed7d31;color:#fff;font-size:.8rem;font-weight:700;text-align:center;text-transform:uppercase;letter-spacing:.08em;padding:.2rem;border-bottom:1px solid #000}',
  '.pb{padding:.4rem .45rem .45rem}',
  '.legend{display:flex;flex-wrap:wrap;gap:.15rem .7rem;font-size:.64rem;color:#595959;margin-bottom:.3rem}',
  '.legend span{display:flex;align-items:center;gap:.35rem}',
  '.sw{width:1.4rem;height:.7rem;display:inline-block;border:1px solid #808080}',
  'table.plate{border-collapse:collapse;width:100%;table-layout:fixed;font-family:var(--mono)}',
  'table.plate th{font-size:.68rem;font-weight:700;background:#ededed;border:1px solid #808080;padding:.1rem;text-align:center;font-family:Aptos,Calibri,sans-serif}',
  'table.plate th.rh{width:1.15rem}',
  'table.plate td{height:3.45rem;border:1px solid #808080;text-align:center;font-size:.7rem;padding:.1rem .03rem;overflow:hidden;background:#fff;position:relative}',
  'td .wid{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.4}',
  'td .wo,td .wd{display:block;font-size:.68rem;color:#595959;line-height:1.35}',
  'td .wd.overdue{color:#c00000;font-weight:700}td .wd.today{color:#bf6a00;font-weight:700}',
  // Every fill, outline and divider carries the table.plate prefix: the base
  // cell rule above is (0,1,2) and a bare td.bac (0,1,1) loses to it, which
  // printed white wells with no order outlines (review 2026-09-22).
  'table.plate td.bac{background:#deeaf6}table.plate td.fun{background:#fff2cc}table.plate td.bac.alt{background:#bdd7ee}table.plate td.fun.alt{background:#ffe699}',
  'table.plate td.ctrl{background:#d9d9d9;font-weight:700}',
  "td.prio::after{content:'';position:absolute;top:0;right:0;border-style:solid;border-width:0 .6rem .6rem 0;border-color:transparent #c00000 transparent transparent}",
  'td.prio.overdue .wid{color:#c00000;font-weight:700}',
  'table.plate td.ob-t{border-top:2px solid #44546a}table.plate td.ob-b{border-bottom:2px solid #44546a}table.plate td.ob-l{border-left:2px solid #44546a}table.plate td.ob-r{border-right:2px solid #44546a}',
  // After the outlines on purpose: same specificity, so the assay divider wins.
  'table.plate td.bs,table.plate th.bs{border-left:3px solid #000}',
  '.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.3rem}',
  '.card{border:1px solid #000}',
  '.card h3{margin:0;background:#ededed;border-bottom:1px solid #000;font-size:.7rem;font-weight:700;padding:.1rem .3rem;display:flex;justify-content:space-between}',
  '.card .u{font-weight:400;color:#595959;font-size:.62rem}',
  'table.kv,table.mix{width:100%;border-collapse:collapse;font-size:.78rem}',
  'table.kv th,table.mix tbody th{text-align:left;font-weight:400;padding:.05rem .25rem;border:1px solid #808080;line-height:1.2}',
  'table.kv td,table.mix td{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;padding:.05rem .25rem;border:1px solid #808080;line-height:1.2}',
  'table.mix thead th{background:#ededed;font-size:.64rem;font-weight:700;text-transform:uppercase;padding:.05rem .25rem;border:1px solid #808080;text-align:right}',
  'table.mix thead th:first-child{text-align:left}',
  'table.mix td.s{font-weight:700;background:#f2e8e1}',
  'tr.total th,tr.total td{font-weight:700;border-top:2px solid #000}',
  'table.kv tr.total td{background:#f2e8e1}',
  // The HTML parser wraps the rows in a <tbody>; it has to dissolve too, or
  // all ten pairs land on one row and push the page past the paper.
  '.card.reag{grid-column:1/-1}.card.reag table.kv{display:grid;grid-template-columns:1fr auto 1fr auto}.card.reag table.kv tbody,.card.reag table.kv tr{display:contents}',
  '.notes{margin-top:.3rem;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:#595959}',
  '.notes div{font-weight:400;text-transform:none;letter-spacing:0;font-size:.7rem;color:#000;border:1px solid #808080;min-height:2rem;padding:.12rem .3rem;white-space:pre-wrap;margin-top:.2rem}',
  '.foot{margin-top:.25rem;font-size:.62rem;color:#595959;display:flex;justify-content:space-between}',
].join('')

// Preview: the very document Print hands over, shown as paper (landscape
// Letter, the @page margins as padding).
const PREVIEW_CSS =
  'body{background:#E7ECEC;padding:16px 0}' +
  '.page{width:1056px;min-height:816px;padding:30px;background:#fff;' +
  'margin:0 auto 16px;box-shadow:0 1px 8px rgba(0,0,0,.28);' +
  'page-break-after:auto;break-after:auto}'

/** "09/22/2026" from YYYY-MM-DD, as the workbook prints dates. */
function usDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return y && m && d ? `${m}/${d}/${y}` : iso
}

/** "9/22" for a well. */
function shortDue(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  return m && d ? `${m}/${d}` : iso
}

function stripHtml(doc: PcrRunDoc, pl: PcrPlate): string {
  const { layout: L, summary: S, meta: m } = doc
  const pair = (k: string, v: string, cls = '') =>
    v
      ? `<span class="pair ${cls}"><b>${escapeHtml(k)}</b><span>${escapeHtml(v)}</span></span>`
      : ''
  const box = (label: string, on: boolean) =>
    `<span class="box"><i>${on ? '&#10003;' : ''}</i>${label}</span>`
  const all = doc.status.total > 0
  return (
    '<div class="strip"><div class="strip-title"><strong>qPCR Experimental Setup</strong>' +
    (m.runName
      ? `<span class="strip-name">${escapeHtml(m.runName)}</span>`
      : '') +
    (L.plateCount > 1
      ? `<span class="strip-plate">Plate ${pl.plate} of ${L.plateCount}</span>`
      : '') +
    '</div><div class="strip-status">' +
    box('Plate Made', all && doc.status.made === doc.status.total) +
    box('Ran on QuantStudio', all && doc.status.ran === doc.status.total) +
    '</div><div class="strip-meta">' +
    pair('Run', m.runId) +
    pair('Analyst', m.analyst) +
    pair('Date', m.date ? usDate(m.date) : '') +
    pair('Curve', m.curve) +
    pair('Plate', m.plateType) +
    pair('QuantStudio', m.instrument) +
    pair('Wells', String(pl.n)) +
    pair('Run samples', String(S.samples)) +
    pair(
      'Earliest due',
      S.earliestDue ? usDate(S.earliestDue) : '',
      S.overdue ? 'overdue' : S.today ? 'today' : ''
    ) +
    pair('Priority', S.prioText, S.flagged ? 'flagged' : '') +
    pair('Overage', `${m.overage}x`) +
    pair('Printed', doc.printedAt) +
    '</div></div>'
  )
}

function plateTableHtml(pl: PcrPlate, outlineGroups: boolean): string {
  const map = plateGrid(pl)
  const groupAt = (ri: number, c: number): number | null =>
    ri < 0 || ri > 7 || c < 1 || c > PROTOCOL.cols
      ? null
      : (map.get(`${PROTOCOL.rows[ri]}${c}`)?.placement.group ?? null)
  let html = '<table class="plate"><thead><tr><th class="rh"></th>'
  for (let c = 1; c <= PROTOCOL.cols; c++)
    html += `<th${c === 7 ? ' class="bs"' : ''}>${c}</th>`
  html += '</tr></thead><tbody>'
  PROTOCOL.rows.forEach((r, ri) => {
    html += `<tr><th class="rh">${r}</th>`
    for (let c = 1; c <= PROTOCOL.cols; c++) {
      const cell = map.get(`${r}${c}`)
      const cls: string[] = c === 7 ? ['bs'] : []
      if (!cell) {
        html += `<td class="${cls.join(' ')}"></td>`
        continue
      }
      const p = cell.placement
      cls.push(p.isControl ? 'ctrl' : cell.assay)
      if (outlineGroups) {
        const g = p.group
        if (g % 2 === 1) cls.push('alt')
        if (groupAt(ri - 1, c) !== g) cls.push('ob-t')
        if (groupAt(ri + 1, c) !== g) cls.push('ob-b')
        if (c === 1 || c === 7 || groupAt(ri, c - 1) !== g) cls.push('ob-l')
        if (c === 6 || c === 12 || groupAt(ri, c + 1) !== g) cls.push('ob-r')
      }
      const a = p.assessment
      if (a?.flagged) cls.push('prio')
      if (a?.urgency === 'overdue') cls.push('overdue')
      html +=
        `<td class="${cls.join(' ')}"><span class="wid">${escapeHtml(plateLabel(p.id))}</span>` +
        (p.order ? `<span class="wo">${escapeHtml(p.order)}</span>` : '') +
        (a?.due
          ? `<span class="wd ${a.urgency}">${escapeHtml(shortDue(a.due))}</span>`
          : '') +
        '</td>'
    }
    html += '</tr>'
  })
  return html + '</tbody></table>'
}

const LEGEND =
  '<div class="legend">' +
  '<span><i class="sw" style="background:#deeaf6;border-color:#5b9bd5"></i>Bacterial assay (16S), cols 1 to 6</span>' +
  '<span><i class="sw" style="background:#fff2cc;border-color:#bf9000"></i>Fungal assay (18S), cols 7 to 12</span>' +
  '<span><i class="sw" style="background:#d9d9d9"></i>Control</span>' +
  '<span><i class="sw" style="background:#deeaf6;border:2px solid #44546a"></i><i class="sw" style="background:#bdd7ee;border:2px solid #44546a"></i>Each boxed block is one order</span>' +
  '<span>Red corner: priority, overdue or due today</span>' +
  '</div>'

function kvHtml(rows: [string, string][], total?: [string, string]): string {
  const tr = ([k, v]: [string, string], cls = '') =>
    `<tr${cls ? ` class="${cls}"` : ''}><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`
  return (
    '<table class="kv">' +
    rows.map(r => tr(r)).join('') +
    (total ? tr(total, 'total') : '') +
    '</table>'
  )
}

function mixHtml(rows: MixRow[], overage: number): string {
  const body = rows
    .map(
      r =>
        `<tr><th>${escapeHtml(r.name)}</th><td>${fmt2(r.base)}</td><td class="s">${fmt2(r.pipette)}</td></tr>`
    )
    .join('')
  const total = `<tr class="total"><th>Total</th><td>${fmt2(rows.reduce((a, r) => a + r.base, 0))}</td><td class="s">${fmt2(rows.reduce((a, r) => a + r.pipette, 0))}</td></tr>`
  return `<table class="mix"><thead><tr><th>Component</th><th>Calc</th><th>x ${overage}</th></tr></thead><tbody>${body}${total}</tbody></table>`
}

function card(title: string, unit: string, body: string, cls = ''): string {
  return `<div class="card${cls ? ` ${cls}` : ''}"><h3>${title}${unit ? `<span class="u">${unit}</span>` : ''}</h3>${body}</div>`
}

function calcCardsHtml(pl: PcrPlate, overage: number): string {
  const c = calculatePrep(pl.n, overage)
  return (
    '<div class="grid">' +
    card(
      'Well Counts',
      '',
      kvHtml([
        ['Wells on plate (N)', String(pl.n)],
        ['Master mix wells', String(c.wells.mm)],
        ['BAC wells', String(c.wells.bac)],
        ['FUN wells', String(c.wells.fun)],
        ['IPC wells', String(c.wells.ipc)],
      ])
    ) +
    card(
      'Volume per Well',
      '&micro;L',
      kvHtml(
        [
          ['Master mix', fmt2(c.perWell.mm)],
          ['Assay mix', fmt2(c.perWell.assayMix)],
          ['IPC mix', fmt2(c.perWell.ipcMix)],
          ['Template', fmt2(c.perWell.template)],
        ],
        ['Total per well', fmt2(c.perWell.total)]
      )
    ) +
    card('BAC Mix: 16S', '&micro;L', mixHtml(c.bac, overage)) +
    card('FUN Mix: 18S', '&micro;L', mixHtml(c.fun, overage)) +
    card(
      'Bulk Volumes Needed',
      '&micro;L',
      kvHtml([
        ['Master mix', fmt2(c.bulk.mm)],
        ['BAC mix', fmt2(c.bulk.bac)],
        ['FUN mix', fmt2(c.bulk.fun)],
        ['IPC mix', fmt2(c.bulk.ipc)],
      ])
    ) +
    card('IPC Mix', '&micro;L', mixHtml(c.ipc, overage)) +
    card('Reagent Reference', '', kvHtml(PROTOCOL.reagents), 'reag') +
    '</div>'
  )
}

export function buildPcrBenchSheetHtml(
  doc: PcrRunDoc,
  opts: { preview?: boolean } = {}
): string {
  const L = doc.layout
  const title = escapeHtml(doc.title)
  const multi = L.plateCount > 1
  let out =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<title>${title} qPCR plate</title><style>${SHEET_CSS}${opts.preview ? PREVIEW_CSS : ''}</style></head><body>`
  L.plates.forEach((pl, i) => {
    const last = i === L.plates.length - 1
    const of = multi ? `: Plate ${pl.plate} of ${L.plateCount}` : ''
    out +=
      '<section class="page">' +
      stripHtml(doc, pl) +
      '<div class="body">' +
      `<div class="panel"><h2>Plate Map${of}</h2><div class="pb">${LEGEND}${plateTableHtml(pl, doc.sortByOrder)}` +
      (last && doc.notes
        ? `<div class="notes">Internal Notes<div>${escapeHtml(doc.notes)}</div></div>`
        : '') +
      '</div></div>' +
      `<div class="panel"><h2>Calculations${of}</h2><div class="pb">${calcCardsHtml(pl, doc.meta.overage)}</div></div>` +
      '</div>' +
      `<div class="foot"><span>${title} &middot; ${escapeHtml(doc.meta.runId)}${doc.meta.analyst ? ` &middot; ${escapeHtml(doc.meta.analyst)}` : ''}</span>` +
      `<span>Page ${i + 1} of ${L.plates.length}</span></div>` +
      '</section>'
  })
  return out + '</body></html>'
}

/** The run header, then two 8 x 12 grids per plate (ids, identities). */
export function buildPcrPlateMapCsv(doc: PcrRunDoc): string {
  return toCsv([
    ...metaHeaderRows(doc.meta, doc.layout),
    ...plateMapRows(doc.layout),
  ])
}

/** One row per occupied well in both blocks. */
export function buildPcrWellListCsv(doc: PcrRunDoc): string {
  return toCsv(wellListRows(doc.layout))
}
