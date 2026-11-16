import type { HPLCAnalyzeWeights, HPLCPrepForm, SamplePrep } from '@/lib/api'

/** The part of a POST /hplc/analyze request that comes from the prep. Every key here is a
 *  field HPLCAnalyzeRequest (or, inside weights, HPLCWeightsInput) in backend/main.py
 *  declares: the server drops an undeclared key without an error. */
export interface PrepAnalyzeFields {
  weights: HPLCAnalyzeWeights
  prep_form?: HPLCPrepForm
  declared_volume_ml?: number
  capsules_used?: number
}

/** What POST /hplc/analyze needs from a prep, for the row as a whole (vialNumber null) or for
 *  one entry of its vial_data. A blend's weighings come from that vial's entry when it has
 *  one, else from the row; the form, the volume and the count always come from the row.
 *
 *  A wizard-born prep (no prep_form) gets exactly the request the flyout always sent: the
 *  five weights with 0 for a blank, and nothing else. A prep with a form sends it, a blank
 *  weighing as null (the engine reads only null as "not weighed"), the intermediate vial
 *  only when one of its weighings is stored, the volume only for a liquid and the count only
 *  for a capsule. */
export function prepAnalyzeFields(
  prep: SamplePrep,
  vialNumber: number | null = null
): PrepAnalyzeFields {
  const vial =
    vialNumber != null
      ? prep.vial_data?.find(v => v.vial_number === vialNumber)
      : undefined
  const src = vial ?? prep
  const form = prep.prep_form

  if (!form) {
    return {
      weights: {
        stock_vial_empty: src.stock_vial_empty_mg ?? 0,
        stock_vial_with_diluent: src.stock_vial_loaded_mg ?? 0,
        dil_vial_empty: src.dil_vial_empty_mg ?? 0,
        dil_vial_with_diluent: src.dil_vial_with_diluent_mg ?? 0,
        dil_vial_with_diluent_and_sample: src.dil_vial_final_mg ?? 0,
      },
    }
  }

  const weights: HPLCAnalyzeWeights = {
    stock_vial_empty: src.stock_vial_empty_mg ?? null,
    stock_vial_with_diluent: src.stock_vial_loaded_mg ?? null,
    dil_vial_empty: src.dil_vial_empty_mg ?? null,
    dil_vial_with_diluent: src.dil_vial_with_diluent_mg ?? null,
    dil_vial_with_diluent_and_sample: src.dil_vial_final_mg ?? null,
  }
  const int = [
    src.int_vial_empty_mg ?? null,
    src.int_vial_with_diluent_mg ?? null,
    src.int_vial_final_mg ?? null,
  ] as const
  if (int.some(v => v != null)) {
    weights.int_vial_empty = int[0]
    weights.int_vial_with_diluent = int[1]
    weights.int_vial_with_diluent_and_sample = int[2]
  }

  const fields: PrepAnalyzeFields = { weights, prep_form: form }
  if (form === 'liquid' && prep.declared_volume_ml != null) {
    fields.declared_volume_ml = prep.declared_volume_ml
  }
  if (form === 'capsule' && prep.capsules_used != null) {
    fields.capsules_used = prep.capsules_used
  }
  return fields
}
