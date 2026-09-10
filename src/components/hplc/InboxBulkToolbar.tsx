import { toast } from 'sonner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import type { InboxVialItem } from '@/lib/api'
import {
  useActivePriorities,
  useAssignPriorityBulk,
} from '@/services/priorities'

/** Sentinel for "clear the explicit key and inherit up the chain". Radix
 *  Select rejects an empty-string item value, so the null travels as this. */
const INHERIT = '__inherit__'

interface InboxBulkToolbarProps {
  /** The selected inbox rows themselves — priority is assigned at the VIAL
   *  level against each row's native sub-sample pk, so the toolbar needs the
   *  rows, not just a count. */
  selected: InboxVialItem[]
  onCreateWorksheet: () => void
  onClearSelection: () => void
}

export function InboxBulkToolbar({
  selected,
  onCreateWorksheet,
  onClearSelection,
}: InboxBulkToolbarProps) {
  const { data: priorities } = useActivePriorities()
  const assignBulk = useAssignPriorityBulk()

  function setPriority(value: string) {
    const priority_key = value === INHERIT ? null : value
    // Parent rows and SENAITE-only rows carry no native vial: there is nothing
    // to write against, so they're skipped rather than silently retargeted at
    // the parent sample (which would widen the blast radius of the change).
    const items = selected
      .filter(v => v.sub_sample_pk != null)
      .map(v => ({
        level: 'vial' as const,
        id: String(v.sub_sample_pk),
        priority_key,
      }))
    const skipped = selected.length - items.length
    if (items.length > 0) assignBulk.mutate(items)
    if (skipped > 0) {
      toast.warning(
        `${skipped} item${skipped === 1 ? '' : 's'} skipped — no native vial`
      )
    }
  }

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 duration-200">
      <div className="bg-background border shadow-lg rounded-lg px-4 py-3 flex items-center gap-3 whitespace-nowrap">
        {/* Selected count */}
        <span className="text-sm font-medium text-muted-foreground">
          {selected.length} selected
        </span>

        <div className="w-px h-5 bg-border shrink-0" />

        {/* Set Priority — catalog-driven, plus an explicit Inherit. */}
        <Select onValueChange={setPriority} disabled={assignBulk.isPending}>
          <SelectTrigger size="sm" className="w-36" aria-label="Set Priority">
            <SelectValue placeholder="Set Priority" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>Inherit</SelectItem>
            {(priorities ?? []).map(p => (
              <SelectItem key={p.key} value={p.key}>
                {p.name}
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
