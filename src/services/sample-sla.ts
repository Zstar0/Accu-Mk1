import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  fetchSlaStatuses,
  type InboxPriority,
  type SenaiteLookupResult,
  type SlaStatus,
  type SlaStatusRequestItem,
  type SlaTier,
} from '@/lib/api'
import {
  buildKeywordToServiceIdMap,
  buildServiceIdToGroupIdMap,
  buildGroupIdToTierMap,
  buildGlobalPriorityToTierMap,
  buildPerGroupPriorityToTierMap,
  classifySampleColor,
  resolveSampleTiersByGroup,
  NO_GROUP_KEY,
  type GroupKey,
  type SampleSlaReason,
} from '@/lib/sla-resolution'
import { useAnalysisServices } from '@/services/analysis-services'
import { useSamplePriorities } from '@/services/sample-priorities'
import { useServiceGroups } from '@/services/service-groups'
import { useSlaTiers, useSlaPriorityTiers } from '@/services/sla'
import type { SampleSlaSnapshot } from '@/services/order-sla'

export interface SampleSlaResult {
  /** Multi-tier follow-on: one snapshot per service-group bucket the sample's
   *  analyses touch. Empty array when the sample is unsuitable for SLA (no
   *  lookup, no received date), tier resolution failed, or the `/sla/status`
   *  round-trip hasn't returned yet. Published samples DO produce snapshots —
   *  historical ones with elapsed = (published_date - received_at) per group.
   *  Single-group samples have an array of length 1; consumers that still
   *  render a single row can index [0]. */
  snapshots: SampleSlaSnapshot[]
  /** Resolved priority that fed the per-group tier resolution. Useful for the
   *  breakdown tooltip's "Priority: normal/expedited" line. Priority is
   *  per-sample (not per-group) so it stays at the top level. */
  priority: InboxPriority | null
  /** True when this sample is published — the renderer switches from
   *  countdown text ("Xh left") to historical text ("took Xh / Met / Missed
   *  by Yh"). Driven by lookup.review_state === 'published'. */
  isPublished: boolean
  isLoading: boolean
  isError: boolean
}

/**
 * Per-sample SLA hook for the Sample Details header and any other surface
 * that needs SLA for a single sample.
 *
 * Multi-tier model (mirrors useOrderSlaStatuses): the sample's analyses are
 * bucketed by their resolved service group via `resolveSampleTiersByGroup`;
 * each bucket gets its own (tier, status, color) and shows up as a separate
 * snapshot in the returned array. Each `/sla/status` batch item is keyed
 * `${sample_uid}|${groupKey}` so the response is unambiguous when the same
 * sample has multiple groups with different `target_minutes` /
 * `business_hours_only`.
 *
 * Shares the same primitives as `useOrderSlaStatuses` (tiers, priority
 * overrides, service groups, analysis services, sample priorities) so the
 * underlying 5 cached queries are hit at most once per page load. Skips the
 * `/sla/status` round-trip entirely if the sample isn't received yet.
 * Published samples flow through — each batch item gets a `now_override` so
 * the server returns a frozen-in-time elapsed = (published_date - received_at)
 * per group.
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
  // unreceived samples. Published samples DO flow through — they get
  // historical snapshots driven by published_date (see batchItems below).
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

  /** Per-group resolution for THIS one sample. Flattened to an array of
   *  {groupKey, groupName, tier, reason} entries so batchItems and
   *  snapshots both consume the same iteration. */
  const perGroup = useMemo(() => {
    if (!applicable || !lookup) {
      return [] as {
        groupKey: GroupKey
        groupName?: string
        tier: SlaTier | null
        reason: SampleSlaReason
      }[]
    }
    const tiers = tiersQuery.data ?? []
    const groups = groupsQuery.data ?? []
    const services = servicesQuery.data ?? []
    const tiersById = new Map(tiers.map(t => [t.id, t]))
    const defaultTier = tiers.find(t => t.is_default) ?? null
    const keywordToServiceId = buildKeywordToServiceIdMap(services)
    const serviceIdToGroupId = buildServiceIdToGroupIdMap(groups, tiersById)
    const groupIdToTier = buildGroupIdToTierMap(groups, tiersById)
    const priorityRows = prioOverridesQuery.data ?? []
    const globalPriorityToTier = buildGlobalPriorityToTierMap(priorityRows, tiersById)
    const perGroupPriorityToTier = buildPerGroupPriorityToTierMap(priorityRows, tiersById)
    const groupNameById = new Map(groups.map(g => [g.id, g.name]))
    const prioByUid = new Map<string, InboxPriority>()
    for (const row of prioritiesQuery.data ?? []) {
      prioByUid.set(row.sample_uid, row.priority)
    }
    const priority: InboxPriority =
      (lookup.sample_uid && prioByUid.get(lookup.sample_uid)) || 'normal'

    const byGroup = resolveSampleTiersByGroup(
      { analyses: lookup.analyses, priority },
      keywordToServiceId,
      serviceIdToGroupId,
      groupIdToTier,
      globalPriorityToTier,
      perGroupPriorityToTier,
      defaultTier
    )
    // Empty resolver output (no analyses) → surface a single no-group entry
    // so a sample with zero analyses still shows a default-tier snapshot
    // (matches the pre-multi-tier behavior of useSampleSla).
    if (byGroup.size === 0) {
      const reason: SampleSlaReason = defaultTier
        ? { tierSource: 'default', unmappedKeywords: [] }
        : { tierSource: 'none', unmappedKeywords: [] }
      return [{
        groupKey: NO_GROUP_KEY as GroupKey,
        groupName: undefined,
        tier: defaultTier,
        reason,
      }]
    }
    return Array.from(byGroup, ([groupKey, { tier, reason }]) => ({
      groupKey,
      groupName:
        groupKey !== NO_GROUP_KEY ? groupNameById.get(groupKey) : undefined,
      tier,
      reason,
    }))
  }, [
    applicable,
    lookup,
    tiersQuery.data,
    groupsQuery.data,
    servicesQuery.data,
    prioOverridesQuery.data,
    prioritiesQuery.data,
  ])

  const resolvedPriority = useMemo<InboxPriority | null>(() => {
    if (!applicable || !lookup) return null
    const prioByUid = new Map<string, InboxPriority>()
    for (const row of prioritiesQuery.data ?? []) {
      prioByUid.set(row.sample_uid, row.priority)
    }
    return (lookup.sample_uid && prioByUid.get(lookup.sample_uid)) || 'normal'
  }, [applicable, lookup, prioritiesQuery.data])

  /** Composite key `${sample_uid}|${groupKey}` — same scheme as
   *  useOrderSlaStatuses so the backend `/sla/status` response is unambiguous
   *  across groups for the same sample. */
  function batchKey(uid: string, groupKey: GroupKey): string {
    return `${uid}|${groupKey}`
  }

  // One batch item per resolved (sample_uid, groupKey) bucket with a non-null
  // tier. Hash by composite key + target + business + received + override for
  // cache reuse. Published samples include now_override per item so the
  // server returns a frozen-in-time elapsed = (published_date - received_at).
  const batchItems: SlaStatusRequestItem[] = useMemo(() => {
    if (!applicable || !lookup || !lookup.sample_uid) return []
    const out: SlaStatusRequestItem[] = []
    for (const g of perGroup) {
      if (!g.tier) continue
      const item: SlaStatusRequestItem = {
        key: batchKey(lookup.sample_uid, g.groupKey),
        received_at: lookup.date_received,
        target_minutes: g.tier.target_minutes,
        business_hours_only: g.tier.business_hours_only,
      }
      if (isPublished && publishedDate) {
        item.now_override = publishedDate
      }
      out.push(item)
    }
    return out
  }, [applicable, lookup, perGroup, isPublished, publishedDate])

  const batchItemsHash = useMemo(
    () =>
      [...batchItems]
        .sort((a, b) => a.key.localeCompare(b.key))
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
        snapshots: [],
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

    const statusByKey = new Map<string, SlaStatus>()
    for (const item of statusQuery.data ?? []) {
      if (item.status) statusByKey.set(item.key, item.status)
    }
    const snapshots: SampleSlaSnapshot[] = []
    if (lookup?.sample_uid) {
      for (const g of perGroup) {
        if (!g.tier) continue
        const status = statusByKey.get(batchKey(lookup.sample_uid, g.groupKey))
        if (!status) continue
        const color = classifySampleColor(status, g.tier)
        if (!color) continue
        snapshots.push({
          groupKey: g.groupKey,
          groupName: g.groupName,
          status,
          color,
          tier: g.tier,
          reason: g.reason,
          priority: resolvedPriority ?? 'normal',
          receivedAt: lookup?.date_received ?? null,
        })
      }
    }
    return {
      snapshots,
      priority: resolvedPriority,
      isPublished,
      isLoading,
      isError,
    }
  }, [
    applicable,
    isPublished,
    lookup,
    perGroup,
    resolvedPriority,
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
