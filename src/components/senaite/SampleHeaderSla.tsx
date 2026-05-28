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
export function SampleHeaderSla({
  lookup,
}: {
  lookup: SenaiteLookupResult | null | undefined
}) {
  const { t } = useTranslation()
  const { snapshot, reason, priority, isPublished, isLoading, isError } =
    useSampleSla(lookup)

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
