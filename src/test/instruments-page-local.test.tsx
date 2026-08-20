import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Instrument, HplcMethod } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getInstruments: vi.fn(),
    syncInstruments: vi.fn(),
    getMethods: vi.fn(),
    createInstrument: vi.fn(),
    updateInstrument: vi.fn(),
    getDepartments: vi.fn(),
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import {
  getInstruments,
  syncInstruments,
  getMethods,
  createInstrument,
  updateInstrument,
  getDepartments,
} from '@/lib/api'
import { InstrumentsPage } from '@/components/hplc/InstrumentsPage'

const INSTRUMENT: Instrument = {
  id: 1,
  name: 'Agilent 1260 Infinity',
  senaite_id: null,
  senaite_uid: null,
  instrument_type: 'HPLC',
  brand: 'Agilent',
  model: '1260 Infinity',
  active: true,
  department_id: null,
  origin: 'mk1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const METHOD: HplcMethod = {
  id: 1,
  name: 'Elemental Impurities by ICP-MS',
  senaite_id: null,
  instrument_ids: [],
  instruments: [],
  size_peptide: null,
  starting_organic_pct: null,
  temperature_mct_c: null,
  dissolution: null,
  notes: null,
  code: 'AM-ELEM-001',
  technique: 'ICP-MS',
  department_id: null,
  reference: null,
  procedure_summary: null,
  supersedes_id: null,
  origin: 'mk1',
  active: true,
  status: 'active',
  revision: 1,
  activated_at: null,
  retired_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  common_peptides: [],
  services: [],
}

describe('InstrumentsPage — local add/edit, sync demoted', () => {
  beforeEach(() => {
    vi.mocked(getInstruments).mockReset().mockResolvedValue([INSTRUMENT])
    vi.mocked(syncInstruments)
      .mockReset()
      .mockResolvedValue({ created: 0, total: 1 })
    vi.mocked(getMethods).mockReset().mockResolvedValue([METHOD])
    vi.mocked(createInstrument).mockReset().mockResolvedValue(INSTRUMENT)
    vi.mocked(updateInstrument).mockReset().mockResolvedValue(INSTRUMENT)
    vi.mocked(getDepartments).mockReset().mockResolvedValue([])
  })

  it('offers Add Instrument as the primary action and demotes sync', async () => {
    render(<InstrumentsPage />)
    expect(
      await screen.findByRole('button', { name: /add instrument/i })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /legacy/i })).toBeInTheDocument() // sync relabeled
    expect(
      screen.queryByText(/synced from senaite lims/i)
    ).not.toBeInTheDocument()
  })

  it('creates a local instrument', async () => {
    const user = userEvent.setup()
    vi.mocked(createInstrument).mockResolvedValue({
      id: 9,
      name: 'Agilent 7900 ICP-MS',
    } as never)
    render(<InstrumentsPage />)
    await user.click(
      await screen.findByRole('button', { name: /add instrument/i })
    )
    await user.type(screen.getByLabelText(/name/i), 'Agilent 7900 ICP-MS')
    await user.type(screen.getByLabelText(/type/i), 'ICP-MS')
    await user.click(screen.getByRole('button', { name: /^create$/i }))
    await waitFor(() =>
      expect(createInstrument).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Agilent 7900 ICP-MS',
          instrument_type: 'ICP-MS',
        })
      )
    )
  })

  it('edits an instrument in place and shows Origin/Department in the read-only panel', async () => {
    const user = userEvent.setup()
    vi.mocked(updateInstrument).mockResolvedValue({
      ...INSTRUMENT,
      brand: 'Waters',
    })
    render(<InstrumentsPage />)
    await user.click(await screen.findByText('Agilent 1260 Infinity'))

    expect(screen.getByText('Origin')).toBeInTheDocument()
    expect(screen.getByText('Mk1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^edit$/i }))
    const brandInput = screen.getByLabelText(/brand/i)
    await user.clear(brandInput)
    await user.type(brandInput, 'Waters')
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(updateInstrument).toHaveBeenCalledWith(
        INSTRUMENT.id,
        expect.objectContaining({ brand: 'Waters' })
      )
    )
  })

  it('renders SENAITE (legacy) origin label for synced instruments', async () => {
    vi.mocked(getInstruments).mockResolvedValue([
      { ...INSTRUMENT, origin: 'senaite' },
    ])
    const user = userEvent.setup()
    render(<InstrumentsPage />)
    await user.click(await screen.findByText('Agilent 1260 Infinity'))
    expect(screen.getByText('SENAITE (legacy)')).toBeInTheDocument()
  })
})
