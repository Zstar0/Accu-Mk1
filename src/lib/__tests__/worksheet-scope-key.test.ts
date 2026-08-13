import { describe, it, expect } from 'vitest'
import {
  itemScopeKey,
  prepStartedKey,
  isPrepStarted,
} from '../worksheet-scope-key'

describe('itemScopeKey', () => {
  it('keys on the department when the row has one', () => {
    expect(itemScopeKey('uid-1', 7, 3)).toBe('uid-1|d7')
  })

  it('falls back to the service group for a pre-S2 row', () => {
    expect(itemScopeKey('uid-1', null, 3)).toBe('uid-1|3')
    expect(itemScopeKey('uid-1', undefined, 3)).toBe('uid-1|3')
  })

  it('never collides a department id with an equal-numbered group id', () => {
    // The two id spaces are unrelated; without the `d` marker a department-1
    // row and a group-1 row would share a key and clobber each other in the
    // SLA snapshot map.
    expect(itemScopeKey('uid-1', 1, null)).not.toBe(itemScopeKey('uid-1', null, 1))
  })
})

describe('prepStartedKey', () => {
  it('writes the department shape when a department is present', () => {
    expect(prepStartedKey('P-0144', 2, 5)).toBe('P-0144-d2')
  })

  it('writes the legacy shape for a row with no department', () => {
    expect(prepStartedKey('P-0144', null, 5)).toBe('P-0144-5')
  })
})

describe('isPrepStarted', () => {
  it('reads back a flag written under the department shape', () => {
    const started = new Set(['P-0144-d2'])
    expect(isPrepStarted(started, 'P-0144', 2, 5)).toBe(true)
  })

  it('still reads a flag a pre-S2 worksheet wrote under the group shape', () => {
    // The whole point of the fallback: notes JSON written before the cutover
    // holds group-shaped keys, and those rows must keep showing "Prep"
    // instead of reverting to an actionable "Start Prep" button.
    const started = new Set(['P-0144-5'])
    expect(isPrepStarted(started, 'P-0144', 2, 5)).toBe(true)
  })

  it('is false when neither shape is present', () => {
    expect(isPrepStarted(new Set(['P-9999-d2']), 'P-0144', 2, 5)).toBe(false)
  })

  it('does not treat an equal-numbered group flag as a department flag', () => {
    // department 2 must not read a flag written for group 2.
    expect(isPrepStarted(new Set(['P-0144-2']), 'P-0144', 2, null)).toBe(false)
  })

  it('matches on the legacy shape alone for a row with no department', () => {
    expect(isPrepStarted(new Set(['P-0144-5']), 'P-0144', null, 5)).toBe(true)
  })
})
