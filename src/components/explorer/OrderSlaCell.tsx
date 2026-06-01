import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { formatMinutes, formatTarget } from '@/lib/sla-format'
import type { OrderSlaColor, OrderSlaVerdict } from '@/lib/sla-resolution'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SlaBreakdownTooltip } from './SlaBreakdownTooltip'

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

interface OrderSlaCellProps {
  verdict: OrderSlaVerdict
  isLoading?: boolean
  isError?: boolean
}

function OrderSlaCellImpl({
  verdict,
  isLoading,
  isError,
}: OrderSlaCellProps) {
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

  // Active states (red/amber/green) with a driving sample get the rich shadcn
  // breakdown tooltip. Inactive states (met/awaiting/loading/error) keep the
  // simple `title=` — there's no meaningful breakdown to render for them.
  const hasBreakdown =
    !isLoading &&
    !isError &&
    Boolean(verdict.drivingTier) &&
    Boolean(verdict.drivingStatus) &&
    Boolean(verdict.drivingSampleId)

  const cell = (
    <span
      data-testid="order-sla-cell"
      data-sla-color={color}
      className={cn('inline-flex items-center gap-1 text-xs font-mono tabular-nums', className)}
      title={hasBreakdown ? undefined : tooltip || undefined}
    >
      <span aria-hidden="true">{dot}</span>
      {text && <span>{text}</span>}
      {!text && tooltip && <span className="sr-only">{tooltip}</span>}
    </span>
  )

  if (hasBreakdown && verdict.drivingTier && verdict.drivingStatus) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{cell}</TooltipTrigger>
        <TooltipContent className="p-0 max-w-md">
          <SlaBreakdownTooltip
            tier={verdict.drivingTier}
            status={verdict.drivingStatus}
            reason={verdict.drivingReason ?? null}
            receivedAt={verdict.drivingReceivedAt}
            drivingSampleId={verdict.drivingSampleId}
            groupName={verdict.drivingGroupName}
          />
        </TooltipContent>
      </Tooltip>
    )
  }

  return cell
}

/** Equality check that compares only the visually-meaningful fields of the
 *  verdict. Prevents per-row Tooltip teardown when the parent re-renders with
 *  a new verdict object reference that has identical color + driving info.
 *  This is the load-bearing piece that prevents synchronized flicker across
 *  ALL rows whenever sampleLookupMap mutates. */
function slaPropsEqual(prev: OrderSlaCellProps, next: OrderSlaCellProps): boolean {
  if (prev.isLoading !== next.isLoading) return false
  if (prev.isError !== next.isError) return false
  const a = prev.verdict
  const b = next.verdict
  if (a === b) return true
  if (a.color !== b.color) return false
  if ((a.drivingSampleId ?? null) !== (b.drivingSampleId ?? null)) return false
  if ((a.drivingReceivedAt ?? null) !== (b.drivingReceivedAt ?? null)) return false
  if ((a.drivingTier?.id ?? null) !== (b.drivingTier?.id ?? null)) return false
  if (
    (a.drivingTier?.target_minutes ?? null) !==
    (b.drivingTier?.target_minutes ?? null)
  )
    return false
  if (
    (a.drivingTier?.amber_threshold_percent ?? null) !==
    (b.drivingTier?.amber_threshold_percent ?? null)
  )
    return false
  if (
    (a.drivingTier?.business_hours_only ?? null) !==
    (b.drivingTier?.business_hours_only ?? null)
  )
    return false
  // Status — compare structural identity not reference. Elapsed/remaining/
  // breached drive the rendered text. target_minutes is captured above via tier.
  if (
    (a.drivingStatus?.elapsed_minutes ?? null) !==
    (b.drivingStatus?.elapsed_minutes ?? null)
  )
    return false
  if (
    (a.drivingStatus?.remaining_minutes ?? null) !==
    (b.drivingStatus?.remaining_minutes ?? null)
  )
    return false
  if (
    (a.drivingStatus?.breached ?? null) !==
    (b.drivingStatus?.breached ?? null)
  )
    return false
  // drivingReason is used in the tooltip — compare the tierSource since that's
  // the only field that drives a visibly-different breakdown line. Same for
  // priorityScope, which distinguishes per-group vs global override.
  if (
    (a.drivingReason?.tierSource ?? null) !==
    (b.drivingReason?.tierSource ?? null)
  )
    return false
  if (
    (a.drivingReason?.priorityScope ?? null) !==
    (b.drivingReason?.priorityScope ?? null)
  )
    return false
  // Multi-tier follow-on — drivingGroupName surfaces in the tooltip source
  // line, so a change must trigger a re-render even when color is unchanged.
  if ((a.drivingGroupKey ?? null) !== (b.drivingGroupKey ?? null)) return false
  if ((a.drivingGroupName ?? null) !== (b.drivingGroupName ?? null)) return false
  return true
}

export const OrderSlaCell = memo(OrderSlaCellImpl, slaPropsEqual)
