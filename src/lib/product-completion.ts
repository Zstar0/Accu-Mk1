/**
 * Product completion — derives, per ordered product, whether its lab work is
 * "done" and which vial(s) contributed, from data the parent sample page
 * already loads. Pure: no fetching, no side effects.
 *
 * Rules (per the 2026-06-28 design):
 *   - Endotoxin  → the Endotoxin-group analysis (ENDO-LAL) is promoted
 *   - Sterility  → the Microbiology-group analysis (STER-PCR) is promoted
 *   - HPLC (Core)→ EVERY hplc-family parent analysis is promoted (strict)
 *   - AccuShield → the bundle ("Core + Full Biosafety Suite") is done only when
 *                  EVERY live parent analysis is promoted — HPLC AND Endotoxin
 *                  AND Sterility. (Core is HPLC-only; AccuShield = Core + Endo +
 *                  Ster, so its check must clear all three, not just HPLC.)
 *   - Variance   → the variance set is locked (the lock guard already enforces
 *                  the required count + promoted/verified, see lock_variance_set)
 *
 * hplc-family = parent analyses whose service group is neither "Microbiology"
 * nor "Endotoxin" (mirrors the seeder's _NON_HPLC_GROUPS).
 */
import type {
  OrderedProduct, ParentPromotionInfo, SenaiteAnalysis, VarianceSetResponse,
} from '@/lib/api'

export interface ProductCompletion {
  /** True when this product's completion condition is satisfied. */
  met: boolean
  /** Vial sample_ids that contributed to the met condition (for the hover tooltip). */
  vials: string[]
}

export interface ProductCompletionContext {
  /** Parent AR analyses (from the SENAITE lookup). */
  analyses: SenaiteAnalysis[]
  /** keyword → promotion record (from listParentPromotions). */
  promotionsByKeyword: Map<string, ParentPromotionInfo>
  /** Variance set overlay (present only when the family has a variance vial). */
  varianceSet: VarianceSetResponse | undefined
}

type CompletionKind = 'endo' | 'ster' | 'hplc' | 'bundle' | 'variance'

const NON_HPLC_GROUPS = new Set(['Microbiology', 'Endotoxin'])

/** Map an ordered-product key to its completion rule (null = no check shown).
 *  `core`/`hplcpurity_identity`/`bac_water_panel` are single-component HPLC
 *  packages; `accushield` is the multi-component bundle (Core + Endo + Ster). */
function completionKind(productKey: string): CompletionKind | null {
  switch (productKey) {
    case 'endotoxin':
      return 'endo'
    case 'sterility_pcr':
      return 'ster'
    case 'accushield':
      return 'bundle'
    case 'core':
    case 'hplcpurity_identity':
    case 'bac_water_panel':
      return 'hplc'
    case 'variance':
      return 'variance'
    default:
      return null
  }
}

function inCategory(a: SenaiteAnalysis, kind: 'endo' | 'ster' | 'hplc'): boolean {
  const group = a.service_group_name
  if (kind === 'endo') return group === 'Endotoxin'
  if (kind === 'ster') return group === 'Microbiology'
  return !NON_HPLC_GROUPS.has(group ?? '') // hplc = everything not micro/endo
}

export function computeProductCompletion(
  product: OrderedProduct,
  ctx: ProductCompletionContext,
): ProductCompletion | null {
  const kind = completionKind(product.key)
  if (!kind) return null

  if (kind === 'variance') {
    const locked = ctx.varianceSet?.locked === true
    const vials = locked
      ? (ctx.varianceSet?.vials ?? [])
          .filter(v => v.in_variance_set)
          .map(v => v.sample_id)
      : []
    return { met: locked, vials }
  }

  // endo / ster / hplc / bundle: every live (non-retested) analysis in the
  // category must have a promotion. An empty category is "not done" (nothing to
  // promote yet). `bundle` (AccuShield) spans ALL groups — HPLC + Endo + Ster.
  const category = ctx.analyses.filter(
    a => !a.retested && a.keyword && (kind === 'bundle' || inCategory(a, kind)),
  )
  if (category.length === 0) return { met: false, vials: [] }

  const allPromoted = category.every(a => ctx.promotionsByKeyword.has(a.keyword!))
  if (!allPromoted) return { met: false, vials: [] }

  const vials = Array.from(
    new Set(
      category.flatMap(a =>
        (ctx.promotionsByKeyword.get(a.keyword!)?.sources ?? [])
          .map(s => s.sample_id)
          .filter((id): id is string => !!id),
      ),
    ),
  )
  return { met: true, vials }
}
