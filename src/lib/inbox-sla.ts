// Pure helpers wiring the inbox's vial cards into the shared SLA subject
// resolver (useSlaForSubjects) so the inbox shows the same SLA column as the
// Order Status page (dot + "over by X / X left" + breakdown tooltip).
//
// The department->group bridge exists because SLA tiers are still keyed on
// SERVICE GROUPS (departments take that over in S7), but the inbox wire's
// per-analysis `group_id` carries DEPARTMENT identity (S2 re-meaning, see
// InboxAnalysisItem). Subjects must therefore map a department to the group
// that owns it to reach the group's tier — catalog-driven off the live
// service-groups list, never hardcoded ids. Departments owning no group
// (Heavy Metals today, the "Other"/0 legacy bucket) resolve to a null group
// = the default tier, exactly like group-less items on the worksheet pages.

import type { InboxVialItem, InboxPriority, ServiceGroup } from '@/lib/api'
import type { SlaSubject } from '@/services/sla-subjects'

/** department id -> owning service group id. First group wins, in the BE's
 *  (sort_order, name) response ordering — collisions only occur if two groups
 *  share a department (Microbiology+Endotoxin historically), where either
 *  group's tier is the department's tier by construction. */
export function departmentToGroupId(
  groups: ServiceGroup[]
): Map<number, number> {
  const map = new Map<number, number>()
  for (const g of groups) {
    if (g.department_id != null && !map.has(g.department_id)) {
      map.set(g.department_id, g.id)
    }
  }
  return map
}

/** Distinct department ids across a vial's analyses, first-seen order.
 *  0 is the legacy "Other" bucket — kept, it resolves to the default tier. */
export function vialSlaDepartments(
  vial: Pick<InboxVialItem, 'analyses'>
): number[] {
  const seen: number[] = []
  for (const a of vial.analyses) {
    if (!seen.includes(a.group_id)) seen.push(a.group_id)
  }
  return seen
}

/** Subject/React key for one (vial, department) SLA lane. `|` cannot appear
 *  in a uid or a numeric department id, so the key is collision-free. */
export function inboxVialSlaKey(uid: string, departmentId: number): string {
  return `${uid}|${departmentId}`
}

/** One SLA subject per (vial, department the vial's analyses touch). Vials
 *  with no received date are skipped — the resolver would skip them anyway,
 *  and the card then renders the indicator's "—" none state. */
export function buildInboxSlaSubjects(
  vials: InboxVialItem[],
  deptToGroup: Map<number, number>
): SlaSubject[] {
  const subjects: SlaSubject[] = []
  for (const vial of vials) {
    if (!vial.date_received) continue
    for (const deptId of vialSlaDepartments(vial)) {
      subjects.push({
        key: inboxVialSlaKey(vial.uid, deptId),
        priority: vial.priority as InboxPriority,
        groupId: deptToGroup.get(deptId) ?? null,
        receivedAt: vial.date_received,
        // Profile-SLA step (Task 11): this department's analysis keywords —
        // a tiered profile covering them (e.g. Sterility USP 71's 14-day
        // tier) beats the group/default tier, matching Order Status.
        keywords: vial.analyses
          .filter(a => a.group_id === deptId)
          .map(a => a.keyword)
          .filter((k): k is string => Boolean(k)),
      })
    }
  }
  return subjects
}
