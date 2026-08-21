import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { AnalysisProfile, VialRoleRow, Department } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
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
    // Task 11: the page now also renders an SLA tier Select (useSlaTiers()).
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
  getRideHosts,
  putRideHosts,
  getVialRoles,
  getDepartments,
  getSlaTiers,
} from '@/lib/api'
import { toast } from 'sonner'
import AnalysisProfilesPage from '@/components/hplc/AnalysisProfilesPage'

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const PROFILE: AnalysisProfile = {
  id: 1,
  key: 't-fent',
  name: 'Fentanyl Rider',
  description: null,
  is_addon: true,
  vials_required: 1,
  fulfillment_role: 'tfent',
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

function role(code: string, label: string, extra: Partial<VialRoleRow> = {}): VialRoleRow {
  return {
    id: code.length,
    code,
    label,
    department_id: 1,
    boxable: false,
    variance_eligible: false,
    sort_order: 0,
    frozen: false,
    is_system: false,
    ...extra,
  }
}

const HPLC_ROLE = role('thplc', 'HPLC Family')
const ENDO_ROLE = role('endo', 'Endotoxin', { is_system: true })
const STER_ROLE = role('ster', 'Sterility', { is_system: true })
const XTRA_ROLE = role('xtra', 'Extras', { is_system: true, department_id: null })
const OWN_ROLE = role('tfent', 'Fentanyl Rider')

async function openEditPanel() {
  const user = userEvent.setup()
  render(<AnalysisProfilesPage />, { wrapper })
  const row = await screen.findByText('Fentanyl Rider')
  await user.click(row)
  return user
}

describe('AnalysisProfilesPage — ride hosts editor (spec 4)', () => {
  beforeEach(() => {
    vi.mocked(getAnalysisProfiles).mockReset().mockResolvedValue([PROFILE])
    vi.mocked(getAnalysisProfileMembers).mockReset().mockResolvedValue([])
    vi.mocked(getAnalysisServices).mockReset().mockResolvedValue([])
    vi.mocked(getMethods).mockReset().mockResolvedValue([])
    vi.mocked(getRideHosts).mockReset().mockResolvedValue([])
    vi.mocked(putRideHosts).mockReset().mockResolvedValue({ count: 0 })
    vi.mocked(getVialRoles).mockReset().mockResolvedValue(
      [HPLC_ROLE, ENDO_ROLE, STER_ROLE, XTRA_ROLE, OWN_ROLE]
    )
    vi.mocked(getDepartments).mockReset().mockResolvedValue([DEPT])
    vi.mocked(getSlaTiers).mockReset().mockResolvedValue([])
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.success).mockClear()
  })

  it('loads and renders existing ride hosts as ordered chips with role labels', async () => {
    vi.mocked(getRideHosts).mockResolvedValue(['thplc'])
    await openEditPanel()

    expect(await screen.findByText('thplc')).toBeInTheDocument()
    expect(screen.getByText('HPLC Family')).toBeInTheDocument()
    expect(getRideHosts).toHaveBeenCalledWith(1)
  })

  it('shows the empty-state copy when the profile has no ride hosts', async () => {
    await openEditPanel()
    expect(await screen.findByText('No ride hosts — mints its own vial')).toBeInTheDocument()
  })

  it('the add-select excludes endo, ster, xtra, and the profile\'s own role', async () => {
    const user = await openEditPanel()
    await screen.findByText('No ride hosts — mints its own vial')

    fireEvent.click(screen.getByRole('combobox', { name: 'Add ride host' }))

    expect(await screen.findByRole('option', { name: /thplc/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /endo/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /ster/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /xtra/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /tfent/ })).not.toBeInTheDocument()
    void user
  })

  it('adding a host from the select and saving PUTs the new list in order', async () => {
    await openEditPanel()
    await screen.findByText('No ride hosts — mints its own vial')

    fireEvent.click(screen.getByRole('combobox', { name: 'Add ride host' }))
    fireEvent.click(await screen.findByRole('option', { name: /thplc/ }))

    expect(await screen.findByText('thplc')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save Ride Hosts' }))

    await waitFor(() => {
      expect(putRideHosts).toHaveBeenCalledWith(1, ['thplc'])
    })
  })

  it('removing a chip drops it from the saved list', async () => {
    vi.mocked(getRideHosts).mockResolvedValue(['thplc'])
    await openEditPanel()
    await screen.findByText('thplc')

    fireEvent.click(screen.getByRole('button', { name: 'Remove thplc ride host' }))

    await waitFor(() => {
      expect(screen.getByText('No ride hosts — mints its own vial')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save Ride Hosts' }))
    await waitFor(() => {
      expect(putRideHosts).toHaveBeenCalledWith(1, [])
    })
  })

  it('reordering with the down/up buttons changes save priority order', async () => {
    const HPLC2_ROLE = role('thplc2', 'HPLC Family 2')
    vi.mocked(getVialRoles).mockResolvedValue(
      [HPLC_ROLE, HPLC2_ROLE, ENDO_ROLE, STER_ROLE, XTRA_ROLE, OWN_ROLE]
    )
    vi.mocked(getRideHosts).mockResolvedValue(['thplc', 'thplc2'])
    await openEditPanel()
    await screen.findByText('thplc')
    await screen.findByText('thplc2')

    // Move the second chip (thplc2) up one position, ahead of thplc.
    fireEvent.click(screen.getByRole('button', { name: 'Move thplc2 up' }))

    fireEvent.click(screen.getByRole('button', { name: 'Save Ride Hosts' }))
    await waitFor(() => {
      expect(putRideHosts).toHaveBeenCalledWith(1, ['thplc2', 'thplc'])
    })
  })

  it('surfaces the backend 400 text via toast on save failure', async () => {
    vi.mocked(getRideHosts).mockResolvedValue(['thplc'])
    vi.mocked(putRideHosts).mockRejectedValue(
      new Error("role 'endo' may not be a ride host (sensitive tests never share a vial)")
    )
    await openEditPanel()
    await screen.findByText('thplc')

    fireEvent.click(screen.getByRole('button', { name: 'Save Ride Hosts' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "role 'endo' may not be a ride host (sensitive tests never share a vial)"
      )
    })
  })

  it('does not render the ride hosts section on the create panel', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })
    await screen.findByText('Fentanyl Rider')
    await user.click(screen.getByRole('button', { name: /add profile/i }))

    expect(screen.queryByText('Ride Hosts')).not.toBeInTheDocument()
  })
})
