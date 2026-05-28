import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { formatMinutes, formatTarget } from '@/lib/sla-format'
import type { SlaColor } from '@/lib/sla-resolution'
import type { SampleSlaSnapshot } from '@/services/order-sla'

const COLOR_CLASS: Record<SlaColor, string> = {
  red: 'text-red-400',
  amber: 'text-amber-400',
  green: 'text-muted-foreground/70',
}

/**
 * Per-sample SLA indicator for the OrderStatusPage card view. Replaces the
 * hardcoded 24/48h goalNote with the real tier-based color from sla-resolution.
 * Shares the same classifySampleColor primitive as OrderSlaCell — color is
 * pre-computed on `snapshot.color` upstream by useOrderSlaStatuses.
 */
export function SampleSlaIndicator({
  snapshot,
}: {
  snapshot: SampleSlaSnapshot | undefined
}) {
  const { t } = useTranslation()
  if (!snapshot) {
    return (
      <span className="text-[10px] font-mono leading-none tabular-nums text-muted-foreground/70" />
    )
  }
  const { status, color, tier } = snapshot
  const text = status.breached
    ? t('orderStatus.sla.over', { time: formatMinutes(status.remaining_minutes) })
    : t('orderStatus.sla.left', { time: formatMinutes(status.remaining_minutes) })
  const tooltip = t('orderStatus.sla.tooltipSample', {
    tier: tier.name,
    target: formatTarget(tier.target_minutes),
    elapsed: formatMinutes(status.elapsed_minutes),
    businessSuffix: tier.business_hours_only ? t('orderStatus.sla.businessSuffix') : '',
  })
  return (
    <span
      data-testid="sample-sla-indicator"
      data-sla-color={color}
      className={cn('text-[10px] font-mono leading-none tabular-nums', COLOR_CLASS[color])}
      title={tooltip}
    >
      {text}
    </span>
  )
}
