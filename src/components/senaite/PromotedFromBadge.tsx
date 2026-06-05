import { ArrowUpFromLine } from 'lucide-react'
import type { ParentPromotionInfo } from '@/lib/api'

export function PromotedFromBadge({
  promotion,
}: {
  promotion: ParentPromotionInfo | undefined
}) {
  if (!promotion) return null

  const sourceLabels = promotion.sources
    .map(s => s.sample_id ?? 'sub-sample')
    .join(', ')

  const datePart = promotion.promoted_at.slice(0, 10)
  const byWhom = promotion.promoted_by_email ?? 'unknown'
  const tooltip = `Promoted ${datePart} by ${byWhom}`

  return (
    <span
      title={tooltip}
      aria-label="Promoted from sub-sample"
      className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground shrink-0"
    >
      <ArrowUpFromLine size={11} className="shrink-0" />
      {`from ${sourceLabels}`}
    </span>
  )
}
