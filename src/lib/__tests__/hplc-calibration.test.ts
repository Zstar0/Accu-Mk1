import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CAL_LEVEL_TARGETS,
  CAL_MIN_STOCK_MG,
  CAL_STOCK_AS_TOP_PCT,
  CAL_STOCK_DILUENT_UL,
  CAL_TOP_ALIQUOT_UL,
  COUNTERIONS,
  MS_IONS,
  PROTON_DA,
  blankCalInputs,
  blankReplicateInputs,
  linearFit,
  msNeutralMass,
  netPeptide,
  replicatePrep,
  workOutSheet,
  type CalInputs,
  type CalLevelInputs,
  type CalReplicateInputs,
} from '@/lib/hplc-calibration'
import { HPLC_RUN_PARAM_DEFAULTS } from '@/lib/hplc-run-params'

// The work_out_sheet fixture (plan 4, Task 2), made from the lab tool's
// calc.js; pytest runs the same cases against backend/hplc_calibration.py.
// Read at run time, not imported, so the production `tsc` (whose Docker
// context has no backend/) never resolves a path outside src.
interface FixtureCase {
  name: string
  inputs: CalInputs | CalReplicateInputs
  replicate_of?: CalInputs
  expect: Record<string, unknown>
}
const fixture = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../backend/tests/fixtures/hplc_calibration_cases.json'
    ),
    'utf8'
  )
) as {
  counterions: Record<string, number>
  ms_ions: string[]
  constants: Record<string, number | number[]>
  cases: FixtureCase[]
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)

/** Exact for everything but numbers, which compare as pytest.approx(rel=1e-9,
 *  abs=1e-9) does; the key sets of every object must match, so a missing or
 *  extra key fails. As the Python test's _same. */
function same(got: unknown, want: unknown, where: string): void {
  if (isObject(want)) {
    expect(isObject(got), `${where}: ${JSON.stringify(got)}`).toBe(true)
    const g = got as Record<string, unknown>
    expect(Object.keys(g).sort(), `${where}: keys`).toEqual(
      Object.keys(want).sort()
    )
    for (const k of Object.keys(want)) same(g[k], want[k], `${where}.${k}`)
  } else if (Array.isArray(want)) {
    expect(Array.isArray(got), `${where}: ${JSON.stringify(got)}`).toBe(true)
    const g = got as unknown[]
    expect(g.length, `${where}: length`).toBe(want.length)
    want.forEach((w, i) => same(g[i], w, `${where}[${i}]`))
  } else if (typeof want === 'number') {
    expect(typeof got, `${where}: ${String(got)}`).toBe('number')
    const diff = Math.abs((got as number) - want)
    expect(
      diff <= Math.max(1e-9 * Math.abs(want), 1e-9),
      `${where}: got ${String(got)}, want ${want}`
    ).toBe(true)
  } else {
    expect(got, where).toBe(want)
  }
}

describe('workOutSheet gives the lab tool answer', () => {
  it('the fixture has cases', () => {
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it.each(fixture.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const inputs = c.replicate_of
      ? replicatePrep(c.replicate_of, c.inputs as CalReplicateInputs)
      : (c.inputs as CalInputs)
    const worked = workOutSheet(inputs)
    const { warnings: wantWarnings, ...want } = c.expect as {
      warnings: { code: string; level: number | null }[]
    }
    const { warnings, ...rest } = worked
    same(rest, want, 'sheet')
    expect(warnings.map(w => [w.code, w.level])).toEqual(
      wantWarnings.map(w => [w.code, w.level])
    )
    for (const w of warnings) {
      expect(Object.keys(w).sort()).toEqual(['code', 'level', 'text'])
      expect(typeof w.text).toBe('string')
      expect(w.text.trim()).not.toBe('')
      expect(w.text).not.toContain(String.fromCodePoint(0x2014))
    }
  })

  it('never mutates its inputs', () => {
    for (const c of fixture.cases) {
      const inputs = structuredClone(c.inputs)
      const original = structuredClone(c.replicate_of)
      const merged = c.replicate_of
        ? replicatePrep(c.replicate_of, c.inputs as CalReplicateInputs)
        : (c.inputs as CalInputs)
      const mergedCopy = structuredClone(merged)
      workOutSheet(merged)
      expect(merged).toEqual(mergedCopy)
      expect(c.inputs).toEqual(inputs)
      expect(c.replicate_of).toEqual(original)
    }
  })
})

describe('a counterion fraction that cannot be worked out', () => {
  // The source gets NaN or -Infinity here (calc.js 2793-2794 divide without
  // div()), so it has no stock and no curve; neither may the twin.
  const base = fixture.cases.find(c => c.name === 'no correction')
    ?.inputs as CalInputs
  it.each([
    ['Acetate, 0 equivalents, free MW 0', { equivalents: 0, free_mw: 0 }],
    [
      'stated FW 0, free MW blank, 0 equivalents',
      { equivalents: 0, stated_fw: 0 },
    ],
    ['free MW -120.1, 2 equivalents', { equivalents: 2, free_mw: -120.1 }],
  ] as const)('%s: no stock, no curve', (_name, net) => {
    const worked = workOutSheet({
      ...base,
      net: { counterion: 'Acetate', ...net },
    })
    expect(worked.net.factor).toBeNull()
    expect(worked.stock_net_weight_mg).toBeNull()
    expect(worked.stock_conc_ug_ml).toBeNull()
    expect(worked.fit.n).toBe(0)
    expect(worked.fit.slope).toBeNull()
  })
})

describe('extreme input never throws and never leaves a non-finite number', () => {
  /** Every number finite, or null; undefined anywhere is a failure. */
  function walkFinite(x: unknown, where: string): void {
    if (x === undefined) throw new Error(`${where}: undefined`)
    if (Array.isArray(x)) x.forEach((v, i) => walkFinite(v, `${where}[${i}]`))
    else if (isObject(x))
      for (const [k, v] of Object.entries(x)) walkFinite(v, `${where}.${k}`)
    else if (typeof x === 'number' && !Number.isFinite(x))
      throw new Error(`${where}: ${x}`)
  }

  /** mulberry32: a small seeded generator, so a failing seed replays. */
  function seeded(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  // As the Python hammer: the extremes, ordinary values, and their mixes.
  const EXTREMES = [5e-324, 1e-300, 1e-12, 1e12, 1e-6, 1, 0]
  const ORDINARY = [
    0.5, 2, 60.05, 99.3, 711.86, 1000, 2794.62, 4268.25, 15729.14,
  ]

  function pickers(rnd: () => number) {
    const pickOf = <T>(xs: readonly T[]): T =>
      xs[Math.floor(rnd() * xs.length)] as T
    const value = (weighing = false): number | null => {
      const pick = rnd()
      if (pick < 0.12) return null
      const v =
        pick < 0.6
          ? pickOf(EXTREMES)
          : pick < 0.85
            ? pickOf(ORDINARY)
            : rnd() * (weighing ? 1e9 : 1e12)
      if (weighing) return Math.min(v, 1e9)
      return rnd() < 0.1 ? -v : v
    }
    return { pickOf, value }
  }

  function hammerSheet(rnd: () => number): CalInputs {
    const { pickOf, value } = pickers(rnd)
    const levels: CalLevelInputs[] = []
    const nLevels = 1 + Math.floor(rnd() * 12)
    for (let i = 0; i < nLevels; i++)
      levels.push({
        target: value(),
        vial_mg: value(true),
        vial_diluent_mg: value(true),
        vial_diluent_std_mg: value(true),
        peak_area: value(),
        purity: value(),
        rt: value(),
      })
    return {
      ...blankCalInputs(),
      net: {
        counterion_mw: value(),
        equivalents: value(),
        free_mw: value(),
        stated_fw: value(),
        ms_mz: value(),
        assay_pct: value(),
        water_pct: value(),
        override_factor: value(),
        counterion: pickOf([null, '', 'Other', ...Object.keys(COUNTERIONS)]),
        ms_ion: pickOf([null, ...MS_IONS]),
        assumption: pickOf([null, '', 'lean 2']),
        override_reason: pickOf([null, '', 'why']),
      },
      levels,
      stock: {
        vial_mg: value(true),
        vial_standard_mg: value(true),
        vial_diluent_mg: value(true),
      },
      diluent_density_mg_ml: value(),
      level_volume_ul: value(),
      top_aliquot_ul: value(),
      stock_as_top: pickOf([null, false, true]),
    }
  }

  it('5,000 seeded sheets', () => {
    for (let seed = 0; seed < 5000; seed++) {
      try {
        const rnd = seeded(seed)
        let sheet = hammerSheet(rnd)
        if (rnd() < 0.25) {
          const { pickOf, value } = pickers(rnd)
          const levels: CalReplicateInputs['levels'] = []
          const n = Math.floor(rnd() * 13)
          for (let i = 0; i < n; i++)
            levels.push({ peak_area: value(), purity: value(), rt: value() })
          sheet = replicatePrep(sheet, {
            notes: pickOf([null, 'Inj2']),
            levels,
          })
          walkFinite(sheet, 'replicate')
        }
        const worked = workOutSheet(sheet)
        walkFinite(worked, 'sheet')
        walkFinite(netPeptide(sheet.net), 'net')
        for (const w of worked.warnings) {
          if (typeof w.text !== 'string' || w.text.trim() === '')
            throw new Error(`${w.code}: empty text`)
          if (/Infinity|NaN/.test(w.text))
            throw new Error(`${w.code}: ${w.text}`)
        }
      } catch (e) {
        throw new Error(`seed ${seed}: ${String(e)}`)
      }
    }
  })

  it('the edges the Python pins', () => {
    const fit = linearFit([
      [0, 0],
      [1e-160, 1e-160],
    ])
    expect(fit.n).toBe(2)
    expect(fit.r2).toBeNull()
    expect(msNeutralMass(1e12, 'M+' + '9'.repeat(5000) + 'H')).toBeNull()
  })
})

describe('the constants are the source', () => {
  it('counterions and ion forms', () => {
    expect(COUNTERIONS).toEqual(fixture.counterions)
    expect([...MS_IONS]).toEqual(fixture.ms_ions)
  })

  it('the module constants', () => {
    const k = fixture.constants
    expect(PROTON_DA).toBe(k.proton_da)
    expect([...CAL_LEVEL_TARGETS]).toEqual(k.cal_level_targets)
    expect(CAL_STOCK_DILUENT_UL).toBe(k.cal_stock_diluent_ul)
    expect(CAL_MIN_STOCK_MG).toBe(k.cal_min_stock_mg)
    expect(CAL_TOP_ALIQUOT_UL).toBe(k.cal_top_aliquot_ul)
    expect(CAL_STOCK_AS_TOP_PCT).toBe(k.cal_stock_as_top_pct)
    expect(HPLC_RUN_PARAM_DEFAULTS.diluent_density_mg_ml).toBe(
      k.diluent_density_mg_ml
    )
    expect(HPLC_RUN_PARAM_DEFAULTS.target_volume_ul).toBe(k.target_volume_ul)
    expect(HPLC_RUN_PARAM_DEFAULTS.volume_tolerance_pct).toBe(
      k.volume_tolerance_pct
    )
  })
})

describe('the blanks', () => {
  it('blankCalInputs is the blank case', () => {
    const blank = fixture.cases.find(c => c.name === 'blank sheet')
    expect(blank).toBeDefined()
    expect(blankCalInputs()).toEqual(blank?.inputs)
  })

  it('blankReplicateInputs holds only the run results', () => {
    expect(blankReplicateInputs(2)).toEqual({
      notes: null,
      levels: [
        { peak_area: null, purity: null, rt: null },
        { peak_area: null, purity: null, rt: null },
      ],
    })
  })
})

describe('the pieces', () => {
  it('linearFit ignores a pair with a blank', () => {
    expect(
      linearFit([
        [1, 2],
        [null, 5],
        [2, 4],
      ]).n
    ).toBe(2)
  })

  it('linearFit with every area equal has no r2, never 0', () => {
    const fit = linearFit([
      [1, 5],
      [2, 5],
      [3, 5],
    ])
    expect(fit.slope).toBe(0)
    expect(fit.r2).toBeNull()
  })

  it('linearFit with one point has no slope', () => {
    expect(linearFit([[1, 2]])).toEqual({
      slope: null,
      intercept: null,
      r2: null,
      n: 1,
    })
  })

  it('msNeutralMass reads the ion form', () => {
    expect(msNeutralMass(1000, 'M')).toBe(1000)
    expect(msNeutralMass(1000, '')).toBeNull()
    expect(msNeutralMass(null, 'M+H')).toBeNull()
    expect(msNeutralMass(1000, 'M+H')).toBe(1000 - PROTON_DA)
    expect(msNeutralMass(1000, 'M-2H')).toBe(2000 + 2 * PROTON_DA)
  })

  it('netPeptide with nothing typed is a factor of 1', () => {
    const net = netPeptide(null)
    expect(net.factor).toBe(1)
    expect(net.parts_used).toEqual([])
  })

  it('replicatePrep takes only the run results and leaves the original alone', () => {
    const original = blankCalInputs()
    original.notes = 'original'
    original.stock = { vial_mg: 1, vial_standard_mg: 30, vial_diluent_mg: 1030 }
    const copy = structuredClone(original)
    const merged = replicatePrep(original, {
      notes: 'rep',
      levels: [{ peak_area: 5, purity: 99, rt: 6.1 }],
    })
    expect(original).toEqual(copy)
    expect(merged.notes).toBe('rep')
    expect(merged.stock).toEqual(original.stock)
    expect(merged.levels?.[0]).toEqual({
      ...original.levels?.[0],
      peak_area: 5,
      purity: 99,
      rt: 6.1,
    })
    expect(merged.levels?.[1]?.peak_area).toBeNull()
    expect('notes' in replicatePrep(original, { levels: [] })).toBe(false)
  })
})
