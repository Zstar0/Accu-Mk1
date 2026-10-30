import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Eye, Printer } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  getWorksheet,
  listConsumables,
  recordWorksheetPrinted,
  type WorksheetListItem,
  type WorksheetUser,
} from '@/lib/api'
import { buildEndoBenchSheetHtml, buildEndoCsv } from '@/lib/endo-bench-sheet'
import {
  buildEndoBenchSheet2Html,
  buildEndoCsv2,
  buildEndoSheet2Doc,
} from '@/lib/endo-bench-sheet-2ml'
import { endoscanSampleCsv } from '@/lib/endo-reader-export'
import {
  buildEndoSheetDoc,
  isEndoWorksheetItem,
  type EndoSheetOptions,
} from '@/lib/endo-worksheet'
import { worksheetItemSlaSubjects } from '@/lib/worksheet-sla-subjects'
import { downloadTextFile, printHtmlDocument } from '@/lib/print-document'
import { displayName } from '@/lib/user-display'
import { useLabCalendar } from '@/hooks/use-lab-calendar'
import { worksheetPageKey } from '@/hooks/use-worksheet-drawer'
import { useEndoPrepRules } from '@/services/endo-prep-rules'
import { useSlaForSubjects } from '@/services/sla-subjects'

/**
 * Preview, Print and CSV for a worksheet that holds endotoxin items, as on
 * Dennis's tool. All three build the same document (bench order, prep
 * figures, SLA due dates) so screen, paper and export never disagree. The
 * tech prints the sheet and carries it to the bench, so every Print is
 * recorded: the first one is the run's start (worksheets.printed_at), and
 * it pins the worksheet's endo method. A 2 mL worksheet prints the 2 mL
 * sheet (endo-bench-sheet-2ml.ts) from the GET-by-id worksheet, which
 * carries the method; a stock worksheet prints the stock sheet as before.
 * Renders nothing on a worksheet with no endo work.
 */
export function EndoWorksheetActions({
  worksheet,
  users,
}: {
  worksheet: WorksheetListItem
  users: WorksheetUser[]
}) {
  const queryClient = useQueryClient()
  const { calendar } = useLabCalendar()
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const twoMl = worksheet.endo_prep === '2ml'
  // The list payload has no endo_method key; a 2 mL sheet needs the method
  // (run parameters, cartridges), so it reads the page's GET-by-id entry.
  const needsFull = twoMl && worksheet.endo_method === undefined
  const { data: full, isError: fullFailed } = useQuery({
    queryKey: worksheetPageKey(worksheet.id),
    queryFn: () => getWorksheet(worksheet.id),
    enabled: needsFull,
    staleTime: 30_000,
  })
  const sheetWorksheet = needsFull ? full : worksheet
  // The allowed list when no method resolves, or the method links no
  // cartridges (4.3), as the page reads it.
  const { data: catalog, isError: catalogFailed } = useQuery({
    queryKey: ['consumables', 'endo_cartridge'],
    queryFn: () => listConsumables({ kind: 'endo_cartridge' }),
    enabled: twoMl,
    staleTime: 5 * 60_000,
  })
  const needsCatalog = twoMl && !sheetWorksheet?.endo_method?.cartridges.length
  // The rule lines a row that is not locked yet prints under (slice 5).
  const { data: rules, isError: rulesFailed } = useEndoPrepRules(twoMl)
  // Due dates key on the items the sheet is built from.
  const sheetItems = (sheetWorksheet ?? worksheet).items
  const endoItems = sheetItems.filter(isEndoWorksheetItem)
  // Due dates order the bench and print in the Due column; a sheet built
  // before they land prints them blank and numbers the rows another way.
  const { byKey, isLoading: slaLoading } = useSlaForSubjects(
    worksheetItemSlaSubjects(
      endoItems,
      worksheet.status === 'completed' ? worksheet.completed_at : null
    )
  )
  // The browser never says whether the print dialog was confirmed, so the
  // click is what gets recorded (print() says when it blocks the printout).
  const recordPrint = useMutation({
    mutationFn: () => recordWorksheetPrinted(worksheet.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      queryClient.invalidateQueries({ queryKey: ['worksheet-by-id'] })
    },
  })
  if (!endoItems.length) return null

  const analyst = users.find(u => u.id === worksheet.assigned_analyst)
  const analystName = analyst
    ? displayName(analyst)
    : (worksheet.assigned_analyst_email ?? '')
  const opts = (): EndoSheetOptions => ({
    analystName,
    calendar,
    printedAt: new Date().toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    dueAtByItemId: new Map(
      endoItems.map(it => [
        it.id,
        byKey.get(String(it.id))?.status.due_at ?? null,
      ])
    ),
  })
  const sheetHtml = (preview: boolean, ws = sheetWorksheet) =>
    twoMl && ws
      ? buildEndoBenchSheet2Html(
          buildEndoSheet2Doc(ws, opts(), catalog, rules ?? []),
          { preview }
        )
      : buildEndoBenchSheetHtml(buildEndoSheetDoc(worksheet, opts()), {
          preview,
        })
  const sheetCsv = () =>
    twoMl && sheetWorksheet
      ? buildEndoCsv2(
          buildEndoSheet2Doc(sheetWorksheet, opts(), catalog, rules ?? [])
        )
      : buildEndoCsv(buildEndoSheetDoc(worksheet, opts()))
  const fileStem = worksheet.title.replace(/[^A-Za-z0-9._-]+/g, '_')
  /**
   * The EndoScan-V Sample Database file, built from the same doc the bench
   * sheet prints, so the reader is set up with the limits the run was planned
   * on. 2 mL runs only: the export is built on that model.
   */
  const downloadReaderCsv = () => {
    if (!sheetWorksheet) return
    const doc = buildEndoSheet2Doc(sheetWorksheet, opts(), catalog, rules ?? [])
    const { csv, count, skipped } = endoscanSampleCsv(
      doc.rows.map(r => r.sample),
      doc.ctx
    )
    downloadTextFile(`${fileStem}_endoscan.csv`, csv)
    // Never silently: a row the reader cannot be set up for is named.
    if (skipped.length > 0) {
      toast.warning(
        `${count} vial${count === 1 ? '' : 's'} written, ${skipped.length} left out`,
        {
          description: skipped
            .map(s => `${s.sampleId || '(no ID)'}: ${s.why}`)
            .join('; '),
        }
      )
    } else {
      toast.success(`${count} vial${count === 1 ? '' : 's'} written`)
    }
  }
  // A failed refetch keeps the data it had (react-query): only a read with
  // nothing on hand blocks the sheet.
  const runSettingsFailed =
    twoMl &&
    ((needsFull && fullFailed && !full) ||
      (needsCatalog && catalogFailed && !catalog) ||
      (rulesFailed && !rules))
  const waiting = !calendar
    ? 'Loading the lab calendar…'
    : runSettingsFailed
      ? 'Could not load the run settings; reopen to try again'
      : twoMl && (!sheetWorksheet || (needsCatalog && !catalog))
        ? 'Loading the run settings…'
        : slaLoading
          ? 'Loading the SLA due dates…'
          : twoMl && !rules
            ? 'Loading the prep rules…'
            : undefined

  // Record, then print (spec 6). On a 2 mL run the record locks every row
  // not locked yet to the rule the server matches at that moment, so the
  // paper is built from the worksheet read back after it, each row on its
  // lock, never from a rules list that may be seconds old. A failed record
  // or read back prints nothing; a print cancelled in the dialog still
  // counts as recorded. A stock sheet has no locks: it prints first, and a
  // failed record does not block it.
  async function print() {
    if (!twoMl) {
      printHtmlDocument(sheetHtml(false))
      recordPrint.mutate()
      return
    }
    let locked: WorksheetListItem
    try {
      await recordPrint.mutateAsync()
      // a GET already in flight may predate the locks
      await queryClient.cancelQueries({
        queryKey: worksheetPageKey(worksheet.id),
      })
      locked = await queryClient.fetchQuery({
        queryKey: worksheetPageKey(worksheet.id),
        queryFn: () => getWorksheet(worksheet.id),
        staleTime: 0,
      })
    } catch (err) {
      toast.error(
        `Not printed: ${err instanceof Error ? err.message : 'the print was not recorded'}`
      )
      return
    }
    printHtmlDocument(sheetHtml(false, locked))
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={waiting !== undefined}
        title={waiting ?? 'See the bench sheet as it will print'}
        onClick={() => setPreviewHtml(sheetHtml(true))}
      >
        <Eye className="h-3.5 w-3.5" />
        Preview
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={waiting !== undefined}
        title={waiting ?? 'Print the bench sheet to take to the bench'}
        onClick={() => void print()}
      >
        <Printer className="h-3.5 w-3.5" />
        Print
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={waiting !== undefined}
        title={waiting ?? 'Export the bench rows as CSV'}
        onClick={() =>
          downloadTextFile(`${fileStem}_endotoxin.csv`, sheetCsv())
        }
      >
        <Download className="h-3.5 w-3.5" />
        CSV
      </Button>
      {twoMl && (
        <Button
          variant="outline"
          size="sm"
          disabled={waiting !== undefined}
          title={
            waiting ??
            'Export the vials as an EndoScan-V Sample Database CSV, to import into the reader before the run'
          }
          onClick={downloadReaderCsv}
        >
          <Download className="h-3.5 w-3.5" />
          Reader CSV
        </Button>
      )}

      <Dialog
        open={previewHtml !== null}
        onOpenChange={open => {
          if (!open) setPreviewHtml(null)
        }}
      >
        <DialogContent className="flex h-[92vh] w-[1160px] max-w-[96vw] flex-col gap-0 p-0 sm:max-w-[96vw]">
          <div className="flex items-center gap-3 border-b px-4 py-2.5 pr-12">
            <DialogTitle className="text-sm font-semibold">
              Print preview
            </DialogTitle>
            <DialogDescription className="font-mono text-[11.5px]">
              {worksheet.title} · landscape Letter, 10 samples per page
            </DialogDescription>
            <span className="flex-1" />
            <Button
              size="sm"
              className="bg-teal-600 text-white hover:bg-teal-600/90"
              onClick={() => {
                setPreviewHtml(null)
                void print()
              }}
            >
              <Printer className="h-3.5 w-3.5" />
              Print
            </Button>
          </div>
          {previewHtml !== null && (
            <iframe
              title="Bench sheet preview"
              sandbox=""
              srcDoc={previewHtml}
              className="min-h-0 w-full flex-1 border-0 bg-[#E7ECEC]"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

export default EndoWorksheetActions
