import { describe, it, expect } from 'vitest'
import {
  buildEndoBenchSheet2Html,
  buildEndoCsv2,
  buildEndoSheet2Doc,
  planEndoSheet2,
  productIdentity,
  type EndoSheet2Doc,
  type EndoSheet2Row,
} from '@/lib/endo-bench-sheet-2ml'
import {
  ENDO_RUN_PARAM_DEFAULTS,
  type EndoCtx,
  type EndoSample,
} from '@/lib/endo-prep-2ml'
import type { EndoPrepRule } from '@/lib/endo-prep-rules'
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

/** The row padding (px) the fitter printed. */
const padOf = (html: string) => /td\{padding:([\d.]+)px 5pt\}/.exec(html)?.[1]

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

  it('counts the 1pt margin over the declared mg in a wrapping name', () => {
    // two name lines plus the mg line, and the mg line's 1pt top margin:
    // (732 - 10 - 162 - 10 x (3 x 15.4 + 4/3)) / 20 = 4.23
    const ten = Array.from({ length: 10 }, (_, i) =>
      row(i + 1, { identity: 'Ipamorelin, Sermorelin' })
    )
    expect(padOf(buildEndoBenchSheet2Html(doc(ten), { measure }))).toBe('4.2')
  })

  /** Table pages' row counts as printed. */
  const printedPages = (html: string) =>
    [...html.matchAll(/<section class="page">.*?<\/section>/g)].map(
      m => (m[0].match(/<tr[ >]/g) ?? []).length - 1
    )

  /** Plan and print one document; the printout must follow the plan. */
  function planned(d: EndoSheet2Doc) {
    const plan = planEndoSheet2(d, measure)
    const html = buildEndoBenchSheet2Html(d, { measure })
    expect(printedPages(html)).toEqual(plan.rows)
    expect(padOf(html)).toBe(plan.pad.toFixed(1))
    // every page, as the fitter plans it, stays inside the sheet
    for (const h of plan.pageHeights) expect(h).toBeLessThanOrEqual(plan.budget)
    return { plan, html }
  }

  it('estimates a step row from its cells as measured in print', () => {
    const one = (over: Partial<EndoSample>) =>
      planEndoSheet2(doc([row(1, over)]), measure).rowHeights
    // the standard row keeps Dennis's 42; a boxed step with its note line
    // measures 51.4 px, so 53; an over-tube note that wraps, 64.4, so 66
    expect(one({})).toEqual([42])
    expect(one({ totalDilution: 300 })).toEqual([53])
    expect(one({ steps: [null, null, { sampleUl: 800 }] })).toEqual([53])
    expect(one({ totalDilution: 3333 })).toEqual([66])
  })

  it('moves rows to the next page when ten tall rows would run past the sheet', () => {
    // twelve boxed-step rows (53 px each): at the 4 px floor page one holds
    // (732 - 10 - 162) / (53 + 2 x 4) = 9.2 rows, so 9, padded to fill it:
    // (560 - 9 x 53) / 18 = 4.61, printed 4.6
    const twelve = Array.from({ length: 12 }, (_, i) =>
      row(i + 1, { totalDilution: 300 })
    )
    const { plan, html } = planned(doc(twelve))
    expect(plan.rows).toEqual([9, 3])
    expect(plan.pad).toBe(4.6)
    expect(html).toContain(
      'Samples <b>1&ndash;9</b> of 12 &middot; <b>Page 1 of 3</b>'
    )
    expect(html).toContain(
      'Samples <b>10&ndash;12</b> of 12 &middot; <b>Page 2 of 3</b>'
    )
  })

  it('keeps ten rows with five boxed steps on one sheet, the padding rounded down', () => {
    // (560 - 5 x 53 - 5 x 42) / 20 = 4.25: one page, printed 4.2, never 4.3
    const ten = Array.from({ length: 10 }, (_, i) =>
      row(i + 1, i < 5 ? { totalDilution: 300 } : {})
    )
    const { plan } = planned(doc(ten))
    expect(plan.rows).toEqual([10])
    expect(plan.pad).toBe(4.2)
  })

  it('pays for a two-line meta strip on page one', () => {
    // the Orders list wraps the strip: page one's chrome is 162 + 26.94, so
    // (722 - 188.94) / 61 = 8.7 rows, 8, padded (533.06 - 8 x 53) / 16 = 6.8
    const twelve = Array.from({ length: 12 }, (_, i) =>
      row(i + 1, { totalDilution: 300 })
    )
    const { plan } = planned({
      ...doc(twelve),
      orders: '8860, 8861, 8862, 8863, 8864, 8865',
    })
    expect(plan.rows).toEqual([8, 4])
    expect(plan.pad).toBe(6.8)
  })

  it('breaks the page where rows of wrapping names would run past the sheet', () => {
    // three name lines and the mg line: 4 x 15.4 + 4/3 = 62.93 a row, so
    // (722 - 162) / (62.93 + 8) = 7.9 rows on page one
    const twelve = Array.from({ length: 12 }, (_, i) =>
      row(i + 1, { identity: 'CJC-1295 (no DAC), Ipamorelin' })
    )
    const { plan } = planned(doc(twelve))
    expect(plan.rowHeights[0]).toBeCloseTo(4 * 15.4 + 4 / 3)
    expect(plan.rows).toEqual([7, 5])
  })

  it('counts a long spaceless name as the lines it wraps to on paper', () => {
    const height = (identity: string) =>
      planEndoSheet2(doc([row(1, { identity })]), measure).rowHeights[0]
    // breaks after a hyphen or a slash, not a slash after a digit:
    // [BPC-157/TB-] [500/GHK-Cu/] [KPV], then the mg line
    expect(height('BPC-157/TB-500/GHK-Cu/KPV')).toBeCloseTo(4 * 15.4 + 4 / 3)
    // no break at all: 28 x 7 = 196 px over an 81.8 px column, 3 lines
    expect(height('Thymosinalpha1/Thymosinbeta4')).toBeCloseTo(4 * 15.4 + 4 / 3)
    // 140 px, 2 lines
    expect(height('Glutathionedisulfide')).toBeCloseTo(3 * 15.4 + 4 / 3)
    // 23 x 7 = 161 px, under 2 x 81.8, but a line holds 11 whole characters
    // (77 px): [11] [11] [1], 3 lines, as Chrome fills it
    expect(height('Abcdefghijklmnopqrstuvw')).toBeCloseTo(4 * 15.4 + 4 / 3)
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

    it('starts a new box at a page edge', () => {
      // twelve boxed-step rows break 9 and 3 (see the page fitter test)
      const twelve = Array.from({ length: 12 }, (_, i) => at300(i + 1))
      const html = buildEndoBenchSheet2Html(doc(twelve), { measure })
      const s2 = stepCells(html, 2)
      expect(s2[0]).toBe('step odd diff dtop s2')
      expect(s2.slice(1, 8)).toEqual(Array(7).fill('step odd diff s2'))
      expect(s2[8]).toBe('step odd diff dbot s2')
      expect(s2[9]).toBe('step odd diff dtop s2')
      expect(s2[10]).toBe('step odd diff s2')
      expect(s2[11]).toBe('step odd diff dbot s2')
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

  describe('method rules (slice 5, Dennis efbc160)', () => {
    const trial300: EndoPrepRule = {
      id: 1,
      peptide_id: 7,
      min_mg: null,
      max_mg: null,
      recon_water_ml: null,
      total_dilution: 300,
      step1_ratio: null,
      cartridge_type_id: null,
      status: 'trial',
      note: '60 mg PPC low at 1:250',
      sort_order: 0,
      active: true,
    }
    const valid300: EndoPrepRule = {
      ...trial300,
      id: 2,
      min_mg: 30,
      status: 'validated',
      note: null,
    }

    it('marks a ruled ratio "rule (trial)" or "rule", and lists the lines used on the summary', () => {
      const html = buildEndoBenchSheet2Html(
        doc([
          row(1, { rule: trial300 }, { locked: true }),
          row(2, { rule: trial300 }),
          row(3, { rule: valid300, weightMg: 60 }),
        ]),
        { measure }
      )
      // 1:300 makes step 2 a 1:15: the rule set it
      expect(html).toContain(
        '<span class="rat">1:15 &middot; rule (trial)</span>'
      )
      expect(html).toContain('<span class="rat">1:15 &middot; rule</span>')
      // a ruled step off the standard is boxed as any other (A.0 item 6,
      // Dennis): one outline down the run of 20 + 280
      expect(
        [...html.matchAll(/<td class="(step[^"]* s2)">/g)].map(m => m[1])
      ).toEqual([
        'step odd diff dtop s2',
        'step odd diff s2',
        'step odd diff dbot s2',
      ])
      expect(html).toContain(
        '<h2 class="ruleshead">Method rules used in this run</h2>'
      )
      expect(html).toContain(
        '<div><span class="st trial">trial</span><span class="rl">Retatrutide any weight · 1:300 total</span>' +
          '<span class="rn">2 samples (1 locked) &middot; 60 mg PPC low at 1:250</span></div>'
      )
      expect(html).toContain(
        '<div><span class="st validated">validated</span><span class="rl">Retatrutide above 30 mg · 1:300 total</span>' +
          '<span class="rn">1 sample</span></div>'
      )
      // short, so a read note with all four of its sentences stays at two
      // lines (fix round 2: 6 due dates and 4 rules then fit one sheet)
      expect(html).toContain(
        'next total. Marked <b>rule</b> or <b>R</b>: a method rule set it.</p>'
      )
      expect(html).toContain('A <b>boxed step</b> is not the standard prep')
      // a ruled ratio is not a value set by hand: not underlined
      expect(html).not.toContain('<b>Underlined</b>')
      expect(html).not.toMatch(new RegExp('\u2014|&' + 'mdash;'))
    })

    it('boxes a ruled 1:300 step 2 as 20 + 280, with its "1:15 · rule" and the R on its cartridge', () => {
      const r300c4: EndoPrepRule = {
        ...valid300,
        min_mg: null,
        cartridge_type_id: 4,
      }
      const html = buildEndoBenchSheet2Html(
        doc([row(1, { rule: r300c4, lambda: 0.01 }, { cartridgeRuled: true })]),
        { measure }
      )
      expect(html).toContain(
        '<td class="step odd diff dtop dbot s2"><span class="pair">' +
          '<span class="pc k1"><span class="cap c1">step 1</span><span class="num">20</span></span>' +
          '<span class="plus">+</span>' +
          '<span class="pc k2"><span class="cap c2">water</span><span class="num">280</span></span></span>' +
          '<span class="rat">1:15 &middot; rule</span></td>'
      )
      expect(html).toContain(
        '<td class="cart set">0.01<sup class="rmark">R</sup></td>'
      )
    })

    it('underlines and marks a recon water a rule set, so the bench adds that volume', () => {
      // The whole point of a ruled water: the tech works from this paper, so
      // a 3 mL row must not read as the standard 2 mL it is printed beside.
      const r3 = { ...trial300, total_dilution: null, recon_water_ml: 3 }
      const html = buildEndoBenchSheet2Html(doc([row(1, { rule: r3 })]), {
        measure,
      })
      expect(html).toContain(
        '<td class="m r vial own">3<sup class="rmark">R</sup></td>'
      )
      expect(html).toContain(
        '<b>Underlined</b> figures were set for that sample, not the standard. '
      )
      // A row at the standard is neither underlined nor marked.
      const plain = buildEndoBenchSheet2Html(doc([row(1)]), { measure })
      expect(plain).toContain('<td class="m r vial">2</td>')
    })

    it('puts an R on a cartridge a rule set', () => {
      const r4 = { ...trial300, total_dilution: null, cartridge_type_id: 4 }
      const html = buildEndoBenchSheet2Html(
        doc([row(1, { rule: r4, lambda: 0.01 }, { cartridgeRuled: true })]),
        { measure }
      )
      expect(html).toContain(
        '<td class="cart set">0.01<sup class="rmark">R</sup></td>'
      )
      expect(html).toContain('sup.rmark{')
      expect(html).toContain(
        'Marked <b>rule</b> or <b>R</b>: a method rule set it.</p>'
      )
    })

    it("prints a special prep's note under its peptide, and the fitter counts its lines", () => {
      const html = buildEndoBenchSheet2Html(
        doc([
          row(1, {}, { rulesOff: true, note: '4 mL' }),
          row(2, {}, { rulesOff: true }),
        ]),
        { measure }
      )
      expect(html).toContain(
        '<td class="pep2">Retatrutide<span class="mg">10 mg</span><span class="sp">special prep: 4 mL</span></td>'
      )
      expect(html).toContain('<span class="sp">special prep</span>')
      // the name, the mg and "special prep: 4 mL" on two lines of the 81.8 px
      // column, each extra line with its 1pt margin
      expect(
        planEndoSheet2(
          doc([row(1, {}, { rulesOff: true, note: '4 mL' })]),
          measure
        ).rowHeights[0]
      ).toBeCloseTo(4 * 15.4 + 8 / 3)
    })

    it('measures a ruled note that wraps, so twelve such rows still fit their pages', () => {
      const one = (rule: EndoPrepRule) =>
        planEndoSheet2(doc([row(1, { rule })]), measure).rowHeights
      // "1:15 · rule" is 77 px of the 126 px step column: one note line;
      // "1:15 · rule (trial)" is 133 px: two, as an over-tube note's
      expect(one(valid300)).toEqual([53])
      expect(one(trial300)).toEqual([66])
      // (722 - 162) / (66 + 2 x 4) = 7.6 rows on page one
      const twelve = Array.from({ length: 12 }, (_, i) =>
        row(i + 1, { rule: trial300 })
      )
      expect(planned(doc(twelve)).plan.rows).toEqual([7, 5])
    })

    it('lists at most four rules on one line each, else three and "and K more"', () => {
      /** Rows 1 to `count`, each under its own line. */
      const ruled = (count: number) =>
        doc(
          Array.from({ length: count }, (_, i) =>
            row(i + 1, {
              rule: { ...valid300, id: i + 1, min_mg: (i + 1) * 10 },
              weightMg: (i + 1) * 10 + 5,
            })
          )
        )
      const lines = (html: string) =>
        (html.match(/<div><span class="st /g) ?? []).length
      const four = buildEndoBenchSheet2Html(ruled(4), { measure })
      expect(lines(four)).toBe(4)
      expect(four).not.toContain('class="more"')
      const six = buildEndoBenchSheet2Html(ruled(6), { measure })
      expect(lines(six)).toBe(3)
      expect(six).toContain(
        '<div class="more">and 3 more rules (see the Prep rules page)</div></div>'
      )
      // one line each, cut at the end; the summary closes up around it
      expect(six).toContain(
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      )
      expect(six).toContain('<section class="page summary two used">')
    })

    it('a sheet without a rule or a special prep carries none of their CSS', () => {
      const html = buildEndoBenchSheet2Html(doc([row(1), row(2)]), {
        measure,
      })
      expect(html).not.toContain('rmark')
      expect(html).not.toContain('usedrules')
      expect(html).not.toContain('Method rules used')
      expect(html).not.toContain('class="sp"')
      expect(html).toContain('<section class="page summary two">')
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

describe('buildEndoSheet2Doc under method rules (slice 5)', () => {
  it('carries the rule, the lock, the special prep and the ruled cartridge from the worksheet', () => {
    const r4: EndoPrepRule = {
      id: 1,
      peptide_id: 7,
      min_mg: null,
      max_mg: null,
      recon_water_ml: null,
      total_dilution: null,
      step1_ratio: null,
      cartridge_type_id: 4,
      status: 'trial',
      note: null,
      sort_order: 0,
      active: true,
    }
    const d = buildEndoSheet2Doc(
      endoWorksheet([
        endoItem({ sample_id: 'P-0001-S02', sample_peptide_id: 7 }),
        endoItem({
          sample_id: 'P-0002-S02',
          sample_peptide_id: 7,
          prep_rule: {
            rule: r4,
            locked_at: '2026-10-14T15:00:00Z',
            locked_by: 'print',
            user_id: 5,
          },
        }),
        endoItem({
          sample_id: 'P-0003-S02',
          sample_peptide_id: 7,
          prep_rules_off: true,
          prep_note: '4 mL',
        }),
      ]),
      {
        analystName: 'Test Analyst',
        calendar: null,
        printedAt: 'now',
        dueAtByItemId: new Map(),
      },
      [],
      [r4]
    )
    expect(
      d.rows.map(r => [
        r.sample.sampleId,
        r.sample.rule?.id ?? null,
        r.sample.lambda,
        r.locked,
        r.rulesOff,
        r.note,
        r.cartridgeRuled,
      ])
    ).toEqual([
      ['P-0001-S02', 1, 0.01, false, false, null, true],
      ['P-0002-S02', 1, 0.01, true, false, null, true],
      ['P-0003-S02', null, 0.05, false, true, '4 mL', false],
    ])
    expect(d.cartridgeLabels).toEqual({
      3: '0.05 cartridge',
      4: '0.01 cartridge',
    })
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
