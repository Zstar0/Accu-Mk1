import { describe, it, expect } from 'vitest'
import type { SamplePrep, VialData } from '@/lib/api'
import { prepAnalyzeFields } from '@/lib/hplc-analyze-fields'

// A prep row as GET /sample-preps returns it, with only what prepAnalyzeFields reads.
function prep(over: Partial<SamplePrep> = {}): SamplePrep {
  return {
    id: 7,
    sample_id: 'SP-20261112-0001',
    stock_vial_empty_mg: 1000,
    stock_vial_loaded_mg: 3006,
    dil_vial_empty_mg: 1000,
    dil_vial_with_diluent_mg: 2234.66,
    dil_vial_final_mg: 2454.59,
    vial_data: null,
    ...over,
  } as SamplePrep
}

function vial(n: number, over: Partial<VialData> = {}): VialData {
  return {
    vial_number: n,
    stock_vial_empty_mg: 100 * n,
    stock_vial_loaded_mg: 100 * n + 50,
    dil_vial_empty_mg: 10 * n,
    dil_vial_with_diluent_mg: 10 * n + 5,
    dil_vial_final_mg: 10 * n + 6,
    ...over,
  } as VialData
}

// What SamplePrepHplcFlyout.tsx built at b2210a9d, copied verbatim: `defaultWeights` for the
// row, and the per-vial `weights` for a blend whose vial_data holds that vial (otherwise the
// row's). Nothing else from the prep went into the request.
function headWeights(p: SamplePrep, vialNumber: number | null) {
  const v =
    vialNumber != null && p.vial_data && p.vial_data.length > 0
      ? p.vial_data.find(x => x.vial_number === vialNumber)
      : undefined
  const src = v ?? p
  return {
    stock_vial_empty: src.stock_vial_empty_mg ?? 0,
    stock_vial_with_diluent: src.stock_vial_loaded_mg ?? 0,
    dil_vial_empty: src.dil_vial_empty_mg ?? 0,
    dil_vial_with_diluent: src.dil_vial_with_diluent_mg ?? 0,
    dil_vial_with_diluent_and_sample: src.dil_vial_final_mg ?? 0,
  }
}

describe('prepAnalyzeFields', () => {
  it('a wizard-born prep builds the request it builds today', () => {
    const cases: [SamplePrep, number | null][] = [
      [prep(), null],
      [prep({ stock_vial_empty_mg: null, dil_vial_final_mg: null }), null],
      [prep({ vial_data: [vial(1), vial(2, { dil_vial_final_mg: null })] }), 2],
      // A vial number the vial_data has no entry for, and no vial_data: the row's weights.
      [prep({ vial_data: [vial(1)] }), 3],
      [prep({ vial_data: null }), 1],
      [prep({ vial_data: [] }), 1],
    ]
    for (const [p, n] of cases) {
      expect(prepAnalyzeFields(p, n)).toStrictEqual({
        weights: headWeights(p, n),
      })
    }
    expect(prepAnalyzeFields(prep())).toStrictEqual({
      weights: {
        stock_vial_empty: 1000,
        stock_vial_with_diluent: 3006,
        dil_vial_empty: 1000,
        dil_vial_with_diluent: 2234.66,
        dil_vial_with_diluent_and_sample: 2454.59,
      },
    })
    expect(
      prepAnalyzeFields(prep({ stock_vial_empty_mg: null }), null).weights
        .stock_vial_empty
    ).toBe(0)
  })

  it('a worksheet-born two-step prep sends its intermediate', () => {
    const fields = prepAnalyzeFields(
      prep({
        prep_form: 'powder',
        int_vial_empty_mg: 500,
        int_vial_with_diluent_mg: 1900,
        int_vial_final_mg: 2000,
      })
    )
    expect(fields).toStrictEqual({
      weights: {
        stock_vial_empty: 1000,
        stock_vial_with_diluent: 3006,
        dil_vial_empty: 1000,
        dil_vial_with_diluent: 2234.66,
        dil_vial_with_diluent_and_sample: 2454.59,
        int_vial_empty: 500,
        int_vial_with_diluent: 1900,
        int_vial_with_diluent_and_sample: 2000,
      },
      prep_form: 'powder',
    })
    expect(fields).not.toHaveProperty('intermediate')
    // A one-step worksheet prep sends no intermediate keys at all.
    expect(
      Object.keys(prepAnalyzeFields(prep({ prep_form: 'powder' })).weights)
    ).not.toContain('int_vial_empty')
  })

  it('a liquid prep sends its declared volume and null stock weighings', () => {
    expect(
      prepAnalyzeFields(
        prep({
          prep_form: 'liquid',
          declared_volume_ml: 2.5,
          capsules_used: 3,
          stock_vial_empty_mg: null,
          stock_vial_loaded_mg: null,
        })
      )
    ).toStrictEqual({
      weights: {
        stock_vial_empty: null,
        stock_vial_with_diluent: null,
        dil_vial_empty: 1000,
        dil_vial_with_diluent: 2234.66,
        dil_vial_with_diluent_and_sample: 2454.59,
      },
      prep_form: 'liquid',
      declared_volume_ml: 2.5,
    })
  })

  it('a capsule prep sends its count', () => {
    expect(
      prepAnalyzeFields(
        prep({ prep_form: 'capsule', capsules_used: 4, declared_volume_ml: 2 })
      )
    ).toStrictEqual({
      weights: headWeights(prep(), null),
      prep_form: 'capsule',
      capsules_used: 4,
    })
    // bac sends neither a volume nor a count.
    expect(
      prepAnalyzeFields(
        prep({ prep_form: 'bac', capsules_used: 4, declared_volume_ml: 2 })
      )
    ).toStrictEqual({ weights: headWeights(prep(), null), prep_form: 'bac' })
  })

  it('a blend reads the weighings of the vial it is asked for', () => {
    const p = prep({
      prep_form: 'capsule',
      capsules_used: 2,
      int_vial_empty_mg: 1,
      int_vial_with_diluent_mg: 2,
      int_vial_final_mg: 3,
      vial_data: [
        vial(1),
        vial(2, {
          int_vial_empty_mg: 20,
          int_vial_with_diluent_mg: 21,
          int_vial_final_mg: 22,
        }),
      ],
    })
    expect(prepAnalyzeFields(p, 2)).toStrictEqual({
      weights: {
        stock_vial_empty: 200,
        stock_vial_with_diluent: 250,
        dil_vial_empty: 20,
        dil_vial_with_diluent: 25,
        dil_vial_with_diluent_and_sample: 26,
        int_vial_empty: 20,
        int_vial_with_diluent: 21,
        int_vial_with_diluent_and_sample: 22,
      },
      prep_form: 'capsule',
      capsules_used: 2,
    })
    // Vial 1 has no intermediate of its own; the row's does not leak into it.
    expect(prepAnalyzeFields(p, 1)).toStrictEqual({
      weights: headWeights(p, 1),
      prep_form: 'capsule',
      capsules_used: 2,
    })
  })

  it('a missing weight on a worksheet-born prep is null, never 0', () => {
    const fields = prepAnalyzeFields(
      prep({
        prep_form: 'powder',
        stock_vial_empty_mg: null,
        dil_vial_final_mg: null,
        int_vial_with_diluent_mg: 1900,
      })
    )
    expect(fields.weights).toStrictEqual({
      stock_vial_empty: null,
      stock_vial_with_diluent: 3006,
      dil_vial_empty: 1000,
      dil_vial_with_diluent: 2234.66,
      dil_vial_with_diluent_and_sample: null,
      int_vial_empty: null,
      int_vial_with_diluent: 1900,
      int_vial_with_diluent_and_sample: null,
    })
    // A liquid with no stored volume sends none, so the route names the missing field.
    expect(
      prepAnalyzeFields(prep({ prep_form: 'liquid', declared_volume_ml: null }))
    ).not.toHaveProperty('declared_volume_ml')
  })

  it('returns only keys the server request model declares', () => {
    // Pydantic drops an undeclared key without an error, so a key outside these sets is
    // silently lost. Top level: fields of HPLCAnalyzeRequest in backend/main.py that this
    // helper fills. weights: the eight fields of HPLCWeightsInput in backend/main.py.
    const TOP = new Set([
      'weights',
      'prep_form',
      'declared_volume_ml',
      'capsules_used',
    ])
    const WEIGHTS = new Set([
      'stock_vial_empty',
      'stock_vial_with_diluent',
      'dil_vial_empty',
      'dil_vial_with_diluent',
      'dil_vial_with_diluent_and_sample',
      'int_vial_empty',
      'int_vial_with_diluent',
      'int_vial_with_diluent_and_sample',
    ])
    const everything: Partial<SamplePrep> = {
      declared_volume_ml: 2,
      capsules_used: 3,
      int_vial_empty_mg: 1,
      int_vial_with_diluent_mg: 2,
      int_vial_final_mg: 3,
      diluent: 'water',
      worksheet_item_id: 9,
      vial_data: [vial(1, { int_vial_empty_mg: 1 })],
    }
    for (const form of [
      undefined,
      'powder',
      'liquid',
      'bac',
      'capsule',
    ] as const) {
      for (const n of [null, 1]) {
        const fields = prepAnalyzeFields(
          prep({ ...everything, prep_form: form }),
          n
        )
        for (const key of Object.keys(fields)) expect(TOP).toContain(key)
        for (const key of Object.keys(fields.weights))
          expect(WEIGHTS).toContain(key)
      }
    }
  })
})
