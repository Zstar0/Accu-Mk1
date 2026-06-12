// Pure, framework-free helpers for family-grouped rendering of the
// Worksheet Inbox. A "family" = all visible vials sharing a
// parent_sample_id. See
// docs/superpowers/specs/2026-06-11-vial-level-worksheets-inbox-design.md.
import type { InboxVialItem } from '@/lib/api'
import type { DragData } from '@/components/hplc/InboxVialCard'

export interface VialFamily {
  parentSampleId: string
  vials: InboxVialItem[]
}

/** Drag payload for a whole-family drop. Discriminated from single-vial
 *  DragData by the `family` flag. */
export interface FamilyDragData {
  family: true
  parentSampleId: string
  items: DragData[]
}

const PRIORITY_ORDER: Record<string, number> = { expedited: 0, high: 1, normal: 2 }

function familyPriorityRank(vials: InboxVialItem[]): number {
  return Math.min(...vials.map(v => PRIORITY_ORDER[v.priority] ?? 2))
}

/** Group vials by parent_sample_id and sort for rendering: families ordered
 *  by their MOST URGENT vial's priority, then parent id; vials within a
 *  family by (parent row first, vial_sequence). Keeping a mixed-priority
 *  family intact is deliberate — techs grab all of a sample's vials at
 *  once, so a family must never split across the list. */
export function groupInboxFamilies(vials: InboxVialItem[]): VialFamily[] {
  const byParent = new Map<string, InboxVialItem[]>()
  for (const v of vials) {
    const list = byParent.get(v.parent_sample_id)
    if (list) list.push(v)
    else byParent.set(v.parent_sample_id, [v])
  }
  const families: VialFamily[] = Array.from(byParent.entries()).map(
    ([parentSampleId, fam]) => ({
      parentSampleId,
      vials: fam.slice().sort((a, b) => {
        if (a.is_parent !== b.is_parent) return a.is_parent ? -1 : 1
        return a.vial_sequence - b.vial_sequence
      }),
    }),
  )
  families.sort((a, b) => {
    const ra = familyPriorityRank(a.vials)
    const rb = familyPriorityRank(b.vials)
    if (ra !== rb) return ra - rb
    return a.parentSampleId.localeCompare(b.parentSampleId)
  })
  return families
}

/** Per-vial drag payloads for a whole-family drop — one entry per vial,
 *  byte-identical to what the vial's own drag handle would carry
 *  (InboxVialCard's useDraggable data). */
export function familyDragItems(vials: InboxVialItem[]): DragData[] {
  return vials.map(v => ({
    sampleUid: v.uid,
    sampleId: v.sample_id,
    groupId: v.analyses[0]?.group_id ?? 0,
    groupName: v.analyses[0]?.group_name ?? '',
    dateReceived: v.date_received,
    analyses: v.analyses.map(a => ({
      title: a.title,
      keyword: a.keyword,
      peptide_name: a.peptide_name,
      method: a.method,
    })),
  }))
}

/** Earliest date_received in the family — drives the header aging timer. */
export function familyDateReceived(vials: InboxVialItem[]): string | null {
  const dates = vials
    .map(v => v.date_received)
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
  if (dates.length === 0) return null
  return dates.slice().sort()[0] ?? null
}
