import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { formatMinutes } from '@/lib/sla-format'
import { NO_GROUP_KEY, type SlaColor } from '@/lib/sla-resolution'
import type { SampleSlaSnapshot } from '@/services/order-sla'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SlaBreakdownTooltip } from './SlaBreakdownTooltip'

const COLOR_CLASS: Record<SlaColor, string> = {
  red: 'text-red-400',
  amber: 'text-amber-400',
  green: 'text-muted-foreground/70',
}

/** Severity ranking for sorting stacked rows worst-first. Smaller = more severe.
 *  Matches the visual prominence ordering analysts expect at a glance. */
const SEVERITY: Record<SlaColor, number> = {
  red: 0,
  amber: 1,
  green: 2,
}

interface SampleSlaIndicatorProps {
  /** Multi-tier reshape: one snapshot per service group bucket. A
   *  single-element array renders inline without a group label (preserves the
   *  pre-multi-tier visual for samples whose analyses all map to one group).
   *  Multiple entries render stacked vertically, worst-color first, each
   *  labeled with its group name. */
  snapshots: SampleSlaSnapshot[] | undefined
}

function renderRow(
  snapshot: SampleSlaSnapshot,
  t: (key: string, opts?: Record<string, string | number>) => string,
  showLabel: boolean
) {
  const { status, color } = snapshot
  const text = status.breached
    ? t('orderStatus.sla.over', { time: formatMinutes(status.remaining_minutes) })
    : t('orderStatus.sla.left', { time: formatMinutes(status.remaining_minutes) })
  // For multi-row, the group name prefixes the indicator; NO_GROUP_KEY rows
  // (analyses with no group / fallback to default tier) show no prefix because
  // there's no real group name to label them with.
  const label =
    showLabel && snapshot.groupKey !== NO_GROUP_KEY && snapshot.groupName
      ? snapshot.groupName
      : null
  return (
    <Tooltip key={String(snapshot.groupKey)}>
      <TooltipTrigger asChild>
        <span
          data-testid="sample-sla-indicator"
          data-sla-color={color}
          data-group-key={String(snapshot.groupKey)}
          className={cn(
            'text-[10px] font-mono leading-none tabular-nums',
            COLOR_CLASS[color]
          )}
        >
          {label && (
            <span className="text-muted-foreground/60 mr-1">{label}</span>
          )}
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent className="p-0 max-w-md">
        <SlaBreakdownTooltip
          tier={snapshot.tier}
          status={snapshot.status}
          reason={snapshot.reason}
          priority={snapshot.priority}
          groupName={snapshot.groupName}
        />
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Per-sample SLA indicator. Renders one row per service group the sample
 * touches; samples bucketed into one group still render as a single row with
 * no label (so existing single-tier cards stay visually compact).
 *
 * Color and elapsed/remaining math come pre-computed on each snapshot from
 * `useOrderSlaStatuses` / `useSampleSla` so this component does no resolution
 * itself — keeps rendering cheap and lets the structural-equality memo below
 * suppress re-renders when the snapshot content is unchanged.
 */
function SampleSlaIndicatorImpl({ snapshots }: SampleSlaIndicatorProps) {
  const { t } = useTranslation()
  if (!snapshots || snapshots.length === 0) {
    return (
      <span className="text-[10px] font-mono leading-none tabular-nums text-muted-foreground/70" />
    )
  }
  // Single snapshot: render inline, no label, no list wrapper. Preserves the
  // pre-multi-tier DOM shape for callers that pass exactly one snapshot
  // (KanbanSampleCard, SampleHeaderSla legacy adapter, single-group samples).
  if (snapshots.length === 1) {
    const single = snapshots[0]
    if (!single) {
      return (
        <span className="text-[10px] font-mono leading-none tabular-nums text-muted-foreground/70" />
      )
    }
    return renderRow(single, t, false)
  }
  // Multi-snapshot: stacked rows, worst-color first. Tie-break alphabetically
  // by group name so the order is stable when severities match.
  const sorted = [...snapshots].sort((a, b) => {
    const sev = SEVERITY[a.color] - SEVERITY[b.color]
    if (sev !== 0) return sev
    const an = a.groupName ?? ''
    const bn = b.groupName ?? ''
    return an.localeCompare(bn)
  })
  return (
    <div
      data-testid="sample-sla-indicator-list"
      className="flex flex-col items-end gap-0.5"
    >
      {sorted.map(s => renderRow(s, t, true))}
    </div>
  )
}

/** Structural equality for the snapshots array — prevents re-render when the
 *  parent rebuilds sampleSlaStatusesMap with new object references for
 *  identical content. Length + per-index field comparison; the hook produces
 *  snapshots in deterministic (analysis iteration) order so identical content
 *  arrives in identical order. */
function snapshotsPropsEqual(
  prev: SampleSlaIndicatorProps,
  next: SampleSlaIndicatorProps
): boolean {
  const a = prev.snapshots
  const b = next.snapshots
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (!x || !y) return false
    if (x.groupKey !== y.groupKey) return false
    if (x.color !== y.color) return false
    if (x.tier.id !== y.tier.id) return false
    if (x.tier.target_minutes !== y.tier.target_minutes) return false
    if (x.tier.business_hours_only !== y.tier.business_hours_only) return false
    if (x.status.elapsed_minutes !== y.status.elapsed_minutes) return false
    if (x.status.remaining_minutes !== y.status.remaining_minutes) return false
    if (x.status.breached !== y.status.breached) return false
    if (x.priority !== y.priority) return false
    if ((x.reason?.tierSource ?? null) !== (y.reason?.tierSource ?? null)) return false
    if ((x.groupName ?? null) !== (y.groupName ?? null)) return false
  }
  return true
}

export const SampleSlaIndicator = memo(SampleSlaIndicatorImpl, snapshotsPropsEqual)
