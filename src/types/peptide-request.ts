// src/types/peptide-request.ts — mirror the contract doc's PeptideRequest shape
export type CompoundKind = 'peptide' | 'other'

export type RequestStatus =
  | 'new' | 'approved' | 'ordering_standard' | 'sample_prep_created'
  | 'in_process' | 'on_hold' | 'completed' | 'rejected' | 'cancelled'

export interface PeptideRequest {
  id: string
  created_at: string
  updated_at: string
  /**
   * Origin of the row:
   *   'wp'     — submitted via WP checkout (integration-service relay).
   *   'manual' — lab tech created the ClickUp task directly and the
   *              taskCreated webhook materialized a row here.
   */
  source: 'wp' | 'manual'
  submitted_by_wp_user_id: number
  submitted_by_email: string
  submitted_by_name: string
  compound_kind: CompoundKind
  compound_name: string
  vendor_producer: string
  sequence_or_structure: string | null
  molecular_weight: number | null
  cas_or_reference: string | null
  vendor_catalog_number: string | null
  reason_notes: string | null
  expected_monthly_volume: number | null
  status: RequestStatus
  previous_status: RequestStatus | null
  rejection_reason: string | null
  sample_id: string | null
  clickup_task_id: string | null
  clickup_list_id: string
  clickup_assignee_ids: string[]
  senaite_service_uid: string | null
  wp_coupon_code: string | null
  wp_coupon_issued_at: string | null
  completed_at: string | null
  rejected_at: string | null
  cancelled_at: string | null
}

export interface StatusLogEntry {
  id: string
  peptide_request_id: string
  from_status: RequestStatus | null
  to_status: RequestStatus
  source: 'clickup' | 'accumk1_admin' | 'system'
  actor_clickup_user_id: string | null
  actor_accumk1_user_id: number | null
  note: string | null
  created_at: string
}

export const ACTIVE_STATUSES: RequestStatus[] = [
  'new', 'approved', 'ordering_standard', 'sample_prep_created',
  'in_process', 'on_hold',
]
export const CLOSED_STATUSES: RequestStatus[] = ['completed', 'rejected', 'cancelled']
