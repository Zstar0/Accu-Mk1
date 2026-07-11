import { describe, it, expect, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useThreadViewMode } from '@/components/flags/use-thread-view-mode'

const KEY = 'flags:threadView'

describe('useThreadViewMode', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("defaults to 'bubbles' when localStorage is empty", () => {
    const { result } = renderHook(() => useThreadViewMode())
    expect(result.current[0]).toBe('bubbles')
  })

  it('reads a previously stored value back on init', () => {
    window.localStorage.setItem(KEY, 'compact')
    const { result } = renderHook(() => useThreadViewMode())
    expect(result.current[0]).toBe('compact')
  })

  it('falls back to the default when the stored value is invalid', () => {
    window.localStorage.setItem(KEY, 'nonsense')
    const { result } = renderHook(() => useThreadViewMode())
    expect(result.current[0]).toBe('bubbles')
  })

  it('persists a set value to localStorage and updates state', () => {
    const { result } = renderHook(() => useThreadViewMode())
    act(() => result.current[1]('compact'))
    expect(result.current[0]).toBe('compact')
    expect(window.localStorage.getItem(KEY)).toBe('compact')
  })

  it('a fresh hook reads back the value written by a prior one', () => {
    const first = renderHook(() => useThreadViewMode())
    act(() => first.result.current[1]('compact'))
    const second = renderHook(() => useThreadViewMode())
    expect(second.result.current[0]).toBe('compact')
  })
})
