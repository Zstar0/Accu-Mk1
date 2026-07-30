/**
 * Task 5b: NativeParentAnalysesCard — the read-only "Accu-Mk1 Analyses"
 * section on the sample-details parent page. Separate from the SENAITE-
 * sourced Analyses table by design (task-5b-brief.md), so this is a
 * standalone render test of the exported card component, not a full
 * SampleDetails page render (that component's transitive dependency graph
 * is enormous and untested as a whole elsewhere — see select-root-
 * generations.test.ts for the same "import the pure/small export directly"
 * precedent this file follows for a .tsx render instead of a .ts unit test).
 *
 * isParentPage is passed as an explicit prop rather than derived from a
 * sampleId regex — that keeps the "never fetches on sub-sample pages" case
 * a real assertion against the query's `enabled` gate (the mock is called
 * or not), not a tautological check of a hand-rolled predicate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NativeParentAnalysesCard } from '@/components/senaite/SampleDetails'
import { getNativeParentAnalyses, type NativeParentAnalysisRow } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getNativeParentAnalyses: vi.fn(),
  }
})

function renderCard(props: { sampleId: string | null; isParentPage: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <NativeParentAnalysesCard {...props} />
    </QueryClientProvider>
  )
}

const ROW: NativeParentAnalysisRow = {
  keyword: 'HM-PB',
  title: 'Heavy Metals — Lead',
  result_value: '0.12',
  result_unit: 'ppm',
  review_state: 'verified',
  updated_at: '2026-07-30T00:00:00Z',
}

describe('NativeParentAnalysesCard', () => {
  beforeEach(() => {
    vi.mocked(getNativeParentAnalyses).mockReset()
  })

  it('renders the card and its rows on a parent page with data', async () => {
    vi.mocked(getNativeParentAnalyses).mockResolvedValue([ROW])
    renderCard({ sampleId: 'P-0120', isParentPage: true })

    expect(await screen.findByText('Accu-Mk1 Analyses')).toBeInTheDocument()
    expect(screen.getByText('Heavy Metals — Lead')).toBeInTheDocument()
    expect(screen.getByText('HM-PB')).toBeInTheDocument()
    expect(screen.getByText('0.12 ppm')).toBeInTheDocument()
    expect(getNativeParentAnalyses).toHaveBeenCalledWith('P-0120')
  })

  it('renders nothing when the list comes back empty', async () => {
    vi.mocked(getNativeParentAnalyses).mockResolvedValue([])
    const { container } = renderCard({ sampleId: 'P-0121', isParentPage: true })

    await waitFor(() => expect(getNativeParentAnalyses).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('Accu-Mk1 Analyses')).not.toBeInTheDocument()
  })

  it('never fetches on a sub-sample page', async () => {
    vi.mocked(getNativeParentAnalyses).mockResolvedValue([ROW])
    const { container } = renderCard({ sampleId: 'P-0120-S01', isParentPage: false })

    // Give any (incorrect) fetch a chance to fire before asserting it didn't.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getNativeParentAnalyses).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })
})
