import type {
  AnalysisProfile,
  AnalysisServiceRecord,
  InboxPriority,
  SenaiteAnalysis,
  SenaiteLookupResult,
  ServiceGroup,
  SlaPriorityTier,
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
  // Optional — populated when the caller resolved the tier via
  // `resolveSampleTierWithReason`. Threading the reason through aggregation
  // lets OrderSlaCell render a breakdown tooltip for the driving sample
  // without re-running the resolver.
  reason?: SampleSlaReason | null
  // Multi-tier follow-on — which service-group bucket this cell represents.
  // A sample with multiple groups contributes multiple cells to order
  // aggregation; the driving cell's group surfaces on OrderSlaVerdict so the
  // order-level tooltip can say which group drove the worst color.
  groupKey?: GroupKey
  groupName?: string
}

export interface OrderSlaVerdict {
  color: OrderSlaColor
  drivingSampleId?: string
  drivingTier?: SlaTier
  drivingStatus?: SlaStatus
  /** SLA clock start (received_at) of the driving sample — surfaced so the
   *  order-level breakdown tooltip can show "Received: ..." as its first field.
   *  Read off the driving cell's lookup. */
  drivingReceivedAt?: string | null
  /** Reason snapshot for the driving sample — present only when the
   *  upstream cell state was populated with a reason. */
  drivingReason?: SampleSlaReason
  /** Multi-tier follow-on — which service-group's tier drove the order
   *  verdict. Surfaced on the SlaBreakdownTooltip so the order-level breakdown
   *  can say "Group tier (HPLC)" instead of the generic "Group tier".
   *  Populated only when the driving cell had a real (non-NO_GROUP_KEY) group. */
  drivingGroupKey?: GroupKey
  drivingGroupName?: string
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

/** A profile's own tier, paired with the profile's name so the reason/tooltip
 *  can say WHICH profile drove the precedence decision without a second
 *  lookup. Returned by `buildServiceToProfileTierMap` and consumed by the
 *  profile-tier step (2.5) in every resolver below. */
export interface ServiceProfileTier {
  tier: SlaTier
  profileName: string
}

/**
 * Service-id → tightest TIERED profile among the active profiles that carry
 * the service (Task 11). Mirrors `buildServiceToGroupTierMap`'s tightest-wins
 * idiom exactly (strict `<`, so a first-seen tie is kept), except the value
 * also carries the winning profile's name — precedence needs to report WHICH
 * profile won, and re-deriving that after the fact could pick a different
 * profile than the one that actually set the tightest tier on a multi-way
 * tie, so tier and name are resolved atomically in one pass.
 *
 * Profiles without a sla_tier_id, or whose tier id is missing from
 * `tiersById`, are skipped (same "don't shadow a real tier with a null" rule
 * as the group map). Inactive profiles are also skipped — a retired profile
 * must not keep driving SLA precedence for services it once claimed.
 */
export function buildServiceToProfileTierMap(
  profiles: AnalysisProfile[],
  tiersById: Map<number, SlaTier>
): Map<number, ServiceProfileTier> {
  const out = new Map<number, ServiceProfileTier>()
  for (const p of profiles) {
    if (!p.active) continue
    if (p.sla_tier_id == null) continue
    const tier = tiersById.get(p.sla_tier_id)
    if (!tier) continue
    for (const svcId of p.member_service_ids) {
      const existing = out.get(svcId)
      if (!existing || tier.target_minutes < existing.tier.target_minutes) {
        out.set(svcId, { tier, profileName: p.name })
      }
    }
  }
  return out
}

/**
 * Apply precedence: priority-override > profile-tier > tightest-group-tier >
 * default. Returns null if no default is configured AND nothing resolves.
 *
 * `serviceToProfileTier` (Task 11) is OPTIONAL and trailing: legacy callers
 * that don't pass one skip the profile step entirely and fall through to the
 * group-tier step exactly as before — byte-identical behavior for anything
 * that hasn't been wired to profile data yet.
 */
export function resolveSampleTier(
  inputs: SampleSlaInputs,
  keywordToServiceId: Map<string, number>,
  serviceToGroupTier: Map<number, SlaTier>,
  priorityToTier: Map<InboxPriority, SlaTier>,
  defaultTier: SlaTier | null,
  serviceToProfileTier?: Map<number, ServiceProfileTier>
): SlaTier | null {
  // 1. Priority override.
  if (inputs.priority) {
    const pTier = priorityToTier.get(inputs.priority)
    if (pTier) return pTier
  }
  // 1.5. Tightest profile tier across the sample's analyses (Task 11).
  if (serviceToProfileTier) {
    let tightestProfile: ServiceProfileTier | null = null
    for (const a of inputs.analyses) {
      if (!a.keyword) continue
      const svcId = keywordToServiceId.get(a.keyword)
      if (svcId == null) continue
      const candidate = serviceToProfileTier.get(svcId)
      if (!candidate) continue
      if (!tightestProfile || candidate.tier.target_minutes < tightestProfile.tier.target_minutes) {
        tightestProfile = candidate
      }
    }
    if (tightestProfile) return tightestProfile.tier
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

/** Which precedence rule produced the resolved tier (or 'none' if nothing did).
 *  'profile' (Task 11): a tiered analysis profile beat the bucket's group
 *  tier — see `SampleSlaReason.profileName` for which profile won. */
export type TierSource = 'priority' | 'group' | 'default' | 'none' | 'profile'

/** Multi-tier follow-on: when a priority override fires, was it the global
 *  override (NULL service_group_id) or a per-group override? Only populated
 *  when `tierSource === 'priority'`. Lets the breakdown tooltip distinguish
 *  "expedited (HPLC override)" from "expedited (global override)". */
export type PriorityScope = 'global' | 'group'

/**
 * Diagnostic breakdown of WHY a sample resolved to a particular tier — surfaced
 * in the breakdown tooltip on order/sample SLA indicators so analysts can audit
 * the precedence decision without opening Preferences.
 *
 * - `tierSource` records which precedence rule fired.
 * - `priorityUsed` is only populated when `tierSource === 'priority'`.
 * - `priorityScope` is only populated when `tierSource === 'priority'` (multi-
 *   tier follow-on). Tells whether the per-group or global priority row won.
 * - `multiGroupCandidates` is only populated when `tierSource === 'group'`
 *   AND more than one group-tier candidate was found — i.e. the tooltip needs
 *   to say "tightest of N candidates".
 * - `unmappedKeywords` lists analyses whose keyword had no row in the
 *   keyword→service-id map, regardless of `tierSource`. Useful for spotting
 *   newly-added analyses that haven't been wired into a service group yet.
 * - `profileName` (Task 11) is only populated when `tierSource === 'profile'`
 *   — the name of the tiered analysis profile that beat the bucket's group
 *   tier. Drives the tooltip's "Profile SLA — {profile name}" line.
 */
export interface SampleSlaReason {
  tierSource: TierSource
  priorityUsed?: InboxPriority
  priorityScope?: PriorityScope
  multiGroupCandidates?: { tierName: string; targetMinutes: number }[]
  unmappedKeywords: string[]
  profileName?: string
}

/**
 * Same precedence as `resolveSampleTier` but also returns a `SampleSlaReason`
 * describing which rule fired and (for groups) what the candidate set looked
 * like. The two functions MUST stay in lockstep on precedence semantics —
 * any change to one must be mirrored in the other (and asserted by tests).
 *
 * `serviceToProfileTier` (Task 11) is OPTIONAL and trailing — see
 * `resolveSampleTier`'s doc for the same fall-through guarantee.
 */
export function resolveSampleTierWithReason(
  inputs: SampleSlaInputs,
  keywordToServiceId: Map<string, number>,
  serviceToGroupTier: Map<number, SlaTier>,
  priorityToTier: Map<InboxPriority, SlaTier>,
  defaultTier: SlaTier | null,
  serviceToProfileTier?: Map<number, ServiceProfileTier>
): { tier: SlaTier | null; reason: SampleSlaReason } {
  // 1. Priority override.
  if (inputs.priority) {
    const pTier = priorityToTier.get(inputs.priority)
    if (pTier) {
      return {
        tier: pTier,
        reason: {
          tierSource: 'priority',
          priorityUsed: inputs.priority,
          unmappedKeywords: [],
        },
      }
    }
  }
  // 1.5 / 2. Single pass: collect unmapped keywords, group-tier candidates,
  // AND (Task 11) the tightest profile-tier candidate — one loop instead of
  // walking `inputs.analyses` twice. The profile candidate is checked first
  // below (1.5 beats 2), but both are gathered here so unmappedKeywords stays
  // identical regardless of which step ultimately wins.
  const unmappedKeywords: string[] = []
  const candidates: { tier: SlaTier }[] = []
  let tightestProfile: ServiceProfileTier | null = null
  for (const a of inputs.analyses) {
    if (!a.keyword) continue
    const svcId = keywordToServiceId.get(a.keyword)
    if (svcId == null) {
      unmappedKeywords.push(a.keyword)
      continue
    }
    const groupTier = serviceToGroupTier.get(svcId)
    if (groupTier) candidates.push({ tier: groupTier })
    if (serviceToProfileTier) {
      const candidate = serviceToProfileTier.get(svcId)
      if (candidate && (!tightestProfile || candidate.tier.target_minutes < tightestProfile.tier.target_minutes)) {
        tightestProfile = candidate
      }
    }
  }
  // 1.5. Tightest profile tier — beats the group step below.
  if (tightestProfile) {
    return {
      tier: tightestProfile.tier,
      reason: {
        tierSource: 'profile',
        profileName: tightestProfile.profileName,
        unmappedKeywords,
      },
    }
  }
  if (candidates.length > 0) {
    const tightest = candidates.reduce((a, b) =>
      a.tier.target_minutes <= b.tier.target_minutes ? a : b
    )
    return {
      tier: tightest.tier,
      reason: {
        tierSource: 'group',
        unmappedKeywords,
        // Only populate when there's an actual choice to report — single
        // candidates don't need a "tightest of 1" line in the tooltip.
        multiGroupCandidates:
          candidates.length > 1
            ? candidates.map(c => ({
                tierName: c.tier.name,
                targetMinutes: c.tier.target_minutes,
              }))
            : undefined,
      },
    }
  }
  // 3. Default tier (or nothing).
  if (defaultTier) {
    return {
      tier: defaultTier,
      reason: { tierSource: 'default', unmappedKeywords },
    }
  }
  return { tier: null, reason: { tierSource: 'none', unmappedKeywords } }
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
    drivingReceivedAt: driver.lookup?.date_received ?? null,
    drivingReason: driver.reason ?? undefined,
    // Multi-tier follow-on: the driving cell may belong to a specific service
    // group; surfacing its identity lets OrderSlaCell's tooltip say "Group
    // tier (HPLC)" rather than the generic "Group tier". NO_GROUP_KEY is
    // omitted (the tooltip has no useful label to render for it).
    drivingGroupKey:
      driver.groupKey !== undefined && driver.groupKey !== NO_GROUP_KEY
        ? driver.groupKey
        : undefined,
    drivingGroupName: driver.groupName,
  }
}

// ─── Multi-tier follow-on ─────────────────────────────────────────────────────
//
// The functions and types below resolve a sample to ONE tier PER service group
// rather than collapsing to a single tightest tier. The legacy
// `resolveSampleTier` / `resolveSampleTierWithReason` above are unchanged and
// remain in use until the consumer (useOrderSlaStatuses) migrates over in the
// next commit.
//
// Mental model: a sample's analyses are bucketed by their service group; each
// bucket resolves to its own tier using the precedence
//   (priority, group_id) > (priority, NULL) > group's own tier > default
// Analyses whose keyword maps to no service, or to a service in no group, go
// into a special 'no-group' bucket and use only the (priority, NULL) → default
// portion of the precedence.

/** Sentinel key for the bucket holding analyses that don't map to any service
 *  group. Kept as a typed constant so consumers can branch on it without magic
 *  strings. */
export const NO_GROUP_KEY = 'no-group' as const
export type GroupKey = number | typeof NO_GROUP_KEY

/**
 * Service-id → group-id map. When a service is a member of multiple groups,
 * pick the group whose tier has the SMALLEST target_minutes — matches the
 * existing `buildServiceToGroupTierMap` "tightest wins" rule so a service's
 * group membership stays consistent across the two map builders.
 */
export function buildServiceIdToGroupIdMap(
  groups: ServiceGroup[],
  tiersById: Map<number, SlaTier>
): Map<number, number> {
  const out = new Map<number, number>()
  // Track the chosen group's tier minutes so we can compare on collision.
  const chosenTierMin = new Map<number, number>()
  for (const g of groups) {
    const tier = g.sla_tier_id != null ? tiersById.get(g.sla_tier_id) : undefined
    const min = tier ? tier.target_minutes : Number.POSITIVE_INFINITY
    for (const svcId of g.member_ids) {
      const prev = chosenTierMin.get(svcId)
      if (prev === undefined || min < prev) {
        out.set(svcId, g.id)
        chosenTierMin.set(svcId, min)
      }
    }
  }
  return out
}

/** Group-id → tier map. Groups without a tier id (or whose tier id is missing
 *  from `tiersById`) are omitted — callers should fall back to the default
 *  tier in the resolver's precedence walk. */
export function buildGroupIdToTierMap(
  groups: ServiceGroup[],
  tiersById: Map<number, SlaTier>
): Map<number, SlaTier> {
  const out = new Map<number, SlaTier>()
  for (const g of groups) {
    if (g.sla_tier_id == null) continue
    const tier = tiersById.get(g.sla_tier_id)
    if (tier) out.set(g.id, tier)
  }
  return out
}

/** Global priority overrides (rows with NULL service_group_id) keyed by
 *  priority value. */
export function buildGlobalPriorityToTierMap(
  rows: SlaPriorityTier[],
  tiersById: Map<number, SlaTier>
): Map<InboxPriority, SlaTier> {
  const out = new Map<InboxPriority, SlaTier>()
  for (const row of rows) {
    if (row.service_group_id != null) continue
    const tier = tiersById.get(row.sla_tier_id)
    if (tier) out.set(row.priority, tier)
  }
  return out
}

/** Per-(priority, group) overrides keyed by `${priority}|${groupId}`. The
 *  string composition keeps lookups O(1) without nesting Maps. */
export function buildPerGroupPriorityToTierMap(
  rows: SlaPriorityTier[],
  tiersById: Map<number, SlaTier>
): Map<string, SlaTier> {
  const out = new Map<string, SlaTier>()
  for (const row of rows) {
    if (row.service_group_id == null) continue
    const tier = tiersById.get(row.sla_tier_id)
    if (tier) out.set(`${row.priority}|${row.service_group_id}`, tier)
  }
  return out
}

/**
 * Resolve every (sample → service group) bucket to its own tier, applying the
 * precedence (priority, group_id) > (priority, NULL) > profile tier > group's
 * own tier > default per bucket (Task 11 inserts the profile-tier step
 * between the priority overrides and the group's own tier — a tiered
 * analysis profile beats its member services' group tier, but still loses to
 * either priority override). Analyses with unmapped keywords or whose
 * service has no group land in a `NO_GROUP_KEY` bucket; the profile-tier step
 * (like the group's-own-tier step) never applies there.
 *
 * Returns at least one entry whenever the sample has any analyses (or the
 * sample has a priority override / default tier configured — see edge cases
 * below). An empty map means the sample has no analyses AND there is no
 * default tier.
 *
 * Edge cases:
 * - All keywords unmapped: produces a single `NO_GROUP_KEY` entry whose
 *   reason.unmappedKeywords lists every analysis keyword.
 * - Service is in multiple groups: the bucket follows the tightest-tier rule
 *   from `buildServiceIdToGroupIdMap` (so it's deterministic and matches the
 *   legacy single-tier collapse for that one service).
 * - Multiple services in one bucket belong to (different) tiered profiles:
 *   the tightest (smallest target_minutes) profile tier wins — same
 *   tightest-wins idiom as the multi-group candidate set.
 * - Sample has no analyses: returns an empty map.
 */
export function resolveSampleTiersByGroup(
  inputs: SampleSlaInputs,
  keywordToServiceId: Map<string, number>,
  serviceIdToGroupId: Map<number, number>,
  serviceIdToProfileTier: Map<number, ServiceProfileTier>,
  groupIdToTier: Map<number, SlaTier>,
  globalPriorityToTier: Map<InboxPriority, SlaTier>,
  perGroupPriorityToTier: Map<string, SlaTier>,
  defaultTier: SlaTier | null
): Map<GroupKey, { tier: SlaTier | null; reason: SampleSlaReason }> {
  // Bucket each analysis by group, and accumulate unmapped keywords AND
  // mapped service ids per bucket. The service ids feed the profile-tier step
  // below (2.5) — profile membership is per-service, not per-keyword.
  const bucketKeywords = new Map<GroupKey, string[]>()
  const bucketServiceIds = new Map<GroupKey, number[]>()
  for (const a of inputs.analyses) {
    if (!a.keyword) continue
    const svcId = keywordToServiceId.get(a.keyword)
    if (svcId == null) {
      const arr = bucketKeywords.get(NO_GROUP_KEY) ?? []
      arr.push(a.keyword)
      bucketKeywords.set(NO_GROUP_KEY, arr)
      continue
    }
    const groupId = serviceIdToGroupId.get(svcId)
    const key: GroupKey = groupId ?? NO_GROUP_KEY
    if (!bucketKeywords.has(key)) bucketKeywords.set(key, [])
    const svcArr = bucketServiceIds.get(key) ?? []
    svcArr.push(svcId)
    bucketServiceIds.set(key, svcArr)
  }

  const result = new Map<GroupKey, { tier: SlaTier | null; reason: SampleSlaReason }>()
  for (const [key, keywords] of bucketKeywords) {
    // 1. (priority, group_id) — only meaningful when the bucket has a real group.
    if (inputs.priority && key !== NO_GROUP_KEY) {
      const perGroupTier = perGroupPriorityToTier.get(`${inputs.priority}|${key}`)
      if (perGroupTier) {
        result.set(key, {
          tier: perGroupTier,
          reason: {
            tierSource: 'priority',
            priorityUsed: inputs.priority,
            priorityScope: 'group',
            unmappedKeywords: keywords,
          },
        })
        continue
      }
    }
    // 2. (priority, NULL) — global override.
    if (inputs.priority) {
      const globalTier = globalPriorityToTier.get(inputs.priority)
      if (globalTier) {
        result.set(key, {
          tier: globalTier,
          reason: {
            tierSource: 'priority',
            priorityUsed: inputs.priority,
            priorityScope: 'global',
            unmappedKeywords: keywords,
          },
        })
        continue
      }
    }
    // 2.5. Tightest profile tier (Task 11) — only for real-group buckets;
    // beats the group's own tier below but loses to both priority steps
    // above. When more than one service in the bucket belongs to a (different)
    // tiered profile, the tightest target_minutes wins.
    if (key !== NO_GROUP_KEY) {
      const svcIds = bucketServiceIds.get(key) ?? []
      let tightestProfile: ServiceProfileTier | null = null
      for (const svcId of svcIds) {
        const candidate = serviceIdToProfileTier.get(svcId)
        if (!candidate) continue
        if (!tightestProfile || candidate.tier.target_minutes < tightestProfile.tier.target_minutes) {
          tightestProfile = candidate
        }
      }
      if (tightestProfile) {
        result.set(key, {
          tier: tightestProfile.tier,
          reason: {
            tierSource: 'profile',
            profileName: tightestProfile.profileName,
            unmappedKeywords: keywords,
          },
        })
        continue
      }
    }
    // 3. Group's own tier (only for real-group buckets).
    if (key !== NO_GROUP_KEY) {
      const groupTier = groupIdToTier.get(key)
      if (groupTier) {
        result.set(key, {
          tier: groupTier,
          reason: { tierSource: 'group', unmappedKeywords: keywords },
        })
        continue
      }
    }
    // 4. Default tier (or nothing).
    if (defaultTier) {
      result.set(key, {
        tier: defaultTier,
        reason: { tierSource: 'default', unmappedKeywords: keywords },
      })
    } else {
      result.set(key, {
        tier: null,
        reason: { tierSource: 'none', unmappedKeywords: keywords },
      })
    }
  }
  return result
}
