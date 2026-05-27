import { describe, it, expect } from 'vitest'
import { resolveSlaTarget, type SlaTarget } from '@/lib/api'
import type { InboxPriority } from '@/lib/api'

// Parity tests for the client-side SLA resolver. These mirror the Python
// backend tests (backend/tests/test_sla_engine.py) case-for-case — the two
// resolvers MUST stay in lockstep, so any drift fails here.

function target(
  partial: Partial<SlaTarget> & { target_minutes: number },
): SlaTarget {
  return {
    id: 0,
    analysis_service_id: null,
    priority: null,
    business_hours_only: false,
    is_default: false,
    created_at: '',
    updated_at: '',
    ...partial,
  }
}

const DEFAULT = target({ target_minutes: 1440, is_default: true })

describe('resolveSlaTarget — 4-level fallback', () => {
  it('picks the exact (service, priority) row', () => {
    const exact = target({ analysis_service_id: 7, priority: 'high', target_minutes: 120 })
    const targets = [DEFAULT, target({ analysis_service_id: 7, target_minutes: 480 }), exact]
    expect(resolveSlaTarget(targets, 7, 'high')).toBe(exact)
  })

  it('falls back to the service any-priority row', () => {
    const svcAny = target({ analysis_service_id: 7, target_minutes: 480 })
    expect(resolveSlaTarget([DEFAULT, svcAny], 7, 'high')).toBe(svcAny)
  })

  it('falls back to the priority any-service row', () => {
    const prioAny = target({ priority: 'expedited', target_minutes: 60 })
    expect(resolveSlaTarget([DEFAULT, prioAny], 7, 'expedited')).toBe(prioAny)
  })

  it('falls back to the default catch-all', () => {
    const targets = [DEFAULT, target({ analysis_service_id: 99, priority: 'high', target_minutes: 90 })]
    expect(resolveSlaTarget(targets, 7, 'normal')).toBe(DEFAULT)
  })

  it('prefers service-wildcard over priority-wildcard', () => {
    const svcAny = target({ analysis_service_id: 7, target_minutes: 480 })
    const prioAny = target({ priority: 'high', target_minutes: 60 })
    expect(resolveSlaTarget([DEFAULT, prioAny, svcAny], 7, 'high')).toBe(svcAny)
  })

  it('degrades a null priority to the service any-priority row', () => {
    const svcAny = target({ analysis_service_id: 7, target_minutes: 480 })
    const exact = target({ analysis_service_id: 7, priority: 'high', target_minutes: 120 })
    expect(resolveSlaTarget([DEFAULT, exact, svcAny], 7, null)).toBe(svcAny)
  })

  it('returns null when nothing matches and there is no default', () => {
    const targets = [target({ analysis_service_id: 99, priority: 'high', target_minutes: 90 })]
    expect(resolveSlaTarget(targets, 7, 'normal' as InboxPriority)).toBeNull()
  })
})
