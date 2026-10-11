import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ServiceEndoJudgedPanel } from '@/components/hplc/ServiceEndoJudgedPanel'
import type * as ApiModule from '@/lib/api'
import {
  listServiceSpecs,
  type AnalysisServiceRecord,
  type AnalysisServiceSpecRecord,
  type ConsumableType,
  type HplcMethod,
} from '@/lib/api'
import { useUIStore } from '@/store/ui-store'

const spec = (
  over: Partial<AnalysisServiceSpecRecord>
): AnalysisServiceSpecRecord => ({
  id: 1,
  analysis_service_id: 61,
  matrix: 'Peptide',
  peptide_id: null,
  peptide_code: null,
  rule_kind: 'range',
  min_value: null,
  max_value: '5',
  equals_value: null,
  unit: 'EU/mL',
  display_override: null,
  loq: null,
  active: true,
  updated_at: null,
  ...over,
})

const cartridge: ConsumableType = {
  id: 3,
  kind: 'endo_cartridge',
  name: 'Endosafe 0.05',
  manufacturer: null,
  part_number: null,
  instrument_id: null,
  specs: { sensitivity_eu_ml: 0.05 },
  active: true,
  in_use: true,
}

const retired: ConsumableType = {
  ...cartridge,
  id: 4,
  name: 'Endosafe 0.01 (retired lot)',
  specs: { sensitivity_eu_ml: 0.01 },
  active: false,
}

// A type-only import is erased at compile time, so the hoisted factory may use it.
vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  listServiceSpecs: vi.fn(),
  getServiceMethods: vi.fn(),
  getMethods: vi.fn(),
  getMethodConsumables: vi.fn(),
  listConsumables: vi.fn(),
}))

async function mockApi() {
  const api = await import('@/lib/api')
  vi.mocked(api.listServiceSpecs).mockResolvedValue([
    spec({ id: 1 }),
    spec({
      id: 2,
      matrix: 'Bacteriostatic Water',
      max_value: '0.5',
      loq: '0.25',
    }),
  ])
  vi.mocked(api.getServiceMethods).mockResolvedValue([
    {
      method_id: 12,
      name: 'Endotoxin (LAL)',
      code: null,
      technique: 'LAL',
      revision: 2,
      status: 'active',
      is_default: true,
    },
  ])
  vi.mocked(api.getMethods).mockResolvedValue([
    {
      id: 12,
      name: 'Endotoxin (LAL)',
      revision: 2,
      status: 'active',
      run_parameters: { endotoxin: { cv_limit_pct: 20 } },
    } as HplcMethod,
  ])
  vi.mocked(api.getMethodConsumables).mockResolvedValue([
    { consumable_type_id: 3, kind: 'endo_cartridge', is_default: true },
  ])
  vi.mocked(api.listConsumables).mockResolvedValue([cartridge])
}

function renderPanel(service: Partial<AnalysisServiceRecord>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return render(
    <ServiceEndoJudgedPanel
      service={
        { id: 61, keyword: 'ENDO-LAL', ...service } as AnalysisServiceRecord
      }
    />,
    { wrapper: wrap }
  )
}

describe('ServiceEndoJudgedPanel', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await mockApi()
  })

  it('lists the spec tiers, the worksheet rules and the method with its cartridges', async () => {
    renderPanel({})
    expect(await screen.findByText('≤ 5 EU/mL')).toBeInTheDocument()
    expect(screen.getByText('Peptide')).toBeInTheDocument()
    expect(screen.getByText('Bacteriostatic Water')).toBeInTheDocument()
    expect(screen.getByText('0.25')).toBeInTheDocument()
    // the method's own CV limit, Dennis's recovery range
    expect(
      await screen.findByText(
        /spike recovery 50 to 200 % and both CVs at most 20 %/
      )
    ).toBeInTheDocument()
    expect(
      await screen.findByText(
        /0\.05 × 250 × 2 mL = 25 EU per vial at the standard prep/
      )
    ).toBeInTheDocument()
    expect(screen.getByText('not yet the COA spec')).toBeInTheDocument()
    expect(
      await screen.findByRole('button', { name: 'Endosafe 0.05' })
    ).toBeInTheDocument()
    expect(screen.getByText('0.05 EU/mL')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Endotoxin (LAL) · Rev 2' })
    )
    expect(useUIStore.getState().methodsTargetId).toBe(12)
  })

  // The allowed list follows the worksheet (allowedCartridges, and the
  // server's cartridge_ids_allowed_by): a method that links none offers every
  // active endo cartridge; one whose links are all retired offers none.
  it('offers every active endo cartridge when the method links none', async () => {
    const api = await import('@/lib/api')
    vi.mocked(api.getMethodConsumables).mockResolvedValue([])
    vi.mocked(api.listConsumables).mockResolvedValue([cartridge, retired])
    renderPanel({})
    expect(
      await screen.findByText(
        /links no cartridges, so worksheets offer every active endotoxin cartridge/
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Endosafe 0.05' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: retired.name })
    ).not.toBeInTheDocument()
  })

  it('offers none when every cartridge the method links is retired', async () => {
    const api = await import('@/lib/api')
    vi.mocked(api.getMethodConsumables).mockResolvedValue([
      {
        consumable_type_id: retired.id,
        kind: 'endo_cartridge',
        is_default: true,
      },
    ])
    vi.mocked(api.listConsumables).mockResolvedValue([cartridge, retired])
    renderPanel({})
    expect(await screen.findByText(/worksheets offer none/)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Endosafe 0.05' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: retired.name })
    ).not.toBeInTheDocument()
  })

  it('says so when the method cannot load, rather than showing the standard parameters as its own', async () => {
    const api = await import('@/lib/api')
    vi.mocked(api.getMethods).mockRejectedValue(
      new Error('Get methods failed: 500')
    )
    renderPanel({})
    expect(
      await screen.findByText(/Couldn't load how results are judged/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/spike recovery/)).not.toBeInTheDocument()
  })

  it('shows nothing, and asks for nothing, on a service that is not endotoxin', () => {
    const { container } = renderPanel({ keyword: 'HPLC-PURITY' })
    expect(container).toBeEmptyDOMElement()
    expect(listServiceSpecs).not.toHaveBeenCalled()
  })
})
