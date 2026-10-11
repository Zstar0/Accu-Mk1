import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as Api from '@/lib/api'
import type { ConsumableKind, ConsumableType, Instrument } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof Api>()
  return {
    ...actual,
    listConsumables: vi.fn(),
    listConsumableKinds: vi.fn(),
    createConsumable: vi.fn(),
    updateConsumable: vi.fn(),
    getInstruments: vi.fn(),
  }
})

import {
  createConsumable,
  getInstruments,
  listConsumableKinds,
  listConsumables,
  updateConsumable,
} from '@/lib/api'
import { ConsumablesPage } from '@/components/hplc/ConsumablesPage'

const KIND: ConsumableKind = {
  key: 'endo_cartridge',
  label: 'Endotoxin cartridge',
  specs: [
    {
      key: 'sensitivity_eu_ml',
      label: 'Sensitivity',
      unit: 'EU/mL',
      type: 'positive_float',
      required: true,
    },
  ],
}
const USED: ConsumableType = {
  id: 1,
  kind: 'endo_cartridge',
  name: 'Endosafe 0.05',
  manufacturer: 'Example Co',
  part_number: 'PN-005',
  instrument_id: 3,
  specs: { sensitivity_eu_ml: 0.05 },
  active: true,
  in_use: true,
}
const FREE: ConsumableType = {
  ...USED,
  id: 2,
  name: 'Endosafe 0.01',
  part_number: 'PN-001',
  specs: { sensitivity_eu_ml: 0.01 },
  in_use: false,
}
const READER = { id: 3, name: 'Nexgen-MCS', active: true } as Instrument

describe('ConsumablesPage', () => {
  beforeEach(() => {
    vi.mocked(listConsumables).mockReset().mockResolvedValue([USED, FREE])
    vi.mocked(listConsumableKinds).mockReset().mockResolvedValue([KIND])
    vi.mocked(getInstruments).mockReset().mockResolvedValue([READER])
    vi.mocked(createConsumable).mockReset().mockResolvedValue(FREE)
    vi.mocked(updateConsumable).mockReset().mockResolvedValue(USED)
  })

  it("lists each type with its kind, instrument, the kind's numbers and whether it is used", async () => {
    render(<ConsumablesPage />)
    const row = (await screen.findByText('Endosafe 0.05')).closest('tr')
    if (!row) throw new Error('expected a table row')
    for (const text of [
      'Endotoxin cartridge',
      'Example Co',
      'PN-005',
      'Nexgen-MCS',
      '0.05',
      'Yes',
      'Active',
    ])
      expect(within(row).getByText(text)).toBeInTheDocument()
    expect(
      screen.getByRole('columnheader', { name: /sensitivity/i })
    ).toBeInTheDocument()
  })

  it("shows a used type's numbers read-only and never sends kind or specs for it", async () => {
    const user = userEvent.setup()
    render(<ConsumablesPage />)
    await user.click(await screen.findByText('Endosafe 0.05'))
    expect(
      screen.getByText('In use; retire and add a new one to change')
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Sensitivity (EU/mL)')).toBeNull()
    expect(screen.getByLabelText('Kind')).toBeDisabled()

    await user.type(screen.getByLabelText('Part number'), 'B')
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(updateConsumable).toHaveBeenCalledTimes(1))
    const [id, body] = vi.mocked(updateConsumable).mock.calls[0] ?? []
    expect(id).toBe(1)
    expect(body).toEqual({
      name: 'Endosafe 0.05',
      manufacturer: 'Example Co',
      part_number: 'PN-005B',
      instrument_id: 3,
      active: true,
    })
  })

  it('creates a type with its kind and numbers', async () => {
    const user = userEvent.setup()
    render(<ConsumablesPage />)
    // Add stays disabled until the kind registry has loaded with the rows.
    await screen.findByText('Endosafe 0.05')
    await user.click(screen.getByRole('button', { name: /add consumable/i }))
    await user.type(screen.getByLabelText('Name'), 'Endosafe 0.005')
    await user.type(screen.getByLabelText('Sensitivity (EU/mL)'), '0.005')
    await user.click(screen.getByRole('button', { name: /^create$/i }))
    await waitFor(() =>
      expect(createConsumable).toHaveBeenCalledWith({
        kind: 'endo_cartridge',
        name: 'Endosafe 0.005',
        manufacturer: null,
        part_number: null,
        instrument_id: null,
        specs: { sensitivity_eu_ml: 0.005 },
      })
    )
  })

  it('refuses a number at or below zero before sending anything', async () => {
    const user = userEvent.setup()
    render(<ConsumablesPage />)
    await screen.findByText('Endosafe 0.05')
    await user.click(screen.getByRole('button', { name: /add consumable/i }))
    await user.type(screen.getByLabelText('Name'), 'Bad')
    await user.type(screen.getByLabelText('Sensitivity (EU/mL)'), '0')
    await user.click(screen.getByRole('button', { name: /^create$/i }))
    expect(
      await screen.findByText('Sensitivity must be a number above zero')
    ).toBeInTheDocument()
    expect(createConsumable).not.toHaveBeenCalled()
  })

  it("caps the text fields at the server's column lengths", async () => {
    const user = userEvent.setup()
    render(<ConsumablesPage />)
    await screen.findByText('Endosafe 0.05')
    await user.click(screen.getByRole('button', { name: /add consumable/i }))
    expect(screen.getByLabelText('Name')).toHaveAttribute('maxLength', '200')
    expect(screen.getByLabelText('Manufacturer')).toHaveAttribute(
      'maxLength',
      '200'
    )
    expect(screen.getByLabelText('Part number')).toHaveAttribute(
      'maxLength',
      '100'
    )
  })
})
