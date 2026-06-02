import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { formatMinutes } from '@/lib/sla-format'
import type { InboxPriority, SenaiteLookupResult } from '@/lib/api'
import { NO_GROUP_KEY } from '@/lib/sla-resolution'
import { useSampleSla } from '@/services/sample-sla'
import type { SampleSlaSnapshot } from '@/services/order-sla'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SlaBreakdownTooltip } from '@/components/explorer/SlaBreakdownTooltip'

interface SampleHeaderSlaProps {
  lookup: SenaiteLookupResult | null | undefined
}

/** Per-snapshot severity for sort. Worst → 0, best → 2. Used when stacking
 *  multiple group snapshots so the most-pressing one appears first. */
function snapshotSeverity(s: SampleSlaSnapshot, isPublished: boolean): number {
  if (isPublished) return s.status.breached ? 0 : 2
  if (s.color === 'red') return 0
  if (s.color === 'amber') return 1
  return 2
}

/** Single inline span — one snapshot's worth of indicator. Composed by
 *  `SampleHeaderSlaImpl` once per group when the sample is multi-tier. */
function renderSnapshotSpan({
  snapshot,
  priority,
  isPublished,
  showGroupLabel,
  t,
}: {
  snapshot: SampleSlaSnapshot
  priority: InboxPriority | null
  isPublished: boolean
  showGroupLabel: boolean
  t: (key: string, opts?: Record<string, string | number>) => string
}) {
  const { status, color } = snapshot
  let text: string
  let colorClass: string
  let dataColor: string
  if (isPublished) {
    // Historical view — total time taken to publish. Color is binary
    // (met/missed) since amber is meaningless after the fact.
    text = t('orderStatus.sla.publishedTook', {
      time: formatMinutes(status.elapsed_minutes),
    })
    colorClass = status.breached ? 'text-red-400' : 'text-green-600/70'
    dataColor = status.breached ? 'missed' : 'met'
  } else {
    text = status.breached
      ? t('orderStatus.sla.over', { time: formatMinutes(status.remaining_minutes) })
      : t('orderStatus.sla.left', { time: formatMinutes(status.remaining_minutes) })
    colorClass =
      color === 'red'
        ? 'text-red-400'
        : color === 'amber'
          ? 'text-amber-400'
          : 'text-muted-foreground'
    dataColor = color
  }
  // Group label prefix appears only on multi-tier samples to disambiguate
  // which row is which group. NO_GROUP_KEY rows have no useful label, so
  // they render without a prefix even in the multi-tier stack.
  const label =
    showGroupLabel && snapshot.groupKey !== NO_GROUP_KEY && snapshot.groupName
      ? `${snapshot.groupName}: `
      : ''
  return (
    <Tooltip key={String(snapshot.groupKey)}>
      <TooltipTrigger asChild>
        <span
          data-testid="sample-header-sla"
          data-sla-color={dataColor}
          data-group-key={String(snapshot.groupKey)}
          className={cn('font-mono', colorClass)}
        >
          ({label}{text})
        </span>
      </TooltipTrigger>
      <TooltipContent className="p-0 max-w-md">
        <SlaBreakdownTooltip
          tier={snapshot.tier}
          status={snapshot.status}
          reason={snapshot.reason}
          priority={priority}
          receivedAt={snapshot.receivedAt}
          groupName={snapshot.groupName}
          isPublished={isPublished}
        />
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Per-sample SLA indicator for the Sample Details page header.
 *
 * Multi-tier follow-on: when the sample's analyses span multiple service
 * groups, renders ONE inline span per group, worst-color first, each prefixed
 * with the group name. Single-group samples still render as one unlabeled
 * `(took 13h)` span — preserves the pre-multi-tier compact layout.
 *
 * Renders nothing when SLA isn't applicable (no lookup or no date_received).
 * Published samples render historical "took Xh" / met / missed indicators
 * driven by `useSampleSla` (which passes `now_override = published_date` to
 * /sla/status so elapsed is frozen at publication).
 */
function SampleHeaderSlaImpl({ lookup }: SampleHeaderSlaProps) {
  const { t } = useTranslation()
  const { snapshots, priority, isPublished, isLoading, isError } =
    useSampleSla(lookup)

  if (!lookup?.date_received) return null

  if (isLoading) {
    return (
      <span
        data-testid="sample-header-sla"
        data-sla-color="loading"
        className="ml-1.5 font-mono text-muted-foreground"
      >
        …
      </span>
    )
  }
  // Errors and empty snapshots: don't pollute the header. The page still
  // shows "Received {date}" without an SLA suffix.
  if (isError || snapshots.length === 0) return null

  const sorted = [...snapshots].sort(
    (a, b) =>
      snapshotSeverity(a, isPublished) - snapshotSeverity(b, isPublished) ||
      (a.groupName ?? '').localeCompare(b.groupName ?? '')
  )
  const showGroupLabel = sorted.length > 1
  return (
    <span className="ml-1.5 inline-flex items-baseline gap-1.5">
      {sorted.map(s =>
        renderSnapshotSpan({
          snapshot: s,
          priority,
          isPublished,
          showGroupLabel,
          t,
        })
      )}
    </span>
  )
}

/** Memo equality on the lookup. When the parent's useState holds a stable
 *  lookup reference (the common case), this hits the reference fast path. If
 *  the parent rebuilds the lookup, we still skip re-render when the fields
 *  that drive useSampleSla's tier resolution + display haven't changed. */
function headerPropsEqual(
  prev: SampleHeaderSlaProps,
  next: SampleHeaderSlaProps
): boolean {
  if (prev.lookup === next.lookup) return true
  if (!prev.lookup || !next.lookup) return false
  if (prev.lookup.sample_uid !== next.lookup.sample_uid) return false
  if (prev.lookup.date_received !== next.lookup.date_received) return false
  if (prev.lookup.review_state !== next.lookup.review_state) return false
  if (
    (prev.lookup.published_coa?.published_date ?? null) !==
    (next.lookup.published_coa?.published_date ?? null)
  )
    return false
  if (prev.lookup.analyses.length !== next.lookup.analyses.length) return false
  return true
}

export const SampleHeaderSla = memo(SampleHeaderSlaImpl, headerPropsEqual)
