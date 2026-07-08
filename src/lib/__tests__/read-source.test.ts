import { beforeEach, describe, expect, it } from 'vitest'
import {
  getOverride, setOverride, parseGlobalReadSource, resolveEffective, DEFAULT_READ_SOURCE,
} from '@/lib/read-source'

beforeEach(() => sessionStorage.clear())

describe('tri-state per-page override store', () => {
  it('defaults to null (follow global) when unset', () => {
    expect(getOverride('sample_details')).toBeNull()
  })
  it('sets and reads a per-page override independently', () => {
    setOverride('sample_details', 'mk1')
    expect(getOverride('sample_details')).toBe('mk1')
    expect(getOverride('samples_list')).toBeNull()
  })
  it('clears an override with null', () => {
    setOverride('sample_details', 'mk1')
    setOverride('sample_details', null)
    expect(getOverride('sample_details')).toBeNull()
  })
  it('migrates a legacy bare value to a sample_details override', () => {
    sessionStorage.setItem('registryReadSource', 'mk1')
    expect(getOverride('sample_details')).toBe('mk1')
    // and rewrites it as JSON so subsequent reads are the new shape
    expect(JSON.parse(sessionStorage.getItem('registryReadSource')!)).toEqual({ sample_details: 'mk1' })
  })
})

describe('parseGlobalReadSource', () => {
  it('returns {} for undefined/empty/garbage', () => {
    expect(parseGlobalReadSource(undefined)).toEqual({})
    expect(parseGlobalReadSource('')).toEqual({})
    expect(parseGlobalReadSource('not json')).toEqual({})
  })
  it('parses a valid map and drops invalid values', () => {
    expect(parseGlobalReadSource('{"sample_details":"mk1","samples_list":"nope"}'))
      .toEqual({ sample_details: 'mk1' })
  })
})

describe('resolveEffective precedence', () => {
  it('override wins over global', () => {
    expect(resolveEffective('sample_details', 'senaite', { sample_details: 'mk1' })).toBe('senaite')
  })
  it('falls back to global when no override', () => {
    expect(resolveEffective('sample_details', null, { sample_details: 'mk1' })).toBe('mk1')
  })
  it('falls back to default when neither set', () => {
    expect(resolveEffective('samples_list', null, {})).toBe(DEFAULT_READ_SOURCE)
    expect(DEFAULT_READ_SOURCE).toBe('senaite')
  })
})
