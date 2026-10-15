// Dennis's reader vectors, ported from tools-dennis/tools/endotoxin-log/calc.test.js
// at 5ef2a62. The export below is HIS made-up one (calc.test.js:971-990, same
// IDs and values); real reader files never go in a test. Validity is checked
// against the method's run parameters (spec 4.4); his storage lines (fromStored)
// and his intake file are not Mk1's.
import { describe, it, expect } from 'vitest'
import {
  BW_LAMBDA,
  ENDO_RUN_PARAM_DEFAULTS,
  mk1Value,
  prep2Result,
  type EndoCtx,
  type EndoReaderRecord,
  type EndoSample,
} from '@/lib/endo-prep-2ml'
import {
  baseSampleId,
  matchReaderTests,
  parseEndoScan,
  readerCartridgeLambda,
  readerValidity,
  splitIdentity,
  toReaderRecord,
  type ReaderTest,
} from '@/lib/endo-reader'

// A reader export in the same shape as EndoScan-V's, with made-up IDs and values.
interface EsRow {
  ch: number
  oq?: string
  onset: number
  kind: 'SPL1' | 'SPK1'
  sid: string
  identity: string
  rec?: number
  cv: string
  spikeEu?: string
  tid: string
  /** The operator's free-text fields: '1009' (identity, type, ID), '1014' (ID, product, short name). */
  ids?: '1009' | '1014'
  short?: string
}
function esRow(o: EsRow): string {
  const r = new Array<string>(79).fill('')
  const set = (i: number, v: string | number | undefined) => {
    r[i] = v === undefined ? '' : String(v)
  }
  set(0, o.ch)
  set(1, 0)
  set(2, o.oq)
  set(3, o.onset)
  set(10, o.kind)
  if (o.ids === '1014') {
    set(11, o.sid)
    set(12, o.identity)
    set(13, o.short ?? 'short')
  } else {
    set(11, o.identity)
    set(12, 'Peptide')
    set(13, o.sid)
  }
  set(14, 'mL')
  set(16, o.kind === 'SPK1' ? 0.8 : 1)
  set(18, o.rec)
  set(22, o.cv)
  set(24, 25)
  if (o.kind === 'SPK1') {
    const rec = o.rec ?? 0
    set(6, 50)
    set(7, 200)
    set(27, o.spikeEu)
    set(29, rec >= 50 && rec <= 200 ? 1 : 0)
  } else {
    set(26, '<')
    set(27, '0.05')
    set(28, 1)
  }
  set(31, '5-0.05')
  set(39, '6.2.2.PTS150 V11.1.2')
  set(44, '1111111111')
  set(66, 'Test Analyst')
  set(67, '2026-10-09T15:03:15-07:00')
  set(70, 'MCS 0000001')
  set(71, '37.0')
  set(72, '36.9')
  set(73, o.tid)
  set(75, '9999 - MCS 0000001/1')
  return r.join(',')
}
function esTest(
  tid: string,
  sid: string,
  identity: string,
  rec: number,
  spikeCv: string,
  ids: '1009' | '1014' = '1009',
  short?: string
): string {
  const spikeEu = (rec * 0.008).toFixed(3)
  return [
    esRow({
      ch: 1,
      oq: '>',
      onset: 759,
      kind: 'SPL1',
      sid,
      identity,
      cv: '0.0',
      tid,
      ids,
      short,
    }),
    esRow({
      ch: 2,
      onset: 300,
      kind: 'SPK1',
      sid,
      identity,
      rec,
      cv: spikeCv,
      spikeEu,
      tid,
      ids,
      short,
    }),
    esRow({
      ch: 3,
      oq: '>',
      onset: 759,
      kind: 'SPL1',
      sid,
      identity,
      cv: '0.0',
      tid,
      ids,
      short,
    }),
    esRow({
      ch: 4,
      onset: 310,
      kind: 'SPK1',
      sid,
      identity,
      rec,
      cv: spikeCv,
      spikeEu,
      tid,
      ids,
      short,
    }),
    '',
    '_Cartridge,5 - 0.05,1111111111,2028-06-01T00:00:00-07:00,222222222222',
    '',
  ].join('\r\n')
}
const EXPORT =
  esTest('CRL-T-001', 'P-9001', 'Examplerelin', 87, '3.7') +
  '\r\n' +
  esTest('CRL-T-002', 'P-9002', 'Testpeptide', 44, '1.7') +
  '\r\n' +
  esTest('CRL-T-003', 'PB-9003', 'Blend A + Blend B', 75, '26.0')

const params = ENDO_RUN_PARAM_DEFAULTS

describe("the operator's ID fields in either order", () => {
  it('finds the Sample ID by its shape in the 2026-10-14 order (ID, product, short name)', () => {
    const file =
      esTest('CRL-T-101', 'P-5397-S02', 'MOTS-c', 133, '6.1', '1014', 'mot-c') +
      '\r\n' +
      esTest(
        'CRL-T-102',
        'PB-1081-S02',
        'BPC-157 + TB500 (17-23 Fragment)',
        120,
        '4.1',
        '1014',
        '"BPC-157, TB500"'
      )
    const { tests } = parseEndoScan(file)
    expect(tests.map(t => [t.sampleId, t.identity, t.result])).toEqual([
      ['P-5397-S02', 'MOTS-c', '<0.05'],
      ['PB-1081-S02', 'BPC-157 + TB500 (17-23 Fragment)', '<0.05'],
    ])
    const m = matchReaderTests(tests, [
      { itemId: 1, sampleId: 'P-5397-S02' },
      { itemId: 2, sampleId: 'PB-1081-S02' },
    ])
    expect(m.matched.map(x => [x.itemId, x.via])).toEqual([
      [1, 'exact'],
      [2, 'exact'],
    ])
    expect(m.unmatched).toEqual([])
  })

  it('never takes a peptide name for the Sample ID in the 2026-10-09 order', () => {
    for (const name of ['BPC-157', 'PT-141', 'AOD-9604', 'CJC-1295']) {
      const [t] = parseEndoScan(
        esTest('CRL-T-103', 'P-9004', name, 90, '2.0')
      ).tests
      expect([t?.sampleId, t?.identity]).toEqual(['P-9004', name])
    }
  })
})
const three = (tests: ReaderTest[]) =>
  tests as [ReaderTest, ReaderTest, ReaderTest]

describe('calc.test.js:992 reader export: one record per test, spike recovery and CV checked', () => {
  it('matches Dennis', () => {
    const { tests, cartridges } = parseEndoScan(EXPORT)
    expect(tests).toHaveLength(3)
    expect(cartridges).toEqual([
      {
        range: '5 - 0.05',
        lot: '1111111111',
        expiry: '2028-06-01',
        code: '222222222222',
      },
    ]) // once, though it repeats
    const [a, b, c] = three(tests)
    expect([a.sampleId, a.identity, a.testId]).toEqual([
      'P-9001',
      'Examplerelin',
      'CRL-T-001',
    ])
    expect([a.result, a.lt, a.value]).toEqual(['<0.05', true, 0.05])
    expect([a.recovery, a.spikeCv, a.sampleCv, a.cvLimit]).toEqual([
      87, 3.7, 0, 25,
    ])
    expect(readerValidity(a, params)).toEqual({ valid: true, why: [] })
    expect(a.readerPass).toBe(true)
    expect([a.cartLot, a.cartExpiry]).toEqual(['1111111111', '2028-06-01'])
    expect([a.reader, a.operator]).toEqual(['MCS 0000001', 'Test Analyst'])
    expect([a.tempStart, a.tempEnd]).toEqual([37, 36.9])
    expect(a.slot).toBe(1) // his slot cell "9999 - MCS 0000001/1"
    // 44 % recovery: invalid, and the reader's own flag agrees
    expect(readerValidity(b, params)).toEqual({
      valid: false,
      why: ['spike recovery 44 % outside 50-200 %'],
    })
    expect(b.readerPass).toBe(false)
    // a spike CV over 25 %: invalid on the numbers though the recovery is fine
    expect(readerValidity(c, params)).toEqual({
      valid: false,
      why: ['spike CV 26 % over 25 %'],
    })
    // not a reader export
    expect(() => parseEndoScan('Received,Sample ID\n2026-10-09,P-1\n')).toThrow(
      /not a reader export/
    )
  })

  it("judges against the method's limits, and the record keeps the file's beside them", () => {
    const [a, b, c] = three(parseEndoScan(EXPORT).tests)
    expect(readerValidity(a, { ...params, spikeRecoveryMinPct: 90 })).toEqual({
      valid: false,
      why: ['spike recovery 87 % outside 90-200 %'],
    })
    expect(readerValidity(c, { ...params, cvLimitPct: 30 })).toEqual({
      valid: true,
      why: [],
    })
    const rec = toReaderRecord(
      a,
      { ...params, spikeRecoveryMinPct: 90 },
      'EndoScanV-Export-test.csv'
    )
    expect([rec.rec_min, rec.rec_max, rec.cv_limit]).toEqual([50, 200, 25])
    expect([rec.valid, rec.why]).toEqual([
      false,
      ['spike recovery 87 % outside 90-200 %'],
    ])
    expect(toReaderRecord(b, params, 'EndoScanV-Export-test.csv')).toEqual({
      test_id: 'CRL-T-002',
      result: '<0.05',
      reader: 'MCS 0000001',
      slot: 1,
      operator: 'Test Analyst',
      tested_at: '2026-10-09T15:03:15-07:00',
      temp_start: 37,
      temp_end: 36.9,
      software: '6.2.2.PTS150 V11.1.2',
      cartridge_lot: '1111111111',
      cartridge_expiry: '2028-06-01',
      cartridge_range: '5-0.05',
      spike_level: 0.8,
      recovery: 44,
      rec_min: 50,
      rec_max: 200,
      sample_cv: 0,
      spike_cv: 1.7,
      cv_limit: 25,
      reader_pass: false,
      valid: false,
      why: ['spike recovery 44 % outside 50-200 %'],
      file_name: 'EndoScanV-Export-test.csv',
    } satisfies EndoReaderRecord)
  })

  it('a missing recovery, sample CV or spike CV fails closed, in the server wording', () => {
    const [a] = three(parseEndoScan(EXPORT).tests)
    expect(readerValidity({ ...a, sampleCv: null }, params)).toEqual({
      valid: false,
      why: ['no sample CV'],
    })
    expect(readerValidity({ ...a, spikeCv: null }, params)).toEqual({
      valid: false,
      why: ['no spike CV'],
    })
    expect(readerValidity({ ...a, recovery: null }, params)).toEqual({
      valid: false,
      why: ['no spike recovery'],
    })
    expect(
      readerValidity(
        { ...a, recovery: null, sampleCv: null, spikeCv: null },
        params
      )
    ).toEqual({
      valid: false,
      why: ['no spike recovery', 'no sample CV', 'no spike CV'],
    })
    // a sample CV over the limit is named as the sample's, not the spike's
    expect(readerValidity({ ...a, sampleCv: 30 }, params)).toEqual({
      valid: false,
      why: ['sample CV 30 % over 25 %'],
    })
    // the record carries the same verdict
    const rec = toReaderRecord(
      { ...a, sampleCv: null },
      params,
      'EndoScanV-Export-test.csv'
    )
    expect([rec.valid, rec.why]).toEqual([false, ['no sample CV']])
  })

  it('RF1: BOM, CRLF, trailing blank lines and padded cells parse the same', () => {
    const lf = EXPORT.replace(/\r\n/g, '\n')
    const messy =
      '\uFEFF' +
      lf
        .split('\n')
        .map(line =>
          line
            .split(',')
            .map(c => `  ${c} `)
            .join(',')
        )
        .join('\r\n') +
      '\r\n\r\n   \r\n'
    const clean = parseEndoScan(lf)
    expect(clean.tests).toHaveLength(3)
    expect(parseEndoScan(messy)).toEqual(clean)
    expect(parseEndoScan(EXPORT)).toEqual(clean)
  })

  it('RF1: anything that is not this export throws a readable error', () => {
    for (const bad of [
      '',
      'Order,Sample ID,Peptide\n9001,P-0101,Examplerelin\n',
      '1,2,3\n4,5,6\n',
    ])
      expect(() => parseEndoScan(bad)).toThrow(
        'This is not a reader export: no test rows (channel 1-4, 79 columns) were found.'
      )
  })

  it('a file with channel rows but no sample/spike pair is not this export either', () => {
    // a wrong or column-shifted file must not come back as {tests: []}
    for (const bad of [
      EXPORT.replace(/SPK1/g, 'SPK9'),
      EXPORT.replace(/SPL1/g, 'SPL9'),
      EXPORT.replace(/SPL1|SPK1/g, 'XXXX'),
    ])
      expect(() => parseEndoScan(bad)).toThrow(
        'This is not a reader export: no test rows (channel 1-4, 79 columns) were found.'
      )
  })

  it('a result qualifier other than "<" is kept verbatim and is never an exact number', () => {
    // column 26 ">" on the first test: the reading is ">5.00", not 5
    const odd = parseEndoScan(EXPORT.replace(',<,0.05,', ',>,5.00,'))
    const [a, b] = three(odd.tests)
    expect([a.result, a.lt, a.value]).toEqual(['>5.00', false, null])
    expect(toReaderRecord(a, params, 'EndoScanV-Export-test.csv').result).toBe(
      '>5.00'
    )
    // the others keep reading as before
    expect([b.result, b.lt, b.value]).toEqual(['<0.05', true, 0.05])
    // no qualifier at all is an exact number
    const exact = parseEndoScan(EXPORT.replace(',<,0.05,', ',,0.05,'))
    expect([exact.tests[0]?.result, exact.tests[0]?.lt]).toEqual([
      '0.05',
      false,
    ])
    expect(exact.tests[0]?.value).toBe(0.05)
  })
})

const ctx: EndoCtx = { params, allowedLambdas: [0.05, 0.01, 0.005] }
function record(valid: boolean, why: string[]): EndoReaderRecord {
  return {
    test_id: 'CRL-T-001',
    result: '<0.05',
    reader: null,
    slot: null,
    operator: null,
    tested_at: null,
    temp_start: null,
    temp_end: null,
    software: null,
    cartridge_lot: null,
    cartridge_expiry: null,
    cartridge_range: null,
    spike_level: null,
    recovery: null,
    rec_min: null,
    rec_max: null,
    sample_cv: null,
    spike_cv: null,
    cv_limit: null,
    reader_pass: null,
    valid,
    why,
    file_name: 'test.csv',
  }
}

describe('calc.test.js:1016 a failed spike or CV makes the verdict invalid, and nothing goes to Mk1', () => {
  it('matches Dennis', () => {
    const pep = (o: Partial<EndoSample> = {}): EndoSample => ({
      sampleId: 'P-1',
      identity: 'Examplerelin',
      sampleType: null,
      weightMg: 10,
      form: null,
      waterMl: null,
      totalDilution: null,
      steps: null,
      lambda: 0.05,
      reading: '<0.05',
      reader: null,
      ...o,
    })
    const ok = record(true, [])
    const bad = record(false, ['spike recovery 44 % outside 50-200 %'])
    expect(prep2Result(pep({ reader: ok }), ctx).verdict).toBe('pass')
    const r = prep2Result(pep({ reader: bad }), ctx)
    expect(r.verdict).toBe('invalid') // his invalidWhy is the record's why, shown by the UI
    expect(r.euPerVial).toBe(25) // the numbers still show; they are not a result
    expect(mk1Value(pep({ reader: bad }), ctx)).toBeNull()
    expect(mk1Value(pep({ reader: ok }), ctx)?.value).toBe('<25')
    // bac water is gated the same way
    expect(
      prep2Result(
        pep({
          sampleId: 'BW-1',
          identity: 'Bac water',
          weightMg: null,
          lambda: BW_LAMBDA,
          reading: '<0.2',
          reader: bad,
        }),
        ctx
      ).verdict
    ).toBe('invalid')
    // and the record parsed from his export drives it end to end
    const [, b] = three(parseEndoScan(EXPORT).tests)
    const parsed = toReaderRecord(b, params, 'EndoScanV-Export-test.csv')
    expect(prep2Result(pep({ reader: parsed }), ctx).verdict).toBe('invalid')
    // readerDiffers: the record carries no reading (contract), not ported
  })
})

function rt(
  sampleId: string,
  testedAt = '2026-10-09T15:00:00-07:00'
): ReaderTest {
  return {
    testId: `T-${sampleId}-${testedAt}`,
    sampleId,
    identity: '',
    sampleType: '',
    result: '<0.05',
    lt: true,
    value: 0.05,
    sampleCv: null,
    spikeCv: null,
    cvLimit: null,
    recovery: null,
    recMin: null,
    recMax: null,
    spikeLevel: null,
    readerPass: null,
    operator: null,
    testedAt,
    reader: null,
    slot: null,
    tempStart: null,
    tempEnd: null,
    cartLot: null,
    cartExpiry: null,
    cartRange: null,
    software: null,
  }
}

describe('calc.test.js:1035 matched to rows by Sample ID, the parent only when unambiguous', () => {
  it('matches Dennis', () => {
    expect(readerCartridgeLambda('5 - 0.05')).toBe(0.05)
    expect(readerCartridgeLambda('1-0.01')).toBe(0.01)
    expect(readerCartridgeLambda('0.5 - 0.005')).toBe(0.005)
    // his null for "10 - 0.1" was "not one of my three cartridges"; that check
    // is the catalog's now (spec 8.3), so the sensitivity comes back
    expect(readerCartridgeLambda('10 - 0.1')).toBe(0.1)
    expect(baseSampleId('p-5309-s02')).toBe('P-5309')
    expect(baseSampleId('PB-0544')).toBe('PB-0544')
    const rows = [
      { itemId: 1, sampleId: 'P-5299-S02' },
      { itemId: 2, sampleId: 'P-5311' },
      { itemId: 3, sampleId: 'P-7000-S01' },
      { itemId: 4, sampleId: 'P-7000-S02' },
      { itemId: 5, sampleId: '' },
    ]
    const m = matchReaderTests(
      [
        rt('P-5299'),
        rt('P-5311'),
        rt('P-7000'),
        rt('P-9999'),
        rt(''),
        rt('P-7000-S02'),
      ],
      rows
    )
    expect(m.matched.map(x => [x.test.sampleId, x.itemId, x.via])).toEqual([
      ['P-5299', 1, 'parent'],
      ['P-5311', 2, 'exact'],
      ['P-7000-S02', 4, 'exact'],
    ])
    expect(m.ambiguous.map(t => t.sampleId)).toEqual(['P-7000'])
    expect(m.unmatched.map(t => t.sampleId)).toEqual(['P-9999', ''])
    // tested twice: the later test wins, the earlier is superseded
    const early = rt('P-5311', '2026-10-09T13:48:00-07:00')
    const late = rt('P-5311', '2026-10-09T15:03:00-07:00')
    const twice = matchReaderTests([early, late], rows)
    expect(twice.matched.map(x => x.test)).toEqual([late])
    expect(twice.superseded).toEqual([early])
    expect(matchReaderTests([late, early], rows).matched[0]?.test).toBe(late)
  })

  it('never pairs two different vials, never sends one row two tests', () => {
    // the reader's S02 is not the sheet's S01
    const m = matchReaderTests(
      [rt('P-7000-S02')],
      [{ itemId: 3, sampleId: 'P-7000-S01' }]
    )
    expect(m.matched).toEqual([])
    expect(m.unmatched.map(t => t.sampleId)).toEqual(['P-7000-S02'])
    // a vial ID on the reader still finds a bare parent row
    expect(
      matchReaderTests([rt('P-5299-S02')], [{ itemId: 9, sampleId: 'P-5299' }])
        .matched[0]
    ).toMatchObject({ itemId: 9, via: 'parent' })
    // the same time twice: the later one in the file, once
    const first = { ...rt('P-5311'), testId: 'A' }
    const second = { ...rt('P-5311'), testId: 'B' }
    const tie = matchReaderTests(
      [first, second],
      [{ itemId: 2, sampleId: 'P-5311' }]
    )
    expect(tie.matched.map(x => x.test.testId)).toEqual(['B'])
    expect(tie.superseded.map(t => t.testId)).toEqual(['A'])
  })

  it('a retest ID is not a vial of its parent: the two are never paired', () => {
    expect(baseSampleId('P-0134-R01')).toBe('P-0134-R01')
    expect(baseSampleId('p-0134-r01-s02')).toBe('P-0134-R01')
    // the retest's test against the original's row, and the reverse
    const toOriginal = matchReaderTests(
      [rt('P-0134-R01')],
      [{ itemId: 1, sampleId: 'P-0134' }]
    )
    expect(toOriginal.matched).toEqual([])
    expect(toOriginal.unmatched.map(t => t.sampleId)).toEqual(['P-0134-R01'])
    const toRetest = matchReaderTests(
      [rt('P-0134')],
      [{ itemId: 2, sampleId: 'P-0134-R01' }]
    )
    expect(toRetest.matched).toEqual([])
    expect(toRetest.unmatched.map(t => t.sampleId)).toEqual(['P-0134'])
    // both on the sheet: each test goes to its own sample, the retest's through its vial
    const both = matchReaderTests(
      [rt('P-0134-R01'), rt('P-0134')],
      [
        { itemId: 1, sampleId: 'P-0134' },
        { itemId: 2, sampleId: 'P-0134-R01-S01' },
      ]
    )
    expect(both.matched.map(x => [x.test.sampleId, x.itemId, x.via])).toEqual([
      ['P-0134-R01', 2, 'parent'],
      ['P-0134', 1, 'exact'],
    ])
    expect(both.ambiguous).toEqual([])
    expect(both.unmatched).toEqual([])
  })

  it('on one row an exact ID outranks a parent ID whatever the times (exact first, spec 8.1)', () => {
    const rows = [{ itemId: 7, sampleId: 'P-5299-S02' }]
    const exact = {
      ...rt('P-5299-S02', '2026-10-09T13:00:00-07:00'),
      testId: 'A',
    }
    const parent = { ...rt('P-5299', '2026-10-09T15:00:00-07:00'), testId: 'B' }
    for (const order of [
      [exact, parent],
      [parent, exact],
    ]) {
      const m = matchReaderTests(order, rows)
      expect(m.matched.map(x => [x.test.testId, x.via])).toEqual([
        ['A', 'exact'],
      ])
      expect(m.superseded.map(t => t.testId)).toEqual(['B'])
    }
  })

  it('an unparseable time ranks below any parsed time; a tie goes to the later test in the file', () => {
    const rows = [{ itemId: 2, sampleId: 'P-5311' }]
    const parsed = { ...rt('P-5311'), testId: 'P' }
    const garbled = { ...rt('P-5311'), testId: 'G', testedAt: 'garbled' }
    const missing = { ...rt('P-5311'), testId: 'M', testedAt: null }
    for (const order of [
      [parsed, garbled],
      [garbled, parsed],
      [parsed, missing],
      [missing, parsed],
    ]) {
      const m = matchReaderTests(order, rows)
      expect(m.matched.map(x => x.test.testId)).toEqual(['P'])
      expect(m.superseded).toHaveLength(1)
    }
    const bad = matchReaderTests([garbled, missing], rows)
    expect(bad.matched.map(x => x.test.testId)).toEqual(['M'])
    expect(
      matchReaderTests([missing, garbled], rows).matched.map(x => x.test.testId)
    ).toEqual(['G'])
  })

  it('reads the lower bound in either order, and nothing from nothing', () => {
    expect(readerCartridgeLambda('0.05 - 5')).toBe(0.05)
    expect(readerCartridgeLambda('')).toBeNull()
    expect(readerCartridgeLambda(null)).toBeNull()
    expect(readerCartridgeLambda('n/a')).toBeNull()
  })
})

describe('calc.test.js:952 inbox identity: the test label comes off the product, nothing else does', () => {
  it('matches Dennis (his parseIntake and pickRule halves are not Mk1)', () => {
    expect(splitIdentity('Retatrutide - Identity (HPLC)')).toEqual({
      product: 'Retatrutide',
      label: 'Identity (HPLC)',
    })
    expect(splitIdentity('MOTS-c - Identity (HPLC)')).toEqual({
      product: 'MOTS-c',
      label: 'Identity (HPLC)',
    })
    expect(splitIdentity('Tirzepatide - Endotoxin (LAL)').product).toBe(
      'Tirzepatide'
    )
    for (const keep of [
      'CJC-1295 no DAC',
      'BPC-157, TB500 (Thymosin Beta 4)',
      'GHK-Cu',
      'Bacteriostatic Water',
      'NAD+',
      '',
    ])
      expect(splitIdentity(keep)).toEqual({ product: keep, label: null })
  })
})
