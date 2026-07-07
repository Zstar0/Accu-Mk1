import { useQuery } from '@tanstack/react-query'
import { getOrderBoxLabelSummary } from '@/lib/api'

/**
 * Per-order expected-vials cell. Lazily fetches the box-label summary for the
 * order and renders the integer sum of hplc + endo + ster vials. Shows '—'
 * while loading or when there is no order number. Mirrors the `VialCount`
 * lazy-query pattern in `ReceiveSample.tsx`.
 */
export function OrderExpectedVials({ orderNumber }: { orderNumber: string | null }) {
  const { data, isLoading } = useQuery({
    queryKey: ['order-expected-vials', orderNumber],
    queryFn: () => getOrderBoxLabelSummary(orderNumber as string),
    enabled: !!orderNumber,
    staleTime: 60_000,
  })
  if (!orderNumber || isLoading) return <span className="text-muted-foreground">—</span>
  const c = data?.counts
  const total = c ? c.hplc + c.endo + c.ster : 0
  return (
    <span>
      {total} expected vial{total !== 1 ? 's' : ''}
    </span>
  )
}
