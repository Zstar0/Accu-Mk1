import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * The customer's "Notes for Lab" from the order wizard, as a receive-page cell.
 *
 * Customer-origin remarks only — never a lab remark (the backend query in
 * registry_list.fetch_customer_notes enforces that). Notes routinely run past
 * a column's width, so the cell truncates to one line and puts the full text
 * in a hover tooltip rather than wrapping and stretching every row.
 *
 * Empty is the common case and renders NOTHING, not a placeholder: samples
 * ordered before the note was persisted natively have none, and this table
 * deliberately avoids standalone em-dash placeholders (pinned by
 * OrderListRow.test.tsx's "omits standalone placeholders" case).
 */
export function CustomerNoteCell({ note }: { note?: string | null }) {
  const text = (note ?? '').trim()
  if (!text) {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="block max-w-[16rem] truncate text-xs text-foreground"
          data-testid="customer-note"
        >
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-wrap">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
