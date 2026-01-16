/**
 * PreviewTable component for displaying parsed file data.
 * Shows column headers, first 10 rows, row count, and any errors.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { type ParsePreview } from '@/lib/api'
import { FileText, X, AlertCircle, CheckCircle2 } from 'lucide-react'

interface PreviewTableProps {
  preview: ParsePreview
  onRemove?: () => void
}

const MAX_PREVIEW_ROWS = 10

export function PreviewTable({ preview, onRemove }: PreviewTableProps) {
  const { filename, headers, rows, row_count, errors } = preview
  const hasErrors = errors.length > 0
  const displayRows = rows.slice(0, MAX_PREVIEW_ROWS)
  const hasMoreRows = row_count > MAX_PREVIEW_ROWS

  return (
    <Card className={hasErrors ? 'border-destructive/50' : ''}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="size-4" />
          {filename}
          {hasErrors ? (
            <Badge variant="destructive" className="ml-2">
              <AlertCircle className="size-3" />
              Error
            </Badge>
          ) : (
            <Badge variant="secondary" className="ml-2">
              <CheckCircle2 className="size-3" />
              {row_count} rows
            </Badge>
          )}
        </CardTitle>
        {onRemove && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRemove}
            aria-label={`Remove ${filename}`}
          >
            <X className="size-4" />
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {hasErrors ? (
          <div className="flex flex-col gap-2">
            {errors.map((error, index) => (
              <div
                key={index}
                className="flex items-center gap-2 text-sm text-destructive"
              >
                <AlertCircle className="size-4" />
                {error}
              </div>
            ))}
          </div>
        ) : (
          <ScrollArea className="w-full">
            <div className="min-w-max">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    {headers.map((header, index) => (
                      <th
                        key={index}
                        className="px-3 py-2 text-left font-medium text-muted-foreground"
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row, rowIndex) => (
                    <tr
                      key={rowIndex}
                      className="border-b last:border-b-0 hover:bg-muted/50"
                    >
                      {headers.map((header, colIndex) => (
                        <td key={colIndex} className="px-3 py-2">
                          {formatCellValue(row[header])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        )}
        {hasMoreRows && !hasErrors && (
          <div className="mt-2 text-sm text-muted-foreground">
            Showing {MAX_PREVIEW_ROWS} of {row_count} rows
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Format a cell value for display.
 */
function formatCellValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '-'
  }
  if (typeof value === 'number') {
    // Format numbers with reasonable precision
    return Number.isInteger(value) ? value.toString() : value.toFixed(4)
  }
  return value
}
