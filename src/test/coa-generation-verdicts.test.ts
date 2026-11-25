import { describe, it, expect } from 'vitest'
import {
  coaReleaseStatus,
  selectRegularGenerations,
  selectVialGenerations,
} from '@/components/senaite/SampleDetails'
import type { ExplorerCOAGeneration } from '@/lib/api'

// Revoked is a terminal state like superseded: a revoked generation is never
// the "current" one for a vial or a regular child, and the console must say
// so rather than fall through to the published branch.

function gen(overrides: Partial<ExplorerCOAGeneration>): ExplorerCOAGeneration {
  return {
    id: 'gen-1',
    sample_id: 'P-0001',
    generation_number: 1,
    verification_code: 'ABCD-1234',
    content_hash: 'hash',
    status: 'published',
    anchor_status: 'pending',
    anchor_tx_hash: null,
    chromatogram_s3_key: null,
    chromatogram_5k_url: null,
    chromatogram_10k_url: null,
    published_at: '2026-09-01T00:00:00Z',
    superseded_at: null,
    created_at: '2026-09-01T00:00:00Z',
    order_id: null,
    order_number: null,
    parent_generation_id: null,
    vial_sequence: null,
    is_regular_coa: false,
    ingestion_status: null,
    forward_enabled: false,
    revoked_at: null,
    revocation_reason: null,
    ...overrides,
  }
}

describe('revoked generations are retired from current selection', () => {
  it('selectVialGenerations skips a revoked per-vial COA', () => {
    const revoked = gen({
      id: 'v1-revoked',
      parent_generation_id: 'root',
      vial_sequence: 1,
      status: 'revoked',
    })
    const live = gen({
      id: 'v2-live',
      parent_generation_id: 'root',
      vial_sequence: 2,
    })
    expect(selectVialGenerations([revoked, live]).map(g => g.id)).toEqual([
      'v2-live',
    ])
  })

  it('selectRegularGenerations skips a revoked regular child even when it is the only one', () => {
    const revoked = gen({
      id: 'r-revoked',
      parent_generation_id: 'root',
      is_regular_coa: true,
      status: 'revoked',
    })
    expect(selectRegularGenerations([revoked])).toEqual([])
  })

  it('selectVialGenerations skips a revoked per-vial COA even when it is the only one', () => {
    const revoked = gen({
      id: 'v1-revoked',
      parent_generation_id: 'root',
      vial_sequence: 1,
      status: 'revoked',
    })
    expect(selectVialGenerations([revoked])).toEqual([])
  })
})

describe('coaReleaseStatus', () => {
  it('reports a revoked generation as revoked, with the reason in the title', () => {
    const status = coaReleaseStatus(
      gen({
        status: 'revoked',
        revoked_at: '2026-09-22T12:00:00Z',
        revocation_reason: 'Sample identity could not be confirmed',
      })
    )
    expect(status.label).toBe('Revoked')
    expect(status.color).toBe('red')
    expect(status.title).toContain('Sample identity could not be confirmed')
  })

  it('still reports superseded as superseded', () => {
    expect(coaReleaseStatus(gen({ status: 'superseded' })).label).toBe(
      'Superseded'
    )
  })
})
