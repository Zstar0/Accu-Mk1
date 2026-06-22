import { describe, it, expect } from 'vitest'
import { selectRootGenerations, selectVialGenerations } from '@/components/senaite/SampleDetails'
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
    vial_sequence: null,
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

  it('excludes per-vial children (they have a parent)', () => {
    const root = gen({ id: 'root', parent_generation_id: null, vial_sequence: null })
    const vial = gen({ id: 'vial', parent_generation_id: 'root', vial_sequence: 1 })
    expect(selectRootGenerations([root, vial]).map(g => g.id)).toEqual(['root'])
  })
})

describe('selectVialGenerations', () => {
  it('returns empty array for empty input', () => {
    expect(selectVialGenerations([])).toEqual([])
  })

  it('includes only generations with a vial_sequence', () => {
    const primary = gen({ id: 'primary', vial_sequence: null })
    const branding = gen({ id: 'branding', parent_generation_id: 'primary', vial_sequence: null })
    const vial = gen({ id: 'vial', parent_generation_id: 'primary', vial_sequence: 2 })
    const result = selectVialGenerations([primary, branding, vial])
    expect(result.map(g => g.id)).toEqual(['vial'])
  })

  it('sorts by vial_sequence ascending', () => {
    const v3 = gen({ id: 'v3', parent_generation_id: 'p', vial_sequence: 3 })
    const v1 = gen({ id: 'v1', parent_generation_id: 'p', vial_sequence: 1 })
    const v2 = gen({ id: 'v2', parent_generation_id: 'p', vial_sequence: 2 })
    const result = selectVialGenerations([v3, v1, v2])
    expect(result.map(g => g.vial_sequence)).toEqual([1, 2, 3])
  })

  it('excludes superseded vial generations (mirrors the primary card)', () => {
    const live = gen({ id: 'live', parent_generation_id: 'p', vial_sequence: 1, status: 'published' })
    const old = gen({ id: 'old', parent_generation_id: 'p', vial_sequence: 1, status: 'superseded' })
    const result = selectVialGenerations([live, old])
    expect(result.map(g => g.id)).toEqual(['live'])
  })

  it('collapses to one row per vial, preferring the published generation', () => {
    // Vial 5 has both a published COA and an orphan draft (the P-0152 case).
    const pub = gen({ id: 'pub', parent_generation_id: 'p', vial_sequence: 5, status: 'published', generation_number: 6 })
    const draft = gen({ id: 'draft', parent_generation_id: 'p', vial_sequence: 5, status: 'draft', generation_number: 2 })
    const result = selectVialGenerations([pub, draft])
    expect(result.map(g => g.id)).toEqual(['pub'])
  })

  it('for a draft-only vial keeps the latest draft generation', () => {
    const d1 = gen({ id: 'd1', parent_generation_id: 'p', vial_sequence: 2, status: 'draft', generation_number: 1 })
    const d2 = gen({ id: 'd2', parent_generation_id: 'p', vial_sequence: 2, status: 'draft', generation_number: 3 })
    const result = selectVialGenerations([d1, d2])
    expect(result.map(g => g.id)).toEqual(['d2'])
  })
})
