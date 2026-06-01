import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { formatMinutes } from '@/lib/sla-format'
import type { InboxPriority } from '@/lib/api'
import type { SampleSlaSnapshot } from '@/services/order-sla'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SlaBreakdownTooltip } from '@/components/explorer/SlaBreakdownTooltip'

type CellColor = 'red' | 'amber' | 'green' | 'met' | 'missed' | 'loading' | 'error' | 'none'

const COLOR_CLASS: Record<CellColor, string> = {
  red: 'text-red-500',
  amber: 'text-amber-500',
  green: 'text-green-600',
  met: 'text-muted-foreground',
  missed: 'text-red-500',
  loading: 'text-muted-foreground',
  error: 'text-muted-foreground',
  none: 'text-muted-foreground',
}

const DOT: Record<CellColor, string> = {
  red: '●',
  amber: '●',
  green: '●',
  met: '✓',
  missed: '—',
  loading: '…',
  error: '—',
  none: '—',
}

interface AnalysisSlaCellProps {
  snapshot: SampleSlaSnapshot | null
  priority: InboxPriority | null
  isLoading: boolean
  isError: boolean
  isPublished: boolean
}

function pickColor(props: AnalysisSlaCellProps): CellColor {
  if (props.isLoading) return 'loading'
  if (props.isError) return 'error'
  if (!props.snapshot) return 'none'
  if (props.isPublished) {
    return props.snapshot.status.breached ? 'missed' : 'met'
  }
  return props.snapshot.color
}

function AnalysisSlaCellImpl(props: AnalysisSlaCellProps) {
  const { t } = useTranslation()
  const color = pickColor(props)
  const className = COLOR_CLASS[color]
  const dot = DOT[color]

  let text = ''
  let titleAttr: string | undefined
  const snap = props.snapshot
  if (color === 'red' && snap) {
    text = t('orderStatus.sla.over', {
      time: formatMinutes(Math.abs(snap.status.remaining_minutes)),
    })
  } else if ((color === 'amber' || color === 'green') && snap) {
    text = t('orderStatus.sla.left', {
      time: formatMinutes(snap.status.remaining_minutes),
    })
  } else if (color === 'met' && snap) {
    text = t('orderStatus.sla.publishedTook', {
      time: formatMinutes(snap.status.elapsed_minutes),
    })
  } else if (color === 'missed' && snap) {
    text = t('orderStatus.sla.missedBy', {
      time: formatMinutes(Math.abs(snap.status.remaining_minutes)),
    })
  } else if (color === 'loading') {
    titleAttr = t('orderStatus.sla.loading')
  } else if (color === 'error') {
    titleAttr = t('orderStatus.sla.unavailable')
  } else {
    text = '—'
    titleAttr = t('orderStatus.sla.noTierConfigured')
  }

  const hasBreakdown =
    !props.isLoading &&
    !props.isError &&
    props.snapshot !== null

  const cell = (
    <span
      data-testid="analysis-sla-cell"
      data-sla-color={color}
      className={cn(
        'inline-flex items-center gap-1 text-xs font-mono tabular-nums',
        className
      )}
      title={hasBreakdown ? undefined : titleAttr}
    >
      <span aria-hidden="true">{dot}</span>
      {text && <span>{text}</span>}
      {!text && titleAttr && <span className="sr-only">{titleAttr}</span>}
    </span>
  )

  if (hasBreakdown && props.snapshot) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{cell}</TooltipTrigger>
        <TooltipContent className="p-0 max-w-md">
          <SlaBreakdownTooltip
            tier={props.snapshot.tier}
            status={props.snapshot.status}
            reason={props.snapshot.reason}
            priority={props.priority}
            receivedAt={props.snapshot.receivedAt}
            groupName={props.snapshot.groupName}
            isPublished={props.isPublished}
          />
        </TooltipContent>
      </Tooltip>
    )
  }
  return cell
}

/** Structural equality across visually-meaningful fields — same anti-flicker
 *  pattern as OrderSlaCell. Prevents Tooltip teardown when the parent passes
 *  a new map reference but the snapshot's content is unchanged. */
function slaPropsEqual(prev: AnalysisSlaCellProps, next: AnalysisSlaCellProps): boolean {
  if (prev.isLoading !== next.isLoading) return false
  if (prev.isError !== next.isError) return false
  if (prev.isPublished !== next.isPublished) return false
  if (prev.priority !== next.priority) return false
  const a = prev.snapshot
  const b = next.snapshot
  if (a === b) return true
  if (a === null || b === null) return false
  if (a.color !== b.color) return false
  if ((a.groupKey ?? null) !== (b.groupKey ?? null)) return false
  if ((a.groupName ?? null) !== (b.groupName ?? null)) return false
  if ((a.tier?.id ?? null) !== (b.tier?.id ?? null)) return false
  if ((a.tier?.target_minutes ?? null) !== (b.tier?.target_minutes ?? null)) return false
  if ((a.tier?.amber_threshold_percent ?? null) !== (b.tier?.amber_threshold_percent ?? null)) return false
  if ((a.tier?.business_hours_only ?? null) !== (b.tier?.business_hours_only ?? null)) return false
  if (a.status.elapsed_minutes !== b.status.elapsed_minutes) return false
  if (a.status.remaining_minutes !== b.status.remaining_minutes) return false
  if (a.status.breached !== b.status.breached) return false
  if ((a.receivedAt ?? null) !== (b.receivedAt ?? null)) return false
  if ((a.reason?.tierSource ?? null) !== (b.reason?.tierSource ?? null)) return false
  if ((a.reason?.priorityScope ?? null) !== (b.reason?.priorityScope ?? null)) return false
  return true
}

export const AnalysisSlaCell = memo(AnalysisSlaCellImpl, slaPropsEqual)
