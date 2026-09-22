import { Moon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SlaUnits } from '@/lib/sla-format'
import { formatResumesAt, type LabClockState } from '@/lib/lab-clock'

/**
 * A moon after an SLA value while the lab clock is paused (after close,
 * before open, weekend, holiday). Only for business-hours tiers, whose
 * "4.8bh left" does not move overnight; a calendar tier's clock never stops,
 * and a published row is frozen for good.
 */
export function SlaClockMoon({
  units,
  clock,
  frozen = false,
}: {
  units: SlaUnits
  clock: LabClockState | null | undefined
  frozen?: boolean
}) {
  const { t } = useTranslation()
  if (!units.business || frozen || !clock?.paused) return null
  const title = t('orderStatus.sla.clockPaused', {
    when: formatResumesAt(clock.resumesAt),
  })
  return (
    <span
      data-testid="sla-clock-paused"
      title={title}
      className="inline-flex shrink-0 opacity-60"
    >
      <Moon className="h-3 w-3" aria-hidden="true" />
      <span className="sr-only">{title}</span>
    </span>
  )
}
