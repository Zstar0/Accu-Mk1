import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import type { InboxPriority } from '@/lib/api'

interface InboxBulkToolbarProps {
  selectedCount: number
  onSetPriority: (priority: InboxPriority) => void
  onCreateWorksheet: () => void
  onClearSelection: () => void
}

export function InboxBulkToolbar({
  selectedCount,
  onSetPriority,
  onCreateWorksheet,
  onClearSelection,
}: InboxBulkToolbarProps) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 duration-200">
      <div className="bg-background border shadow-lg rounded-lg px-4 py-3 flex items-center gap-3 whitespace-nowrap">
        {/* Selected count */}
        <span className="text-sm font-medium text-muted-foreground">
          {selectedCount} selected
        </span>

        <div className="w-px h-5 bg-border shrink-0" />

        {/* Set Priority */}
        <Select onValueChange={value => onSetPriority(value as InboxPriority)}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder="Set Priority" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="normal">Normal</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="expedited">Expedited</SelectItem>
          </SelectContent>
        </Select>

        <div className="w-px h-5 bg-border shrink-0" />

        {/* Create Worksheet — primary action */}
        <Button size="sm" variant="default" onClick={onCreateWorksheet}>
          Create Worksheet
        </Button>

        {/* Clear selection */}
        <Button size="sm" variant="ghost" onClick={onClearSelection}>
          Clear
        </Button>
      </div>
    </div>
  )
}
