import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebouncedValue } from '@/hooks/use-debounced-value'

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 300))
    expect(result.current).toBe('a')
  })

  it('updates only after the delay elapses', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 300),
      { initialProps: { v: 'a' } }
    )
    rerender({ v: 'ab' })
    expect(result.current).toBe('a') // not yet
    act(() => void vi.advanceTimersByTime(299))
    expect(result.current).toBe('a')
    act(() => void vi.advanceTimersByTime(1))
    expect(result.current).toBe('ab')
  })

  it('coalesces rapid changes to the last value', () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 300),
      { initialProps: { v: 'a' } }
    )
    rerender({ v: 'ab' })
    act(() => void vi.advanceTimersByTime(150))
    rerender({ v: 'abc' })
    act(() => void vi.advanceTimersByTime(150))
    expect(result.current).toBe('a') // first timer was reset
    act(() => void vi.advanceTimersByTime(150))
    expect(result.current).toBe('abc')
  })
})
