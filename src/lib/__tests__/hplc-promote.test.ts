import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { HplcSheetRow } from '@/lib/api'
import type { HplcRowComputed } from '@/lib/hplc-prep'
import { promoteReasons } from '@/lib/hplc-promote'

// Task 6's promote_reasons fixture: the Python function's answer over fixed
// rows. Read at run time, never imported, so no file under src/ resolves a
// path in backend/.
interface ReasonCase {
  name: string
  row: HplcSheetRow
  computed: HplcRowComputed | null
  blend_cap: number
  reasons: string[]
}
const fixture = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../backend/tests/fixtures/hplc_promote_reason_cases.json'
    ),
    'utf8'
  )
) as { cases: ReasonCase[] }

describe('promoteReasons, the browser copy of promote_reasons', () => {
  it('reads every case in the fixture', () => {
    expect(fixture.cases.length).toBeGreaterThan(20)
  })

  it.each(fixture.cases.map(c => [c.name, c] as const))(
    'lists every reason a row cannot be promoted, in the server wording: %s',
    (_name, c) => {
      expect(promoteReasons(c.row, c.computed, c.blend_cap)).toEqual(c.reasons)
    }
  )

  it('the floor is never a reason', () => {
    const c = fixture.cases.find(
      x => x.name === 'below the floor is never a reason'
    )
    if (!c?.computed) throw new Error('no floor case in the fixture')
    // the case really is below the floor, so an empty answer means something
    expect(c.computed.warnings.map(w => w.code)).toContain('below_floor')
    expect(promoteReasons(c.row, c.computed, c.blend_cap)).toEqual([])
  })
})
