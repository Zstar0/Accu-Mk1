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
const SYNC_KEY = [...KEY_ROOT, 'sync-diff'] as const

// --- Sync-from-ClickUp wire types ---
// Shape matches backend peptide_request_sync.compute_diff / apply_actions.
// Kept inline rather than in src/types/ because they're modal-internal;
// if a third consumer appears, promote to a shared types file.

export interface SyncDiffCreateItem {
  task_id: string
  name: string
  clickup_status: string
  clickup_url: string
  creator_username: string
}

export interface SyncDiffRetireItem {
  row_id: string
  clickup_task_id: string
  compound_name: string
  status: RequestStatus
  created_at: string | null
}

export interface SyncDiffFixStatusItem {
  row_id: string
  clickup_task_id: string
  compound_name: string
  mk1_status: RequestStatus
  clickup_column: string
  mapped_status: RequestStatus
}

/**
 * One item in the field_drift bucket. Emitted by compute_diff when a
 * row + task agree on identity (same clickup_task_id) but disagree on
 * one of the 5 bidirectional-sync fields. compound_kind's
 * clickup_value is already resolved to 'peptide'/'other' server-side
 * (NOT the raw option UUID) so the UI renders it verbatim.
 */
export type BidirectionalField =
  | 'sample_id'
  | 'compound_kind'
  | 'cas_or_reference'
  | 'vendor_producer'
  | 'submitted_by_email'

export interface SyncDiffFieldDriftItem {
  row_id: string
  task_id: string
  compound_name: string
  field: BidirectionalField
  db_value: string | null
  clickup_value: string | null
}

export interface SyncDiff {
  in_clickup_not_mk1: SyncDiffCreateItem[]
  in_mk1_not_clickup: SyncDiffRetireItem[]
  status_mismatch: SyncDiffFixStatusItem[]
  field_drift: SyncDiffFieldDriftItem[]
}

export interface FieldDriftResolution {
  row_id: string
  field: BidirectionalField
  value_to_use: 'db' | 'clickup'
}

export interface SyncApplyRequest {
  materialize_task_ids: string[]
  retire_row_ids: string[]
  fix_status_pairs: { row_id: string; target_status: RequestStatus }[]
  resolve_field_drift: FieldDriftResolution[]
}

export interface SyncApplyResult {
  materialized: number
  retired: number
  fixed_status: number
  field_drift_resolved: number
  errors: { type: string; id: string; reason: string }[]
}

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

/**
 * Fetches the 3-bucket diff between the ClickUp list and Accu-Mk1.
 *
 * Gated behind `enabled` so the modal can decline to fetch until the
 * user opens it (the query would otherwise fire on every render of
 * PeptideRequestsList). Pass `enabled: true` when the modal mounts.
 *
 * staleTime is 0 — sync is fundamentally a "give me ground truth right
 * now" operation; we don't want tanstack serving a stale diff after
 * the tech closed + reopened the modal.
 */
export function useSyncDiff(enabled: boolean) {
  return useQuery({
    queryKey: SYNC_KEY,
    queryFn: () =>
      apiFetch<SyncDiff>('/lims/peptide-requests/sync/diff'),
    enabled,
    staleTime: 0,
    gcTime: 0,
  })
}

/**
 * Applies the tech's selected actions. On success invalidates BOTH the
 * peptide-requests list (so retired rows disappear and materialized
 * rows appear) AND the sync-diff query so the modal refreshes to show
 * what's left after this round of fixes.
 */
export function useApplySync() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SyncApplyRequest) =>
      apiFetch<SyncApplyResult>('/lims/peptide-requests/sync/apply', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY_ROOT, 'list'] })
      qc.invalidateQueries({ queryKey: SYNC_KEY })
    },
  })
}
