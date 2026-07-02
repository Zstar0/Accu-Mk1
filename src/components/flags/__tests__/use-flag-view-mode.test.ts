import { describe, it, expect, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useFlagViewMode } from '@/components/flags/use-flag-view-mode'

const KEY = 'flags:viewMode'

describe('useFlagViewMode', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("defaults to 'table' when localStorage is empty", () => {
    const { result } = renderHook(() => useFlagViewMode())
    expect(result.current[0]).toBe('table')
  })

  it('reads a previously stored value back on init', () => {
    window.localStorage.setItem(KEY, 'list')
    const { result } = renderHook(() => useFlagViewMode())
    expect(result.current[0]).toBe('list')
  })

  it('falls back to the default when the stored value is invalid', () => {
    window.localStorage.setItem(KEY, 'nonsense')
    const { result } = renderHook(() => useFlagViewMode())
    expect(result.current[0]).toBe('table')
  })

  it('persists a set value to localStorage and updates state', () => {
    const { result } = renderHook(() => useFlagViewMode())
    act(() => result.current[1]('list'))
    expect(result.current[0]).toBe('list')
    expect(window.localStorage.getItem(KEY)).toBe('list')
  })

  it('a fresh hook reads back the value written by a prior one', () => {
    const first = renderHook(() => useFlagViewMode())
    act(() => first.result.current[1]('list'))
    const second = renderHook(() => useFlagViewMode())
    expect(second.result.current[0]).toBe('list')
  })
})
