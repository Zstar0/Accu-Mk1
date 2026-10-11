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

const picker = () => screen.getByLabelText('Run cartridge') as HTMLSelectElement

describe('EndoRunHeader', () => {
  it('switches the prep with one worksheet PUT', () => {
    const onUpdate = renderHeader()
    fireEvent.change(screen.getByLabelText('Prep'), {
      target: { value: 'stock' },
    })
    expect(onUpdate).toHaveBeenCalledWith({ endo_prep: 'stock' })
  })

  it('offers the allowed cartridges under the method default and never saves on its own', () => {
    const onUpdate = renderHeader()
    expect(Array.from(picker().options).map(o => o.text)).toEqual([
      'Method default (0.05)',
      '0.05 EU/mL',
      '0.01 EU/mL',
    ])
    expect(picker().value).toBe('')
    expect(onUpdate).not.toHaveBeenCalled()
    fireEvent.change(picker(), { target: { value: '2' } })
    expect(onUpdate).toHaveBeenCalledWith({ cartridge_type_id: 2 })
  })

  it('going back to the method default clears the run pick', () => {
    const onUpdate = renderHeader({
      cartridge_type_id: 2,
      cartridge_sensitivity_eu_ml: 0.01,
    })
    fireEvent.change(picker(), { target: { value: '' } })
    expect(onUpdate).toHaveBeenCalledWith({ cartridge_type_id: null })
  })

  it('keeps a retired run cartridge visible', () => {
    renderHeader({ cartridge_type_id: 4, cartridge_sensitivity_eu_ml: 0.02 })
    expect(picker().value).toBe('4')
    expect(
      screen.getByRole('option', { name: '0.02 EU/mL (not in the list)' })
    ).toBeInTheDocument()
  })

  it('names the method revision the numbers come from', () => {
    renderHeader()
    expect(screen.getByText('Endotoxin rev 3')).toBeInTheDocument()
  })

  it('a stock run shows only the prep', () => {
    renderHeader({ endo_prep: 'stock' })
    expect((screen.getByLabelText('Prep') as HTMLSelectElement).value).toBe(
      'stock'
    )
    expect(screen.queryByLabelText('Run cartridge')).toBeNull()
  })

  it('a completed run cannot be changed', () => {
    renderHeader({}, true)
    expect(screen.getByLabelText('Prep')).toBeDisabled()
    expect(picker()).toBeDisabled()
  })
})
