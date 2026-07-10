import { describe, it, expect } from 'vitest'
import { entityLabel, entityMeta } from '@/components/flags/flag-entity'

// Slice 7: after the backfill, general tasks carry entity_type='general_task'
// (entity_id null) instead of a null anchor. The chip must render the kind
// label, never "general_task null".
describe('flag-entity virtual-kind labels', () => {
  it('renders the general_task kind label, not the raw slug', () => {
    expect(entityMeta('general_task').label).toBe('General Task')
  })

  it('omits the id for a kind-anchored flag (entity_id null)', () => {
    expect(entityLabel('general_task', null)).toBe('General Task')
  })

  it('still renders code entities with their id', () => {
    expect(entityLabel('sample', 'P-1')).toBe('Sample P-1')
  })

  it('keeps the legacy null-anchor label', () => {
    expect(entityLabel(null, null)).toBe('General task')
  })

  it('falls back to the raw slug (no trailing id) for an unknown kind', () => {
    // Arbitrary kinds resolve their real label FE-side via useItemKinds; the
    // pure fallback must at least not append a null id.
    expect(entityLabel('purchase_task', null)).toBe('purchase_task')
  })
})
