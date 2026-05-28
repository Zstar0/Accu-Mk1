import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { formatMinutes, formatTarget } from '@/lib/sla-format'
import type { OrderSlaColor, OrderSlaVerdict } from '@/lib/sla-resolution'

const COLOR_CLASS: Record<OrderSlaColor, string> = {
  red: 'text-red-500',
  amber: 'text-amber-500',
  green: 'text-green-600',
  met: 'text-muted-foreground',
  awaiting: 'text-muted-foreground',
  loading: 'text-muted-foreground',
  error: 'text-muted-foreground',
}

const DOT: Record<OrderSlaColor, string> = {
  red: '●',
  amber: '●',
  green: '●',
  met: '✓',
  awaiting: '—',
  loading: '…',
  error: '—',
}

export function OrderSlaCell({
  verdict,
  isLoading,
  isError,
}: {
  verdict: OrderSlaVerdict
  isLoading?: boolean
  isError?: boolean
}) {
  const { t } = useTranslation()
  const color: OrderSlaColor = isError ? 'error' : isLoading ? 'loading' : verdict.color
  const className = COLOR_CLASS[color] ?? 'text-muted-foreground'
  const dot = DOT[color]

  let text = ''
  let tooltip = ''
  if (color === 'red' && verdict.drivingStatus) {
    text = t('orderStatus.sla.over', { time: formatMinutes(verdict.drivingStatus.remaining_minutes) })
  } else if ((color === 'amber' || color === 'green') && verdict.drivingStatus) {
    text = t('orderStatus.sla.left', { time: formatMinutes(verdict.drivingStatus.remaining_minutes) })
  } else if (color === 'met') {
    text = t('orderStatus.sla.met')
    tooltip = t('orderStatus.sla.allPublished')
  } else if (color === 'awaiting') {
    text = t('orderStatus.sla.awaiting')
    tooltip = t('orderStatus.sla.awaiting')
  } else if (color === 'loading') {
    text = ''
    tooltip = t('orderStatus.sla.loading')
  } else if (color === 'error') {
    text = ''
    tooltip = t('orderStatus.sla.unavailable')
  }

  if (
    !tooltip &&
    verdict.drivingTier &&
    verdict.drivingStatus &&
    verdict.drivingSampleId
  ) {
    tooltip = t('orderStatus.sla.tooltipFull', {
      tier: verdict.drivingTier.name,
      target: formatTarget(verdict.drivingTier.target_minutes),
      elapsed: formatMinutes(verdict.drivingStatus.elapsed_minutes),
      businessSuffix: verdict.drivingTier.business_hours_only
        ? t('orderStatus.sla.businessSuffix')
        : '',
      sampleId: verdict.drivingSampleId,
    })
  }

  return (
    <span
      data-testid="order-sla-cell"
      data-sla-color={color}
      className={cn('inline-flex items-center gap-1 text-xs font-mono tabular-nums', className)}
      title={tooltip || undefined}
    >
      <span aria-hidden="true">{dot}</span>
      {text && <span>{text}</span>}
      {!text && tooltip && <span className="sr-only">{tooltip}</span>}
    </span>
  )
}
