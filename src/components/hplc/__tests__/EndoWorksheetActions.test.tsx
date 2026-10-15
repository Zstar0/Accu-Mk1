import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import { EndoWorksheetActions } from '@/components/hplc/EndoWorksheetActions'
import {
  getEndoPrepRules,
  getWorksheet,
  listConsumables,
  recordWorksheetPrinted,
  type ConsumableType,
  type EndoPrepRuleOut,
  type WorksheetListItem,
} from '@/lib/api'
import type { EndoPrepRule } from '@/lib/endo-prep-rules'
import { printHtmlDocument } from '@/lib/print-document'
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
  getEndoPrepRules: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/print-document', () => ({
  printHtmlDocument: vi.fn(),
  downloadTextFile: vi.fn(),
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
    vi.mocked(getEndoPrepRules).mockReset().mockResolvedValue([])
    vi.mocked(recordWorksheetPrinted).mockReset()
    vi.mocked(printHtmlDocument).mockClear()
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

  describe('Print records first, then prints the rows as the server locked them', () => {
    const r300: EndoPrepRuleOut = {
      id: 1,
      peptide_id: 7,
      min_mg: null,
      max_mg: null,
      total_dilution: 300,
      step1_ratio: null,
      cartridge_type_id: null,
      status: 'trial',
      note: null,
      sort_order: 1,
      active: true,
      peptide_name: 'Retatrutide',
      cartridge_name: null,
      updated_at: null,
    }
    const recorded = { printed_at: '2026-10-14T15:00:00Z', print_count: 1 }
    const lockedTo = (rule: EndoPrepRule | null) => ({
      rule,
      locked_at: '2026-10-14T15:00:00Z',
      locked_by: 'print' as const,
      user_id: 5,
    })
    const firstCall = (f: { mock: { invocationCallOrder: number[] } }) =>
      f.mock.invocationCallOrder[0] ?? -1

    it('calls /printed, then reads the worksheet back, then opens the print window', async () => {
      const item = endoItem({ sample_peptide_id: 7 })
      vi.mocked(recordWorksheetPrinted).mockResolvedValue(recorded)
      vi.mocked(getWorksheet).mockResolvedValue(
        endoWorksheet([{ ...item, prep_rule: lockedTo(null) }])
      )
      renderActions(endoWorksheet([item]))
      const print = screen.getByRole('button', { name: 'Print' })
      await waitFor(() => expect(print).toBeEnabled())
      fireEvent.click(print)
      await waitFor(() => expect(printHtmlDocument).toHaveBeenCalledTimes(1))
      expect(recordWorksheetPrinted).toHaveBeenCalledWith(77)
      expect(getWorksheet).toHaveBeenCalledWith(77)
      expect(firstCall(vi.mocked(recordWorksheetPrinted))).toBeLessThan(
        firstCall(vi.mocked(getWorksheet))
      )
      expect(firstCall(vi.mocked(getWorksheet))).toBeLessThan(
        firstCall(vi.mocked(printHtmlDocument))
      )
    })

    it('prints a row locked to 1:300 at 1:300, though the cached rules list says 1:250', async () => {
      const r250: EndoPrepRuleOut = {
        ...r300,
        id: 2,
        total_dilution: 250,
        status: 'validated',
      }
      vi.mocked(getEndoPrepRules).mockResolvedValue([r250])
      vi.mocked(recordWorksheetPrinted).mockResolvedValue(recorded)
      const item = endoItem({ sample_peptide_id: 7 })
      vi.mocked(getWorksheet).mockResolvedValue(
        endoWorksheet([{ ...item, prep_rule: lockedTo(r300) }])
      )
      renderActions(endoWorksheet([item]))
      const print = screen.getByRole('button', { name: 'Print' })
      await waitFor(() => expect(print).toBeEnabled())
      // the cached list: 1:250, the standard steps, so no ratio prints
      expect(previewHtml()).not.toContain('<span class="rat">1:15')
      fireEvent.click(print)
      await waitFor(() => expect(printHtmlDocument).toHaveBeenCalledTimes(1))
      // the row read back carries its lock: 1:300 makes step 2 a 1:15
      const html = vi.mocked(printHtmlDocument).mock.calls[0]?.[0]
      expect(html).toContain(
        '<span class="rat">1:15 &middot; rule (trial)</span>'
      )
      expect(html).toContain('<span class="rn">1 sample (1 locked)</span>')
      // the lock decides, so the rules are not read again at Print
      expect(getEndoPrepRules).toHaveBeenCalledTimes(1)
    })

    it('prints nothing when /printed fails, or the worksheet cannot be read back', async () => {
      const toastError = vi.spyOn(toast, 'error')
      vi.mocked(recordWorksheetPrinted).mockRejectedValue(
        new Error('Record print failed: 500')
      )
      renderActions(endoWorksheet([endoItem()]))
      const print = screen.getByRole('button', { name: 'Print' })
      await waitFor(() => expect(print).toBeEnabled())
      fireEvent.click(print)
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          'Not printed: Record print failed: 500'
        )
      )
      expect(getWorksheet).not.toHaveBeenCalled()
      expect(printHtmlDocument).not.toHaveBeenCalled()
      // recorded, but the read back fails
      vi.mocked(recordWorksheetPrinted).mockResolvedValue(recorded)
      vi.mocked(getWorksheet).mockRejectedValue(
        new Error('Get worksheet failed: 500')
      )
      fireEvent.click(print)
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          'Not printed: Get worksheet failed: 500'
        )
      )
      expect(printHtmlDocument).not.toHaveBeenCalled()
      toastError.mockRestore()
    })
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
