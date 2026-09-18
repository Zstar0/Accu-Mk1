import { describe, it, expect } from 'vitest'
import {
  buildEndoBenchSheetHtml,
  buildEndoCsv,
  escapeHtml,
  type EndoSheetDoc,
  type EndoSheetRow,
} from '@/lib/endo-bench-sheet'

function row(i: number, over: Partial<EndoSheetRow> = {}): EndoSheetRow {
  return {
    due: '2026-09-16',
    dueHoliday: false,
    priority: 'default',
    order: '7539',
    sampleId: `P-${String(2800 + i).padStart(4, '0')}-S02`,
    identity: 'Retatrutide',
    received: '2026-09-11',
    weightMg: '24',
    volumeMl: '1',
    dilution: null,
    sampleUl: '41.7',
    lalUl: '958.3',
    vialConc: '24',
    ...over,
  }
}

function doc(rows: EndoSheetRow[]): EndoSheetDoc {
  return {
    title: 'Endo 09/11/2026 #3',
    runName: 'WS-2026-09-11-003',
    analyst: 'Guian Calisterio',
    dateMade: '2026-09-11',
    orders: '7539, 7520',
    printedAt: '2026-09-18 01:00',
    rows,
    holidayNotes: [{ iso: '2026-09-07', name: 'Labor Day' }],
  }
}

describe('buildEndoBenchSheetHtml', () => {
  it('prints exactly 10 samples per page and a summary sheet last', () => {
    const rows = Array.from({ length: 21 }, (_, i) => row(i))
    const html = buildEndoBenchSheetHtml(doc(rows))
    const pages = html.match(/<section class="page">/g) ?? []
    expect(pages).toHaveLength(3)
    expect(html.match(/<section class="page summary">/g)).toHaveLength(1)
    expect(html.lastIndexOf('<section class="page summary">')).toBeGreaterThan(
      html.lastIndexOf('<section class="page">')
    )
    // Every table page carries its own column headings.
    expect(html.match(/<thead>/g)).toHaveLength(3)
    // Ten rows on the first two pages, one on the third.
    const bodies = html.split('<tbody>').slice(1)
    const counts = bodies.map(
      b => (b.split('</tbody>')[0]?.match(/<tr>/g) ?? []).length
    )
    expect(counts).toEqual([10, 10, 1])
  })

  it('escapes untrusted text', () => {
    const html = buildEndoBenchSheetHtml(
      doc([row(1, { identity: '<b>BPC-157</b> & TB500' })])
    )
    expect(html).toContain('&lt;b&gt;BPC-157&lt;/b&gt; &amp; TB500')
    expect(html).not.toContain('<b>BPC-157</b>')
    expect(escapeHtml('"a" \'b\'')).toBe('&quot;a&quot; &#39;b&#39;')
  })

  it('prints a bac-water row as a dilution chip with no vial concentration', () => {
    const html = buildEndoBenchSheetHtml(
      doc([
        row(1, {
          sampleId: 'BW-0114-S02',
          identity: 'Bacteriostatic Water',
          dilution: 20,
          volumeMl: '',
          vialConc: '',
          sampleUl: '50',
          lalUl: '950',
        }),
      ])
    )
    expect(html).toContain('<span class="chip">20&times;</span>')
    expect(html).toContain('bacteriostatic water, prepped as a dilution')
  })

  it('marks a due date that was pushed by a holiday and lists the holiday', () => {
    const html = buildEndoBenchSheetHtml(doc([row(1, { dueHoliday: true })]))
    expect(html).toContain('<sup>*</sup>')
    expect(html).toContain('Labor Day')
  })
})

describe('buildEndoCsv', () => {
  it('writes one header line plus one line per row, in the given order', () => {
    const csv = buildEndoCsv(
      doc([row(1), row(2, { identity: 'BPC-157, TB500' })])
    )
    const lines = csv.trimEnd().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(
      'Received,Due,Priority,Order #,Sample ID,Sample identity,Declared wt (mg),Volume to add (mL),Sample (uL),LAL (uL),Vial conc (mg/mL),Dilution'
    )
    expect(lines[2]).toContain('"BPC-157, TB500"')
    expect(lines[1]).toBe(
      '2026-09-11,2026-09-16,default,7539,P-2801-S02,Retatrutide,24,1,41.7,958.3,24,'
    )
  })
})
