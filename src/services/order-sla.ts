import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  fetchSlaStatuses,
  type ExplorerOrder,
  type InboxPriority,
  type SenaiteLookupResult,
  type SlaStatus,
  type SlaStatusRequestItem,
  type SlaTier,
} from '@/lib/api'
import {
  aggregateOrderSlaVerdict,
  buildKeywordToServiceIdMap,
  buildServiceIdToGroupIdMap,
  buildGroupIdToTierMap,
  buildGlobalPriorityToTierMap,
  buildPerGroupPriorityToTierMap,
  classifySampleColor,
  resolveSampleTiersByGroup,
  NO_GROUP_KEY,
  type GroupKey,
  type OrderSlaVerdict,
  type SampleSlaCellState,
  type SampleSlaReason,
  type SlaColor,
} from '@/lib/sla-resolution'
import { useAnalysisServices } from '@/services/analysis-services'
import { useSamplePriorities } from '@/services/sample-priorities'
import { useServiceGroups } from '@/services/service-groups'
import { useSlaTiers, useSlaPriorityTiers } from '@/services/sla'

export interface SampleSlaSnapshot {
  /** Multi-tier follow-on: which service-group bucket this snapshot belongs
   *  to. NO_GROUP_KEY means the snapshot covers analyses that didn't map to
   *  any service group (default-tier fallback). */
  groupKey: GroupKey
  /** Display name of the service group; undefined for NO_GROUP_KEY or when
   *  the group lookup is missing. Denormalized here so the renderer doesn't
   *  need a second ServiceGroup query. */
  groupName?: string
  status: SlaStatus
  color: SlaColor
  tier: SlaTier
  /** Diagnostic — explains which precedence rule (priority/group/default) won
   *  and is consumed by the breakdown tooltip. */
  reason: SampleSlaReason
  /** Resolved priority that fed the tier resolution. Useful for the
   *  "Priority: normal/expedited" line in the breakdown tooltip. */
  priority: InboxPriority
}

export interface OrderSlaResult {
  verdictByOrderId: Map<string | number, OrderSlaVerdict>
  /** Multi-tier follow-on: each sample can now yield MULTIPLE snapshots, one
   *  per service group its analyses touch. A single-group sample still has an
   *  array of length 1. Consumers that want the legacy "one snapshot per
   *  sample" behavior can index `[0]` (preserves the visible tier of the
   *  tightest-group resolver). */
  sampleStatusesBySampleId: Map<string, SampleSlaSnapshot[]>
  isLoading: boolean
  isError: boolean
}

/**
 * Composite hook: per-order SLA verdict + per-sample-per-group snapshots for
 * the explorer.
 *
 * Wraps 5 cached queries (tiers, priority overrides, service groups, analysis
 * services, sample priorities) and runs ONE batched `/sla/status` POST keyed
 * by a stable hash of the resolved batch items (so re-renders with logically
 * identical inputs hit cache). Aggregation is `useMemo`, NOT another `useQuery`
 * (advisor sharpening #4).
 *
 * Multi-tier model: a sample's analyses are bucketed by their resolved
 * service group; each bucket gets its own (tier, status, color) via
 * `resolveSampleTiersByGroup` and contributes one cell to the order verdict.
 * The batch item key is `${sample_uid}|${groupKey}` so the `/sla/status`
 * response is unambiguous across groups for the same sample.
 *
 * @param orders — pages's order list (consumed verbatim for sample_results iteration)
 * @param sampleLookupMap — Map<senaiteId, lookupResult> from the page's senaite
 *   lookup hook. Indirection note: map keys are senaite_ids, but `/sla/status`
 *   batch is keyed by `sample_uid|groupKey` (we read sample_uid OFF each
 *   lookup result).
 * @returns
 *   `verdictByOrderId` — Map<order.order_id, OrderSlaVerdict>; the verdict's
 *      worst-color is computed across ALL (sample, group) cells the order
 *      contains.
 *   `sampleStatusesBySampleId` — Map<senaiteId, SampleSlaSnapshot[]>; one
 *      entry per service group the sample touches. Only present for
 *      received-but-unpublished samples with non-null tier AND status AND
 *      color for that bucket.
 *   `isLoading` / `isError` — composed across all dependent queries.
 */
export function useOrderSlaStatuses(
  orders: ExplorerOrder[],
  sampleLookupMap: Map<string, { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }>
): OrderSlaResult {
  const tiersQuery = useSlaTiers()
  const prioOverridesQuery = useSlaPriorityTiers()
  const groupsQuery = useServiceGroups()
  const servicesQuery = useAnalysisServices()

  const liveLookups = useMemo(() => {
    const out: { senaiteId: string; lookup: SenaiteLookupResult }[] = []
    for (const order of orders) {
      if (!order.sample_results) continue
      for (const entry of Object.values(order.sample_results)) {
        if (!entry.senaite_id || entry.status === 'failed') continue
        const lq = sampleLookupMap.get(entry.senaite_id)
        if (!lq?.data) continue
        if (lq.data.review_state === 'published') continue
        if (!lq.data.date_received) continue
        out.push({ senaiteId: entry.senaite_id, lookup: lq.data })
      }
    }
    return out
  }, [orders, sampleLookupMap])

  const sampleUids = useMemo(
    () => liveLookups.map(l => l.lookup.sample_uid).filter((u): u is string => Boolean(u)),
    [liveLookups]
  )

  const prioritiesQuery = useSamplePriorities(sampleUids)

  /** Flattened per-sample-per-group resolution. One entry per (sample, group)
   *  bucket produced by `resolveSampleTiersByGroup`. Samples whose analyses
   *  span multiple groups appear N times here. */
  const perSampleGroup = useMemo(() => {
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

    const out: {
      senaiteId: string
      lookup: SenaiteLookupResult
      groupKey: GroupKey
      groupName?: string
      tier: SlaTier | null
      priority: InboxPriority
      reason: SampleSlaReason
    }[] = []
    for (const { senaiteId, lookup } of liveLookups) {
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
      // Samples with zero analyses yield an empty Map — surface them anyway
      // with a single no-group entry so the order aggregator can still place
      // a cell for the sample (preserves the pre-multi-tier behavior where
      // an analyses-less sample still got a default-tier verdict).
      if (byGroup.size === 0) {
        out.push({
          senaiteId,
          lookup,
          groupKey: NO_GROUP_KEY,
          groupName: undefined,
          tier: defaultTier,
          priority,
          reason: { tierSource: defaultTier ? 'default' : 'none', unmappedKeywords: [] },
        })
        continue
      }
      for (const [groupKey, { tier, reason }] of byGroup) {
        out.push({
          senaiteId,
          lookup,
          groupKey,
          groupName:
            groupKey !== NO_GROUP_KEY ? groupNameById.get(groupKey) : undefined,
          tier,
          priority,
          reason,
        })
      }
    }
    return out
  }, [
    liveLookups,
    tiersQuery.data,
    groupsQuery.data,
    servicesQuery.data,
    prioOverridesQuery.data,
    prioritiesQuery.data,
  ])

  /** Composite key `${sample_uid}|${groupKey}` so the `/sla/status` response
   *  is unambiguous when the same sample has multiple group entries with
   *  different target_minutes / business_hours_only. */
  function batchKey(uid: string, groupKey: GroupKey): string {
    return `${uid}|${groupKey}`
  }

  const batchItems: SlaStatusRequestItem[] = useMemo(() => {
    const out: SlaStatusRequestItem[] = []
    for (const s of perSampleGroup) {
      if (!s.tier || !s.lookup.sample_uid) continue
      out.push({
        key: batchKey(s.lookup.sample_uid, s.groupKey),
        received_at: s.lookup.date_received,
        target_minutes: s.tier.target_minutes,
        business_hours_only: s.tier.business_hours_only,
      })
    }
    return out
  }, [perSampleGroup])

  // Stable hash that subsumes every input affecting the `/sla/status` payload:
  // composite keys (sample_uid|groupKey), received_at, target_minutes,
  // business_hours_only. Anything that could shift a sample's resolved tier
  // (tiers data, group membership, services, priorities) flows through
  // `batchItems` and thus through this hash. Sorting by key first makes the
  // hash order-independent — reordering sample_results keys hits the cache.
  const batchItemsHash = useMemo(
    () =>
      [...batchItems]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(b => `${b.key}:${b.target_minutes}:${b.business_hours_only ? 1 : 0}:${b.received_at ?? '-'}`)
        .join('|'),
    [batchItems]
  )

  const statusQuery = useQuery({
    queryKey: ['order-sla-status', batchItemsHash],
    queryFn: () => fetchSlaStatuses(batchItems),
    enabled: batchItems.length > 0,
    // Hold the previous batch's result while the new key fetches so isLoading
    // stays false during the transition — prevents OrderSlaCell from flashing
    // to '…' every time a SENAITE sample lookup trickles in and grows the UID set.
    placeholderData: keepPreviousData,
  })

  // Aggregate verdict per order. useMemo, NOT useQuery (sharpening #4).
  const result = useMemo<OrderSlaResult>(() => {
    const statusByKey = new Map<string, SlaStatus>()
    for (const item of statusQuery.data ?? []) {
      if (item.status) statusByKey.set(item.key, item.status)
    }
    const sampleStatusesBySampleId = new Map<string, SampleSlaSnapshot[]>()
    /** Cells (one per (sample, group)) keyed by senaiteId for fast lookup
     *  during order aggregation. */
    const cellsBySampleId = new Map<string, SampleSlaCellState[]>()
    for (const s of perSampleGroup) {
      const uid = s.lookup.sample_uid
      const key = uid ? batchKey(uid, s.groupKey) : null
      const status = key ? (statusByKey.get(key) ?? null) : null
      const color = status && s.tier ? classifySampleColor(status, s.tier) : null

      const cell: SampleSlaCellState = {
        senaiteId: s.senaiteId,
        tier: s.tier,
        lookup: s.lookup,
        status,
        color,
        reason: s.reason,
        // Multi-tier follow-on — surface the (sample, group) identity on the
        // cell so the order verdict's driving cell can carry its group name
        // to the tooltip.
        groupKey: s.groupKey,
        groupName: s.groupName,
      }
      const cells = cellsBySampleId.get(s.senaiteId) ?? []
      cells.push(cell)
      cellsBySampleId.set(s.senaiteId, cells)

      if (uid && status && s.tier && color) {
        const snapshots = sampleStatusesBySampleId.get(s.senaiteId) ?? []
        snapshots.push({
          groupKey: s.groupKey,
          groupName: s.groupName,
          status,
          color,
          tier: s.tier,
          reason: s.reason,
          priority: s.priority,
        })
        sampleStatusesBySampleId.set(s.senaiteId, snapshots)
      }
    }

    const cellByOrderId = new Map<string | number, SampleSlaCellState[]>()
    for (const order of orders) {
      const cells: SampleSlaCellState[] = []
      // D2 follow-on (cold-load flicker fix): when ANY non-failed sample lookup
      // for this order is still in-flight, omit the order from verdictByOrderId
      // so OrderSlaCell keeps rendering the loading dot. Otherwise the verdict
      // briefly resolves to "awaiting" (empty cells[] → aggregator default) and
      // then flips to the real color a beat later when the lookup lands —
      // exactly the cold-load flash the user reported in the table view.
      let anyLookupPending = false
      if (order.sample_results) {
        for (const entry of Object.values(order.sample_results)) {
          if (!entry.senaite_id || entry.status === 'failed') continue
          const lq = sampleLookupMap.get(entry.senaite_id)
          if (lq?.isLoading) {
            anyLookupPending = true
            continue
          }
          if (!lq?.data) continue
          const sampleCells = cellsBySampleId.get(entry.senaite_id) ?? []
          if (sampleCells.length === 0) {
            // The sample is loaded but produced no resolver buckets (e.g.
            // published, no date_received, or filtered upstream). Surface a
            // null-tier placeholder cell so the aggregator can still consider
            // the sample in worst-color / driver selection — matches the
            // pre-multi-tier behavior.
            cells.push({
              senaiteId: entry.senaite_id,
              tier: null,
              lookup: lq.data,
              status: null,
              color: null,
              reason: null,
            })
          } else {
            for (const c of sampleCells) cells.push(c)
          }
        }
      }
      if (anyLookupPending) continue
      // Orders with null sample_results (failed-integration / pre-pipeline) fall
      // through with an empty cells[] → aggregator returns { color: 'awaiting' }
      // instead of being absent from verdictByOrderId (which would render as
      // eternal "Loading SLA…" in OrderSlaCell).
      cellByOrderId.set(order.order_id, cells)
    }
    const verdictByOrderId = new Map<string | number, OrderSlaVerdict>()
    for (const [orderId, cells] of cellByOrderId) {
      verdictByOrderId.set(orderId, aggregateOrderSlaVerdict(cells))
    }
    return {
      verdictByOrderId,
      sampleStatusesBySampleId,
      isLoading:
        tiersQuery.isLoading ||
        groupsQuery.isLoading ||
        servicesQuery.isLoading ||
        prioOverridesQuery.isLoading ||
        prioritiesQuery.isLoading ||
        (batchItems.length > 0 && statusQuery.isLoading),
      isError:
        tiersQuery.isError ||
        groupsQuery.isError ||
        servicesQuery.isError ||
        prioOverridesQuery.isError ||
        prioritiesQuery.isError ||
        statusQuery.isError,
    }
  }, [
    orders,
    sampleLookupMap,
    perSampleGroup,
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

  return result
}
