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
 * Renders nothing when SLA isn't applicable (no lookup, no date_received, or
 * already published) — matches the prior behaviour where the goalNote span
 * was only added when both conditions were true.
 */
export function SampleHeaderSla({
  lookup,
}: {
  lookup: SenaiteLookupResult | null | undefined
}) {
  const { t } = useTranslation()
  const { snapshot, reason, priority, isLoading, isError } = useSampleSla(lookup)

  // Gating mirrors useSampleSla.applicable so we don't render an empty span
  // for unreceived / published samples.
  if (!lookup?.date_received || lookup.review_state === 'published') return null

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
  const text = status.breached
    ? t('orderStatus.sla.over', { time: formatMinutes(status.remaining_minutes) })
    : t('orderStatus.sla.left', { time: formatMinutes(status.remaining_minutes) })

  const colorClass =
    color === 'red'
      ? 'text-red-400'
      : color === 'amber'
        ? 'text-amber-400'
        : 'text-muted-foreground'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="sample-header-sla"
          data-sla-color={color}
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
        />
      </TooltipContent>
    </Tooltip>
  )
}
