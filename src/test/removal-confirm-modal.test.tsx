import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RemovalConfirmModal } from '@/components/senaite/RemovalConfirmModal'
import type { RemovalImpact } from '@/lib/api'

// Radix Dialog drives pointer-capture APIs jsdom lacks.
window.HTMLElement.prototype.hasPointerCapture = vi.fn()
window.HTMLElement.prototype.setPointerCapture = vi.fn()
window.HTMLElement.prototype.releasePointerCapture = vi.fn()
window.HTMLElement.prototype.scrollIntoView = vi.fn()

const row = (sample_id: string, review_state: string): RemovalImpact['pristine'][number] => ({
  analysis_id: 1,
  sample_id,
  keyword: 'ID_TB500BETA4',
  review_state,
})

describe('RemovalConfirmModal', () => {
  it('worked rows: shows retract warning and confirms', async () => {
    const onConfirm = vi.fn()
    const impact: RemovalImpact = {
      pristine: [],
      worked_unverified: [row('P-0075-S01', 'to_be_verified'), row('P-0075-S02', 'assigned')],
      blocked: [],
    }
    render(
      <RemovalConfirmModal
        open
        serviceTitle="TB500 (Thymosin Beta 4) - Identity (HPLC)"
        impact={impact}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText(/retract 2 entered results/i)).toBeInTheDocument()
    expect(screen.getByText(/keep a record/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /retract & remove/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('blocked rows: refuses removal, no confirm button', () => {
    const impact: RemovalImpact = {
      pristine: [],
      worked_unverified: [],
      blocked: [row('P-0075-S01', 'verified')],
    }
    render(
      <RemovalConfirmModal
        open
        serviceTitle="TB500 (Thymosin Beta 4) - Identity (HPLC)"
        impact={impact}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText(/invalidate or retest/i)).toBeInTheDocument()
    // Removal is refused — no destructive confirm action is offered.
    expect(screen.queryByRole('button', { name: /retract & remove/i })).not.toBeInTheDocument()
  })
})
