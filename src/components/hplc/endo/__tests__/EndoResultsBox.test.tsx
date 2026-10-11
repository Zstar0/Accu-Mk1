import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import { importReaderResults, type WorksheetListItem } from '@/lib/api'
import { EndoResultsBox } from '@/components/hplc/endo/EndoResultsBox'
import type { EndoReaderRecord } from '@/lib/endo-prep-2ml'
import type * as EndoReaderModule from '@/lib/endo-reader'
import { parseEndoScan } from '@/lib/endo-reader'
import { worksheetPageKey } from '@/hooks/use-worksheet-drawer'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import {
  endoBoxProps,
  endoItem,
  endoWorksheet,
  readerTest,
} from './endo-fixtures'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

vi.mock('@/lib/endo-reader', async importOriginal => ({
  ...(await importOriginal<typeof EndoReaderModule>()),
  parseEndoScan: vi.fn(),
}))

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
    importReaderResults: vi.fn(),
    getAnalysisServices: vi.fn().mockResolvedValue([
      {
        id: 61,
        title: 'Endotoxin (LAL)',
        keyword: 'ENDO-LAL',
        origin: 'mk1',
        active: true,
      },
    ]),
    listServiceSpecs: vi.fn().mockResolvedValue([
      {
        id: 9,
        analysis_service_id: 61,
        matrix: 'Peptide',
        peptide_id: null,
        peptide_code: null,
        rule_kind: 'range',
        min_value: null,
        max_value: '5',
        equals_value: null,
        unit: 'EU/mL',
        display_override: null,
        loq: null,
        active: true,
        updated_at: null,
      },
    ]),
  }
})

const invalidReader: EndoReaderRecord = {
  test_id: 'T-9',
  result: '<0.05',
  reader: 'MCS-1234',
  slot: 2,
  operator: 'QA',
  tested_at: '2026-10-09 14:02',
  temp_start: 37,
  temp_end: 37.1,
  software: '1.0',
  cartridge_lot: 'L1',
  cartridge_expiry: '2027-01-31',
  cartridge_range: '5 - 0.05',
  spike_level: 0.8,
  recovery: 44,
  rec_min: 50,
  rec_max: 200,
  sample_cv: 3.1,
  spike_cv: 3.7,
  cv_limit: 25,
  reader_pass: false,
  valid: false,
  why: ['spike recovery 44 % outside 50-200 %'],
  file_name: 'EndoScanV-Export-2026-10-09.csv',
}

function setup(
  items: WorksheetItemRow[],
  isCompleted = false,
  over: Partial<WorksheetListItem> = {}
) {
  const { props, onUpdateItem } = endoBoxProps(items, over, isCompleted)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const view = render(<EndoResultsBox {...props} />, { wrapper: wrap })
  return { onUpdateItem, qc, rerender: view.rerender }
}

function rowOf(sampleId: string): HTMLElement {
  const row = screen.getByText(sampleId).closest('tr')
  if (!row) throw new Error(`no row for ${sampleId}`)
  return row
}

describe('EndoResultsBox', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders Pass, Fail, Inconclusive and Invalid, and the Accu-Mk1 value only when there is one', () => {
    setup([
      endoItem({ sample_id: 'P-0001-S02', result_reading: '<0.05' }),
      endoItem({ sample_id: 'P-0002-S02', result_reading: '0.8' }),
      endoItem({ sample_id: 'P-0003-S02', result_reading: '<1' }),
      endoItem({
        sample_id: 'P-0004-S02',
        result_reading: '<0.05',
        result_reader: invalidReader,
      }),
    ])
    // <0.05 x 250 x 2 mL = <25 EU/vial; 0.8 -> 400 > 350; <1 -> <500, a floor above the limit
    expect(within(rowOf('P-0001-S02')).getByText('Pass')).toBeInTheDocument()
    expect(within(rowOf('P-0002-S02')).getByText('Fail')).toBeInTheDocument()
    expect(
      within(rowOf('P-0003-S02')).getByText('Inconclusive')
    ).toBeInTheDocument()
    expect(within(rowOf('P-0004-S02')).getByText('Invalid')).toBeInTheDocument()
    expect(
      within(rowOf('P-0001-S02')).getByRole('button', {
        name: 'Copy <25 for Accu-Mk1',
      })
    ).toBeInTheDocument()
    expect(
      within(rowOf('P-0004-S02')).queryByRole('button')
    ).not.toBeInTheDocument()
    // the Reader cell: spike recovery and the larger CV
    expect(
      within(rowOf('P-0004-S02')).getByText('44 % · 3.7')
    ).toBeInTheDocument()
  })

  it('says under the title what Mk1 reports today, read from the peptide spec tier', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    expect(
      await screen.findByText(
        "Accu-Mk1 values are per vial; Mk1's endotoxin test reports EU/mL against ≤ 5 EU/mL until the spec switch."
      )
    ).toBeInTheDocument()
  })

  it('shows the larger CV the record carries, and "-" for what it does not', () => {
    setup([
      endoItem({
        sample_id: 'P-0001-S02',
        result_reading: '<0.05',
        result_reader: {
          ...invalidReader,
          recovery: null,
          sample_cv: null,
          spike_cv: null,
        },
      }),
      endoItem({
        sample_id: 'P-0002-S02',
        result_reading: '<0.05',
        result_reader: { ...invalidReader, recovery: 90, sample_cv: null },
      }),
    ])
    // no CV is not a CV of 0
    expect(within(rowOf('P-0001-S02')).getByText('- · -')).toBeInTheDocument()
    expect(
      within(rowOf('P-0002-S02')).getByText('90 % · 3.7')
    ).toBeInTheDocument()
  })

  it('flags a typed reading that differs from the reader, and keeps an invalid test Invalid', () => {
    setup([
      endoItem({
        sample_id: 'P-0001-S02',
        result_reading: '0.3',
        result_reader: invalidReader,
      }),
    ])
    const row = rowOf('P-0001-S02')
    expect(
      within(row).getByText('the reader exported <0.05')
    ).toBeInTheDocument()
    expect(within(row).getByText('Invalid')).toBeInTheDocument()
  })

  it('saves the reading with the row cartridge when the item has none', () => {
    const bare = endoItem({ sample_id: 'P-0001-S02' })
    const own = endoItem({
      sample_id: 'P-0002-S02',
      cartridge_type_id: 4,
      cartridge_sensitivity_eu_ml: 0.01,
    })
    const { onUpdateItem } = setup([bare, own])
    const first = screen.getByLabelText('Reading for P-0001-S02')
    fireEvent.change(first, { target: { value: '0.8' } })
    fireEvent.blur(first)
    expect(onUpdateItem).toHaveBeenCalledWith(bare.id, {
      result_reading: '0.8',
      cartridge_type_id: 3,
    })
    const second = screen.getByLabelText('Reading for P-0002-S02')
    fireEvent.change(second, { target: { value: '<0.01' } })
    fireEvent.blur(second)
    expect(onUpdateItem).toHaveBeenCalledWith(own.id, {
      result_reading: '<0.01',
    })
  })

  it("shows the server's refusal of a reading on its row", async () => {
    const refusal =
      "That cartridge is retired, not an endotoxin cartridge, or not allowed by this worksheet's method"
    const { onUpdateItem } = setup([
      endoItem({ sample_id: 'P-0001-S02' }),
      endoItem({ sample_id: 'P-0002-S02' }),
    ])
    onUpdateItem.mockResolvedValue(refusal)
    const first = screen.getByLabelText('Reading for P-0001-S02')
    fireEvent.change(first, { target: { value: '0.8' } })
    fireEvent.blur(first)
    expect(
      await within(rowOf('P-0001-S02')).findByText(`Not saved: ${refusal}`)
    ).toHaveAttribute('role', 'alert')
    expect(
      within(rowOf('P-0002-S02')).queryByText(/Not saved/)
    ).not.toBeInTheDocument()
  })

  it('refuses a reading on the client, on its row, when no cartridge resolves', () => {
    const { onUpdateItem } = setup(
      [endoItem({ sample_id: 'P-0001-S02' })],
      false,
      {
        cartridge_type_id: null,
        cartridge_sensitivity_eu_ml: null,
        endo_method: null,
      }
    )
    const cell = screen.getByLabelText('Reading for P-0001-S02')
    fireEvent.change(cell, { target: { value: '0.8' } })
    fireEvent.blur(cell)
    expect(onUpdateItem).not.toHaveBeenCalled()
    expect(within(rowOf('P-0001-S02')).getByRole('alert')).toHaveTextContent(
      "Not saved: set the run cartridge (or this row's) before saving a reading"
    )
  })

  it('copies the Accu-Mk1 number on click', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    setup([
      endoItem({ sample_id: 'P-0001-S02', result_reading: '<0.05' }),
      // bac water runs on the 0.01: its floor is <0.2 EU/mL of the water
      endoItem({
        sample_id: 'BW-0001',
        sample_type: 'Bacteriostatic Water',
        result_reading: '<0.2',
      }),
    ])
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy <25 for Accu-Mk1' })
    )
    expect(writeText).toHaveBeenCalledWith('<25')
    // bac water reports the reading itself, in EU/mL; LOQ and Limit per mL
    const bw = rowOf('BW-0001')
    const copy = within(bw).getByRole('button', {
      name: 'Copy <0.2 for Accu-Mk1',
    })
    expect(within(copy).getByText('EU/mL')).toBeInTheDocument()
    fireEvent.click(copy)
    expect(writeText).toHaveBeenLastCalledWith('<0.2')
    expect(
      within(bw)
        .getAllByText('/mL')
        .map(unit => unit.parentElement?.textContent)
    ).toEqual(['0.2/mL', '0.25/mL'])
  })

  it('shows the worked line of a computed cell on hover', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02', result_reading: '<0.05' })])
    // EU/vial is the first "<25" in the row; the Accu-Mk1 button is the second
    const [euPerVial] = within(rowOf('P-0001-S02')).getAllByText('<25')
    if (!euPerVial) throw new Error('no EU/vial cell')
    await userEvent.setup().hover(euPerVial)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '<0.05 EU/mL on the MCS × 1:250 = <12.5 EU/mL of the vial solution × 2 mL = <25 EU'
    )
  })

  it("prints the method's validity limits on the reader hover, not the file's", async () => {
    const method = endoWorksheet([]).endo_method
    if (!method) throw new Error('the fixture worksheet has a method')
    setup(
      [
        endoItem({
          sample_id: 'P-0001-S02',
          result_reading: '<0.05',
          // the file's own limits, which the verdict does not use
          result_reader: {
            ...invalidReader,
            recovery: 90,
            rec_min: 70,
            rec_max: 130,
            cv_limit: 10,
            valid: true,
            why: [],
          },
        }),
      ],
      false,
      {
        endo_method: {
          ...method,
          run_parameters: {
            endotoxin: {
              spike_recovery_min_pct: 60,
              spike_recovery_max_pct: 150,
              cv_limit_pct: 20,
            },
          },
        },
      }
    )
    await userEvent
      .setup()
      .hover(within(rowOf('P-0001-S02')).getByText('90 % · 3.7'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Valid: spike recovery 60-150 %, CV under 20 %'
    )
  })

  it('puts an applied reader import in the page cache at once, then refetches the worksheets list', async () => {
    const a = endoItem({ sample_id: 'P-0001-S02' })
    const { qc } = setup([a])
    // the page as it was read before the method was pinned
    qc.setQueryData(
      worksheetPageKey(77),
      endoWorksheet([a], { endo_method: null })
    )
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const pinned = endoWorksheet([]).endo_method ?? null
    vi.mocked(importReaderResults).mockResolvedValue({
      applied: 1,
      items: [{ ...a, result_reading: '<0.05' }],
      endo_method: pinned,
    })
    vi.mocked(parseEndoScan).mockReturnValueOnce({
      tests: [readerTest({ sampleId: 'P-0001-S02' })],
      cartridges: [],
    })
    fireEvent.change(screen.getByLabelText('Reader export file'), {
      target: { files: [new File(['x'], 'export.csv', { type: 'text/csv' })] },
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Apply 1 reading' })
    )
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['worksheets-list'] })
    )
    expect(invalidate).toHaveBeenCalledTimes(1)
    const page = qc.getQueryData<WorksheetListItem>(worksheetPageKey(77))
    expect(page?.items[0]?.result_reading).toBe('<0.05')
    expect(page?.endo_method?.id).toBe(12)
  })

  it('clears the refusals of the rows an import wrote, drops their late replies, and keeps the rest', async () => {
    const refusal = 'the server refused it'
    const a = endoItem({ sample_id: 'P-0001-S02' })
    const b = endoItem({ sample_id: 'P-0002-S02' })
    const c = endoItem({ sample_id: 'P-0003-S02' })
    const { onUpdateItem } = setup([a, b, c])
    let replyA: (msg: string | null) => void = () => undefined
    onUpdateItem
      .mockReturnValueOnce(
        new Promise<string | null>(r => {
          replyA = r
        })
      )
      .mockResolvedValue(refusal)
    for (const sid of ['P-0001-S02', 'P-0002-S02', 'P-0003-S02']) {
      const input = screen.getByLabelText(`Reading for ${sid}`)
      fireEvent.change(input, { target: { value: '0.8' } })
      fireEvent.blur(input)
    }
    expect(
      await within(rowOf('P-0002-S02')).findByText(`Not saved: ${refusal}`)
    ).toBeInTheDocument()
    expect(
      await within(rowOf('P-0003-S02')).findByText(`Not saved: ${refusal}`)
    ).toBeInTheDocument()
    vi.mocked(importReaderResults).mockResolvedValue({
      applied: 2,
      items: [a, b],
      endo_method: null,
    })
    vi.mocked(parseEndoScan).mockReturnValueOnce({
      tests: [
        readerTest({ testId: 'T1', sampleId: 'P-0001-S02' }),
        readerTest({ testId: 'T2', sampleId: 'P-0002-S02' }),
      ],
      cartridges: [],
    })
    fireEvent.change(screen.getByLabelText('Reader export file'), {
      target: { files: [new File(['x'], 'export.csv', { type: 'text/csv' })] },
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Apply 2 readings' })
    )
    await waitFor(() =>
      expect(
        within(rowOf('P-0002-S02')).queryByText(/Not saved/)
      ).not.toBeInTheDocument()
    )
    // row 1's save was still in flight: its refusal lands after the import
    await act(async () => replyA(refusal))
    expect(
      within(rowOf('P-0001-S02')).queryByText(/Not saved/)
    ).not.toBeInTheDocument()
    expect(
      within(rowOf('P-0003-S02')).getByText(`Not saved: ${refusal}`)
    ).toBeInTheDocument()
  })

  it("drops a rejected draft when the row's saved reading changes", () => {
    const a = endoItem({ sample_id: 'P-0001-S02' })
    const { rerender } = setup([a])
    const input = screen.getByLabelText('Reading for P-0001-S02')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    // the reader import (or another analyst) writes the row
    rerender(
      <EndoResultsBox
        {...endoBoxProps([{ ...a, result_reading: '<0.05' }]).props}
      />
    )
    const after = screen.getByLabelText('Reading for P-0001-S02')
    expect(after).toHaveValue('<0.05')
    expect(after).not.toHaveAttribute('aria-invalid')
  })

  it('is read-only on a completed worksheet', () => {
    setup(
      [endoItem({ sample_id: 'P-0001-S02', result_reading: '<0.05' })],
      true
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('<0.05')).toBeInTheDocument()
    // a completed worksheet refuses an import (409): no drop zone
    expect(
      screen.queryByLabelText('Reader export file')
    ).not.toBeInTheDocument()
  })
})
