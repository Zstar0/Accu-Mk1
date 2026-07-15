import { describe, it, expect } from 'vitest'
import {
  formatDate,
  formatProcessingTime,
  TEST_EMAILS,
  getOrderEmail,
  getOrderReceivedAt,
  groupAnalysisStates,
  isOrderDone,
  splitHighlight,
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

// getOrderReceivedAt drives the order-level "Outstanding" (time-since-received)
// display in OrderRow. It returns the EARLIEST date_received across an order's
// samples — when the lab first received anything — or null if nothing is
// received yet (rendered as "Awaiting sample").
describe('getOrderReceivedAt', () => {
  interface LookupEntry {
    data?: SenaiteLookupResult
    isLoading: boolean
    isError: boolean
  }

  function receivedLookup(dateReceived: string | null): LookupEntry {
    return {
      data: { date_received: dateReceived } as unknown as SenaiteLookupResult,
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

  it('returns null when sample_results is null', () => {
    expect(
      getOrderReceivedAt({ sample_results: null } as ExplorerOrder, new Map())
    ).toBeNull()
  })

  it('returns null when no sample has been received', () => {
    const map = new Map<string, LookupEntry>([
      ['S-1', receivedLookup(null)],
      ['S-2', { isLoading: true, isError: false }],
    ])
    expect(getOrderReceivedAt(orderWith(['S-1', 'S-2']), map)).toBeNull()
  })

  it('returns the earliest date_received across samples', () => {
    const map = new Map<string, LookupEntry>([
      ['S-1', receivedLookup('2026-05-10T12:00:00Z')],
      ['S-2', receivedLookup('2026-05-08T09:00:00Z')], // earliest
      ['S-3', receivedLookup('2026-05-12T00:00:00Z')],
    ])
    expect(getOrderReceivedAt(orderWith(['S-1', 'S-2', 'S-3']), map)).toBe(
      '2026-05-08T09:00:00Z'
    )
  })

  it('ignores samples lacking a lookup or a date_received', () => {
    const map = new Map<string, LookupEntry>([
      ['S-1', { isLoading: true, isError: false }], // no data
      ['S-2', receivedLookup(null)], // no date
      ['S-3', receivedLookup('2026-05-09T00:00:00Z')], // only one received
    ])
    expect(getOrderReceivedAt(orderWith(['S-1', 'S-2', 'S-3']), map)).toBe(
      '2026-05-09T00:00:00Z'
    )
  })
})

// Lot-search highlight — pure segment splitter behind <HighlightMatch>.
// Case-insensitive, all occurrences, browser-find semantics. Empty/undefined
// query → one non-match segment (renders as plain text).
describe('splitHighlight', () => {
  it('splits a middle match into before/match/after segments', () => {
    expect(splitHighlight('LOT-555-A', '555')).toEqual([
      { text: 'LOT-', match: false },
      { text: '555', match: true },
      { text: '-A', match: false },
    ])
  })

  it('matches case-insensitively but preserves original casing in segments', () => {
    expect(splitHighlight('Lot-ABC', 'abc')).toEqual([
      { text: 'Lot-', match: false },
      { text: 'ABC', match: true },
    ])
  })

  it('highlights every occurrence, not just the first', () => {
    expect(splitHighlight('555x555', '555')).toEqual([
      { text: '555', match: true },
      { text: 'x', match: false },
      { text: '555', match: true },
    ])
  })

  it('returns one non-match segment when the query is absent from the text', () => {
    expect(splitHighlight('LOT-111', '555')).toEqual([
      { text: 'LOT-111', match: false },
    ])
  })

  it('returns one non-match segment for undefined or whitespace-only query', () => {
    expect(splitHighlight('LOT-111', undefined)).toEqual([
      { text: 'LOT-111', match: false },
    ])
    expect(splitHighlight('LOT-111', '   ')).toEqual([
      { text: 'LOT-111', match: false },
    ])
  })

  it('handles the query equalling the whole text', () => {
    expect(splitHighlight('555', '555')).toEqual([{ text: '555', match: true }])
  })
})
