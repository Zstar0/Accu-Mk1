import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatDate } from '@/components/senaite/senaite-utils'
import { formatLabDateTime } from '@/lib/lab-time'

// A machine zone far from the lab's proves the output ignores it.
const originalTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Asia/Tokyo'
})
afterAll(() => {
  process.env.TZ = originalTz
})

describe('sample timestamps render on the lab clock', () => {
  it('UTC Z string renders as Pacific wall time', () => {
    const out = formatDate('2026-09-20T17:13:00Z')
    expect(out).toMatch(/Sep 20/)
    expect(out).toMatch(/10:13\sAM/)
  })

  it('offset string (SENAITE-born) renders as Pacific wall time', () => {
    const out = formatDate('2026-02-27T09:44:51-08:00')
    expect(out).toMatch(/Feb 27/)
    expect(out).toMatch(/9:44\sAM/)
  })

  it('SampleDetails shares the same lab-zone formatter', () => {
    expect(formatLabDateTime(new Date('2026-09-20T17:13:00Z'))).toBe(
      formatDate('2026-09-20T17:13:00Z')
    )
  })

  it('null and invalid input keep their fallback', () => {
    // Existing placeholder glyph, escaped to keep this file dash-free.
    expect(formatDate(null)).toBe('—')
    expect(formatDate('not a date')).toBe('—')
  })
})
