/**
 * What gets SAVED when a tech picks "Conforms" on an identity line.
 *
 * Legacy (SENAITE-era) identity lines have no result options: the dropdown
 * says "Conforms" but saves the PEPTIDE NAME, and conformance is a name match.
 * Native identity lines carry catalog options and a spec of equals "Conforms".
 * Both titles end "- Identity (HPLC)", and the legacy branch used to win on
 * native rows too: PB-1002 and P-5007 stored "KPV" / "Cagrilintide" and Mk1's
 * own verdict read Does Not Conform on a sample the tech had passed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  AnalysisTable,
  legacyIdentityConformsValue,
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

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    setAnalysisResult: vi.fn().mockResolvedValue({ success: true, new_review_state: 'to_be_verified' }),
  }
})

import { setAnalysisResult } from '@/lib/api'

const OPTIONS = [
  { value: 'Conforms', label: 'Conforms' },
  { value: 'Does Not Conform', label: 'Does Not Conform' },
]

const row = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis => ({
  uid: 'mk1:3806', keyword: 'HPLC-IDENTITY', title: 'KPV - Identity (HPLC)',
  result: null, result_options: [], unit: null, method: null, method_uid: null,
  method_options: [], instrument: null, instrument_uid: null, instrument_options: [],
  analyst: null, due_date: null, review_state: 'unassigned', sort_key: null,
  captured: null, retested: false, service_group_id: null, service_group_name: null,
  ...over,
})

function renderTable(analysis: SenaiteAnalysis) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <AnalysisTable analyses={[analysis]} analyteNameMap={new Map()} />
    </QueryClientProvider>
  )
}

describe('legacyIdentityConformsValue', () => {
  it('stands down for a native row that carries its own options', () => {
    expect(
      legacyIdentityConformsValue(
        { service_origin: 'mk1', result_options: OPTIONS }, 'KPV - Identity (HPLC)')
    ).toBeNull()
  })
  it('still applies to a legacy identity line', () => {
    expect(
      legacyIdentityConformsValue(
        { service_origin: 'senaite', result_options: [] }, 'BPC-157 - Identity (HPLC)')
    ).toBe('BPC-157')
  })
  it('still applies to an mk1 row with NO options (nothing else to offer)', () => {
    expect(
      legacyIdentityConformsValue(
        { service_origin: 'mk1', result_options: [] }, 'BPC-157 - Identity (HPLC)')
    ).toBe('BPC-157')
  })
  it('is null for a non-identity title', () => {
    expect(
      legacyIdentityConformsValue({ service_origin: 'senaite', result_options: [] }, 'KPV - Purity (HPLC)')
    ).toBeNull()
  })
})

describe('picking "Conforms" in the result cell', () => {
  beforeEach(() => vi.mocked(setAnalysisResult).mockClear())

  it('NATIVE identity saves the literal "Conforms", never the peptide name', async () => {
    renderTable(row({ service_origin: 'mk1', result_type: 'select', result_options: OPTIONS }))
    await userEvent.selectOptions(
      screen.getByLabelText('Select result for KPV - Identity (HPLC)'), 'Conforms')
    await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
    expect(vi.mocked(setAnalysisResult).mock.calls[0]?.slice(0, 2)).toEqual(['mk1:3806', 'Conforms'])
  })

  it('LEGACY identity still saves the peptide name (unchanged)', async () => {
    renderTable(row({
      uid: 'mk1:9001', keyword: 'ID_BPC157', title: 'BPC-157 - Identity (HPLC)',
      service_origin: 'senaite', result_options: [],
    }))
    await userEvent.selectOptions(
      screen.getByLabelText('Select result for BPC-157 - Identity (HPLC)'), 'Conforms')
    await waitFor(() => expect(setAnalysisResult).toHaveBeenCalledTimes(1))
    expect(vi.mocked(setAnalysisResult).mock.calls[0]?.slice(0, 2)).toEqual(['mk1:9001', 'BPC-157'])
  })
})
