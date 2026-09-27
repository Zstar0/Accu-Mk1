import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type * as ApiModule from '@/lib/api'
import type { AdditionalCOAConfig, ExplorerCOAGeneration } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    setCoaForwardEnabled: vi.fn(),
    revokeCoaGeneration: vi.fn(),
    getCoaRevokePreview: vi.fn(),
    updateAdditionalCOAConfig: vi.fn(),
    regenAdditionalCOA: vi.fn(),
    getExplorerCOASignedUrl: vi.fn(),
  }
})
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import { AdditionalCoaCard } from '@/components/senaite/SampleDetails'
import { useAuthStore } from '@/store/auth-store'

// An ACOA card carries the same controls as the primary list: Revoke on its
// current certificate (admin only) and, under "Earlier versions", a Forward
// switch and Revoke on each superseded version of this ACOA.

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

const CONFIG: AdditionalCOAConfig = {
  config_id: 'cfg-1',
  coa_index: 1,
  status: 'published',
  wp_profile_id: null,
  coa_info: { company_name: 'Acme Peptides' },
  generation_id: 'acoa-2',
  verification_code: 'NEW-0002',
  generation_number: 2,
}
const CURRENT = gen({
  id: 'acoa-2',
  verification_code: 'NEW-0002',
  generation_number: 2,
})
const OLD = gen({
  id: 'acoa-1',
  verification_code: 'OLD-0001',
  status: 'superseded',
  superseded_by_id: 'acoa-2',
  superseded_at: '2026-09-10T00:00:00Z',
})

function renderCard(
  props: Partial<ComponentProps<typeof AdditionalCoaCard>> = {}
) {
  return render(
    <AdditionalCoaCard
      coa={CONFIG}
      sampleId="P-0001"
      onUpdateState={vi.fn()}
      onRegenerated={vi.fn()}
      generation={CURRENT}
      earlierVersions={[OLD]}
      onStateChanged={vi.fn()}
      {...props}
    />
  )
}

beforeEach(() => {
  useAuthStore.setState({
    user: { id: 1, email: 'lab@example.com', role: 'admin' } as never,
  })
})

describe('AdditionalCoaCard verdict controls', () => {
  it('offers Revoke on the current certificate once opened', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /Acme Peptides/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    expect(screen.getByRole('button', { name: /^revoke/i })).toBeTruthy()
  })

  it('lists earlier versions with a Forward switch and their own Revoke', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /Acme Peptides/ }))
    fireEvent.click(
      screen.getByRole('button', { name: /Earlier versions \(1\)/ })
    )
    expect(screen.getByText('OLD-0001')).toBeTruthy()

    // Each row is its own popover (a click outside one closes it), so open
    // and check them one at a time rather than expecting both open together.
    const [currentManage, oldManage] = screen.getAllByRole('button', {
      name: 'Manage',
    })
    if (!currentManage || !oldManage)
      throw new Error('expected two Manage buttons')

    fireEvent.click(currentManage)
    expect(screen.getByRole('button', { name: /^revoke/i })).toBeTruthy()

    fireEvent.click(oldManage)
    expect(screen.getByLabelText('Forward to current')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^revoke/i })).toBeTruthy()
  })

  it('shows the generation status (revoked) over the config status', () => {
    renderCard({
      generation: gen({
        id: 'acoa-2',
        status: 'revoked',
        revocation_reason: 'Lot recalled',
      }),
      earlierVersions: [],
    })
    expect(screen.getByText('revoked')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Acme Peptides/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    expect(screen.queryByRole('button', { name: /^revoke/i })).toBeNull()
  })

  it('hides Revoke from non-admins', () => {
    useAuthStore.setState({
      user: { id: 2, email: 'tech@example.com', role: 'hplc' } as never,
    })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: /Acme Peptides/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    expect(screen.queryByRole('button', { name: /^revoke/i })).toBeNull()
  })
})
