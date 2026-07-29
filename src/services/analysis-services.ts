import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  getAnalysisServices,
  createAnalysisService,
  updateAnalysisService,
  deleteAnalysisService,
  type AnalysisServiceRecord,
  type AnalysisServiceCreatePayload,
  type AnalysisServiceUpdatePayload,
} from '@/lib/api'

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

export function useCreateAnalysisService() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: AnalysisServiceCreatePayload) => createAnalysisService(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: analysisServicesQueryKeys.all })
      toast.success('Analysis service created')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdateAnalysisService() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: AnalysisServiceUpdatePayload }) =>
      updateAnalysisService(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: analysisServicesQueryKeys.all })
      toast.success('Analysis service updated')
    },
    // Callers needing to react to a specific failure (e.g. locking the
    // keyword field on the "referenced by existing analyses" 409) attach
    // their own onError via mutate()'s options — both fire.
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteAnalysisService() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteAnalysisService(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: analysisServicesQueryKeys.all })
      toast.success('Analysis service deleted')
    },
    // Surfaces the backend's 409 ("...deactivate instead") and 400 messages
    // verbatim rather than a generic failure message.
    onError: (e: Error) => toast.error(e.message),
  })
}

export type { AnalysisServiceRecord }
