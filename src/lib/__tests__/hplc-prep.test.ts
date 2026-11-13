import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  computeRow,
  mergeHplcPrep,
  type HplcPrepInputs,
  type HplcRowFacts,
  type HplcRunParams,
} from '@/lib/hplc-prep'
import type { HplcPrepRule } from '@/lib/hplc-prep-rules'

// The compute_row fixture (Task 3), made from the lab tool's calc.js; pytest
// runs the same cases against backend/hplc_prep.py. Read at run time, not
// imported, so the production `tsc` (whose Docker context has no backend/)
// never resolves a path outside src. Its rules carry the fifteen snapshot keys.
type Snapshot = Omit<
  HplcPrepRule,
  | 'peptide_name'
  | 'peptide_is_blend'
  | 'lead_component_name'
  | 'default_instrument_name'
  | 'updated_at'
>
interface FixtureCase {
  name: string
  facts: HplcRowFacts
  inputs: HplcPrepInputs | null
  expect: Record<string, unknown>
}
const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../backend/tests/fixtures/hplc_prep_cases.json'),
    'utf8'
  )
) as { params: HplcRunParams; rules: Snapshot[]; cases: FixtureCase[] }

const isObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)

/** Exact for everything but numbers, which compare to 9 places; the key sets
 *  of every object must match, so a missing or extra key fails. As the
 *  Python test's _same. */
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
    expect(got as number, where).toBeCloseTo(want, 9)
  } else {
    expect(got, where).toBe(want)
  }
}

describe('computeRow gives the lab tool answer', () => {
  it('the fixture has cases', () => {
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  it.each(fixture.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const row = computeRow(c.facts, c.inputs, fixture.rules, fixture.params)
    const { warnings: wantWarnings, ...want } = c.expect as {
      warnings: {
        code: string
        vial: number | null
        peptide_id: number | null
      }[]
    }
    const { warnings, ...rest } = row
    same(rest, want, 'row')
    expect(warnings.map(w => [w.code, w.vial, w.peptide_id])).toEqual(
      wantWarnings.map(w => [w.code, w.vial, w.peptide_id])
    )
    for (const w of warnings) {
      expect(Object.keys(w).sort()).toEqual([
        'code',
        'peptide_id',
        'text',
        'vial',
      ])
      expect(typeof w.text).toBe('string')
      expect(w.text.trim()).not.toBe('')
    }
  })

  it('a row with no prep form has nothing to work out', () => {
    const row = computeRow(
      {
        declared_mg: 10,
        form: null,
        peptide_id: 10,
        components: [{ peptide_id: 10, declared_mg: 10, vial: 1 }],
      },
      null,
      fixture.rules,
      fixture.params
    )
    expect(row).toEqual({
      form: null,
      declared_total_mg: null,
      diluent: { diluent: null, rule_id: null, typed: false },
      stock: { total_diluent_ml: null, problem: null },
      capsule_diluent_ul: null,
      floor_ug_ml: null,
      components: [],
      vials: [],
      warnings: [],
    })
  })
})

describe('mergeHplcPrep', () => {
  it('a sent key replaces, a null removes, an unsent key stays', () => {
    const stored: HplcPrepInputs = {
      declared_mg: 10,
      capsules: 4,
      diluent: 'Water',
      vials: { '1': { vial_mg: 2500.1, target_ug_ml: 200 } },
    }
    expect(
      mergeHplcPrep(stored, {
        declared_mg: 12,
        capsules: null,
        two_step: false,
        vials: { '1': { target_ug_ml: null, vial_diluent_mg: 3800.2 } },
      })
    ).toEqual({
      declared_mg: 12,
      diluent: 'Water',
      two_step: false,
      vials: { '1': { vial_mg: 2500.1, vial_diluent_mg: 3800.2 } },
    })
    // an undefined key is not sent (JSON.stringify drops it): it stays
    expect(
      mergeHplcPrep(stored, {
        declared_mg: undefined,
        vials: { '1': { vial_mg: undefined } },
      })
    ).toEqual(stored)
  })

  it('an emptied vial or component entry is removed, and so is an emptied map', () => {
    const stored: HplcPrepInputs = {
      components: { '36': { mg: 5 } },
      vials: { '1': { vial_mg: 1 }, '2': { lead_id: 36 } },
    }
    expect(
      mergeHplcPrep(stored, {
        components: { '36': { mg: null } },
        vials: { '2': { lead_id: null } },
      })
    ).toEqual({ vials: { '1': { vial_mg: 1 } } })
    expect(mergeHplcPrep({ declared_mg: 1 }, { declared_mg: null })).toEqual({})
  })

  it('never mutates what it was given', () => {
    const stored: HplcPrepInputs = {
      declared_mg: 10,
      vials: { '1': { vial_mg: 1, vial_all_mg: 3 } },
    }
    const patch: HplcPrepInputs = {
      declared_mg: null,
      vials: { '1': { vial_mg: null, vial_diluent_mg: 2 } },
    }
    const storedCopy = structuredClone(stored)
    const patchCopy = structuredClone(patch)
    const merged = mergeHplcPrep(stored, patch)
    expect(stored).toEqual(storedCopy)
    expect(patch).toEqual(patchCopy)
    expect(merged.vials).not.toBe(stored.vials)
    expect(merged.vials?.['1']).not.toBe(stored.vials?.['1'])
  })

  it('a NaN or Infinity leaf removes the key, as null does', () => {
    expect(
      mergeHplcPrep(
        { stock_vial_mg: 5012.31, capsules: 4 },
        { stock_vial_mg: NaN }
      )
    ).toEqual({ capsules: 4 })
    expect(
      mergeHplcPrep(
        { declared_mg: 10, vials: { '1': { vial_mg: 2500.1 } } },
        { vials: { '1': { vial_mg: Infinity } } }
      )
    ).toEqual({ declared_mg: 10 })
  })

  it('gives what the server stores: the same as the patch after a JSON round trip', () => {
    const stored: HplcPrepInputs = {
      declared_mg: 10,
      stock_vial_mg: 5012.31,
      two_step: true,
      components: { '36': { mg: 5, vial: 2 } },
      vials: {
        '1': { vial_mg: 2500.1 },
        '2': { lead_id: 36, target_ug_ml: 200 },
      },
    }
    const patches: HplcPrepInputs[] = [
      { stock_vial_mg: NaN },
      { vials: { '1': { vial_mg: Infinity } } },
      { declared_mg: -Infinity, two_step: false },
      { components: { '36': { mg: NaN, vial: null } } },
      { vials: { '2': { target_ug_ml: undefined, lead_id: 11 } } },
      { declared_mg: 12, vials: { '3': { vial_mg: NaN } } },
    ]
    for (const patch of patches)
      expect(mergeHplcPrep(stored, patch)).toEqual(
        mergeHplcPrep(
          stored,
          JSON.parse(JSON.stringify(patch)) as HplcPrepInputs
        )
      )
  })
})
