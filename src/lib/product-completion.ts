/**
 * Product completion — derives, per ordered product, whether its lab work is
 * "done" and which vial(s) contributed, from data the parent sample page
 * already loads. Pure: no fetching, no side effects.
 *
 * Rules (per the 2026-06-28 design, families extended 2026-08-28):
 *   - Endotoxin  → the ENDO-* analysis is promoted
 *   - Sterility  → the STER-* (non-USP) analysis is promoted
 *   - HPLC (Core)→ EVERY hplc-family parent analysis is promoted (strict)
 *   - AccuShield → the bundle ("Core + Full Biosafety Suite") is done only when
 *                  EVERY live parent analysis in HPLC + Endo + Ster is promoted.
 *   - Variance   → the variance set is locked (the lock guard already enforces
 *                  the required count + promoted/verified, see lock_variance_set)
 *   - Native catalog families (heavy_metals, fentanyl, sterility-usp71, and
 *     any future profile with member services) → EVERY member-service analysis
 *     is promoted. Membership is CATALOG-DRIVEN via `buildKeywordFamilyMap`
 *     (profile member_ids -> service keywords), so a new family added in the
 *     admin UI completes without code edits.
 *
 * Classification is KEYWORD-first with the service-group check kept only as a
 * SENAITE-era fallback: the sample_details read source serves registry rows
 * whose `service_group_name` is always null (group enrichment was a
 * SENAITE-path feature), so the original group-name partition silently broke
 * when the read source flipped (2026-08-27) — STER-PCR and every new-family
 * row landed in the hplc bucket, blocking the HPLC check and making the
 * Sterility check unreachable.
 */
import type {
  AnalysisProfile,
  OrderedProduct,
  ParentPromotionInfo,
  SenaiteAnalysis,
  VarianceSetResponse,
} from '@/lib/api'

export interface ProductCompletion {
  /** True when this product's completion condition is satisfied. */
  met: boolean
  /** Vial sample_ids that contributed to the met condition (for the hover tooltip). */
  vials: string[]
}

export interface ProductCompletionContext {
  /** Parent AR analyses (from the per-sample lookup, either read source). */
  analyses: SenaiteAnalysis[]
  /** keyword → promotion record (from listParentPromotions). */
  promotionsByKeyword: Map<string, ParentPromotionInfo>
  /** Variance set overlay (present only when the family has a variance vial). */
  varianceSet: VarianceSetResponse | undefined
  /** UPPERCASE keyword → owning profile key, from buildKeywordFamilyMap.
   *  Optional: without it the native families fall back to pattern rules
   *  below (which don't know them), so callers should pass it. */
  keywordFamilies?: Map<string, string>
}

// ── Analysis-family classification ──────────────────────────────────────────

/** UPPERCASE keyword → profile key for every ACTIVE profile that declares
 *  member services. Legacy profiles (hplcpurity_identity, endotoxin,
 *  sterility_pcr, …) deliberately keep their membership rows empty in prod —
 *  they classify via the pattern rules instead — so this map is effectively
 *  the native-family registry (heavy_metals, fentanyl, sterility-usp71, …). */
export function buildKeywordFamilyMap(
  profiles: AnalysisProfile[],
  services: { id: number; keyword: string | null }[]
): Map<string, string> {
  const keywordById = new Map(services.map(s => [s.id, s.keyword]))
  const map = new Map<string, string>()
  for (const p of profiles) {
    if (!p.active) continue
    for (const sid of p.member_ids ?? []) {
      const kw = keywordById.get(sid)
      if (kw) map.set(kw.toUpperCase(), p.key)
    }
  }
  return map
}

/** Micro service groups — SENAITE-era fallback only (registry rows carry no
 *  group). Prod folds endotoxin INTO 'Microbiology'; endotoxin is told apart
 *  by keyword (the P-0965 lesson). */
const MICRO_GROUPS = new Set(['Microbiology', 'Endotoxin'])

/** Enumerated analytical keyword families — mirrors the backend backfill's
 *  explicit `_UNGROUPED_ANALYTICAL_LIKE_PATTERNS` doctrine: never a
 *  catch-all "everything else is HPLC". An unmatched keyword belongs to NO
 *  family: it can't block a check and can't satisfy one (false-unchecked is
 *  safer than false-checked; moisture's KF/MOISTURE-KF lands here). */
const HPLC_KEYWORD_PREFIXES = [
  'ANALYTE-',
  'ID_',
  'PEPT',
  'HPLC',
  'PUR_',
  'QTY_',
  'BLEND',
]

/** The family of one analysis: a catalog family key (profile key), one of
 *  'endotoxin' | 'sterility_pcr' | 'hplc', or null (unclassified). */
export function analysisFamily(
  a: SenaiteAnalysis,
  keywordFamilies?: Map<string, string>
): string | null {
  const kw = (a.keyword ?? '').toUpperCase()
  if (!kw) return null
  const mapped = keywordFamilies?.get(kw)
  if (mapped) return mapped
  if (kw.startsWith('ENDO')) return 'endotoxin'
  if (kw.startsWith('STER')) return 'sterility_pcr'
  // SENAITE-era fallback: a micro-grouped, non-endotoxin row is sterility.
  if (MICRO_GROUPS.has(a.service_group_name ?? '')) return 'sterility_pcr'
  if (HPLC_KEYWORD_PREFIXES.some(p => kw.startsWith(p))) return 'hplc'
  return null
}

/** HPLC single-component package keys — each one's category is the hplc
 *  family (plus any keywords a dev-seeded catalog maps to them directly). */
const HPLC_PACKAGE_KEYS = new Set([
  'core',
  'hplcpurity_identity',
  'bac_water_panel',
])

/** Does `family` (from analysisFamily) count toward `productKey`'s check? */
function familyMatchesProduct(family: string, productKey: string): boolean {
  if (productKey === 'accushield') {
    return (
      family === 'hplc' ||
      family === 'endotoxin' ||
      family === 'sterility_pcr' ||
      HPLC_PACKAGE_KEYS.has(family)
    )
  }
  if (HPLC_PACKAGE_KEYS.has(productKey)) {
    return family === 'hplc' || HPLC_PACKAGE_KEYS.has(family)
  }
  return family === productKey
}

/** Whether this product has a completion rule at all. Legacy keys are
 *  explicit; any other key participates only when the catalog declares
 *  member services for it (so unknown products keep rendering with NO
 *  check, exactly as before). */
function hasCompletionRule(
  productKey: string,
  keywordFamilies?: Map<string, string>
): boolean {
  if (
    productKey === 'endotoxin' ||
    productKey === 'sterility_pcr' ||
    productKey === 'accushield' ||
    HPLC_PACKAGE_KEYS.has(productKey)
  ) {
    return true
  }
  if (!keywordFamilies) return false
  for (const fam of keywordFamilies.values()) {
    if (fam === productKey) return true
  }
  return false
}

function categoryAnalyses(
  product: OrderedProduct,
  analyses: SenaiteAnalysis[],
  keywordFamilies?: Map<string, string>
): SenaiteAnalysis[] {
  return analyses.filter(a => {
    if (a.retested || !a.keyword) return false
    const family = analysisFamily(a, keywordFamilies)
    return family !== null && familyMatchesProduct(family, product.key)
  })
}

// ── Canonical rule (Sample Details): promotion-based ────────────────────────

export function computeProductCompletion(
  product: OrderedProduct,
  ctx: ProductCompletionContext
): ProductCompletion | null {
  if (product.key === 'variance') {
    const locked = ctx.varianceSet?.locked === true
    const vials = locked
      ? (ctx.varianceSet?.vials ?? [])
          .filter(v => v.in_variance_set)
          .map(v => v.sample_id)
      : []
    return { met: locked, vials }
  }
  if (!hasCompletionRule(product.key, ctx.keywordFamilies)) return null

  // Every live analysis in the product's category must have a promotion. An
  // empty category is "not done" (nothing to promote yet).
  const category = categoryAnalyses(product, ctx.analyses, ctx.keywordFamilies)
  if (category.length === 0) return { met: false, vials: [] }

  const allPromoted = category.every(a =>
    ctx.promotionsByKeyword.has(a.keyword!)
  )
  if (!allPromoted) return { met: false, vials: [] }

  const vials = Array.from(
    new Set(
      category.flatMap(a =>
        (ctx.promotionsByKeyword.get(a.keyword!)?.sources ?? [])
          .map(s => s.sample_id)
          .filter((id): id is string => !!id)
      )
    )
  )
  return { met: true, vials }
}

// ── Order Status board variant: state-derived ───────────────────────────────

/** Analysis states whose result is in — submitted (SENAITE flow), promoted
 *  awaiting sign-off (native flow), or beyond. The board's chip check means
 *  "the lab work for this product is done"; review may still remain. */
const RESULT_DONE_STATES = new Set([
  'to_be_verified',
  'parent_to_verify',
  'verified',
  'published',
])

/** Dead rows never block completion (the canonical rule reaches the same end
 *  through promotions: dead rows are the un-promotable leftovers). */
const DEAD_STATES = new Set(['rejected', 'cancelled', 'invalid', 'retracted'])

/**
 * State-derived product completion for surfaces that only have the per-sample
 * lookup (Order Status table + kanban cards — 372 samples; fetching
 * promotions + variance sets per sample is off the table). Shares the
 * family classification with the canonical rule above so the two can't
 * drift on category membership. Deliberate differences:
 *   - "done" = every live category analysis has its result in
 *     (RESULT_DONE_STATES) instead of "a promotion row exists".
 *   - variance returns null (its check needs the lock state, which the
 *     lookup doesn't carry) — Sample Details stays the authoritative view.
 *   - contributing vials are unknown here (empty list).
 */
export function computeProductCompletionFromStates(
  product: OrderedProduct,
  analyses: SenaiteAnalysis[],
  keywordFamilies?: Map<string, string>
): ProductCompletion | null {
  if (product.key === 'variance') return null
  if (!hasCompletionRule(product.key, keywordFamilies)) return null
  const category = categoryAnalyses(product, analyses, keywordFamilies).filter(
    a => !DEAD_STATES.has((a.review_state ?? '').toLowerCase())
  )
  if (category.length === 0) return { met: false, vials: [] }
  const met = category.every(a =>
    RESULT_DONE_STATES.has((a.review_state ?? '').toLowerCase())
  )
  return { met, vials: [] }
}
