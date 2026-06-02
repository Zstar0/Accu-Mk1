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
import { cn } from '@/lib/utils'
import {
  SERVICE_GROUP_COLORS,
  type ServiceGroupColor,
} from '@/lib/service-group-colors'
import type {
  InboxAnalysisItem,
  InboxVialItem,
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

// Role palette — mirrors VialsList / SenaiteDashboard / VialDetailsTab. Inline
// copy #4 to stay additive; dedup is a tracked fast-follow.
const ROLE_BADGES: Record<string, { label: string; cls: string }> = {
  hplc:       { label: 'HPLC',       cls: 'bg-sky-500/15 text-sky-700 border-sky-500/40 dark:text-sky-300' },
  endo:       { label: 'ENDO',       cls: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40 dark:text-emerald-300' },
  ster:       { label: 'STER',       cls: 'bg-violet-500/15 text-violet-700 border-violet-500/40 dark:text-violet-300' },
  xtra:       { label: 'XTRA',       cls: 'bg-zinc-500/15 text-zinc-700 border-zinc-500/40 dark:text-zinc-300' },
  unassigned: { label: '—',          cls: 'bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-300' },
}

function RoleBadge({ role }: { role: string | null | undefined }) {
  const b = ROLE_BADGES[role ?? 'unassigned'] ?? ROLE_BADGES.unassigned!
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        b.cls,
      )}
      title={`Role: ${b.label}`}
    >
      {b.label}
    </span>
  )
}

/**
 * Roll core HPLC analyses (Purity / Identity / Quantity) into one peptide line.
 * Adapted from InboxServiceGroupCard.groupCoreAnalyses — same logic, but
 * operates on the flat analyses[] shape (group context lives per-analysis).
 */
function groupCoreAnalyses(analyses: InboxAnalysisItem[]) {
  const peptideMap = new Map<string, { peptide: string; types: string[]; method: string | null }>()
  const standalone: InboxAnalysisItem[] = []

  for (const a of analyses) {
    if (!a.peptide_name) {
      standalone.push(a)
      continue
    }
    const typeMatch = a.title.match(/\(([^)]+)\)/)
    const identMatch = a.title.match(/Identity/)
    const type = identMatch ? 'Identity' : typeMatch?.[1] ?? a.title

    const existing = peptideMap.get(a.peptide_name)
    if (existing) {
      if (!existing.types.includes(type)) existing.types.push(type)
      if (!existing.method && a.method) existing.method = a.method
    } else {
      peptideMap.set(a.peptide_name, {
        peptide: a.peptide_name,
        types: [type],
        method: a.method,
      })
    }
  }
  return { peptideLines: Array.from(peptideMap.values()), standalone }
}

interface InboxVialCardProps {
  vial: InboxVialItem
  /** True when the previous card in the rendered list shares this vial's parent_sample_id.
   *  Used for the indent + connector visual grouping (parents render flush, subs indent under their parent). */
  groupedWithPrevious: boolean
  onPriorityChange: (sampleUid: string, priority: InboxPriority) => void
}

export function InboxVialCard({
  vial,
  groupedWithPrevious,
  onPriorityChange,
}: InboxVialCardProps) {
  // Drag uses the first analysis's group_id. Today every vial's analyses[]
  // collapses to a single group after the server-side role filter (Analytics
  // for HPLC, Microbiology for ster/endo), so this is always unambiguous.
  // A future HPLC sub-group split could revisit this for multi-group drops.
  const firstGroup = vial.analyses[0]
  const groupId = firstGroup?.group_id ?? 0
  const groupName = firstGroup?.group_name ?? ''
  const groupColor = firstGroup?.group_color ?? 'zinc'
  const dragId = `${vial.uid}::${groupId}`

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId,
    data: {
      sampleUid: vial.uid,
      sampleId: vial.sample_id,
      groupId,
      groupName,
      dateReceived: vial.date_received,
      analyses: vial.analyses.map(a => ({
        title: a.title,
        keyword: a.keyword,
        peptide_name: a.peptide_name,
        method: a.method,
      })),
    } satisfies DragData,
  })

  const style: React.CSSProperties | undefined = isDragging
    ? { opacity: 0.3, pointerEvents: 'none' }
    : undefined

  const colorKey = (groupColor as ServiceGroupColor) in SERVICE_GROUP_COLORS
    ? (groupColor as ServiceGroupColor)
    : 'zinc'
  const colorClasses = SERVICE_GROUP_COLORS[colorKey]

  const { peptideLines, standalone } = groupCoreAnalyses(vial.analyses)

  const positionLabel = vial.is_parent
    ? vial.vial_total > 1 ? `Vial 1 / ${vial.vial_total}` : null
    : `Vial ${vial.vial_sequence + 1} / ${vial.vial_total}`

  return (
    <div className={cn('flex', groupedWithPrevious && !vial.is_parent && 'pl-6 relative')}>
      {/* Connector line for sub-vials grouped under a parent above */}
      {groupedWithPrevious && !vial.is_parent && (
        <div className="absolute left-2 top-0 bottom-0 w-px bg-border" aria-hidden="true" />
      )}
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'group flex-1 rounded-lg border bg-card transition-all duration-200 hover:border-primary/30 hover:shadow-md',
          isDragging && 'shadow-lg ring-2 ring-primary/20',
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b px-3 py-2.5 hover:bg-muted/30 transition-colors">
          <button
            {...attributes}
            {...listeners}
            className="h-6 w-14 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none text-muted-foreground/40 hover:text-muted-foreground rounded hover:bg-muted/50"
            aria-label="Drag handle"
          >
            <GripVertical className="h-4 w-4" />
          </button>

          {/* Sample ID — clickable to sample details */}
          <button
            type="button"
            className="font-mono text-sm font-medium hover:underline hover:text-primary transition-colors"
            onClick={e => {
              e.stopPropagation()
              useUIStore.getState().navigateToSample(vial.sample_id)
            }}
          >
            {vial.sample_id}
          </button>

          <RoleBadge role={vial.assignment_role} />

          {groupName && (
            <span className={cn('inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium', colorClasses)}>
              {groupName}
            </span>
          )}

          {positionLabel && (
            <span className="text-[11px] text-muted-foreground font-mono">{positionLabel}</span>
          )}

          <div className="flex-1" />

          {/* Priority */}
          <Select
            value={vial.priority}
            onValueChange={value => onPriorityChange(vial.uid, value as InboxPriority)}
          >
            <SelectTrigger
              size="sm"
              className="h-6 w-auto min-w-[90px] border-transparent bg-transparent shadow-none text-xs hover:border-border"
            >
              <SelectValue>
                <PriorityBadge priority={vial.priority} />
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="normal"><PriorityBadge priority="normal" /></SelectItem>
              <SelectItem value="high"><PriorityBadge priority="high" /></SelectItem>
              <SelectItem value="expedited"><PriorityBadge priority="expedited" /></SelectItem>
            </SelectContent>
          </Select>

          <AgingTimer dateReceived={vial.date_received} />
        </div>

        {/* Body */}
        <div className="px-3 py-2">
          {(peptideLines.length === 0 && standalone.length === 0) ? (
            <p className="text-xs text-muted-foreground italic">No analyses on this vial.</p>
          ) : (
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
                <div key={a.uid ?? `${a.keyword ?? 'kw'}-${i}`} className="flex items-center gap-2 text-xs">
                  <span className="font-medium">{a.title}</span>
                  {a.method && (
                    <span className="text-muted-foreground font-mono text-[10px]">{a.method}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
