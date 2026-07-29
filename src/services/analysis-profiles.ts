import { useQuery } from '@tanstack/react-query'
import { getAnalysisProfiles, type AnalysisProfile } from '@/lib/api'

export const analysisProfilesQueryKeys = { all: ['analysis-profiles'] as const }

export function useAnalysisProfiles() {
  return useQuery({
    queryKey: analysisProfilesQueryKeys.all,
    queryFn: getAnalysisProfiles,
    staleTime: 1000 * 60 * 5,
  })
}

export type { AnalysisProfile }
