import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  useFlagFilter,
  defaultFlagFilter,
} from '@/components/flags/use-flag-filter'

beforeEach(() => localStorage.clear())

describe('useFlagFilter', () => {
  it('defaults personal tabs to all_open, others to all', () => {
    expect(defaultFlagFilter('assigned').status).toBe('all_open')
    expect(defaultFlagFilter('raised').status).toBe('all_open')
    expect(defaultFlagFilter('watching').status).toBe('all_open')
    expect(defaultFlagFilter('all_open').status).toBe('all')
  })

  it('persists per tab and restores', () => {
    const { result, rerender } = renderHook(({ tab }) => useFlagFilter(tab), {
      initialProps: { tab: 'raised' },
    })
    act(() => result.current[1]({ ...result.current[0], type: 'blocker' }))
    rerender({ tab: 'assigned' })
    expect(result.current[0].type).toBe('all') // other tab untouched
    rerender({ tab: 'raised' })
    expect(result.current[0].type).toBe('blocker') // restored
    expect(result.current[0].status).toBe('all_open')
  })

  it('ignores corrupt storage', () => {
    localStorage.setItem('flags:filter:raised', '{not json')
    const { result } = renderHook(() => useFlagFilter('raised'))
    expect(result.current[0].status).toBe('all_open')
  })
})
