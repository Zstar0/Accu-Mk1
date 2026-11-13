import { describe, it, expect } from 'vitest'
import {
  HPLC_RUN_PARAM_DEFAULTS,
  hplcRunParamsFrom,
} from '@/lib/hplc-run-params'

describe('HPLC method run parameters', () => {
  it('carries the same thirteen defaults the backend does', () => {
    expect(HPLC_RUN_PARAM_DEFAULTS).toEqual({
      default_target_ug_ml: 200,
      intermediate_target_ug_ml: 5000,
      intermediate_volume_ul: 1500,
      two_step_threshold_mg: 500,
      bac_stock_ug_ml: 9000,
      bac_target_ug_ml: 500,
      capsule_neat_max_ug_ml: 350,
      diluent_density_mg_ml: 997.1,
      benzyl_alcohol_density_mg_ml: 1034.72,
      floor_ug_ml: 60,
      target_volume_ul: 1500,
      sample_diluent_ul: 3000,
      volume_tolerance_pct: 15,
    })
  })

  it('fills missing and null keys with the default', () => {
    expect(hplcRunParamsFrom(null)).toEqual(HPLC_RUN_PARAM_DEFAULTS)
    expect(hplcRunParamsFrom({ hplc: { floor_ug_ml: null } }).floor_ug_ml).toBe(
      60
    )
    expect(hplcRunParamsFrom({ hplc: { floor_ug_ml: 40 } }).floor_ug_ml).toBe(
      40
    )
    expect(hplcRunParamsFrom({ endotoxin: { cv_limit_pct: 20 } })).toEqual(
      HPLC_RUN_PARAM_DEFAULTS
    )
  })
})
