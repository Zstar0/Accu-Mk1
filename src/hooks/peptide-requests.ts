import { useQuery } from '@tanstack/react-query'
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
        `/api/lims/peptide-requests?${params}`
      )
    },
  })
}

export function usePeptideRequest(id: string) {
  return useQuery({
    queryKey: [...KEY_ROOT, 'detail', id],
    queryFn: () => apiFetch<PeptideRequest>(`/api/lims/peptide-requests/${id}`),
    enabled: Boolean(id),
  })
}

export function usePeptideRequestHistory(id: string) {
  return useQuery({
    queryKey: [...KEY_ROOT, 'history', id],
    queryFn: () =>
      apiFetch<StatusLogEntry[]>(`/api/lims/peptide-requests/${id}/history`),
    enabled: Boolean(id),
  })
}
