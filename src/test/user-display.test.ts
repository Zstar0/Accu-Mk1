import { describe, it, expect } from 'vitest'
import { displayName, resolveUserName } from '@/lib/user-display'

describe('displayName', () => {
  it('both names', () => {
    expect(displayName({ first_name: 'Ada', last_name: 'Lovelace', email: 'a@x' })).toBe('Ada Lovelace')
  })
  it('first only', () => {
    expect(displayName({ first_name: 'Ada', last_name: null, email: 'a@x' })).toBe('Ada')
  })
  it('last only', () => {
    expect(displayName({ first_name: null, last_name: 'Lovelace', email: 'a@x' })).toBe('Lovelace')
  })
  it('neither → email', () => {
    expect(displayName({ first_name: null, last_name: null, email: 'a@x' })).toBe('a@x')
  })
  it('whitespace-only → email', () => {
    expect(displayName({ first_name: '  ', last_name: '', email: 'a@x' })).toBe('a@x')
  })
})

describe('resolveUserName', () => {
  const dir = new Map([['a@x', 'Ada Lovelace']])
  it('resolves a known email to its name', () => {
    expect(resolveUserName('a@x', dir)).toBe('Ada Lovelace')
  })
  it('falls back to the short local-part for unknown emails', () => {
    expect(resolveUserName('grace@hopper.test', dir)).toBe('grace')
  })
  it('returns empty string for empty input', () => {
    expect(resolveUserName('', dir)).toBe('')
  })
})
