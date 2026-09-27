import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { createRetest, getRetestOptions } from '@/lib/api'
import type { RetestCreated, RetestRequestBody } from '@/lib/api'

export const RETEST_OPTIONS_KEY = 'retest-options'

export function useRetestOptions(sampleId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [RETEST_OPTIONS_KEY, sampleId],
    queryFn: () => getRetestOptions(sampleId as string),
    enabled: enabled && Boolean(sampleId),
    staleTime: 30_000,
    retry: false,
  })
}

export function useCreateRetest(
  sampleId: string,
  opts: { onCreated?: (r: RetestCreated) => void }
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: RetestRequestBody) => createRetest(sampleId, body),
    onSuccess: r => {
      toast.success(
        `Retest order ${r.order_number ?? ''} created`
          .replace('  ', ' ')
          .trim(),
        {
          description: r.payment_url
            ? 'Waiting for payment; the sample is created when the order completes.'
            : 'The sample is created when the order completes.',
        }
      )
      queryClient.invalidateQueries({
        queryKey: ['ordered-products', sampleId],
      })
      queryClient.invalidateQueries({
        queryKey: [RETEST_OPTIONS_KEY, sampleId],
      })
      opts.onCreated?.(r)
    },
    onError: (e: Error) => {
      toast.error('Retest failed', { description: e.message })
    },
  })
}
