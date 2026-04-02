import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getInboxSamples,
  updateInboxPriority,
  bulkUpdateInbox,
  createWorksheet,
  type InboxResponse,
  type InboxPriority,
} from '@/lib/api'
import { toast } from 'sonner'

export function inboxKey(hideTestOrders: boolean) {
  return ['inbox-samples', { hideTestOrders }] as const
}

export function useInboxSamples(hideTestOrders = true) {
  return useQuery({
    queryKey: inboxKey(hideTestOrders),
    queryFn: () => getInboxSamples(hideTestOrders),
    refetchInterval: 30_000, // 30s polling per D-04
    staleTime: 0, // always fresh -- live queue
  })
}

export function usePriorityMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ sampleUid, priority }: { sampleUid: string; priority: InboxPriority }) =>
      updateInboxPriority(sampleUid, priority),
    onMutate: async ({ sampleUid, priority }) => {
      await queryClient.cancelQueries({ queryKey: ['inbox-samples'] })
      // Optimistically update all inbox query variants (any hideTestOrders value)
      const allQueries = queryClient.getQueriesData<InboxResponse>({ queryKey: ['inbox-samples'] })
      const previousMap = new Map(allQueries)
      for (const [key] of allQueries) {
        queryClient.setQueryData<InboxResponse>(key, old => {
          if (!old) return old
          return {
            ...old,
            items: old.items.map(s =>
              s.uid === sampleUid ? { ...s, priority } : s
            ),
          }
        })
      }
      return { previousMap }
    },
    onError: (_err, _vars, context) => {
      if (context?.previousMap) {
        for (const [key, data] of context.previousMap) {
          queryClient.setQueryData(key, data)
        }
      }
      toast.error('Failed to update priority')
    },
  })
}

export function useBulkUpdateMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: bulkUpdateInbox,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
      toast.success('Bulk update applied')
    },
    onError: () => {
      toast.error('Bulk update failed')
    },
  })
}

export function useCreateWorksheetMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: createWorksheet,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['inbox-samples'] })
      toast.success(`Worksheet "${data.title}" created with ${data.item_count} items`)
    },
    onError: (err: Error & { staleUids?: string[] }) => {
      if (err.staleUids) {
        toast.error(`${err.staleUids.length} sample(s) have changed state -- selection updated`)
      } else {
        toast.error('Failed to create worksheet')
      }
    },
  })
}
