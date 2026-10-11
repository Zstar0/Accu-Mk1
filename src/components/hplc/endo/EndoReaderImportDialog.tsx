import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { importReaderResults, type WorksheetListItem } from '@/lib/api'
import { fmt } from '@/lib/endo-prep'
import { parseReading, type EndoRunParams } from '@/lib/endo-prep-2ml'
import {
  matchReaderTests,
  parseEndoScan,
  readerCartridgeLambda,
  readerValidity,
  toReaderRecord,
  type ReaderTest,
} from '@/lib/endo-reader'
import {
  runCartridgeFor,
  type EndoCartridgeOption,
  type EndoRow,
} from '@/lib/endo-worksheet-2ml'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import { TH, UNIT } from '@/components/hplc/EndoWorksheetTable'

/** What the import returns: the applied count, the updated rows and the method. */
export type ReaderImportResult = Awaited<ReturnType<typeof importReaderResults>>

const MAX_FILE_BYTES = 2 * 1024 * 1024
const PCELL = 'border-b border-border/60 px-2 py-1.5 align-top'

type Action = 'fill' | 'replace' | 'same' | 'blocked'

interface PreviewRow {
  test: ReaderTest
  item: WorksheetItemRow
  /** The Box 1 row number. */
  n: number
  via: 'exact' | 'parent'
  valid: boolean
  why: string[]
  /** The file's cartridge sensitivity, or null when the file names none. */
  lambda: number | null
  cartridgeId: number | null
  action: Action
  note: string
}

interface Staged {
  fileName: string
  tests: ReaderTest[]
}

/** The file's text. A FileReader, as NewDocumentDialog reads its file:
 *  jsdom's File has no text(). */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('That file could not be read.'))
    reader.readAsText(file)
  })
}

/** Two readings the same as the server compares them: parsed, so "< 0.05"
 *  and "<0.05" are one reading. */
function sameReading(a: string, b: string): boolean {
  const x = parseReading(a)
  const y = parseReading(b)
  return x !== null && y !== null && x.lt === y.lt && x.value === y.value
}

/** Why a test cannot be sent, or null when it can. The server refuses the
 *  whole import for either. */
function unusableWhy(t: ReaderTest): string | null {
  if (!t.testId.trim()) return 'no Test ID in the file'
  if (parseReading(t.result) === null)
    return t.result
      ? `${t.result} is not a usable reading`
      : 'no reading in the file'
  return null
}

const testName = (t: ReaderTest) => t.testId.trim() || '(no Test ID)'

/**
 * What applying each test would do (Dennis's readerAction): each matched
 * test with its checks against the method's limits, the cartridge it maps
 * to, and fill / tick to replace / already imported / skipped. Of several
 * allowed types with the file's sensitivity, the row's cartridge, then the
 * run cartridge (`runId`); when neither is one of them, none is guessed.
 * matchReaderTests keeps one test per row (an exact ID over a parent ID,
 * then the latest). When that test cannot be sent it is listed in
 * `unusable` and the row gets nothing: an earlier test never stands in.
 * Each superseded test names the test its row uses.
 */
function buildPreview(
  tests: ReaderTest[],
  rows: EndoRow[],
  cartridges: EndoCartridgeOption[],
  params: EndoRunParams,
  runId: number | null
) {
  const sheet = rows.map(r => ({
    itemId: r.item.id,
    sampleId: r.item.sample_id,
  }))
  const m = matchReaderTests(tests, sheet)
  const byItem = new Map(rows.map(r => [r.item.id, r]))
  const used = new Map(m.matched.map(x => [x.itemId, x.test]))
  const lines: PreviewRow[] = []
  const unusable: { test: ReaderTest; why: string }[] = []
  for (const x of m.matched) {
    const row = byItem.get(x.itemId)
    if (!row) continue
    const skip = unusableWhy(x.test)
    if (skip) {
      unusable.push({ test: x.test, why: skip })
      continue
    }
    const item = row.item
    const { valid, why } = readerValidity(x.test, params)
    const lambda = readerCartridgeLambda(x.test.cartRange)
    const same =
      lambda === null
        ? []
        : cartridges.filter(c => Math.abs(c.sensitivity_eu_ml - lambda) < 1e-9)
    const picked =
      same.find(c => c.id === row.cartridge?.id) ??
      same.find(c => c.id === runId) ??
      (same.length === 1 ? same[0] : undefined)
    // Either way only an allowed type is sent: the server refuses the whole
    // import for one that is not (a row's own pick can be retired).
    const cartridgeId =
      lambda !== null
        ? (picked?.id ?? null)
        : (cartridges.find(c => c.id === row.cartridge?.id)?.id ?? null)
    const had = item.result_reading ?? null
    let action: Action = 'fill'
    let note = 'fills the reading'
    if (same.length > 1 && !picked) {
      action = 'blocked'
      note = 'more than one catalog cartridge has this sensitivity'
    } else if (lambda !== null && cartridgeId === null) {
      action = 'blocked'
      note = `cartridge not in the catalog (${fmt(lambda)} EU/mL)`
    } else if (cartridgeId === null) {
      action = 'blocked'
      note = 'no cartridge in the file, and none on this row the method allows'
    } else if (
      had !== null &&
      sameReading(had, x.test.result) &&
      item.result_reader?.test_id === x.test.testId
    ) {
      action = 'same'
      note = 'already imported'
    } else if (had !== null && !sameReading(had, x.test.result)) {
      action = 'replace'
      note = `has ${had}: tick to replace it`
    }
    lines.push({
      test: x.test,
      item,
      n: row.n,
      via: x.via,
      valid,
      why,
      lambda,
      cartridgeId,
      action,
      note,
    })
  }
  return {
    lines,
    unmatched: m.unmatched,
    ambiguous: m.ambiguous,
    // A test matched on its own always takes its row, which finds the row
    // each superseded test lost to.
    superseded: m.superseded.map(t => {
      const itemId = matchReaderTests([t], sheet).matched[0]?.itemId
      const sid =
        itemId === undefined ? null : byItem.get(itemId)?.item.sample_id
      const won = itemId === undefined ? undefined : used.get(itemId)
      if (!sid || !won) return testName(t)
      return unusableWhy(won)
        ? `${testName(t)} (${sid} uses none: ${testName(won)} is not usable)`
        : `${testName(t)} (${sid} uses ${testName(won)})`
    }),
    unusable,
  }
}

/**
 * The reader import on Box 3 (spec 8.1): drop the EndoScan-V export, or pick
 * it. The browser parses it and matches each test to a row by Sample ID
 * (exact, else the only vial of that parent on the sheet; never a guess
 * between two vials). The preview lists every test; nothing changes until
 * Apply, which sends one request. A row that already holds a different
 * reading is replaced only when its box is ticked. The raw file is not
 * stored; each row keeps the reader's record.
 */
export function EndoReaderImportDialog({
  worksheet,
  rows,
  cartridges,
  params,
  onApplied,
}: {
  worksheet: WorksheetListItem
  /** The page's rows (Box 1 order and numbers, each with its resolved cartridge). */
  rows: EndoRow[]
  /** The allowed cartridges (spec 4.3). */
  cartridges: EndoCartridgeOption[]
  params: EndoRunParams
  /** The response, and the rows this import sent. */
  onApplied: (res: ReaderImportResult, itemIds: number[]) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [staged, setStaged] = useState<Staged | null>(null)
  const [replace, setReplace] = useState<ReadonlySet<number>>(new Set())
  const [applying, setApplying] = useState(false)

  async function read(file: File | undefined) {
    if (!file) return
    setError(null)
    if (file.size > MAX_FILE_BYTES) {
      setError('That file is over 2 MB, too big for a reader export.')
      return
    }
    try {
      const parsed = parseEndoScan(await readText(file))
      setReplace(new Set())
      setStaged({ fileName: file.name, tests: parsed.tests })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be read.')
    }
  }

  function close() {
    setStaged(null)
    setError(null)
    setReplace(new Set())
  }

  function toggle(itemId: number, on: boolean) {
    setReplace(prev => {
      const next = new Set(prev)
      if (on) next.add(itemId)
      else next.delete(itemId)
      return next
    })
  }

  const preview = staged
    ? buildPreview(
        staged.tests,
        rows,
        cartridges,
        params,
        runCartridgeFor(worksheet)?.id ?? null
      )
    : null
  const chosen = (preview?.lines ?? []).filter(
    (r): r is PreviewRow & { cartridgeId: number } =>
      r.cartridgeId !== null &&
      (r.action === 'fill' ||
        (r.action === 'replace' && replace.has(r.item.id)))
  )

  async function apply() {
    if (!staged || !chosen.length) return
    setApplying(true)
    setError(null)
    try {
      const res = await importReaderResults(worksheet.id, {
        file_name: staged.fileName,
        tests: chosen.map(r => ({
          item_id: r.item.id,
          reading: r.test.result,
          record: toReaderRecord(r.test, params, staged.fileName),
          cartridge_type_id: r.cartridgeId,
          replace: r.action === 'replace',
        })),
      })
      onApplied(
        res,
        chosen.map(r => r.item.id)
      )
      toast.success(
        `${res.applied} ${res.applied === 1 ? 'reading' : 'readings'} applied from ${staged.fileName}`
      )
      close()
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The import failed; nothing was changed.'
      )
    } finally {
      setApplying(false)
    }
  }

  return (
    <>
      <div
        onDragOver={e => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={e => {
          e.preventDefault()
          setOver(false)
          void read(e.dataTransfer.files[0])
        }}
        className={`rounded-[5px] border border-dashed p-3.5 text-center text-[12.5px] ${over ? 'border-solid border-teal-500 bg-teal-500/10 text-teal-800 dark:border-teal-400 dark:bg-teal-400/15 dark:text-teal-200' : 'bg-muted/40 text-muted-foreground'}`}
      >
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv,text/plain"
          aria-label="Reader export file"
          className="sr-only"
          onChange={e => {
            const file = e.target.files?.[0]
            e.target.value = ''
            void read(file)
          }}
        />
        Reader export (EndoScan-V CSV): drop it here, or{' '}
        <button
          type="button"
          className="text-teal-700 underline underline-offset-2 hover:text-teal-600 focus-visible:outline-2 focus-visible:outline-teal-500 dark:text-teal-300 dark:hover:text-teal-200 dark:focus-visible:outline-teal-400"
          onClick={() => fileInput.current?.click()}
        >
          choose a file
        </button>
        . Each test is matched to its sample by Sample ID, with its spike
        recovery and CV.
        {error && !staged && (
          <p
            role="alert"
            className="mt-1.5 text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}
      </div>

      <Dialog
        open={staged !== null}
        onOpenChange={open => {
          if (!open) close()
        }}
      >
        {staged && preview && (
          <DialogContent className="flex max-h-[88vh] w-[1100px] max-w-[96vw] flex-col gap-3 sm:max-w-[96vw]">
            <DialogTitle className="text-sm font-semibold">
              Reader import
            </DialogTitle>
            <DialogDescription className="font-mono text-[11.5px]">
              {staged.fileName} · {staged.tests.length}{' '}
              {staged.tests.length === 1 ? 'test' : 'tests'} read · nothing
              changes until Apply
            </DialogDescription>
            <div className="min-h-0 overflow-auto">
              <table className="w-full min-w-[900px] border-collapse text-[12.5px]">
                <thead>
                  <tr>
                    <th className={TH}>Reader sample</th>
                    <th className={TH}>Product</th>
                    <th className={TH}>Row on this sheet</th>
                    <th className={`${TH} !text-right`}>
                      Result<span className={UNIT}>EU/mL on the MCS</span>
                    </th>
                    <th className={`${TH} !text-right`}>
                      Spike recovery
                      <span className={UNIT}>
                        valid {params.spikeRecoveryMinPct}-
                        {params.spikeRecoveryMaxPct} %
                      </span>
                    </th>
                    <th className={`${TH} !text-right`}>
                      CV
                      <span className={UNIT}>
                        sample / spike, %, limit {params.cvLimitPct}
                      </span>
                    </th>
                    <th className={TH}>Check</th>
                    <th className={TH}>
                      Cartridge
                      <span className={UNIT}>EU/mL, from the file</span>
                    </th>
                    <th className={TH}>What Apply does</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map(r => {
                    const t = r.test
                    const recOut =
                      t.recovery !== null &&
                      (t.recovery < params.spikeRecoveryMinPct ||
                        t.recovery > params.spikeRecoveryMaxPct)
                    const muted = r.action === 'blocked' || r.action === 'same'
                    return (
                      <tr
                        key={`${t.testId}-${r.item.id}`}
                        className={muted ? 'text-muted-foreground' : ''}
                      >
                        <td className={`${PCELL} font-mono`}>
                          {t.sampleId || '(no ID)'}
                        </td>
                        <td className={PCELL}>{t.identity}</td>
                        <td className={`${PCELL} font-mono`}>
                          {r.item.sample_id}
                          {r.via === 'parent' ? ' (by its vial)' : ''} · row{' '}
                          {r.n}
                        </td>
                        <td className={`${PCELL} text-right font-mono`}>
                          {t.result}
                        </td>
                        <td
                          className={`${PCELL} text-right font-mono ${recOut ? 'font-semibold text-red-600 dark:text-red-400' : ''}`}
                        >
                          {t.recovery === null ? '-' : `${t.recovery} %`}
                        </td>
                        <td className={`${PCELL} text-right font-mono`}>
                          {t.sampleCv ?? '-'} / {t.spikeCv ?? '-'}
                        </td>
                        <td
                          className={`${PCELL} font-semibold ${r.valid ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
                        >
                          {r.valid ? 'Valid' : 'Invalid'}
                          {t.readerPass !== null && t.readerPass !== r.valid
                            ? ' (reader flag differs)'
                            : ''}
                          {!r.valid && (
                            <span className="block text-[11px] font-normal">
                              {r.why.join('; ')}
                            </span>
                          )}
                        </td>
                        <td className={`${PCELL} font-mono`}>
                          {r.lambda === null
                            ? 'none in the file'
                            : fmt(r.lambda)}
                        </td>
                        <td className={PCELL}>
                          {r.action === 'replace' ? (
                            <label className="inline-flex cursor-pointer items-center gap-1.5">
                              <Checkbox
                                checked={replace.has(r.item.id)}
                                onCheckedChange={v =>
                                  toggle(r.item.id, v === true)
                                }
                                aria-label={`Replace the reading on ${r.item.sample_id}`}
                              />
                              {r.note}
                            </label>
                          ) : (
                            r.note
                          )}
                          {!r.valid && !muted && (
                            <span className="block text-[11px] text-red-600 dark:text-red-400">
                              stored as Invalid: no Pass, nothing to Accu-Mk1;
                              rerun it
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {preview.ambiguous.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                More than one vial on this sheet, skipped (type these by hand):{' '}
                {preview.ambiguous.map(t => t.sampleId).join(', ')}
              </p>
            )}
            {preview.superseded.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Other tests of a row tested more than once, skipped:{' '}
                {preview.superseded.join(', ')}
              </p>
            )}
            {preview.unusable.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Not usable, skipped:{' '}
                {preview.unusable
                  .map(u => `${u.test.sampleId} (${u.why})`)
                  .join(', ')}
              </p>
            )}
            {preview.unmatched.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Not on this sheet, skipped:{' '}
                {preview.unmatched.map(t => t.sampleId || '(no ID)').join(', ')}
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="text-xs text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            )}
            <div className="flex items-center gap-2 border-t pt-3">
              <Button
                size="sm"
                className="bg-teal-600 text-white hover:bg-teal-600/90"
                disabled={!chosen.length || applying}
                onClick={() => void apply()}
              >
                Apply {chosen.length}{' '}
                {chosen.length === 1 ? 'reading' : 'readings'}
              </Button>
              <Button size="sm" variant="outline" onClick={close}>
                Discard
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}

export default EndoReaderImportDialog
