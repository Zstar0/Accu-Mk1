import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AnalysisHistory } from '../AnalysisHistory'
import { listSamplePreps, getChromatogramStatus } from '@/lib/api'
import type { SamplePrep } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  listSamplePreps: vi.fn(),
  getChromatogramStatus: vi.fn(),
}))

vi.mock('../SamplePrepHplcFlyout', () => ({
  SamplePrepHplcFlyout: () => null,
}))

const DONE_STATUSES = ['hplc_complete', 'completed', 'curve_created']

function prep(id: number, overrides: Partial<SamplePrep> = {}): SamplePrep {
  return {
    id,
    sample_id: `SP-20260824-${String(id).padStart(4, '0')}`,
    senaite_sample_id: null,
    peptide_name: 'Retatrutide',
    peptide_abbreviation: null,
    is_standard: false,
    status: 'hplc_complete',
    instrument_name: null,
    created_by_email: null,
    created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T00:00:00Z',
    ...overrides,
  } as SamplePrep
}

const listMock = vi.mocked(listSamplePreps)
const chromMock = vi.mocked(getChromatogramStatus)

beforeEach(() => {
  vi.clearAllMocks()
  chromMock.mockResolvedValue({ prep_ids_with_chromatogram: [] })
})

describe('AnalysisHistory', () => {
  it('requests done statuses server-side so the LIMIT window applies after filtering', async () => {
    listMock.mockResolvedValue([prep(1)])
    render(<AnalysisHistory />)
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))
    expect(listMock).toHaveBeenCalledWith({
      limit: 100,
      offset: 0,
      is_standard: false,
      statuses: DONE_STATUSES,
    })
    expect(await screen.findByText('SP-20260824-0001')).toBeInTheDocument()
  })

  it('shows Load more on a full page and appends the next offset', async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => prep(i + 1))
    const pageTwo = [prep(101), prep(102)]
    listMock.mockImplementation(async params =>
      (params?.offset ?? 0) === 0 ? pageOne : pageTwo
    )
    render(<AnalysisHistory />)
    expect(await screen.findByText('SP-20260824-0001')).toBeInTheDocument()

    const button = screen.getByRole('button', { name: /load more/i })
    fireEvent.click(button)

    expect(await screen.findByText('SP-20260824-0102')).toBeInTheDocument()
    expect(listMock).toHaveBeenLastCalledWith({
      limit: 100,
      offset: 100,
      is_standard: false,
      statuses: DONE_STATUSES,
    })
    // page one is still there (appended, not replaced)
    expect(screen.getByText('SP-20260824-0001')).toBeInTheDocument()
    // short second page exhausts the list
    expect(
      screen.queryByRole('button', { name: /load more/i })
    ).not.toBeInTheDocument()
  })

  it('hides Load more when the first page is short', async () => {
    listMock.mockResolvedValue([prep(1), prep(2)])
    render(<AnalysisHistory />)
    expect(await screen.findByText('SP-20260824-0002')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /load more/i })
    ).not.toBeInTheDocument()
  })
})
