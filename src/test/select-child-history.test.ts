import { describe, it, expect } from 'vitest'
import {
  selectRegularHistory,
  selectVialHistory,
} from '@/components/senaite/SampleDetails'
import type { ExplorerCOAGeneration } from '@/lib/api'

// Superseded per-vial and Core (regular) certificates still need Manage:
// the forward pointer lives on superseded rows and an admin may revoke one
// on its own. The current-row selectors drop them by design, so history is
// a separate selection, newest first, superseded only (revoked rows are
// terminal and have nothing left to manage).

function gen(overrides: Partial<ExplorerCOAGeneration>): ExplorerCOAGeneration {
  return {
    id: 'g',
    sample_id: 'P-0001',
    generation_number: 1,
    verification_code: 'CODE-0001',
    content_hash: 'h',
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
    parent_generation_id: 'root',
    vial_sequence: null,
    is_regular_coa: false,
    ingestion_status: null,
    forward_enabled: false,
    revoked_at: null,
    revocation_reason: null,
    ...overrides,
  }
}

const vial2Old = gen({
  id: 'v2a',
  verification_code: 'V2OL-0001',
  vial_sequence: 2,
  status: 'superseded',
  generation_number: 1,
})
const vial2Older = gen({
  id: 'v2b',
  verification_code: 'V2OL-0000',
  vial_sequence: 2,
  status: 'superseded',
  generation_number: 0,
})
const vial2Live = gen({
  id: 'v2c',
  verification_code: 'V2LI-0002',
  vial_sequence: 2,
  status: 'published',
  generation_number: 2,
})
const vial2Revoked = gen({
  id: 'v2d',
  verification_code: 'V2RV-0003',
  vial_sequence: 2,
  status: 'revoked',
  generation_number: 3,
})
const vial3Old = gen({
  id: 'v3a',
  verification_code: 'V3OL-0001',
  vial_sequence: 3,
  status: 'superseded',
  generation_number: 1,
})
const regularOld = gen({
  id: 'r1',
  verification_code: 'REGO-0001',
  is_regular_coa: true,
  status: 'superseded',
  generation_number: 1,
})
const regularLive = gen({
  id: 'r2',
  verification_code: 'REGL-0002',
  is_regular_coa: true,
  status: 'published',
  generation_number: 2,
})
const brandingOld = gen({
  id: 'b1',
  verification_code: 'BRND-0001',
  status: 'superseded',
  generation_number: 1,
})

describe('selectVialHistory', () => {
  it('returns that vial’s superseded certificates, newest first, and nothing else', () => {
    const all = [
      vial2Older,
      vial3Old,
      vial2Live,
      vial2Old,
      vial2Revoked,
      regularOld,
    ]
    expect(selectVialHistory(all, 2).map(g => g.id)).toEqual(['v2a', 'v2b'])
    expect(selectVialHistory(all, 3).map(g => g.id)).toEqual(['v3a'])
    expect(selectVialHistory(all, 4)).toEqual([])
  })
})

describe('selectRegularHistory', () => {
  it('returns the superseded Core certificates only', () => {
    const all = [regularLive, brandingOld, regularOld, vial2Old]
    expect(selectRegularHistory(all).map(g => g.id)).toEqual(['r1'])
  })
})
