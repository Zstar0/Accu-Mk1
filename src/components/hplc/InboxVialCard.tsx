import { useDraggable } from '@dnd-kit/core'
import { useUIStore } from '@/store/ui-store'
import { GripVertical, Layers } from 'lucide-react'
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
import { vialLabel } from '@/lib/vial-label'
import { ROLE_BADGE_CLASS } from '@/lib/assignment-colors'
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

// Labels live here; colours come from the official scheme in
// @/lib/assignment-colors (single source of truth).
const ROLE_BADGES: Record<string, { label: string; cls: string }> = {
  hplc:       { label: 'HPLC',       cls: ROLE_BADGE_CLASS.hplc },
  endo:       { label: 'ENDO',       cls: ROLE_BADGE_CLASS.endo },
  ster:       { label: 'PCR',        cls: ROLE_BADGE_CLASS.ster },
  xtra:       { label: 'XTRA',       cls: ROLE_BADGE_CLASS.xtra },
  unassigned: { label: '—',          cls: ROLE_BADGE_CLASS.unassigned },
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
  /** True when this vial's family has ≥1 variance-assigned sub-sample. Only the
   *  parent card surfaces it (a Layers icon before the ID) — an at-a-glance cue
   *  that the sample needs multiple vials tested. */
  parentHasVarianceSubs?: boolean
  onPriorityChange: (sampleUid: string, priority: InboxPriority) => void
}

export function InboxVialCard({
  vial,
  groupedWithPrevious,
  parentHasVarianceSubs,
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

  // Container parents stay in the inbox — native subs have no SENAITE AR, so
  // the parent card is the family's worksheet-assignment vehicle — but a
  // container parent is NOT a vial, so it never claims the "Vial 1" label.
  const positionLabel = vial.is_parent
    ? vial.container_mode
      ? vial.vial_total > 0
        ? `${vial.vial_total} vial${vial.vial_total === 1 ? '' : 's'}`
        : null
      : vial.vial_total > 1 ? `Vial 1 / ${vial.vial_total}` : null
    : `${vialLabel(vial.vial_sequence, vial.container_mode ?? false)} / ${vial.vial_total}`

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

          {/* Sample ID — clickable to sample details. A Layers icon prefixes
              the ID on the parent card (family has variance vials) AND on each
              variance vial itself, so the variance rows line up down the ID
              column. Variance vials also keep the explicit VARIANCE badge below. */}
          <span className="inline-flex items-center gap-1">
            {((vial.is_parent && parentHasVarianceSubs) ||
              vial.assignment_kind === 'variance') && (
              <Layers
                className="h-3 w-3 text-sky-500 shrink-0"
                aria-label={
                  vial.assignment_kind === 'variance'
                    ? 'Variance replicate vial'
                    : 'Has variance vials'
                }
                role="img"
              />
            )}
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
          </span>

          <RoleBadge role={vial.assignment_role} />

          {/* Variance replicate marker — sky + Layers mirrors SenaiteDashboard's
              subIsVarianceMember treatment (variance = sky/Layers everywhere) */}
          {vial.assignment_kind === 'variance' && (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300"
              title="Variance replicate vial"
            >
              <Layers className="h-3 w-3" aria-hidden="true" />
              Variance
            </span>
          )}

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
