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
  classifySampleColor,
  type SlaColor,
} from '@/lib/sla-resolution'
import { useServiceGroups } from '@/services/service-groups'
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
}

export interface SlaSubjectsResult {
  byKey: Map<string, SlaSubjectSnapshot>
  isLoading: boolean
  isError: boolean
}

/** Resolve ONE subject's tier by precedence:
 *  (priority, groupId) override → global priority override → group own tier → default. */
function resolveSubjectTier(
  subject: SlaSubject,
  groupIdToTier: Map<number, SlaTier>,
  globalPriorityToTier: Map<InboxPriority, SlaTier>,
  perGroupPriorityToTier: Map<string, SlaTier>,
  defaultTier: SlaTier | null
): SlaTier | null {
  if (subject.groupId != null) {
    const perGroup = perGroupPriorityToTier.get(`${subject.priority}|${subject.groupId}`)
    if (perGroup) return perGroup
  }
  const global = globalPriorityToTier.get(subject.priority)
  if (global) return global
  if (subject.groupId != null) {
    const groupTier = groupIdToTier.get(subject.groupId)
    if (groupTier) return groupTier
  }
  return defaultTier
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
 */
export function useSlaForSubjects(subjects: SlaSubject[]): SlaSubjectsResult {
  const tiersQuery = useSlaTiers()
  const prioOverridesQuery = useSlaPriorityTiers()
  const groupsQuery = useServiceGroups()

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
    const perGroupPriorityToTier = buildPerGroupPriorityToTierMap(prio, tiersById)
    const groupNameById = new Map(groups.map(g => [g.id, g.name]))

    const out: { subject: SlaSubject; tier: SlaTier; groupName?: string }[] = []
    for (const subject of subjects) {
      if (!subject.receivedAt) continue
      const tier = resolveSubjectTier(
        subject, groupIdToTier, globalPriorityToTier, perGroupPriorityToTier, defaultTier
      )
      if (!tier) continue
      out.push({
        subject,
        tier,
        groupName: subject.groupId != null ? groupNameById.get(subject.groupId) : undefined,
      })
    }
    return out
  }, [subjects, tiersQuery.data, groupsQuery.data, prioOverridesQuery.data])

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
        .map(b => `${b.key}:${b.target_minutes}:${b.business_hours_only ? 1 : 0}:${b.received_at ?? '-'}:${b.now_override ?? '-'}`)
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
    const applicable = batchItems.length > 0
    const isLoading =
      applicable &&
      (tiersQuery.isLoading ||
        groupsQuery.isLoading ||
        prioOverridesQuery.isLoading ||
        statusQuery.isLoading)
    const isError =
      applicable &&
      (tiersQuery.isError ||
        groupsQuery.isError ||
        prioOverridesQuery.isError ||
        statusQuery.isError)

    const statusByKey = new Map<string, SlaStatus>()
    for (const item of statusQuery.data ?? []) {
      if (item.status) statusByKey.set(item.key, item.status)
    }
    const byKey = new Map<string, SlaSubjectSnapshot>()
    for (const { subject, tier, groupName } of resolved) {
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
      })
    }
    return { byKey, isLoading, isError }
  }, [
    resolved,
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
  ])
}

/** Severity rank for worst-pick. Higher wins. Live-red beats frozen-missed
 *  (an actively-breaching item is more urgent than a closed one). */
function severityRank(s: SlaSubjectSnapshot): number {
  if (!s.isFrozen && s.color === 'red') return 5
  if (s.isFrozen && s.status.breached) return 4 // frozen missed
  if (!s.isFrozen && s.color === 'amber') return 3
  if (!s.isFrozen && s.color === 'green') return 2
  return 1 // frozen met
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
      return s.status.remaining_minutes < worst.status.remaining_minutes ? s : worst
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
