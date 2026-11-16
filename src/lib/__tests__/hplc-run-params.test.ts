import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  HPLC_RUN_PARAM_DEFAULTS,
  hplcRunParamsFrom,
} from '@/lib/hplc-run-params'

// The shared defaults fixture: pytest holds the backend's table to the same
// file. Read at run time, not imported, so the production `tsc` (whose Docker
// context has no backend/) never resolves a path outside src.
const fixture = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../backend/tests/fixtures/hplc_run_param_defaults.json'
    ),
    'utf8'
  )
) as { defaults: Record<string, number> }

describe('HPLC method run parameters', () => {
  it('carries the same thirteen defaults the backend does', () => {
    expect(HPLC_RUN_PARAM_DEFAULTS).toEqual(fixture.defaults)
    expect(Object.keys(fixture.defaults)).toHaveLength(13)
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
