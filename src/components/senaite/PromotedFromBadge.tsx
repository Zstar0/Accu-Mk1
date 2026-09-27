import { Fragment } from 'react'
import { ArrowUpFromLine, RefreshCw } from 'lucide-react'
import type { ParentPromotionInfo } from '@/lib/api'
import { isCarriedPromotion, carriedSourceLabel } from '@/lib/retest-chips'

export function PromotedFromBadge({
  promotion,
}: {
  promotion: ParentPromotionInfo | undefined
}) {
  if (!promotion) return null

  const datePart = promotion.promoted_at.slice(0, 10)
  const byWhom = promotion.promoted_by_email ?? 'unknown'
  const tooltip = `Promoted ${datePart} by ${byWhom}`

  if (isCarriedPromotion(promotion)) {
    const src =
      promotion.sources.find(s => s.contribution_kind === 'carried') ??
      promotion.sources[0]
    const label = carriedSourceLabel(promotion)
    const target = src?.sample_id ?? src?.parent_sample_id ?? null
    const origin = src?.parent_sample_id ?? label
    return (
      <span
        title={`Carried from ${origin}, promoted ${datePart} by ${byWhom}`}
        aria-label="Carried from original"
        className="inline-flex items-center gap-1 rounded-md border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300 shrink-0"
      >
        <RefreshCw size={10} className="shrink-0" />
        {'Carried from '}
        {target ? (
          <a
            href={`/#senaite/sample-details?id=${target}`}
            className="underline underline-offset-2 hover:text-foreground"
            onClick={e => e.stopPropagation()}
          >
            {label}
          </a>
        ) : (
          label
        )}
      </span>
    )
  }

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
