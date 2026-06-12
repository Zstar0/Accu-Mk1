import { useDraggable } from '@dnd-kit/core'
import { GripVertical } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'
import { AgingTimer } from '@/components/hplc/AgingTimer'
import { InboxVialCard } from '@/components/hplc/InboxVialCard'
import {
  familyDateReceived,
  familyDragItems,
  type FamilyDragData,
  type VialFamily,
} from '@/lib/inbox-families'
import { cn } from '@/lib/utils'
import type { InboxPriority } from '@/lib/api'

interface InboxFamilyGroupProps {
  family: VialFamily
  onPriorityChange: (sampleUid: string, priority: InboxPriority) => void
}

/** Bordered section wrapping all of one sample's vial cards, with a header
 *  drag handle that assigns the WHOLE family at once (one worksheet item
 *  per vial). Rendered only for vial-only families (no parent row) with
 *  2+ visible vials — legacy parent-led families keep the flat card list. */
export function InboxFamilyGroup({ family, onPriorityChange }: InboxFamilyGroupProps) {
  const dragData: FamilyDragData = {
    family: true,
    parentSampleId: family.parentSampleId,
    items: familyDragItems(family.vials),
  }
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `family-${family.parentSampleId}`,
    data: dragData,
  })

  const client = family.vials[0]?.client_id
  const title = family.vials[0]?.title

  return (
    <div
      className={cn(
        'rounded-lg border border-dashed border-border/80 bg-muted/20',
        isDragging && 'opacity-50',
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-dashed border-border/60">
        <button
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          className="h-6 w-10 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none text-muted-foreground/40 hover:text-muted-foreground rounded hover:bg-muted/50"
          aria-label={`Drag all ${family.vials.length} vials of ${family.parentSampleId}`}
          title="Drag to assign all vials at once"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="font-mono text-sm font-semibold hover:underline hover:text-primary transition-colors"
          onClick={() => useUIStore.getState().navigateToSample(family.parentSampleId)}
        >
          {family.parentSampleId}
        </button>
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {family.vials.length} vials
        </span>
        {title && (
          <span className="text-xs text-muted-foreground truncate max-w-48">{title}</span>
        )}
        {client && (
          <span className="text-xs text-muted-foreground/70 truncate max-w-40">{client}</span>
        )}
        <div className="flex-1" />
        <AgingTimer dateReceived={familyDateReceived(family.vials)} />
      </div>
      <div className="space-y-2 p-2">
        {family.vials.map(v => (
          <InboxVialCard
            key={v.uid}
            vial={v}
            groupedWithPrevious={false}
            onPriorityChange={onPriorityChange}
          />
        ))}
      </div>
    </div>
  )
}
