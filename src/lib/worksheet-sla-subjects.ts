import type { WorksheetListItem } from '@/lib/api'
import { legacyToKey } from '@/lib/inbox-sla'
import { slaSubjectIdentities, type SlaSubject } from '@/services/sla-subjects'

export type WorksheetItemRow = WorksheetListItem['items'][number]

/**
 * The SLA subjects for a worksheet's items: one per item, keyed by item id.
 * Shared by the drawer's item list, the endo table and the bench-sheet
 * actions so every surface resolves the same tier and the same due date.
 * A completed worksheet freezes the clock at its completion.
 */
export function worksheetItemSlaSubjects(
  items: WorksheetItemRow[],
  completedAt: string | null
): SlaSubject[] {
  return items.map(item => ({
    key: String(item.id),
    priority: legacyToKey(item.priority),
    groupId: item.service_group_id,
    receivedAt: item.date_received ?? item.added_at,
    completedAt,
    // Profile-SLA step (Task 11): tiered profile beats the group tier.
    // Each row's service FK is the identity; keyword only for rows without
    // one (HPLC-native slice 15).
    ...slaSubjectIdentities(item.analyses),
  }))
}
