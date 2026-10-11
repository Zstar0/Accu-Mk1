import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EndoWorksheetActions } from '@/components/hplc/EndoWorksheetActions'
import {
  getWorksheet,
  listConsumables,
  type ConsumableType,
  type WorksheetListItem,
} from '@/lib/api'
import type * as ApiModule from '@/lib/api'
import type * as SlaSubjects from '@/services/sla-subjects'
import {
  endoItem,
  endoWorksheet,
} from '@/components/hplc/endo/__tests__/endo-fixtures'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  getWorksheet: vi.fn(),
  listConsumables: vi.fn(),
  recordWorksheetPrinted: vi.fn(),
}))
vi.mock('@/hooks/use-lab-calendar', () => ({
  useLabCalendar: () => ({
    calendar: {
      timezone: 'America/Denver',
      workingDays: [0, 1, 2, 3, 4],
      holidays: new Map(),
    },
    isLoading: false,
  }),
}))
const sla = vi.hoisted(() => ({ isLoading: false }))
vi.mock('@/services/sla-subjects', async importOriginal => ({
  ...(await importOriginal<typeof SlaSubjects>()),
  useSlaForSubjects: () => ({
    byKey: new Map(),
    isLoading: sla.isLoading,
    isError: false,
  }),
}))

const cartridge9: ConsumableType = {
  id: 9,
  kind: 'endo_cartridge',
  name: 'Endosafe 0.05',
  manufacturer: null,
  part_number: null,
  instrument_id: null,
  specs: { sensitivity_eu_ml: 0.05 },
  active: true,
  in_use: true,
}

/** The list payload: no endo_method key at all. */
function listPayload(ws: WorksheetListItem): WorksheetListItem {
  const copy = { ...ws }
  delete copy.endo_method
  return copy
}

function renderActions(worksheet: WorksheetListItem) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  render(<EndoWorksheetActions worksheet={worksheet} users={[]} />, {
    wrapper,
  })
  return qc
}

const FAILED = 'Could not load the run settings; reopen to try again'

function previewHtml(): string {
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
  return screen.getByTitle('Bench sheet preview').getAttribute('srcdoc') ?? ''
}

describe('EndoWorksheetActions', () => {
  beforeEach(() => {
    vi.mocked(getWorksheet).mockReset()
    vi.mocked(listConsumables).mockReset().mockResolvedValue([])
    sla.isLoading = false
  })

  it('builds the stock sheet on a stock worksheet, with no extra reads', () => {
    renderActions(
      listPayload(endoWorksheet([endoItem()], { endo_prep: 'stock' }))
    )
    const html = previewHtml()
    expect(html).toContain('Volume to add')
    expect(html).not.toContain('Step 1 &middot; Tris')
    expect(getWorksheet).not.toHaveBeenCalled()
    expect(listConsumables).not.toHaveBeenCalled()
  })

  it('reads GET /worksheets/{id} for a 2 mL list payload, then builds the 2 mL sheet', async () => {
    const full = endoWorksheet([endoItem()])
    vi.mocked(getWorksheet).mockResolvedValue(full)
    renderActions(listPayload(full))
    const preview = screen.getByRole('button', { name: 'Preview' })
    expect(preview).toBeDisabled()
    expect(preview).toHaveAttribute('title', 'Loading the run settings…')
    await waitFor(() => expect(preview).toBeEnabled())
    expect(getWorksheet).toHaveBeenCalledWith(77)
    const html = previewHtml()
    expect(html).toContain('Step 1 &middot; Tris')
    expect(html).not.toContain('Volume to add')
  })

  it('waits for the catalog when the method links no cartridges', async () => {
    let resolve: (c: ConsumableType[]) => void = () => undefined
    vi.mocked(listConsumables).mockReturnValue(
      new Promise(r => {
        resolve = r
      })
    )
    const base = endoWorksheet([endoItem()])
    renderActions(
      endoWorksheet([endoItem()], {
        cartridge_type_id: 9,
        cartridge_sensitivity_eu_ml: null,
        endo_method: base.endo_method && {
          ...base.endo_method,
          cartridges: [],
        },
      })
    )
    const preview = screen.getByRole('button', { name: 'Preview' })
    expect(preview).toBeDisabled()
    resolve([cartridge9])
    await waitFor(() => expect(preview).toBeEnabled())
    expect(getWorksheet).not.toHaveBeenCalled()
    // The run cartridge resolves from the catalog, not to "-".
    expect(previewHtml()).toContain('<dt>Cartridge</dt><dd>0.05 EU/mL</dd>')
  })

  it('says the run settings failed when GET /worksheets/{id} fails with nothing on hand', async () => {
    vi.mocked(getWorksheet).mockRejectedValue(
      new Error('Get worksheet failed: 500')
    )
    renderActions(listPayload(endoWorksheet([endoItem()])))
    const preview = screen.getByRole('button', { name: 'Preview' })
    await waitFor(() => expect(preview).toHaveAttribute('title', FAILED))
    expect(preview).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'CSV' })).toBeDisabled()
  })

  it('keeps the buttons when a background refetch fails with the worksheet on hand', async () => {
    const full = endoWorksheet([endoItem()])
    vi.mocked(getWorksheet).mockResolvedValue(full)
    const qc = renderActions(listPayload(full))
    const preview = screen.getByRole('button', { name: 'Preview' })
    await waitFor(() => expect(preview).toBeEnabled())
    vi.mocked(getWorksheet).mockRejectedValue(
      new Error('Get worksheet failed: 500')
    )
    await qc.invalidateQueries({ queryKey: ['worksheets-list'] })
    // let react-query notify and React re-render with the failed refetch
    await act(() => new Promise(r => setTimeout(r, 20)))
    expect(qc.getQueryState(['worksheets-list', 'page', 77])?.status).toBe(
      'error'
    )
    expect(preview).toBeEnabled()
    expect(previewHtml()).toContain('Step 1 &middot; Tris')
  })

  it('does not wait on a failed catalog when the method links its cartridges', async () => {
    vi.mocked(listConsumables).mockRejectedValue(new Error('List failed: 500'))
    const qc = renderActions(endoWorksheet([endoItem()]))
    await waitFor(() =>
      expect(qc.getQueryState(['consumables', 'endo_cartridge'])?.status).toBe(
        'error'
      )
    )
    for (const name of ['Preview', 'Print', 'CSV'])
      expect(screen.getByRole('button', { name })).toBeEnabled()
  })

  it('waits for the SLA due dates on stock and 2 mL alike', () => {
    sla.isLoading = true
    renderActions(endoWorksheet([endoItem()], { endo_prep: 'stock' }))
    renderActions(endoWorksheet([endoItem()]))
    const previews = screen.getAllByRole('button', { name: 'Preview' })
    expect(previews).toHaveLength(2)
    for (const b of previews) {
      expect(b).toBeDisabled()
      expect(b).toHaveAttribute('title', 'Loading the SLA due dates…')
    }
  })
})
