import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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

function gen(overrides: Partial<ExplorerCOAGeneration>): ExplorerCOAGeneration {
  return {
    id: 'g',
    sample_id: 'P-0001',
    generation_number: 1,
    verification_code: 'CODE',
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
    parent_generation_id: 'root',
    vial_sequence: 1,
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

beforeEach(() => {
  useAuthStore.setState({
    user: { id: 1, email: 'lab@example.com', role: 'admin' } as never,
  })
})

describe('VialCOAList verdict controls', () => {
  it('offers Revoke on published vials and Forward plus Revoke on superseded ones', () => {
    render(
      <VialCOAList
        generations={[
          gen({ id: 'v1', vial_sequence: 1, verification_code: 'V1-0002' }),
          gen({
            id: 'v2',
            vial_sequence: 2,
            status: 'superseded',
            verification_code: 'V2-0001',
          }),
        ]}
        onStateChanged={vi.fn()}
      />
    )
    const manage = screen.getAllByRole('button', { name: 'Manage' })
    expect(manage).toHaveLength(2)

    // Published vial: Revoke only.
    fireEvent.click(manage[0] as HTMLElement)
    expect(screen.getByRole('button', { name: 'Revoke…' })).toBeTruthy()
    expect(screen.queryByLabelText('Forward to current')).toBeNull()

    // Superseded vial: Forward plus Revoke (opening it closes the first popover).
    fireEvent.click(manage[1] as HTMLElement)
    expect(screen.getByLabelText('Forward to current')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Revoke…' })).toBeTruthy()
  })

  it('offers nothing on a draft or a revoked vial', () => {
    render(
      <VialCOAList
        generations={[
          gen({ id: 'd', status: 'draft', published_at: null }),
          gen({ id: 'r', status: 'revoked', revocation_reason: 'x' }),
        ]}
      />
    )
    // The draft offers nothing; the revoked vial keeps one admin control, the
    // revocation follow-ups (no Revoke, no Forward).
    expect(screen.getAllByRole('button', { name: 'Manage' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    expect(screen.getByText('Revocation follow-ups')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^revoke/i })).toBeNull()
    expect(screen.queryByLabelText('Forward to current')).toBeNull()
    expect(screen.getByText('Revoked')).toBeTruthy()
  })
})
