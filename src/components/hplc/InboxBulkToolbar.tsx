import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import type { InboxPriority, WorksheetUser } from '@/lib/api'

interface InboxBulkToolbarProps {
  selectedCount: number
  onSetPriority: (priority: InboxPriority) => void
  onAssignTech: (analystId: number) => void
  onSetInstrument: (instrumentUid: string) => void
  onCreateWorksheet: () => void
  onClearSelection: () => void
  users: WorksheetUser[]
  instruments: { uid: string; title: string }[]
}

export function InboxBulkToolbar({
  selectedCount,
  onSetPriority,
  onAssignTech,
  onSetInstrument,
  onCreateWorksheet,
  onClearSelection,
  users,
  instruments,
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

        {/* Assign Tech */}
        <Select
          onValueChange={value => onAssignTech(Number(value))}
          disabled={users.length === 0}
        >
          <SelectTrigger size="sm" className="w-44">
            <SelectValue placeholder="Assign Tech" />
          </SelectTrigger>
          <SelectContent>
            {users.map(user => (
              <SelectItem key={user.id} value={String(user.id)}>
                {user.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Set Instrument */}
        <Select
          onValueChange={value => onSetInstrument(value)}
          disabled={instruments.length === 0}
        >
          <SelectTrigger size="sm" className="w-44">
            <SelectValue placeholder="Set Instrument" />
          </SelectTrigger>
          <SelectContent>
            {instruments.map(inst => (
              <SelectItem key={inst.uid} value={inst.uid}>
                {inst.title}
              </SelectItem>
            ))}
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
