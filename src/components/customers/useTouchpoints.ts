import { useQueries } from '@tanstack/react-query'
import { getCustomerTouchpoints, type Touchpoints } from '@/lib/api'
import { useAuthStore } from '@/store/auth-store'
import { useSupportSeat } from './useSupportSeat'

const CHUNK = 50
const DEGRADED = {
  state: 'unavailable',
  reason: 'unavailable',
  stale: false,
} as const

/** Last CRM / support touch per customer key, fetched in chunks of 50. A failed
 *  chunk degrades its keys to "unavailable"; keys of a chunk still in flight
 *  are absent from `rows` (the cell shows its loading state). */
export function useTouchpoints(keys: string[]): {
  rows: Record<string, Touchpoints>
  crmVisible: boolean
  supportVisible: boolean
  isLoading: boolean
} {
  const chunks: string[][] = []
  for (let i = 0; i < keys.length; i += CHUNK)
    chunks.push(keys.slice(i, i + CHUNK))
  const results = useQueries({
    queries: chunks.map(chunk => ({
      queryKey: ['customers', 'touchpoints', chunk],
      queryFn: () => getCustomerTouchpoints(chunk),
      staleTime: 300_000,
      refetchOnWindowFocus: false,
    })),
  })
  const rows: Record<string, Touchpoints> = {}
  results.forEach((q, i) => {
    for (const k of chunks[i] ?? []) {
      if (q.data) rows[k] = q.data.rows[k] ?? { crm: null, support: null }
      else if (q.isError) rows[k] = { crm: DEGRADED, support: DEGRADED }
    }
  })
  // Until the first chunk settles, seed visibility from what the client already
  // knows (admin role, Plain seat) so the columns show their loading cells on
  // first load. Once the server has answered its flags win: it can only take a
  // column away, never add one the seed did not expect.
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const seat = useSupportSeat()
  const first = results.find(q => q.data)?.data
  return {
    rows,
    crmVisible: first ? first.crm_visible : isAdmin,
    supportVisible: first
      ? first.support_visible
      : isAdmin || seat.data?.has_seat === true,
    isLoading: results.some(q => q.isLoading),
  }
}
