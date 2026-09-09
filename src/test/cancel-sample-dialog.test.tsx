import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CancelSampleDialog } from '@/components/senaite/CancelSampleDialog'
import type * as ApiModule from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return { ...actual, cancelSample: vi.fn() }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { cancelSample } from '@/lib/api'
import { toast } from 'sonner'
const mockCancel = vi.mocked(cancelSample)

const PREVIEW = {
  status: 'published',
  from_status: 'published',
  cancelled_rows: [1, 2],
  released_worksheets: [7],
  published_coa_still_live: true,
  dry_run: true as const,
}
const RESULT = { ...PREVIEW, status: 'cancelled', dry_run: false as const }

function renderDialog(
  overrides: { currentStatus?: string; statusAuthority?: 'senaite' | 'mk1' } = {}
) {
  const onClose = vi.fn()
  const onCancelled = vi.fn()
  render(
    <CancelSampleDialog
      open
      sampleId="PB-0001"
      currentStatus={overrides.currentStatus ?? 'published'}
      statusAuthority={overrides.statusAuthority}
      onClose={onClose}
      onCancelled={onCancelled}
    />
  )
  return { onClose, onCancelled }
}

beforeEach(() => vi.clearAllMocks())

describe('CancelSampleDialog', () => {
  it('previews on open, warns about the live COA, and needs reason + typed id', async () => {
    mockCancel.mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce(RESULT)
    const { onCancelled } = renderDialog()
    await waitFor(() =>
      expect(mockCancel).toHaveBeenCalledWith(
        'PB-0001',
        expect.objectContaining({ dryRun: true })
      )
    )
    expect(
      await screen.findByText(/2 pending results will be cancelled/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/1 worksheet/i)).toBeInTheDocument()
    expect(
      screen.getByText(/published certificate .* stay live/i)
    ).toBeInTheDocument()
    const button = screen.getByRole('button', { name: /^cancel sample$/i })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: 'Customer withdrew the order' },
    })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/type pb-0001 to confirm/i), {
      target: { value: 'pb-0001' },
    })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() =>
      expect(mockCancel).toHaveBeenLastCalledWith(
        'PB-0001',
        expect.objectContaining({
          confirm: true,
          reason: 'Customer withdrew the order',
        })
      )
    )
    await waitFor(() => expect(onCancelled).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalled()
  })

  it('surfaces a server error as a toast and keeps the dialog open', async () => {
    mockCancel
      .mockResolvedValueOnce({ ...PREVIEW, published_coa_still_live: false })
      .mockRejectedValueOnce(
        Object.assign(new Error('no cancel edge'), { status: 409 })
      )
    const { onCancelled } = renderDialog()
    await screen.findByText(/2 pending results/i)
    fireEvent.change(screen.getByLabelText(/reason/i), {
      target: { value: 'Customer withdrew' },
    })
    fireEvent.change(screen.getByLabelText(/type pb-0001 to confirm/i), {
      target: { value: 'PB-0001' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^cancel sample$/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(onCancelled).not.toHaveBeenCalled()
  })

  it('shows the senaite-mode note by default and the post-verification wording for published samples', async () => {
    mockCancel.mockResolvedValueOnce(PREVIEW)
    renderDialog({ currentStatus: 'published' })
    await screen.findByText(/2 pending results/i)
    expect(screen.getByTestId('senaite-mode-note')).toHaveTextContent(
      /does not allow cancel after verification/i
    )
  })

  it('hides the senaite-mode note under Accu-Mk1 authority', async () => {
    mockCancel.mockResolvedValueOnce(PREVIEW)
    renderDialog({ statusAuthority: 'mk1' })
    await screen.findByText(/2 pending results/i)
    expect(
      screen.getByText(/Cancelling stops all pending work/i)
    ).toBeInTheDocument()
    expect(screen.queryByTestId('senaite-mode-note')).toBeNull()
  })
})
