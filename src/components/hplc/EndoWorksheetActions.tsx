import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Download, Eye, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  recordWorksheetPrinted,
  type WorksheetListItem,
  type WorksheetUser,
} from '@/lib/api'
import { buildEndoBenchSheetHtml, buildEndoCsv } from '@/lib/endo-bench-sheet'
import { buildEndoSheetDoc, isEndoWorksheetItem } from '@/lib/endo-worksheet'
import { worksheetItemSlaSubjects } from '@/lib/worksheet-sla-subjects'
import { downloadTextFile, printHtmlDocument } from '@/lib/print-document'
import { displayName } from '@/lib/user-display'
import { useLabCalendar } from '@/hooks/use-lab-calendar'
import { useSlaForSubjects } from '@/services/sla-subjects'

/**
 * Preview, Print and CSV for a worksheet that holds endotoxin items, as on
 * Dennis's tool. All three build the same document (bench order, prep
 * figures, SLA due dates) so screen, paper and export never disagree. The
 * tech prints the sheet and carries it to the bench, so every Print is
 * recorded: the first one is the run's start (worksheets.printed_at).
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
  const endoItems = worksheet.items.filter(isEndoWorksheetItem)
  const { byKey } = useSlaForSubjects(
    worksheetItemSlaSubjects(
      endoItems,
      worksheet.status === 'completed' ? worksheet.completed_at : null
    )
  )
  // The browser never says whether the print dialog was confirmed, so the
  // click is what gets recorded. A failed record must not block the printout.
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
  const doc = () =>
    buildEndoSheetDoc(worksheet, {
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
  const fileStem = worksheet.title.replace(/[^A-Za-z0-9._-]+/g, '_')
  const waiting = calendar ? undefined : 'Loading the lab calendar…'

  function print() {
    printHtmlDocument(buildEndoBenchSheetHtml(doc()))
    recordPrint.mutate()
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!calendar}
        title={waiting ?? 'See the bench sheet as it will print'}
        onClick={() =>
          setPreviewHtml(buildEndoBenchSheetHtml(doc(), { preview: true }))
        }
      >
        <Eye className="h-3.5 w-3.5" />
        Preview
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!calendar}
        title={waiting ?? 'Print the bench sheet to take to the bench'}
        onClick={print}
      >
        <Printer className="h-3.5 w-3.5" />
        Print
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!calendar}
        title={waiting ?? 'Export the bench rows as CSV'}
        onClick={() =>
          downloadTextFile(`${fileStem}_endotoxin.csv`, buildEndoCsv(doc()))
        }
      >
        <Download className="h-3.5 w-3.5" />
        CSV
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
              {worksheet.title} · landscape Letter, 10 samples per page
            </DialogDescription>
            <span className="flex-1" />
            <Button
              size="sm"
              className="bg-teal-600 text-white hover:bg-teal-600/90"
              onClick={() => {
                setPreviewHtml(null)
                print()
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
