/**
 * Task 7 (methods bench-stamping): per-row method/instrument override dialog
 * for native (mk1:) analysis rows. Mirrors PromoteDialog's standalone-render
 * style (no QueryClientProvider — the dialog fetches methods itself via a
 * plain useEffect, not react-query).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', () => ({
  getMethods: vi.fn(),
  stampAnalysisMethodInstrument: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { getMethods, stampAnalysisMethodInstrument } from '@/lib/api'
import { toast } from 'sonner'
import { SetMethodInstrumentDialog } from '@/components/senaite/SetMethodInstrumentDialog'

const METHOD = {
  id: 11,
  name: 'ICP-MS G',
  senaite_id: null,
  code: 'AM-G-1',
  active: true,
  instrument_ids: [3],
  instruments: [{ id: 3, name: '7900G', model: null }],
  size_peptide: null,
  starting_organic_pct: null,
  temperature_mct_c: null,
  dissolution: null,
  notes: null,
  technique: null,
  department_id: null,
  reference: null,
  procedure_summary: null,
  supersedes_id: null,
  origin: 'native',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  common_peptides: [],
  services: [
    {
      analysis_service_id: 5,
      keyword: 'LEAD-PPM',
      title: 'Lead',
      is_default: true,
    },
  ],
}

describe('SetMethodInstrumentDialog', () => {
  beforeEach(() => {
    vi.mocked(getMethods).mockReset()
    vi.mocked(stampAnalysisMethodInstrument).mockReset()
    vi.mocked(toast.success).mockReset()
    vi.mocked(toast.error).mockReset()
  })

  it('preselects the default method and saves', async () => {
    vi.mocked(getMethods).mockResolvedValue([METHOD] as never)
    vi.mocked(stampAnalysisMethodInstrument).mockResolvedValue({} as never)
    const user = userEvent.setup()
    const onSaved = vi.fn()
    render(
      <SetMethodInstrumentDialog
        analysisId={99}
        serviceId={5}
        currentMethodId={null}
        currentInstrumentId={null}
        open
        onOpenChange={vi.fn()}
        onSaved={onSaved}
      />
    )

    expect(await screen.findByText(/am-g-1|icp-ms g/i)).toBeInTheDocument() // default preselected

    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() =>
      expect(stampAnalysisMethodInstrument).toHaveBeenCalledWith(
        99,
        expect.objectContaining({ method_id: 11 })
      )
    )
    expect(toast.success).toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalled()
  })

  it('surfaces state_locked as a friendly error', async () => {
    vi.mocked(getMethods).mockResolvedValue([METHOD] as never)
    vi.mocked(stampAnalysisMethodInstrument).mockRejectedValue(
      Object.assign(new Error('409'), { detail: { code: 'state_locked' } })
    )
    const user = userEvent.setup()
    render(
      <SetMethodInstrumentDialog
        analysisId={99}
        serviceId={5}
        currentMethodId={null}
        currentInstrumentId={null}
        open
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    )

    await user.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringMatching(/already reported/i)
      )
    )
  })

  it('renders with no crash when no methods cover this service', async () => {
    vi.mocked(getMethods).mockResolvedValue([] as never)
    render(
      <SetMethodInstrumentDialog
        analysisId={7}
        serviceId={999}
        currentMethodId={null}
        currentInstrumentId={null}
        open
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    )
    // Loading resolves; no crash, Save still present.
    expect(
      await screen.findByRole('button', { name: /save/i })
    ).toBeInTheDocument()
    // No covering methods -> no default preselection text rendered.
    expect(screen.queryByText(/am-g-1|icp-ms g/i)).not.toBeInTheDocument()
  })
})
