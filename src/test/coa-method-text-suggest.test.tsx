import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { AnalysisProfile, AnalysisServiceRecord, Department, HplcMethod } from '@/lib/api'
import type * as ApiModule from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    getAnalysisProfiles: vi.fn(),
    getAnalysisProfileMembers: vi.fn(),
    getAnalysisServices: vi.fn(),
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
  member_ids: [5],
  member_service_ids: [5],
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

const LEAD_SERVICE: AnalysisServiceRecord = {
  id: 5,
  title: 'Lead',
  keyword: 'LEAD-PPM',
  category: null,
  unit: null,
  methods: null,
  peptide_name: null,
  peptide_id: null,
  senaite_id: null,
  senaite_uid: null,
  active: true,
  origin: 'mk1',
  local_overrides: null,
  department_id: null,
  default_method_id: 11,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const ICP_METHOD: HplcMethod = {
  id: 11,
  name: 'ICP-MS',
  senaite_id: null,
  instrument_ids: [],
  instruments: [],
  size_peptide: null,
  starting_organic_pct: null,
  temperature_mct_c: null,
  dissolution: null,
  notes: null,
  code: 'AM-ELEM-001',
  technique: 'ICP-MS',
  department_id: null,
  reference: 'USP <232>/<233>',
  procedure_summary: null,
  supersedes_id: null,
  origin: 'mk1',
  active: true,
  status: 'active',
  revision: 1,
  activated_at: null,
  retired_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  common_peptides: [],
  services: [],
}

describe('AnalysisProfilesPage — suggest COA method text from methods', () => {
  beforeEach(() => {
    vi.mocked(getAnalysisProfiles).mockReset().mockResolvedValue([PROFILE])
    vi.mocked(getAnalysisProfileMembers).mockReset().mockResolvedValue([5])
    vi.mocked(getAnalysisServices).mockReset().mockResolvedValue([LEAD_SERVICE])
    vi.mocked(getMethods).mockReset().mockResolvedValue([ICP_METHOD])
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

  it('suggest fills coa_method_text from member default methods, never automatically', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })
    await user.click(await screen.findByText('Heavy Metals'))
    const field = await screen.findByLabelText(/^method$/i)
    expect(field).toHaveValue('')                            // never auto-filled
    await user.click(screen.getByRole('button', { name: /suggest from methods/i }))
    expect(field).toHaveValue('AM-ELEM-001 — ICP-MS per USP <232>/<233>')
  })

  it('suggest disabled when no member default resolves', async () => {
    vi.mocked(getAnalysisServices).mockResolvedValue(
      [{ id: 5, keyword: 'LEAD-PPM', title: 'Lead', default_method_id: null }] as never)
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })
    await user.click(await screen.findByText('Heavy Metals'))
    expect(await screen.findByRole('button', { name: /suggest from methods/i })).toBeDisabled()
  })

  it('suggest replaces existing text on click rather than appending', async () => {
    const populated: AnalysisProfile = { ...PROFILE, coa_method_text: 'Old method text' }
    vi.mocked(getAnalysisProfiles).mockResolvedValue([populated])

    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })
    await user.click(await screen.findByText('Heavy Metals'))
    const field = await screen.findByLabelText(/^method$/i)
    expect(field).toHaveValue('Old method text')

    await user.click(await screen.findByRole('button', { name: /suggest from methods/i }))
    expect(field).toHaveValue('AM-ELEM-001 — ICP-MS per USP <232>/<233>')
  })
})
