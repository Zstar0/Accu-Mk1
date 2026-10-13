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
import {
  importReaderResults,
  promoteWorksheetRows,
  type WorksheetListItem,
} from '@/lib/api'
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
    promoteWorksheetRows: vi.fn(),
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

/** The row's cell under the column whose header starts with `header`. */
function cellOf(sampleId: string, header: string): HTMLElement {
  const ix = screen
    .getAllByRole('columnheader')
    .findIndex(th => th.textContent?.startsWith(header))
  const cell = rowOf(sampleId).querySelectorAll('td')[ix]
  if (ix < 0 || !cell) throw new Error(`no ${header} cell for ${sampleId}`)
  return cell
}

/** The three reader cells as [text, red] pairs. */
function readerCells(sampleId: string): [string, boolean][] {
  return ['Spike rec.', 'Sample CV', 'Spike CV'].map(h => {
    const td = cellOf(sampleId, h)
    return [td.textContent ?? '', td.className.includes('text-red-600')]
  })
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
    // the reader's three checks, each in its own column, red only on its own failure
    expect(readerCells('P-0004-S02')).toEqual([
      ['44', true],
      ['3.1', false],
      ['3.7', false],
    ])
    // no reader record: the three cells stay empty
    expect(readerCells('P-0001-S02')).toEqual([
      ['', false],
      ['', false],
      ['', false],
    ])
  })

  it('says under the title what Mk1 reports today, read from the peptide spec tier', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    expect(
      await screen.findByText(
        "Accu-Mk1 values are per vial; Mk1's endotoxin test reports EU/mL against ≤ 5 EU/mL until the spec switch."
      )
    ).toBeInTheDocument()
  })

  it('shows spike recovery, sample CV and spike CV in their own columns, and "-" for what the record lacks', () => {
    setup([
      endoItem({
        sample_id: 'P-0001-S02',
        result_reading: '<0.05',
        result_reader: {
          ...invalidReader,
          recovery: null,
          sample_cv: null,
          spike_cv: null,
          why: ['no spike recovery', 'no sample CV', 'no spike CV'],
        },
      }),
      endoItem({
        sample_id: 'P-0002-S02',
        result_reading: '<0.05',
        result_reader: {
          ...invalidReader,
          recovery: 90,
          sample_cv: 0,
          spike_cv: null,
          why: ['no spike CV'],
        },
      }),
    ])
    // a missing number is "-", never red on its own; the row still reads Invalid
    expect(readerCells('P-0001-S02')).toEqual([
      ['-', false],
      ['-', false],
      ['-', false],
    ])
    expect(within(rowOf('P-0001-S02')).getByText('Invalid')).toBeInTheDocument()
    // a CV of 0 is a CV of 0, not a missing one
    expect(readerCells('P-0002-S02')).toEqual([
      ['90', false],
      ['0', false],
      ['-', false],
    ])
    expect(within(rowOf('P-0002-S02')).getByText('Invalid')).toBeInTheDocument()
  })

  it("heads and colours the reader columns with the method's limits, not the file's or the defaults", () => {
    const method = endoWorksheet([]).endo_method
    if (!method) throw new Error('the fixture worksheet has a method')
    // the file's own limits (rec_min 50, rec_max 200, cv_limit 25) would pass all of these
    const rec = (over: Partial<EndoReaderRecord>): EndoReaderRecord => ({
      ...invalidReader,
      ...over,
    })
    setup(
      [
        endoItem({
          sample_id: 'P-0001-S02',
          result_reading: '<0.05',
          result_reader: rec({ recovery: 55, sample_cv: 22, spike_cv: 20 }),
        }),
        endoItem({
          sample_id: 'P-0002-S02',
          result_reading: '<0.05',
          result_reader: rec({ recovery: 60, sample_cv: 20, spike_cv: 21 }),
        }),
        endoItem({
          sample_id: 'P-0003-S02',
          result_reading: '<0.05',
          result_reader: rec({ recovery: 150.5, sample_cv: 1, spike_cv: 2 }),
        }),
        endoItem({
          sample_id: 'P-0004-S02',
          result_reading: '<0.05',
          result_reader: rec({ recovery: 150, sample_cv: 1, spike_cv: 2 }),
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
    const heads = screen.getAllByRole('columnheader').map(th => th.textContent)
    expect(heads).toContain('Spike rec.%, valid 60-150')
    expect(heads).toContain('Sample CV%, ≤ 20')
    expect(heads).toContain('Spike CV%, ≤ 20')
    expect(heads.some(h => h?.startsWith('Reader'))).toBe(false)
    // under the minimum and over the CV limit are red; at a limit is not
    expect(readerCells('P-0001-S02')).toEqual([
      ['55', true],
      ['22', true],
      ['20', false],
    ])
    expect(readerCells('P-0002-S02')).toEqual([
      ['60', false],
      ['20', false],
      ['21', true],
    ])
    expect(readerCells('P-0003-S02')).toEqual([
      ['150.5', true],
      ['1', false],
      ['2', false],
    ])
    // at the maximum is inside the range
    expect(readerCells('P-0004-S02')).toEqual([
      ['150', false],
      ['1', false],
      ['2', false],
    ])
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
    // the whole record shows on each of the three cells
    const user = userEvent.setup()
    await user.hover(within(cellOf('P-0001-S02', 'Spike CV')).getByText('3.7'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Valid: spike recovery 60-150 %, CV at most 20 %'
    )
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Spike recovery 90 % · sample CV 3.1 % · spike CV 3.7 %'
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

/** The vial's live native endotoxin analysis, as GET /worksheets/{id} serves it. */
const NATIVE = {
  id: 501,
  state: 'to_be_verified',
  keyword: 'ENDOTOXIN-USP85LAL',
  native: true,
}

const promoteBox = (sampleId: string) =>
  screen.getByRole('checkbox', { name: `Promote ${sampleId}` })

/** A dialog row's cells as text. */
function dialogRow(dialog: HTMLElement, sampleId: string): string[] {
  const tr = within(dialog).getByText(sampleId).closest('tr')
  if (!tr) throw new Error(`no dialog row for ${sampleId}`)
  return [...tr.querySelectorAll('td')].map(td => td.textContent ?? '')
}

describe('EndoResultsBox: Promote to Parent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('ticks eligible rows only, gives the reason on hover, and shows a promoted row as a chip', async () => {
    setup([
      endoItem({
        sample_id: 'P-0001-S02',
        result_reading: '<0.05',
        endo_analysis: NATIVE,
      }),
      endoItem({ sample_id: 'P-0002-S02', endo_analysis: NATIVE }),
      endoItem({
        sample_id: 'P-0003-S02',
        result_reading: '<0.05',
        endo_analysis: { ...NATIVE, keyword: 'ENDO-LAL', native: false },
      }),
      endoItem({
        sample_id: 'P-0004-S02',
        result_reading: '<0.05',
        endo_analysis: { ...NATIVE, state: 'promoted' },
      }),
    ])
    expect(
      screen.getByRole('columnheader', { name: 'Promote' })
    ).toBeInTheDocument()
    expect(promoteBox('P-0001-S02')).toBeEnabled()
    expect(promoteBox('P-0002-S02')).toBeDisabled()
    // SENAITE-born keeps manual entry: no checkbox at all
    expect(
      within(rowOf('P-0003-S02')).queryByRole('checkbox')
    ).not.toBeInTheDocument()
    expect(
      within(rowOf('P-0004-S02')).getByText('Promoted')
    ).toBeInTheDocument()
    expect(
      within(rowOf('P-0004-S02')).queryByRole('checkbox')
    ).not.toBeInTheDocument()
    const user = userEvent.setup()
    await user.hover(within(cellOf('P-0003-S02', 'Promote')).getByText('-'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'manual entry: SENAITE-born endotoxin'
    )
    // the button counts the ticked rows
    const button = screen.getByRole('button', { name: 'Promote to Parent (0)' })
    expect(button).toBeDisabled()
    fireEvent.click(promoteBox('P-0001-S02'))
    expect(
      screen.getByRole('button', { name: 'Promote to Parent (1)' })
    ).toBeEnabled()
  })

  it('gives a disabled checkbox its reason on hover', async () => {
    setup([endoItem({ sample_id: 'P-0002-S02', endo_analysis: NATIVE })])
    const target = promoteBox('P-0002-S02').parentElement
    if (!target) throw new Error('no hover target')
    await userEvent.setup().hover(target)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('no reading')
  })

  it('confirms exactly what is sent, sends one request, reports each row, and refetches the page', async () => {
    const pep = endoItem({
      sample_id: 'P-0001-S02',
      result_reading: '<0.05',
      endo_analysis: NATIVE,
    })
    const bw = endoItem({
      sample_id: 'BW-0001',
      sample_type: 'Bacteriostatic Water',
      sample_identity: 'Bacteriostatic Water',
      result_reading: '<0.2',
      endo_analysis: { ...NATIVE, id: 502 },
    })
    const fail = endoItem({
      sample_id: 'P-0003-S02',
      result_reading: '0.8',
      endo_analysis: { ...NATIVE, id: 503 },
    })
    const { qc, rerender } = setup([pep, bw, fail])
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    vi.mocked(promoteWorksheetRows).mockResolvedValue({
      results: [
        {
          item_id: pep.id,
          promoted: true,
          parent_analysis_id: 9001,
          state: 'parent_to_verify',
        },
        {
          item_id: bw.id,
          promoted: true,
          parent_analysis_id: 9002,
          state: 'parent_to_verify',
        },
        {
          item_id: fail.id,
          promoted: false,
          reason:
            'the parent already holds a result; retest the vial to replace it',
        },
      ],
    })
    for (const sid of ['P-0001-S02', 'BW-0001', 'P-0003-S02'])
      fireEvent.click(promoteBox(sid))
    fireEvent.click(
      screen.getByRole('button', { name: 'Promote to Parent (3)' })
    )
    const dialog = await screen.findByRole('dialog')
    // row, sample, value, LOQ, LOD, verdict: a "<" result goes as its LOQ
    expect(dialogRow(dialog, 'P-0001-S02')).toEqual([
      '1',
      'P-0001-S02',
      '25 EU/vial',
      '25 EU/vial',
      '0.05 EU/mL',
      'Pass',
    ])
    expect(dialogRow(dialog, 'BW-0001')).toEqual([
      '2',
      'BW-0001',
      '0.2 EU/mL',
      '0.2 EU/mL',
      '0.01 EU/mL',
      'Pass',
    ])
    expect(dialogRow(dialog, 'P-0003-S02')).toEqual([
      '3',
      'P-0003-S02',
      '400 EU/vial',
      '25 EU/vial',
      '0.05 EU/mL',
      'Fail',
    ])
    expect(promoteWorksheetRows).not.toHaveBeenCalled()
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Promote 3 results' })
    )
    expect(
      await within(dialog).findByText(
        'Not promoted: the parent already holds a result; retest the vial to replace it'
      )
    ).toBeInTheDocument()
    expect(promoteWorksheetRows).toHaveBeenCalledTimes(1)
    expect(promoteWorksheetRows).toHaveBeenCalledWith(77, [
      {
        item_id: pep.id,
        value: 25,
        unit: 'EU/vial',
        loq: 25,
        lod: 0.05,
        lod_unit: 'EU/mL',
      },
      {
        item_id: bw.id,
        value: 0.2,
        unit: 'EU/mL',
        loq: 0.2,
        lod: 0.01,
        lod_unit: 'EU/mL',
      },
      {
        item_id: fail.id,
        value: 400,
        unit: 'EU/vial',
        loq: 25,
        lod: 0.05,
        lod_unit: 'EU/mL',
      },
    ])
    expect(dialogRow(dialog, 'P-0001-S02').at(-1)).toBe(
      'Promoted: parent result To Verify'
    )
    expect(within(dialog).getByText(/^2 of 3 promoted/)).toBeInTheDocument()
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: worksheetPageKey(77),
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    // the ticks are spent; the refetched rows show the chip
    expect(
      screen.getByRole('button', { name: 'Promote to Parent (0)' })
    ).toBeDisabled()
    rerender(
      <EndoResultsBox
        {...endoBoxProps([
          { ...pep, endo_analysis: { ...NATIVE, state: 'promoted' } },
          bw,
          fail,
        ]).props}
      />
    )
    expect(
      within(rowOf('P-0001-S02')).getByText('Promoted')
    ).toBeInTheDocument()
  })

  it('sends once while the request is in flight, and keeps the dialog with the error when it fails', async () => {
    const a = endoItem({
      sample_id: 'P-0001-S02',
      result_reading: '<0.05',
      endo_analysis: NATIVE,
    })
    setup([a])
    let fail: (e: Error) => void = () => undefined
    vi.mocked(promoteWorksheetRows).mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject
      })
    )
    fireEvent.click(promoteBox('P-0001-S02'))
    fireEvent.click(
      screen.getByRole('button', { name: 'Promote to Parent (1)' })
    )
    const dialog = await screen.findByRole('dialog')
    const send = within(dialog).getByRole('button', {
      name: 'Promote 1 result',
    })
    fireEvent.click(send)
    fireEvent.click(send)
    expect(send).toBeDisabled()
    expect(promoteWorksheetRows).toHaveBeenCalledTimes(1)
    await act(async () => fail(new Error('Promote failed: 500')))
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Promote failed: 500'
    )
    expect(send).toBeEnabled()
    expect(dialogRow(dialog, 'P-0001-S02')[2]).toBe('25 EU/vial')
  })

  it('promotes on a completed worksheet, which has no reader drop zone', () => {
    setup(
      [
        endoItem({
          sample_id: 'P-0001-S02',
          result_reading: '<0.05',
          endo_analysis: NATIVE,
        }),
      ],
      true
    )
    expect(promoteBox('P-0001-S02')).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Promote to Parent (0)' })
    ).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Reader export file')
    ).not.toBeInTheDocument()
  })

  it('shows no Promote column and no button on a stock worksheet', () => {
    setup(
      [
        endoItem({
          sample_id: 'P-0001-S02',
          result_reading: '<0.05',
          endo_analysis: NATIVE,
        }),
      ],
      false,
      { endo_prep: 'stock' }
    )
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Promote to Parent/ })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('columnheader', { name: 'Promote' })
    ).not.toBeInTheDocument()
    // the reader import is unchanged
    expect(screen.getByLabelText('Reader export file')).toBeInTheDocument()
  })
})
