import { describe, it, expect } from 'vitest'
import { selectDisplayedGeneration } from '@/components/senaite/SampleDetails'
import type { ExplorerCOAGeneration } from '@/lib/api'

// The SENAITE-era card shows one certificate (the attached report's code).
// Its Manage controls must act on exactly that certificate: when the ledger
// has moved on (a regen whose SENAITE attachment failed leaves the old report
// displayed while a newer code is published), the newer root is NOT a stand-in.

function gen(overrides: Partial<ExplorerCOAGeneration>): ExplorerCOAGeneration {
  return {
    id: 'g',
    sample_id: 'P-0001',
    generation_number: 1,
    verification_code: 'AAAA-0001',
    content_hash: 'h',
    status: 'published',
    anchor_status: 'pending',
    anchor_tx_hash: null,
    chromatogram_s3_key: null,
    chromatogram_5k_url: null,
    chromatogram_10k_url: null,
    published_at: '2026-09-10T00:00:00Z',
    superseded_at: null,
    created_at: '2026-09-10T00:00:00Z',
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

const displayedA = gen({
  id: 'a',
  verification_code: 'AAAA-0001',
  status: 'superseded',
  generation_number: 1,
})
const newerB = gen({
  id: 'b',
  verification_code: 'BBBB-0002',
  status: 'published',
  generation_number: 2,
})

describe('selectDisplayedGeneration', () => {
  it('returns the generation whose code the card displays, even when a newer root is live', () => {
    expect(selectDisplayedGeneration([newerB, displayedA], 'AAAA-0001')).toBe(
      displayedA
    )
  })

  it('returns null when no generation carries the displayed code (no stand-in)', () => {
    expect(selectDisplayedGeneration([newerB], 'AAAA-0001')).toBeNull()
    expect(selectDisplayedGeneration([newerB, displayedA], null)).toBeNull()
    expect(
      selectDisplayedGeneration([newerB, displayedA], undefined)
    ).toBeNull()
  })
})
