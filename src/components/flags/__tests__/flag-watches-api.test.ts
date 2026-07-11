import { describe, expect, it } from 'vitest'
import { flagKeys } from '@/hooks/use-flags'
import { WATCHABLE_ENTITY_TYPES } from '@/components/flags/flag-entity'

describe('watch api wiring', () => {
  it('watches key nests under [flags] for blanket invalidation', () => {
    expect(flagKeys.watches(12)).toEqual(['flags', 'watches', 12])
  })
  it('sample is watchable, vials/worksheets are not', () => {
    expect(WATCHABLE_ENTITY_TYPES.has('sample')).toBe(true)
    expect(WATCHABLE_ENTITY_TYPES.has('sub_sample')).toBe(false)
  })
})
