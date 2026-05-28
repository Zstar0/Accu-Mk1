import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { SampleSlaSnapshot } from '@/services/order-sla'

const COLOR_CLASS: Record<'red' | 'amber' | 'green', string> = {
  red: 'text-red-400',
  amber: 'text-amber-400',
  green: 'text-muted-foreground/70',
}

function formatMinutes(min: number): string {
  const abs = Math.abs(min)
  if (abs < 60) return `${Math.round(abs)}m`
  if (abs < 60 * 24) return `${(abs / 60).toFixed(1).replace(/\.0$/, '')}h`
  const days = Math.floor(abs / (60 * 24))
  const hours = Math.round((abs - days * 60 * 24) / 60)
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

function formatTarget(min: number): string {
  if (min % 60 === 0) return `${min / 60}h`
  return `${min}m`
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
  const tooltip = t('orderStatus.sla.tooltipFull', {
    tier: tier.name,
    target: formatTarget(tier.target_minutes),
    elapsed: formatMinutes(status.elapsed_minutes),
    businessSuffix: tier.business_hours_only ? t('orderStatus.sla.businessSuffix') : '',
    sampleId: '',
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
