import { describe, it, expect } from 'vitest'
import {
  buildPcrBenchSheetHtml,
  buildPcrPlateMapCsv,
  buildPcrWellListCsv,
} from '@/lib/pcr-bench-sheet'
import {
  assess,
  layoutPlates,
  summarize,
  type PcrSample,
} from '@/lib/pcr-plate'
import type { PcrRunDoc } from '@/lib/pcr-worksheet'

const sample = (
  n: number,
  order = '9001',
  identity = 'Examplerelin'
): PcrSample => ({
  itemId: n,
  id: `P-${String(n).padStart(4, '0')}`,
  order,
  identity,
  received: '2026-09-21',
  priority: 'normal',
  assessment: assess('2026-09-24', '2026-09-22', 'normal'),
  frozen: null,
})

function doc(samples: PcrSample[], notes = ''): PcrRunDoc {
  const layout = layoutPlates(samples)
  return {
    title: 'PCR 09/22/2026',
    meta: {
      runId: 'WS-24',
      runName: 'PCR 09/22/2026',
      date: '2026-09-22',
      analyst: 'Guian',
      curve: 'Quantitative',
      plateType: '8-Well Strip',
      instrument: 'QuantStudio 6 Flex',
      overage: 1.4,
    },
    layout,
    summary: summarize(layout),
    printedAt: 'Sep 22, 2026, 10:04 AM',
    status: { made: 0, ran: 0, total: samples.length },
    notes,
    sortByOrder: true,
  }
}

describe('buildPcrBenchSheetHtml', () => {
  it('prints one landscape page per plate with the strip, the map and the calculations', () => {
    const html = buildPcrBenchSheetHtml(
      doc(
        Array.from({ length: 48 }, (_, i) => sample(i + 1)),
        'lot 42'
      )
    )
    expect(html.match(/<section class="page">/g)?.length).toBe(2)
    expect(html).toContain('Plate 1 of 2')
    expect(html).toContain('Plate 2 of 2')
    expect(html).toContain('size:letter landscape')
    // The NPC sits in H6 and H12 on the full plate; the notes print once, on the last page.
    expect(html).toContain('>NPC<')
    expect(html.match(/lot 42/g)?.length).toBe(1)
    const page2 = html.indexOf(
      '<section class="page">',
      html.indexOf('<section class="page">') + 1
    )
    expect(html.indexOf('lot 42')).toBeGreaterThan(page2)
    // The workbook's 48-well figures ride on plate 1 (48 wells: 47 samples + NPC).
    expect(html).toContain('>53.9<')
  })

  it('escapes every value and marks the preview as paper', () => {
    const d = doc([sample(1, '<b>', 'Examplerelin')])
    d.title = '<script>alert(1)</script>'
    const html = buildPcrBenchSheetHtml(d, { preview: true })
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;b&gt;')
    expect(html).toContain('background:#E7ECEC')
  })
})

describe('CSVs', () => {
  it('lead the plate map with the run header and write the well list with CRLF', () => {
    const d = doc([sample(1)])
    expect(
      buildPcrPlateMapCsv(d).startsWith(
        'Run ID,WS-24\r\nRun name,PCR 09/22/2026\r\n'
      )
    ).toBe(true)
    expect(buildPcrWellListCsv(d).split('\r\n')[0]).toBe(
      'Plate,Well,Sample Name,Order,Identity,Received,Due,Priority,Assay,Target,Task'
    )
  })
})
