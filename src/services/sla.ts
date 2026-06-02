import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  getSlaTiers, createSlaTier, updateSlaTier, deleteSlaTier,
  getSlaPriorityTiers, setSlaPriorityTier, deleteSlaPriorityTier,
  type SlaTier, type SlaTierCreate, type SlaTierUpdate, type InboxPriority,
} from '@/lib/api'

export const slaQueryKeys = {
  tiers: ['sla', 'tiers'] as const,
  priorityTiers: ['sla', 'priority-tiers'] as const,
}

export function useSlaTiers() {
  return useQuery({ queryKey: slaQueryKeys.tiers, queryFn: getSlaTiers, staleTime: 1000 * 60 * 5 })
}

export function useSlaPriorityTiers() {
  return useQuery({ queryKey: slaQueryKeys.priorityTiers, queryFn: getSlaPriorityTiers, staleTime: 1000 * 60 * 5 })
}

export function useCreateSlaTier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: SlaTierCreate) => createSlaTier(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: slaQueryKeys.tiers }); toast.success('SLA tier created') },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdateSlaTier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: SlaTierUpdate }) => updateSlaTier(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: slaQueryKeys.tiers }); toast.success('SLA tier saved') },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteSlaTier() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteSlaTier(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: slaQueryKeys.tiers }); toast.success('SLA tier deleted') },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useSetPriorityTier() {
  const qc = useQueryClient()
  return useMutation({
    // serviceGroupId omitted/null = global override; an id scopes to that group.
    // Multi-tier reshape: precedence resolves (priority, group_id) before
    // (priority, NULL) so lab can layer e.g. expedited-HPLC=4h on top of a
    // global expedited tier.
    mutationFn: ({
      priority,
      slaTierId,
      serviceGroupId,
    }: {
      priority: InboxPriority
      slaTierId: number
      serviceGroupId?: number | null
    }) => setSlaPriorityTier(priority, slaTierId, serviceGroupId),
    onSuccess: () => qc.invalidateQueries({ queryKey: slaQueryKeys.priorityTiers }),
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeletePriorityTier() {
  const qc = useQueryClient()
  return useMutation({
    // Without serviceGroupId, removes the global override; with it, removes
    // only the per-group row (the global one survives).
    mutationFn: ({
      priority,
      serviceGroupId,
    }: {
      priority: InboxPriority
      serviceGroupId?: number | null
    }) => deleteSlaPriorityTier(priority, serviceGroupId),
    onSuccess: () => qc.invalidateQueries({ queryKey: slaQueryKeys.priorityTiers }),
    onError: (e: Error) => toast.error(e.message),
  })
}

export type { SlaTier }
