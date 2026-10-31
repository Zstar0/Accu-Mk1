import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type * as ApiModule from '@/lib/api'
import type { ExplorerCOAGeneration } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    setCoaForwardEnabled: vi.fn(),
    revokeCoaGeneration: vi.fn(),
    getCoaRevokePreview: vi.fn(),
    resumeCoaRevocation: vi.fn(),
  }
})
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import { CoaManagePopover } from '@/components/senaite/SampleDetails'
import { useAuthStore } from '@/store/auth-store'
import { resumeCoaRevocation } from '@/lib/api'
import { toast } from 'sonner'

const mockResume = vi.mocked(resumeCoaRevocation)

// A revoke commits first; the WordPress notice and the PDF withdrawal run
// after it and can fail on their own. Calling Revoke again is refused (the
// row is already revoked), so an admin needs a way to re-run just those
// follow-ups from the revoked row.

function gen(overrides: Partial<ExplorerCOAGeneration>): ExplorerCOAGeneration {
  return {
    id: 'g-revoked',
    sample_id: 'P-0001',
    generation_number: 1,
    verification_code: 'RVKD-0001',
    content_hash: 'h',
    status: 'revoked',
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
    revoked_at: '2026-10-01T12:00:00Z',
    revocation_reason: 'Lot recalled',
    ...overrides,
  }
}

function signInAs(role: string) {
  useAuthStore.setState({
    user: { id: 1, email: 'lab@example.com', role } as never,
  })
}

beforeEach(() => {
  mockResume.mockReset()
  vi.mocked(toast.success).mockReset()
  vi.mocked(toast.warning).mockReset()
})

describe('revocation follow-ups (resume)', () => {
  it('an admin can re-run the follow-ups from a revoked row and sees the outcome', async () => {
    signInAs('admin')
    mockResume.mockResolvedValue({
      revoked: [],
      skipped: [],
      wp_notified: true,
      wp_error: null,
      wp_warning: null,
      pdfs_withdrawn: ['RVKD-0001'],
      pdfs_withdraw_failed: [],
      resumed: true,
    })
    const onStateChanged = vi.fn()
    render(<CoaManagePopover gen={gen({})} onStateChanged={onStateChanged} />)

    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    expect(screen.getByText('Revocation follow-ups')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(mockResume).toHaveBeenCalledWith('g-revoked'))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(onStateChanged).toHaveBeenCalled()
  })

  it('reports what still failed as a warning', async () => {
    signInAs('admin')
    mockResume.mockResolvedValue({
      revoked: [],
      skipped: [],
      wp_notified: false,
      wp_error: 'HTTP 500: boom',
      wp_warning: null,
      pdfs_withdrawn: [],
      pdfs_withdraw_failed: ['RVKD-0001'],
      resumed: true,
    })
    render(<CoaManagePopover gen={gen({})} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    const descriptions = vi
      .mocked(toast.warning)
      .mock.calls.map(c => String(c[1]?.description))
      .join(' ')
    expect(descriptions).toContain('HTTP 500: boom')
    expect(descriptions).toContain('RVKD-0001')
  })

  it('is admin only: a revoked row offers nothing to other roles', () => {
    signInAs('hplc')
    render(<CoaManagePopover gen={gen({})} />)
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull()
  })
})
