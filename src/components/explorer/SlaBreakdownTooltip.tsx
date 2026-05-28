import { useTranslation } from 'react-i18next'
import { formatMinutes, formatTarget } from '@/lib/sla-format'
import type { InboxPriority, SlaStatus, SlaTier } from '@/lib/api'
import type { SampleSlaReason } from '@/lib/sla-resolution'

export interface SlaBreakdownTooltipProps {
  /** Resolved tier — required to render the breakdown. */
  tier: SlaTier
  /** Live SLA status (elapsed/remaining/breached). */
  status: SlaStatus
  /** Reason snapshot from `resolveSampleTierWithReason`. */
  reason: SampleSlaReason | null
  /** Resolved priority — drives the "Priority:" line. Optional because some
   *  callers (e.g. order-level summary) may not have a single sample-priority. */
  priority?: InboxPriority | null
  /** Driving sample id — only rendered when distinct from the surface that
   *  hosts the tooltip. SampleSlaIndicator + SampleHeaderSla pass `undefined`
   *  (the surface IS the sample); OrderSlaCell passes the driving sample id. */
  drivingSampleId?: string
  /** When true, swap the live countdown headline and "Elapsed:" label for a
   *  historical "Met / Missed by Xh" headline and "Total time:" label. Driven
   *  by `useSampleSla.isPublished`. */
  isPublished?: boolean
}

/**
 * Pure render of the SLA breakdown — receives all data via props and runs no
 * queries of its own. Hosted inside a shadcn `TooltipContent`. Keeps the
 * tooltip self-contained so any surface (order cell, sample card indicator,
 * sample-detail header) can reuse it.
 */
export function SlaBreakdownTooltip({
  tier,
  status,
  reason,
  priority,
  drivingSampleId,
  isPublished = false,
}: SlaBreakdownTooltipProps) {
  const { t } = useTranslation()
  let headline: string
  if (isPublished) {
    headline = status.breached
      ? t('orderStatus.sla.publishedMissed', {
          time: formatMinutes(Math.abs(status.remaining_minutes)),
        })
      : t('orderStatus.sla.publishedMet')
  } else {
    headline = status.breached
      ? t('orderStatus.sla.over', { time: formatMinutes(status.remaining_minutes) })
      : t('orderStatus.sla.left', { time: formatMinutes(status.remaining_minutes) })
  }
  const elapsedLabel = isPublished
    ? t('orderStatus.sla.breakdown.totalTime')
    : t('orderStatus.sla.breakdown.elapsed')

  const businessSuffix = tier.business_hours_only
    ? t('orderStatus.sla.businessSuffix')
    : ''

  let sourceLine: string | null = null
  if (reason?.tierSource === 'priority' && reason.priorityUsed) {
    sourceLine = t('orderStatus.sla.breakdown.source.priority', {
      priority: reason.priorityUsed,
    })
  } else if (reason?.tierSource === 'group') {
    sourceLine = t('orderStatus.sla.breakdown.source.group')
  } else if (reason?.tierSource === 'default') {
    sourceLine = t('orderStatus.sla.breakdown.source.default')
  } else if (reason?.tierSource === 'none') {
    sourceLine = t('orderStatus.sla.breakdown.source.none')
  }

  const multiGroupLine =
    reason?.tierSource === 'group' && reason.multiGroupCandidates?.length
      ? t('orderStatus.sla.breakdown.source.groupMultiple', {
          count: reason.multiGroupCandidates.length,
        })
      : null

  const unmappedLine =
    reason && reason.unmappedKeywords.length > 0
      ? t('orderStatus.sla.breakdown.unmapped', {
          count: reason.unmappedKeywords.length,
          keywords: reason.unmappedKeywords.join(', '),
        })
      : null

  return (
    <div
      data-testid="sla-breakdown-tooltip"
      data-tier-source={reason?.tierSource ?? 'unknown'}
      className="flex flex-col gap-1.5 p-3 text-xs font-mono"
    >
      <div className="font-semibold border-b border-primary-foreground/20 pb-1.5">
        {t('orderStatus.sla')} — {headline}
      </div>
      <div className="flex flex-col gap-0.5">
        <div>
          {t('orderStatus.sla.breakdown.tier')}{' '}
          <span className="font-semibold">{tier.name}</span>
        </div>
        {sourceLine && (
          <div className="pl-3 opacity-80">↳ {sourceLine}</div>
        )}
        {multiGroupLine && (
          <div className="pl-3 opacity-80">↳ {multiGroupLine}</div>
        )}
      </div>
      <div className="flex flex-col gap-0.5 border-t border-primary-foreground/20 pt-1.5">
        <div>
          {t('orderStatus.sla.breakdown.target')}{' '}
          <span className="tabular-nums">
            {formatTarget(tier.target_minutes)}
            {businessSuffix}
          </span>
        </div>
        <div>
          {elapsedLabel}{' '}
          <span className="tabular-nums">
            {formatMinutes(status.elapsed_minutes)}
          </span>
        </div>
        <div>
          {t('orderStatus.sla.breakdown.remaining')}{' '}
          <span className="tabular-nums">
            {status.remaining_minutes < 0 ? '-' : ''}
            {formatMinutes(status.remaining_minutes)}
          </span>
        </div>
      </div>
      {(drivingSampleId || priority) && (
        <div className="flex flex-col gap-0.5 border-t border-primary-foreground/20 pt-1.5">
          {drivingSampleId && (
            <div>
              {t('orderStatus.sla.breakdown.drivingSample')}{' '}
              <span className="font-semibold tabular-nums">
                {drivingSampleId}
              </span>
            </div>
          )}
          {priority && (
            <div>
              {t('orderStatus.sla.breakdown.priority')}{' '}
              <span>{priority}</span>
            </div>
          )}
        </div>
      )}
      {unmappedLine && (
        <div className="border-t border-primary-foreground/20 pt-1.5 opacity-70">
          {unmappedLine}
        </div>
      )}
    </div>
  )
}
