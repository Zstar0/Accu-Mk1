import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  fetchSlaStatuses,
  type InboxPriority,
  type SlaStatus,
  type SlaStatusRequestItem,
  type SlaTier,
} from '@/lib/api'
import {
  buildGroupIdToTierMap,
  buildGlobalPriorityToTierMap,
  buildPerGroupPriorityToTierMap,
  buildKeywordToServiceIdMap,
  buildServiceToProfileTierMap,
  classifySampleColor,
  type SlaColor,
  type SampleSlaReason,
  type ServiceProfileTier,
} from '@/lib/sla-resolution'
import { useServiceGroups } from '@/services/service-groups'
import { useAnalysisServices } from '@/services/analysis-services'
import { useAnalysisProfiles } from '@/services/analysis-profiles'
import { useSlaTiers, useSlaPriorityTiers } from '@/services/sla'

export interface SlaSubject {
  /** Stable unique id — used as the /sla/status batch key and the React key. */
  key: string
  priority: InboxPriority
  /** Service group; null → default-tier fallback. */
  groupId: number | null
  /** SLA clock start. Null → subject is non-applicable (no indicator). */
  receivedAt: string | null
  /** When set, freezes elapsed at this instant (now_override) → met/missed. */
  completedAt?: string | null
  /** Analysis keywords on the subject's row/vial. Enables the profile-SLA
   *  precedence step (Task 11): keyword -> service id -> tightest tiered
   *  ACTIVE profile, which beats the group tier and loses to a priority
   *  override — same chain as the Order Status resolvers. Omitted → the
   *  legacy group-only resolution (profile tiers invisible). */
  keywords?: string[]
}

export interface SlaSubjectSnapshot {
  key: string
  status: SlaStatus
  color: SlaColor
  tier: SlaTier
  priority: InboxPriority
  groupId: number | null
  groupName?: string
  isFrozen: boolean
  /** SLA clock start (received_at) — surfaced as the "Received: ..." first
   *  field in the breakdown tooltip. Carried straight from the subject. */
  receivedAt?: string | null
  /** Which precedence rule set the tier (priority/profile/group/default) —
   *  drives the tooltip's source line ("Profile SLA — {name}", "Default
   *  tier (no priority override, no group match)"), matching Order Status. */
  reason?: SampleSlaReason
}

export interface SlaSubjectsResult {
  byKey: Map<string, SlaSubjectSnapshot>
  isLoading: boolean
  isError: boolean
}

/** Resolve ONE subject's tier by the canonical precedence chain
 *  (kept in lockstep with sla-resolution's resolveSampleTier):
 *  (priority, groupId) override → global priority override → tightest tiered
 *  profile across the subject's keywords (Task 11) → group own tier → default.
 *  The profile maps are null when no subject passed keywords or the
 *  services/profiles catalogs are unavailable — then the step is skipped,
 *  which is exactly the pre-Task-11 behavior. */
function resolveSubjectTier(
  subject: SlaSubject,
  groupIdToTier: Map<number, SlaTier>,
  globalPriorityToTier: Map<InboxPriority, SlaTier>,
  perGroupPriorityToTier: Map<string, SlaTier>,
  defaultTier: SlaTier | null,
  keywordToServiceId: Map<string, number> | null,
  serviceIdToProfileTier: Map<number, ServiceProfileTier> | null
): { tier: SlaTier; reason: SampleSlaReason } | null {
  const unmappedKeywords: string[] = []
  let profileWin: ServiceProfileTier | null = null
  if (
    subject.keywords?.length &&
    keywordToServiceId &&
    serviceIdToProfileTier
  ) {
    for (const kw of subject.keywords) {
      const svcId = keywordToServiceId.get(kw)
      if (svcId == null) {
        unmappedKeywords.push(kw)
        continue
      }
      const cand = serviceIdToProfileTier.get(svcId)
      if (
        cand &&
        (!profileWin ||
          cand.tier.target_minutes < profileWin.tier.target_minutes)
      ) {
        profileWin = cand
      }
    }
  }
  if (subject.groupId != null) {
    const perGroup = perGroupPriorityToTier.get(
      `${subject.priority}|${subject.groupId}`
    )
    if (perGroup) {
      return {
        tier: perGroup,
        reason: {
          tierSource: 'priority',
          priorityUsed: subject.priority,
          priorityScope: 'group',
          unmappedKeywords,
        },
      }
    }
  }
  const global = globalPriorityToTier.get(subject.priority)
  if (global) {
    return {
      tier: global,
      reason: {
        tierSource: 'priority',
        priorityUsed: subject.priority,
        priorityScope: 'global',
        unmappedKeywords,
      },
    }
  }
  if (profileWin) {
    return {
      tier: profileWin.tier,
      reason: {
        tierSource: 'profile',
        profileName: profileWin.profileName,
        unmappedKeywords,
      },
    }
  }
  if (subject.groupId != null) {
    const groupTier = groupIdToTier.get(subject.groupId)
    if (groupTier) {
      return {
        tier: groupTier,
        reason: { tierSource: 'group', unmappedKeywords },
      }
    }
  }
  if (defaultTier) {
    return {
      tier: defaultTier,
      reason: { tierSource: 'default', unmappedKeywords },
    }
  }
  return null
}

/**
 * Resolve a flat list of SLA subjects to per-key snapshots. Reuses the shared
 * tier/priority/service-group caches and runs ONE batched /sla/status keyed by
 * subject.key. Subjects with a null receivedAt or no resolvable tier are
 * skipped. Subjects with a completedAt freeze elapsed at that instant
 * (now_override) and surface as isFrozen snapshots.
 *
 * Surfaces that render many rows should call this ONCE at the list level with
 * the flattened subjects of every row, then slice per row by key.
 *
 * Callers should pass a stable `subjects` reference (e.g. via useMemo) if they
 * key children off `byKey` identity — an inline `.map()` produces a new array
 * every render and will cause unnecessary re-fetches.
 */
export function useSlaForSubjects(subjects: SlaSubject[]): SlaSubjectsResult {
  const tiersQuery = useSlaTiers()
  const prioOverridesQuery = useSlaPriorityTiers()
  const groupsQuery = useServiceGroups()
  // Task 11 catalogs — only consulted (and only gate loading) when a subject
  // actually carries keywords, so keyword-less callers behave exactly as
  // before this step existed.
  const servicesQuery = useAnalysisServices()
  const profilesQuery = useAnalysisProfiles()
  const anyKeywords = subjects.some(s => s.keywords && s.keywords.length > 0)

  /** Subjects that resolve to a real tier AND have a received date — paired
   *  with their resolved tier so batchItems and snapshots share the iteration. */
  const resolved = useMemo(() => {
    const tiers = tiersQuery.data ?? []
    const groups = groupsQuery.data ?? []
    const prio = prioOverridesQuery.data ?? []
    const tiersById = new Map(tiers.map(t => [t.id, t]))
    const defaultTier = tiers.find(t => t.is_default) ?? null
    const groupIdToTier = buildGroupIdToTierMap(groups, tiersById)
    const globalPriorityToTier = buildGlobalPriorityToTierMap(prio, tiersById)
    const perGroupPriorityToTier = buildPerGroupPriorityToTierMap(
      prio,
      tiersById
    )
    const groupNameById = new Map(groups.map(g => [g.id, g.name]))
    // Profile step inputs. Fail-open on catalog fetch error: the step is
    // skipped and subjects fall to group/default resolution rather than the
    // whole surface erroring — profile tiers are an overlay, not a core dep.
    const profileDataReady =
      anyKeywords && servicesQuery.data != null && profilesQuery.data != null
    const keywordToServiceId = profileDataReady
      ? buildKeywordToServiceIdMap(servicesQuery.data ?? [])
      : null
    const serviceIdToProfileTier = profileDataReady
      ? buildServiceToProfileTierMap(profilesQuery.data ?? [], tiersById)
      : null

    const out: {
      subject: SlaSubject
      tier: SlaTier
      groupName?: string
      reason: SampleSlaReason
    }[] = []
    for (const subject of subjects) {
      if (!subject.receivedAt) continue
      const hit = resolveSubjectTier(
        subject,
        groupIdToTier,
        globalPriorityToTier,
        perGroupPriorityToTier,
        defaultTier,
        keywordToServiceId,
        serviceIdToProfileTier
      )
      if (!hit) continue
      out.push({
        subject,
        tier: hit.tier,
        groupName:
          subject.groupId != null
            ? groupNameById.get(subject.groupId)
            : undefined,
        reason: hit.reason,
      })
    }
    return out
  }, [
    subjects,
    anyKeywords,
    tiersQuery.data,
    groupsQuery.data,
    prioOverridesQuery.data,
    servicesQuery.data,
    profilesQuery.data,
  ])

  const batchItems: SlaStatusRequestItem[] = useMemo(
    () =>
      resolved.map(({ subject, tier }) => ({
        key: subject.key,
        received_at: subject.receivedAt,
        target_minutes: tier.target_minutes,
        business_hours_only: tier.business_hours_only,
        now_override: subject.completedAt ?? undefined,
      })),
    [resolved]
  )

  const batchHash = useMemo(
    () =>
      [...batchItems]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(
          b =>
            `${b.key}:${b.target_minutes}:${b.business_hours_only ? 1 : 0}:${b.received_at ?? '-'}:${b.now_override ?? '-'}`
        )
        .join('|'),
    [batchItems]
  )

  const statusQuery = useQuery({
    queryKey: ['sla-subjects-status', batchHash],
    queryFn: () => fetchSlaStatuses(batchItems),
    enabled: batchItems.length > 0,
    placeholderData: keepPreviousData,
  })

  return useMemo<SlaSubjectsResult>(() => {
    const isLoading =
      tiersQuery.isLoading ||
      groupsQuery.isLoading ||
      prioOverridesQuery.isLoading ||
      // Keyword-carrying surfaces wait for the profile catalogs so a usp71
      // subject never flashes its group tier before the profile tier lands.
      // Errors deliberately do NOT gate — the profile step fails open above.
      (anyKeywords && (servicesQuery.isLoading || profilesQuery.isLoading)) ||
      (batchItems.length > 0 && statusQuery.isLoading)
    const isError =
      tiersQuery.isError ||
      groupsQuery.isError ||
      prioOverridesQuery.isError ||
      (batchItems.length > 0 && statusQuery.isError)

    const statusByKey = new Map<string, SlaStatus>()
    for (const item of statusQuery.data ?? []) {
      if (item.status) statusByKey.set(item.key, item.status)
    }
    const byKey = new Map<string, SlaSubjectSnapshot>()
    for (const { subject, tier, groupName, reason } of resolved) {
      const status = statusByKey.get(subject.key)
      if (!status) continue
      byKey.set(subject.key, {
        key: subject.key,
        status,
        color: classifySampleColor(status, tier),
        tier,
        priority: subject.priority,
        groupId: subject.groupId,
        groupName,
        isFrozen: Boolean(subject.completedAt),
        receivedAt: subject.receivedAt,
        reason,
      })
    }
    return { byKey, isLoading, isError }
  }, [
    resolved,
    anyKeywords,
    batchItems.length,
    statusQuery.data,
    statusQuery.isLoading,
    statusQuery.isError,
    tiersQuery.isLoading,
    tiersQuery.isError,
    groupsQuery.isLoading,
    groupsQuery.isError,
    prioOverridesQuery.isLoading,
    prioOverridesQuery.isError,
    servicesQuery.isLoading,
    profilesQuery.isLoading,
  ])
}

/** Severity rank for worst-pick. Higher wins. Live-red beats frozen-missed
 *  (an actively-breaching item is more urgent than a closed one). */
function severityRank(s: SlaSubjectSnapshot): number {
  if (!s.isFrozen && s.color === 'red') return 5
  if (s.isFrozen && s.status.breached) return 4 // frozen missed
  if (!s.isFrozen && s.color === 'amber') return 3
  if (!s.isFrozen && s.color === 'green') return 2
  return 1 // frozen met (frozen-amber falls through here intentionally — no meaningful distinction)
}

/** Worst snapshot for aggregate surfaces. Ties within live-red broken by
 *  most-over (lowest remaining_minutes); within live-amber by least
 *  percent-remaining. Returns null for an empty array. */
export function pickWorstSnapshot(
  snapshots: SlaSubjectSnapshot[]
): SlaSubjectSnapshot | null {
  if (snapshots.length === 0) return null
  return snapshots.reduce((worst, s) => {
    const rs = severityRank(s)
    const rw = severityRank(worst)
    if (rs !== rw) return rs > rw ? s : worst
    if (rs === 5) {
      // live-red tie → most over (lowest remaining)
      return s.status.remaining_minutes < worst.status.remaining_minutes
        ? s
        : worst
    }
    if (rs === 3) {
      // live-amber tie → least percent remaining
      const sp = s.status.remaining_minutes / s.status.target_minutes
      const wp = worst.status.remaining_minutes / worst.status.target_minutes
      return sp < wp ? s : worst
    }
    return worst
  })
}
