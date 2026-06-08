// Pure join logic for the parent analyses vial-assignment overlay. Maps each
// parent analysis keyword to the vial(s) currently carrying that analysis in
// Accu-Mk1. See docs/superpowers/specs/2026-06-08-parent-analyses-vial-assignment-design.md.
import type { SenaiteAnalysis } from '@/lib/api'

export interface VialMatch {
  vialSampleId: string        // e.g. 'P-0142-S02'
  vialLabel: string           // e.g. 'Vial 3'  (vial_sequence + 1)
  mk1Analysis: SenaiteAnalysis
}

export interface VialAssignment {
  matches: VialMatch[]        // ≥1 when present (keyword omitted from map when 0)
  editable: boolean           // true only when exactly one match
}

export interface VialInput {
  sampleId: string
  label: string
  analyses: SenaiteAnalysis[]
}

const DEAD_STATES = new Set(['retracted', 'rejected'])

/** Identity-type analysis: generic vial keyword HPLC-ID, per-peptide parent
 *  keyword ID_*, or a title ending in "Identity (HPLC)" / "ID (HPLC)". */
export function isIdentityAnalysis(a: { keyword?: string | null; title?: string | null }): boolean {
  const kw = (a.keyword ?? '').toUpperCase()
  if (kw === 'HPLC-ID' || kw.startsWith('ID_')) return true
  return /\b(identity|id)\s*\(hplc\)/i.test(a.title ?? '')
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
          out.push({ vialSampleId: v.sampleId, vialLabel: v.label, mk1Analysis: a })
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
