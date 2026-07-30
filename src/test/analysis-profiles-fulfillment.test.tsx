import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { AnalysisProfile } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getAnalysisProfiles: vi.fn(),
    getAnalysisProfileMembers: vi.fn(),
    getAnalysisServices: vi.fn(),
    createAnalysisProfile: vi.fn(),
    updateAnalysisProfile: vi.fn(),
    deleteAnalysisProfile: vi.fn(),
    setAnalysisProfileMembers: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import {
  getAnalysisProfiles,
  getAnalysisProfileMembers,
  getAnalysisServices,
  updateAnalysisProfile,
} from '@/lib/api'
import AnalysisProfilesPage from '@/components/hplc/AnalysisProfilesPage'

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const PROFILE: AnalysisProfile = {
  id: 1,
  key: 'heavy-metals',
  name: 'Heavy Metals',
  description: null,
  is_addon: false,
  vials_required: 1,
  fulfillment_role: null,
  fulfillment_dim: 'role',
  sort_order: 0,
  active: true,
  coa_section_title: null,
  coa_archetype: null,
  coa_sort_order: 0,
  member_ids: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

describe('AnalysisProfilesPage — fulfillment fields', () => {
  beforeEach(() => {
    vi.mocked(getAnalysisProfiles).mockResolvedValue([PROFILE])
    vi.mocked(getAnalysisProfileMembers).mockResolvedValue([])
    vi.mocked(getAnalysisServices).mockResolvedValue([])
    vi.mocked(updateAnalysisProfile).mockResolvedValue({ ...PROFILE, fulfillment_role: 'hm' })
  })

  it('renders a fulfillment_role input in the edit panel and includes it in the PATCH payload', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    const row = await screen.findByText('Heavy Metals')
    await user.click(row)

    const roleInput = await screen.findByPlaceholderText('e.g. hm')
    await user.type(roleInput, 'hm')

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(updateAnalysisProfile).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ fulfillment_role: 'hm', fulfillment_dim: 'role' })
      )
    })
  })

  it('shows the honest active copy instead of the old "hidden from new orders" wording', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    const row = await screen.findByText('Heavy Metals')
    await user.click(row)

    expect(await screen.findByText(
      /Inactive marks the profile retired — fulfilment of already-sold orders continues\. Removing it from sale is the WordPress Test-Services entry\./
    )).toBeInTheDocument()
    expect(screen.queryByText('Inactive profiles are hidden from new orders')).not.toBeInTheDocument()
  })

  it('round-trips a non-default fulfillment_dim/role pair unchanged', async () => {
    const varianceProfile: AnalysisProfile = {
      ...PROFILE,
      id: 2,
      name: 'Variance HPLC',
      fulfillment_role: 'variance',
      fulfillment_dim: 'kind',
    }
    vi.mocked(getAnalysisProfiles).mockResolvedValue([varianceProfile])
    vi.mocked(updateAnalysisProfile).mockResolvedValue(varianceProfile)

    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    const row = await screen.findByText('Variance HPLC')
    await user.click(row)

    // No edits — Save Changes should round-trip the seeded pair, proving the
    // select/input are actually wired to the loaded profile and not
    // hardcoded to the 'role' default.
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(updateAnalysisProfile).toHaveBeenCalledWith(
        2,
        expect.objectContaining({ fulfillment_role: 'variance', fulfillment_dim: 'kind' })
      )
    })
  })

  it('also renders the fulfillment_role input on the create panel', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    await screen.findByText('Heavy Metals')
    await user.click(screen.getByRole('button', { name: /add profile/i }))

    expect(await screen.findByPlaceholderText('e.g. hm')).toBeInTheDocument()
  })
})
