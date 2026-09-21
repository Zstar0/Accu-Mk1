/**
 * Native blend aggregates are calculated by Mk1, so the result cell must never
 * offer an editor for them. Typed by hand on PB-1002 they drifted from the COA.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  AnalysisTable,
  CalculatedAggregateTooltip,
  calculatedAggregateInfo,
} from '@/components/senaite/AnalysisTable'
import type { SenaiteAnalysis } from '@/lib/api'

class MockIntersectionObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  constructor(_cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {}
}
Object.defineProperty(window, 'IntersectionObserver', {
  writable: true, configurable: true, value: MockIntersectionObserver,
})

vi.mock('@/components/ui/sidebar', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/ui/sidebar')>()
  return {
    ...actual,
    useSidebar: () => ({
      state: 'expanded' as const, open: true, setOpen: vi.fn(), openMobile: false,
      setOpenMobile: vi.fn(), isMobile: false, toggleSidebar: vi.fn(),
    }),
  }
})

const row = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis => ({
  uid: 'mk1:3818', keyword: 'HPLC-BLEND-PURITY', title: 'HPLC Blend Purity (mass-weighted)',
  result: null, result_options: [], unit: '%', method: null, method_uid: null,
  method_options: [], instrument: null, instrument_uid: null, instrument_options: [],
  analyst: null, due_date: null, review_state: 'unassigned', sort_key: null,
  captured: null, retested: false, service_group_id: null, service_group_name: null,
  service_origin: 'mk1', ...over,
})

function renderTable(analysis: SenaiteAnalysis) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AnalysisTable analyses={[analysis]} analyteNameMap={new Map()} />
    </QueryClientProvider>
  )
}

describe('calculatedAggregateInfo', () => {
  it('knows the two native aggregates', () => {
    expect(calculatedAggregateInfo({ service_origin: 'mk1', keyword: 'HPLC-BLEND-TOTAL' })?.label)
      .toBe('Blend total quantity')
    expect(calculatedAggregateInfo({ service_origin: 'mk1', keyword: 'hplc-blend-purity' })?.label)
      .toBe('Blend purity')
  })
  it('ignores peptide rows and every legacy row', () => {
    expect(calculatedAggregateInfo({ service_origin: 'mk1', keyword: 'HPLC-PURITY' })).toBeNull()
    expect(calculatedAggregateInfo({ service_origin: 'senaite', keyword: 'BLEND-PUR' })).toBeNull()
    expect(calculatedAggregateInfo({ service_origin: 'senaite', keyword: 'HPLC-BLEND-PURITY' })).toBeNull()
  })
})

describe('result cell on a calculated row', () => {
  it('an empty native aggregate offers NO editor, just the marker', () => {
    renderTable(row({}))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    // 'Pending' shows in the result cell AND as the status badge.
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Blend purity is calculated')).toBeInTheDocument()
  })

  it('a filled native aggregate is not click-to-edit either', () => {
    renderTable(row({ result: '98.75', review_state: 'to_be_verified' }))
    expect(screen.getByText('98.75')).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Edit result for/)).toBeNull()
  })

  it('a legacy blend purity row keeps its editor (unchanged)', () => {
    renderTable(row({
      uid: 'mk1:9002', keyword: 'BLEND-PUR', title: 'Blend Purity', service_origin: 'senaite',
    }))
    expect(screen.queryByLabelText('Blend purity is calculated')).toBeNull()
    expect(screen.getByLabelText('Edit result for Blend Purity')).toBeInTheDocument()
  })
})

describe('CalculatedAggregateTooltip', () => {
  const info = { label: 'Blend purity', formula: 'Quantity-weighted average of every peptide’s purity' }
  it('explains the formula and when it fills in', () => {
    const { getByTestId } = render(<CalculatedAggregateTooltip info={info} hasValue={false} />)
    const text = getByTestId('calculated-aggregate-tooltip').textContent ?? ''
    expect(text).toContain('Calculated: Blend purity')
    expect(text).toContain('Quantity-weighted average')
    expect(text).toContain('once every peptide has both a purity and a quantity')
  })
  it('says it is still promoted and verified once it has a value', () => {
    const { getByTestId } = render(<CalculatedAggregateTooltip info={info} hasValue />)
    expect(getByTestId('calculated-aggregate-tooltip').textContent).toContain('still promoted and verified')
  })
})
