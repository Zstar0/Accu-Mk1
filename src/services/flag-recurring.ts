/**
 * TanStack Query hooks for recurring-task templates (Slice 5, admin-only).
 *
 * Mirrors services/flag-types.ts. Mutations invalidate the recurring list; the
 * minted flags themselves show up through the normal flag queries on their own
 * cadence, so no cross-invalidation is needed here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  listRecurring,
  createRecurring,
  updateRecurring,
  deleteRecurring,
  type FlagRecurringCreate,
  type FlagRecurringUpdate,
} from '@/lib/flags-api'

const KEY = ['flag-recurring'] as const

export function useRecurring() {
  return useQuery({ queryKey: KEY, queryFn: listRecurring })
}

export function useCreateRecurring() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: FlagRecurringCreate) => createRecurring(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdateRecurring() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: FlagRecurringUpdate }) =>
      updateRecurring(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteRecurring() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteRecurring(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: (e: Error) => toast.error(e.message),
  })
}
