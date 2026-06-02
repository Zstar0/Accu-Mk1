import { useQuery } from '@tanstack/react-query'
import { getServiceGroups, type ServiceGroup } from '@/lib/api'

export const serviceGroupsQueryKeys = { all: ['service-groups'] as const }

export function useServiceGroups() {
  return useQuery({
    queryKey: serviceGroupsQueryKeys.all,
    queryFn: getServiceGroups,
    staleTime: 1000 * 60 * 5,
  })
}

export type { ServiceGroup }
