import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Radix Dialog needs these jsdom shims.
window.HTMLElement.prototype.hasPointerCapture = vi.fn()
window.HTMLElement.prototype.setPointerCapture = vi.fn()
window.HTMLElement.prototype.releasePointerCapture = vi.fn()
window.HTMLElement.prototype.scrollIntoView = vi.fn()

vi.mock('@/lib/api', () => ({
  getPeptides: vi.fn(),
  getPeptidesWithServiceSet: vi.fn(),
  replaceAnalyte: vi.fn(),
}))

import { getPeptides, getPeptidesWithServiceSet, replaceAnalyte } from '@/lib/api'
import { ReplaceAnalyteDialog } from '@/components/senaite/ReplaceAnalyteDialog'

const pep = (id: number, name: string) => ({
  id, name, abbreviation: name.slice(0, 3), active: true, is_blend: false,
  analyte_class: 'peptide', prep_vial_count: 1, created_at: '', updated_at: '',
}) as any

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onReplaced = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <ReplaceAnalyteDialog
        open sampleId="PB-0075" senaiteUid="uid-pb75" slot={2}
        oldPeptideId={1} oldPeptideName="TP500"
        onClose={vi.fn()} onReplaced={onReplaced}
      />
    </QueryClientProvider>,
  )
  return { onReplaced }
}

describe('ReplaceAnalyteDialog', () => {
  beforeEach(() => {
    vi.mocked(getPeptides).mockResolvedValue([
      pep(1, 'TP500'),                      // current (excluded)
      pep(2, 'TB500 (Thymosin Beta 4)'),    // eligible
      pep(3, 'Obscure Variant'),            // ineligible (no services)
    ])
    vi.mocked(getPeptidesWithServiceSet).mockResolvedValue([2])
    vi.mocked(replaceAnalyte).mockReset()
  })

  it('offers eligible peptides, disables ineligible, and replaces', async () => {
    vi.mocked(replaceAnalyte).mockResolvedValue({
      success: true, field_updated: 'Analyte2Peptide', new_peptide: 'TB500 (Thymosin Beta 4)',
      identity: { removed: 'ID_TP500', added: 'ID_TB500BETA4' },
      slot: 2, old_peptide_id: 1, new_peptide_id: 2,
      vials: { deleted: [], retracted: [], blocked: [], reseeded: ['PB-0075-S01'] },
    })
    const { onReplaced } = renderDialog()

    const eligible = await screen.findByRole('button', { name: /TB500 \(Thymosin Beta 4\)/ })
    const ineligible = screen.getByRole('button', { name: /Obscure Variant/ })
    expect(ineligible).toBeDisabled()
    expect(screen.getByText(/no services/i)).toBeInTheDocument()
    // current peptide is excluded from the list
    expect(screen.queryByRole('button', { name: /^TP500/ })).not.toBeInTheDocument()

    await userEvent.click(eligible)
    await userEvent.click(screen.getByRole('button', { name: /^Replace$/ }))

    await waitFor(() => expect(replaceAnalyte).toHaveBeenCalledWith('PB-0075', 2, {
      newPeptideId: 2, oldPeptideId: 1, senaiteUid: 'uid-pb75', force: false,
    }))
    await waitFor(() => expect(onReplaced).toHaveBeenCalled())
  })

  it('412 surfaces the retract-confirm modal, then re-posts with confirm', async () => {
    const err = Object.assign(new Error('confirm'), {
      status: 412,
      impact: { pristine: [], worked_unverified: [{ analysis_id: 1, sample_id: 'PB-0075-S01', keyword: 'PUR_TP500', review_state: 'to_be_verified' }], blocked: [] },
    })
    vi.mocked(replaceAnalyte)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        success: true, field_updated: 'Analyte2Peptide', new_peptide: 'TB500 (Thymosin Beta 4)',
        identity: { removed: null, added: null }, slot: 2, old_peptide_id: 1, new_peptide_id: 2,
        vials: { deleted: [], retracted: [{}], blocked: [], reseeded: ['PB-0075-S01'] },
      })
    renderDialog()

    await userEvent.click(await screen.findByRole('button', { name: /TB500 \(Thymosin Beta 4\)/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Replace$/ }))

    // retract-confirm modal
    await screen.findByText(/retract 1 entered result/i)
    await userEvent.click(screen.getByRole('button', { name: /retract & remove/i }))

    await waitFor(() => expect(replaceAnalyte).toHaveBeenLastCalledWith('PB-0075', 2, {
      newPeptideId: 2, oldPeptideId: 1, senaiteUid: 'uid-pb75', force: true,
    }))
  })
})
