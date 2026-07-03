import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useUIStore } from '@/store/ui-store'
import { useHashNavigation } from '@/lib/hash-navigation'

describe('hash navigation ?flag= deep link', () => {
  beforeEach(() => {
    useUIStore.setState({ flagsFlyoutOpen: false, flagsThreadId: null })
  })

  it('opens the flag thread from the initial hash', () => {
    window.location.hash = '#dashboard/orders?flag=42'
    renderHook(() => useHashNavigation())
    expect(useUIStore.getState().flagsFlyoutOpen).toBe(true)
    expect(useUIStore.getState().flagsThreadId).toBe(42)
  })

  it('ignores a non-numeric flag param', () => {
    window.location.hash = '#dashboard/orders?flag=abc'
    renderHook(() => useHashNavigation())
    expect(useUIStore.getState().flagsThreadId).toBeNull()
  })
})
