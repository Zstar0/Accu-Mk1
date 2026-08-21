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
 *  failed) — the dialog fails closed on that.
 *
 *  Only valid when the CALLING row's own promoted_to_parent_id is non-null
 *  — see resolvePromotedSourceDialogParentState, which is what actually
 *  decides whether to call this at all. */
export function resolvePromotedSourceParentState(
  rows: SenaiteAnalysis[],
  keyword: string | null
): string | null {
  const matches = rows.filter(r => r.keyword === keyword)
  return matches[matches.length - 1]?.review_state ?? null
}

/** Task 10 fix round 1: sentinel parentState value for
 *  PromotedSourceRetestDialog meaning "this row's OWN promotion has no
 *  active parent (retracted/rejected) — the backend accepts the retest
 *  unconditionally, nothing to un-verify." Distinct from a real backend
 *  review_state (e.g. the literal string 'retracted') so the dialog can
 *  tell "we resolved a fetched row's raw state" apart from "we knew this
 *  without fetching, from the row itself." */
export const NO_ACTIVE_PROMOTION_PARENT_STATE = 'no_active_promotion'

/** Task 10 fix round 1: resolves PromotedSourceRetestDialog's parentState
 *  for a row about to be retested. Branches on the ROW'S OWN
 *  promoted_to_parent_id FIRST, not a keyword-newest-row heuristic — the
 *  two can diverge. A parent-tier row shares its keyword with EVERY
 *  promotion under that keyword (co-source vials, or a later re-promote
 *  after this row's own parent was retracted); "find the newest row for
 *  this keyword" can resolve to a DIFFERENT promotion's parent than the
 *  one this specific row is linked to. The row's own promoted_to_parent_id
 *  doesn't have that ambiguity: list_analyses_in_senaite_shape's
 *  promo_by_source explicitly excludes links whose parent is retracted or
 *  rejected (backend/lims_analyses/service.py ~2729), so
 *  `review_state === 'promoted' && promoted_to_parent_id == null` can ONLY
 *  mean "this row's own promotion's parent is retracted/rejected" — a row
 *  can't reach 'promoted' review_state without having been promoted once.
 *  vial_source_retest's un-promote guard is a no-op (not a rejection) in
 *  that state — the retest still succeeds server-side — so this resolves
 *  to NO_ACTIVE_PROMOTION_PARENT_STATE without a fetch. Only when
 *  promoted_to_parent_id is non-null does the keyword-newest fetch apply:
 *  the partial unique index on source_analysis_id guarantees at most one
 *  ACTIVE promotion per source, so the keyword-newest row is guaranteed to
 *  be THIS row's own promotion parent. */
export async function resolvePromotedSourceDialogParentState(
  analysis: { promoted_to_parent_id?: number | null; keyword: string | null },
  fetchParentRows: () => Promise<SenaiteAnalysis[]>
): Promise<string | null> {
  if (analysis.promoted_to_parent_id == null) {
    return NO_ACTIVE_PROMOTION_PARENT_STATE
  }
  try {
    const rows = await fetchParentRows()
    return resolvePromotedSourceParentState(rows, analysis.keyword)
  } catch {
    return null
  }
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
