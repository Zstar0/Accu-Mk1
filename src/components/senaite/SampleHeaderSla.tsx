import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { formatMinutes } from '@/lib/sla-format'
import type { SenaiteLookupResult } from '@/lib/api'
import { useSampleSla } from '@/services/sample-sla'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SlaBreakdownTooltip } from '@/components/explorer/SlaBreakdownTooltip'

interface SampleHeaderSlaProps {
  lookup: SenaiteLookupResult | null | undefined
}

/**
 * Per-sample SLA indicator for the Sample Details page header.
 * Replaces the hardcoded 24/48h `goalNote` IIFE with the real tier-based
 * resolution + multi-line breakdown tooltip.
 *
 * Renders nothing when SLA isn't applicable (no lookup or no date_received).
 * Published samples render a historical "took Xh" indicator with met/missed
 * colouring driven by `useSampleSla` (which passes `now_override =
 * published_date` to /sla/status so elapsed is frozen at publication).
 */
function SampleHeaderSlaImpl({ lookup }: SampleHeaderSlaProps) {
  const { t } = useTranslation()
  const { snapshots, priority, isPublished, isLoading, isError } =
    useSampleSla(lookup)
  // Multi-tier follow-on: useSampleSla now returns an array of per-group
  // snapshots. The sample-details header currently renders only the first
  // (preserves the single-inline "(took 13h)" layout); multi-row sample
  // header rendering is a follow-on. Tooltip pulls reason from the same
  // snapshot so the breakdown stays accurate to the displayed tier.
  const snapshot = snapshots[0]
  const reason = snapshot?.reason ?? null

  // Gating mirrors useSampleSla.applicable so we don't render an empty span
  // for unreceived samples. Published samples flow through — their snapshot is
  // frozen at published_date via now_override on /sla/status.
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
  // Errors and missing snapshots: don't pollute the header. The page still
  // shows "Received {date}" without an SLA suffix.
  if (isError || !snapshot) return null

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
    // Live view — countdown (existing behaviour).
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

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="sample-header-sla"
          data-sla-color={dataColor}
          className={cn('ml-1.5 font-mono', colorClass)}
        >
          ({text})
        </span>
      </TooltipTrigger>
      <TooltipContent className="p-0 max-w-md">
        <SlaBreakdownTooltip
          tier={snapshot.tier}
          status={snapshot.status}
          reason={reason}
          priority={priority}
          isPublished={isPublished}
        />
      </TooltipContent>
    </Tooltip>
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
