import type {
  AnalysisServiceRecord,
  InboxPriority,
  SenaiteAnalysis,
  SenaiteLookupResult,
  ServiceGroup,
  SlaStatus,
  SlaTier,
} from '@/lib/api'

export type SlaColor = 'red' | 'amber' | 'green'
export type OrderSlaColor = SlaColor | 'met' | 'awaiting' | 'loading' | 'error'

export interface SampleSlaInputs {
  analyses: SenaiteAnalysis[]
  priority: InboxPriority | null
}

export interface SampleSlaCellState {
  senaiteId: string
  tier: SlaTier | null
  lookup: SenaiteLookupResult
  status: SlaStatus | null
  color: SlaColor | null
}

export interface OrderSlaVerdict {
  color: OrderSlaColor
  drivingSampleId?: string
  drivingTier?: SlaTier
  drivingStatus?: SlaStatus
}

/**
 * Build keyword → analysis_services.id map from the local /analysis-services
 * response. Services with no keyword are skipped (they can't be matched against
 * SENAITE analysis keywords).
 */
export function buildKeywordToServiceIdMap(
  services: AnalysisServiceRecord[]
): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of services) {
    if (s.keyword) out.set(s.keyword, s.id)
  }
  return out
}

/**
 * Service-id → tightest group tier among groups that contain the service.
 * When a service appears in multiple groups, the smallest target_minutes wins.
 * Groups without a sla_tier_id (or whose tier id is missing from tiersById) are
 * skipped so they don't shadow a real tier with a null.
 */
export function buildServiceToGroupTierMap(
  groups: ServiceGroup[],
  tiersById: Map<number, SlaTier>
): Map<number, SlaTier> {
  const out = new Map<number, SlaTier>()
  for (const g of groups) {
    if (g.sla_tier_id == null) continue
    const tier = tiersById.get(g.sla_tier_id)
    if (!tier) continue
    for (const svcId of g.member_ids) {
      const existing = out.get(svcId)
      if (!existing || tier.target_minutes < existing.target_minutes) {
        out.set(svcId, tier)
      }
    }
  }
  return out
}

/**
 * Apply precedence: priority-override > tightest-group-tier > default.
 * Returns null if no default is configured AND nothing resolves.
 */
export function resolveSampleTier(
  inputs: SampleSlaInputs,
  keywordToServiceId: Map<string, number>,
  serviceToGroupTier: Map<number, SlaTier>,
  priorityToTier: Map<InboxPriority, SlaTier>,
  defaultTier: SlaTier | null
): SlaTier | null {
  // 1. Priority override.
  if (inputs.priority) {
    const pTier = priorityToTier.get(inputs.priority)
    if (pTier) return pTier
  }
  // 2. Tightest group tier across the sample's analyses.
  let tightest: SlaTier | null = null
  for (const a of inputs.analyses) {
    if (!a.keyword) continue
    const svcId = keywordToServiceId.get(a.keyword)
    if (svcId == null) continue
    const groupTier = serviceToGroupTier.get(svcId)
    if (!groupTier) continue
    if (!tightest || groupTier.target_minutes < tightest.target_minutes) {
      tightest = groupTier
    }
  }
  if (tightest) return tightest
  // 3. Default tier.
  return defaultTier
}

/**
 * Classify ONE sample's SLA color using its own resolved tier's amber threshold.
 * `breached` is the strict > target check from the engine (B); amber is strict <.
 */
export function classifySampleColor(
  status: SlaStatus,
  tier: SlaTier
): SlaColor {
  if (status.breached) return 'red'
  // At-target without breach (remaining_minutes <= 0 but breached=false) → green.
  // Strict > check in the engine means remaining=0 is exactly on-target, not amber.
  if (status.remaining_minutes <= 0) return 'green'
  if (tier.target_minutes <= 0) return 'green'
  const pct = (status.remaining_minutes / tier.target_minutes) * 100
  if (pct < tier.amber_threshold_percent) return 'amber'
  return 'green'
}

type ActiveSample = SampleSlaCellState & {
  tier: SlaTier
  status: SlaStatus
  color: SlaColor
}

function isActive(s: SampleSlaCellState): s is ActiveSample {
  return (
    s.lookup.review_state !== 'published' &&
    s.status != null &&
    s.color != null &&
    s.tier != null
  )
}

const RANK: Record<SlaColor, number> = { red: 3, amber: 2, green: 1 }

/** Comparator: returns negative if `a` is WORSE than `b` (should drive verdict),
 *  positive if `b` is worse, 0 if tied. Worse = higher color rank, then
 *  color-specific tie-break (most-over for red, least-pct-remaining for amber). */
function compareActive(a: ActiveSample, b: ActiveSample): number {
  const r = RANK[b.color] - RANK[a.color]
  if (r !== 0) return r
  if (a.color === 'red') {
    return a.status.remaining_minutes - b.status.remaining_minutes
  }
  if (a.color === 'amber') {
    const aPct = a.status.remaining_minutes / a.status.target_minutes
    const bPct = b.status.remaining_minutes / b.status.target_minutes
    return aPct - bPct
  }
  return 0
}

/**
 * Aggregate per-sample cell state into a single order verdict.
 * Worst-active sample drives the verdict (red > amber > green), with ties broken
 * by most-over for red and least-percent-remaining for amber. Published samples
 * are excluded; an order with all-published becomes 'met'; an order with no
 * received samples becomes 'awaiting'.
 */
export function aggregateOrderSlaVerdict(
  samples: SampleSlaCellState[]
): OrderSlaVerdict {
  if (samples.length === 0) return { color: 'awaiting' }
  const active = samples.filter(isActive)
  if (active.length === 0) {
    const allPublished = samples.every(s => s.lookup.review_state === 'published')
    return { color: allPublished ? 'met' : 'awaiting' }
  }
  const driver = active.reduce((d, s) => (compareActive(s, d) < 0 ? s : d))
  return {
    color: driver.color as OrderSlaColor,
    drivingSampleId: driver.senaiteId,
    drivingTier: driver.tier,
    drivingStatus: driver.status,
  }
}
