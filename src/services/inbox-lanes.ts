import { useQuery } from '@tanstack/react-query'
import { getInboxLanes, type InboxLaneRow } from '@/lib/api'

export const inboxLanesQueryKeys = { all: ['worksheet-inbox-lanes'] as const }

export function useInboxLanes() {
  return useQuery({
    queryKey: inboxLanesQueryKeys.all,
    queryFn: getInboxLanes,
    staleTime: 1000 * 60 * 5,
  })
}

export type { InboxLaneRow }
