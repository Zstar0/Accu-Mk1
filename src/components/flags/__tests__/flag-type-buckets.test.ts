import { describe, it, expect } from 'vitest'
import {
  addTypeScope,
  removeTypeScope,
  clearTypeScope,
  isGlobalScope,
  isInBucket,
} from '@/components/flags/flag-type-buckets'

describe('flag-type-buckets scoping transitions', () => {
  it('adds a slug, restricting a previously-global type', () => {
    expect(addTypeScope([], 'sample')).toEqual(['sample'])
    expect(isGlobalScope([])).toBe(true)
    expect(isGlobalScope(['sample'])).toBe(false)
  })

  it('adds is idempotent and supports multi-bucket membership', () => {
    const scoped = addTypeScope(['sample'], 'general_task')
    expect(scoped).toEqual(['sample', 'general_task'])
    // Now in BOTH buckets.
    expect(isInBucket(scoped, 'sample')).toBe(true)
    expect(isInBucket(scoped, 'general_task')).toBe(true)
    // Re-adding is a no-op (same array contents).
    expect(addTypeScope(scoped, 'sample')).toEqual(scoped)
  })

  it('removes a slug; dropping the last one makes the type global', () => {
    expect(removeTypeScope(['sample', 'general_task'], 'sample')).toEqual([
      'general_task',
    ])
    expect(removeTypeScope(['sample'], 'sample')).toEqual([])
    expect(isGlobalScope(removeTypeScope(['sample'], 'sample'))).toBe(true)
  })

  it('clears to global', () => {
    expect(clearTypeScope()).toEqual([])
  })

  it('does not mutate the input array', () => {
    const original = ['sample']
    addTypeScope(original, 'worksheet')
    removeTypeScope(original, 'sample')
    expect(original).toEqual(['sample'])
  })
})
