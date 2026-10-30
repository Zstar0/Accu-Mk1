import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useItemFlagCounts } from './useItemFlagCounts'

vi.mock('@/hooks/use-flags', () => ({
  useFlagsList: () => ({
    data: [
      { id: 1, entity_type: 'support_ticket', entity_id: 'wc:1|th_A' },
      { id: 2, entity_type: 'support_ticket', entity_id: 'wc:1|th_A' },
      { id: 3, entity_type: 'support_ticket', entity_id: 'wc:1|th_B' },
      { id: 4, entity_type: 'support_ticket', entity_id: 'wc:12|th_C' },
      { id: 5, entity_type: 'support_ticket', entity_id: null },
    ],
  }),
}))

describe('useItemFlagCounts', () => {
  it('counts open flags per item for this customer only', () => {
    const { result } = renderHook(() =>
      useItemFlagCounts('support_ticket', 'wc:1')
    )
    expect(Object.fromEntries(result.current)).toEqual({ th_A: 2, th_B: 1 })
  })
})
