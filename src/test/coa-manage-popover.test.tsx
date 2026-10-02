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
  }
})
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import { CoaManagePopover } from '@/components/senaite/SampleDetails'
import { useAuthStore } from '@/store/auth-store'
import { setCoaForwardEnabled } from '@/lib/api'

const mockForward = vi.mocked(setCoaForwardEnabled)

// CoaManagePopover gathers the per-row COA actions (Forward to current,
// Regen & Republish, Revoke) behind a single "Manage" trigger, each with a
// hint and a hover help icon. Same gating as the inline controls it replaces:
// Forward only on a superseded row, Revoke admin-only on an issued row,
// Regen only when the caller passes one in. The popover renders nothing when
// none of the three apply.

function gen(overrides: Partial<ExplorerCOAGeneration>): ExplorerCOAGeneration {
  return {
    id: 'g1',
    sample_id: 'P-0001',
    generation_number: 1,
    verification_code: 'CODE-0001',
    content_hash: 'hash',
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

const REGEN_BUTTON = <button type="button">Regen</button>

function signInAs(role: string) {
  useAuthStore.setState({
    user: { id: 1, email: 'lab@example.com', role } as never,
  })
}

function openManage() {
  fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
}

beforeEach(() => {
  mockForward.mockReset()
  signInAs('admin')
})

describe('CoaManagePopover', () => {
  it('published, admin, with regen: only the Manage button shows inline; opening it shows Regen and Revoke but no Forward', () => {
    render(
      <CoaManagePopover
        gen={gen({ status: 'published' })}
        regen={REGEN_BUTTON}
      />
    )

    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy()
    expect(screen.queryByLabelText('Forward to current')).toBeNull()
    expect(screen.queryByRole('button', { name: /^revoke/i })).toBeNull()

    openManage()

    expect(screen.getByText('Regen & Republish')).toBeTruthy()
    expect(screen.getByText('Revoke')).toBeTruthy()
    expect(screen.queryByText('Forward to current')).toBeNull()
    expect(screen.queryByLabelText('Forward to current')).toBeNull()
  })

  it('clicking Revoke... opens the dialog and the popover content is gone', async () => {
    render(
      <CoaManagePopover
        gen={gen({ status: 'published', verification_code: 'CODE-9' })}
        regen={REGEN_BUTTON}
      />
    )
    openManage()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke…' }))

    expect(await screen.findByText('Revoke COA CODE-9')).toBeTruthy()
    expect(screen.queryByText('Regen & Republish')).toBeNull()
  })

  it('superseded, admin: the Forward row is present and the checkbox persists', async () => {
    const g = gen({ status: 'superseded', id: 'g-super' })
    render(<CoaManagePopover gen={g} />)
    openManage()

    expect(screen.getByText('Forward to current')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Forward to current'))

    await waitFor(() =>
      expect(mockForward).toHaveBeenCalledWith('g-super', true)
    )
  })

  it('published, non-admin, no regen: renders nothing', () => {
    signInAs('hplc')
    render(<CoaManagePopover gen={gen({ status: 'published' })} />)
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull()
  })

  it('non-admin with a regen node: Manage opens with the Regen row but no Revoke row', () => {
    signInAs('hplc')
    render(
      <CoaManagePopover
        gen={gen({ status: 'published' })}
        regen={REGEN_BUTTON}
      />
    )
    openManage()
    expect(screen.getByText('Regen & Republish')).toBeTruthy()
    expect(screen.queryByText('Revoke')).toBeNull()
  })

  it('a draft row with no regen offers no Manage button', () => {
    render(<CoaManagePopover gen={gen({ status: 'draft' })} />)
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull()
  })

  it('a revoked row with no regen offers no Manage button', () => {
    render(<CoaManagePopover gen={gen({ status: 'revoked' })} />)
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull()
  })

  it('every rendered row has a help button, and the Forward help mentions the Superseded notice', async () => {
    render(
      <CoaManagePopover
        gen={gen({ status: 'superseded' })}
        regen={REGEN_BUTTON}
      />
    )
    openManage()

    expect(screen.getByLabelText('About Forward to current')).toBeTruthy()
    expect(screen.getByLabelText('About Regen & Republish')).toBeTruthy()
    expect(screen.getByLabelText('About Revoke')).toBeTruthy()

    fireEvent.focus(screen.getByLabelText('About Forward to current'))
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toMatch(/Superseded notice/)
  })
})
