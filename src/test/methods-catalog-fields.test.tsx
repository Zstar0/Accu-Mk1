import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { HplcMethod, MethodServiceLink } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getMethods: vi.fn(),
    createMethod: vi.fn(),
    deleteMethod: vi.fn(),
    updateMethod: vi.fn(),
    getInstruments: vi.fn(),
    getDepartments: vi.fn(),
    getAnalysisServices: vi.fn(),
    getMethodServices: vi.fn(),
    putMethodServices: vi.fn(),
    getMethodAttachments: vi.fn(),
    getPeptides: vi.fn(),
    updatePeptide: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import {
  getMethods,
  createMethod,
  deleteMethod,
  updateMethod,
  getInstruments,
  getDepartments,
  getAnalysisServices,
  getMethodServices,
  putMethodServices,
  getMethodAttachments,
  getPeptides,
  updatePeptide,
} from '@/lib/api'
import { MethodsPage } from '@/components/hplc/MethodsPage'

const METHOD: HplcMethod = {
  id: 1,
  name: 'Elemental Impurities by ICP-MS',
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
  reference: null,
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

describe('MethodsPage / MethodPanel — catalog fields + covered services', () => {
  beforeEach(() => {
    vi.mocked(getMethods).mockReset().mockResolvedValue([METHOD])
    vi.mocked(createMethod).mockReset().mockResolvedValue(METHOD)
    vi.mocked(deleteMethod).mockReset().mockResolvedValue(undefined)
    vi.mocked(updateMethod).mockReset().mockResolvedValue(METHOD)
    vi.mocked(getInstruments).mockReset().mockResolvedValue([])
    vi.mocked(getDepartments).mockReset().mockResolvedValue([])
    vi.mocked(getAnalysisServices).mockReset().mockResolvedValue([])
    vi.mocked(getMethodServices).mockReset().mockResolvedValue([])
    vi.mocked(putMethodServices).mockReset().mockResolvedValue([])
    vi.mocked(getMethodAttachments).mockReset().mockResolvedValue([])
    vi.mocked(getPeptides).mockReset().mockResolvedValue([])
    vi.mocked(updatePeptide)
      .mockReset()
      .mockResolvedValue({} as never)
  })

  it('create form offers code/technique/department and no senaite id', async () => {
    const user = userEvent.setup()
    render(<MethodsPage />)
    await user.click(await screen.findByRole('button', { name: /new method/i }))
    expect(screen.getByLabelText(/code/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/technique/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/department/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/senaite id/i)).not.toBeInTheDocument()
  })

  it('method panel manages covered services with a default toggle', async () => {
    const link: MethodServiceLink = {
      analysis_service_id: 5,
      keyword: 'LEAD-PPM',
      title: 'Lead',
      is_default: true,
    }
    vi.mocked(getMethodServices).mockResolvedValue([link])
    const user = userEvent.setup()
    render(<MethodsPage />)
    await user.click(await screen.findByText('Elemental Impurities by ICP-MS'))
    expect(await screen.findByText(/covered services/i)).toBeInTheDocument()
    expect(screen.getByText('LEAD-PPM')).toBeInTheDocument()
    expect(screen.getByText(/default/i)).toBeInTheDocument()
  })

  it('fix round 1: a covered-services mutation refreshes the parent methods list (onUpdated wiring)', async () => {
    const link: MethodServiceLink = {
      analysis_service_id: 5,
      keyword: 'LEAD-PPM',
      title: 'Lead',
      is_default: true,
    }
    vi.mocked(getMethodServices).mockResolvedValue([link])
    vi.mocked(putMethodServices).mockResolvedValue([
      { ...link, is_default: false },
    ])
    const user = userEvent.setup()
    render(<MethodsPage />)
    await user.click(await screen.findByText('Elemental Impurities by ICP-MS'))
    await screen.findByText('LEAD-PPM')

    const getMethodsCallsBefore = vi.mocked(getMethods).mock.calls.length

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    // Toggle the row's "Default" checkbox — scoped to the LEAD-PPM row so it
    // doesn't collide with the table's bulk-select checkboxes rendered
    // underneath the slide-out panel.
    const row = screen.getByText('LEAD-PPM').parentElement as HTMLElement
    await user.click(within(row).getByRole('checkbox'))

    await waitFor(() => {
      expect(putMethodServices).toHaveBeenCalled()
    })
    // The parent's methods list must be refetched after the mutation
    // (onUpdated -> load()) so table rows carrying stale `services` don't
    // linger — not just the panel's own local `services` state.
    await waitFor(() => {
      expect(vi.mocked(getMethods).mock.calls.length).toBeGreaterThan(
        getMethodsCallsBefore
      )
    })
  })

  it('create form links covered services: POST then PUT with the new id', async () => {
    vi.mocked(getAnalysisServices).mockResolvedValue([
      {
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
        default_method_id: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ])
    const user = userEvent.setup()
    render(<MethodsPage />)
    await user.click(await screen.findByRole('button', { name: /new method/i }))

    await user.type(screen.getByPlaceholderText('Method 1'), 'MP-AES Elemental')
    const picker = await screen.findByRole('combobox', { name: /add service/i })
    await user.selectOptions(picker, '5')

    // Chip appears; mark it as the service's default
    const chip = screen.getByText('LEAD-PPM').parentElement as HTMLElement
    await user.click(within(chip).getByRole('checkbox'))

    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(createMethod).toHaveBeenCalled()
    })
    // Links ride a chained PUT against the id the POST returned
    await waitFor(() => {
      expect(putMethodServices).toHaveBeenCalledWith(METHOD.id, [
        { analysis_service_id: 5, is_default: true },
      ])
    })
  })

  it('create form without services never calls the services endpoint', async () => {
    const user = userEvent.setup()
    render(<MethodsPage />)
    await user.click(await screen.findByRole('button', { name: /new method/i }))
    await user.type(screen.getByPlaceholderText('Method 1'), 'Plain Method')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => {
      expect(createMethod).toHaveBeenCalled()
    })
    expect(putMethodServices).not.toHaveBeenCalled()
  })
})
