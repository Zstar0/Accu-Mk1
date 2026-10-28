import { cloneElement, type ReactElement } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Recharts from 'recharts'
import { getAnalyteTrends, type AnalyteTrendCoa } from '@/lib/api'
import { AnalyteTrends } from './AnalyteTrends'

vi.mock('@/lib/api', () => ({ getAnalyteTrends: vi.fn() }))
vi.mock('@/lib/api-profiles', () => ({
  getWordpressUrl: () => 'https://wp.test',
}))
const mockGet = vi.mocked(getAnalyteTrends)

vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof Recharts>()
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children: ReactElement<{ width?: number; height?: number }>
    }) => cloneElement(children, { width: 800, height: 240 }),
  }
})

const day = 86_400_000
function coa(over: Partial<AnalyteTrendCoa>): AnalyteTrendCoa {
  return {
    code: 'X',
    sample_id: 'P-1',
    published_at: new Date(Date.now() - day).toISOString(),
    product: '5-Amino-1MQ',
    is_blend: false,
    matrix: 'Peptide',
    lot: 'L1',
    overall: 'PASSED',
    purity: 99.2,
    purity_ok: true,
    purity_spec: '≥98%',
    identity_ok: true,
    qty: 9.6,
    qty_declared: 10,
    endo: null,
    sterility: null,
    hm: null,
    tests: [],
    ...over,
  }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AnalyteTrends />
    </QueryClientProvider>
  )
}

describe('AnalyteTrends', () => {
  beforeEach(() => {
    mockGet.mockResolvedValue({
      tz: 'America/Los_Angeles',
      coas: [
        coa({ code: 'AAAA-0001' }),
        coa({
          code: 'AAAA-0002',
          sample_id: 'P-2',
          overall: 'FAILED',
          endo: false,
        }),
        coa({
          code: 'BW-1',
          sample_id: 'BW-0001',
          product: 'Bacteriostatic Water',
          matrix: 'Bacteriostatic Water',
          purity: null,
          purity_ok: null,
          identity_ok: null,
          qty: null,
          qty_declared: null,
          tests: [
            {
              name: 'pH Determination',
              value: 5.5,
              unit: 'pH',
              ok: true,
              spec: '4.5 – 7.0',
            },
          ],
        }),
      ],
    })
  })

  it('lists products with the failing test, not just a count', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: 'Analyte Trends' })
    ).toBeInTheDocument()
    const row = (await screen.findByText('5-Amino-1MQ')).closest('tr')
    if (!row) throw new Error('row missing')
    expect(within(row).getByText('1/1')).toBeInTheDocument() // endotoxin
    expect(within(row).getAllByText('0/2')).toHaveLength(2) // purity, identity
    expect(within(row).getByText('-4.0%')).toBeInTheDocument() // qty Δ
    expect(screen.getByText('Bacteriostatic Water')).toBeInTheDocument()
  })

  it('drill-down shows the same COAs, with the reason the COA failed', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('5-Amino-1MQ'))
    expect(await screen.findByText('AAAA-0002')).toBeInTheDocument()
    expect(screen.getByText('AAAA-0001')).toBeInTheDocument()
    expect(screen.getByText('Endotoxin ✗')).toBeInTheDocument()
    expect(screen.getByText('Quantity vs declared')).toBeInTheDocument()
  })

  it('bac water drill-down charts each assay', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('Bacteriostatic Water'))
    expect(await screen.findAllByText('pH Determination')).not.toHaveLength(0)
    expect(screen.getByText('5.5 pH')).toBeInTheDocument()
  })
})
