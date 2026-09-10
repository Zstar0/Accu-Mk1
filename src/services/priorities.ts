import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  assignPriority,
  assignPriorityBulk,
  createPriority,
  deactivatePriority,
  getCustomerPriorities,
  getPriorities,
  patchPriority,
  setDefaultPriority,
  type AssignInput,
  type Priority,
} from '@/lib/api-priorities'
import { priorityQueryKeys } from '@/services/priority-keys'
import { slaQueryKeys } from '@/services/sla'

export { priorityQueryKeys } from '@/services/priority-keys'

export function usePriorities() {
  return useQuery({
    queryKey: priorityQueryKeys.all,
    queryFn: getPriorities,
    staleTime: 1000 * 60 * 5,
  })
}

export function useActivePriorities() {
  const q = usePriorities()
  return { ...q, data: q.data?.filter(p => p.is_active) }
}

export function priorityByKey(
  list: Priority[] | undefined,
  key: string | null | undefined
): Priority | undefined {
  return key ? list?.find(p => p.key === key) : undefined
}

function useInvalidateAfterAssign() {
  const qc = useQueryClient()
  return () => {
    // Every list that embeds `priority` and every SLA consumer re-reads.
    qc.invalidateQueries({
      predicate: q =>
        typeof q.queryKey[0] === 'string' &&
        /sample|order|inbox|worksheet|vial|registry|sla/i.test(q.queryKey[0]),
    })
    // The per-sample SENAITE lookup (`['senaite','lookup',id,source]`, see
    // services/senaite-lookup-map.ts) carries the inline effective priority
    // that every SLA surface now resolves its tier from, and its first key
    // segment ('senaite') is invisible to the predicate above. Prefix match
    // covers every id/source combination.
    qc.invalidateQueries({ queryKey: ['senaite', 'lookup'] })
    // Customer-level assigns land in a key the predicate cannot see.
    qc.invalidateQueries({ queryKey: priorityQueryKeys.customers })
  }
}

export function useAssignPriority() {
  const invalidate = useInvalidateAfterAssign()
  return useMutation({
    mutationFn: (input: AssignInput) => assignPriority(input),
    onSuccess: res => {
      invalidate()
      toast.success(res.new_key ? 'Priority set' : 'Priority cleared')
    },
    onError: (e: Error) =>
      toast.error('Set priority failed', { description: e.message }),
  })
}

export function useAssignPriorityBulk() {
  const invalidate = useInvalidateAfterAssign()
  return useMutation({
    mutationFn: (items: AssignInput[]) => assignPriorityBulk(items),
    onSuccess: res => {
      invalidate()
      toast.success(
        `Priority set on ${res.length} item${res.length === 1 ? '' : 's'}`
      )
    },
    onError: (e: Error) =>
      toast.error('Set priority failed', { description: e.message }),
  })
}

export function usePriorityMutations() {
  const qc = useQueryClient()
  const done = (msg: string) => () => {
    qc.invalidateQueries({ queryKey: priorityQueryKeys.all })
    qc.invalidateQueries({ queryKey: slaQueryKeys.priorityTiers })
    toast.success(msg)
  }
  const fail = (e: Error) =>
    toast.error('Priority change failed', { description: e.message })
  return {
    create: useMutation({
      mutationFn: createPriority,
      onSuccess: done('Priority created'),
      onError: fail,
    }),
    patch: useMutation({
      mutationFn: ({
        key,
        body,
      }: {
        key: string
        body: Parameters<typeof patchPriority>[1]
      }) => patchPriority(key, body),
      onSuccess: done('Priority saved'),
      onError: fail,
    }),
    deactivate: useMutation({
      mutationFn: deactivatePriority,
      onSuccess: done('Priority deactivated'),
      onError: fail,
    }),
    setDefault: useMutation({
      mutationFn: setDefaultPriority,
      onSuccess: done('Default priority changed'),
      onError: fail,
    }),
  }
}

export function useCustomerPriorities() {
  return useQuery({
    queryKey: priorityQueryKeys.customers,
    queryFn: getCustomerPriorities,
  })
}
