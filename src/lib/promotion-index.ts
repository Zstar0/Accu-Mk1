import type { ParentPromotionInfo, SenaiteAnalysis } from './api'

/**
 * A parent's promotion records, joined to parent-tier rows BY ID.
 *
 * A native parent-tier row IS a lims_analyses row (uid "mk1:<id>") and every
 * promotion record carries that row's id (lims_analysis_promotions.
 * parent_analysis_id, a real FK), so the join is exact. Keyword survives only
 * for rows that have no Mk1 id to join on (SENAITE-sourced, hex uid).
 *
 * Keyword is NOT an identity on a native blend: every analyte slot shares
 * HPLC-PURITY, so a keyword join answers for the wrong slot. That is how one
 * promoted slot used to read as "every slot promoted".
 */
export interface PromotionIndex {
  byParentId: Map<number, ParentPromotionInfo>
  byKeyword: Map<string, ParentPromotionInfo>
}

export const EMPTY_PROMOTION_INDEX: PromotionIndex = {
  byParentId: new Map(),
  byKeyword: new Map(),
}

export function indexPromotions(
  records: ParentPromotionInfo[]
): PromotionIndex {
  return {
    byParentId: new Map(records.map(r => [r.parent_analysis_id, r])),
    byKeyword: new Map(records.map(r => [r.keyword, r])),
  }
}

/** lims_analyses.id behind a "mk1:<id>" uid, or null for a SENAITE hex uid. */
export function mk1RowId(uid: string | null | undefined): number | null {
  if (!uid?.startsWith('mk1:')) return null
  const id = parseInt(uid.slice('mk1:'.length), 10)
  return Number.isNaN(id) ? null : id
}

/**
 * The promotion record for ONE parent-tier row.
 *
 * Id first. A per-slot native row (slot != null) never falls back to keyword:
 * its keyword is shared across slots, so a miss means "this slot is not
 * promoted", not "look for a sibling". Slot-less rows keep the keyword
 * fallback they always had, where a keyword is unique per parent.
 */
export function promotionForRow(
  index: PromotionIndex | undefined,
  row: Pick<SenaiteAnalysis, 'uid' | 'keyword' | 'slot'>
): ParentPromotionInfo | undefined {
  if (!index) return undefined
  const id = mk1RowId(row.uid)
  if (id != null) {
    const hit = index.byParentId.get(id)
    if (hit || row.slot != null) return hit
  }
  return row.keyword ? index.byKeyword.get(row.keyword) : undefined
}
