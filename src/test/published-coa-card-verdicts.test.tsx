import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type * as ApiModule from '@/lib/api'
import type { ExplorerCOAGeneration, SenaitePublishedCOA } from '@/lib/api'

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

import { PublishedCOACard } from '@/components/senaite/SampleDetails'
import { useAuthStore } from '@/store/auth-store'

// PublishedCOACard is the SENAITE-attached-ARReport card (the primary on most
// prod samples). It carries the same additive controls as the other COA
// cards: Revoke on the root when published|superseded, Forward when
// superseded, admin only.

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
    superseded_by_id: null,
    revoked_by: null,
    ...overrides,
  }
}

const COA: SenaitePublishedCOA = {
  report_uid: 'uid-1',
  filename: 'coa.pdf',
  file_size_bytes: 1024,
  published_date: '2026-09-10T00:00:00Z',
  published_by: 'Lab Tech',
  download_url: 'https://example.test/coa.pdf',
}
const PUBLISHED = gen({
  id: 'g2',
  verification_code: 'CODE-0001',
  status: 'published',
})
const SUPERSEDED = gen({
  id: 'g1',
  verification_code: 'OLD-0001',
  status: 'superseded',
  superseded_by_id: 'g2',
})

function renderCard(
  props: Partial<ComponentProps<typeof PublishedCOACard>> = {}
) {
  return render(
    <PublishedCOACard
      coa={COA}
      sampleId="P-0001"
      verificationCode="CODE-0001"
      generation={PUBLISHED}
      onRefresh={vi.fn()}
      {...props}
    />
  )
}

beforeEach(() => {
  useAuthStore.setState({
    user: { id: 1, email: 'lab@example.com', role: 'admin' } as never,
  })
})

describe('PublishedCOACard verdict controls', () => {
  it('offers Revoke on a published root to an admin', () => {
    renderCard({ generation: PUBLISHED })
    expect(screen.getByRole('button', { name: /^revoke/i })).toBeTruthy()
  })

  it('offers Forward to current on a superseded root to an admin', () => {
    renderCard({ generation: SUPERSEDED })
    expect(screen.getByLabelText('Forward to current')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^revoke/i })).toBeTruthy()
  })

  it('hides Revoke from non-admins', () => {
    useAuthStore.setState({
      user: { id: 2, email: 'tech@example.com', role: 'hplc' } as never,
    })
    renderCard({ generation: PUBLISHED })
    expect(screen.queryByRole('button', { name: /^revoke/i })).toBeNull()
  })
})
