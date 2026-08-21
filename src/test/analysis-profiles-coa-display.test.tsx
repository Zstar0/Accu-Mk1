import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { AnalysisProfile, Department } from '@/lib/api'
import type * as ApiModule from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    getAnalysisProfiles: vi.fn(),
    getAnalysisProfileMembers: vi.fn(),
    getAnalysisServices: vi.fn(),
    // Task 8: the panel now also loads the methods catalog on open (feeds
    // "Suggest from methods") — mock it so the panel doesn't fall through to
    // the real implementation's fetch() during these unrelated tests.
    getMethods: vi.fn(),
    createAnalysisProfile: vi.fn(),
    updateAnalysisProfile: vi.fn(),
    deleteAnalysisProfile: vi.fn(),
    setAnalysisProfileMembers: vi.fn(),
    getRideHosts: vi.fn(),
    putRideHosts: vi.fn(),
    getVialRoles: vi.fn(),
    getDepartments: vi.fn(),
    getSlaTiers: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import {
  getAnalysisProfiles,
  getAnalysisProfileMembers,
  getAnalysisServices,
  getMethods,
  updateAnalysisProfile,
  createAnalysisProfile,
  getRideHosts,
  putRideHosts,
  getVialRoles,
  getDepartments,
  getSlaTiers,
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
  coa_basis_note: null,
  coa_method_text: null,
  coa_prep_text: null,
  coa_footnotes: null,
  member_ids: [],
  member_service_ids: [],
  sla_tier_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const DEPT: Department = {
  id: 1,
  name: 'Analytical',
  sort_order: 0,
  color: 'blue',
  is_system: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

describe('AnalysisProfilesPage — COA display fields', () => {
  beforeEach(() => {
    vi.mocked(getAnalysisProfiles).mockReset().mockResolvedValue([PROFILE])
    vi.mocked(getAnalysisProfileMembers).mockReset().mockResolvedValue([])
    vi.mocked(getAnalysisServices).mockReset().mockResolvedValue([])
    vi.mocked(getMethods).mockReset().mockResolvedValue([])
    vi.mocked(createAnalysisProfile)
      .mockReset()
      .mockResolvedValue({ ...PROFILE, id: 99 })
    vi.mocked(updateAnalysisProfile).mockReset().mockResolvedValue(PROFILE)
    vi.mocked(getRideHosts).mockReset().mockResolvedValue([])
    vi.mocked(putRideHosts).mockReset().mockResolvedValue({ count: 0 })
    vi.mocked(getVialRoles).mockReset().mockResolvedValue([])
    vi.mocked(getDepartments).mockReset().mockResolvedValue([DEPT])
    vi.mocked(getSlaTiers).mockReset().mockResolvedValue([])
  })

  it('fills basis note, method, prep, and two footnotes, and PATCH carries all four', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    const row = await screen.findByText('Heavy Metals')
    await user.click(row)

    await user.type(
      await screen.findByLabelText('Basis Note'),
      'Per USP <232> limits'
    )
    await user.type(screen.getByLabelText('Method'), 'ICP-MS')
    await user.type(screen.getByLabelText('Prep'), 'Microwave digestion')

    await user.click(screen.getByRole('button', { name: /add footnote/i }))
    await user.type(screen.getByLabelText('Footnote 1 label'), 'note-a')
    await user.type(
      screen.getByLabelText('Footnote 1 text'),
      'First footnote text'
    )

    await user.click(screen.getByRole('button', { name: /add footnote/i }))
    await user.type(screen.getByLabelText('Footnote 2 label'), 'note-b')
    await user.type(
      screen.getByLabelText('Footnote 2 text'),
      'Second footnote text'
    )

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(updateAnalysisProfile).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          coa_basis_note: 'Per USP <232> limits',
          coa_method_text: 'ICP-MS',
          coa_prep_text: 'Microwave digestion',
          coa_footnotes: [
            { label: 'note-a', text: 'First footnote text' },
            { label: 'note-b', text: 'Second footnote text' },
          ],
        })
      )
    })
  })

  it('clearing basis/method/prep and removing all footnotes sends nulls', async () => {
    const populated: AnalysisProfile = {
      ...PROFILE,
      coa_basis_note: 'Old basis',
      coa_method_text: 'Old method',
      coa_prep_text: 'Old prep',
      coa_footnotes: [{ label: 'x', text: 'y' }],
    }
    vi.mocked(getAnalysisProfiles).mockResolvedValue([populated])
    vi.mocked(updateAnalysisProfile).mockResolvedValue(populated)

    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    const row = await screen.findByText('Heavy Metals')
    await user.click(row)

    const basisInput = await screen.findByLabelText('Basis Note')
    expect(basisInput).toHaveValue('Old basis')
    await user.clear(basisInput)
    await user.clear(screen.getByLabelText('Method'))
    await user.clear(screen.getByLabelText('Prep'))

    // One hydrated footnote row — remove it.
    await user.click(screen.getByRole('button', { name: /remove footnote 1/i }))

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(updateAnalysisProfile).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          coa_basis_note: null,
          coa_method_text: null,
          coa_prep_text: null,
          coa_footnotes: null,
        })
      )
    })
  })

  it('drops a fully-blank footnote row but keeps a half-filled row', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    const row = await screen.findByText('Heavy Metals')
    await user.click(row)

    // Row 1: fully blank — added then left untouched.
    await user.click(screen.getByRole('button', { name: /add footnote/i }))

    // Row 2: label only, text blank — must survive (backend surfaces the 400).
    await user.click(screen.getByRole('button', { name: /add footnote/i }))
    await user.type(screen.getByLabelText('Footnote 2 label'), 'only-label')

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(updateAnalysisProfile).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          coa_footnotes: [{ label: 'only-label', text: '' }],
        })
      )
    })
  })

  it('reordering footnotes with the up/down buttons changes save order', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    const row = await screen.findByText('Heavy Metals')
    await user.click(row)

    await user.click(screen.getByRole('button', { name: /add footnote/i }))
    await user.type(screen.getByLabelText('Footnote 1 label'), 'first')
    await user.type(screen.getByLabelText('Footnote 1 text'), 'first-text')

    await user.click(screen.getByRole('button', { name: /add footnote/i }))
    await user.type(screen.getByLabelText('Footnote 2 label'), 'second')
    await user.type(screen.getByLabelText('Footnote 2 text'), 'second-text')

    await user.click(
      screen.getByRole('button', { name: /move footnote 2 up/i })
    )

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(updateAnalysisProfile).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          coa_footnotes: [
            { label: 'second', text: 'second-text' },
            { label: 'first', text: 'first-text' },
          ],
        })
      )
    })
  })

  it('also renders the basis/method/prep/footnote fields on the create panel and Create Profile sends them', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    await screen.findByText('Heavy Metals')
    await user.click(screen.getByRole('button', { name: /add profile/i }))

    await user.type(
      await screen.findByPlaceholderText('e.g. bpc157-core'),
      'zzauto'
    )
    await user.type(
      screen.getByPlaceholderText('e.g. BPC-157 Core Panel'),
      'ZZ Auto'
    )
    await user.click(screen.getByRole('radio', { name: 'Primary test' }))

    await user.type(screen.getByLabelText('Basis Note'), 'Basis on create')

    await user.click(screen.getByRole('button', { name: 'Create Profile' }))

    await waitFor(() => {
      expect(createAnalysisProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          coa_basis_note: 'Basis on create',
          coa_method_text: null,
          coa_prep_text: null,
          coa_footnotes: null,
        })
      )
    })
  })
})
