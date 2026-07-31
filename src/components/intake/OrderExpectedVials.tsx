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
  // Demand-shape-driven: sum every bucket the backend returns rather than a
  // hardcoded hplc/endo/ster list, so a catalog-only role (e.g. 'hm') isn't
  // silently dropped from the receiving desk's expected-vials total.
  const total = Object.values(summary.counts).reduce((sum, n) => sum + n, 0)
  return (
    <span>
      {total} expected vial{total !== 1 ? 's' : ''}
    </span>
  )
}
