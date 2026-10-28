/** TanStack Query hooks for the managed sample-form list. Mirrors services/groups.ts. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  createSampleForm,
  getSampleFormsOfSamples,
  listSampleForms,
  setSampleForm,
  updateSampleForm,
  type SampleFormCreate,
  type SampleFormUpdate,
} from '@/lib/api-sample-forms'
import { invalidateAnalysisListings } from '@/lib/vial-assignment'

export const sampleFormKeys = { all: ['sample-forms'] as const }

/** One query serves the Settings pane (needs inactive rows) and the pickers
 *  (filter to active plus the sample's current form), so one invalidation
 *  refreshes both. */
export function useSampleForms() {
  return useQuery({
    queryKey: sampleFormKeys.all,
    queryFn: () => listSampleForms(true),
    staleTime: 60_000,
  })
}

/** Form id per sample id for a page that holds only ids (COA Explorer).
 *  Under sampleFormKeys.all, so a form change refreshes it too. */
export function useSampleFormIdsFor(sampleIds: string[]) {
  const ids = [...new Set(sampleIds)].sort()
  return useQuery({
    queryKey: [...sampleFormKeys.all, 'of-samples', ids],
    queryFn: () => getSampleFormsOfSamples(ids),
    enabled: ids.length > 0,
    staleTime: 60_000,
  })
}

export function useCreateSampleForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: SampleFormCreate) => createSampleForm(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sampleFormKeys.all })
      toast.success('Form added')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdateSampleForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: SampleFormUpdate }) =>
      updateSampleForm(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sampleFormKeys.all })
      toast.success('Form updated')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useSetSampleForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      sampleId,
      sampleFormId,
    }: {
      sampleId: string
      sampleFormId: number
    }) => setSampleForm(sampleId, sampleFormId),
    onSuccess: () => {
      // sample_count on the pane rows moves with every assignment
      qc.invalidateQueries({ queryKey: sampleFormKeys.all })
      // Cached analyses rows carry the old form's units and specs
      invalidateAnalysisListings(qc)
      toast.success('Form set')
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
