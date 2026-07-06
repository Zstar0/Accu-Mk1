import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useUIStore } from '@/store/ui-store'
import { useHashNavigation } from '@/lib/hash-navigation'
import { queryClient } from '@/lib/query-client'
import { getFlag } from '@/lib/flags-api'

vi.mock('@/lib/flags-api', () => ({
  getFlag: vi.fn().mockResolvedValue({ id: 42, comments: [], events: [] }),
}))

describe('hash navigation ?flag= deep link', () => {
  beforeEach(() => {
    useUIStore.setState({ flagsFlyoutOpen: false, flagsThreadId: null })
    queryClient.clear()
    vi.mocked(getFlag).mockClear()
  })

  it('opens the flag thread from the initial hash', () => {
    window.location.hash = '#dashboard/orders?flag=42'
    renderHook(() => useHashNavigation())
    expect(useUIStore.getState().flagsFlyoutOpen).toBe(true)
    expect(useUIStore.getState().flagsThreadId).toBe(42)
  })

  it('prefetches the flag thread so the fetch leads the boot burst', () => {
    // Cold deep link: the thread query otherwise dispatches last (portal
    // mount order) and queues ~10s behind the page burst on HTTP/1.1.
    window.location.hash = '#senaite/sample-details?id=P-1110&flag=42'
    renderHook(() => useHashNavigation())
    expect(getFlag).toHaveBeenCalledWith(42)
    // Seeded under the same key useFlag(42) reads — no duplicate fetch later.
    expect(queryClient.getQueryState(['flags', 42])).toBeDefined()
  })

  it('ignores a non-numeric flag param', () => {
    window.location.hash = '#dashboard/orders?flag=abc'
    renderHook(() => useHashNavigation())
    expect(useUIStore.getState().flagsThreadId).toBeNull()
    expect(getFlag).not.toHaveBeenCalled()
  })
})
