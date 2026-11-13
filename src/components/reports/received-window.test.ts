import { describe, expect, it } from 'vitest'

import { monthOptions, windowRange } from './received-window'

const TODAY = new Date(2026, 9, 7) // Oct 7 2026, local

describe('windowRange', () => {
  it('maps a month to its first and last day, including short months', () => {
    expect(windowRange('2026-09', TODAY)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    })
    expect(windowRange('2026-02', TODAY)).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    })
  })
  it('maps a rolling period to an open-ended from, and all to no bounds', () => {
    expect(windowRange('30d', TODAY)).toEqual({ from: '2026-09-07' })
    expect(windowRange('all', TODAY)).toEqual({})
  })
})

describe('monthOptions', () => {
  it('lists months newest first back to the start month', () => {
    const keys = monthOptions('2026-08', TODAY).map(m => m.key)
    expect(keys).toEqual(['2026-10', '2026-09', '2026-08'])
  })
})
