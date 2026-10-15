/**
 * Endotoxin slice 3: a result carries its own LOQ and LOD. The sample page
 * shows them in small text under the value, and the Spec column shows the
 * result's LOQ in place of the spec's. Rows without them render as before.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AnalysisTable } from '@/components/senaite/AnalysisTable'
import { AnalysisSpecCell } from '@/components/senaite/AnalysisSpecCell'
import type { AnalysisSpecification, SenaiteAnalysis } from '@/lib/api'
import type * as SidebarModule from '@/components/ui/sidebar'

// AnalysisTable watches its card with an IntersectionObserver; jsdom has none.
class MockIntersectionObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
})

vi.mock('@/components/ui/sidebar', async importOriginal => {
  const actual = await importOriginal<typeof SidebarModule>()
  return {
    ...actual,
    useSidebar: () => ({
      state: 'expanded' as const,
      open: true,
      setOpen: vi.fn(),
      openMobile: false,
      setOpenMobile: vi.fn(),
      isMobile: false,
      toggleSidebar: vi.fn(),
    }),
  }
})

/** The peptide EU/vial spec row: 0 to 350, LOQ empty (each result carries its own). */
const EU_VIAL: AnalysisSpecification = {
  rule_kind: 'range',
  equals: null,
  min: 0,
  max: 350,
  unit: 'EU/vial',
  display: null,
  loq: null,
}

const row = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis => ({
  uid: 'mk1:4101',
  keyword: 'ENDOTOXIN-USP85LAL',
  title: 'Endotoxin USP85 LAL',
  result: '25',
  result_options: [],
  unit: 'EU/vial',
  method: null,
  method_uid: null,
  method_options: [],
  instrument: null,
  instrument_uid: null,
  instrument_options: [],
  analyst: null,
  due_date: null,
  review_state: 'parent_to_verify',
  sort_key: null,
  captured: null,
  retested: false,
  service_group_id: null,
  service_group_name: null,
  service_origin: 'mk1',
  ...over,
})

function renderTable(analysis: SenaiteAnalysis) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AnalysisTable analyses={[analysis]} analyteNameMap={new Map()} />
    </QueryClientProvider>
  )
}

const resultCell = () => {
  const cell = screen.getByText('25').closest('td')
  if (!cell) throw new Error('no result cell')
  return cell
}

describe('the result cell', () => {
  it('shows the LOQ and LOD under a parent result awaiting its reviewer', () => {
    renderTable(row({ loq: 25, lod: 0.05, lod_unit: 'EU/mL' }))
    expect(resultCell()).toHaveTextContent('25EU/vialLOQ 25 · LOD 0.05 EU/mL')
    expect(screen.getByTestId('result-limits')).toHaveTextContent(
      'LOQ 25 · LOD 0.05 EU/mL'
    )
  })

  it('shows them under a vial result that is still editable', () => {
    renderTable(
      row({
        review_state: 'to_be_verified',
        loq: 0.2,
        lod: 0.01,
        lod_unit: 'EU/mL',
        result: '0.2',
        unit: 'EU/mL',
      })
    )
    expect(screen.getByTestId('result-limits')).toHaveTextContent(
      'LOQ 0.2 · LOD 0.01 EU/mL'
    )
    expect(
      screen.getByLabelText('Edit result for Endotoxin USP85 LAL')
    ).toBeInTheDocument()
  })

  it('renders a row without them exactly as before', () => {
    renderTable(row({}))
    expect(screen.queryByTestId('result-limits')).not.toBeInTheDocument()
    expect(resultCell()).toHaveTextContent(/^25EU\/vial$/)
    // null from the server is the same as absent
    renderTable(row({ uid: 'mk1:4102', loq: null, lod: null, lod_unit: null }))
    expect(screen.queryByTestId('result-limits')).not.toBeInTheDocument()
  })
})

describe('the Spec column', () => {
  const renderCell = (
    analysis: Parameters<typeof AnalysisSpecCell>[0]['analysis']
  ) =>
    render(
      <TooltipProvider>
        <AnalysisSpecCell analysis={analysis} />
      </TooltipProvider>
    )

  it("shows the result's LOQ where the spec has none", () => {
    renderCell({
      specification: EU_VIAL,
      conforms: true,
      result: '25',
      unit: 'EU/vial',
      loq: 25,
    })
    expect(screen.getByTestId('analysis-spec-cell')).toHaveTextContent(
      '0 – 350 EU/vial · LOQ 25'
    )
  })

  it("shows the result's LOQ in place of the spec's", () => {
    renderCell({
      specification: { ...EU_VIAL, max: 5, unit: 'EU/mL', loq: 2.5 },
      conforms: true,
      result: '3.75',
      unit: 'EU/mL',
      loq: 3.75,
    })
    const cell = screen.getByTestId('analysis-spec-cell')
    expect(cell).toHaveTextContent('0 – 5 EU/mL · LOQ 3.75')
    expect(cell).not.toHaveTextContent('LOQ 2.5')
  })

  it("keeps the spec's LOQ for a result without its own", () => {
    renderCell({
      specification: { ...EU_VIAL, max: 5, unit: 'EU/mL', loq: 2.5 },
      conforms: true,
      result: '1',
      unit: 'EU/mL',
    })
    expect(screen.getByTestId('analysis-spec-cell')).toHaveTextContent(
      '0 – 5 EU/mL · LOQ 2.5'
    )
  })
})
