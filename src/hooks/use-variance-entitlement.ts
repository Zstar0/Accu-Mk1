import { useQuery } from '@tanstack/react-query'
import { fetchVarianceEntitlement } from '@/lib/api'

/** Parent-scoped variance entitlement for gating Verify (Variance).
 *  Entitlement changes only when the WP order changes — long staleTime is fine.
 *  Errors resolve to {} (fail closed: action hidden; backend re-checks anyway). */
export function useVarianceEntitlement(parentSampleId: string | null | undefined) {
  const { data } = useQuery({
    queryKey: ['variance-entitlement', parentSampleId],
    queryFn: () => fetchVarianceEntitlement(parentSampleId!),
    enabled: !!parentSampleId,
    staleTime: 5 * 60_000,
  })
  return data?.variance
}
