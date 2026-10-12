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
import { buildEndoSheetDoc } from '@/lib/endo-worksheet'
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
    expect(html).toContain('<td class="step odd diff dtop dbot s2">')
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
    expect(html).toContain('<td class="step own diff dtop dbot s1">')
    expect(html).toContain('<span class="rat">1:10</span>')
    expect(html).toContain('<td class="m r vial own">3</td>')
    expect(html).toContain('<td class="step own bad diff s3">')
    expect(html).toContain('<span class="rat">1:2 &middot; over 1.5 mL</span>')
    expect(html).toContain(
      'td.step.bad.diff{outline:1.5pt solid #8C2822;outline-offset:-1.5pt}'
    )
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

  describe('one outline per run of the same non-standard step (Dennis 8fae7bb)', () => {
    /** Step `sn`'s cell classes, in print order. */
    const stepCells = (html: string, sn: number) =>
      [
        ...html.matchAll(new RegExp(`<td class="(step[^"]* s${sn})">`, 'g')),
      ].map(m => m[1])
    const at300 = (n: number, over: Partial<EndoSample> = {}) =>
      row(n, { totalDilution: 300, ...over })

    it('draws the top on the first cell, the bottom on the last and only the sides between', () => {
      const html = buildEndoBenchSheet2Html(
        doc([at300(1), at300(2), at300(3)]),
        { measure }
      )
      expect(stepCells(html, 2)).toEqual([
        'step odd diff dtop s2',
        'step odd diff s2',
        'step odd diff dbot s2',
      ])
      // standard steps are not boxed
      expect(stepCells(html, 1)).toEqual(['step s1', 'step s1', 'step s1'])
      // inset shadows, so a box adds no height; no per-cell outline any more
      expect(html).toContain(
        'td.step.diff:not(.bad){box-shadow:inset 1.5pt 0 0 var(--dc),inset -1.5pt 0 0 var(--dc)}'
      )
      expect(html).toContain(
        'td.step.diff.dtop{box-shadow:inset 1.5pt 0 0 var(--dc),inset -1.5pt 0 0 var(--dc),inset 0 1.5pt 0 var(--dc)}'
      )
      expect(html).toContain(
        'td.step.diff.dbot{box-shadow:inset 1.5pt 0 0 var(--dc),inset -1.5pt 0 0 var(--dc),inset 0 -1.5pt 0 var(--dc)}'
      )
      expect(html).not.toContain('td.step.diff{outline')
    })

    it('starts a new box where the volumes change', () => {
      // rows 3 and 4 take 40 uL into step 2: same 1:15, different volumes
      const own: Partial<EndoSample> = {
        steps: [null, { sampleUl: 40 }, null],
      }
      const html = buildEndoBenchSheet2Html(
        doc([at300(1), at300(2), at300(3, own), at300(4, own)]),
        { measure }
      )
      expect(stepCells(html, 2)).toEqual([
        'step odd diff dtop s2',
        'step odd diff dbot s2',
        'step own odd diff dtop s2',
        'step own odd diff dbot s2',
      ])
    })

    it('starts a new box at a page edge, and the pages and their rows do not change', () => {
      const twelve = Array.from({ length: 12 }, (_, i) => at300(i + 1))
      const html = buildEndoBenchSheet2Html(doc(twelve), { measure })
      const s2 = stepCells(html, 2)
      expect(s2[0]).toBe('step odd diff dtop s2')
      expect(s2.slice(1, 9)).toEqual(Array(8).fill('step odd diff s2'))
      expect(s2[9]).toBe('step odd diff dbot s2')
      expect(s2[10]).toBe('step odd diff dtop s2')
      expect(s2[11]).toBe('step odd diff dbot s2')
      // guard, measured before the outlines changed: two table pages of 10
      // and 2 rows at 4 px of padding (ten three-line rows on page 1)
      const pages = [
        ...html.matchAll(/<section class="page">.*?<\/section>/g),
      ].map(m => (m[0].match(/<tr[ >]/g) ?? []).length - 1)
      expect(pages).toEqual([10, 2])
      expect(html).toContain('td{padding:4.0px 5pt}')
    })

    it('starts a new box at a new total, its top just under the group line', () => {
      // step 1 is 30 + 270 at both totals; the group line still splits them
      const s1: Partial<EndoSample> = { steps: [{ sampleUl: 30 }, null, null] }
      const html = buildEndoBenchSheet2Html(doc([row(1, s1), at300(2, s1)]), {
        measure,
      })
      expect(stepCells(html, 1)).toEqual([
        'step own diff dtop dbot s1',
        'step own diff dtop dbot s1',
      ])
      expect(html).toContain('<tr class="newtotal"><td class="n">2</td>')
      expect(html).toContain(
        'tr.newtotal td.step.diff.dtop{box-shadow:inset 0 2pt 0 #41595F,inset 1.5pt 0 0 var(--dc),inset -1.5pt 0 0 var(--dc),inset 0 3.5pt 0 var(--dc)}'
      )
    })

    it('keeps an over-tube step in its own red box, out of any run', () => {
      const over: Partial<EndoSample> = {
        steps: [null, null, { sampleUl: 800 }],
      }
      const html = buildEndoBenchSheet2Html(doc([row(1, over), row(2, over)]), {
        measure,
      })
      expect(stepCells(html, 3)).toEqual([
        'step own bad diff s3',
        'step own bad diff s3',
      ])
    })
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

describe('buildEndoSheet2Doc order', () => {
  const opts = {
    analystName: 'Test Analyst',
    calendar: null,
    printedAt: 'now',
    dueAtByItemId: new Map<number, string | null>(),
  }
  // No due dates, so bench order falls to priority, then the worksheet's own
  // order: expedited and first in the worksheet puts it at the top.
  const bw = endoItem({
    sample_id: 'BW-0114-S02',
    sample_identity: 'Bacteriostatic Water',
    sample_type: 'Bacteriostatic Water',
    priority: 'expedited',
  })
  const pep = endoItem({ sample_id: 'P-0200-S02' })

  it('numbers bac water last, as Box 1 does, whatever its priority or place in the worksheet', () => {
    const d = buildEndoSheet2Doc(endoWorksheet([bw, pep]), opts)
    expect(d.rows.map(r => [r.n, r.sample.sampleId])).toEqual([
      [1, 'P-0200-S02'],
      [2, 'BW-0114-S02'],
    ])
    const csv = buildEndoCsv2(d).trimEnd().split('\r\n')
    expect(csv[1]).toContain('P-0200-S02')
    expect(csv[2]).toContain('BW-0114-S02')
  })

  it('the stock sheet keeps bench order: bac water stays where it sorts', () => {
    const d = buildEndoSheetDoc(
      endoWorksheet([bw, pep], { endo_prep: 'stock' }),
      opts
    )
    expect(d.rows.map(r => r.sampleId)).toEqual(['BW-0114-S02', 'P-0200-S02'])
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
