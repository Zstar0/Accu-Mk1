import { useQuery } from '@tanstack/react-query'
import { getAnalysisServices, type AnalysisServiceRecord } from '@/lib/api'

export const analysisServicesQueryKeys = {
  all: ['analysis-services', 'local'] as const,
}

export function useAnalysisServices() {
  return useQuery({
    queryKey: analysisServicesQueryKeys.all,
    queryFn: () => getAnalysisServices(),
    staleTime: 1000 * 60 * 5,
  })
}

export type { AnalysisServiceRecord }
