import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { OrderSlaVerdict } from '@/lib/sla-resolution'

const COLOR_CLASS: Record<string, string> = {
  red: 'text-red-500',
  amber: 'text-amber-500',
  green: 'text-green-600',
  met: 'text-muted-foreground',
  awaiting: 'text-muted-foreground',
  loading: 'text-muted-foreground',
  error: 'text-muted-foreground',
}

const DOT: Record<string, string> = {
  red: '●',
  amber: '●',
  green: '●',
  met: '✓',
  awaiting: '—',
  loading: '…',
  error: '—',
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
  const color = isError ? 'error' : isLoading ? 'loading' : verdict.color
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
    </span>
  )
}
