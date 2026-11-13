import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as Api from '@/lib/api'
import type { Instrument } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof Api>()
  return {
    ...actual,
    getInstruments: vi.fn(),
    getMethods: vi.fn(),
    createInstrument: vi.fn(),
    updateInstrument: vi.fn(),
    getDepartments: vi.fn(),
  }
})

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import {
  createInstrument,
  getDepartments,
  getInstruments,
  getMethods,
  updateInstrument,
} from '@/lib/api'
import { InstrumentsPage } from '@/components/hplc/InstrumentsPage'

// The reader import stamps the instrument by the serial in the reader's
// export (spec 2026-10-10 3.5, 4.5), so the serial is set here.

const READER: Instrument = {
  id: 1,
  name: 'Nexgen-MCS',
  senaite_id: null,
  senaite_uid: null,
  instrument_type: 'Endotoxin reader',
  brand: null,
  model: null,
  active: true,
  department_id: null,
  origin: 'mk1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  serial_number: 'NX-1001',
}

describe('InstrumentsPage serial number', () => {
  beforeEach(() => {
    vi.mocked(getInstruments).mockReset().mockResolvedValue([READER])
    vi.mocked(getMethods).mockReset().mockResolvedValue([])
    vi.mocked(getDepartments).mockReset().mockResolvedValue([])
    vi.mocked(createInstrument).mockReset().mockResolvedValue(READER)
    vi.mocked(updateInstrument).mockReset().mockResolvedValue(READER)
  })

  it('shows the serial in the table and saves an edit', async () => {
    const user = userEvent.setup()
    render(<InstrumentsPage />)
    expect(await screen.findByText('NX-1001')).toBeInTheDocument()
    expect(
      screen.getByRole('columnheader', { name: 'Serial' })
    ).toBeInTheDocument()

    await user.click(screen.getByText('Nexgen-MCS'))
    await user.click(screen.getByRole('button', { name: /^edit$/i }))
    const serial = screen.getByLabelText('Serial number')
    // The server caps the serial at 100 characters (a longer one is a 422).
    expect(serial).toHaveAttribute('maxlength', '100')
    await user.clear(serial)
    await user.type(serial, 'NX-2002')
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(updateInstrument).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ serial_number: 'NX-2002' })
      )
    )
  })

  it('creates an instrument with its serial', async () => {
    const user = userEvent.setup()
    render(<InstrumentsPage />)
    await user.click(
      await screen.findByRole('button', { name: /add instrument/i })
    )
    await user.type(screen.getByLabelText(/name/i), 'Second reader')
    const serial = screen.getByLabelText('Serial number')
    expect(serial).toHaveAttribute('maxlength', '100')
    await user.type(serial, 'NX-3003')
    await user.click(screen.getByRole('button', { name: /^create$/i }))
    await waitFor(() =>
      expect(createInstrument).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Second reader',
          serial_number: 'NX-3003',
        })
      )
    )
  })
})
