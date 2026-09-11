import { useDraggable } from '@dnd-kit/core'
import { GripVertical, Layers } from 'lucide-react'
import { useUIStore } from '@/store/ui-store'
import { AgingTimer } from '@/components/hplc/AgingTimer'
import { InboxVialCard } from '@/components/hplc/InboxVialCard'
import { PriorityGlyph } from '@/components/common/PriorityGlyph'
import {
  familyDateReceived,
  familyDragItems,
  familyPriorityRank,
  type FamilyDragData,
  type VialFamily,
} from '@/lib/inbox-families'
import { cn } from '@/lib/utils'
import type { SlaSubjectSnapshot } from '@/services/sla-subjects'

interface InboxFamilyGroupProps {
  family: VialFamily
  /** True when this family has ≥1 variance-assigned sub-sample — prefixes the
   *  header sample id with a Layers icon so the whole job reads as variance. */
  hasVarianceSubs?: boolean
  /** SLA column passthrough — forwarded verbatim to each vial card. */
  slaByKey?: Map<string, SlaSubjectSnapshot>
  slaLoading?: boolean
  slaError?: boolean
}

/** Bordered section wrapping all of one sample's vial cards, with a header
 *  drag handle that assigns the WHOLE family at once (one worksheet item
 *  per vial). Rendered only for vial-only families (no parent row) with
 *  2+ visible vials — legacy parent-led families keep the flat card list. */
export function InboxFamilyGroup({
  family,
  hasVarianceSubs,
  slaByKey,
  slaLoading,
  slaError,
}: InboxFamilyGroupProps) {
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
  // The family header shows the SAME priority the family is ordered by — its
  // most urgent vial's, by catalog rank.
  const rank = familyPriorityRank(family.vials)
  const headline =
    family.vials.find(v => (v.priority_effective?.rank ?? 0) === rank)
      ?.priority_effective ?? null

  return (
    <div
      className={cn(
        'rounded-lg border border-dashed border-border/80 bg-muted/20',
        isDragging && 'opacity-50'
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
        <span className="inline-flex items-center gap-1.5">
          <PriorityGlyph priority={headline} size="row" />
          {hasVarianceSubs && (
            <Layers
              className="h-3 w-3 text-sky-500 shrink-0"
              aria-label="Has variance vials"
              role="img"
            />
          )}
          <button
            type="button"
            className="font-mono text-sm font-semibold hover:underline hover:text-primary transition-colors"
            onClick={() =>
              useUIStore.getState().navigateToSample(family.parentSampleId)
            }
          >
            {family.parentSampleId}
          </button>
        </span>
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {family.vials.length} vials
        </span>
        {title && (
          <span className="text-xs text-muted-foreground truncate max-w-48">
            {title}
          </span>
        )}
        {client && (
          <span className="text-xs text-muted-foreground/70 truncate max-w-40">
            {client}
          </span>
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
            slaByKey={slaByKey}
            slaLoading={slaLoading}
            slaError={slaError}
          />
        ))}
      </div>
    </div>
  )
}
