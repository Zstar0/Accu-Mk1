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
  buildServiceToGroupTierMap,
  classifySampleColor,
  resolveSampleTierWithReason,
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
  sampleStatusBySampleId: Map<string, SampleSlaSnapshot>
  isLoading: boolean
  isError: boolean
}

/**
 * Composite hook: per-order SLA verdict + per-sample snapshot for the explorer.
 *
 * Wraps 5 cached queries (tiers, priority overrides, service groups, analysis
 * services, sample priorities) and runs ONE batched `/sla/status` POST keyed
 * by a stable hash of the resolved batch items (so re-renders with logically
 * identical inputs hit cache). Aggregation is `useMemo`, NOT another `useQuery`
 * (advisor sharpening #4).
 *
 * @param orders — pages's order list (consumed verbatim for sample_results iteration)
 * @param sampleLookupMap — Map<senaiteId, lookupResult> from the page's senaite
 *   lookup hook. Indirection note: map keys are senaite_ids, but `/sla/status`
 *   batch is keyed by `sample_uid` (we read sample_uid OFF each lookup result).
 * @returns
 *   `verdictByOrderId` — Map<order.order_id, OrderSlaVerdict> for OrderSlaCell.
 *   `sampleStatusBySampleId` — Map<senaiteId, SampleSlaSnapshot> for
 *      SampleSlaIndicator. Only present for received-but-unpublished samples
 *      with non-null tier AND status AND color.
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

  const perSample = useMemo(() => {
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
    return liveLookups.map(({ senaiteId, lookup }) => {
      const priority: InboxPriority =
        (lookup.sample_uid && prioByUid.get(lookup.sample_uid)) || 'normal'
      const { tier, reason } = resolveSampleTierWithReason(
        { analyses: lookup.analyses, priority },
        keywordToServiceId,
        serviceToGroupTier,
        priorityToTier,
        defaultTier
      )
      return { senaiteId, lookup, tier, priority, reason }
    })
  }, [
    liveLookups,
    tiersQuery.data,
    groupsQuery.data,
    servicesQuery.data,
    prioOverridesQuery.data,
    prioritiesQuery.data,
  ])

  const batchItems: SlaStatusRequestItem[] = useMemo(() => {
    const out: SlaStatusRequestItem[] = []
    for (const s of perSample) {
      if (!s.tier || !s.lookup.sample_uid) continue
      out.push({
        key: s.lookup.sample_uid,
        received_at: s.lookup.date_received,
        target_minutes: s.tier.target_minutes,
        business_hours_only: s.tier.business_hours_only,
      })
    }
    return out
  }, [perSample])

  // Stable hash that subsumes every input affecting the `/sla/status` payload:
  // UIDs (key), received_at, target_minutes, business_hours_only. Anything that
  // could shift a sample's resolved tier (tiers data, group membership, services,
  // priorities) flows through `batchItems` and thus through this hash. Sorting
  // by key first makes the hash order-independent — reordering `sample_results`
  // keys hits the cache.
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
    const sampleStatusBySampleId = new Map<string, SampleSlaSnapshot>()
    const cellByOrderId = new Map<string | number, SampleSlaCellState[]>()
    const sampleTierById = new Map<string, SlaTier | null>()
    const sampleReasonById = new Map<string, SampleSlaReason>()
    for (const s of perSample) {
      sampleTierById.set(s.senaiteId, s.tier)
      sampleReasonById.set(s.senaiteId, s.reason)
      const uid = s.lookup.sample_uid
      const status = uid ? (statusByKey.get(uid) ?? null) : null
      const color =
        status && s.tier ? classifySampleColor(status, s.tier) : null
      if (uid && status && s.tier && color) {
        sampleStatusBySampleId.set(s.senaiteId, {
          status,
          color,
          tier: s.tier,
          reason: s.reason,
          priority: s.priority,
        })
      }
    }
    for (const order of orders) {
      const cells: SampleSlaCellState[] = []
      if (order.sample_results) {
        for (const entry of Object.values(order.sample_results)) {
          if (!entry.senaite_id || entry.status === 'failed') continue
          const lq = sampleLookupMap.get(entry.senaite_id)
          if (!lq?.data) continue
          const snap = sampleStatusBySampleId.get(entry.senaite_id)
          cells.push({
            senaiteId: entry.senaite_id,
            tier: sampleTierById.get(entry.senaite_id) ?? null,
            lookup: lq.data,
            status: snap?.status ?? null,
            color: snap?.color ?? null,
            reason: sampleReasonById.get(entry.senaite_id) ?? null,
          })
        }
      }
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
      sampleStatusBySampleId,
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
    perSample,
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
