import { useMemo } from 'react'
import type { InboxPriority, SenaiteLookupResult } from '@/lib/api'
import {
  buildKeywordToServiceIdMap,
  buildServiceIdToGroupIdMap,
  NO_GROUP_KEY,
  type GroupKey,
} from '@/lib/sla-resolution'
import { useAnalysisServices } from '@/services/analysis-services'
import { useServiceGroups } from '@/services/service-groups'
import { useSlaTiers } from '@/services/sla'
import { useSampleSla } from '@/services/sample-sla'
import type { SampleSlaSnapshot } from '@/services/order-sla'

export interface AnalysisSlaMapResult {
  /** Per-keyword snapshot for the resolved service-group bucket. Empty when
   *  SLA isn't applicable (no lookup, no date_received) or while underlying
   *  queries are still loading. */
  byKeyword: Map<string, SampleSlaSnapshot>
  isLoading: boolean
  isError: boolean
  isPublished: boolean
  priority: InboxPriority | null
}

/**
 * Per-keyword SLA snapshot map for the Sample Details analyses table.
 *
 * Composes `useSampleSla` (per-group snapshots + flags) with the
 * analysis-services and service-groups queries (already shared TanStack cache)
 * to expose a flat `Map<keyword, snapshot>` that table rows can read in O(1).
 *
 * Resolution: analysis.keyword → service.id → group.id → snapshot whose
 * `groupKey === group_id`. Unmapped keywords (no service match or service has
 * no group) fall through to the NO_GROUP_KEY snapshot (default-tier bucket)
 * when a default tier is configured; otherwise produce no entry.
 */
export function useAnalysisSlaMap(
  lookup: SenaiteLookupResult | null | undefined
): AnalysisSlaMapResult {
  const sampleSla = useSampleSla(lookup)
  const servicesQuery = useAnalysisServices()
  const groupsQuery = useServiceGroups()
  const tiersQuery = useSlaTiers()

  const byKeyword = useMemo(() => {
    const out = new Map<string, SampleSlaSnapshot>()
    if (!lookup || !lookup.date_received) return out
    const services = servicesQuery.data ?? []
    const groups = groupsQuery.data ?? []
    const tiers = tiersQuery.data ?? []
    const tiersById = new Map(tiers.map(t => [t.id, t]))
    const keywordToServiceId = buildKeywordToServiceIdMap(services)
    const serviceIdToGroupId = buildServiceIdToGroupIdMap(groups, tiersById)
    const snapshotByGroupKey = new Map<GroupKey, SampleSlaSnapshot>()
    for (const snap of sampleSla.snapshots) {
      snapshotByGroupKey.set(snap.groupKey, snap)
    }
    for (const analysis of lookup.analyses) {
      const kw = analysis.keyword
      if (!kw) continue
      const serviceId = keywordToServiceId.get(kw)
      const groupId = serviceId !== undefined ? serviceIdToGroupId.get(serviceId) : undefined
      const groupKey: GroupKey = groupId ?? NO_GROUP_KEY
      const snap = snapshotByGroupKey.get(groupKey)
      if (snap) out.set(kw, snap)
    }
    return out
  }, [
    lookup,
    sampleSla.snapshots,
    servicesQuery.data,
    groupsQuery.data,
    tiersQuery.data,
  ])

  // Mirror the byKeyword gate (and useSampleSla's `applicable` guard): when
  // SLA isn't applicable for this sample, the underlying queries' loading /
  // error states are irrelevant — short-circuit to false so the inapplicable
  // branch never appears "loading" on first render.
  const applicable = Boolean(lookup && lookup.date_received)
  const isLoading =
    applicable &&
    (sampleSla.isLoading ||
      servicesQuery.isLoading ||
      groupsQuery.isLoading ||
      tiersQuery.isLoading)
  const isError =
    applicable &&
    (sampleSla.isError ||
      servicesQuery.isError ||
      groupsQuery.isError ||
      tiersQuery.isError)

  return {
    byKeyword,
    isLoading,
    isError,
    isPublished: sampleSla.isPublished,
    priority: sampleSla.priority,
  }
}
