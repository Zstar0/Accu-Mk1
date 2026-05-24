import { describe, it, expect } from 'vitest'
import {
  formatDate,
  formatProcessingTime,
  TEST_EMAILS,
  getOrderEmail,
  groupAnalysisStates,
  isOrderDone,
} from '@/components/explorer/helpers'
import type {
  ExplorerOrder,
  SenaiteAnalysis,
  SenaiteLookupResult,
} from '@/lib/api'

describe('formatProcessingTime', () => {
  it('returns d+h form for spans >= 1 day', () => {
    expect(
      formatProcessingTime('2026-05-01T00:00:00Z', '2026-05-03T05:00:00Z')
    ).toBe('2d 5h')
  })

  it('returns h+m form for spans >= 1 hour and < 1 day (null completed_at branch)', () => {
    const start = new Date(Date.now() - 3 * 60 * 60_000 - 15 * 60_000) // 3h 15m ago
    const result = formatProcessingTime(start.toISOString(), null)
    // Format: "{N}h {M}m"
    expect(result).toMatch(/^\d+h \d+m$/)
  })

  it('returns ms form for sub-second spans', () => {
    const start = new Date()
    const end = new Date(start.getTime() + 250)
    const result = formatProcessingTime(start.toISOString(), end.toISOString())
    expect(result).toMatch(/^\d+ms$/)
  })

  it('returns em-dash for negative spans', () => {
    expect(
      formatProcessingTime('2026-05-03T00:00:00Z', '2026-05-01T00:00:00Z')
    ).toBe('—')
  })
})

describe('getOrderEmail', () => {
  it('extracts email from billing payload', () => {
    const order = {
      payload: { billing: { email: 'a@b.com' } },
    } as unknown as ExplorerOrder
    expect(getOrderEmail(order)).toBe('a@b.com')
  })

  it('returns null when payload is null', () => {
    expect(getOrderEmail({ payload: null } as ExplorerOrder)).toBeNull()
  })

  it('returns null when billing is not an object', () => {
    const order = {
      payload: { billing: 'not-an-object' },
    } as unknown as ExplorerOrder
    expect(getOrderEmail(order)).toBeNull()
  })
})

describe('TEST_EMAILS', () => {
  it('contains the two locked policy entries', () => {
    expect(TEST_EMAILS).toEqual([
      'forrestp@outlook.com',
      'forrest@valenceanalytical.com',
    ])
  })
})

describe('formatDate', () => {
  it('returns em-dash for null input', () => {
    expect(formatDate(null)).toBe('—')
  })

  it('returns a non-em-dash truthy string for valid ISO date', () => {
    const out = formatDate('2026-05-14T12:00:00Z')
    expect(out).toBeTruthy()
    expect(out).not.toBe('—')
    // Should include some recognizable date fragment
    expect(out.length).toBeGreaterThan(3)
  })
})

describe('groupAnalysisStates', () => {
  it('returns all-zero counts for empty analyses and null sample state', () => {
    const result = groupAnalysisStates([] as SenaiteAnalysis[], null)
    expect(result).toEqual({
      sample_due: 0,
      received: 0,
      assigned: 0,
      to_verify: 0,
      waiting_for_addon: 0,
      ready_for_review: 0,
      verified: 0,
      published: 0,
      pending: 0,
    })
  })
})

// isOrderDone drives the greyed-out (opacity-45) row treatment on the Order
// Status page. Policy: an order is "done" only when EVERY sample is published
// in SENAITE (sample-level review_state === 'published'). A sample that is
// merely verified — results approved but COA not yet published — does NOT
// count as done, so the order stays at full opacity (active).
describe('isOrderDone', () => {
  type LookupEntry = {
    data?: SenaiteLookupResult
    isLoading: boolean
    isError: boolean
  }

  function makeLookup(reviewState: string): LookupEntry {
    return {
      data: { review_state: reviewState } as unknown as SenaiteLookupResult,
      isLoading: false,
      isError: false,
    }
  }

  function orderWith(senaiteIds: string[]): ExplorerOrder {
    const sample_results: Record<
      string,
      { senaite_id: string; status: string }
    > = {}
    senaiteIds.forEach((id, i) => {
      sample_results[String(i + 1)] = { senaite_id: id, status: 'created' }
    })
    return { sample_results } as unknown as ExplorerOrder
  }

  it('returns false when sample_results is null', () => {
    const order = { sample_results: null } as ExplorerOrder
    expect(isOrderDone(order, new Map())).toBe(false)
  })

  it('returns false when there are no sample entries', () => {
    expect(isOrderDone(orderWith([]), new Map())).toBe(false)
  })

  it('returns true when every sample is published', () => {
    const map = new Map<string, LookupEntry>([
      ['P-1', makeLookup('published')],
      ['P-2', makeLookup('published')],
    ])
    expect(isOrderDone(orderWith(['P-1', 'P-2']), map)).toBe(true)
  })

  it('returns false when all samples are verified but not yet published', () => {
    const map = new Map<string, LookupEntry>([['P-1', makeLookup('verified')]])
    expect(isOrderDone(orderWith(['P-1']), map)).toBe(false)
  })

  it('returns false when samples are a mix of published and verified', () => {
    const map = new Map<string, LookupEntry>([
      ['P-1', makeLookup('published')],
      ['P-2', makeLookup('verified')],
    ])
    expect(isOrderDone(orderWith(['P-1', 'P-2']), map)).toBe(false)
  })

  it('is case-insensitive on review_state', () => {
    const map = new Map<string, LookupEntry>([['P-1', makeLookup('PUBLISHED')]])
    expect(isOrderDone(orderWith(['P-1']), map)).toBe(true)
  })

  it('returns false when a sample lookup has no data yet (still loading)', () => {
    const map = new Map<string, LookupEntry>([
      ['P-1', { isLoading: true, isError: false }],
    ])
    expect(isOrderDone(orderWith(['P-1']), map)).toBe(false)
  })
})
