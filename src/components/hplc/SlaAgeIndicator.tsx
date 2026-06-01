import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { formatMinutes } from '@/lib/sla-format'
import type { SlaSubjectSnapshot } from '@/services/sla-subjects'
import { pickWorstSnapshot } from '@/services/sla-subjects'
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
  red: '●', amber: '●', green: '●',
  met: '✓', missed: '—', loading: '…', error: '—', none: '—',
}

interface SlaAgeIndicatorProps {
  snapshot?: SlaSubjectSnapshot | null
  snapshots?: SlaSubjectSnapshot[]
  isLoading: boolean
  isError: boolean
  compact?: boolean
}

function pickColor(snap: SlaSubjectSnapshot | null, isLoading: boolean, isError: boolean): CellColor {
  if (isLoading) return 'loading'
  if (isError) return 'error'
  if (!snap) return 'none'
  if (snap.isFrozen) return snap.status.breached ? 'missed' : 'met'
  return snap.color
}

function SlaAgeIndicatorImpl(props: SlaAgeIndicatorProps) {
  const { t } = useTranslation()
  const snap = props.snapshot ?? pickWorstSnapshot(props.snapshots ?? [])
  const color = pickColor(snap, props.isLoading, props.isError)
  const className = COLOR_CLASS[color]
  const dot = DOT[color]
  const compact = props.compact ?? false

  let text = ''
  let titleAttr: string | undefined
  if (snap && color === 'red') {
    const over = formatMinutes(Math.abs(snap.status.remaining_minutes))
    text = compact ? `−${over}` : t('orderStatus.sla.over', { time: over })
  } else if (snap && (color === 'amber' || color === 'green')) {
    const left = formatMinutes(snap.status.remaining_minutes)
    text = compact ? left : t('orderStatus.sla.left', { time: left })
  } else if (snap && color === 'met') {
    const took = formatMinutes(snap.status.elapsed_minutes)
    text = compact ? took : t('orderStatus.sla.publishedTook', { time: took })
  } else if (snap && color === 'missed') {
    const by = formatMinutes(Math.abs(snap.status.remaining_minutes))
    text = compact ? `−${by}` : t('orderStatus.sla.missedBy', { time: by })
  } else if (color === 'loading') {
    titleAttr = t('orderStatus.sla.loading')
  } else if (color === 'error') {
    titleAttr = t('orderStatus.sla.unavailable')
  } else {
    titleAttr = t('orderStatus.sla.noTierConfigured')
  }

  const hasBreakdown = !props.isLoading && !props.isError && snap !== null
  const sizeClass = compact ? 'text-[10px]' : 'text-sm'

  const cell = (
    <span
      data-testid="sla-age-indicator"
      data-sla-color={color}
      className={cn('inline-flex items-center gap-1 font-mono tabular-nums', sizeClass, className)}
      title={hasBreakdown ? undefined : titleAttr}
    >
      <span aria-hidden="true">{dot}</span>
      {text && <span>{text}</span>}
      {titleAttr && <span className="sr-only">{titleAttr}</span>}
    </span>
  )

  if (hasBreakdown && snap) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{cell}</TooltipTrigger>
        <TooltipContent className="p-0 max-w-md">
          <SlaBreakdownTooltip
            tier={snap.tier}
            status={snap.status}
            reason={null}
            priority={snap.priority}
            receivedAt={snap.receivedAt}
            groupName={snap.groupName}
            isPublished={snap.isFrozen}
          />
        </TooltipContent>
      </Tooltip>
    )
  }
  return cell
}

/** Structural equality on the effective snapshot's visually-meaningful fields —
 *  same anti-flicker pattern as OrderSlaCell. */
function propsEqual(prev: SlaAgeIndicatorProps, next: SlaAgeIndicatorProps): boolean {
  if (prev.isLoading !== next.isLoading) return false
  if (prev.isError !== next.isError) return false
  if ((prev.compact ?? false) !== (next.compact ?? false)) return false
  const a = prev.snapshot ?? pickWorstSnapshot(prev.snapshots ?? [])
  const b = next.snapshot ?? pickWorstSnapshot(next.snapshots ?? [])
  if (a === b) return true
  if (a === null || b === null) return false
  if (a.color !== b.color) return false
  if (a.isFrozen !== b.isFrozen) return false
  if ((a.groupId ?? null) !== (b.groupId ?? null)) return false
  if ((a.groupName ?? null) !== (b.groupName ?? null)) return false
  if (a.priority !== b.priority) return false
  if ((a.tier?.id ?? null) !== (b.tier?.id ?? null)) return false
  if ((a.tier?.target_minutes ?? null) !== (b.tier?.target_minutes ?? null)) return false
  if ((a.tier?.amber_threshold_percent ?? null) !== (b.tier?.amber_threshold_percent ?? null)) return false
  if ((a.tier?.business_hours_only ?? null) !== (b.tier?.business_hours_only ?? null)) return false
  if (a.status.elapsed_minutes !== b.status.elapsed_minutes) return false
  if (a.status.remaining_minutes !== b.status.remaining_minutes) return false
  if (a.status.breached !== b.status.breached) return false
  if ((a.receivedAt ?? null) !== (b.receivedAt ?? null)) return false
  return true
}

export const SlaAgeIndicator = memo(SlaAgeIndicatorImpl, propsEqual)
