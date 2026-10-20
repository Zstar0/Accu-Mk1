import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type * as ApiModule from '@/lib/api'
import type { ExplorerCOAGeneration } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    setCoaForwardEnabled: vi.fn(),
    revokeCoaGeneration: vi.fn(),
    getCoaRevokePreview: vi.fn(),
  }
})
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import { VialCOAList } from '@/components/senaite/SampleDetails'
import { useAuthStore } from '@/store/auth-store'

// A re-published vial certificate retires the previous one. That superseded
// row must stay reachable under the vial: it carries the forward pointer the
// lab may switch off and an admin may revoke it on its own.

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
    superseded_at: '2026-09-02T00:00:00Z',
    created_at: '2026-09-01T00:00:00Z',
    order_id: null,
    order_number: null,
    parent_generation_id: 'root',
    vial_sequence: 2,
    is_regular_coa: false,
    ingestion_status: null,
    forward_enabled: true,
    revoked_at: null,
    revocation_reason: null,
    ...overrides,
  }
}

const vial2Live = gen({
  id: 'v2c',
  verification_code: 'V2LI-0002',
  generation_number: 2,
  superseded_at: null,
  forward_enabled: false,
})
const vial2Old = gen({
  id: 'v2a',
  verification_code: 'V2OL-0001',
  status: 'superseded',
})
const vial3Old = gen({
  id: 'v3a',
  verification_code: 'V3OL-0001',
  vial_sequence: 3,
  status: 'superseded',
})

beforeEach(() => {
  useAuthStore.setState({
    user: { id: 1, email: 'lab@example.com', role: 'admin' } as never,
  })
})

describe('VialCOAList history', () => {
  it('lists each vial’s superseded certificates under it with Manage (Forward reachable)', () => {
    render(
      <VialCOAList
        generations={[vial2Live]}
        allGenerations={[vial2Live, vial2Old, vial3Old]}
      />
    )

    const toggle = screen.getByRole('button', {
      name: /Earlier versions \(1\)/,
    })
    fireEvent.click(toggle)
    expect(screen.getByText('V2OL-0001')).toBeInTheDocument()
    expect(screen.queryByText('V3OL-0001')).toBeNull()

    // The superseded row's own Manage: the Forward row is on it.
    const manage = screen.getAllByRole('button', { name: 'Manage' })
    fireEvent.click(manage.at(-1)!)
    expect(screen.getByText('Forward to current')).toBeInTheDocument()
  })

  it('shows no history control when nothing was superseded', () => {
    render(
      <VialCOAList generations={[vial2Live]} allGenerations={[vial2Live]} />
    )
    expect(
      screen.queryByRole('button', { name: /Earlier versions/ })
    ).toBeNull()
  })
})
