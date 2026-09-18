import { useState } from 'react'
import { MoveRight } from 'lucide-react'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { WorksheetListItem } from '@/lib/api'

type ItemType = WorksheetListItem['items'][number]

interface ReassignButtonProps {
  item: ItemType
  otherWorksheets: WorksheetListItem[]
  onReassign: (itemId: number, targetWorksheetId: number) => void
}

/** "Move to worksheet" popover for a worksheet item. Shared by the generic
 *  item row and the endo bench table. */
export function ReassignButton({
  item,
  otherWorksheets,
  onReassign,
}: ReassignButtonProps) {
  const [open, setOpen] = useState(false)
  const hasTargets = otherWorksheets.length > 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="h-6 w-6 flex items-center justify-center opacity-0 group-hover/item:opacity-100 transition-opacity text-muted-foreground hover:text-foreground rounded disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label={`Move ${item.sample_id} to another worksheet`}
          disabled={!hasTargets}
          title={hasTargets ? undefined : 'No other open worksheets'}
          onClick={e => {
            if (!hasTargets) e.preventDefault()
          }}
        >
          <MoveRight className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      {hasTargets && (
        <PopoverContent className="w-56 p-2" align="end">
          <p className="text-xs font-semibold text-muted-foreground mb-2">
            Move to worksheet
          </p>
          <Select
            onValueChange={value => {
              onReassign(item.id, Number(value))
              setOpen(false)
            }}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Select worksheet..." />
            </SelectTrigger>
            <SelectContent>
              {otherWorksheets.map(ws => (
                <SelectItem key={ws.id} value={String(ws.id)}>
                  {ws.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PopoverContent>
      )}
    </Popover>
  )
}

export default ReassignButton
