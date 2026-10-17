import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type * as ApiModule from '@/lib/api'
import type { ExplorerCOAGeneration } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return { ...actual, regenPrimaryCOA: vi.fn() }
})
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import {
  CoaManagePopover,
  PrimaryRegenButton,
} from '@/components/senaite/SampleDetails'
import { useAuthStore } from '@/store/auth-store'
import { regenPrimaryCOA } from '@/lib/api'

const mockRegen = vi.mocked(regenPrimaryCOA)

// The Regen & Republish button lives inside the Manage popover, which
// unmounts its content when it closes. The in-flight state must survive
// that: closing and reopening Manage while a regen is running must show a
// disabled button and must not let a second request start.

function gen(): ExplorerCOAGeneration {
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
  }
}

const openManage = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
// Anchored regex: the popover's help icon is named "About Regen & Republish".
const REGEN = /^Regen & Republish$/
const regenButton = () => screen.getByRole('button', { name: REGEN })

beforeEach(() => {
  mockRegen.mockReset()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  useAuthStore.setState({
    user: { id: 1, email: 'lab@example.com', role: 'hplc' } as never,
  })
})

describe('Regen & Republish in-flight guard across the Manage popover', () => {
  it('a reopened popover shows the running regen as disabled and refuses a second request', async () => {
    let finish!: (v: {
      success: boolean
      message: string
      verification_code: string | null
    }) => void
    mockRegen.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )

    render(<CoaManagePopover gen={gen()} regen={<RegenForTest />} />)

    openManage()
    fireEvent.click(regenButton())
    expect(mockRegen).toHaveBeenCalledTimes(1)

    // Close (the trigger toggles; the content unmounts) and reopen while the
    // request is still pending.
    openManage()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: REGEN })).toBeNull()
    )
    openManage()

    expect(regenButton()).toBeDisabled()
    fireEvent.click(regenButton())
    expect(mockRegen).toHaveBeenCalledTimes(1)

    finish({ success: true, message: 'ok', verification_code: 'NEW1-0001' })
    await waitFor(() => expect(regenButton()).toBeEnabled())
  })
})

// The popover's `regen` slot is how the page mounts the button; mount it the same way.
function RegenForTest() {
  return (
    <PrimaryRegenButton sampleId="P-0001" onRegenerated={() => undefined} />
  )
}
