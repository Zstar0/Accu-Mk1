/**
 * The HPLC prep worksheet's method constants (plan 2026-11-12-hplc-prep-rules,
 * Task 4): the browser's copy of backend/catalog/method_run_params.py
 * HPLC_RUN_PARAM_DEFAULTS and hplc_run_params. The test pins the thirteen
 * values to the backend's. Pure: no DOM, no fetch.
 */

/** The method's defaults; a method's run_parameters.hplc overrides any of them. */
export const HPLC_RUN_PARAM_DEFAULTS = {
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
} as const

type HplcRunParamKey = keyof typeof HPLC_RUN_PARAM_DEFAULTS

/** run_parameters.hplc as a method stores it: every key optional, null
 *  meaning the default. */
export type HplcRunParamsWire = Partial<Record<HplcRunParamKey, number | null>>

/**
 * A method's run_parameters ({"hplc": {...}}, null or anything else) with
 * every missing or null hplc key at its default, as the server's
 * hplc_run_params reads it.
 */
export function hplcRunParamsFrom(
  runParameters: unknown
): Record<HplcRunParamKey, number> {
  const block =
    runParameters !== null && typeof runParameters === 'object'
      ? (runParameters as { hplc?: unknown }).hplc
      : null
  const stored: HplcRunParamsWire =
    block !== null && typeof block === 'object' ? block : {}
  const out = { ...HPLC_RUN_PARAM_DEFAULTS } as Record<HplcRunParamKey, number>
  for (const key of Object.keys(out) as HplcRunParamKey[]) {
    const v = stored[key]
    if (typeof v === 'number') out[key] = v
  }
  return out
}
