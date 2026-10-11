import { describe, it, expect } from 'vitest'
import {
  buildEndoBenchSheet2Html,
  buildEndoCsv2,
  buildEndoSheet2Doc,
  productIdentity,
  type EndoSheet2Doc,
  type EndoSheet2Row,
} from '@/lib/endo-bench-sheet-2ml'
import {
  ENDO_RUN_PARAM_DEFAULTS,
  type EndoCtx,
  type EndoSample,
} from '@/lib/endo-prep-2ml'
import {
  endoItem,
  endoWorksheet,
} from '@/components/hplc/endo/__tests__/endo-fixtures'

const ctx: EndoCtx = {
  params: ENDO_RUN_PARAM_DEFAULTS,
  allowedLambdas: [0.05, 0.01],
}
// Deterministic text widths: 7 px a character, whatever the font.
const measure = (text: string) => text.length * 7

function sample(over: Partial<EndoSample> = {}): EndoSample {
  return {
    sampleId: 'P-0001-S02',
    identity: 'Retatrutide',
    sampleType: 'Peptide',
    weightMg: 10,
    form: null,
    waterMl: null,
    totalDilution: null,
    steps: null,
    lambda: 0.05,
    reading: null,
    reader: null,
    ...over,
  }
}

function row(
  n: number,
  over: Partial<EndoSample> = {},
  rowOver: Partial<EndoSheet2Row> = {}
): EndoSheet2Row {
  return {
    n,
    due: '2026-10-14',
    dueHoliday: false,
    priority: 'normal',
    received: '2026-10-09',
    order: '8860',
    identityAsReceived: 'Retatrutide - Identity (HPLC)',
    sample: sample({ sampleId: `P-000${n}-S02`, ...over }),
    ...rowOver,
  }
}

function bacRow(n: number): EndoSheet2Row {
  return row(
    n,
    {
      sampleId: 'BW-0114-S02',
      identity: 'Bacteriostatic Water',
      sampleType: 'Bacteriostatic Water',
      weightMg: null,
      lambda: 0.01,
    },
    { identityAsReceived: 'Bacteriostatic Water' }
  )
}

function doc(rows: EndoSheet2Row[]): EndoSheet2Doc {
  return {
    title: 'Endo 10/09/2026 #1',
    runName: 'worksheet 77',
    analyst: 'Test Analyst',
    dateMade: '2026-10-09',
    orders: '8860',
    printedAt: '2026-10-10 09:00',
    runLambda: 0.05,
    ctx,
    rows,
    holidayNotes: [],
  }
}

describe('buildEndoBenchSheet2Html', () => {
  it('groups rows by total with a rule per group, numbered as Box 1', () => {
    const html = buildEndoBenchSheet2Html(
      doc([row(1), row(2, { totalDilution: 300 }), row(3), bacRow(4)]),
      { measure }
    )
    expect(
      [...html.matchAll(/<td class="n">(\d+)<\/td>/g)].map(m => m[1])
    ).toEqual(['1', '3', '2', '4'])
    expect(html.match(/<tr class="newtotal">/g)).toHaveLength(2)
    // 1:300 makes step 2 a 1:15 (20 + 280): boxed, with its ratio
    expect(html).toContain('<td class="step odd diff s2">')
    expect(html).toContain('<span class="rat">1:15</span>')
    // bac water: one "50 + 950" cell across the three steps
    expect(html).toContain('<td class="step bwcell" colspan="3">')
    expect(html).toContain(
      '<span class="num">50</span></span><span class="plus">+</span><span class="pc"><span class="cap">LAL water</span><span class="num">950</span>'
    )
    expect(html).toContain('bac water &middot; 1:20 &middot; one tube')
    expect(html).not.toMatch(new RegExp('\u2014|&' + 'mdash;'))
  })

  it('marks hand-set values, boxes off-standard steps and prints the tube overflow in red', () => {
    const html = buildEndoBenchSheet2Html(
      doc([
        row(1, { steps: [{ sampleUl: 30 }, null, null], waterMl: 3 }),
        row(2, { steps: [null, null, { sampleUl: 800 }] }),
      ]),
      { measure }
    )
    expect(html).toContain('<td class="step own diff s1">')
    expect(html).toContain('<span class="rat">1:10</span>')
    expect(html).toContain('<td class="m r vial own">3</td>')
    expect(html).toContain('<td class="step own bad diff s3">')
    expect(html).toContain('<span class="rat">1:2 &middot; over 1.5 mL</span>')
    expect(html).toContain('td.step.bad.diff.s3{outline-color:#8C2822}')
    expect(html).toContain(
      'td.step.own .num{font-weight:700;text-decoration:underline'
    )
    expect(html).toContain(
      '<td class="pep2">Retatrutide<span class="mg">10 mg</span></td>'
    )
    expect(html).toContain(
      '<span class="duepill"><span class="pill default">Default</span></span>'
    )
  })

  it('totals the reagents and tubes on the summary page', () => {
    const html = buildEndoBenchSheet2Html(
      doc([row(1), row(2, { totalDilution: 300 }), row(3), bacRow(4)]),
      { measure }
    )
    expect(html).toContain('<div class="tile"><dt>Samples</dt><dd>4</dd></div>')
    expect(html).toContain(
      '<div class="tile"><dt>Off the standard</dt><dd>1</dd></div>'
    )
    expect(html).toContain(
      '<div class="tile s1"><dt>0.1 M Tris</dt><dd>540<span class="tunit">&micro;L</span></dd></div>'
    )
    expect(html).toContain(
      '<div class="tile s2"><dt>LAL water</dt><dd>1690<span class="tunit">&micro;L</span></dd></div>'
    )
    expect(html).toContain(
      '<div class="tile s3"><dt>BG600</dt><dd>375<span class="tunit">&micro;L</span></dd></div>'
    )
    expect(html).toContain(
      '<div class="tile"><dt>1.5 mL tubes</dt><dd>10</dd></div>'
    )
    expect(html).toContain('A <b>boxed step</b> is not the standard prep')
  })

  it("sizes the row padding with Dennis's fitter, inside its 4 to 22 px bounds", () => {
    expect(buildEndoBenchSheet2Html(doc([row(1)]), { measure })).toContain(
      'td{padding:22.0px 5pt}'
    )
    const ten = Array.from({ length: 10 }, (_, i) => row(i + 1))
    // (732 - 10 - 10 x 42 - 162) / 20 = 7
    expect(buildEndoBenchSheet2Html(doc(ten), { measure })).toContain(
      'td{padding:7.0px 5pt}'
    )
  })

  it('shows the same document as paper when previewed', () => {
    const d = doc([row(1)])
    const printed = buildEndoBenchSheet2Html(d, { measure })
    const preview = buildEndoBenchSheet2Html(d, { measure, preview: true })
    expect(preview).toContain('width:1056px')
    expect(preview.replace(/<style>.*?<\/style>/s, '')).toBe(
      printed.replace(/<style>.*?<\/style>/s, '')
    )
  })
})

describe('buildEndoCsv2', () => {
  it('writes the 2 mL columns, one line per row in Box 1 order, and a run total', () => {
    const csv = buildEndoCsv2(doc([row(1, { reading: '<0.05' })]))
    const lines = csv.trimEnd().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(
      'Received,Due,Priority,Order #,Sample ID,Sample identity,identity as received,Declared wt (mg),form,' +
        'reconstitution water (mL),step 1 sample (uL),step 1 ratio,step 1 Tris (uL),step 2 sample (uL),step 2 ratio,' +
        'step 2 LAL water (uL),step 3 sample (uL),step 3 ratio,step 3 BG600 (uL),total dilution (x),cartridge (EU/mL),' +
        'loaded (mg/mL),MVD (x),MVC (mg/mL),"result as read (EU/mL on MCS, factor 1)",EU/mL of vial solution,' +
        'LOD (EU/mL cartridge),LOQ (EU/vial),EU/vial,EU/mg,limit (EU/vial),bac water limit (EU/mL),verdict,' +
        'Accu-Mk1 value,Accu-Mk1 unit,spike recovery (%),sample CV (%),spike CV (%),reader check,reader test ID,' +
        'reader,cartridge lot,cartridge expiry,operator,tested at,Tris used (uL),LAL water used (uL),BG600 used (uL),tubes'
    )
    expect(lines[1]).toBe(
      [
        '2026-10-09',
        '2026-10-14',
        'default',
        '8860',
        'P-0001-S02',
        'Retatrutide',
        'Retatrutide - Identity (HPLC)',
        '10',
        'powder',
        '2',
        '20',
        '10',
        '180',
        '20',
        '12.5',
        '230',
        '125',
        '2',
        '125',
        '250',
        '0.05',
        '0.02',
        '3500',
        '0.0014',
        '<0.05',
        '<12.5',
        '0.05',
        '25',
        '<25',
        '<2.5',
        '350',
        '',
        'pass',
        '<25',
        'EU/vial',
        ...Array<string>(10).fill(''),
        '180',
        '230',
        '125',
        '3',
      ].join(',')
    )
    expect(lines[2]).toBe(
      [
        '',
        '',
        '',
        '',
        'Run total',
        ...Array<string>(40).fill(''),
        '180',
        '230',
        '125',
        '3',
      ].join(',')
    )
  })

  it('neutralises cells a spreadsheet would run as formulas', () => {
    const csv = buildEndoCsv2(
      doc([
        row(
          1,
          {},
          { identityAsReceived: '=HYPERLINK("http://x")', order: '+8860' }
        ),
      ])
    )
    const line = csv.split('\r\n')[1] ?? ''
    expect(line).toContain('"\'=HYPERLINK(""http://x"")"')
    expect(line).toContain('"\'+8860"')
  })
})

describe('productIdentity on the 2 mL sheet', () => {
  it('strips each analyte of a blend; the doc prints the product and keeps the raw text', () => {
    expect(
      productIdentity('BPC-157 - Identity (HPLC), TB-500 - Identity (HPLC)')
    ).toBe('BPC-157, TB-500')
    const item = endoItem({ sample_identity: 'Retatrutide - Identity (HPLC)' })
    const d = buildEndoSheet2Doc(endoWorksheet([item]), {
      analystName: 'Test Analyst',
      calendar: null,
      printedAt: 'now',
      dueAtByItemId: new Map(),
    })
    expect(d.rows[0]?.sample.identity).toBe('Retatrutide')
    expect(d.rows[0]?.identityAsReceived).toBe('Retatrutide - Identity (HPLC)')
    expect(d.runLambda).toBe(0.05)
  })
})
