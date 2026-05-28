import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { formatMinutes } from '@/lib/sla-format'
import type { SlaColor } from '@/lib/sla-resolution'
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

interface SampleSlaIndicatorProps {
  snapshot: SampleSlaSnapshot | undefined
}

/**
 * Per-sample SLA indicator for the OrderStatusPage card view. Replaces the
 * hardcoded 24/48h goalNote with the real tier-based color from sla-resolution.
 * Shares the same classifySampleColor primitive as OrderSlaCell — color is
 * pre-computed on `snapshot.color` upstream by useOrderSlaStatuses.
 *
 * Tooltip: wrapped in a shadcn `Tooltip` hosting the multi-line breakdown
 * (replaces the previous single-line `title=` attribute).
 */
function SampleSlaIndicatorImpl({ snapshot }: SampleSlaIndicatorProps) {
  const { t } = useTranslation()
  if (!snapshot) {
    return (
      <span className="text-[10px] font-mono leading-none tabular-nums text-muted-foreground/70" />
    )
  }
  const { status, color } = snapshot
  const text = status.breached
    ? t('orderStatus.sla.over', { time: formatMinutes(status.remaining_minutes) })
    : t('orderStatus.sla.left', { time: formatMinutes(status.remaining_minutes) })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="sample-sla-indicator"
          data-sla-color={color}
          className={cn(
            'text-[10px] font-mono leading-none tabular-nums',
            COLOR_CLASS[color]
          )}
        >
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent className="p-0 max-w-md">
        <SlaBreakdownTooltip
          tier={snapshot.tier}
          status={snapshot.status}
          reason={snapshot.reason}
          priority={snapshot.priority}
        />
      </TooltipContent>
    </Tooltip>
  )
}

/** Structural equality for the snapshot — prevents per-sample re-render when
 *  the parent rebuilds sampleSlaStatusMap with new object references for
 *  identical content. Without this, sampleLookupMap mutations trigger a
 *  synchronized flicker across every visible sample row. */
function snapshotPropsEqual(
  prev: SampleSlaIndicatorProps,
  next: SampleSlaIndicatorProps
): boolean {
  const a = prev.snapshot
  const b = next.snapshot
  if (a === b) return true
  if (!a || !b) return false
  if (a.color !== b.color) return false
  if (a.tier.id !== b.tier.id) return false
  if (a.tier.target_minutes !== b.tier.target_minutes) return false
  if (a.tier.business_hours_only !== b.tier.business_hours_only) return false
  if (a.status.elapsed_minutes !== b.status.elapsed_minutes) return false
  if (a.status.remaining_minutes !== b.status.remaining_minutes) return false
  if (a.status.breached !== b.status.breached) return false
  if (a.priority !== b.priority) return false
  if ((a.reason?.tierSource ?? null) !== (b.reason?.tierSource ?? null)) return false
  return true
}

export const SampleSlaIndicator = memo(SampleSlaIndicatorImpl, snapshotPropsEqual)
