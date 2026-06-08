// Pure, framework-free helpers for the Worksheet Inbox filters and the
// role-tinted badges on worksheet items. See
// docs/superpowers/specs/2026-06-07-inbox-filters-design.md.

export type InboxRoleTag = 'endo' | 'ster' | 'hplc'

interface AnalysisLike {
  keyword?: string | null
  title?: string | null
  peptide_name?: string | null
}

interface VialLike {
  sample_id: string
  analyses: AnalysisLike[]
}

/** Bench lane of a worksheet item, from its top-level service_group_id.
 *  1 = Analytics -> HPLC, 2 = Microbiology. `analyses_json` drops group_id,
 *  so this is the only reliable bench signal for a stored item. */
export function itemBench(serviceGroupId: number | null): 'hplc' | 'micro' | null {
  if (serviceGroupId === 1) return 'hplc'
  if (serviceGroupId === 2) return 'micro'
  return null
}

/** Fine-grained role of one analysis. Keyword first (ENDO-/STER- prefixes),
 *  title-substring fallback for null-keyword Mk1-native analyses, then
 *  peptide_name => hplc. Moisture (KF, no peptide) and blanks => null. */
export function analysisRole(a: AnalysisLike): InboxRoleTag | null {
  const kw = (a.keyword ?? '').toUpperCase()
  const title = a.title ?? ''
  if (kw.startsWith('ENDO') || /endotoxin/i.test(title)) return 'endo'
  if (kw.startsWith('STER') || /sterilit/i.test(title)) return 'ster'
  if (a.peptide_name) return 'hplc'
  return null
}

/** Distinct, stably-ordered role badges for a worksheet item. Bench from
 *  service_group_id picks the lane; within micro, split ENDO/STER per analysis. */
export function itemRoleBadges(item: {
  service_group_id: number | null
  analyses?: AnalysisLike[]
}): InboxRoleTag[] {
  const bench = itemBench(item.service_group_id)
  const analyses = item.analyses ?? []
  if (bench === 'hplc') return ['hplc']
  const roles = new Set<InboxRoleTag>()
  for (const a of analyses) {
    const r = analysisRole(a)
    if (r) roles.add(r)
  }
  if (bench === 'micro') {
    return (['endo', 'ster'] as const).filter(r => roles.has(r))
  }
  // Unknown bench — fall back to whatever per-analysis derivation found.
  return (['hplc', 'endo', 'ster'] as const).filter(r => roles.has(r))
}

/** Micro service-group categories for the inbox dropdown (Microbiology = group 2).
 *  Verified members: Endotoxin (ENDO-LAL), Rapid Sterility Screening (PCR)
 *  (STER-PCR), Moisture Content (KF). */
export const MICRO_CATEGORIES = [
  { value: 'endo',     label: 'Endotoxin',                       keyword: 'ENDO-LAL', titleRe: /endotoxin/i },
  { value: 'ster',     label: 'Rapid Sterility Screening (PCR)', keyword: 'STER-PCR', titleRe: /sterilit/i },
  { value: 'moisture', label: 'Moisture Content',                keyword: 'KF',       titleRe: /moisture/i },
] as const

/** True if the vial carries an analysis in the given micro category value. */
export function vialHasMicroCategory(vial: VialLike, value: string): boolean {
  const cat = MICRO_CATEGORIES.find(c => c.value === value)
  if (!cat) return false
  return vial.analyses.some(a =>
    (a.keyword ?? '').toUpperCase() === cat.keyword || cat.titleRe.test(a.title ?? ''),
  )
}

/** Case-insensitive substring match on the vial's sample_id. */
export function vialMatchesSampleId(vial: VialLike, q: string): boolean {
  return vial.sample_id.toLowerCase().includes(q.trim().toLowerCase())
}

/** Case-insensitive substring match on any analysis peptide_name OR title.
 *  Empty/blank query is a no-op (matches). */
export function vialMatchesAnalyte(vial: VialLike, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return vial.analyses.some(a =>
    (a.peptide_name ?? '').toLowerCase().includes(needle) ||
    (a.title ?? '').toLowerCase().includes(needle),
  )
}
