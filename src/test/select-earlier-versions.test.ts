import { describe, expect, it } from 'vitest'
import { selectEarlierVersions } from '@/components/senaite/SampleDetails'
import type { ExplorerCOAGeneration } from '@/lib/api'

// Earlier versions of an ACOA are the superseded generations whose recorded
// replacement chain (superseded_by_id) ends at the ACOA's current generation.
// Brand isolation falls out of the chain: another brand's history never points
// here. A broken link (hand-retired rows) or a cycle drops out, never crashes.

function gen(overrides: Partial<ExplorerCOAGeneration>): ExplorerCOAGeneration {
  return {
    id: 'g',
    sample_id: 'P-0001',
    generation_number: 1,
    verification_code: 'CODE',
    content_hash: 'h',
    status: 'superseded',
    anchor_status: 'pending',
    anchor_tx_hash: null,
    chromatogram_s3_key: null,
    chromatogram_5k_url: null,
    chromatogram_10k_url: null,
    published_at: null,
    superseded_at: null,
    created_at: '2026-09-01T00:00:00Z',
    order_id: null,
    order_number: null,
    parent_generation_id: 'root',
    vial_sequence: null,
    is_regular_coa: false,
    ingestion_status: null,
    forward_enabled: false,
    revoked_at: null,
    revocation_reason: null,
    superseded_by_id: null,
    revoked_by: null,
    ...overrides,
  }
}

describe('selectEarlierVersions', () => {
  it('walks the chain to the current generation, newest first', () => {
    const cur = gen({ id: 'x3', status: 'published', generation_number: 3 })
    const x2 = gen({ id: 'x2', generation_number: 2, superseded_by_id: 'x3' })
    const x1 = gen({ id: 'x1', generation_number: 1, superseded_by_id: 'x2' })
    expect(selectEarlierVersions([x1, cur, x2], 'x3').map(g => g.id)).toEqual([
      'x2',
      'x1',
    ])
  })

  it('keeps brands apart because only the recorded chain counts', () => {
    const x2 = gen({ id: 'x2', status: 'published' })
    const x1 = gen({ id: 'x1', superseded_by_id: 'x2' })
    const y2 = gen({ id: 'y2', status: 'published' })
    const y1 = gen({ id: 'y1', superseded_by_id: 'y2' })
    expect(
      selectEarlierVersions([x1, x2, y1, y2], 'x2').map(g => g.id)
    ).toEqual(['x1'])
    expect(
      selectEarlierVersions([x1, x2, y1, y2], 'y2').map(g => g.id)
    ).toEqual(['y1'])
  })

  it('drops rows with no recorded link and survives a cycle', () => {
    const cur = gen({ id: 'c', status: 'published' })
    const orphan = gen({ id: 'o', superseded_by_id: null })
    const a = gen({ id: 'a', superseded_by_id: 'b' })
    const b = gen({ id: 'b', superseded_by_id: 'a' })
    expect(selectEarlierVersions([cur, orphan, a, b], 'c')).toEqual([])
  })

  it('returns nothing without a current id', () => {
    expect(
      selectEarlierVersions([gen({ id: 'x1', superseded_by_id: 'x2' })], null)
    ).toEqual([])
  })
})
