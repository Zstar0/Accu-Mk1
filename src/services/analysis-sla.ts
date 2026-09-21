import { useMemo } from 'react'
import type { SenaiteLookupResult } from '@/lib/api'
import {
  analysisSlaKey,
  buildKeywordToServiceIdMap,
  serviceIdOfAnalysis,
  buildServiceIdToGroupIdMap,
  buildServiceToProfileTierMap,
  NO_GROUP_KEY,
  profileBucketKey,
  type GroupKey,
} from '@/lib/sla-resolution'
import { useAnalysisProfiles } from '@/services/analysis-profiles'
import { useAnalysisServices } from '@/services/analysis-services'
import { useServiceGroups } from '@/services/service-groups'
import { useSlaTiers } from '@/services/sla'
import { useSampleSla } from '@/services/sample-sla'
import type { SampleSlaSnapshot } from '@/services/order-sla'

export interface AnalysisSlaMapResult {
  /** Per-analysis snapshot for the resolved service-group bucket, keyed by
   *  analysisSlaKey(row): the row's service id, keyword only for rows without
   *  one. Empty when SLA isn't applicable (no lookup, no date_received) or
   *  while underlying queries are still loading. */
  byAnalysis: Map<string, SampleSlaSnapshot>
  isLoading: boolean
  isError: boolean
  isPublished: boolean
  /** Effective priority KEY that fed tier resolution ('default' when none). */
  priority: string | null
}

/**
 * Per-keyword SLA snapshot map for the Sample Details analyses table.
 *
 * Composes `useSampleSla` (per-group snapshots + flags) with the
 * analysis-services and service-groups queries (already shared TanStack cache)
 * to expose a flat map (keyed by analysisSlaKey) that table rows read in O(1).
 *
 * Resolution: analysis.keyword → service.id → group.id → snapshot whose
 * `groupKey === group_id`. An UNGROUPED service on a tiered profile may have
 * its own `profile:<id>` snapshot (see resolveSampleTiersByGroup); when that
 * snapshot exists the row reads it, so a USP 71 line shows the 14-day clock
 * rather than the default. Otherwise unmapped keywords (no service match or
 * service has no group) fall through to the NO_GROUP_KEY snapshot
 * (default-tier bucket) when a default tier is configured, else no entry.
 */
export function useAnalysisSlaMap(
  lookup: SenaiteLookupResult | null | undefined
): AnalysisSlaMapResult {
  const sampleSla = useSampleSla(lookup)
  const servicesQuery = useAnalysisServices()
  const groupsQuery = useServiceGroups()
  const tiersQuery = useSlaTiers()
  const profilesQuery = useAnalysisProfiles()

  const byAnalysis = useMemo(() => {
    const out = new Map<string, SampleSlaSnapshot>()
    if (!lookup || !lookup.date_received) return out
    const services = servicesQuery.data ?? []
    const groups = groupsQuery.data ?? []
    const tiers = tiersQuery.data ?? []
    const tiersById = new Map(tiers.map(t => [t.id, t]))
    const keywordToServiceId = buildKeywordToServiceIdMap(services)
    const serviceIdToGroupId = buildServiceIdToGroupIdMap(groups, tiersById)
    const serviceIdToProfileTier = buildServiceToProfileTierMap(
      profilesQuery.data ?? [],
      tiersById
    )
    const snapshotByGroupKey = new Map<GroupKey, SampleSlaSnapshot>()
    for (const snap of sampleSla.snapshots) {
      snapshotByGroupKey.set(snap.groupKey, snap)
    }
    for (const analysis of lookup.analyses) {
      const kw = analysis.keyword
      if (!kw && analysis.analysis_service_id == null) continue
      const serviceId = serviceIdOfAnalysis(analysis, keywordToServiceId)
      const groupId = serviceId !== undefined ? serviceIdToGroupId.get(serviceId) : undefined
      const groupKey: GroupKey = groupId ?? NO_GROUP_KEY
      // The resolver only splits a per-profile bucket off when it decides to
      // (ungrouped, clock differs, no global override), so ask whether the
      // snapshot EXISTS rather than re-deriving that decision here.
      const profileId =
        groupId == null && serviceId !== undefined
          ? serviceIdToProfileTier.get(serviceId)?.profileId
          : undefined
      const snap =
        (profileId != null
          ? snapshotByGroupKey.get(profileBucketKey(profileId))
          : undefined) ?? snapshotByGroupKey.get(groupKey)
      if (snap) out.set(analysisSlaKey(analysis), snap)
    }
    return out
  }, [
    lookup,
    sampleSla.snapshots,
    servicesQuery.data,
    groupsQuery.data,
    tiersQuery.data,
    profilesQuery.data,
  ])

  // Mirror the byAnalysis gate (and useSampleSla's `applicable` guard): when
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
    byAnalysis,
    isLoading,
    isError,
    isPublished: sampleSla.isPublished,
    priority: sampleSla.priority,
  }
}
