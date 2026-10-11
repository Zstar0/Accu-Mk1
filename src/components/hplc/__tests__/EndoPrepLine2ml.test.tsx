import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EndoPrepLine } from '@/components/hplc/EndoPrepLine'
import { getWorksheet, type WorksheetListItem } from '@/lib/api'
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
  render(
    <EndoPrepLine
      item={item}
      worksheet={ws}
      isCompleted={false}
      dueAt={null}
      onUpdate={onUpdate}
    />,
    { wrapper: wrap }
  )
  return { onUpdate }
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
    await waitFor(() => expect(getWorksheet).toHaveBeenCalledWith(77))
  })
})
