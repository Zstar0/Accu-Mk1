import type { OrderBoxLabelSummary } from '@/lib/api'

/**
 * Per-order expected-vials cell. PRESENTATIONAL: the summary comes from the
 * parent list's single batched box-label-summaries query — this component
 * must never fetch per-row. (Its old per-row useQuery fired ~50 concurrent
 * requests under HTTP/2 and exhausted the backend DB pool — prod brownout
 * 2026-07-09.) Shows '—' while the batch is loading or when the order has no
 * resolvable summary.
 */
export function OrderExpectedVials({
  summary,
  loading = false,
}: {
  summary: OrderBoxLabelSummary | undefined
  loading?: boolean
}) {
  if (loading || !summary) return <span className="text-muted-foreground">—</span>
  const c = summary.counts
  const total = c.hplc + c.endo + c.ster
  return (
    <span>
      {total} expected vial{total !== 1 ? 's' : ''}
    </span>
  )
}
