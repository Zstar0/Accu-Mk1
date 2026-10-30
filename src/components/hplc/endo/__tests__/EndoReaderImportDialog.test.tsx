import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { toast } from 'sonner'
import { EndoReaderImportDialog } from '@/components/hplc/endo/EndoReaderImportDialog'
import type * as ApiModule from '@/lib/api'
import {
  importReaderResults,
  type EndoMethodInfo,
  type WorksheetListItem,
} from '@/lib/api'
import { ENDO_RUN_PARAM_DEFAULTS } from '@/lib/endo-prep-2ml'
import type * as EndoReaderModule from '@/lib/endo-reader'
import {
  parseEndoScan,
  toReaderRecord,
  type ReaderTest,
} from '@/lib/endo-reader'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import { endoBoxProps, endoItem, readerTest } from './endo-fixtures'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

// Only the file parser is stubbed: matching, validity, the cartridge range
// and the stored record run for real (Task 9).
vi.mock('@/lib/endo-reader', async importOriginal => ({
  ...(await importOriginal<typeof EndoReaderModule>()),
  parseEndoScan: vi.fn(),
}))

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof ApiModule>()),
  importReaderResults: vi.fn(),
}))

const FILE = 'EndoScanV-Export-2026-10-09.csv'

function setup(
  items: WorksheetItemRow[],
  over: Partial<WorksheetListItem> = {}
) {
  const { props } = endoBoxProps(items, over)
  const onApplied = vi.fn()
  render(
    <EndoReaderImportDialog
      worksheet={props.worksheet}
      rows={props.rows}
      cartridges={props.cartridges}
      params={props.ctx.params}
      onApplied={onApplied}
    />
  )
  return { onApplied, rows: props.rows }
}

function pick(name: string) {
  fireEvent.change(screen.getByLabelText('Reader export file'), {
    target: { files: [new File(['x'], name, { type: 'text/csv' })] },
  })
}

async function drop(tests: ReaderTest[]) {
  vi.mocked(parseEndoScan).mockReturnValueOnce({ tests, cartridges: [] })
  pick(FILE)
  return screen.findByRole('dialog')
}

describe('EndoReaderImportDialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('previews exact and by-vial matches, and lists ambiguous and unmatched tests', async () => {
    setup([
      endoItem({ sample_id: 'P-0001-S02' }),
      endoItem({ sample_id: 'P-0002-S02' }),
      endoItem({ sample_id: 'P-0003-S02' }),
      endoItem({ sample_id: 'P-0003-S03' }),
      endoItem({ sample_id: 'P-0005-S02' }),
    ])
    const dialog = await drop([
      readerTest({ testId: 'T1', sampleId: 'P-0001-S02' }),
      readerTest({ testId: 'T2', sampleId: 'P-0002' }),
      readerTest({ testId: 'T3', sampleId: 'P-0003' }),
      readerTest({ testId: 'T4', sampleId: 'P-9999' }),
      // a differently written vial and a different vial of a parent on the
      // sheet both fail safe: listed and skipped, never paired
      readerTest({ testId: 'T5', sampleId: 'P-0005-S2' }),
      readerTest({ testId: 'T6', sampleId: 'P-0005-S03' }),
    ])
    expect(within(dialog).getByText('P-0001-S02 · row 1')).toBeInTheDocument()
    expect(
      within(dialog).getByText('P-0002-S02 (by its vial) · row 2')
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(/More than one vial on this sheet.*P-0003/)
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'Not on this sheet, skipped: P-9999, P-0005-S2, P-0005-S03'
      )
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: 'Apply 2 readings' })
    ).toBeEnabled()
  })

  it('lists an earlier test of a sample tested twice and applies only the later one', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    const dialog = await drop([
      readerTest({
        testId: 'T1',
        sampleId: 'P-0001-S02',
        testedAt: '2026-10-09T10:00:00',
      }),
      readerTest({
        testId: 'T2',
        sampleId: 'P-0001-S02',
        testedAt: '2026-10-09T14:00:00',
      }),
    ])
    expect(
      within(dialog).getByText(
        'Other tests of a row tested more than once, skipped: T1 (P-0001-S02 uses T2)'
      )
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: 'Apply 1 reading' })
    ).toBeEnabled()
  })

  it('names the test a row uses when an earlier exact-ID test outranks a later parent-ID one', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    vi.mocked(importReaderResults).mockResolvedValue({
      applied: 1,
      items: [],
      endo_method: null,
    })
    const dialog = await drop([
      readerTest({
        testId: 'T1',
        sampleId: 'P-0001-S02',
        testedAt: '2026-10-09T10:00:00',
      }),
      readerTest({
        testId: 'T2',
        sampleId: 'P-0001',
        testedAt: '2026-10-09T14:00:00',
      }),
    ])
    expect(
      within(dialog).getByText(
        'Other tests of a row tested more than once, skipped: T2 (P-0001-S02 uses T1)'
      )
    ).toBeInTheDocument()
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Apply 1 reading' })
    )
    await waitFor(() => expect(importReaderResults).toHaveBeenCalledTimes(1))
    expect(
      vi.mocked(importReaderResults).mock.calls[0]?.[1].tests[0]?.record.test_id
    ).toBe('T1')
  })

  it('never falls back to an earlier test when the one a row uses is not usable', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    const dialog = await drop([
      readerTest({
        testId: 'T1',
        sampleId: 'P-0001-S02',
        testedAt: '2026-10-09T10:00:00',
      }),
      readerTest({
        testId: 'T2',
        sampleId: 'P-0001-S02',
        testedAt: '2026-10-09T14:00:00',
        result: '~5',
        lt: false,
        value: null,
      }),
    ])
    expect(
      within(dialog).getByText(
        'Other tests of a row tested more than once, skipped: T1 (P-0001-S02 uses none: T2 is not usable)'
      )
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'Not usable, skipped: P-0001-S02 (~5 is not a usable reading)'
      )
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: 'Apply 0 readings' })
    ).toBeDisabled()
  })

  it('replaces a different reading only when its box is ticked', async () => {
    const a = endoItem({ sample_id: 'P-0001-S02', result_reading: '0.3' })
    setup([a])
    vi.mocked(importReaderResults).mockResolvedValue({
      applied: 1,
      items: [a],
      endo_method: null,
    })
    const dialog = await drop([
      readerTest({ sampleId: 'P-0001-S02', result: '<0.05' }),
    ])
    expect(
      within(dialog).getByText('has 0.3: tick to replace it')
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: 'Apply 0 readings' })
    ).toBeDisabled()
    fireEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'Replace the reading on P-0001-S02',
      })
    )
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Apply 1 reading' })
    )
    await waitFor(() => expect(importReaderResults).toHaveBeenCalledTimes(1))
    expect(
      vi.mocked(importReaderResults).mock.calls[0]?.[1].tests[0]?.replace
    ).toBe(true)
  })

  it('compares readings as the server does, so "< 0.05" already holds "<0.05"', async () => {
    setup([
      endoItem({
        sample_id: 'P-0001-S02',
        result_reading: '< 0.05',
        result_reader: toReaderRecord(
          readerTest(),
          ENDO_RUN_PARAM_DEFAULTS,
          FILE
        ),
      }),
    ])
    const dialog = await drop([
      readerTest({ sampleId: 'P-0001-S02', result: '<0.05' }),
    ])
    expect(within(dialog).getByText('already imported')).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: 'Apply 0 readings' })
    ).toBeDisabled()
  })

  it('marks a test on a cartridge the method does not allow and never sends it', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    const dialog = await drop([
      readerTest({ sampleId: 'P-0001-S02', cartRange: '5 - 0.005' }),
    ])
    expect(
      within(dialog).getByText(/cartridge not in the catalog/)
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: 'Apply 0 readings' })
    ).toBeDisabled()
  })

  it("falls back to the row's cartridge when the file names none, only when the method allows it", async () => {
    const { rows } = setup([
      endoItem({ sample_id: 'P-0001-S02' }),
      // a pick the method no longer allows (retired, or outside its list)
      endoItem({
        sample_id: 'P-0002-S02',
        cartridge_type_id: 9,
        cartridge_sensitivity_eu_ml: 0.1,
      }),
    ])
    const dialog = await drop([
      readerTest({ testId: 'T1', sampleId: 'P-0001-S02', cartRange: null }),
      readerTest({ testId: 'T2', sampleId: 'P-0002-S02', cartRange: null }),
    ])
    expect(
      within(dialog).getByText(
        'no cartridge in the file, and none on this row the method allows'
      )
    ).toBeInTheDocument()
    vi.mocked(importReaderResults).mockResolvedValue({
      applied: 1,
      items: [],
      endo_method: null,
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Apply 1 reading' })
    )
    await waitFor(() => expect(importReaderResults).toHaveBeenCalledTimes(1))
    const sent = vi.mocked(importReaderResults).mock.calls[0]?.[1].tests
    // the first row inherits the run cartridge, 3 (0.05 EU/mL)
    expect(rows[0]?.cartridge?.id).toBe(3)
    expect(sent).toEqual([
      expect.objectContaining({
        item_id: rows[0]?.item.id,
        cartridge_type_id: 3,
      }),
    ])
  })

  // Two allowed types read 0.05 EU/mL (two makes of one sensitivity).
  const twin05: EndoMethodInfo = {
    id: 12,
    name: 'Endotoxin (LAL)',
    revision: 2,
    status: 'active',
    run_parameters: null,
    cartridges: [
      {
        id: 3,
        name: 'Endosafe 0.05',
        sensitivity_eu_ml: 0.05,
        is_default: true,
        active: true,
      },
      {
        id: 6,
        name: 'Endosafe 0.05 (second make)',
        sensitivity_eu_ml: 0.05,
        is_default: false,
        active: true,
      },
      {
        id: 4,
        name: 'Endosafe 0.01',
        sensitivity_eu_ml: 0.01,
        is_default: false,
        active: true,
      },
    ],
  }

  it("picks the row's cartridge, then the run's, among types that share the file's sensitivity", async () => {
    const { rows } = setup(
      [
        endoItem({
          sample_id: 'P-0001-S02',
          cartridge_type_id: 6,
          cartridge_sensitivity_eu_ml: 0.05,
        }),
        // its own 0.01 does not match the file, so the run cartridge (3) does
        endoItem({
          sample_id: 'P-0002-S02',
          cartridge_type_id: 4,
          cartridge_sensitivity_eu_ml: 0.01,
        }),
      ],
      { endo_method: twin05 }
    )
    vi.mocked(importReaderResults).mockResolvedValue({
      applied: 2,
      items: [],
      endo_method: null,
    })
    const dialog = await drop([
      readerTest({ testId: 'T1', sampleId: 'P-0001-S02' }),
      readerTest({ testId: 'T2', sampleId: 'P-0002-S02' }),
    ])
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Apply 2 readings' })
    )
    await waitFor(() => expect(importReaderResults).toHaveBeenCalledTimes(1))
    const sent = vi.mocked(importReaderResults).mock.calls[0]?.[1].tests
    expect(sent?.map(t => [t.item_id, t.cartridge_type_id])).toEqual([
      [rows[0]?.item.id, 6],
      [rows[1]?.item.id, 3],
    ])
  })

  it('never sends a test whose sensitivity two allowed types share and neither the row nor the run names', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })], {
      endo_method: twin05,
      // the run (and so the row) is on the 0.01
      cartridge_type_id: 4,
      cartridge_sensitivity_eu_ml: 0.01,
    })
    const dialog = await drop([readerTest({ sampleId: 'P-0001-S02' })])
    expect(
      within(dialog).getByText(
        'more than one catalog cartridge has this sensitivity'
      )
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: 'Apply 0 readings' })
    ).toBeDisabled()
  })

  it('applies the matched tests in one request and hands the updated items back', async () => {
    const a = endoItem({ sample_id: 'P-0001-S02' })
    const { onApplied } = setup([a])
    const updated = { ...a, result_reading: '<0.05' }
    const res = { applied: 1, items: [updated], endo_method: null }
    vi.mocked(importReaderResults).mockResolvedValue(res)
    const dialog = await drop([
      readerTest({ testId: 'T1', sampleId: 'P-0001-S02' }),
    ])
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Apply 1 reading' })
    )
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(res, [a.id]))
    expect(importReaderResults).toHaveBeenCalledWith(77, {
      file_name: FILE,
      tests: [
        {
          item_id: a.id,
          reading: '<0.05',
          record: expect.objectContaining({
            test_id: 'T1',
            result: '<0.05',
            reader: 'MCS-1234',
            slot: 2,
            valid: true,
            file_name: FILE,
          }),
          cartridge_type_id: 3,
          replace: false,
        },
      ],
    })
  })

  it('names each row the server skipped, with its reason, beside the applied count (slice 5)', async () => {
    const a = endoItem({ sample_id: 'P-0001-S02' })
    const b = endoItem({ sample_id: 'P-0002-S02' })
    setup([a, b])
    vi.mocked(importReaderResults).mockResolvedValue({
      applied: 1,
      items: [a, b],
      endo_method: null,
      skipped: [
        {
          item_id: b.id,
          sample_id: 'P-0002-S02',
          reason: 'the row is promoted; its prep is final',
        },
      ],
    })
    const dialog = await drop([
      readerTest({ testId: 'T1', sampleId: 'P-0001-S02' }),
      readerTest({ testId: 'T2', sampleId: 'P-0002-S02' }),
    ])
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Apply 2 readings' })
    )
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        `1 reading applied from ${FILE}; 1 not applied`,
        {
          description: 'P-0002-S02 (the row is promoted; its prep is final)',
          // stays until dismissed (final review Minor 8)
          duration: Infinity,
        }
      )
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('lists a test with no usable reading as skipped and never sends it', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    // a qualifier the parser does not know keeps the reading verbatim with no
    // value; the server would refuse the whole import for it. ">" is NOT one
    // of these any more: it reads as a floor (Handler ruling 2026-10-26).
    const dialog = await drop([
      readerTest({
        sampleId: 'P-0001-S02',
        result: '~5',
        lt: false,
        value: null,
      }),
    ])
    expect(
      within(dialog).getByText(
        'Not usable, skipped: P-0001-S02 (~5 is not a usable reading)'
      )
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: 'Apply 0 readings' })
    ).toBeDisabled()
    expect(importReaderResults).not.toHaveBeenCalled()
  })

  it('lists a test with no Test ID as skipped and never sends it', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    // the server refuses the whole import for a record without a test_id
    const dialog = await drop([
      readerTest({ testId: ' ', sampleId: 'P-0001-S02' }),
    ])
    expect(
      within(dialog).getByText(
        'Not usable, skipped: P-0001-S02 (no Test ID in the file)'
      )
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: 'Apply 0 readings' })
    ).toBeDisabled()
  })

  it('keeps the dialog open with the server refusal and hands nothing back', async () => {
    const { onApplied } = setup([endoItem({ sample_id: 'P-0001-S02' })])
    const refusal =
      'Nothing was imported. Row P-0001-S02: already holds the reading 0.3; tick replace to overwrite it'
    vi.mocked(importReaderResults).mockRejectedValue(new Error(refusal))
    const dialog = await drop([readerTest({ sampleId: 'P-0001-S02' })])
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Apply 1 reading' })
    )
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(refusal)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('refuses a file over 2 MB before reading it', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    fireEvent.change(screen.getByLabelText('Reader export file'), {
      target: {
        files: [
          new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.csv', {
            type: 'text/csv',
          }),
        ],
      },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That file is over 2 MB, too big for a reader export.'
    )
    expect(parseEndoScan).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows a readable message for a file that is not a reader export', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    vi.mocked(parseEndoScan).mockImplementationOnce(() => {
      throw new Error(
        'This is not a reader export: no test rows (channel 1-4, 79 columns) were found.'
      )
    })
    pick('notes.csv')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This is not a reader export'
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
