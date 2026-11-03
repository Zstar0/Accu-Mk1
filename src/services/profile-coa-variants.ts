/** TanStack Query hook for a profile's COA text versions. Mirrors services/sample-forms.ts. */
import { useQuery } from '@tanstack/react-query'
import { listProfileCoaVariants } from '@/lib/api-profile-coa-variants'

export const profileCoaVariantKeys = {
  forProfile: (id: number | null) => ['profile-coa-variants', id] as const,
}

export function useProfileCoaVariants(profileId: number | null) {
  return useQuery({
    queryKey: profileCoaVariantKeys.forProfile(profileId),
    queryFn: () => listProfileCoaVariants(profileId as number),
    enabled: profileId !== null,
    // Save sends all five fields, so a stale row could revert a colleague's edit.
    staleTime: 0,
  })
}
