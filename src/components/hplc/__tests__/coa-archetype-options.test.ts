import { describe, it, expect } from 'vitest'
import { COA_ARCHETYPE_OPTIONS } from '../coa-archetype-options'

describe('COA_ARCHETYPE_OPTIONS', () => {
  it('offers not-reported, limit_table, and legacy_hplc in that select order', () => {
    expect(COA_ARCHETYPE_OPTIONS).toEqual([
      { value: 'none', label: 'Not reported' },
      { value: 'limit_table', label: 'Limit table' },
      { value: 'legacy_hplc', label: 'Legacy (HPLC page 1)' },
    ])
  })
})
