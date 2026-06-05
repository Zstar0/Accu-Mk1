import { describe, it, expect } from 'vitest'
import { selectRootGenerations } from '@/components/senaite/SampleDetails'
import type { ExplorerCOAGeneration } from '@/lib/api'

function gen(overrides: Partial<ExplorerCOAGeneration>): ExplorerCOAGeneration {
  return {
    id: 'gen-1',
    sample_id: 'P-0001-S01',
    generation_number: 1,
    verification_code: 'ABCD-1234',
    content_hash: 'hash',
    status: 'draft',
    anchor_status: 'pending',
    anchor_tx_hash: null,
    chromatogram_s3_key: null,
    chromatogram_5k_url: null,
    chromatogram_10k_url: null,
    published_at: null,
    superseded_at: null,
    created_at: '2026-06-01T00:00:00Z',
    order_id: null,
    order_number: null,
    parent_generation_id: null,
    ingestion_status: null,
    ...overrides,
  }
}

describe('selectRootGenerations', () => {
  it('returns empty array for empty input', () => {
    expect(selectRootGenerations([])).toEqual([])
  })

  it('excludes child (additional) generations', () => {
    const root = gen({ id: 'root', parent_generation_id: null })
    const child = gen({ id: 'child', parent_generation_id: 'root' })
    const result = selectRootGenerations([root, child])
    expect(result.map(g => g.id)).toEqual(['root'])
  })

  it('sorts root generations newest first by created_at', () => {
    const older = gen({ id: 'older', generation_number: 1, created_at: '2026-06-01T00:00:00Z' })
    const newer = gen({ id: 'newer', generation_number: 2, created_at: '2026-06-03T00:00:00Z' })
    const result = selectRootGenerations([older, newer])
    expect(result.map(g => g.id)).toEqual(['newer', 'older'])
  })

  it('breaks created_at ties by generation_number descending', () => {
    const ts = '2026-06-01T00:00:00Z'
    const g1 = gen({ id: 'g1', generation_number: 1, created_at: ts })
    const g2 = gen({ id: 'g2', generation_number: 2, created_at: ts })
    const result = selectRootGenerations([g1, g2])
    expect(result.map(g => g.id)).toEqual(['g2', 'g1'])
  })
})
