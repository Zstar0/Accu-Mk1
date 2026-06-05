import { Fragment } from 'react'
import { ArrowUpFromLine } from 'lucide-react'
import type { ParentPromotionInfo } from '@/lib/api'

export function PromotedFromBadge({
  promotion,
}: {
  promotion: ParentPromotionInfo | undefined
}) {
  if (!promotion) return null

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
      {'from '}
      {promotion.sources.map((s, i) => (
        <Fragment key={s.sample_id ?? i}>
          {i > 0 && ', '}
          {s.sample_id ? (
            <a
              href={`/#senaite/sample-details?id=${s.sample_id}`}
              className="underline underline-offset-2 hover:text-foreground"
              onClick={e => e.stopPropagation()}
            >
              {s.sample_id}
            </a>
          ) : (
            'sub-sample'
          )}
        </Fragment>
      ))}
    </span>
  )
}
