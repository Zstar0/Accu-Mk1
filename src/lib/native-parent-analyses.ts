import type { ParentPromotionInfo, SenaiteAnalysis } from './api'

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

/** Task 10: resolves the parent-tier row's current state for a promoted
 *  vial's keyword — the PromotedSourceRetestDialog's copy source. Mirrors
 *  the backend's own ordering contract (list_native_parent_analyses_
 *  senaite_shape: `ORDER BY keyword, id`, "the table groups by title and
 *  renders history rows itself, taking the LAST row as current") — among
 *  rows sharing a keyword, the last one in array order is current. null
 *  when there's no matching row (keyword not (yet) promoted, or the read
 *  failed) — the dialog fails closed on that. */
export function resolvePromotedSourceParentState(
  rows: SenaiteAnalysis[],
  keyword: string | null
): string | null {
  const matches = rows.filter(r => r.keyword === keyword)
  return matches[matches.length - 1]?.review_state ?? null
}

export interface PromotedSourceRetestOutcome {
  newRowId: number
  parentUnverified: boolean
  parentReviewState: string | null
}

/** Task 10: the vial-side (source) retest's confirm-flow orchestration —
 *  parses the mk1: uid and invokes the injected retest call, returning its
 *  outcome for the caller to toast/refresh on. Extracted (same move as
 *  buildParentRetestImpact/buildBulkParentRetestImpact above) so the
 *  confirm-flow contract is directly testable: SampleDetails itself has no
 *  render harness in this repo (six nested queries — see
 *  sample-details-assignment-label.test.ts), so this is what actually ships
 *  in SampleDetails' onConfirm handler, not a test-only reimplementation of
 *  it. */
export async function runPromotedSourceRetest(
  uid: string,
  retest: (analysisId: number, reason?: string) => Promise<{
    new_row_id: number
    parent_unverified: boolean
    parent_review_state: string | null
  }>
): Promise<PromotedSourceRetestOutcome> {
  const analysisId = parseInt(uid.slice('mk1:'.length), 10)
  const resp = await retest(analysisId)
  return {
    newRowId: resp.new_row_id,
    parentUnverified: resp.parent_unverified,
    parentReviewState: resp.parent_review_state,
  }
}
