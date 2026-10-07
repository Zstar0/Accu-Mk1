import { describe, expect, it } from 'vitest'

import type { AnalyteTrendCoa } from '@/lib/api'
import {
  buildMatrix,
  commonMinSpec,
  failedTests,
  labDay,
  parseMinSpec,
  qtyDeltaPct,
  risingFailures,
  trendPP,
} from './analyte-trends-utils'

const NOW = Date.parse('2026-10-05T18:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

function coa(over: Partial<AnalyteTrendCoa> = {}): AnalyteTrendCoa {
  return {
    code: Math.random().toString(36).slice(2),
    sample_id: 'P-1',
    published_at: daysAgo(1),
    product: 'BPC-157',
    is_blend: false,
    matrix: 'Peptide',
    lot: null,
    overall: 'PASSED',
    purity: 99,
    purity_ok: true,
    purity_spec: '≥98%',
    identity_ok: true,
    qty: null,
    qty_declared: null,
    endo: null,
    sterility: null,
    hm: null,
    tests: [],
    ...over,
  }
}

describe('failedTests', () => {
  it('names the failing add-on even when purity passed', () => {
    expect(failedTests(coa({ overall: 'FAILED', endo: false }))).toEqual([
      'endo',
    ])
  })
  it('falls back to other when the COA failed on something untracked', () => {
    expect(failedTests(coa({ overall: 'FAILED' }))).toEqual(['other'])
  })
  it('rolls bac water assays into one outcome', () => {
    const bw = coa({
      purity_ok: null,
      identity_ok: null,
      tests: [
        { name: 'pH', value: 8, unit: 'pH', ok: false, spec: null },
        { name: 'Benzyl', value: 0.9, unit: '%', ok: true, spec: null },
      ],
    })
    expect(failedTests(bw)).toEqual(['assay'])
  })
})

describe('labDay', () => {
  it('uses the lab zone, not UTC (evening publish stays on its local day)', () => {
    const t = Date.parse('2026-03-06T03:30:00Z') // 7:30pm Mar 5 in Los Angeles
    expect(labDay(t, 'America/Los_Angeles')).toBe('2026-03-05')
    expect(labDay(t, 'UTC')).toBe('2026-03-06')
  })
})

describe('specs and qty', () => {
  it('parses purity floors', () => {
    expect(parseMinSpec('≥98%')).toBe(98)
    expect(parseMinSpec('>= 99.0 %')).toBe(99)
    expect(parseMinSpec('NLT 95%')).toBe(95)
    expect(parseMinSpec('MEASURE')).toBeNull()
    expect(commonMinSpec([coa(), coa(), coa({ purity_spec: '≥99%' })])).toBe(98)
  })
  it('computes measured vs declared', () => {
    expect(qtyDeltaPct(coa({ qty: 9, qty_declared: 10 }))).toBeCloseTo(-10)
    expect(qtyDeltaPct(coa({ qty: 9 }))).toBeNull()
  })
})

describe('buildMatrix', () => {
  it('counts every COA once and splits tests per column', () => {
    const [row] = buildMatrix(
      [
        coa({ overall: 'FAILED', endo: false }),
        coa({ endo: true, qty: 11, qty_declared: 10 }),
        coa({ qty: 10, qty_declared: 10 }),
      ],
      NOW,
      null
    )
    expect(row?.total).toBe(3)
    expect(row?.failed).toBe(1)
    expect(row?.cells.endo).toMatchObject({ tested: 2, failed: 1 })
    expect(row?.cells.purity).toMatchObject({ tested: 3, failed: 0 })
    expect(row?.qty).toEqual({ n: 2, median: 5, flagged: 0 })
  })

  it('applies the period to counts but not to the trend windows', () => {
    const rows = buildMatrix([coa({ published_at: daysAgo(120) })], NOW, 30)
    expect(rows).toEqual([])
  })

  it('reports a rising sterility trend only with enough tests', () => {
    const coas = [
      ...Array.from({ length: 6 }, (_, i) =>
        coa({ published_at: daysAgo(100 + i), sterility: true })
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        coa({ published_at: daysAgo(10 + i), sterility: i >= 3 ? false : true })
      ),
    ]
    const rows = buildMatrix(coas, NOW, null)
    const cell = (r: typeof rows) => {
      if (!r[0]) throw new Error('no product row')
      return r[0].cells.sterility
    }
    expect(trendPP(cell(rows))).toBeCloseTo(50)
    expect(risingFailures(rows)).toMatchObject([
      { product: 'BPC-157', test: 'sterility' },
    ])

    const thin = buildMatrix(coas.slice(2), NOW, null)
    expect(trendPP(cell(thin))).toBeNull()
  })
})
