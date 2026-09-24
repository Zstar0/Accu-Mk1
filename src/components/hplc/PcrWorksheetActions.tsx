import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Download, Eye, FileDown, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { recordWorksheetPrinted, type WorksheetWellFreeze } from '@/lib/api'
import {
  buildPcrBenchSheetHtml,
  buildPcrPlateMapCsv,
  buildPcrWellListCsv,
} from '@/lib/pcr-bench-sheet'
import { freezePayload, quantStudioFiles } from '@/lib/pcr-plate'
import type { PcrRunDoc } from '@/lib/pcr-worksheet'
import { downloadTextFile, printHtmlDocument } from '@/lib/print-document'

/**
 * Dennis's run actions: the QuantStudio sample file (one per plate), the
 * plate map and well list CSVs, Preview and Print. Print and the QuantStudio
 * export are what load the plate, so both freeze the wells first (ruling
 * 2026-09-22) and print is recorded like the endo sheet: the first print is
 * the run's start on the bench.
 */
export function PcrWorksheetActions({
  worksheetId,
  buildDoc,
  ready,
  isCompleted,
  onFreeze,
}: {
  worksheetId: number
  /** Builds the run document at click time, so it carries the print stamp. */
  buildDoc: () => PcrRunDoc
  /** False until the lab calendar has loaded (dates would print blank). */
  ready: boolean
  isCompleted: boolean
  /** Pins the wells; resolves once the server has them. */
  onFreeze: (wells: WorksheetWellFreeze[]) => Promise<unknown>
}) {
  const queryClient = useQueryClient()
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  // The browser never says whether the print dialog was confirmed, so the
  // click is what gets recorded. A failed record must not block the printout.
  const recordPrint = useMutation({
    mutationFn: () => recordWorksheetPrinted(worksheetId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      queryClient.invalidateQueries({ queryKey: ['worksheet-by-id'] })
    },
  })
  const waiting = ready ? undefined : 'Loading the lab calendar…'

  /** Freeze the wells this layout shows, then hand the doc on. A refused
   *  freeze (a well taken by a concurrent edit) stops the export. */
  async function loaded(doc: PcrRunDoc): Promise<boolean> {
    if (isCompleted) return true
    const wells = freezePayload(doc.layout)
    if (!wells.length) return true
    try {
      await onFreeze(wells)
      return true
    } catch {
      return false
    }
  }

  async function print() {
    const doc = buildDoc()
    if (!(await loaded(doc))) return
    printHtmlDocument(buildPcrBenchSheetHtml(doc))
    recordPrint.mutate()
  }

  async function quantStudio(plate?: number) {
    const doc = buildDoc()
    if (!(await loaded(doc))) return
    const files = quantStudioFiles(doc.layout, {
      runId: doc.meta.runId,
      date: doc.meta.date,
    })
    for (const f of files)
      if (plate === undefined || f.plate === plate)
        downloadTextFile(f.filename, f.text, 'text/plain;charset=utf-8')
  }

  const doc = buildDoc()
  const stem = doc.title.replace(/[^A-Za-z0-9._-]+/g, '_')
  const plates = doc.layout.plateCount

  return (
    <>
      {plates > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={!ready}
              title={
                waiting ??
                'One file per plate for Plate Setup, Define Samples, Import'
              }
            >
              <FileDown className="h-3.5 w-3.5" />
              QuantStudio file
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {doc.layout.plates.map(pl => (
              <DropdownMenuItem
                key={pl.plate}
                onSelect={() => void quantStudio(pl.plate)}
              >
                Plate {pl.plate} of {plates} ({pl.n} wells)
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={!ready}
          title={
            waiting ??
            'Tab-delimited sample file for Plate Setup, Define Samples, Import'
          }
          onClick={() => void quantStudio()}
        >
          <FileDown className="h-3.5 w-3.5" />
          QuantStudio file
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={!ready}
        title={waiting ?? 'Two 8 x 12 grids per plate: ids, then identities'}
        onClick={() =>
          downloadTextFile(
            `${stem}_plate-map.csv`,
            buildPcrPlateMapCsv(buildDoc())
          )
        }
      >
        <Download className="h-3.5 w-3.5" />
        Plate map CSV
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!ready}
        title={waiting ?? 'One row per occupied well in both blocks'}
        onClick={() =>
          downloadTextFile(
            `${stem}_well-list.csv`,
            buildPcrWellListCsv(buildDoc())
          )
        }
      >
        <Download className="h-3.5 w-3.5" />
        Well list CSV
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!ready}
        title={waiting ?? 'See the pages as they will print'}
        onClick={() =>
          setPreviewHtml(buildPcrBenchSheetHtml(buildDoc(), { preview: true }))
        }
      >
        <Eye className="h-3.5 w-3.5" />
        Preview
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!ready}
        title={waiting ?? 'Print one page per plate; locks the wells'}
        onClick={() => void print()}
      >
        <Printer className="h-3.5 w-3.5" />
        Print
      </Button>

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
              {doc.title} · landscape Letter, one page per plate
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
              title="Plate sheet preview"
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

export default PcrWorksheetActions
