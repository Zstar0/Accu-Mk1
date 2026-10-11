// Dennis's 2 mL vectors, ported from tools-dennis/tools/endotoxin-log/calc.test.js
// at 5ef2a62 with every expected number unchanged. Each describe names his test
// by line. What changed: a cartridge is its lambda (his "0.05" is 0.05), resolved
// by the caller and passed on the sample (spec 4.3); the standard total and water
// come from ctx.params; method rules, the stock model, his storage shape
// (fromStored) and prepareRun's string table are not this module's. Clauses
// dropped for those reasons carry a comment naming what they covered.
import { describe, it, expect } from 'vitest'
import { calcEndoPrep, fmt, fmtUl, orderForBench } from '@/lib/endo-prep'
import {
  BW_DILUTION,
  BW_LAMBDA,
  BW_LIMIT_EU_PER_ML,
  DILUTION_STEPS,
  ENDO_RUN_PARAM_DEFAULTS,
  FORMS,
  LIMIT_EU_PER_VIAL,
  TUBE_UL,
  dilutionPlan,
  fmtConc,
  fmtEu,
  formOf,
  judgeWater,
  limitPerMg,
  limitPerVial,
  mk1Value,
  mvcFor,
  orderByTotal,
  parseReading,
  prep2Check,
  prep2Result,
  stdStep,
  stepFactor,
  targetDilutionOf,
  vialDilutionOf,
  waterOf,
  type EndoCtx,
  type EndoReaderRecord,
  type EndoSample,
} from '@/lib/endo-prep-2ml'

const ctx: EndoCtx = {
  params: ENDO_RUN_PARAM_DEFAULTS,
  allowedLambdas: [0.05, 0.01, 0.005],
}

function sample(o: Partial<EndoSample> = {}): EndoSample {
  return {
    sampleId: 'P-1',
    identity: 'Examplerelin',
    sampleType: null,
    weightMg: null,
    form: null,
    waterMl: null,
    totalDilution: null,
    steps: null,
    lambda: null,
    reading: null,
    reader: null,
    ...o,
  }
}
// calc.test.js:528-531: pep2, tot and near, as he wrote them
const pep2 = (weightMg: number | null, o: Partial<EndoSample> = {}) =>
  sample({ weightMg, ...o })
const tot = (n: number) => ({ totalDilution: n })
function near(a: number | null, b: number) {
  expect(Math.abs((a ?? Infinity) - b)).toBeLessThan(1e-9)
}
// Bac water as the caller resolves it: the 0.01 unless the row says otherwise
const BW = (o: Partial<EndoSample> = {}) =>
  sample({
    sampleId: 'BW-1',
    identity: 'Bacteriostatic Water',
    lambda: BW_LAMBDA,
    ...o,
  })

describe('calc.test.js:533 2 mL prep: the factor, what is on the cartridge, MVD, MVC, floors', () => {
  it('matches Dennis', () => {
    // RECON_ML and DILUTION_2ML are the method's run parameters now. prepOf and
    // PREP_2ML_FROM (the stock / 2 mL switch) are worksheets.endo_prep (Task 1).
    expect(ENDO_RUN_PARAM_DEFAULTS.reconWaterMl).toBe(2)
    expect(ENDO_RUN_PARAM_DEFAULTS.stdTotalDilution).toBe(250)
    expect(targetDilutionOf(pep2(10), ctx)).toBe(250)
    expect(targetDilutionOf(pep2(10, tot(500)), ctx)).toBe(500)
    expect(targetDilutionOf(BW(), ctx)).toBeNull()
    expect(vialDilutionOf(pep2(10), ctx)).toBe(250) // 10 x 12.5 x 2
    expect(vialDilutionOf(pep2(10, tot(100)), ctx)).toBe(100) // step 2 1:5
    expect(vialDilutionOf(pep2(10, tot(500)), ctx)).toBe(500) // step 2 1:25
    expect(
      vialDilutionOf(pep2(10, { steps: [{ sampleUl: 100 }, null, null] }), ctx)
    ).toBe(250) // more sample, same 1:10: Tris follows
    expect(
      vialDilutionOf(
        pep2(10, { steps: [{ sampleUl: null, ratio: 5 }, null, null] }),
        ctx
      )
    ).toBe(250) // 1:5 in step 1 -> step 2 becomes 1:25, total holds
    expect(
      vialDilutionOf(
        pep2(10, { steps: [{ sampleUl: null, ratio: 0.5 }, null, null] }),
        ctx
      )
    ).toBeNull() // below 1:1 is not a dilution
    expect(
      vialDilutionOf(pep2(10, { steps: [{ sampleUl: 0 }, null, null] }), ctx)
    ).toBeNull() // no sample volume
    expect(vialDilutionOf(pep2(10, { steps: [null, null, null] }), ctx)).toBe(
      250
    ) // his steps: []
    expect(vialDilutionOf(BW(), ctx)).toBeNull()
    expect(waterOf(pep2(10), ctx)).toBe(2) // the standard
    expect(waterOf(pep2(10, { waterMl: 4 }), ctx)).toBe(4)
    expect(waterOf(pep2(10, { waterMl: 0 }), ctx)).toBe(2)
    expect(waterOf(BW(), ctx)).toBeNull()

    const a = prep2Check(pep2(10, { lambda: 0.05 }), ctx)
    expect([a.lambda, a.water, a.dilution]).toEqual([0.05, 2, 250])
    expect(a.loaded).toBe(0.02) // 10 mg / 2 mL / 250
    expect(a.mvd).toBe(3500) // 175 / 0.05
    near(a.mvc, (0.05 * 10) / 350)
    expect(a.valid).toBe(true)
    expect(a.needs).toBe(0.05)
    expect(a.floorShown).toBe(0.05) // the reading is per mL of the step 3 tube
    expect(a.floorVial).toBe(25) // x 250 x 2 mL
    expect(a.failAt).toBe(0.7) // 350 / (2 mL x 250), as displayed

    const b = prep2Check(pep2(1000, { lambda: 0.005 }), ctx)
    expect(b.loaded).toBe(2)
    expect(b.mvd).toBe(35000)
    near(b.mvc, (0.005 * 1000) / 350)
    expect(b.valid).toBe(true)
    expect(b.floorShown).toBe(0.005)
    expect(b.floorVial).toBe(2.5)
    // a big vial is valid even on the 0.05 at 250x
    expect(prep2Check(pep2(1000, { lambda: 0.05 }), ctx).valid).toBe(true)
    // the only way to be invalid is a factor above the MVD
    const over = prep2Check(pep2(10, { ...tot(4000), lambda: 0.05 }), ctx)
    expect(over.valid).toBe(false)
    expect(over.needs).toBe(0.01)
    expect(over.floorVial).toBe(400)
    expect(
      prep2Check(pep2(10, { ...tot(3500), lambda: 0.05 }), ctx).valid
    ).toBe(true) // exactly on it
    expect(
      prep2Check(pep2(10, { ...tot(40000), lambda: 0.005 }), ctx).needs
    ).toBeNull()
    // the row's cartridge is the lambda it is given (inheritance is the caller's)
    expect(prep2Check(pep2(10, { lambda: 0.01 }), ctx).lambda).toBe(0.01)
    const u = prep2Check(pep2(10), ctx) // no cartridge
    expect(u.lambda).toBeNull()
    expect(u.loaded).toBe(0.02)
    expect(u.mvd).toBeNull()
    expect(u.valid).toBeNull()
    expect(u.needs).toBe(0.05)
    expect(u.floorShown).toBeNull()
    // no weight: the floors and MVD are known, the load and validity are not
    const nw = prep2Check(pep2(null, { lambda: 0.05 }), ctx)
    expect([nw.loaded, nw.mvc, nw.valid, nw.needs]).toEqual([
      null,
      null,
      null,
      null,
    ])
    expect([nw.mvd, nw.floorShown, nw.floorVial]).toEqual([3500, 0.05, 25])
    // bac water: its 0.01 and its 20x; valid = its floor (0.2) is under 0.25
    const bw = prep2Check(BW(), ctx)
    expect([bw.lambda, bw.water, bw.dilution]).toEqual([0.01, null, 20])
    expect([bw.loaded, bw.mvd, bw.valid, bw.floorVial]).toEqual([
      null,
      null,
      true,
      null,
    ])
    // dissolved in 4 mL: half the load, half the MVD, twice the floor per vial
    const four = prep2Check(pep2(10, { waterMl: 4, lambda: 0.05 }), ctx)
    expect(four.water).toBe(4)
    expect(four.loaded).toBe(0.01)
    expect(four.mvd).toBe(1750)
    expect(four.floorShown).toBe(0.05)
    expect(four.floorVial).toBe(50)
    expect(four.failAt).toBe(0.35)
    expect(four.valid).toBe(true)
  })
})

describe('calc.test.js:602 2 mL prep: reading x total x water = EU/vial; verdict on the vial', () => {
  it('matches Dennis', () => {
    const on = (o: Partial<EndoSample>) => ({ lambda: 0.05, ...o })
    const r = prep2Result(pep2(10, on({ reading: '<0.05' })), ctx)
    expect(r.lt).toBe(true)
    expect(r.value).toBe(0.05)
    expect(r.euPerMlVial).toBe(12.5)
    expect(r.euPerVial).toBe(25)
    near(r.euPerMg, 2.5) // x 250, x 2 mL, / 10 mg
    expect(r.limitPerVial).toBe(350)
    expect(r.verdict).toBe('pass')
    expect(r.expectedFloor).toBe(0.05)
    expect(r.floorMismatch).toBe(false)
    const fine = prep2Result(
      pep2(1000, { lambda: 0.005, reading: '<0.005' }),
      ctx
    )
    expect(fine.euPerVial).toBe(2.5)
    near(fine.euPerMg, 0.0025)
    expect(fine.verdict).toBe('pass')
    expect(fine.floorMismatch).toBe(false)
    expect(prep2Result(pep2(10, on({ reading: '0.8' })), ctx).verdict).toBe(
      'fail'
    ) // 0.8 x 500 = 400 EU/vial
    expect(prep2Result(pep2(10, on({ reading: '0.7' })), ctx).verdict).toBe(
      'pass'
    ) // 350: the boundary passes
    const inc = prep2Result(
      pep2(10, on({ reading: '<0.05', ...tot(4000) })),
      ctx
    ) // < 400 per vial
    expect(inc.verdict).toBe('inconclusive')
    expect(inc.floorMismatch).toBe(false)
    const mm = prep2Result(pep2(10, on({ reading: '<0.005' })), ctx) // the 0.005's floor
    expect(mm.floorMismatch).toBe(true)
    expect(mm.expectedFloor).toBe(0.05)
    expect(mm.verdict).toBe('pass')
    const num1 = prep2Result(pep2(10, on({ reading: '0.1' })), ctx)
    expect(num1.euPerMlVial).toBe(25)
    expect(num1.euPerVial).toBe(50)
    near(num1.euPerMg, 5)
    expect(
      prep2Result(pep2(10, on({ reading: '0.1', ...tot(500) })), ctx).euPerVial
    ).toBe(100)
    // no mg: EU/vial and the verdict still exist; EU/mg does not
    const nw = prep2Result(pep2(null, on({ reading: '0.1' })), ctx)
    expect(nw.euPerVial).toBe(50)
    expect(nw.euPerMg).toBeNull()
    expect(nw.verdict).toBe('pass')
    // no cartridge: judged, no floor to compare
    const nc = prep2Result(pep2(10, { reading: '<0.05' }), ctx)
    expect(nc.verdict).toBe('pass')
    expect(nc.expectedFloor).toBeNull()
    expect(nc.floorMismatch).toBe(false)
    const bw = prep2Result(BW({ reading: '<2.5' }), ctx)
    expect(bw.value).toBe(2.5)
    expect(bw.euPerVial).toBeNull()
    expect(bw.verdict).toBe('inconclusive') // <2.5 is above 0.25
    const blank = prep2Result(pep2(10, on({})), ctx)
    expect(blank.value).toBeNull()
    expect(blank.verdict).toBeNull()
    expect(blank.limitPerVial).toBe(350)
    expect(
      prep2Result(pep2(10, on({ reading: 'pending' })), ctx).verdict
    ).toBeNull()
    // the same displayed reading on a 4 mL row is twice the EU per vial
    const four = prep2Result(
      pep2(10, on({ waterMl: 4, reading: '<0.05' })),
      ctx
    )
    expect(four.euPerVial).toBe(50)
    near(four.euPerMg, 5)
    expect(four.verdict).toBe('pass')
    expect(
      prep2Result(pep2(10, on({ waterMl: 4, reading: '0.4' })), ctx).verdict
    ).toBe('fail') // 0.4 x 250 x 4 = 400
    // an unmakeable total: no EU/vial and no verdict
    const un = prep2Result(pep2(10, on({ reading: '0.1', ...tot(15) })), ctx)
    expect(un.value).toBe(0.1)
    expect(un.euPerVial).toBeNull()
    expect(un.verdict).toBeNull()
  })
})

describe('calc.test.js:641 the 2 mL fields, and no stock fields from this module', () => {
  it('matches Dennis (prepareRun strings rebuilt from the check and result)', () => {
    // The prep switch is the caller's (worksheets.endo_prep); this module only
    // knows the 2 mL model. His prepareRun row is rebuilt from its parts.
    const s = pep2(10, { lambda: 0.05, reading: '<0.05' })
    const k = prep2Check(s, ctx)
    const rs = prep2Result(s, ctx)
    expect(fmt(k.water)).toBe('2')
    expect(fmt(k.dilution)).toBe('250')
    expect(fmtConc(k.loaded)).toBe('0.02')
    expect(fmt(k.mvd)).toBe('3500')
    expect(fmtConc(k.mvc)).toBe('0.0014')
    expect(k.valid).toBe(true)
    expect(k.needs).toBe(0.05)
    expect(fmt(k.floorVial)).toBe('25') // per vial on a 2 mL run
    expect(s.reading).toBe('<0.05')
    expect(fmtEu(!!rs.lt, rs.euPerMlVial)).toBe('<12.5')
    expect(fmtEu(!!rs.lt, rs.euPerVial)).toBe('<25')
    expect(fmtEu(!!rs.lt, rs.euPerMg)).toBe('<2.5')
    expect(fmt(rs.limitPerVial)).toBe('350')
    expect(rs.verdict).toBe('pass')
    // his stock-only columns are never produced here
    for (const key of [
      'dissolutionMl',
      'sampleUl',
      'lalUl',
      'vialConc',
      'cartridgeDilution',
      'totalDilution',
      'euStock',
    ]) {
      expect(Object.keys(k)).not.toContain(key)
      expect(Object.keys(rs)).not.toContain(key)
    }
    const ov = prep2Check(pep2(10, { ...tot(100), lambda: 0.05 }), ctx)
    expect(fmt(ov.dilution)).toBe('100')
    expect(fmtConc(ov.loaded)).toBe('0.05')
    expect(fmt(ov.floorVial)).toBe('10')
    const four = pep2(10, { waterMl: 4, lambda: 0.05, reading: '<0.05' })
    expect(fmt(prep2Check(four, ctx).water)).toBe('4')
    expect(fmt(prep2Check(four, ctx).floorVial)).toBe('50')
    expect(fmtEu(true, prep2Result(four, ctx).euPerVial)).toBe('<50')
    const bw = BW()
    expect(waterOf(bw, ctx)).toBeNull() // his water ""
    expect(prep2Check(bw, ctx).dilution).toBe(20)
    // bac water still shows its 50 + 950, from the shared stock helper
    expect(fmtUl(calcEndoPrep({ sampleId: 'BW-1' }).sampleUl)).toBe('50')
    expect(prep2Result(bw, ctx).verdict).toBeNull()
    // the stock path byte-for-byte: endo-prep.ts and its tests, untouched.
    // fromStored (df, st): Mk1 stores prep_total_dilution and prep_steps; the
    // maths his storage lines checked:
    expect(
      vialDilutionOf(
        pep2(10, { ...tot(500), steps: [null, { sampleUl: 40 }, null] }),
        ctx
      )
    ).toBe(500)
    expect(
      vialDilutionOf(
        pep2(10, { steps: [{ sampleUl: 100, ratio: 5 }, null, null] }),
        ctx
      )
    ).toBe(250) // step 2 absorbs it
  })
})

describe('calc.test.js:670 dilution scheme: total first; step 1 by ratio, step 2 derived, step 3 fixed at 1:2', () => {
  it('matches Dennis', () => {
    expect(DILUTION_STEPS).toHaveLength(3)
    expect(DILUTION_STEPS[0]).toEqual({
      sampleUl: 20,
      ratio: 10,
      byRatio: true,
      diluent: '0.1 M Tris (BT103)',
    })
    expect(DILUTION_STEPS[1]).toEqual({
      sampleUl: 20,
      derived: true,
      diluent: 'LAL reagent water',
    })
    expect(DILUTION_STEPS[2]).toEqual({
      sampleUl: 125,
      ratio: 2,
      fixed: true,
      diluent: 'beta-glucan blocker (BG600)',
    })
    expect(ENDO_RUN_PARAM_DEFAULTS.stdTotalDilution).toBe(250)
    expect(TUBE_UL).toBe(1500)
    const p0 = ctx.params
    expect(stdStep(DILUTION_STEPS[0], p0)).toEqual({
      sampleUl: 20,
      diluentUl: 180,
      ratio: 10,
    })
    expect(stdStep(DILUTION_STEPS[1], p0)).toEqual({
      sampleUl: 20,
      diluentUl: 230,
      ratio: 12.5,
    })
    expect(stdStep(DILUTION_STEPS[2], p0)).toEqual({
      sampleUl: 125,
      diluentUl: 125,
      ratio: 2,
    })
    expect(stepFactor({ sampleUl: 50, diluentUl: 450 })).toBe(10)
    expect(stepFactor({ sampleUl: 0, diluentUl: 450 })).toBeNull()
    expect(stepFactor({ sampleUl: 50, diluentUl: null })).toBeNull()

    // the standard: 1:10 x 1:12.5 x 1:2 = 1:250, everything fits
    const p = dilutionPlan(pep2(10), ctx)
    expect(p.target).toBe(250)
    expect(
      p.steps.map(s => [
        s.ratio,
        s.diluentUl,
        s.totalUl,
        s.running,
        s.fits,
        s.own,
      ])
    ).toEqual([
      [10, 180, 200, 10, true, false],
      [12.5, 230, 250, 125, true, false],
      [2, 125, 250, 250, true, false],
    ])
    expect(p.total).toBe(250)
    expect(p.fits).toBe(true)
    expect(p.standard).toBe(true)

    // 1:10 then 1:25 for 1:500; 1:10 then 1:20 for 1:400
    const d500 = dilutionPlan(pep2(10, tot(500)), ctx)
    expect(d500.steps[1]?.ratio).toBe(25)
    expect(d500.total).toBe(500)
    expect(d500.standard).toBe(false)
    expect(d500.steps[1]?.diluentUl).toBe(480)
    expect(d500.steps[1]?.fits).toBe(true) // 20 + 480 fits
    // more sample than the tube allows at 1:25: 100 + 2400 does not fit
    const d500b = dilutionPlan(
      pep2(10, { ...tot(500), steps: [null, { sampleUl: 100 }, null] }),
      ctx
    )
    expect(d500b.steps[1]?.diluentUl).toBe(2400)
    expect(d500b.steps[1]?.fits).toBe(false)
    expect(d500b.fits).toBe(false)
    const d500s = dilutionPlan(
      pep2(10, { ...tot(500), steps: [null, { sampleUl: 40 }, null] }),
      ctx
    )
    expect(d500s.steps[1]?.diluentUl).toBe(960)
    expect(d500s.steps[1]?.fits).toBe(true)
    expect(d500s.total).toBe(500)
    const d400 = dilutionPlan(pep2(10, tot(400)), ctx)
    expect(d400.steps[1]?.ratio).toBe(20)
    expect(d400.steps[1]?.diluentUl).toBe(380)
    expect(d400.total).toBe(400)

    // step 1 changed: step 2 follows so the total holds
    const r5 = dilutionPlan(
      pep2(10, { steps: [{ sampleUl: null, ratio: 5 }, null, null] }),
      ctx
    )
    expect([
      r5.steps[0]?.diluentUl,
      r5.steps[1]?.ratio,
      r5.steps[1]?.diluentUl,
      r5.total,
    ]).toEqual([80, 25, 480, 250])
    const r20 = dilutionPlan(
      pep2(10, { steps: [{ ratio: 20, sampleUl: 25 }, null, null] }),
      ctx
    )
    expect([
      r20.steps[0]?.diluentUl,
      r20.steps[1]?.ratio,
      r20.steps[1]?.diluentUl,
      r20.total,
    ]).toEqual([475, 6.25, 105, 250])
    // the standard typed out is not an override
    expect(
      dilutionPlan(
        pep2(10, {
          ...tot(250),
          steps: [
            { sampleUl: 20, ratio: 10 },
            { sampleUl: 20 },
            { sampleUl: 125 },
          ],
        }),
        ctx
      ).standard
    ).toBe(true)
    // step 3 sample volume: BG600 equals it
    const s3 = dilutionPlan(
      pep2(10, { steps: [null, null, { sampleUl: 250 }] }),
      ctx
    )
    expect([
      s3.steps[2]?.sampleUl,
      s3.steps[2]?.diluentUl,
      s3.steps[2]?.ratio,
      s3.total,
    ]).toEqual([250, 250, 2, 250])

    // a total too small for step 1 x step 3: step 2 below 1:1, no total
    const small = dilutionPlan(pep2(10, tot(15)), ctx)
    expect(small.steps[1]?.ratio).toBe(0.75)
    expect(small.steps[1]?.diluentUl).toBeNull()
    expect(small.steps[1]?.running).toBeNull() // his factor null
    expect(small.total).toBeNull()
    // a total of exactly step 1 x step 3: step 2 is 1:1 (no water), allowed
    const t20 = dilutionPlan(pep2(10, tot(20)), ctx)
    expect([t20.steps[1]?.diluentUl, t20.total]).toEqual([0, 20])
    // step 1 below 1:1
    const bad = dilutionPlan(
      pep2(10, { steps: [{ sampleUl: null, ratio: 0.5 }, null, null] }),
      ctx
    )
    expect([
      bad.steps[0]?.diluentUl,
      bad.steps[0]?.totalUl,
      bad.steps[0]?.running,
      bad.total,
    ]).toEqual([null, null, null, null])
    // no sample volume in step 2
    const none = dilutionPlan(
      pep2(10, { steps: [null, { sampleUl: 0 }, null] }),
      ctx
    )
    expect(none.steps[1]?.running).toBeNull()
    expect(none.total).toBeNull()
    // his dilutionPlan(bac water) is null; here: no steps, its one 20x
    expect(dilutionPlan(BW(), ctx)).toEqual({
      steps: [],
      target: BW_DILUTION,
      total: BW_DILUTION,
      fits: true,
      standard: true,
    })
    // a total the steps cannot make: the cartridge check has nothing to judge
    const k15 = prep2Check(pep2(10, { ...tot(15), lambda: 0.05 }), ctx)
    expect([
      k15.water,
      k15.dilution,
      k15.loaded,
      k15.floorShown,
      k15.valid,
      k15.needs,
    ]).toEqual([2, null, null, null, null, null])
    const r15 = prep2Result(
      pep2(10, { ...tot(15), lambda: 0.05, reading: '<1' }),
      ctx
    )
    expect(r15.expectedFloor).toBeNull()
    expect(r15.euPerVial).toBeNull()
  })
})

describe('calc.test.js:820 LOD is the cartridge limit (EU/mL); LOQ carries it to the vial (EU/vial)', () => {
  it('matches Dennis', () => {
    const a = prep2Check(pep2(10, { lambda: 0.05 }), ctx)
    expect(a.lod).toBe(0.05)
    expect(a.loqVial).toBe(25) // 0.05 x 250 x 2 mL
    // the dilution moves the LOQ, never the LOD
    const b = prep2Check(pep2(10, { ...tot(500), lambda: 0.05 }), ctx)
    expect(b.lod).toBe(0.05)
    expect(b.loqVial).toBe(50)
    expect(
      prep2Check(pep2(10, { waterMl: 4, lambda: 0.05 }), ctx).loqVial
    ).toBe(50) // x 4 mL
    expect(prep2Check(pep2(10, { lambda: 0.01 }), ctx).lod).toBe(0.01)
    expect(prep2Check(pep2(10, { lambda: 0.005 }), ctx).loqVial).toBe(2.5)
    // no cartridge, bac water, an unmakeable total: no limits
    expect(prep2Check(pep2(10), ctx).lod).toBeNull()
    expect(prep2Check(BW(), ctx).loqVial).toBeNull()
    expect(
      prep2Check(pep2(10, { ...tot(15), lambda: 0.05 }), ctx).loqVial
    ).toBeNull()
  })
})

describe('calc.test.js:835 bacteriostatic water: the same 20x prep on a 2 mL run as on a stock run', () => {
  it('matches Dennis (method-rule clause is slice 5)', () => {
    for (const s of [
      BW({ sampleId: 'BW-9001', identity: 'Bacteriostatic Water' }),
      BW({ sampleId: 'P-9002', identity: 'Bacteriostatic water 30 mL' }),
      // his weight note "20X Dilution in 1 EU/mL Cartridge" has no Mk1 field
      BW({ sampleId: 'BW-9003', identity: 'Bac Water' }),
    ]) {
      // the prep itself: 50 uL + 950 uL LAL water, 20x, identical either way
      const stock = calcEndoPrep({ sampleId: s.sampleId, identity: s.identity })
      expect([stock.sampleUl, stock.lalUl, stock.dilution]).toEqual([
        50, 950, 20,
      ])
      const k = prep2Check(s, ctx)
      expect(k.dilution).toBe(stock.dilution)
      expect(formOf(s)).toBe('bac')
      expect(waterOf(s, ctx)).toBeNull() // no reconstitution: already a liquid
      expect(prep2Result(s, ctx).verdict).toBeNull() // no result typed
      expect(prep2Result(s, ctx).euPerVial).toBeNull()
      expect(k.loqVial).toBeNull()
      expect(k.lod).toBe(0.01)
      expect(k.floorShown).toBe(0.2)
      // a reading is judged against 0.25 EU/mL; it has no EU/vial
      const r = prep2Result({ ...s, reading: '<0.2' }, ctx)
      expect(r.value).toBe(0.2)
      expect(r.euPerVial).toBeNull()
      expect(r.verdict).toBe('pass')
    }
  })
})

describe('calc.test.js:861 bac water sorts to the bottom and runs on the 0.01 cartridge', () => {
  it('matches Dennis', () => {
    expect(BW_LAMBDA).toBe(0.01)
    // Mk1's due comes from the SLA engine; his received dates stand in for it
    // (same order). orderForBench is the bench order, orderByTotal groups it.
    const rows = [
      {
        due: '2026-10-01',
        priority: 'expedited',
        s: BW({ sampleId: 'BW-1' }),
      },
      { due: '2026-10-05', priority: null, s: pep2(10, { sampleId: 'P-2' }) },
      { due: '2026-10-01', priority: null, s: pep2(10, { sampleId: 'P-1' }) },
      {
        due: '2026-10-03',
        priority: null,
        s: BW({ sampleId: 'BW-2', identity: 'Bac water' }),
      },
    ]
    const bench = orderForBench(rows, r => ({
      due: r.due,
      priority: r.priority,
    }))
    expect(orderByTotal(bench, r => r.s, ctx).map(r => r.s.sampleId)).toEqual([
      'P-1',
      'P-2',
      'BW-1',
      'BW-2',
    ]) // bac water last, then by due
    // his rows[0].cartridge "0.05" / rows[2].cartridge "0.01": the caller
    // resolves the row's lambda (spec 4.3, Task 13 endoSampleFor); the check
    // reports what it is given, and a cartridge typed on the row wins there.
    expect(prep2Check(BW(), ctx).lambda).toBe(0.01)
    expect(prep2Check(BW({ lambda: 0.005 }), ctx).lambda).toBe(0.005)
    // stock-run and method-rule clauses: not this module
  })

  it('orders by total: numbers ascending, unmakeable next, bac water last (spec 5)', () => {
    const rows = [
      pep2(10, { sampleId: 'A', ...tot(500) }),
      pep2(10, { sampleId: 'B' }),
      pep2(10, { sampleId: 'C', ...tot(15) }),
      BW({ sampleId: 'BW-D' }),
      pep2(10, { sampleId: 'E', ...tot(300) }),
      pep2(10, { sampleId: 'F' }),
    ]
    expect(orderByTotal(rows, r => r, ctx).map(r => r.sampleId)).toEqual([
      'B',
      'F',
      'E',
      'A',
      'C',
      'BW-D',
    ])
  })
})

describe('calc.test.js:879 bac water on 2 mL runs: 0.25 EU/mL, a clean run reads <0.2 on the 0.01', () => {
  it('matches Dennis', () => {
    expect(BW_LIMIT_EU_PER_ML).toBe(0.25)
    const k = prep2Check(BW(), ctx)
    expect(k.lambda).toBe(0.01)
    expect(k.floorShown).toBe(0.2)
    expect(k.loqMl).toBe(0.2)
    expect(k.lod).toBe(0.01)
    expect(k.failAt).toBe(0.25)
    expect(k.valid).toBe(true)
    expect(k.needs).toBe(0.01)
    expect(k.loqVial).toBeNull()
    expect(k.water).toBeNull()
    // the 0.05 cannot prove the limit: floor 1 > 0.25
    const k5 = prep2Check(BW({ lambda: 0.05 }), ctx)
    expect(k5.floorShown).toBe(1)
    expect(k5.valid).toBe(false)
    expect(k5.needs).toBe(0.01)
    const clean = prep2Result(BW({ reading: '<0.2' }), ctx)
    expect(clean.verdict).toBe('pass')
    expect(clean.floorMismatch).toBe(false)
    expect(clean.limitPerMl).toBe(0.25)
    expect(clean.limitPerVial).toBeNull()
    expect(clean.euPerVial).toBeNull()
    expect(prep2Result(BW({ reading: '0.25' }), ctx).verdict).toBe('pass') // the boundary
    expect(prep2Result(BW({ reading: '0.26' }), ctx).verdict).toBe('fail')
    expect(prep2Result(BW({ reading: '<1', lambda: 0.05 }), ctx).verdict).toBe(
      'inconclusive'
    )
    // typed at factor 1 by mistake: <0.01 is not this prep's floor
    expect(prep2Result(BW({ reading: '<0.01' }), ctx).floorMismatch).toBe(true)
    expect(judgeWater(false, 0.2)).toBe('pass')
    expect(judgeWater(true, 0.5)).toBe('inconclusive')
    // his prepareRun strings: limitPerMl "0.25", limitPerVial ""
    expect(fmt(clean.limitPerMl)).toBe('0.25')
    expect(fmt(clean.limitPerVial)).toBe('')
    // stock runs keep bac water not assessed: endo-prep.ts, untouched
  })
})

describe('calc.test.js:906 form: a liquid (reconstituted) vial uses the customer water in place of the 2 mL', () => {
  it('matches Dennis', () => {
    expect(FORMS.map(f => f[0])).toEqual(['powder', 'liquid', 'bac'])
    expect(formOf(sample())).toBe('powder')
    expect(formOf(BW())).toBe('bac')
    expect(formOf(sample({ form: 'liquid' }))).toBe('liquid')
    // a form set by hand wins over the ID / identity, either way
    const asBac = sample({ sampleId: 'P-7', form: 'bac' })
    expect(formOf(asBac)).toBe('bac')
    expect(prep2Check(asBac, ctx).dilution).toBe(20)
    const asPowder = BW({ sampleId: 'BW-7', form: 'powder', weightMg: 10 })
    expect(formOf(asPowder)).toBe('powder')
    expect(vialDilutionOf(asPowder, ctx)).toBe(250) // a peptide prep, not 20x
    const liq = (o: Partial<EndoSample> = {}) =>
      pep2(10, { form: 'liquid', lambda: 0.05, ...o })
    // no volume typed: no 2 mL default, nothing scaled or judged
    expect(waterOf(liq(), ctx)).toBeNull()
    const k0 = prep2Check(liq(), ctx)
    expect([k0.water, k0.dilution, k0.loaded]).toEqual([null, 250, null])
    const r0 = prep2Result(liq({ reading: '<0.05' }), ctx)
    expect([r0.value, r0.euPerVial, r0.verdict]).toEqual([0.05, null, null])
    // 3 mL of the customer's water: everything scales by 3
    const k3 = prep2Check(liq({ waterMl: 3 }), ctx)
    expect(k3.water).toBe(3)
    near(k3.loaded, 10 / 3 / 250)
    expect(k3.loqVial).toBe(37.5) // 0.05 x 250 x 3
    const r3 = prep2Result(liq({ waterMl: 3, reading: '0.4' }), ctx)
    expect(r3.euPerVial).toBe(300) // 0.4 x 250 x 3
    expect(r3.verdict).toBe('pass')
    expect(prep2Result(liq({ waterMl: 3, reading: '0.5' }), ctx).verdict).toBe(
      'fail'
    ) // 375
    // the same numbers as a powder dissolved in 3 mL
    expect(
      prep2Result(liq({ waterMl: 3, reading: '0.4', form: 'powder' }), ctx)
        .euPerVial
    ).toBe(300)
    // his prepareRun row: form "liquid", water "3"
    expect(formOf(liq({ waterMl: 3 }))).toBe('liquid')
    expect(fmt(waterOf(liq({ waterMl: 3 }), ctx))).toBe('3')
  })
})

describe('calc.test.js:934 Accu-Mk1 value: EU/vial for peptides, EU/mL for bac water, the < kept', () => {
  it('matches Dennis', () => {
    const pep = (o: Partial<EndoSample> = {}) =>
      pep2(10, { lambda: 0.05, ...o })
    expect(mk1Value(pep({ reading: '<0.05' }), ctx)).toEqual({
      value: '<25',
      unit: 'EU/vial',
      verdict: 'pass',
    })
    expect(mk1Value(pep({ reading: '0.4' }), ctx)).toEqual({
      value: '200',
      unit: 'EU/vial',
      verdict: 'pass',
    }) // 0.4 x 250 x 2
    expect(mk1Value(BW({ reading: '<0.2' }), ctx)).toEqual({
      value: '<0.2',
      unit: 'EU/mL',
      verdict: 'pass',
    })
    expect(mk1Value(BW({ reading: '0.3' }), ctx)).toEqual({
      value: '0.3',
      unit: 'EU/mL',
      verdict: 'fail',
    })
    // nothing to report yet
    expect(mk1Value(pep(), ctx)).toBeNull()
    expect(mk1Value(pep({ reading: 'pending' }), ctx)).toBeNull()
    expect(mk1Value(pep({ form: 'liquid', reading: '0.4' }), ctx)).toBeNull()
    expect(
      mk1Value(pep({ form: 'liquid', waterMl: 3, reading: '0.4' }), ctx)?.value
    ).toBe('300')
    // his prepareRun pair, and stock runs promote nothing (no Results box)
    expect(
      [pep({ reading: '<0.05' }), BW({ reading: '<0.2' })].map(s => {
        const v = mk1Value(s, ctx)
        return [v?.value, v?.unit]
      })
    ).toEqual([
      ['<25', 'EU/vial'],
      ['<0.2', 'EU/mL'],
    ])
  })
})

describe("the reader's invalid verdict (contract rule; Dennis's case, calc.test.js:1016, is in endo-reader.test.ts)", () => {
  it('a failed reader test is invalid whatever the reading, and never reaches Mk1', () => {
    const reader: EndoReaderRecord = {
      test_id: 'T-1',
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
      recovery: 44,
      rec_min: 50,
      rec_max: 200,
      sample_cv: null,
      spike_cv: null,
      cv_limit: null,
      reader_pass: false,
      valid: false,
      why: ['spike recovery 44 % outside 50-200 %'],
      file_name: 'test.csv',
    }
    const s = pep2(10, { lambda: 0.05, reading: '<0.05', reader })
    const r = prep2Result(s, ctx)
    expect(r.verdict).toBe('invalid')
    expect(r.euPerVial).toBe(25) // the numbers still show
    expect(mk1Value(s, ctx)).toBeNull()
    expect(
      prep2Result({ ...s, reader: { ...reader, valid: true, why: [] } }, ctx)
        .verdict
    ).toBe('pass')
  })
})

describe('calc.test.js:196 the limit is 350 EU per vial; per mg it is 350 over the declared mass', () => {
  it('matches Dennis', () => {
    expect(LIMIT_EU_PER_VIAL).toBe(350)
    const pep = (w: number | null) => sample({ weightMg: w, waterMl: 1 })
    expect(limitPerMg(pep(10))).toBe(35)
    expect(limitPerMg(pep(70))).toBe(5)
    expect(limitPerMg(pep(1000))).toBe(0.35)
    expect(limitPerMg(pep(null))).toBeNull()
    expect(limitPerMg(pep(0))).toBeNull()
    expect(limitPerMg(BW())).toBeNull()
    // DILUTION_TO_CARTRIDGE is the stock model's; the cartridge keys are
    // catalog rows now (consumable_types), not module data
  })
})

describe('calc.test.js:210 MVC is lambda over the row limit per mg', () => {
  it('matches Dennis', () => {
    const pep = (w: number | null) => sample({ weightMg: w, waterMl: 1 })
    near(mvcFor(0.05, pep(10)), (0.05 * 10) / 350)
    near(mvcFor(0.01, pep(10)), (0.01 * 10) / 350)
    near(mvcFor(0.005, pep(10)), (0.005 * 10) / 350)
    expect(mvcFor(0.05, pep(140))).toBe(0.02) // the 0.05's last valid vial at 50x
    expect(mvcFor(0.01, pep(700))).toBe(0.02)
    expect(mvcFor(0.005, pep(1400))).toBe(0.02)
    near(mvcFor(0.05, pep(1000)), (0.05 * 1000) / 350)
    expect(mvcFor(null, pep(10))).toBeNull() // his unknown cartridge "0.1"
    expect(mvcFor(0.05, pep(null))).toBeNull()
    expect(mvcFor(0.05, BW())).toBeNull()
  })
})

describe('calc.test.js:352 parseResult -> parseReading, keeping the <', () => {
  it('matches Dennis (no raw; unparseable text is null)', () => {
    expect(parseReading('<2.5')).toEqual({ lt: true, value: 2.5 })
    expect(parseReading(' < 2.5 ')).toEqual({ lt: true, value: 2.5 })
    expect(parseReading('0.8')).toEqual({ lt: false, value: 0.8 })
    expect(parseReading('.5')).toEqual({ lt: false, value: 0.5 })
    expect(parseReading('')).toBeNull()
    expect(parseReading(null)).toBeNull()
    expect(parseReading('n/a')).toBeNull() // his { lt: false, value: null, raw }
  })

  it('RF2: the readings the backend accepts, and nothing else', () => {
    expect(parseReading('< 0.05')).toEqual({ lt: true, value: 0.05 })
    expect(parseReading(' 0.8 ')).toEqual({ lt: false, value: 0.8 })
    expect(parseReading('0')).toEqual({ lt: false, value: 0 })
    for (const bad of ['0,8', '-1', '<0', 'abc', ''])
      expect(parseReading(bad)).toBeNull()
  })
})

describe('calc.test.js:480 the limit per vial is 350, flat, whatever the declared mass', () => {
  it('matches Dennis', () => {
    expect(limitPerVial(sample({ weightMg: 10 }))).toBe(350)
    expect(limitPerVial(sample({ weightMg: 1000 }))).toBe(350)
    expect(limitPerVial(sample())).toBe(350) // before the weight exists
    expect(limitPerVial(BW())).toBeNull()
    // it rides along with the result, with or without a reading (his stock
    // vectors <2.5 and 36 are the 2 mL <0.05 and 0.8 of calc.test.js:602)
    const s = pep2(10, { lambda: 0.05 })
    expect(prep2Result(s, ctx).limitPerVial).toBe(350)
    const r = prep2Result({ ...s, reading: '<0.05' }, ctx)
    expect(r.limitPerVial).toBe(350)
    expect((r.euPerVial ?? Infinity) < 350 && r.verdict === 'pass').toBe(true) // <25 of 350
    const f = prep2Result({ ...s, reading: '0.8' }, ctx)
    expect((f.euPerVial ?? 0) > 350 && f.verdict === 'fail').toBe(true) // 400 of 350
    expect(fmt(r.limitPerVial)).toBe('350')
  })
})

describe('calc.test.js:517 tiny loaded concentrations keep their significant figures', () => {
  it('matches Dennis', () => {
    expect(fmtConc(0.02)).toBe('0.02')
    expect(fmtConc(0.0005)).toBe('0.0005')
    expect(fmtConc(0.001)).toBe('0.001')
    expect(fmtConc(null)).toBe('')
    // his prepareRun "0.0005" is a stock row at 2000x: not this module
  })
})

describe('run parameters and the allowed cartridges come from the method, not constants', () => {
  const ctx2: EndoCtx = {
    params: {
      ...ENDO_RUN_PARAM_DEFAULTS,
      stdTotalDilution: 500,
      reconWaterMl: 3,
    },
    allowedLambdas: [0.005, 0.01, 0.05], // any order
  }

  it('a method standard of 1:500 in 3 mL moves the target, water, load and EU/vial', () => {
    const s = pep2(30, { lambda: 0.05, reading: '0.1' })
    expect(targetDilutionOf(s, ctx2)).toBe(500)
    expect(waterOf(s, ctx2)).toBe(3)
    expect(dilutionPlan(s, ctx2).steps[1]?.ratio).toBe(25) // 500 / (10 x 2)
    expect(dilutionPlan(s, ctx2).standard).toBe(true)
    expect(dilutionPlan(pep2(30, tot(250)), ctx2).standard).toBe(false)
    expect(prep2Check(s, ctx2).loaded).toBe(0.02) // 30 / 3 / 500
    expect(prep2Result(s, ctx2).euPerVial).toBe(150) // 0.1 x 500 x 3
    expect(stdStep(DILUTION_STEPS[1], ctx2.params).diluentUl).toBe(480)
  })

  it('needs searches the allowed list least sensitive first, whatever its order', () => {
    expect(prep2Check(pep2(10, { lambda: 0.05 }), ctx2).needs).toBe(0.05)
    const no05: EndoCtx = { ...ctx2, allowedLambdas: [0.005, 0.01] }
    expect(prep2Check(pep2(10, { lambda: 0.01 }), no05).needs).toBe(0.01)
    expect(prep2Check(BW(), { ...ctx, allowedLambdas: [] }).needs).toBeNull()
  })
})
