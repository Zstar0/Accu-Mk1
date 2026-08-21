import type { ParentPromotionInfo } from './api'

/** Query-key literal for the native parent analyses card, hoisted so
 *  SampleDetails.refreshSample can invalidate it — the literal used to live
 *  inline in the component and NOTHING invalidated it (staleTime 30s masked
 *  the gap while the card was read-only). Same drift-prevention move as
 *  PARENT_OVERLAY_QUERY_KEY in lib/vial-assignment.ts. */
export const NATIVE_PARENT_ANALYSES_QUERY_KEY = 'native-parent-analyses'

export interface ParentRetestImpact {
  sourceCount: number
  vialIds: string[]
}

/** Blast radius for the parent-retest confirm: how many promoted source
 *  results get retracted, on which vials. Missing promotion record → zero
 *  impact; the confirm dialog fails closed on it (disabled action). */
export function buildParentRetestImpact(
  promotion: ParentPromotionInfo | undefined
): ParentRetestImpact {
  if (!promotion) return { sourceCount: 0, vialIds: [] }
  return {
    sourceCount: promotion.sources.length,
    vialIds: promotion.sources
      .map(s => s.sample_id)
      .filter((s): s is string => !!s),
  }
}

/** Aggregate impact for bulk retest across keywords (vial ids deduped). */
export function buildBulkParentRetestImpact(
  keywords: string[],
  promotionsByKeyword: Map<string, ParentPromotionInfo> | undefined
): ParentRetestImpact {
  const per = keywords.map(k => buildParentRetestImpact(promotionsByKeyword?.get(k)))
  return {
    sourceCount: per.reduce((n, p) => n + p.sourceCount, 0),
    vialIds: Array.from(new Set(per.flatMap(p => p.vialIds))),
  }
}
