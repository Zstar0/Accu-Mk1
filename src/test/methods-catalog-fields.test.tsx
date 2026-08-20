import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
