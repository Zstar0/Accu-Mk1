// Storage-key shapes for worksheet items, department-first with a legacy
// read-fallback (S2 Task 10).
//
// Worksheet rows used to be scoped by service group; they are scoped by
// DEPARTMENT now. Rows written before S2 carry only `service_group_id`, and
// the two id spaces are unrelated — a department key can never match a group
// key. So every key is built department-shaped (a `d` marker keeps the two
// spaces from colliding) when the row has a department, and legacy-shaped
// otherwise. Reads that must survive the cutover try both.
//
// These keys are purely client-side (React keys, a de-dupe set, the
// prep_started flags in worksheet notes JSON). Nothing here reaches the wire.

/** Per-(vial, scope) key for React lists and SLA snapshot maps.
 *  `${sample_uid}|d${department_id}` — or `${sample_uid}|${service_group_id}`
 *  for a pre-S2 row that never got a department. */
export function itemScopeKey(
  sampleUid: string,
  departmentId: number | null | undefined,
  serviceGroupId: number | null | undefined,
): string {
  if (departmentId != null) return `${sampleUid}|d${departmentId}`
  return `${sampleUid}|${serviceGroupId}`
}

/** The `prep_started:` notes-JSON key body for an item — the shape a NEW
 *  "Start Prep" click writes. Read side must use {@link isPrepStarted}. */
export function prepStartedKey(
  sampleId: string,
  departmentId: number | null | undefined,
  serviceGroupId: number | null | undefined,
): string {
  if (departmentId != null) return `${sampleId}-d${departmentId}`
  return `${sampleId}-${serviceGroupId}`
}

/** True when this item's prep was started under EITHER key shape. A worksheet
 *  whose notes were written before S2 holds group-shaped keys; a department
 *  item must still read them, or every legacy row's "Prep" marker silently
 *  reverts to an actionable "Start Prep" button. */
export function isPrepStarted(
  started: ReadonlySet<string>,
  sampleId: string,
  departmentId: number | null | undefined,
  serviceGroupId: number | null | undefined,
): boolean {
  if (started.has(prepStartedKey(sampleId, departmentId, serviceGroupId))) return true
  // Fallback only matters for a department row that predates its department.
  if (departmentId != null && serviceGroupId != null) {
    return started.has(`${sampleId}-${serviceGroupId}`)
  }
  return false
}
