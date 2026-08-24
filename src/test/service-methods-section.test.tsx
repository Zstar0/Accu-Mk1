/** Service panel Methods section reads the method_services link table (via
 * getServiceMethods) instead of the legacy SENAITE `methods` JSON column —
 * which is empty forever on Mk1-native services and made every curated link
 * render as "0 methods". Same page harness as
 * analysis-services-guide-ui.test.tsx. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as ApiModule from '@/lib/api'

// Type-only import above is erased at compile time, so it's safe to reference
// inside the hoisted factory — unlike a value import.
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    getAnalysisServices: vi.fn(),
    getDepartments: vi.fn(),
    getPeptides: vi.fn(),
    getServiceMethods: vi.fn(),
    listServiceSpecs: vi.fn(),
  }
})

vi.mock('@/services/analysis-services', () => ({
  useCreateAnalysisService: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateAnalysisService: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteAnalysisService: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import {
  getAnalysisServices,
  getDepartments,
  getPeptides,
  getServiceMethods,
  listServiceSpecs,
  type AnalysisServiceRecord,
} from '@/lib/api'
import { AnalysisServicesPage } from '@/components/hplc/AnalysisServicesPage'

const lead: AnalysisServiceRecord = {
  id: 7,
  title: 'Lead',
  keyword: 'LEAD-PPM',
  category: 'Elemental',
  unit: 'µg/g',
  // Legacy SENAITE clone column — deliberately empty: native services never
  // get it populated, which is exactly the bug this section fix covers.
  methods: null,
  peptide_name: null,
  peptide_id: null,
  senaite_id: null,
  senaite_uid: null,
  active: true,
  variance_capable: false,
  origin: 'mk1',
  local_overrides: null,
  department_id: null,
  default_method_id: 3,
  linked_method_count: 2,
  created_at: '2026-08-24T00:00:00Z',
  updated_at: '2026-08-24T00:00:00Z',
}

beforeEach(() => {
  vi.mocked(getAnalysisServices).mockReset().mockResolvedValue([lead])
  vi.mocked(getDepartments).mockReset().mockResolvedValue([])
  vi.mocked(getPeptides).mockReset().mockResolvedValue([])
  vi.mocked(listServiceSpecs).mockReset().mockResolvedValue([])
  vi.mocked(getServiceMethods).mockReset().mockResolvedValue([
    {
      method_id: 3, name: 'MP-AES Standard Peptide Method', code: 'AM-ELEM-001',
      technique: 'MP-AES', revision: 1, status: 'active', is_default: true,
    },
    {
      method_id: 9, name: 'Legacy Digest Method', code: 'AM-ELEM-000',
      technique: 'ICP-MS', revision: 2, status: 'superseded', is_default: false,
    },
  ])
})

describe('AnalysisServicesPage — Methods from the link table', () => {
  it('list badge shows linked_method_count, not legacy methods.length', async () => {
    render(<AnalysisServicesPage />)
    const row = await screen.findByText('Lead')
    expect(row).toBeInTheDocument()
    // legacy `methods` is null (length 0) — the badge must say 2
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('panel section fetches getServiceMethods and renders links with badges', async () => {
    const user = userEvent.setup()
    render(<AnalysisServicesPage />)
    await user.click(await screen.findByText('Lead'))

    expect(await screen.findByText('MP-AES Standard Peptide Method')).toBeInTheDocument()
    expect(vi.mocked(getServiceMethods)).toHaveBeenCalledWith(7)
    expect(screen.getByText('Default')).toBeInTheDocument()
    expect(screen.getByText('superseded')).toBeInTheDocument()
    expect(screen.getByText('Methods (2)')).toBeInTheDocument()
    expect(screen.getByText(/AM-ELEM-001 · Rev 1 · MP-AES/)).toBeInTheDocument()
  })

  it('empty link set renders the how-to-link empty state', async () => {
    vi.mocked(getServiceMethods).mockResolvedValue([])
    const user = userEvent.setup()
    render(<AnalysisServicesPage />)
    await user.click(await screen.findByText('Lead'))

    expect(
      await screen.findByText(/No methods cover this service yet/i)
    ).toBeInTheDocument()
    expect(screen.getByText('Methods (0)')).toBeInTheDocument()
  })
})
