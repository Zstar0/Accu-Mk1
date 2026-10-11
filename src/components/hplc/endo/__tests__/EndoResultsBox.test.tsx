import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'
import type { WorksheetListItem } from '@/lib/api'
import { EndoResultsBox } from '@/components/hplc/endo/EndoResultsBox'
import type { EndoReaderRecord } from '@/lib/endo-prep-2ml'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import { endoBoxProps, endoItem } from './endo-fixtures'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return {
    ...actual,
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
  render(<EndoResultsBox {...props} />, { wrapper: wrap })
  return { onUpdateItem }
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
    setup([endoItem({ sample_id: 'P-0001-S02', result_reading: '<0.05' })])
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy <25 for Accu-Mk1' })
    )
    expect(writeText).toHaveBeenCalledWith('<25')
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

  it('is read-only on a completed worksheet', () => {
    setup(
      [endoItem({ sample_id: 'P-0001-S02', result_reading: '<0.05' })],
      true
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('<0.05')).toBeInTheDocument()
  })
})
