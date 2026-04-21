import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type {
  PeptideRequest,
  RequestStatus,
  StatusLogEntry,
} from '@/types/peptide-request'

const KEY_ROOT = ['peptide-requests'] as const

export function usePeptideRequestsList(opts: {
  status?: RequestStatus[] | undefined
  limit?: number
  offset?: number
}) {
  return useQuery({
    queryKey: [...KEY_ROOT, 'list', opts],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (opts.status?.length) params.set('status', opts.status.join(','))
      if (opts.limit) params.set('limit', String(opts.limit))
      if (opts.offset) params.set('offset', String(opts.offset))
      return apiFetch<{ total: number; items: PeptideRequest[] }>(
        `/lims/peptide-requests?${params}`
      )
    },
  })
}

export function usePeptideRequest(id: string) {
  return useQuery({
    queryKey: [...KEY_ROOT, 'detail', id],
    queryFn: () => apiFetch<PeptideRequest>(`/lims/peptide-requests/${id}`),
    enabled: Boolean(id),
  })
}

export function usePeptideRequestHistory(id: string) {
  return useQuery({
    queryKey: [...KEY_ROOT, 'history', id],
    queryFn: () =>
      apiFetch<StatusLogEntry[]>(`/lims/peptide-requests/${id}/history`),
    enabled: Boolean(id),
  })
}

/**
 * Mutation for editing a peptide request from the LIMS UI.
 *
 * Backend accepts sample_id=string to set and sample_id=null to clear. On
 * success the detail query is invalidated so the UI re-reads the server
 * state (including the updated_at bump). The backend may return a
 * `warning` field when the DB was updated but the ClickUp sync failed —
 * callers can surface it to the tech without blocking the save.
 */
export function useUpdatePeptideRequest(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ sample_id }: { sample_id: string | null }) =>
      apiFetch<PeptideRequest & { warning?: string }>(
        `/lims/peptide-requests/${id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ sample_id }),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY_ROOT, 'detail', id] })
    },
  })
}
