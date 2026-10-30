import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { EndoMethodInfo, WorksheetListItem } from '@/lib/api'
import { allowedCartridges } from '@/lib/endo-worksheet-2ml'
import { EndoRunHeader } from '@/components/hplc/endo/EndoRunHeader'

const METHOD: EndoMethodInfo = {
  id: 9,
  name: 'Endotoxin',
  revision: 3,
  status: 'active',
  run_parameters: null,
  cartridges: [
    {
      id: 1,
      name: 'Endosafe 0.05',
      sensitivity_eu_ml: 0.05,
      is_default: true,
      active: true,
    },
    {
      id: 2,
      name: 'Endosafe 0.01',
      sensitivity_eu_ml: 0.01,
      is_default: false,
      active: true,
    },
  ],
}

function renderHeader(
  over: Partial<WorksheetListItem> = {},
  isCompleted = false
) {
  const worksheet = {
    id: 5,
    title: 'Endo 10/10/2026',
    status: isCompleted ? 'completed' : 'open',
    items: [],
    endo_prep: '2ml',
    cartridge_type_id: null,
    cartridge_sensitivity_eu_ml: null,
    endo_method_id: null,
    endo_method: METHOD,
    ...over,
  } as WorksheetListItem
  const onUpdate = vi.fn()
  render(
    <div>
      <EndoRunHeader
        worksheet={worksheet}
        cartridges={allowedCartridges(worksheet)}
        isCompleted={isCompleted}
        onUpdate={onUpdate}
      />
    </div>
  )
  return onUpdate
}

const picker = () => screen.getByRole('combobox', { name: 'Run cartridge' })

// Radix Select under jsdom: fireEvent, not userEvent (no hasPointerCapture),
// as worksheet-apply-method.test.tsx does.
async function open(trigger: HTMLElement) {
  fireEvent.click(trigger)
  return (await screen.findAllByRole('option')).map(o => o.textContent)
}
async function pick(trigger: HTMLElement, option: string) {
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

describe('EndoRunHeader', () => {
  it('switches the prep with one worksheet PUT', async () => {
    const onUpdate = renderHeader()
    await pick(screen.getByRole('combobox', { name: 'Prep' }), '1 mg/mL stock')
    expect(onUpdate).toHaveBeenCalledWith({ endo_prep: 'stock' })
  })

  it('offers the allowed cartridges under the method default and never saves on its own', async () => {
    const onUpdate = renderHeader()
    expect(picker()).toHaveTextContent(/^Method default \(0\.05\)$/)
    expect(await open(picker())).toEqual([
      'Method default (0.05)',
      '0.05 EU/mL',
      '0.01 EU/mL',
    ])
    expect(onUpdate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('option', { name: '0.01 EU/mL' }))
    expect(onUpdate).toHaveBeenCalledWith({ cartridge_type_id: 2 })
  })

  it('going back to the method default clears the run pick', async () => {
    const onUpdate = renderHeader({
      cartridge_type_id: 2,
      cartridge_sensitivity_eu_ml: 0.01,
    })
    expect(picker()).toHaveTextContent(/^0\.01 EU\/mL$/)
    await pick(picker(), 'Method default (0.05)')
    expect(onUpdate).toHaveBeenCalledWith({ cartridge_type_id: null })
  })

  it('keeps a retired run cartridge visible', async () => {
    renderHeader({ cartridge_type_id: 4, cartridge_sensitivity_eu_ml: 0.02 })
    expect(picker()).toHaveTextContent(/^0\.02 EU\/mL \(not in the list\)$/)
    expect(await open(picker())).toContain('0.02 EU/mL (not in the list)')
  })

  it('names the method revision the numbers come from', () => {
    renderHeader()
    expect(screen.getByText('Endotoxin rev 3')).toBeInTheDocument()
  })

  it('a stock run shows only the prep', () => {
    renderHeader({ endo_prep: 'stock' })
    expect(screen.getByRole('combobox', { name: 'Prep' })).toHaveTextContent(
      /^1 mg\/mL stock$/
    )
    expect(screen.queryByLabelText('Run cartridge')).toBeNull()
  })

  it('a completed run cannot be changed', () => {
    renderHeader({}, true)
    expect(screen.getByLabelText('Prep')).toBeDisabled()
    expect(picker()).toBeDisabled()
  })
})
