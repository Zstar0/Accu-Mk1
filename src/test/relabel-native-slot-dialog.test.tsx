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
  relabelNativeSlot: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { getPeptides, relabelNativeSlot } from '@/lib/api'
import { toast } from 'sonner'
import { RelabelNativeSlotDialog } from '@/components/senaite/RelabelNativeSlotDialog'

const pep = (id: number, name: string) => ({
  id, name, abbreviation: name.slice(0, 3), active: true, is_blend: false,
  analyte_class: 'peptide', prep_vial_count: 1, created_at: '', updated_at: '',
}) as any

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onDone = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <RelabelNativeSlotDialog
        open sampleId="P-0120" slot={2}
        oldPeptideId={1} oldPeptideName="TP500"
        onClose={vi.fn()} onDone={onDone}
      />
    </QueryClientProvider>,
  )
  return { onDone }
}

describe('RelabelNativeSlotDialog', () => {
  beforeEach(() => {
    vi.mocked(getPeptides).mockResolvedValue([
      pep(1, 'TP500'),                      // current (excluded)
      pep(2, 'TB500 (Thymosin Beta 4)'),    // has a legacy service set
      pep(3, 'Obscure Variant'),            // no legacy service set — still selectable
    ])
    vi.mocked(relabelNativeSlot).mockReset()
  })

  it('lists all active catalog peptides (including one without a legacy service set) and posts the chosen id to the relabel route', async () => {
    vi.mocked(relabelNativeSlot).mockResolvedValue({
      slot: 2, old_peptide_id: 1, new_peptide_id: 3, restamped: 1,
    })
    const { onDone } = renderDialog()

    const withoutLegacySet = await screen.findByRole('button', { name: /Obscure Variant/ })
    expect(withoutLegacySet).not.toBeDisabled()
    // current peptide is excluded from the list
    expect(screen.queryByRole('button', { name: /^TP500/ })).not.toBeInTheDocument()

    await userEvent.click(withoutLegacySet)
    await userEvent.click(screen.getByRole('button', { name: /^Relabel$/ }))

    await waitFor(() =>
      expect(relabelNativeSlot).toHaveBeenCalledWith('P-0120', 2, 3, undefined)
    )
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('surfaces the 409 native_slot_locked message on failure', async () => {
    vi.mocked(relabelNativeSlot).mockRejectedValue(
      new Error('Slot 2 is locked by a verified result')
    )
    renderDialog()

    await userEvent.click(await screen.findByRole('button', { name: /TB500 \(Thymosin Beta 4\)/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Relabel$/ }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Relabel failed',
        expect.objectContaining({ description: 'Slot 2 is locked by a verified result' })
      )
    )
  })
})
