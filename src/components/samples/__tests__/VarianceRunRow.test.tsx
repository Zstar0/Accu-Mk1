/**
 * Parent page Variance row (variance-run-rows, part A).
 *
 * Pinned: one read-only row per test after its section, a pill per
 * replicate vial in vial order (pending and excluded states), the signed-off
 * count, the 8-pill cap with "+N more", the row never counted in the
 * table's totals, replicate chips dropped only when the row renders, and no
 * row for SENAITE-born parents.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AnalysisTable } from '@/components/senaite/AnalysisTable'
import { parentVarianceRowTests, pillValueText } from '@/lib/variance-values'
import type { SenaiteAnalysis, VarianceRun, VarianceTest } from '@/lib/api'
import type { VialAssignment } from '@/lib/vial-assignment'
import type * as SidebarModule from '@/components/ui/sidebar'

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

const row = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis => ({
  uid: 'mk1:1',
  keyword: 'ENDOTOXIN-USP85LAL',
  title: 'Endotoxin',
  result: '2',
  result_type: 'numeric',
  result_options: [],
  unit: 'EU/mL',
  method: null,
  method_uid: null,
  method_options: [],
  instrument: null,
  instrument_uid: null,
  instrument_options: [],
  analyst: null,
  due_date: null,
  review_state: 'verified',
  sort_key: null,
  captured: null,
  retested: false,
  service_group_id: null,
  service_group_name: null,
  service_origin: 'mk1',
  profile_section_key: 'endotoxin-usp85-lal',
  profile_section_label: 'Endotoxin',
  profile_section_sort: 11,
  ...over,
})

const run = (seq: number, over: Partial<VarianceRun> = {}): VarianceRun => ({
  sample_id: `P-5010-S${String(seq).padStart(2, '0')}`,
  vial_sequence: seq,
  kind: 'variance',
  in_variance_set: true,
  exclusion_reason: null,
  signed_off: true,
  has_result: true,
  values: [{
    keyword: 'ENDOTOXIN-USP85LAL', label: 'Endotoxin', value: String(seq / 2), unit: 'EU/mL',
    conforms: true, review_state: 'variance_verified', analyst: 'D. Lee', specification: null,
  }],
  ...over,
})

const endoTest = (runs: VarianceRun[], signed = 1, counted = 2): VarianceTest => ({
  role: 'endo85',
  section_key: 'endotoxin-usp85-lal',
  title: 'Endotoxin',
  is_hplc: false,
  runs: [run(2, { kind: 'core' }), ...runs],
  summary: {
    runs: counted + 1, runs_with_result: counted + 1, conforming: counted + 1,
    replicates: counted, replicates_signed_off: signed, stats: [],
  },
})

function renderTable(props: Partial<React.ComponentProps<typeof AnalysisTable>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AnalysisTable
        analyses={[
          row({}),
          row({ uid: 'mk1:2', keyword: 'RAPID-PCR', title: 'Rapid PCR', review_state: 'to_be_verified',
                profile_section_key: 'rapid-sterility-pcr', profile_section_label: 'Rapid PCR',
                profile_section_sort: 12 }),
        ]}
        analyteNameMap={new Map()}
        {...props}
      />
    </QueryClientProvider>
  )
}

describe('parent Variance row', () => {
  it('renders one pill per replicate, pending and excluded, and the signed-off count', () => {
    const test = endoTest([
      run(6, { has_result: false, signed_off: false, values: [] }),
      run(5),
      run(7, { in_variance_set: false, exclusion_reason: 'Cracked vial' }),
    ])
    renderTable({ varianceTests: [test] })
    expect(screen.getAllByTestId('variance-run-row')).toHaveLength(1)
    const varianceRow = within(screen.getByTestId('variance-run-row'))
    const pills = varianceRow.getAllByTestId('variance-pill')
    expect(pills.map(p => p.textContent)).toEqual(['Vial 52.5', 'Vial 6pending', 'Vial 73.5'])
    expect(pills.map(p => p.getAttribute('data-state-kind'))).toEqual(['result', 'pending', 'excluded'])
    expect(varianceRow.getByText('Variance · 3')).toBeTruthy()
    expect(varianceRow.getByText('EU/mL')).toBeTruthy()
    expect(varianceRow.getByTestId('variance-signoff').textContent).toBe('1 of 2 signed off')
  })

  it('sits right after its own section, before the next one', () => {
    renderTable({ varianceTests: [endoTest([run(5)])] })
    const bodyRows = Array.from(document.querySelectorAll('tbody tr'))
    const idx = bodyRows.findIndex(r => r.getAttribute('data-testid') === 'variance-run-row')
    expect(bodyRows[idx - 1]?.textContent).toContain('Endotoxin')
    expect(bodyRows[idx + 1]?.textContent).toContain('Rapid PCR')
  })

  it('is not counted in the totals or the tabs', () => {
    renderTable({ varianceTests: [endoTest([run(5), run(6)])] })
    expect(screen.getByText('2 of 2')).toBeTruthy()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(3) // header + two analyses
  })

  it('caps at 8 pills and opens the overlay from +N more', () => {
    const onOpen = vi.fn()
    const many = Array.from({ length: 10 }, (_, i) => run(i + 3))
    renderTable({ varianceTests: [endoTest(many, 10, 10)], onOpenVariance: onOpen })
    expect(screen.getAllByTestId('variance-pill')).toHaveLength(8)
    fireEvent.click(screen.getByText('+2 more'))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(screen.getByTestId('variance-signoff').textContent).toBe('10 of 10 signed off')
  })

  it('drops replicate chips only when the row renders', () => {
    const match = (id: string, kind: string) => ({
      vialSampleId: id, vialLabel: id.endsWith('S02') ? 'Vial 2' : 'Vial 5',
      mk1Analysis: row({ uid: `mk1:${id}` }), assignmentRole: 'endo85', assignmentKind: kind,
    })
    const map = new Map<string, VialAssignment>([
      ['mk1:1', { matches: [match('P-5010-S02', 'core'), match('P-5010-S05', 'variance')], editable: false }],
    ])
    const { unmount } = renderTable({ vialAssignmentByKeyword: map })
    expect(screen.getByText(/P-5010-S05/)).toBeTruthy()
    expect(screen.queryByTestId('variance-run-row')).toBeNull()
    unmount()
    renderTable({ vialAssignmentByKeyword: map, varianceTests: [endoTest([run(5)])] })
    expect(screen.queryByText(/P-5010-S05/)).toBeNull()
    expect(screen.getByText(/P-5010-S02/)).toBeTruthy()
  })

  it('formats an HPLC pill as identity, purity, quantity', () => {
    const hplc: VarianceTest = { ...endoTest([]), role: 'hplc', is_hplc: true }
    const r = run(4, {
      values: [
        { keyword: 'ANALYTE-1-ID', label: 'BPC-157 - Identity (HPLC)', value: 'BPC-157', unit: null,
          conforms: true, review_state: 'variance_verified', analyst: null, specification: null },
        { keyword: 'HPLC-PUR', label: 'BPC-157 - Purity (HPLC)', value: '98', unit: '%',
          conforms: null, review_state: 'variance_verified', analyst: null, specification: null },
        { keyword: 'PEPT-Total', label: 'BPC-157 - Quantity (HPLC)', value: '11', unit: 'mg',
          conforms: null, review_state: 'variance_verified', analyst: null, specification: null },
      ],
    })
    expect(pillValueText(r, hplc)).toBe('Conforms · 98 % · 11 mg')
  })
})

describe('parentVarianceRowTests', () => {
  const tests = [endoTest([run(5)])]
  it('gives the rows to Mk1-born container parents only', () => {
    expect(parentVarianceRowTests({ isParentPage: true, externalLimsSystem: 'mk1', containerMode: true, tests }))
      .toBe(tests)
    for (const args of [
      { isParentPage: true, externalLimsSystem: 'senaite', containerMode: true },
      { isParentPage: true, externalLimsSystem: null, containerMode: false },
      { isParentPage: true, externalLimsSystem: 'mk1', containerMode: false },
      { isParentPage: false, externalLimsSystem: 'mk1', containerMode: true },
    ]) {
      expect(parentVarianceRowTests({ ...args, tests })).toBeUndefined()
    }
  })
})
