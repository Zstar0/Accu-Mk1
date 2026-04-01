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

const INBOX_KEY = ['inbox-samples'] as const

export function useInboxSamples() {
  return useQuery({
    queryKey: INBOX_KEY,
    queryFn: getInboxSamples,
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
      await queryClient.cancelQueries({ queryKey: INBOX_KEY })
      const previous = queryClient.getQueryData<InboxResponse>(INBOX_KEY)
      queryClient.setQueryData<InboxResponse>(INBOX_KEY, old => {
        if (!old) return old
        return {
          ...old,
          items: old.items.map(s =>
            s.uid === sampleUid ? { ...s, priority } : s
          ),
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(INBOX_KEY, context.previous)
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
      queryClient.invalidateQueries({ queryKey: INBOX_KEY })
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
      queryClient.invalidateQueries({ queryKey: INBOX_KEY })
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
