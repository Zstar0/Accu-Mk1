import { describe, it, expect } from 'vitest'
import { eventLevelFor } from '@/components/senaite/SampleActivityLog'

describe('SampleActivityLog', () => {
  it('move out of variance is warn', () => {
    expect(eventLevelFor({ event: 'role_assigned',
      details: { kind_from: 'variance', kind_to: null } } as any)).toBe('warn')
  })

  it('other role_assigned stays accent', () => {
    expect(eventLevelFor({ event: 'role_assigned',
      details: { kind_from: null, kind_to: 'variance' } } as any)).toBe('accent')
  })
})
