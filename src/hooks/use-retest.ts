import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { createAddonOrder, createRetest, getRetestOptions } from '@/lib/api'
import type {
  AddonOrderBody,
  AddonOrderCreated,
  RetestCreated,
  RetestRequestBody,
} from '@/lib/api'
import { NATIVE_PARENT_ANALYSES_QUERY_KEY } from '@/lib/native-parent-analyses'

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
      const paymentUrl = r.payment_url
      toast.success(
        `Retest order ${r.order_number ?? ''} created`
          .replace('  ', ' ')
          .trim(),
        paymentUrl
          ? {
              duration: 15000,
              description:
                'Waiting for payment. The link is also in this dialog under Pending retest orders.',
              action: {
                label: 'Copy link',
                onClick: () => {
                  void navigator.clipboard?.writeText(paymentUrl)
                },
              },
            }
          : {
              description:
                'Order completed; the new sample is being created now.',
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

/** Same-sample add-on (original in progress): no new sample is minted. */
export function useCreateAddonOrder(
  sampleId: string,
  opts: { onCreated?: (r: AddonOrderCreated) => void }
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: AddonOrderBody) => createAddonOrder(sampleId, body),
    onSuccess: r => {
      const paymentUrl = r.payment_url
      if (paymentUrl)
        toast.success(
          `Add-on order ${r.order_number} created. Waiting for payment; the services are added to ${sampleId} when it is paid.`,
          {
            duration: 15000,
            action: {
              label: 'Copy link',
              onClick: () => {
                void navigator.clipboard?.writeText(paymentUrl)
              },
            },
          }
        )
      else
        toast.success(
          `Add-on order ${r.order_number} completed; the services are being added to ${sampleId} now.`
        )
      // A waived order is applied (WP -> IS -> Mk1) before the response returns,
      // so this refetch already sees the new rows.
      for (const queryKey of [
        [RETEST_OPTIONS_KEY, sampleId],
        ['ordered-products', sampleId],
        [NATIVE_PARENT_ANALYSES_QUERY_KEY, sampleId],
        ['sub-samples', sampleId],
      ])
        queryClient.invalidateQueries({ queryKey })
      opts.onCreated?.(r)
    },
    onError: (e: Error) => {
      toast.error('Add-on order failed', { description: e.message })
    },
  })
}
