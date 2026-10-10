import { useQuery } from '@tanstack/react-query'
import { getSupportMe } from '@/lib/api-support'

/** Whether the signed-in user has a Plain seat (the Support write permission). */
export function useSupportSeat() {
  return useQuery({
    queryKey: ['support', 'me'],
    queryFn: getSupportMe,
    staleTime: 300_000,
    retry: false,
  })
}
