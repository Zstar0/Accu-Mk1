import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EndoPrepLine } from '@/components/hplc/EndoPrepLine'
import {
  getEndoPrepRules,
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
  getEndoPrepRules: vi.fn().mockResolvedValue([]),
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

const cartridgePicker = () =>
  screen.getByRole('combobox', { name: 'Cartridge for this sample' })

// Radix Select under jsdom: fireEvent, not userEvent (no hasPointerCapture),
// as worksheet-apply-method.test.tsx does.
async function pick(trigger: HTMLElement, option: string) {
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('option', { name: option }))
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
    expect(cartridgePicker()).toHaveTextContent(/^run \(0\.05\)$/)
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
    await waitFor(() =>
      expect(listConsumables).toHaveBeenCalledWith({ kind: 'endo_cartridge' })
    )
    fireEvent.click(cartridgePicker())
    expect(
      await screen.findByRole('option', { name: '0.005' })
    ).toBeInTheDocument()
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

  it('sends Form Auto as null, labelled with what Auto resolves to, not the hand-set form', async () => {
    const item = endoItem({ sample_id: 'P-0001-S02', prep_form: 'liquid' })
    const { onUpdate } = setup(endoWorksheet([item]), item)
    const form = screen.getByRole('combobox', { name: 'Form' })
    expect(form).toHaveTextContent(/^Liquid \(reconstituted\)$/)
    // A peptide with no form of its own reads as lyophilized.
    await pick(form, 'Auto (Lyophilized)')
    expect(onUpdate).toHaveBeenCalledWith({ prep_form: null })
  })

  it("labels bac water's Auto as bac water even when set by hand to powder", async () => {
    const item = endoItem({ sample_id: 'BW-0114-S02', prep_form: 'powder' })
    setup(endoWorksheet([item]), item)
    fireEvent.click(screen.getByRole('combobox', { name: 'Form' }))
    expect(
      await screen.findByRole('option', { name: 'Auto (Bacteriostatic water)' })
    ).toBeInTheDocument()
  })

  // Spec 6.3 (ruling, fix round 1): the row's cartridge is picked here as in
  // Box 1; a mixed worksheet has no page to pick it on.
  it("picks the row's cartridge as Box 1 does: an id, or null for the run's", async () => {
    const item = endoItem({ sample_id: 'P-0001-S02' })
    const first = setup(endoWorksheet([item]), item)
    expect(cartridgePicker()).toHaveTextContent(/^run \(0\.05\)$/)
    await pick(cartridgePicker(), '0.01')
    expect(first.onUpdate).toHaveBeenCalledWith({ cartridge_type_id: 4 })
    first.unmount()

    // A retired pick stays visible, never offered; back to the run's is null.
    const retired = endoItem({
      sample_id: 'P-0002-S02',
      cartridge_type_id: 9,
      cartridge_sensitivity_eu_ml: 0.1,
    })
    const second = setup(endoWorksheet([retired]), retired)
    expect(cartridgePicker()).toHaveTextContent(/^0\.1 \(not in the list\)$/)
    await pick(cartridgePicker(), 'run (0.05)')
    expect(second.onUpdate).toHaveBeenCalledWith({ cartridge_type_id: null })
  })

  // Slice 5: the rule's total and cartridge are the row's defaults; the
  // method's 1:250 typed on a ruled row is a value of its own (D6).
  it("shows a ruled row's total and cartridge, and keeps the standard typed over the rule", async () => {
    vi.mocked(getEndoPrepRules).mockResolvedValueOnce([
      {
        id: 1,
        peptide_id: 7,
        min_mg: null,
        max_mg: null,
        recon_water_ml: null,
        total_dilution: 300,
        step1_ratio: null,
        cartridge_type_id: 4,
        status: 'trial',
        note: null,
        sort_order: 1,
        active: true,
        peptide_name: 'Retatrutide',
        cartridge_name: 'Endosafe 0.01',
        updated_at: null,
      },
    ])
    const item = endoItem({ sample_id: 'P-0001-S02', sample_peptide_id: 7 })
    const { onUpdate } = setup(endoWorksheet([item]), item)
    const total = screen.getByLabelText('Total (1:N)')
    await waitFor(() => expect(total).toHaveAttribute('placeholder', '300'))
    expect(cartridgePicker()).toHaveTextContent(/^rule \(0\.01\)$/)
    fireEvent.change(total, { target: { value: '300' } })
    fireEvent.blur(total)
    expect(onUpdate).not.toHaveBeenCalled()
    fireEvent.change(total, { target: { value: '250' } })
    fireEvent.blur(total)
    expect(onUpdate).toHaveBeenCalledWith({ prep_total_dilution: 250 })
  })
})
