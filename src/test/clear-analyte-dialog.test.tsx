import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ClearAnalyteDialog } from '@/components/senaite/ClearAnalyteDialog'
import type * as ApiModule from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return { ...actual, clearAnalyteSlot: vi.fn() }
})
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { clearAnalyteSlot } from '@/lib/api'
import { toast } from 'sonner'

const mockClear = vi.mocked(clearAnalyteSlot)

const PREVIEW = {
  dry_run: true as const,
  slot: 2,
  cleared_peptide: 'TP500',
  old_peptide_id: 9,
  identity_keyword: 'ID_TP500',
  cascade: true,
  duplicate_elsewhere: false,
  pre_subsample: false,
  impact: {
    pristine: Array.from({ length: 5 }, (_, i) => ({
      analysis_id: i + 1,
      sub_sample_pk: 1,
      sample_id: 'PB-1-S01',
      keyword: 'X',
      review_state: 'unassigned',
    })),
    worked_unverified: [
      {
        analysis_id: 6,
        sub_sample_pk: 2,
        sample_id: 'PB-1-S02',
        keyword: 'PUR_TP500',
        review_state: 'to_be_verified',
      },
    ],
    blocked: [],
  },
  presubsample_blocked: [],
}

const RESULT = {
  success: true,
  field_updated: ['Analyte2Peptide', 'Analyte2DeclaredQuantity'],
  cleared_peptide: 'TP500',
  identity: { removed: 'ID_TP500', added: null },
  slot: 2,
  old_peptide_id: 9,
  cascade: true,
  vials: { deleted: [1, 2, 3, 4, 5], retracted: [6], blocked: [] },
  pre_subsample: false,
}

function renderDialog(
  over: Partial<React.ComponentProps<typeof ClearAnalyteDialog>> = {}
) {
  const onClose = vi.fn()
  const onCleared = vi.fn()
  render(
    <ClearAnalyteDialog
      open
      sampleId="PB-1"
      senaiteUid="uid-1"
      slot={2}
      peptideId={9}
      peptideName="TP500"
      onClose={onClose}
      onCleared={onCleared}
      {...over}
    />
  )
  return { onClose, onCleared }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ClearAnalyteDialog', () => {
  it('previews the cascade on open and only enables Clear after the typed confirm', async () => {
    mockClear.mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce(RESULT)
    const { onCleared, onClose } = renderDialog()

    // dry-run preview requested immediately
    await waitFor(() =>
      expect(mockClear).toHaveBeenCalledWith(
        'PB-1',
        2,
        expect.objectContaining({ dryRun: true })
      )
    )
    expect(
      await screen.findByText(/5 never-worked vial rows will be deleted/i)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/1 worked result will be rejected/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/ID_TP500/)).toBeInTheDocument()

    const button = screen.getByRole('button', { name: /clear slot 2/i })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/type tp500 to confirm/i), {
      target: { value: 'tp500' },
    })
    expect(button).toBeEnabled()

    fireEvent.click(button)
    await waitFor(() =>
      expect(mockClear).toHaveBeenLastCalledWith(
        'PB-1',
        2,
        expect.objectContaining({ confirm: true })
      )
    )
    await waitFor(() => expect(onCleared).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalled()
  })

  it('explains the fields-only path when the peptide still occupies another slot', async () => {
    mockClear.mockResolvedValueOnce({
      ...PREVIEW,
      cascade: false,
      duplicate_elsewhere: true,
      identity_keyword: 'ID_GHKCU',
      cleared_peptide: 'GHK-Cu',
      impact: { pristine: [], worked_unverified: [], blocked: [] },
    })
    renderDialog({ peptideName: 'GHK-Cu' })

    expect(await screen.findByText(/also in another slot/i)).toBeInTheDocument()
    expect(screen.queryByText(/will be deleted/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/ID_GHKCU/)).not.toBeInTheDocument()
  })

  it('surfaces a 409 from the server as an error toast and keeps the dialog open', async () => {
    const err = Object.assign(new Error('2 result(s) are on a published COA'), {
      status: 409,
    })
    mockClear.mockResolvedValueOnce(PREVIEW).mockRejectedValueOnce(err)
    const { onCleared } = renderDialog()

    await screen.findByText(/5 never-worked vial rows/i)
    fireEvent.change(screen.getByLabelText(/type tp500 to confirm/i), {
      target: { value: 'TP500' },
    })
    fireEvent.click(screen.getByRole('button', { name: /clear slot 2/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(onCleared).not.toHaveBeenCalled()
  })
})
