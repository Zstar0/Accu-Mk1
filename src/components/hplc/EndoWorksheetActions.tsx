import { Download, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { WorksheetListItem, WorksheetUser } from '@/lib/api'
import { buildEndoBenchSheetHtml, buildEndoCsv } from '@/lib/endo-bench-sheet'
import { buildEndoSheetDoc, isEndoWorksheetItem } from '@/lib/endo-worksheet'
import { downloadTextFile, printHtmlDocument } from '@/lib/print-document'
import { displayName } from '@/lib/user-display'
import { useLabCalendar } from '@/hooks/use-lab-calendar'

/**
 * "Bench sheet" and "CSV" for a worksheet that holds endotoxin items. Both
 * build the same document (bench order, prep figures, due dates) so paper and
 * export never disagree. Renders nothing on a worksheet with no endo work.
 */
export function EndoWorksheetActions({
  worksheet,
  users,
}: {
  worksheet: WorksheetListItem
  users: WorksheetUser[]
}) {
  const { calendar } = useLabCalendar()
  if (!worksheet.items.some(isEndoWorksheetItem)) return null

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
    })
  const fileStem = worksheet.title.replace(/[^A-Za-z0-9._-]+/g, '_')

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!calendar}
        title={
          calendar
            ? 'Print the endotoxin bench sheet'
            : 'Loading the lab calendar…'
        }
        onClick={() => printHtmlDocument(buildEndoBenchSheetHtml(doc()))}
      >
        <Printer className="h-3.5 w-3.5" />
        Bench sheet
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!calendar}
        title="Export the bench rows as CSV"
        onClick={() =>
          downloadTextFile(`${fileStem}_endotoxin.csv`, buildEndoCsv(doc()))
        }
      >
        <Download className="h-3.5 w-3.5" />
        CSV
      </Button>
    </>
  )
}

export default EndoWorksheetActions
