import { useQuery } from '@tanstack/react-query'
import { getVialRoles, type VialRoleRow } from '@/lib/api'

export const vialRolesQueryKeys = { all: ['vial-roles'] as const }

export function useVialRoles() {
  return useQuery({
    queryKey: vialRolesQueryKeys.all,
    queryFn: getVialRoles,
    staleTime: 1000 * 60 * 5,
  })
}

export type { VialRoleRow }
