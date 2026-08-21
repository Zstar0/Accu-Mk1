import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { AnalysisProfile, VialRoleRow, Department } from '@/lib/api'
import { suggestRoleCode } from '@/lib/role-code'

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
  createAnalysisProfile,
  updateAnalysisProfile,
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

const HM_ROLE: VialRoleRow = {
  id: 1,
  code: 'hm',
  label: 'Heavy Metals',
  department_id: 1,
  boxable: false,
  variance_eligible: false,
  sort_order: 0,
  frozen: false,
  is_system: false,
}

describe('AnalysisProfilesPage — fulfillment fields', () => {
  beforeEach(() => {
    vi.mocked(getAnalysisProfiles).mockReset().mockResolvedValue([PROFILE])
    vi.mocked(getAnalysisProfileMembers).mockReset().mockResolvedValue([])
    vi.mocked(getAnalysisServices).mockReset().mockResolvedValue([])
    vi.mocked(createAnalysisProfile).mockReset().mockResolvedValue({ ...PROFILE, id: 99 })
    vi.mocked(updateAnalysisProfile).mockReset().mockResolvedValue({ ...PROFILE, fulfillment_role: 'hm' })
    vi.mocked(getRideHosts).mockReset().mockResolvedValue([])
    vi.mocked(putRideHosts).mockReset().mockResolvedValue({ count: 0 })
    vi.mocked(getVialRoles).mockReset().mockResolvedValue([])
    vi.mocked(getDepartments).mockReset().mockResolvedValue([DEPT])
    vi.mocked(getSlaTiers).mockReset().mockResolvedValue([])
    vi.mocked(toast.error).mockClear()
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

  it('Task 11: selecting an SLA tier in the edit panel includes sla_tier_id in the PATCH payload', async () => {
    vi.mocked(getSlaTiers).mockResolvedValue([
      {
        id: 5, name: 'Rush 4h', target_minutes: 240, business_hours_only: false,
        is_default: false, amber_threshold_percent: 20,
        created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
      },
    ])
    render(<AnalysisProfilesPage />, { wrapper })

    const row = await screen.findByText('Heavy Metals')
    fireEvent.click(row)

    // Starts on "— inherit group SLA —" (PROFILE.sla_tier_id is null).
    const trigger = await screen.findByText('— inherit group SLA —')
    fireEvent.click(trigger)
    const option = await screen.findByRole('option', { name: 'Rush 4h' })
    fireEvent.click(option)

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(updateAnalysisProfile).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ sla_tier_id: 5 })
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

  it('shows an inline error and blocks Save when fulfillment_role is malformed', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    const row = await screen.findByText('Heavy Metals')
    await user.click(row)

    const roleInput = await screen.findByPlaceholderText('e.g. hm')
    // Backend regex is [a-z][a-z0-9_]{0,7} — leading digit is invalid.
    await user.type(roleInput, '1bad')

    expect(await screen.findByText(/lowercase/i)).toBeInTheDocument()

    // Save stays clickable (a stored-but-untouched malformed role on an
    // existing profile must not strand every other field behind it) — the
    // guard lives in handleSave and rejects via the same toast idiom as the
    // page's other required-field checks, not a disabled button.
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/lowercase/i))
    expect(updateAnalysisProfile).not.toHaveBeenCalled()
  })

  it('lowercases typed input so uppercase role codes save fine', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    const row = await screen.findByText('Heavy Metals')
    await user.click(row)

    const roleInput = await screen.findByPlaceholderText('e.g. hm')
    await user.type(roleInput, 'HM')

    expect(roleInput).toHaveValue('hm')
    expect(screen.queryByText(/lowercase/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(updateAnalysisProfile).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ fulfillment_role: 'hm', fulfillment_dim: 'role' })
      )
    })
  })

  // ── Auto-mint UX (Task 3) ──

  it('shows "Uses existing role" when the typed code matches the vial-roles catalog', async () => {
    vi.mocked(getVialRoles).mockResolvedValue([HM_ROLE])
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    const row = await screen.findByText('Heavy Metals')
    await user.click(row)

    const roleInput = await screen.findByPlaceholderText('e.g. hm')
    await user.type(roleInput, 'hm')

    expect(await screen.findByText(/Uses existing role .hm. — Heavy Metals/)).toBeInTheDocument()
    expect(screen.queryByText(/Will create role/)).not.toBeInTheDocument()
  })

  it('shows "Will create role" with a department select when the typed code is unknown, and saves the chosen department', async () => {
    vi.mocked(getVialRoles).mockResolvedValue([]) // no code matches
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    const row = await screen.findByText('Heavy Metals')
    await user.click(row)

    const roleInput = await screen.findByPlaceholderText('e.g. hm')
    await user.type(roleInput, 'newrole')

    expect(await screen.findByText(/Will create role .newrole./)).toBeInTheDocument()
    expect(screen.queryByText(/Uses existing role/)).not.toBeInTheDocument()

    // Radix Select doesn't fire change from userEvent's full pointer-event
    // sequence under jsdom (hasPointerCapture isn't implemented there) —
    // fireEvent.click sidesteps it, same workaround as sla-pane.test.tsx.
    fireEvent.click(screen.getByRole('combobox', { name: 'Role department' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Analytical' }))

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(updateAnalysisProfile).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          fulfillment_role: 'newrole',
          fulfillment_dim: 'role',
          role_department_id: 1,
        })
      )
    })
  })

  it('offers the suggested code on the CREATE panel when the role is left blank, and Save sends it', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    await screen.findByText('Heavy Metals')
    await user.click(screen.getByRole('button', { name: /add profile/i }))

    await user.type(await screen.findByPlaceholderText('e.g. bpc157-core'), 'zzauto')
    await user.type(screen.getByPlaceholderText('e.g. BPC-157 Core Panel'), 'ZZ Auto')
    await user.click(screen.getByRole('radio', { name: 'Primary test' }))

    // role input intentionally left blank; dim defaults to 'role'
    expect(await screen.findByText(/Leave blank to auto-create .zzauto./)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create Profile' }))

    await waitFor(() => {
      expect(createAnalysisProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'zzauto',
          fulfillment_role: 'zzauto',
          fulfillment_dim: 'role',
          role_department_id: null,
        })
      )
    })
  })

  it('does not offer the auto-create hint on EDIT, and Save leaves an existing blank role alone (Core/AccuShield safety)', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    // PROFILE fixture: fulfillment_dim 'role', fulfillment_role null — the
    // same shape as the real seeded Core/AccuShield profiles.
    const row = await screen.findByText('Heavy Metals')
    await user.click(row)
    await screen.findByPlaceholderText('e.g. hm')

    expect(screen.queryByText(/Leave blank to auto-create/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(updateAnalysisProfile).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ fulfillment_role: null, fulfillment_dim: 'role' })
      )
    })
  })

  it('invalidates both analysis-profiles and vial-roles queries after a save', async () => {
    const user = userEvent.setup()
    render(<AnalysisProfilesPage />, { wrapper })

    const row = await screen.findByText('Heavy Metals')
    await user.click(row)
    const roleInput = await screen.findByPlaceholderText('e.g. hm')
    await user.type(roleInput, 'hm')
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    // getVialRoles is the query function behind vialRolesQueryKeys — a
    // second call after the initial mount-time fetch proves the cache was
    // invalidated (react-query only refetches an active query on
    // invalidation), independent of any assertion on the profiles side.
    await waitFor(() => {
      expect(vi.mocked(getVialRoles).mock.calls.length).toBeGreaterThan(1)
    })
  })
})

describe('suggestRoleCode', () => {
  it('lowercases and passes through a simple alphanumeric key unchanged', () => {
    expect(suggestRoleCode('zzauto', new Set())).toBe('zzauto')
    expect(suggestRoleCode('ZZAUTO', new Set())).toBe('zzauto')
  })

  it('replaces non [a-z0-9_] characters with underscores and strips leading/trailing underscores', () => {
    expect(suggestRoleCode('bpc157-core', new Set())).toBe('bpc157_c')
    expect(suggestRoleCode('  spaced out  ', new Set())).toBe('spaced_o')
  })

  it('prefixes with "r" when the sanitized base does not start with a letter', () => {
    expect(suggestRoleCode('157purity', new Set())).toBe('r157puri')
  })

  it('falls back to "role" when the key sanitizes to nothing', () => {
    expect(suggestRoleCode('---', new Set())).toBe('role')
  })

  it('truncates to 8 characters (assignment_role is VARCHAR(8))', () => {
    expect(suggestRoleCode('a_very_long_profile_key', new Set())).toBe('a_very_l')
  })

  it('uniquifies against the existing set with a numeric suffix', () => {
    const existing = new Set(['zzauto'])
    expect(suggestRoleCode('zzauto', existing)).toBe('zzauto2')
  })

  it('uniquifies by truncating the base to make room for a longer suffix', () => {
    const existing = new Set(['a_very_l', 'a_very_2'])
    expect(suggestRoleCode('a_very_long_profile_key', existing)).toBe('a_very_3')
  })
})
