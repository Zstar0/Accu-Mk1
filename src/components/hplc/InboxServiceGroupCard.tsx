import { useDraggable } from '@dnd-kit/core'
import { useUIStore } from '@/store/ui-store'
import { GripVertical } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PriorityBadge } from '@/components/hplc/PriorityBadge'
import { AgingTimer } from '@/components/hplc/AgingTimer'
import {
  SERVICE_GROUP_COLORS,
  type ServiceGroupColor,
} from '@/lib/service-group-colors'
import type {
  InboxSampleItem,
  InboxServiceGroupSection,
  InboxPriority,
} from '@/lib/api'

export interface DragData {
  sampleUid: string
  sampleId: string
  groupId: number
  groupName: string
  dateReceived: string | null
  analyses: { title: string; keyword: string | null; peptide_name: string | null; method: string | null }[]
}

interface InboxServiceGroupCardProps {
  sample: InboxSampleItem
  group: InboxServiceGroupSection
  onPriorityChange: (sampleUid: string, priority: InboxPriority) => void
}

/** Group core HPLC analyses (Purity, Identity, Quantity) into one peptide line */
function groupCoreAnalyses(analyses: InboxServiceGroupSection['analyses']) {
  const peptideMap = new Map<string, { peptide: string; types: string[]; method: string | null }>()
  const standalone: typeof analyses = []

  for (const a of analyses) {
    if (!a.peptide_name) {
      standalone.push(a)
      continue
    }

    const existing = peptideMap.get(a.peptide_name)
    if (existing) {
      // Extract type from title: "BPC-157 (Purity)" → "Purity", "BPC-157 - Identity (HPLC)" → "Identity"
      const typeMatch = a.title.match(/\(([^)]+)\)/)
      const identMatch = a.title.match(/Identity/)
      const type = identMatch ? 'Identity' : typeMatch?.[1] ?? a.title
      if (!existing.types.includes(type)) {
        existing.types.push(type)
      }
      if (!existing.method && a.method) {
        existing.method = a.method
      }
    } else {
      const typeMatch = a.title.match(/\(([^)]+)\)/)
      const identMatch = a.title.match(/Identity/)
      const type = identMatch ? 'Identity' : typeMatch?.[1] ?? a.title
      peptideMap.set(a.peptide_name, {
        peptide: a.peptide_name,
        types: [type],
        method: a.method,
      })
    }
  }

  return { peptideLines: Array.from(peptideMap.values()), standalone }
}

export function InboxServiceGroupCard({
  sample,
  group,
  onPriorityChange,
}: InboxServiceGroupCardProps) {
  const dragId = `${sample.uid}::${group.group_id}`
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId,
    data: {
      sampleUid: sample.uid,
      sampleId: sample.id,
      groupId: group.group_id,
      groupName: group.group_name,
      dateReceived: sample.date_received,
      analyses: group.analyses.map(a => ({ title: a.title, keyword: a.keyword, peptide_name: a.peptide_name, method: a.method })),
    } satisfies DragData,
  })

  // When dragging, hide the source card entirely — the DragOverlay shows the ghost
  const style: React.CSSProperties | undefined = isDragging
    ? { opacity: 0.3, pointerEvents: 'none' }
    : undefined

  const colorKey = (group.group_color as ServiceGroupColor) in SERVICE_GROUP_COLORS
    ? (group.group_color as ServiceGroupColor)
    : 'zinc'
  const colorClasses = SERVICE_GROUP_COLORS[colorKey]

  const { peptideLines, standalone } = groupCoreAnalyses(group.analyses)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group rounded-lg border bg-card transition-all duration-200 hover:border-primary/30 hover:shadow-md ${
        isDragging ? 'shadow-lg ring-2 ring-primary/20' : ''
      }`}
    >
      {/* Card header */}
      <div
        className="flex items-center gap-3 border-b px-3 py-2.5 hover:bg-muted/30 transition-colors"
      >
        <button
          {...attributes}
          {...listeners}
          className="h-6 w-14 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none text-muted-foreground/40 hover:text-muted-foreground rounded hover:bg-muted/50"
        >
          <GripVertical className="h-4 w-4" />
        </button>

        {/* Sample ID — clickable to sample details */}
        <button
          className="font-mono text-sm font-medium hover:underline hover:text-primary transition-colors"
          onClick={e => {
            e.stopPropagation()
            useUIStore.getState().navigateToSample(sample.id)
          }}
        >
          {sample.id}
        </button>

        {/* Service group badge */}
        <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium ${colorClasses}`}>
          {group.group_name}
        </span>

        <div className="flex-1" />

        {/* Priority */}
        <Select
          value={sample.priority}
          onValueChange={value => onPriorityChange(sample.uid, value as InboxPriority)}
        >
          <SelectTrigger
            size="sm"
            className="h-6 w-auto min-w-[90px] border-transparent bg-transparent shadow-none text-xs hover:border-border"
          >
            <SelectValue>
              <PriorityBadge priority={sample.priority} />
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="normal"><PriorityBadge priority="normal" /></SelectItem>
            <SelectItem value="high"><PriorityBadge priority="high" /></SelectItem>
            <SelectItem value="expedited"><PriorityBadge priority="expedited" /></SelectItem>
          </SelectContent>
        </Select>

        {/* Aging timer */}
        <AgingTimer dateReceived={sample.date_received} />
      </div>

      {/* Card body — analyses */}
      <div className="px-3 py-2">
        {/* Peptide lines (grouped core analyses) */}
        <div className="space-y-1">
          {peptideLines.map(line => (
            <div key={line.peptide} className="flex items-center gap-2 text-xs">
              <span className="font-medium">{line.peptide}</span>
              <div className="flex gap-1">
                {line.types.sort().map(t => (
                  <Badge key={t} variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                    {t}
                  </Badge>
                ))}
              </div>
              {line.method && (
                <span className="text-muted-foreground font-mono text-[10px]">{line.method}</span>
              )}
            </div>
          ))}
          {standalone.map((a, i) => (
            <div key={a.uid ?? i} className="flex items-center gap-2 text-xs">
              <span className="font-medium">{a.title}</span>
              {a.method && (
                <span className="text-muted-foreground font-mono text-[10px]">{a.method}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
