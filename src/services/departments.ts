import { useQuery } from '@tanstack/react-query'
import { getDepartments, type Department } from '@/lib/api'

export const departmentsQueryKeys = { all: ['departments'] as const }

export function useDepartments() {
  return useQuery({
    queryKey: departmentsQueryKeys.all,
    queryFn: getDepartments,
    staleTime: 1000 * 60 * 5,
  })
}

export type { Department }
