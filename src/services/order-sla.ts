import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
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
  resolveSampleTier,
  type OrderSlaVerdict,
  type SampleSlaCellState,
  type SlaColor,
} from '@/lib/sla-resolution'
import { useAnalysisServices } from '@/services/analysis-services'
import { useSamplePriorities, sortedUidsHash } from '@/services/sample-priorities'
import { useServiceGroups } from '@/services/service-groups'
import { useSlaTiers, useSlaPriorityTiers } from '@/services/sla'

export interface SampleSlaSnapshot {
  status: SlaStatus
  color: SlaColor
  tier: SlaTier
}

export interface OrderSlaResult {
  verdictByOrderId: Map<string | number, OrderSlaVerdict>
  sampleStatusBySampleId: Map<string, SampleSlaSnapshot>
  isLoading: boolean
  isError: boolean
}

function makeTierConfigHash(
  tiers: SlaTier[],
  priorityRows: { priority: string; sla_tier_id: number }[]
): string {
  const tierPart = [...tiers]
    .sort((a, b) => a.id - b.id)
    .map(t => `${t.id}:${t.target_minutes}:${t.amber_threshold_percent}:${t.is_default ? 1 : 0}:${t.business_hours_only ? 1 : 0}`)
    .join(',')
  const prioPart = [...priorityRows]
    .sort((a, b) => a.priority.localeCompare(b.priority))
    .map(p => `${p.priority}:${p.sla_tier_id}`)
    .join(',')
  return `tiers=${tierPart}|prio=${prioPart}`
}

function makeReceivedAtHash(
  receivedByUid: Map<string, string | null>
): string {
  return [...receivedByUid.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([uid, ts]) => `${uid}:${ts ?? '-'}`)
    .join('|')
}

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

  const sortedUids = useMemo(() => sortedUidsHash(sampleUids), [sampleUids])
  const receivedAtHash = useMemo(() => {
    const m = new Map<string, string | null>()
    for (const l of liveLookups) {
      if (l.lookup.sample_uid) m.set(l.lookup.sample_uid, l.lookup.date_received)
    }
    return makeReceivedAtHash(m)
  }, [liveLookups])
  const tierConfigHash = useMemo(
    () => makeTierConfigHash(tiersQuery.data ?? [], prioOverridesQuery.data ?? []),
    [tiersQuery.data, prioOverridesQuery.data]
  )

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
      if (t) priorityToTier.set(row.priority as InboxPriority, t)
    }
    const prioByUid = new Map<string, InboxPriority>()
    for (const row of prioritiesQuery.data ?? []) {
      prioByUid.set(row.sample_uid, row.priority)
    }
    return liveLookups.map(({ senaiteId, lookup }) => {
      const priority: InboxPriority =
        (lookup.sample_uid && prioByUid.get(lookup.sample_uid)) || 'normal'
      const tier = resolveSampleTier(
        { analyses: lookup.analyses, priority },
        keywordToServiceId,
        serviceToGroupTier,
        priorityToTier,
        defaultTier
      )
      return { senaiteId, lookup, tier, priority }
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

  const statusQuery = useQuery({
    queryKey: ['order-sla-status', sortedUids, receivedAtHash, tierConfigHash],
    queryFn: () => fetchSlaStatuses(batchItems),
    enabled: batchItems.length > 0,
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
    for (const s of perSample) {
      sampleTierById.set(s.senaiteId, s.tier)
      const uid = s.lookup.sample_uid
      const status = uid ? (statusByKey.get(uid) ?? null) : null
      const color =
        status && s.tier ? classifySampleColor(status, s.tier) : null
      if (uid && status && s.tier && color) {
        sampleStatusBySampleId.set(s.senaiteId, { status, color, tier: s.tier })
      }
    }
    for (const order of orders) {
      if (!order.sample_results) continue
      const cells: SampleSlaCellState[] = []
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
        })
      }
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
