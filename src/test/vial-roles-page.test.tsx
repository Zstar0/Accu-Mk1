import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { VialRoleRow, Department } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getVialRoles: vi.fn(),
    createVialRole: vi.fn(),
    updateVialRole: vi.fn(),
    deleteVialRole: vi.fn(),
    getDepartments: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import {
  getVialRoles,
  createVialRole,
  updateVialRole,
  deleteVialRole,
  getDepartments,
} from '@/lib/api'
import { toast } from 'sonner'
import VialRolesPage from '@/components/hplc/VialRolesPage'

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
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

const HPLC_ROLE: VialRoleRow = {
  id: 1,
  code: 'hplc',
  label: 'HPLC',
  department_id: 1,
  boxable: true,
  variance_eligible: true,
  sort_order: 0,
  frozen: true,
  is_system: true,
}

const TOX_ROLE: VialRoleRow = {
  id: 2,
  code: 'tox',
  label: 'Toxicology',
  department_id: 1,
  boxable: false,
  variance_eligible: false,
  sort_order: 1,
  frozen: false,
  is_system: false,
  color: 'blue',
  short_label: 'TOX',
  badge_glyph: 'T',
}

describe('VialRolesPage', () => {
  beforeEach(() => {
    vi.mocked(getVialRoles).mockReset().mockResolvedValue([HPLC_ROLE, TOX_ROLE])
    vi.mocked(getDepartments).mockReset().mockResolvedValue([DEPT])
    vi.mocked(createVialRole).mockReset().mockResolvedValue({
      id: 3,
      code: 'new',
      label: 'New Role',
      department_id: 1,
      boxable: false,
      variance_eligible: false,
      sort_order: 0,
      frozen: false,
      is_system: false,
    })
    vi.mocked(updateVialRole).mockReset().mockResolvedValue(TOX_ROLE)
    vi.mocked(deleteVialRole).mockReset().mockResolvedValue(undefined)
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.success).mockClear()
  })

  it('renders rows from a mocked getVialRoles', async () => {
    render(<VialRolesPage />, { wrapper })

    expect(await screen.findByText('HPLC')).toBeInTheDocument()
    expect(screen.getByText('Toxicology')).toBeInTheDocument()
    expect(screen.getByText('hplc')).toBeInTheDocument()
    expect(screen.getByText('tox')).toBeInTheDocument()
  })

  it('create panel POSTs the expected payload, defaulting department to the first loaded department', async () => {
    const user = userEvent.setup()
    render(<VialRolesPage />, { wrapper })

    await screen.findByText('HPLC')
    await user.click(screen.getByRole('button', { name: /add role/i }))

    const codeInput = await screen.findByPlaceholderText('e.g. tox')
    await user.type(codeInput, 'new')
    const labelInput = screen.getByPlaceholderText('e.g. Toxicology')
    await user.type(labelInput, 'New Role')

    await user.click(screen.getByRole('button', { name: 'Create Role' }))

    await waitFor(() => {
      expect(createVialRole).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'new', label: 'New Role', department_id: 1 })
      )
    })
  })

  it("disables delete for a system row but not for an ordinary one", async () => {
    render(<VialRolesPage />, { wrapper })

    await screen.findByText('HPLC')
    expect(screen.getByRole('button', { name: 'Delete hplc' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete tox' })).not.toBeDisabled()
  })

  it('edit panel populates the form from the stored display faces (openEdit round-trip)', async () => {
    const user = userEvent.setup()
    render(<VialRolesPage />, { wrapper })

    await screen.findByText('HPLC')
    await user.click(screen.getByText('Toxicology'))

    await screen.findByDisplayValue('TOX')
    expect(screen.getByDisplayValue('T')).toBeInTheDocument()
    // TOX_ROLE.color is 'blue' — the Blue swatch must come in pre-selected,
    // not "Auto" (would also produce a passing color:null PATCH test if
    // openEdit silently dropped the field).
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(updateVialRole).toHaveBeenCalledWith(
        2,
        expect.objectContaining({ color: 'blue', short_label: 'TOX', badge_glyph: 'T' })
      )
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('edit panel PATCHes color/short_label/badge_glyph for the edited role', async () => {
    const user = userEvent.setup()
    render(<VialRolesPage />, { wrapper })

    await screen.findByText('HPLC')
    await user.click(screen.getByText('Toxicology'))

    const shortLabelInput = await screen.findByDisplayValue('TOX')
    await user.clear(shortLabelInput)
    await user.type(shortLabelInput, 'TX')

    const glyphInput = screen.getByDisplayValue('T')
    await user.clear(glyphInput)
    await user.type(glyphInput, 'X')

    await user.click(screen.getByRole('button', { name: 'Amber' }))
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(updateVialRole).toHaveBeenCalledWith(
        2,
        expect.objectContaining({ color: 'amber', short_label: 'TX', badge_glyph: 'X' })
      )
    })
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalled()
  })

  it('the "Auto (department)" swatch sends color: null', async () => {
    const user = userEvent.setup()
    render(<VialRolesPage />, { wrapper })

    await screen.findByText('HPLC')
    await user.click(screen.getByText('Toxicology'))

    await screen.findByDisplayValue('TOX')
    await user.click(screen.getByRole('button', { name: 'Auto (department)' }))
    await user.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(updateVialRole).toHaveBeenCalledWith(
        2,
        expect.objectContaining({ color: null })
      )
    })
    expect(toast.error).not.toHaveBeenCalled()
  })
})
