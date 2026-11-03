import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type {
  AnalysisProfile,
  AnalysisServiceRecord,
  AnalysisServiceSpecRecord,
  Department,
} from '@/lib/api'
import type * as ApiModule from '@/lib/api'
import type { ProfileCoaVariant } from '@/lib/api-profile-coa-variants'
import type { SampleForm } from '@/lib/api-sample-forms'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    getAnalysisProfiles: vi.fn(),
    getAnalysisProfileMembers: vi.fn(),
    getAnalysisServices: vi.fn(),
    getMethods: vi.fn(),
    updateAnalysisProfile: vi.fn(),
    setAnalysisProfileMembers: vi.fn(),
    getRideHosts: vi.fn(),
    getVialRoles: vi.fn(),
    getDepartments: vi.fn(),
    getSlaTiers: vi.fn(),
    listServiceSpecs: vi.fn(),
  }
})

vi.mock('@/lib/api-profile-coa-variants', () => ({
  listProfileCoaVariants: vi.fn(),
  createProfileCoaVariant: vi.fn(),
  patchProfileCoaVariant: vi.fn(),
}))

vi.mock('@/lib/api-sample-forms', async importOriginal => ({
  ...(await importOriginal<object>()),
  listSampleForms: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import {
  getAnalysisProfiles,
  getAnalysisProfileMembers,
  getAnalysisServices,
  getMethods,
  updateAnalysisProfile,
  setAnalysisProfileMembers,
  getRideHosts,
  getVialRoles,
  getDepartments,
  getSlaTiers,
  listServiceSpecs,
} from '@/lib/api'
import { listProfileCoaVariants } from '@/lib/api-profile-coa-variants'
import { listSampleForms } from '@/lib/api-sample-forms'
import AnalysisProfilesPage from '@/components/hplc/AnalysisProfilesPage'
import {
  COA_FIELD_ROWS,
  UNSAVED_VERSION_PROMPT,
} from '@/components/hplc/coa-variant-logic'

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

const NASAL_FORM: SampleForm = {
  id: 4,
  name: 'Nasal Spray',
  route: 'nasal_inhaled',
  is_default: false,
  active: true,
  sort_order: 4,
  icon: null,
  sample_count: 0,
}

const NASAL_VERSION: ProfileCoaVariant = {
  id: 11,
  analysis_profile_id: 1,
  sample_form_id: NASAL_FORM.id,
  sample_form_name: 'Nasal Spray',
  coa_section_title: null,
  coa_basis_note: 'Nasal basis',
  coa_method_text: null,
  coa_prep_text: 'Diluted',
  coa_footnotes: null,
  active: true,
  updated_at: null,
}

const ARSENIC = {
  id: 1,
  title: 'Arsenic',
  keyword: null,
} as AnalysisServiceRecord
const LEAD = { id: 2, title: 'Lead', keyword: null } as AnalysisServiceRecord
const ARSENIC_NASAL_RULE = {
  id: 50,
  analysis_service_id: ARSENIC.id,
  sample_form_id: NASAL_FORM.id,
  peptide_id: null,
  rule_kind: 'range',
} as AnalysisServiceSpecRecord

let user: UserEvent

async function openProfile() {
  render(<AnalysisProfilesPage />, { wrapper })
  await user.click(await screen.findByText('Heavy Metals'))
  // The guard line reads the members, which load after the panel opens.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Save Members/ })).toBeEnabled()
  )
}

async function openCreate() {
  render(<AnalysisProfilesPage />, { wrapper })
  await screen.findByText('Heavy Metals')
  await user.click(screen.getByRole('button', { name: /add profile/i }))
}

/** Opens the Nasal Spray card if it is closed. */
async function pick(label: string, choice: string) {
  const card = await screen.findByTestId(`coa-variant-card-${NASAL_FORM.id}`)
  const edit = within(card).queryByRole('button', { name: 'Edit' })
  if (edit) await user.click(edit)
  await user.click(screen.getByRole('radio', { name: `${label}: ${choice}` }))
}

const dirtyTheCard = () => pick('Sample prep', 'Leave off')

const closeButton = () => screen.getByRole('button', { name: 'Close panel' })

const confirmReturns = (answer: boolean) =>
  vi.mocked(window.confirm).mockReturnValue(answer)

function row(label: string) {
  const field = COA_FIELD_ROWS.find(r => r.label === label)?.field
  return screen.getByTestId(`coa-variant-row-${field}`)
}

/** Adds through the Members search and does not save. */
async function addMember(name: string) {
  await user.type(
    screen.getByPlaceholderText('Filter services to add...'),
    name
  )
  await user.click(screen.getByRole('button', { name }))
}

describe('AnalysisProfilesPage: COA text versions', () => {
  beforeEach(() => {
    user = userEvent.setup()
    vi.mocked(getAnalysisProfiles).mockReset().mockResolvedValue([PROFILE])
    vi.mocked(getAnalysisProfileMembers)
      .mockReset()
      .mockResolvedValue([ARSENIC.id])
    vi.mocked(getAnalysisServices)
      .mockReset()
      .mockResolvedValue([ARSENIC, LEAD])
    vi.mocked(getMethods).mockReset().mockResolvedValue([])
    vi.mocked(updateAnalysisProfile).mockReset().mockResolvedValue(PROFILE)
    vi.mocked(setAnalysisProfileMembers)
      .mockReset()
      .mockResolvedValue({ count: 2 })
    vi.mocked(getRideHosts).mockReset().mockResolvedValue([])
    vi.mocked(getVialRoles).mockReset().mockResolvedValue([])
    vi.mocked(getDepartments).mockReset().mockResolvedValue([DEPT])
    vi.mocked(getSlaTiers).mockReset().mockResolvedValue([])
    vi.mocked(listServiceSpecs)
      .mockReset()
      .mockImplementation(async id =>
        id === ARSENIC.id ? [ARSENIC_NASAL_RULE] : []
      )
    vi.mocked(listProfileCoaVariants)
      .mockReset()
      .mockResolvedValue([NASAL_VERSION])
    vi.mocked(listSampleForms).mockReset().mockResolvedValue([NASAL_FORM])
    vi.spyOn(window, 'confirm').mockReset().mockReturnValue(true)
  })

  it('heads the block Default text, with one line per form that overrides something', async () => {
    await openProfile()
    expect(
      await screen.findByRole('heading', { name: 'Default text' })
    ).toBeVisible()
    expect(
      await screen.findByText('Nasal Spray overrides basis note and prep')
    ).toBeVisible()
  })

  it('shows the section between Save Changes and Members, in edit mode only', async () => {
    await openProfile()
    const section = await screen.findByRole('heading', {
      name: 'COA text by sample form',
    })
    const save = screen.getByRole('button', { name: 'Save Changes' })
    const members = screen.getByRole('heading', { name: 'Members' })
    expect(
      save.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      section.compareDocumentPosition(members) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('is absent on the create panel', async () => {
    await openCreate()
    expect(
      screen.queryByRole('heading', { name: 'COA text by sample form' })
    ).toBeNull()
  })

  it('closing with unsaved version edits asks; cancelling keeps the panel and the edits', async () => {
    await openProfile()
    await dirtyTheCard()
    confirmReturns(false)
    await user.click(closeButton())
    expect(window.confirm).toHaveBeenCalledWith(UNSAVED_VERSION_PROMPT)
    expect(screen.getByText('Edit: Heavy Metals')).toBeVisible()
    expect(screen.getByText('Unsaved')).toBeVisible()
  })

  it('closing with no unsaved edits does not ask', async () => {
    await openProfile()
    await user.click(closeButton())
    expect(window.confirm).not.toHaveBeenCalled()
    expect(screen.queryByText('Edit: Heavy Metals')).toBeNull()
  })

  it('leaving with the prompt accepted does not make the next panel ask', async () => {
    await openProfile()
    await dirtyTheCard()
    await user.click(closeButton())
    expect(screen.queryByText('Edit: Heavy Metals')).toBeNull()
    vi.mocked(window.confirm).mockClear()
    await user.click(screen.getByRole('button', { name: /add profile/i }))
    await user.click(closeButton())
    expect(window.confirm).not.toHaveBeenCalled()
    expect(screen.queryByText('New Analysis Profile')).toBeNull()
  })

  it('after Save Changes with the prompt cancelled, the cards show the new Default', async () => {
    vi.mocked(updateAnalysisProfile).mockResolvedValue({
      ...PROFILE,
      coa_method_text: 'New method',
    })
    await openProfile()
    await dirtyTheCard()
    confirmReturns(false)
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(screen.getByText('Edit: Heavy Metals')).toBeVisible()
    expect(within(row('Method')).getByText('New method')).toBeVisible()
  })

  it('an unsaved Members edit does not change the guard line; Save Members does', async () => {
    // Saved member: Arsenic, which has a rule. Lead has none.
    await openProfile()
    await pick('Basis note', 'Leave off')
    expect(
      await screen.findByText(/^The 1 service has a Nasal Spray rule/)
    ).toBeVisible()
    await addMember('Lead')
    expect(
      screen.getByText(/^The 1 service has a Nasal Spray rule/)
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: /Save Members/ }))
    expect(
      await screen.findByText(/^Lead has no Nasal Spray rule/)
    ).toBeVisible()
  })
})
