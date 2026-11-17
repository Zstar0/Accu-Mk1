/**
 * Stale-page guard on promote: the server refuses a promote whose source row
 * no longer holds what the page showed (409 source_changed). The value sent
 * as result_value is the PARENT's and stays the reviewer's to edit (or the
 * mean), so each source separately carries what the page showed for it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor, screen } from '@testing-library/react'
import { PromoteDialog } from '@/components/senaite/AnalysisTable'
import { PromoteAnalyteRow } from '@/components/samples/VarianceSummary'
import type {
  SenaiteAnalysis,
  VarianceStatsEntry,
  VarianceVial,
} from '@/lib/api'
import * as api from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof api>()
  return { ...actual, promoteAnalyses: vi.fn().mockResolvedValue({}) }
})

const promote = () => vi.mocked(api.promoteAnalyses)

beforeEach(() => {
  promote()
    .mockClear()
    .mockResolvedValue({} as never)
})

const vialRow = {
  uid: 'mk1:820',
  title: 'Vial Vacuum Test',
  keyword: 'PRESSURE-VC',
  result: '350',
  unit: 'torr',
  review_state: 'to_be_verified',
} as SenaiteAnalysis

describe('the single promote dialog', () => {
  it('sends the value typed for the parent, and what the row showed', async () => {
    const onPromoted = vi.fn()
    render(
      <PromoteDialog
        analysis={vialRow}
        open
        onOpenChange={vi.fn()}
        onPromoted={onPromoted}
      />
    )
    fireEvent.change(screen.getByLabelText('Result value'), {
      target: { value: '350.0' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }))
    await waitFor(() => expect(onPromoted).toHaveBeenCalled())
    expect(promote()).toHaveBeenCalledWith(
      expect.objectContaining({
        result_value: '350.0',
        result_unit: 'torr',
        sources: [
          {
            analysis_id: 820,
            contribution_kind: 'chosen',
            seen_result_value: '350',
            seen_result_unit: 'torr',
          },
        ],
      })
    )
  })

  it('reads the page again when the promote is refused, and stays open', async () => {
    promote().mockRejectedValueOnce(
      new Error('P-0120-S02 Vial Vacuum Test changed after this page loaded it')
    )
    const onPromoted = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <PromoteDialog
        analysis={vialRow}
        open
        onOpenChange={onOpenChange}
        onPromoted={onPromoted}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }))
    await waitFor(() => expect(onPromoted).toHaveBeenCalledTimes(1))
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe('the variance promote row', () => {
  const stat = { kind: 'numeric', mean: 25.5 } as VarianceStatsEntry
  const vial = (
    sample_id: string,
    uid: string,
    value: string | number
  ): VarianceVial =>
    ({
      sample_id,
      in_variance_set: true,
      results: { ENDO: { value, kind: 'numeric', uid } },
    }) as unknown as VarianceVial

  it('a mean says what each replicate showed when it was worked out', async () => {
    const onPromoted = vi.fn()
    render(
      <ul>
        <PromoteAnalyteRow
          keyword="ENDO"
          stat={stat}
          vials={[
            vial('P-1-S01', 'mk1:11', '25'),
            vial('P-1-S02', 'mk1:12', '26'),
          ]}
          onPromoted={onPromoted}
        />
      </ul>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Use mean (25.50)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }))
    await waitFor(() => expect(onPromoted).toHaveBeenCalled())
    expect(promote()).toHaveBeenCalledWith(
      expect.objectContaining({
        result_value: '25.50',
        sources: [
          {
            analysis_id: 11,
            contribution_kind: 'aggregated_in',
            seen_result_value: '25',
          },
          {
            analysis_id: 12,
            contribution_kind: 'aggregated_in',
            seen_result_value: '26',
          },
        ],
      })
    )
  })

  it('a pick sends the chosen and the reference rows, each as shown', async () => {
    const onPromoted = vi.fn()
    render(
      <ul>
        <PromoteAnalyteRow
          keyword="ENDO"
          stat={stat}
          // a value that arrives as a number is not the stored text: not compared
          vials={[
            vial('P-1-S01', 'mk1:11', '25'),
            vial('P-1-S02', 'mk1:12', 26),
          ]}
          onPromoted={onPromoted}
        />
      </ul>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }))
    await waitFor(() => expect(onPromoted).toHaveBeenCalled())
    expect(promote()).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          {
            analysis_id: 11,
            contribution_kind: 'chosen',
            seen_result_value: '25',
          },
          { analysis_id: 12, contribution_kind: 'reference' },
        ],
      })
    )
  })

  it('reads the panel again when the promote is refused', async () => {
    promote().mockRejectedValueOnce(
      new Error('changed after this page loaded it')
    )
    const onPromoted = vi.fn()
    render(
      <ul>
        <PromoteAnalyteRow
          keyword="ENDO"
          stat={stat}
          vials={[vial('P-1-S01', 'mk1:11', '25')]}
          onPromoted={onPromoted}
        />
      </ul>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }))
    await waitFor(() => expect(onPromoted).toHaveBeenCalledTimes(1))
    // not shown as promoted
    expect(screen.queryByText(/promoted/)).toBeNull()
  })
})
