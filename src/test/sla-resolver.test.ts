import { describe, it, expect } from 'vitest'
import { resolveSlaTier, type SlaTier } from '@/lib/api'

// Parity with backend/tests/test_sla_engine.py — keep the two resolvers in
// lockstep. Precedence: priority override > group tier > default.

function tier(target_minutes: number, partial: Partial<SlaTier> = {}): SlaTier {
  return {
    id: 0, name: 't', target_minutes,
    business_hours_only: false, is_default: false,
    amber_threshold_percent: 75,
    created_at: '', updated_at: '', ...partial,
  }
}

const DEFAULT = tier(1440, { id: 1, name: 'Standard', is_default: true })
const RUSH = tier(240, { id: 2, name: 'Rush' })
const GROUP = tier(2880, { id: 3, name: 'Microbiology' })

describe('resolveSlaTier — priority override > group > default', () => {
  it('priority override wins over group', () => {
    expect(resolveSlaTier({ expedited: RUSH }, GROUP, 'expedited', DEFAULT)).toBe(RUSH)
  })
  it('unmapped priority falls to group', () => {
    expect(resolveSlaTier({ expedited: RUSH }, GROUP, 'normal', DEFAULT)).toBe(GROUP)
  })
  it('no group tier falls to default', () => {
    expect(resolveSlaTier({ expedited: RUSH }, null, 'normal', DEFAULT)).toBe(DEFAULT)
  })
  it('null priority falls to group then default', () => {
    expect(resolveSlaTier({ expedited: RUSH }, GROUP, null, DEFAULT)).toBe(GROUP)
    expect(resolveSlaTier({ expedited: RUSH }, null, null, DEFAULT)).toBe(DEFAULT)
  })
  it('returns null when nothing matches and no default', () => {
    expect(resolveSlaTier({}, null, 'normal', null)).toBeNull()
  })
})
