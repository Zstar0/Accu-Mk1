import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  fetchSlaStatuses,
  type InboxPriority,
  type SenaiteLookupResult,
  type SlaStatusRequestItem,
  type SlaTier,
} from '@/lib/api'
import {
  buildKeywordToServiceIdMap,
  buildServiceToGroupTierMap,
  classifySampleColor,
  resolveSampleTierWithReason,
  NO_GROUP_KEY,
  type SampleSlaReason,
} from '@/lib/sla-resolution'
import { useAnalysisServices } from '@/services/analysis-services'
import { useSamplePriorities } from '@/services/sample-priorities'
import { useServiceGroups } from '@/services/service-groups'
import { useSlaTiers, useSlaPriorityTiers } from '@/services/sla'
import type { SampleSlaSnapshot } from '@/services/order-sla'

export interface SampleSlaResult {
  /** Resolved snapshot. `null` if the sample is unsuitable for SLA (no
   *  lookup, no received date), tier resolution failed, or the `/sla/status`
   *  round-trip hasn't returned yet. Published samples DO produce a snapshot —
   *  a historical one with elapsed = (published_date - received_at). */
  snapshot: SampleSlaSnapshot | null
  /** Reason snapshot — populated even when `snapshot` is null IF tier
   *  resolution actually ran (lookup present + received). Lets diagnostic
   *  surfaces explain "no tier configured" cases. */
  reason: SampleSlaReason | null
  /** Resolved priority that fed the tier resolution. Useful for the
   *  breakdown tooltip's "Priority: normal/expedited" line. */
  priority: InboxPriority | null
  /** True when this snapshot represents a published sample — the renderer
   *  switches from countdown text ("Xh left") to historical text ("took Xh /
   *  Met / Missed by Yh"). Driven by lookup.review_state === 'published'. */
  isPublished: boolean
  isLoading: boolean
  isError: boolean
}

/**
 * Per-sample SLA hook for the Sample Details header and any other surface
 * that needs SLA for a single sample.
 *
 * Shares the same primitives as `useOrderSlaStatuses` (tiers, priority
 * overrides, service groups, analysis services, sample priorities) so the
 * underlying 5 cached queries are hit at most once per page load. Skips the
 * `/sla/status` round-trip entirely if the sample isn't received yet or is
 * already published.
 */
export function useSampleSla(
  lookup: SenaiteLookupResult | null | undefined
): SampleSlaResult {
  const tiersQuery = useSlaTiers()
  const prioOverridesQuery = useSlaPriorityTiers()
  const groupsQuery = useServiceGroups()
  const servicesQuery = useAnalysisServices()

  // Gate everything downstream on whether SLA is even applicable for this
  // sample. Drives query enablement so we don't hammer `/sla/status` for
  // unreceived samples. Published samples DO flow through — they get a
  // historical snapshot driven by published_date (see batchItems below).
  const applicable = Boolean(
    lookup && lookup.date_received && lookup.sample_uid
  )
  const isPublished = Boolean(
    lookup?.review_state === 'published' && lookup?.published_coa?.published_date
  )
  const publishedDate = isPublished
    ? lookup?.published_coa?.published_date ?? null
    : null
  const sampleUid = applicable && lookup ? lookup.sample_uid : ''
  // useSamplePriorities skips empty arrays internally (enabled: false).
  const prioritiesQuery = useSamplePriorities(sampleUid ? [sampleUid] : [])

  const resolved = useMemo(() => {
    if (!applicable || !lookup) {
      return { tier: null as SlaTier | null, reason: null as SampleSlaReason | null, priority: null as InboxPriority | null }
    }
    const tiers = tiersQuery.data ?? []
    const groups = groupsQuery.data ?? []
    const services = servicesQuery.data ?? []
    const tiersById = new Map(tiers.map(t => [t.id, t]))
    const defaultTier = tiers.find(t => t.is_default) ?? null
    const keywordToServiceId = buildKeywordToServiceIdMap(services)
    const serviceToGroupTier = buildServiceToGroupTierMap(groups, tiersById)
    const priorityRows = prioOverridesQuery.data ?? []
    const priorityToTier = new Map<InboxPriority, SlaTier>()
    for (const row of priorityRows) {
      const t = tiersById.get(row.sla_tier_id)
      if (t) priorityToTier.set(row.priority, t)
    }
    const prioByUid = new Map<string, InboxPriority>()
    for (const row of prioritiesQuery.data ?? []) {
      prioByUid.set(row.sample_uid, row.priority)
    }
    const priority: InboxPriority =
      (lookup.sample_uid && prioByUid.get(lookup.sample_uid)) || 'normal'
    const { tier, reason } = resolveSampleTierWithReason(
      { analyses: lookup.analyses, priority },
      keywordToServiceId,
      serviceToGroupTier,
      priorityToTier,
      defaultTier
    )
    return { tier, reason, priority }
  }, [
    applicable,
    lookup,
    tiersQuery.data,
    groupsQuery.data,
    servicesQuery.data,
    prioOverridesQuery.data,
    prioritiesQuery.data,
  ])

  // Single batch item — same payload shape as the order-list hook, just a
  // 1-element array. Hash by uid+target+business+received+override for cache
  // reuse. Published samples include now_override so the server returns a
  // frozen-in-time elapsed = (published_date - received_at).
  const batchItems: SlaStatusRequestItem[] = useMemo(() => {
    if (!applicable || !lookup || !resolved.tier || !lookup.sample_uid) return []
    const item: SlaStatusRequestItem = {
      key: lookup.sample_uid,
      received_at: lookup.date_received,
      target_minutes: resolved.tier.target_minutes,
      business_hours_only: resolved.tier.business_hours_only,
    }
    if (isPublished && publishedDate) {
      item.now_override = publishedDate
    }
    return [item]
  }, [applicable, lookup, resolved.tier, isPublished, publishedDate])

  const batchItemsHash = useMemo(
    () =>
      batchItems
        .map(b => `${b.key}:${b.target_minutes}:${b.business_hours_only ? 1 : 0}:${b.received_at ?? '-'}:${b.now_override ?? '-'}`)
        .join('|'),
    [batchItems]
  )

  const statusQuery = useQuery({
    queryKey: ['sample-sla-status', batchItemsHash],
    queryFn: () => fetchSlaStatuses(batchItems),
    enabled: batchItems.length > 0,
    // Same anti-flicker pattern as useOrderSlaStatuses — hold the previous
    // result while the new key fetches.
    placeholderData: keepPreviousData,
  })

  return useMemo<SampleSlaResult>(() => {
    if (!applicable) {
      return {
        snapshot: null,
        reason: null,
        priority: null,
        isPublished: false,
        isLoading: false,
        isError: false,
      }
    }
    const isLoading =
      tiersQuery.isLoading ||
      groupsQuery.isLoading ||
      servicesQuery.isLoading ||
      prioOverridesQuery.isLoading ||
      prioritiesQuery.isLoading ||
      (batchItems.length > 0 && statusQuery.isLoading)
    const isError =
      tiersQuery.isError ||
      groupsQuery.isError ||
      servicesQuery.isError ||
      prioOverridesQuery.isError ||
      prioritiesQuery.isError ||
      statusQuery.isError
    const { tier, reason, priority } = resolved
    // No tier resolved → no snapshot, but still surface the reason so callers
    // can show "no tier configured" diagnostics in the tooltip.
    if (!tier) {
      return { snapshot: null, reason, priority, isPublished, isLoading, isError }
    }
    const statusItem = (statusQuery.data ?? []).find(i => i.key === lookup?.sample_uid)
    const status = statusItem?.status ?? null
    if (!status) {
      return { snapshot: null, reason, priority, isPublished, isLoading, isError }
    }
    const color = classifySampleColor(status, tier)
    return {
      snapshot: {
        // useSampleSla still uses the legacy single-tier resolver, so the
        // snapshot conceptually covers the WHOLE sample (not one specific
        // group). NO_GROUP_KEY is the honest representation until this hook
        // migrates to resolveSampleTiersByGroup in a follow-on commit.
        groupKey: NO_GROUP_KEY,
        status, color, tier,
        reason: reason ?? { tierSource: 'none', unmappedKeywords: [] },
        priority: priority ?? 'normal',
      },
      reason,
      priority,
      isPublished,
      isLoading,
      isError,
    }
  }, [
    applicable,
    isPublished,
    lookup,
    resolved,
    statusQuery.data,
    statusQuery.isLoading,
    statusQuery.isError,
    tiersQuery.isLoading,
    tiersQuery.isError,
    groupsQuery.isLoading,
    groupsQuery.isError,
    servicesQuery.isLoading,
    servicesQuery.isError,
    prioOverridesQuery.isLoading,
    prioOverridesQuery.isError,
    prioritiesQuery.isLoading,
    prioritiesQuery.isError,
    batchItems.length,
  ])
}
