// Pure join logic for the parent analyses vial-assignment overlay. Maps each
// parent analysis keyword to the vial(s) currently carrying that analysis in
// Accu-Mk1. See docs/superpowers/specs/2026-06-08-parent-analyses-vial-assignment-design.md.
import type { QueryClient } from '@tanstack/react-query'
import type { SenaiteAnalysis } from '@/lib/api'

// Query-key roots that render vial-assignment state. The per-vial overlay (the
// parent AR table's "assigned vial" column) and the quicklook dialog's analyses
// are both keyed by vial pk, so they live here as the single source of truth —
// SampleDetails and VialsQuickLookDialog import these instead of re-declaring
// the literal, which kept silently drifting from the invalidate call.
export const PARENT_OVERLAY_QUERY_KEY = 'parent-overlay-vial-analyses' as const
export const QUICKLOOK_VIAL_ANALYSES_QUERY_KEY = 'quicklook-vial-analyses' as const

/**
 * Light-tier refresh: refetch the parent AR overlay for a single vial after a
 * vial-analysis edit inside QuickLook (result / method / instrument). Those
 * edits change what the parent row's overlay column shows for that vial
 * (analyst, review state, method, instrument) but touch nothing else, so we
 * invalidate only that vial's overlay query — not every vial, and not the
 * heavier sub-samples / quicklook caches (the dialog keeps its own optimistic
 * update, so refetching those would only cause flicker). Pass no pk to refresh
 * every vial's overlay (used by the parent-wide refreshSample path).
 */
export function invalidateParentVialOverlay(
  queryClient: QueryClient,
  subSamplePk?: number,
): void {
  void queryClient.invalidateQueries({
    queryKey:
      subSamplePk == null
        ? [PARENT_OVERLAY_QUERY_KEY]
        : [PARENT_OVERLAY_QUERY_KEY, subSamplePk],
  })
}

/**
 * Refetch every active query that renders a vial's assignment after a role
 * change (re-assign in quicklook, drag-to-bucket / reset in the receive wizard).
 *
 * The role PATCH mutates server state immediately, but three caches feed the
 * parent sample page and would otherwise serve stale rows until their staleTime
 * elapsed (and `refetchOnWindowFocus` is off globally, so tabbing away won't
 * save us): the parent-scoped sub-samples list, the per-vial parent-AR overlay,
 * and the quicklook per-vial analyses. The latter two are vial-pk-keyed, so they
 * invalidate by key prefix; sub-samples is scoped to this parent only.
 */
export function invalidateVialAssignmentCaches(
  queryClient: QueryClient,
  parentSampleId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: ['sub-samples', parentSampleId] })
  void queryClient.invalidateQueries({ queryKey: [PARENT_OVERLAY_QUERY_KEY] })
  void queryClient.invalidateQueries({ queryKey: [QUICKLOOK_VIAL_ANALYSES_QUERY_KEY] })
}

export interface VialMatch {
  vialSampleId: string        // e.g. 'P-0142-S02'
  vialLabel: string           // e.g. 'Vial 3' — mode-aware (see lib/vial-label.ts)
  mk1Analysis: SenaiteAnalysis
  assignmentRole?: string | null  // the vial's own bench role (hplc/endo/ster)
  assignmentKind?: string | null  // 'core' | 'variance' | null — variance treatment keys off this
}

export interface VialAssignment {
  matches: VialMatch[]        // ≥1 when present (keyword omitted from map when 0)
  editable: boolean           // true only when exactly one match
}

export interface VialInput {
  sampleId: string
  label: string
  analyses: SenaiteAnalysis[]
  assignmentRole?: string | null  // the sub-sample's bench role; carried onto each VialMatch
  assignmentKind?: string | null  // the sub-sample's assignment_kind; carried onto each VialMatch
}

const DEAD_STATES = new Set(['retracted', 'rejected'])

/** Identity-type analysis: generic vial keyword HPLC-ID, per-peptide parent
 *  keyword ID_*, or a per-peptide title ending in "Identity (HPLC)". */
export function isIdentityAnalysis(a: { keyword?: string | null; title?: string | null }): boolean {
  const kw = (a.keyword ?? '').toUpperCase()
  if (kw === 'HPLC-ID' || kw.startsWith('ID_')) return true
  return /\bidentity\s*\(hplc\)/i.test(a.title ?? '')
}

/** Pick the single live row per keyword on one vial: drop retracted/rejected,
 *  prefer a non-retested row, else the first remaining. */
function liveByKeyword(analyses: SenaiteAnalysis[]): Map<string, SenaiteAnalysis> {
  const out = new Map<string, SenaiteAnalysis>()
  for (const a of analyses) {
    if (!a.keyword) continue
    if (DEAD_STATES.has(a.review_state ?? '')) continue
    const existing = out.get(a.keyword)
    if (!existing) { out.set(a.keyword, a); continue }
    // Prefer the non-retested (current) row.
    if (existing.retested && !a.retested) out.set(a.keyword, a)
  }
  return out
}

/** Build parentKeyword → VialAssignment. Exact keyword match first; identity
 *  type-bridge (ID_* ↔ HPLC-ID) only in single-peptide families. */
export function buildVialAssignmentMap(
  parentAnalyses: SenaiteAnalysis[],
  vials: VialInput[],
): Map<string, VialAssignment> {
  // Per-vial live keyword index.
  const vialLive = vials.map(v => ({ v, live: liveByKeyword(v.analyses) }))

  const matchToVialMatches = (predicate: (kw: string, a: SenaiteAnalysis) => boolean): VialMatch[] => {
    const out: VialMatch[] = []
    for (const { v, live } of vialLive) {
      for (const [kw, a] of live) {
        if (predicate(kw, a)) {
          out.push({ vialSampleId: v.sampleId, vialLabel: v.label, mk1Analysis: a, assignmentRole: v.assignmentRole, assignmentKind: v.assignmentKind })
          break // one analysis per vial per parent row
        }
      }
    }
    return out
  }

  // Identity bridge eligibility: parent has exactly one identity-type analysis.
  const parentIdentityCount = parentAnalyses.filter(isIdentityAnalysis).length
  const identityBridgeAllowed = parentIdentityCount === 1

  const result = new Map<string, VialAssignment>()
  for (const pa of parentAnalyses) {
    if (!pa.keyword) continue
    // 1) exact keyword.
    let matches = matchToVialMatches(kw => kw === pa.keyword)
    // 2) identity bridge (only if no exact match and single-peptide family).
    if (matches.length === 0 && identityBridgeAllowed && isIdentityAnalysis(pa)) {
      matches = matchToVialMatches((_kw, a) => isIdentityAnalysis(a))
    }
    if (matches.length === 0) continue
    result.set(pa.keyword, { matches, editable: matches.length === 1 })
  }
  return result
}
