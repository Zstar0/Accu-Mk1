import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EndoPrepLine } from '@/components/hplc/EndoPrepLine'
import {
  getWorksheet,
  listConsumables,
  type WorksheetListItem,
} from '@/lib/api'
import type * as ApiModule from '@/lib/api'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import {
  endoItem,
  endoWorksheet,
} from '@/components/hplc/endo/__tests__/endo-fixtures'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getWorksheet: vi.fn(),
  listConsumables: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/hooks/use-lab-calendar', () => ({
  useLabCalendar: () => ({ calendar: null, isLoading: false }),
}))

function setup(ws: WorksheetListItem, item: WorksheetItemRow) {
  const onUpdate = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const { unmount } = render(
    <EndoPrepLine
      item={item}
      worksheet={ws}
      isCompleted={false}
      dueAt={null}
      onUpdate={onUpdate}
    />,
    { wrapper: wrap }
  )
  return { onUpdate, unmount }
}

describe('EndoPrepLine on a mixed worksheet', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the 2 mL water, total and cartridge when the worksheet is on 2 mL', () => {
    const item = endoItem({ sample_id: 'P-0001-S02' })
    const { onUpdate } = setup(endoWorksheet([item]), item)
    expect(screen.getByLabelText('Water (mL)')).toHaveAttribute(
      'placeholder',
      '2'
    )
    expect(screen.getByLabelText('Total (1:N)')).toHaveAttribute(
      'placeholder',
      '250'
    )
    expect(screen.getByText('0.05')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Water (mL)'), {
      target: { value: '3' },
    })
    fireEvent.blur(screen.getByLabelText('Water (mL)'))
    expect(onUpdate).toHaveBeenCalledWith({ prep_water_ml: 3 })
    expect(getWorksheet).not.toHaveBeenCalled()
  })

  // Spec 6.3: the same prep inputs as Box 1, whose 2 mL row edits the
  // declared weight; a mixed worksheet has no page to correct it on.
  it('edits the declared weight on the 2 mL line, as Box 1 does', () => {
    const item = endoItem({ sample_id: 'P-0001-S02' })
    const { onUpdate } = setup(endoWorksheet([item]), item)
    const weight = screen.getByLabelText('Weight (mg)')
    expect(weight).toHaveValue(10)
    fireEvent.change(weight, { target: { value: '12' } })
    fireEvent.blur(weight)
    expect(onUpdate).toHaveBeenCalledWith({ prep_weight_mg: 12 })
  })

  it('keeps the stock line on a stock worksheet', () => {
    const item = endoItem({ sample_id: 'P-0001-S02' })
    setup(endoWorksheet([item], { endo_prep: 'stock' }), item)
    expect(screen.getByLabelText('Weight (mg)')).toBeInTheDocument()
    expect(screen.queryByLabelText('Water (mL)')).not.toBeInTheDocument()
  })

  it('reads the run settings by id when it was handed the list payload', async () => {
    const item = endoItem({ sample_id: 'P-0001-S02' })
    const full = endoWorksheet([item])
    vi.mocked(getWorksheet).mockResolvedValue(full)
    setup({ ...full, endo_method: undefined }, item)
    // Nothing is typed until the method lands.
    expect(screen.queryByLabelText('Water (mL)')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Cartridge for this sample')).toBeDisabled()
    await waitFor(() => expect(getWorksheet).toHaveBeenCalledWith(77))
    expect(await screen.findByLabelText('Water (mL)')).toBeEnabled()
    expect(screen.getByLabelText('Cartridge for this sample')).toBeEnabled()
  })

  // Spec 4.3: a method that links no cartridges allows every active endo
  // cartridge, from the catalog, as the page and the server do.
  it('offers the catalog when the method links no cartridges', async () => {
    vi.mocked(listConsumables).mockResolvedValueOnce([
      {
        id: 5,
        kind: 'endo_cartridge',
        name: 'Endosafe 0.005',
        manufacturer: null,
        part_number: null,
        instrument_id: null,
        specs: { sensitivity_eu_ml: 0.005 },
        active: true,
        in_use: false,
      },
    ])
    const item = endoItem({ sample_id: 'P-0001-S02' })
    const base = endoWorksheet([item])
    const method = base.endo_method
    if (!method) throw new Error('fixture has a method')
    setup({ ...base, endo_method: { ...method, cartridges: [] } }, item)
    expect(
      await screen.findByRole('option', { name: '0.005' })
    ).toBeInTheDocument()
    expect(listConsumables).toHaveBeenCalledWith({ kind: 'endo_cartridge' })
  })

  it('shows the water used, and typing the default sends nothing', () => {
    const item = endoItem({ sample_id: 'P-0001-S02' })
    const { onUpdate } = setup(endoWorksheet([item]), item)
    const water = screen.getByLabelText('Water (mL)')
    expect(water).toHaveValue(2)
    fireEvent.change(water, { target: { value: '2' } })
    fireEvent.blur(water)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('sends the standard total as null, and nothing when it is already standard', () => {
    const own = endoItem({ sample_id: 'P-0001-S02', prep_total_dilution: 500 })
    const first = setup(endoWorksheet([own]), own)
    fireEvent.change(screen.getByLabelText('Total (1:N)'), {
      target: { value: '250' },
    })
    fireEvent.blur(screen.getByLabelText('Total (1:N)'))
    expect(first.onUpdate).toHaveBeenCalledWith({ prep_total_dilution: null })
    first.unmount()

    const std = endoItem({ sample_id: 'P-0002-S02' })
    const second = setup(endoWorksheet([std]), std)
    fireEvent.change(screen.getByLabelText('Total (1:N)'), {
      target: { value: '250' },
    })
    fireEvent.blur(screen.getByLabelText('Total (1:N)'))
    expect(second.onUpdate).not.toHaveBeenCalled()
  })

  it('sends Form Auto as null', () => {
    const item = endoItem({ sample_id: 'P-0001-S02', prep_form: 'liquid' })
    const { onUpdate } = setup(endoWorksheet([item]), item)
    fireEvent.change(screen.getByLabelText('Form'), { target: { value: '' } })
    expect(onUpdate).toHaveBeenCalledWith({ prep_form: null })
  })

  // Spec 6.3 (ruling, fix round 1): the row's cartridge is picked here as in
  // Box 1; a mixed worksheet has no page to pick it on.
  it("picks the row's cartridge as Box 1 does: an id, or null for the run's", () => {
    const item = endoItem({ sample_id: 'P-0001-S02' })
    const first = setup(endoWorksheet([item]), item)
    const picker = screen.getByLabelText('Cartridge for this sample')
    expect(picker).toHaveValue('')
    expect(
      screen.getByRole('option', { name: 'run (0.05)' })
    ).toBeInTheDocument()
    fireEvent.change(picker, { target: { value: '4' } })
    expect(first.onUpdate).toHaveBeenCalledWith({ cartridge_type_id: 4 })
    first.unmount()

    // A retired pick stays visible, never offered; back to the run's is null.
    const retired = endoItem({
      sample_id: 'P-0002-S02',
      cartridge_type_id: 9,
      cartridge_sensitivity_eu_ml: 0.1,
    })
    const second = setup(endoWorksheet([retired]), retired)
    const own = screen.getByLabelText('Cartridge for this sample')
    expect(own).toHaveValue('9')
    expect(
      screen.getByRole('option', { name: '0.1 (not in the list)' })
    ).toBeInTheDocument()
    fireEvent.change(own, { target: { value: '' } })
    expect(second.onUpdate).toHaveBeenCalledWith({ cartridge_type_id: null })
  })
})
