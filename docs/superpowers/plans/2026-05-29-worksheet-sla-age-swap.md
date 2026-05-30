# Worksheet/Inbox SLA Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded "AGE" field (`AgingTimer`) across all five surfaces that render it with a configured-SLA status indicator driven by a shared `SlaSubject` model, one batched hook, and one compact indicator component.

**Architecture:** A new `useSlaForSubjects(subjects[])` hook resolves each normalized `SlaSubject` `(priority, groupId, receivedAt, completedAt?)` to its tier via the existing precedence helpers and batches one `/sla/status` call. A new `SlaAgeIndicator` renders a single snapshot or the worst of an array in the compact `OrderSlaCell` idiom (live red/amber/green; frozen took/missed once `completedAt` is set). The five call sites map their rows to subjects and drop in the indicator. `AgingTimer.tsx` is left parked, unused.

**Tech Stack:** React 19, TanStack Query, vitest, shadcn/ui Tooltip, react-i18next. No backend, schema, or i18n changes.

**Spec:** `docs/superpowers/specs/2026-05-29-worksheet-sla-age-swap-design.md`

**Worktree:** `C:\tmp\accu-mk1-wave1` — bind-mounted by the `accu-mk1-frontend` container at `:3101`. All edits here. Frontend HMR fires automatically; restart only if HMR misses (`docker restart accu-mk1-frontend`).

**Commit convention:** `feat(sla):` / `fix(sla):` / `refactor(sla):` + brief description. One commit per task. `.planning/STATE.md` ALWAYS stays out of commits. Never include `docs/superpowers/handoffs/`.

**Lint note:** Run scoped ESLint from inside the worktree: `npx eslint <files>` (NOT `npm run lint -- <files>`, which lints the whole project). Pre-existing baseline noise lives in `src/lib/api.ts` and `src/components/OrderStatusPage.tsx` — only flag NEW errors. `Array<T>` is forbidden (use `T[]`). No Zustand destructuring.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/services/sla-subjects.ts` | NEW | `SlaSubject` + `SlaSubjectSnapshot` types, `useSlaForSubjects(subjects)` hook, `pickWorstSnapshot(snapshots)` helper |
| `src/components/hplc/SlaAgeIndicator.tsx` | NEW | Presentational indicator (single snapshot or worst-of-array), `React.memo` structural equality |
| `src/test/sla-subjects.test.tsx` | NEW | Hook + worst-pick tests |
| `src/test/sla-age-indicator.test.tsx` | NEW | Renderer tests |
| `src/components/hplc/WorksheetDrawerItems.tsx` | MODIFY | Replace `AgingTimer` with `SlaAgeIndicator`; 1 subject per item (list-level hook call) |
| `src/components/hplc/WorksheetDropPanel.tsx` | MODIFY | Replace `AgingTimer` with `SlaAgeIndicator`; 1 subject per item |
| `src/components/hplc/WorksheetsListPage.tsx` | MODIFY | Replace the `completed_at ? date : AgingTimer` cell; N subjects per worksheet row, worst aggregate |
| `src/components/hplc/InboxSampleTable.tsx` | MODIFY | Replace `AgingTimer`; N subjects per sample (per group), worst aggregate |
| `src/components/hplc/InboxServiceGroupCard.tsx` | MODIFY | Replace `AgingTimer`; 1 subject from `(sample.priority, group.group_id, sample.date_received)` |

`AgingTimer.tsx` stays unmodified and unused.

**Reference types (already exist, do not redefine):**
- `SlaTier` = `{ id, name, target_minutes, business_hours_only, is_default, amber_threshold_percent, created_at, updated_at }` (`@/lib/api`)
- `SlaStatus` = `{ key, elapsed_minutes, remaining_minutes, target_minutes, breached }` (`@/lib/api`)
- `SlaStatusRequestItem` = `{ key, received_at: string|null, target_minutes, business_hours_only, now_override?: string|null }` (`@/lib/api`)
- `SlaStatusResultItem` = `{ key, status: SlaStatus | null }` (`@/lib/api`)
- `InboxPriority` = `'normal' | 'high' | 'expedited'` (`@/lib/api`)
- `SlaColor` = `'red' | 'amber' | 'green'` (`@/lib/sla-resolution`)
- `classifySampleColor(status: SlaStatus, tier: SlaTier): SlaColor` (`@/lib/sla-resolution`)
- `buildGroupIdToTierMap`, `buildGlobalPriorityToTierMap`, `buildPerGroupPriorityToTierMap` (`@/lib/sla-resolution`)
- `fetchSlaStatuses(items: SlaStatusRequestItem[]): Promise<SlaStatusResultItem[]>` (`@/lib/api`)
- `useSlaTiers()`, `useSlaPriorityTiers()` (`@/services/sla`); `useServiceGroups()` (`@/services/service-groups`)
- `SlaBreakdownTooltip` props: `{ tier, status, reason: SampleSlaReason|null, priority?, drivingSampleId?, groupName?, isPublished? }` (`@/components/explorer/SlaBreakdownTooltip`)
- `SampleSlaReason` = `{ tierSource: 'priority'|'group'|'default'|'none', priorityUsed?, priorityScope?, unmappedKeywords: string[], multiGroupCandidates?, priorityGroupName? }` (`@/lib/sla-resolution`)

---

## Task 1 — Hook + worst-pick: `useSlaForSubjects` / `pickWorstSnapshot` (TDD)

**Files:**
- Create: `src/services/sla-subjects.ts`
- Test: `src/test/sla-subjects.test.tsx`

### Step 1.1 — Write the failing tests

- [ ] Create `src/test/sla-subjects.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type * as ApiModule from '@/lib/api'
import type { SlaStatusRequestItem, SlaStatusResultItem } from '@/lib/api'

const fetchSlaStatusesMock =
  vi.fn<(items: SlaStatusRequestItem[]) => Promise<SlaStatusResultItem[]>>()
const getServiceGroupsMock = vi.fn()
const getSlaTiersMock = vi.fn()
const getSlaPriorityTiersMock = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api')
  return {
    ...actual,
    fetchSlaStatuses: (items: SlaStatusRequestItem[]) => fetchSlaStatusesMock(items),
    getServiceGroups: () => getServiceGroupsMock(),
    getSlaTiers: () => getSlaTiersMock(),
    getSlaPriorityTiers: () => getSlaPriorityTiersMock(),
  }
})

const { useSlaForSubjects, pickWorstSnapshot } = await import('@/services/sla-subjects')
import type { SlaSubject, SlaSubjectSnapshot } from '@/services/sla-subjects'

function Wrapper({ children }: { children: React.ReactNode }) {
  const [qc] = React.useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  )
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const DEFAULT_TIER = {
  id: 1, name: 'Default', target_minutes: 1440, business_hours_only: false,
  is_default: true, amber_threshold_percent: 80,
  created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
}
const HPLC_TIER = {
  id: 2, name: 'HPLC fast', target_minutes: 240, business_hours_only: false,
  is_default: false, amber_threshold_percent: 80,
  created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
}
const RUSH_TIER = {
  id: 3, name: 'Rush', target_minutes: 120, business_hours_only: false,
  is_default: false, amber_threshold_percent: 80,
  created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
}

beforeEach(() => {
  fetchSlaStatusesMock.mockReset().mockResolvedValue([])
  getServiceGroupsMock.mockReset().mockResolvedValue([
    { id: 100, name: 'HPLC', sla_tier_id: 2, member_ids: [10, 11] },
  ])
  getSlaTiersMock.mockReset().mockResolvedValue([DEFAULT_TIER, HPLC_TIER, RUSH_TIER])
  getSlaPriorityTiersMock.mockReset().mockResolvedValue([])
})

function snap(over: Partial<SlaSubjectSnapshot>): SlaSubjectSnapshot {
  return {
    key: 'k',
    status: { key: 'k', elapsed_minutes: 60, remaining_minutes: 180, target_minutes: 240, breached: false },
    color: 'green',
    tier: HPLC_TIER,
    priority: 'normal',
    groupId: 100,
    isFrozen: false,
    ...over,
  } as SlaSubjectSnapshot
}

describe('useSlaForSubjects', () => {
  it('returns empty byKey + no fetch for empty subjects', async () => {
    const { result } = renderHook(() => useSlaForSubjects([]), { wrapper: Wrapper })
    await waitFor(() => {
      expect(result.current.byKey.size).toBe(0)
      expect(result.current.isLoading).toBe(false)
    })
    expect(fetchSlaStatusesMock).not.toHaveBeenCalled()
  })

  it('resolves a subject to its group own tier', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      { key: 's1', status: { key: 's1', elapsed_minutes: 60, remaining_minutes: 180, target_minutes: 240, breached: false } },
    ])
    const subjects: SlaSubject[] = [
      { key: 's1', priority: 'normal', groupId: 100, receivedAt: '2026-01-01T09:00:00' },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.byKey.size).toBe(1))
    expect(result.current.byKey.get('s1')?.tier.id).toBe(2)
    expect(result.current.byKey.get('s1')?.groupName).toBe('HPLC')
  })

  it('global priority override beats the group tier', async () => {
    getSlaPriorityTiersMock.mockResolvedValue([{ priority: 'expedited', sla_tier_id: 3, service_group_id: null }])
    fetchSlaStatusesMock.mockResolvedValue([
      { key: 's1', status: { key: 's1', elapsed_minutes: 10, remaining_minutes: 110, target_minutes: 120, breached: false } },
    ])
    const subjects: SlaSubject[] = [
      { key: 's1', priority: 'expedited', groupId: 100, receivedAt: '2026-01-01T09:00:00' },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.byKey.size).toBe(1))
    expect(result.current.byKey.get('s1')?.tier.id).toBe(3) // RUSH, not HPLC
  })

  it('per-(priority, group) override beats the global override', async () => {
    getSlaPriorityTiersMock.mockResolvedValue([
      { priority: 'expedited', sla_tier_id: 3, service_group_id: null },   // global → RUSH
      { priority: 'expedited', sla_tier_id: 1, service_group_id: 100 },    // per-group → DEFAULT
    ])
    fetchSlaStatusesMock.mockResolvedValue([
      { key: 's1', status: { key: 's1', elapsed_minutes: 10, remaining_minutes: 1430, target_minutes: 1440, breached: false } },
    ])
    const subjects: SlaSubject[] = [
      { key: 's1', priority: 'expedited', groupId: 100, receivedAt: '2026-01-01T09:00:00' },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.byKey.size).toBe(1))
    expect(result.current.byKey.get('s1')?.tier.id).toBe(1) // per-group DEFAULT wins
  })

  it('null groupId resolves the default tier; no default → no snapshot', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      { key: 's1', status: { key: 's1', elapsed_minutes: 10, remaining_minutes: 1430, target_minutes: 1440, breached: false } },
    ])
    const subjects: SlaSubject[] = [
      { key: 's1', priority: 'normal', groupId: null, receivedAt: '2026-01-01T09:00:00' },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.byKey.get('s1')?.tier.id).toBe(1))

    // No default tier configured → subject yields no snapshot.
    getSlaTiersMock.mockResolvedValue([HPLC_TIER]) // no is_default
    const { result: r2 } = renderHook(() => useSlaForSubjects(subjects), { wrapper: Wrapper })
    await waitFor(() => expect(r2.current.isLoading).toBe(false))
    expect(r2.current.byKey.has('s1')).toBe(false)
  })

  it('null receivedAt → no batch item, no snapshot', async () => {
    const subjects: SlaSubject[] = [
      { key: 's1', priority: 'normal', groupId: 100, receivedAt: null },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.byKey.has('s1')).toBe(false)
    expect(fetchSlaStatusesMock).not.toHaveBeenCalled()
  })

  it('completedAt sets now_override and marks snapshot frozen', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      { key: 's1', status: { key: 's1', elapsed_minutes: 200, remaining_minutes: 40, target_minutes: 240, breached: false } },
    ])
    const subjects: SlaSubject[] = [
      { key: 's1', priority: 'normal', groupId: 100, receivedAt: '2026-01-01T09:00:00', completedAt: '2026-01-01T12:20:00' },
    ]
    const { result } = renderHook(() => useSlaForSubjects(subjects), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.byKey.size).toBe(1))
    expect(result.current.byKey.get('s1')?.isFrozen).toBe(true)
    const sentItems = fetchSlaStatusesMock.mock.calls[0]![0]
    expect(sentItems[0]!.now_override).toBe('2026-01-01T12:20:00')
  })
})

describe('pickWorstSnapshot', () => {
  it('returns null for empty array', () => {
    expect(pickWorstSnapshot([])).toBeNull()
  })

  it('ranks live-red over frozen-missed over live-amber over live-green over frozen-met', () => {
    const liveRed = snap({ key: 'red', color: 'red', status: { key: 'red', elapsed_minutes: 300, remaining_minutes: -60, target_minutes: 240, breached: true } })
    const frozenMissed = snap({ key: 'fm', isFrozen: true, color: 'red', status: { key: 'fm', elapsed_minutes: 300, remaining_minutes: -60, target_minutes: 240, breached: true } })
    const liveAmber = snap({ key: 'amb', color: 'amber', status: { key: 'amb', elapsed_minutes: 210, remaining_minutes: 30, target_minutes: 240, breached: false } })
    const liveGreen = snap({ key: 'grn', color: 'green' })
    const frozenMet = snap({ key: 'met', isFrozen: true, color: 'green', status: { key: 'met', elapsed_minutes: 100, remaining_minutes: 140, target_minutes: 240, breached: false } })

    expect(pickWorstSnapshot([frozenMet, liveGreen, liveAmber, frozenMissed, liveRed])?.key).toBe('red')
    expect(pickWorstSnapshot([frozenMet, liveGreen, liveAmber, frozenMissed])?.key).toBe('fm')
    expect(pickWorstSnapshot([frozenMet, liveGreen, liveAmber])?.key).toBe('amb')
    expect(pickWorstSnapshot([frozenMet, liveGreen])?.key).toBe('grn')
    expect(pickWorstSnapshot([frozenMet])?.key).toBe('met')
  })

  it('breaks live-red ties by most-over (lowest remaining_minutes)', () => {
    const a = snap({ key: 'a', color: 'red', status: { key: 'a', elapsed_minutes: 300, remaining_minutes: -60, target_minutes: 240, breached: true } })
    const b = snap({ key: 'b', color: 'red', status: { key: 'b', elapsed_minutes: 360, remaining_minutes: -120, target_minutes: 240, breached: true } })
    expect(pickWorstSnapshot([a, b])?.key).toBe('b')
  })
})
```

### Step 1.2 — Run tests to verify they fail

Run:
```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-subjects.test.tsx'
```
Expected: FAIL — `Cannot find module '@/services/sla-subjects'`.

### Step 1.3 — Implement `sla-subjects.ts`

- [ ] Create `src/services/sla-subjects.ts`:

```ts
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
```

### Step 1.4 — Run tests to verify they pass

Run:
```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-subjects.test.tsx'
```
Expected: PASS (10 tests).

### Step 1.5 — Scoped lint + typecheck

```bash
npx eslint src/services/sla-subjects.ts src/test/sla-subjects.test.tsx
npm run typecheck
```
Run both from inside `C:\tmp\accu-mk1-wave1`. Expected: clean.

### Step 1.6 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add src/services/sla-subjects.ts src/test/sla-subjects.test.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): useSlaForSubjects hook + pickWorstSnapshot for subject-based SLA"
```

---

## Task 2 — Indicator: `SlaAgeIndicator` (TDD)

**Files:**
- Create: `src/components/hplc/SlaAgeIndicator.tsx`
- Test: `src/test/sla-age-indicator.test.tsx`

### Step 2.1 — Write the failing tests

- [ ] Create `src/test/sla-age-indicator.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n/config'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SlaSubjectSnapshot } from '@/services/sla-subjects'
import { SlaAgeIndicator } from '@/components/hplc/SlaAgeIndicator'

const TIER = {
  id: 2, name: 'HPLC fast', target_minutes: 240, business_hours_only: false,
  is_default: false, amber_threshold_percent: 80,
  created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00',
}

function snap(over: Partial<SlaSubjectSnapshot> = {}): SlaSubjectSnapshot {
  return {
    key: 'k',
    status: { key: 'k', elapsed_minutes: 60, remaining_minutes: 180, target_minutes: 240, breached: false },
    color: 'green',
    tier: TIER,
    priority: 'normal',
    groupId: 100,
    groupName: 'HPLC',
    isFrozen: false,
    ...over,
  } as SlaSubjectSnapshot
}

function wrap(node: React.ReactNode) {
  return (
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>{node}</TooltipProvider>
    </I18nextProvider>
  )
}

describe('SlaAgeIndicator', () => {
  it('renders green dot for live green snapshot', () => {
    render(wrap(<SlaAgeIndicator snapshot={snap({ color: 'green' })} isLoading={false} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'green')
  })

  it('renders amber dot for live amber snapshot', () => {
    render(wrap(<SlaAgeIndicator snapshot={snap({ color: 'amber', status: { key: 'k', elapsed_minutes: 200, remaining_minutes: 40, target_minutes: 240, breached: false } })} isLoading={false} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'amber')
  })

  it('renders red for live breached snapshot', () => {
    render(wrap(<SlaAgeIndicator snapshot={snap({ color: 'red', status: { key: 'k', elapsed_minutes: 360, remaining_minutes: -120, target_minutes: 240, breached: true } })} isLoading={false} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'red')
  })

  it('renders met for frozen non-breached snapshot', () => {
    render(wrap(<SlaAgeIndicator snapshot={snap({ isFrozen: true, color: 'green', status: { key: 'k', elapsed_minutes: 180, remaining_minutes: 60, target_minutes: 240, breached: false } })} isLoading={false} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'met')
  })

  it('renders missed for frozen breached snapshot', () => {
    render(wrap(<SlaAgeIndicator snapshot={snap({ isFrozen: true, color: 'red', status: { key: 'k', elapsed_minutes: 600, remaining_minutes: -360, target_minutes: 240, breached: true } })} isLoading={false} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'missed')
  })

  it('renders loading and error and empty states', () => {
    const { rerender } = render(wrap(<SlaAgeIndicator snapshot={null} isLoading={true} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'loading')
    rerender(wrap(<SlaAgeIndicator snapshot={null} isLoading={false} isError={true} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'error')
    rerender(wrap(<SlaAgeIndicator snapshot={null} isLoading={false} isError={false} compact />))
    const cell = screen.getByTestId('sla-age-indicator')
    expect(cell).toHaveAttribute('data-sla-color', 'none')
    expect(cell.textContent).toContain('—')
  })

  it('renders the worst snapshot from a snapshots array', () => {
    const green = snap({ key: 'g', color: 'green' })
    const red = snap({ key: 'r', color: 'red', status: { key: 'r', elapsed_minutes: 360, remaining_minutes: -120, target_minutes: 240, breached: true } })
    render(wrap(<SlaAgeIndicator snapshots={[green, red]} isLoading={false} isError={false} compact />))
    expect(screen.getByTestId('sla-age-indicator')).toHaveAttribute('data-sla-color', 'red')
  })

  it('shows fuller "left" text when not compact', () => {
    render(wrap(<SlaAgeIndicator snapshot={snap({ color: 'green' })} isLoading={false} isError={false} />))
    expect(screen.getByTestId('sla-age-indicator').textContent).toMatch(/left/i)
  })
})
```

### Step 2.2 — Run tests to verify they fail

Run:
```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-age-indicator.test.tsx'
```
Expected: FAIL — `Cannot find module '@/components/hplc/SlaAgeIndicator'`.

### Step 2.3 — Implement `SlaAgeIndicator.tsx`

- [ ] Create `src/components/hplc/SlaAgeIndicator.tsx`:

```tsx
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { formatMinutes } from '@/lib/sla-format'
import type { SlaSubjectSnapshot } from '@/services/sla-subjects'
import { pickWorstSnapshot } from '@/services/sla-subjects'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SlaBreakdownTooltip } from '@/components/explorer/SlaBreakdownTooltip'

type CellColor = 'red' | 'amber' | 'green' | 'met' | 'missed' | 'loading' | 'error' | 'none'

const COLOR_CLASS: Record<CellColor, string> = {
  red: 'text-red-500',
  amber: 'text-amber-500',
  green: 'text-green-600',
  met: 'text-muted-foreground',
  missed: 'text-red-500',
  loading: 'text-muted-foreground',
  error: 'text-muted-foreground',
  none: 'text-muted-foreground',
}

const DOT: Record<CellColor, string> = {
  red: '●', amber: '●', green: '●',
  met: '✓', missed: '—', loading: '…', error: '—', none: '—',
}

interface SlaAgeIndicatorProps {
  snapshot?: SlaSubjectSnapshot | null
  snapshots?: SlaSubjectSnapshot[]
  isLoading: boolean
  isError: boolean
  compact?: boolean
}

function pickColor(snap: SlaSubjectSnapshot | null, isLoading: boolean, isError: boolean): CellColor {
  if (isLoading) return 'loading'
  if (isError) return 'error'
  if (!snap) return 'none'
  if (snap.isFrozen) return snap.status.breached ? 'missed' : 'met'
  return snap.color
}

function SlaAgeIndicatorImpl(props: SlaAgeIndicatorProps) {
  const { t } = useTranslation()
  const snap = props.snapshot ?? pickWorstSnapshot(props.snapshots ?? [])
  const color = pickColor(snap, props.isLoading, props.isError)
  const className = COLOR_CLASS[color]
  const dot = DOT[color]
  const compact = props.compact ?? false

  let text = ''
  let titleAttr: string | undefined
  if (snap && color === 'red') {
    const over = formatMinutes(Math.abs(snap.status.remaining_minutes))
    text = compact ? `−${over}` : t('orderStatus.sla.over', { time: over })
  } else if (snap && (color === 'amber' || color === 'green')) {
    const left = formatMinutes(snap.status.remaining_minutes)
    text = compact ? left : t('orderStatus.sla.left', { time: left })
  } else if (snap && color === 'met') {
    const took = formatMinutes(snap.status.elapsed_minutes)
    text = compact ? took : t('orderStatus.sla.publishedTook', { time: took })
  } else if (snap && color === 'missed') {
    const by = formatMinutes(Math.abs(snap.status.remaining_minutes))
    text = compact ? `−${by}` : t('orderStatus.sla.missedBy', { time: by })
  } else if (color === 'loading') {
    titleAttr = t('orderStatus.sla.loading')
  } else if (color === 'error') {
    titleAttr = t('orderStatus.sla.unavailable')
  } else {
    text = '—'
    titleAttr = t('orderStatus.sla.noTierConfigured')
  }

  const hasBreakdown = !props.isLoading && !props.isError && snap !== null
  const sizeClass = compact ? 'text-[10px]' : 'text-sm'

  const cell = (
    <span
      data-testid="sla-age-indicator"
      data-sla-color={color}
      className={cn('inline-flex items-center gap-1 font-mono tabular-nums', sizeClass, className)}
      title={hasBreakdown ? undefined : titleAttr}
    >
      <span aria-hidden="true">{dot}</span>
      {text && <span>{text}</span>}
      {!text && titleAttr && <span className="sr-only">{titleAttr}</span>}
    </span>
  )

  if (hasBreakdown && snap) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{cell}</TooltipTrigger>
        <TooltipContent className="p-0 max-w-md">
          <SlaBreakdownTooltip
            tier={snap.tier}
            status={snap.status}
            reason={null}
            priority={snap.priority}
            groupName={snap.groupName}
            isPublished={snap.isFrozen}
          />
        </TooltipContent>
      </Tooltip>
    )
  }
  return cell
}

/** Structural equality on the effective snapshot's visually-meaningful fields —
 *  same anti-flicker pattern as OrderSlaCell. */
function propsEqual(prev: SlaAgeIndicatorProps, next: SlaAgeIndicatorProps): boolean {
  if (prev.isLoading !== next.isLoading) return false
  if (prev.isError !== next.isError) return false
  if ((prev.compact ?? false) !== (next.compact ?? false)) return false
  const a = prev.snapshot ?? pickWorstSnapshot(prev.snapshots ?? [])
  const b = next.snapshot ?? pickWorstSnapshot(next.snapshots ?? [])
  if (a === b) return true
  if (a === null || b === null) return false
  if (a.color !== b.color) return false
  if (a.isFrozen !== b.isFrozen) return false
  if ((a.groupId ?? null) !== (b.groupId ?? null)) return false
  if ((a.groupName ?? null) !== (b.groupName ?? null)) return false
  if (a.priority !== b.priority) return false
  if ((a.tier?.id ?? null) !== (b.tier?.id ?? null)) return false
  if ((a.tier?.target_minutes ?? null) !== (b.tier?.target_minutes ?? null)) return false
  if ((a.tier?.amber_threshold_percent ?? null) !== (b.tier?.amber_threshold_percent ?? null)) return false
  if ((a.tier?.business_hours_only ?? null) !== (b.tier?.business_hours_only ?? null)) return false
  if (a.status.elapsed_minutes !== b.status.elapsed_minutes) return false
  if (a.status.remaining_minutes !== b.status.remaining_minutes) return false
  if (a.status.breached !== b.status.breached) return false
  return true
}

export const SlaAgeIndicator = memo(SlaAgeIndicatorImpl, propsEqual)
```

Note: `reason={null}` is passed to `SlaBreakdownTooltip` — the worksheet/inbox surfaces don't carry the analysis-keyword reason chain, and the tooltip renders fine without a reason line (it falls back to the tier/target/elapsed/remaining lines). `isPublished={snap.isFrozen}` reuses the tooltip's historical-mode rendering for frozen subjects.

### Step 2.4 — Run tests to verify they pass

Run:
```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-age-indicator.test.tsx'
```
Expected: PASS (8 tests).

### Step 2.5 — Scoped lint + typecheck

```bash
npx eslint src/components/hplc/SlaAgeIndicator.tsx src/test/sla-age-indicator.test.tsx
npm run typecheck
```
Run from inside the worktree. Expected: clean.

### Step 2.6 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/hplc/SlaAgeIndicator.tsx src/test/sla-age-indicator.test.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): SlaAgeIndicator compact per-subject SLA indicator"
```

---

## Task 3 — Swap single-group surfaces: drawer, drop panel, inbox card

**Files:**
- Modify: `src/components/hplc/WorksheetDrawerItems.tsx`
- Modify: `src/components/hplc/WorksheetDropPanel.tsx`
- Modify: `src/components/hplc/InboxServiceGroupCard.tsx`

These three render a single `(sample, group)` per indicator. Each builds ONE subject. Because the drawer and drop panel render a LIST of items, call `useSlaForSubjects` ONCE at the list-component level over all items, then look up per row by key.

### Step 3.1 — WorksheetDrawerItems: add the hook at list level

First inspect the file to find the list component that maps items and the `SortableItemRow` that renders `AgingTimer` at ~line 316:
```bash
grep -n "AgingTimer\|function SortableItemRow\|\.map(\|export function WorksheetDrawerItems\|items\b" /c/tmp/accu-mk1-wave1/src/components/hplc/WorksheetDrawerItems.tsx | head -30
```

- [ ] In `WorksheetDrawerItems.tsx`, replace the import:
```ts
import { AgingTimer } from '@/components/hplc/AgingTimer'
```
with:
```ts
import { SlaAgeIndicator } from '@/components/hplc/SlaAgeIndicator'
import { useSlaForSubjects, type SlaSubject } from '@/services/sla-subjects'
import type { InboxPriority } from '@/lib/api'
```

- [ ] In the `WorksheetDrawerItems` component body (the one that receives the `items` array and the worksheet), build subjects and call the hook. The component receives the worksheet's items; it also needs the worksheet's `completed_at` and `status` to freeze. Add near the top of the component body, after props are destructured:
```ts
const worksheetCompletedAt =
  worksheetStatus === 'complete' ? (worksheetCompletedAtProp ?? null) : null
const slaSubjects: SlaSubject[] = items.map(item => ({
  key: String(item.id),
  priority: (item.priority as InboxPriority) || 'normal',
  groupId: item.service_group_id,
  receivedAt: item.date_received ?? item.added_at,
  completedAt: worksheetCompletedAt,
}))
const { byKey: slaByKey, isLoading: slaLoading, isError: slaError } =
  useSlaForSubjects(slaSubjects)
```

**Context note for the implementer:** `WorksheetDrawerItems` is passed the worksheet's items via props. Determine the exact prop names for the worksheet status + completion timestamp by reading `WorksheetDrawerItemsProps` (interface near line 53) and the parent `WorksheetDrawer.tsx`. If a `completed_at`/`status` is not already passed into `WorksheetDrawerItems`, thread it down from `WorksheetDrawer` (which holds the full `WorksheetListItem` with `.status` and `.completed_at`). Name the new props `worksheetStatus?: string` and `worksheetCompletedAtProp?: string | null` (or reuse existing equivalents if present). If threading is needed, that is part of this step — do it.

- [ ] Pass the per-row subject into `SortableItemRow` (which renders the indicator). Add a prop to `SortableItemRow` for the row's snapshot + flags, OR look up inside the row from a passed map. Simplest: pass the map + flags down. In `SortableItemRowProps` (interface near line 169) add:
```ts
  slaSnapshot: SlaSubjectSnapshot | null
  slaLoading: boolean
  slaError: boolean
```
and import the type at top:
```ts
import type { SlaSubjectSnapshot } from '@/services/sla-subjects'
```

- [ ] At the `SortableItemRow` call site (inside the items `.map`), pass:
```tsx
  slaSnapshot={slaByKey.get(String(item.id)) ?? null}
  slaLoading={slaLoading}
  slaError={slaError}
```

- [ ] Replace the AGE block (line ~314-317):
```tsx
{/* Age */}
<div className="w-[60px] shrink-0">
  <AgingTimer dateReceived={item.date_received ?? item.added_at} compact />
</div>
```
with:
```tsx
{/* SLA */}
<div className="w-[60px] shrink-0">
  <SlaAgeIndicator snapshot={slaSnapshot} isLoading={slaLoading} isError={slaError} compact />
</div>
```

### Step 3.2 — WorksheetDropPanel: same pattern

```bash
grep -n "AgingTimer\|\.map(\|export function WorksheetDropPanel\|items\b\|date_received\|added_at" /c/tmp/accu-mk1-wave1/src/components/hplc/WorksheetDropPanel.tsx | head -25
```

- [ ] Replace the import `AgingTimer` → `SlaAgeIndicator` + add `useSlaForSubjects`, `SlaSubject`, `InboxPriority` imports (same as 3.1).
- [ ] In the component body, build subjects from the panel's items and call the hook once:
```ts
const dropSubjects: SlaSubject[] = items.map(item => ({
  key: String(item.id),
  priority: (item.priority as InboxPriority) || 'normal',
  groupId: item.service_group_id,
  receivedAt: item.date_received ?? item.added_at,
}))
const { byKey: dropSlaByKey, isLoading: dropSlaLoading, isError: dropSlaError } =
  useSlaForSubjects(dropSubjects)
```
(The drop panel holds items being staged onto a worksheet — not completed — so no `completedAt`.)
- [ ] Replace the AGE render (line ~198):
```tsx
<AgingTimer dateReceived={item.date_received ?? item.added_at} compact />
```
with:
```tsx
<SlaAgeIndicator
  snapshot={dropSlaByKey.get(String(item.id)) ?? null}
  isLoading={dropSlaLoading}
  isError={dropSlaError}
  compact
/>
```
If `item` is inside a `.map` whose body is a child component, thread the map+flags down the same way as 3.1. Read the file to confirm whether the render is inline (in which case the inline lookup above works directly) or in a child row component.

### Step 3.3 — InboxServiceGroupCard: single subject per card

```bash
grep -n "AgingTimer\|date_received\|sample\.\|group\.\|export function InboxServiceGroupCard" /c/tmp/accu-mk1-wave1/src/components/hplc/InboxServiceGroupCard.tsx | head -25
```

- [ ] Replace the import `AgingTimer` → `SlaAgeIndicator` + add `useSlaForSubjects`, `SlaSubject` imports. (`InboxPriority` is already imported in this file.)
- [ ] In the component body (it receives `sample: InboxSampleItem` and `group: InboxServiceGroupSection`), build one subject and call the hook:
```ts
const slaSubjects: SlaSubject[] = [{
  key: `${sample.uid}|${group.group_id}`,
  priority: sample.priority,
  groupId: group.group_id,
  receivedAt: sample.date_received,
}]
const { byKey: slaByKey, isLoading: slaLoading, isError: slaError } =
  useSlaForSubjects(slaSubjects)
```
- [ ] Replace the AGE render (line ~166):
```tsx
{/* Aging timer */}
<AgingTimer dateReceived={sample.date_received} />
```
with:
```tsx
{/* SLA */}
<SlaAgeIndicator
  snapshot={slaByKey.get(`${sample.uid}|${group.group_id}`) ?? null}
  isLoading={slaLoading}
  isError={slaError}
  compact
/>
```

### Step 3.4 — Verify + lint + typecheck

```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-subjects.test.tsx src/test/sla-age-indicator.test.tsx'
```
Expected: still green (no behavior change to the tested units).

```bash
npx eslint src/components/hplc/WorksheetDrawerItems.tsx src/components/hplc/WorksheetDropPanel.tsx src/components/hplc/InboxServiceGroupCard.tsx
npm run typecheck
```
Run from inside the worktree. Expected: clean (no NEW errors).

### Step 3.5 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/hplc/WorksheetDrawerItems.tsx src/components/hplc/WorksheetDropPanel.tsx src/components/hplc/InboxServiceGroupCard.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): SLA indicator on worksheet drawer, drop panel, inbox card"
```

---

## Task 4 — Swap aggregate surfaces: inbox sample table + worksheets list

**Files:**
- Modify: `src/components/hplc/InboxSampleTable.tsx`
- Modify: `src/components/hplc/WorksheetsListPage.tsx`

Both render aggregate rows. Each row maps to N subjects; the indicator picks the worst. Call `useSlaForSubjects` ONCE at the page/table level over the flattened subjects of all rows, then pass each row its slice (array of snapshots) to `SlaAgeIndicator` via the `snapshots` prop.

### Step 4.1 — InboxSampleTable: N subjects per sample (one per group)

```bash
grep -n "AgingTimer\|\.map(\|samples\b\|sample\.uid\|analyses_by_group\|export function InboxSampleTable" /c/tmp/accu-mk1-wave1/src/components/hplc/InboxSampleTable.tsx | head -30
```

- [ ] Replace the import `AgingTimer` → `SlaAgeIndicator` + add:
```ts
import { useSlaForSubjects, type SlaSubject, type SlaSubjectSnapshot } from '@/services/sla-subjects'
```
- [ ] In the table component body (it has the `samples: InboxSampleItem[]` list), build the flattened subjects across all samples and call the hook once:
```ts
const slaSubjects: SlaSubject[] = samples.flatMap(sample =>
  sample.analyses_by_group.map(group => ({
    key: `${sample.uid}|${group.group_id}`,
    priority: sample.priority,
    groupId: group.group_id,
    receivedAt: sample.date_received,
  }))
)
const { byKey: slaByKey, isLoading: slaLoading, isError: slaError } =
  useSlaForSubjects(slaSubjects)
```
- [ ] Per row, build the snapshots slice and pass to the indicator. Replace the AGE cell (line ~324-327):
```tsx
{/* Age */}
<TableCell>
  <AgingTimer dateReceived={sample.date_received} />
</TableCell>
```
with:
```tsx
{/* SLA */}
<TableCell>
  <SlaAgeIndicator
    snapshots={sample.analyses_by_group
      .map(g => slaByKey.get(`${sample.uid}|${g.group_id}`))
      .filter((s): s is SlaSubjectSnapshot => s != null)}
    isLoading={slaLoading}
    isError={slaError}
  />
</TableCell>
```
(Non-compact here — the table cell has room for the fuller "9h left" form. If the column is visibly cramped after testing, add `compact`.)

### Step 4.2 — WorksheetsListPage: N subjects per worksheet (one per item)

```bash
grep -n "AgingTimer\|earliestAddedAt\|completed_at\|ws\.items\|\.map(\|export function WorksheetsListPage" /c/tmp/accu-mk1-wave1/src/components/hplc/WorksheetsListPage.tsx | head -30
```

- [ ] Replace the import `AgingTimer` → `SlaAgeIndicator` + add:
```ts
import { useSlaForSubjects, type SlaSubject, type SlaSubjectSnapshot } from '@/services/sla-subjects'
import type { InboxPriority } from '@/lib/api'
```
- [ ] At the page-component level (where the `worksheets` array is in scope), build flattened subjects across every worksheet's items and call the hook once:
```ts
const slaSubjects: SlaSubject[] = worksheets.flatMap(ws =>
  ws.items.map(item => ({
    key: `${ws.id}:${item.id}`,
    priority: (item.priority as InboxPriority) || 'normal',
    groupId: item.service_group_id,
    receivedAt: item.date_received ?? item.added_at,
    completedAt: ws.completed_at,
  }))
)
const { byKey: slaByKey, isLoading: slaLoading, isError: slaError } =
  useSlaForSubjects(slaSubjects)
```
(Note the composite key `${ws.id}:${item.id}` — item ids may repeat across worksheets, so namespace by worksheet id.)

**Context note:** confirm the page-level variable holding the list is named `worksheets` (it may be `data`, `filteredWorksheets`, etc.). Read the file and use the actual in-scope name. The per-row variable is `ws` inside the `.map` (per the existing line ~333 using `ws.completed_at`).

- [ ] Replace the AGE cell (line ~322-338):
```tsx
<TableCell>
  {ws.completed_at ? (
    <span className="text-sm text-muted-foreground">
      {new Date(ws.completed_at).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })}
    </span>
  ) : earliestAddedAt ? (
    <AgingTimer dateReceived={earliestAddedAt} compact />
  ) : (
    <span className="text-muted-foreground">—</span>
  )}
</TableCell>
```
with:
```tsx
<TableCell>
  <SlaAgeIndicator
    snapshots={ws.items
      .map(item => slaByKey.get(`${ws.id}:${item.id}`))
      .filter((s): s is SlaSubjectSnapshot => s != null)}
    isLoading={slaLoading}
    isError={slaError}
    compact
  />
</TableCell>
```
This removes the `completed_at`-date branch entirely — the frozen "took/missed" indicator now conveys completion. The `earliestAddedAt` local may become unused; if so, remove its declaration (read the file to confirm it isn't used elsewhere in the row before removing).

### Step 4.3 — Verify + lint + typecheck

```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-subjects.test.tsx src/test/sla-age-indicator.test.tsx'
```
Expected: still green.

```bash
npx eslint src/components/hplc/InboxSampleTable.tsx src/components/hplc/WorksheetsListPage.tsx
npm run typecheck
```
Run from inside the worktree. Expected: clean. If removing `earliestAddedAt` left an unused-var error elsewhere, resolve it.

### Step 4.4 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/hplc/InboxSampleTable.tsx src/components/hplc/WorksheetsListPage.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): SLA indicator on inbox sample table + worksheets list (worst aggregate)"
```

---

## Task 5 — Final regression sweep + manual smoke

### Step 5.1 — Full SLA + worksheet test suite

```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/sla-subjects.test.tsx src/test/sla-age-indicator.test.tsx src/test/sla-format.test.ts src/test/analysis-sla.test.tsx src/test/analysis-sla-cell.test.tsx src/test/order-sla.test.tsx src/test/order-sla-cell.test.tsx src/test/sample-sla.test.tsx src/test/sample-header-sla.test.tsx src/test/sample-sla-indicator.test.tsx src/test/sla-resolution.test.ts src/test/sla-breakdown-tooltip.test.tsx'
```
Then run any worksheet-specific tests:
```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/components/hplc/__tests__/WorksheetDrawer.test.tsx src/components/hplc/__tests__/WorksheetDrawerItems.test.tsx'
```
Expected: all pass. If a worksheet test rendered `AgingTimer` text and now asserts on it, update the assertion to the SLA indicator's `data-testid="sla-age-indicator"` (read the failing test, fix the assertion to match the new component, keep the test's intent).

### Step 5.2 — Typecheck (whole project)

```bash
npm run typecheck
```
Run from inside the worktree. Expected: clean.

### Step 5.3 — Branch state

```bash
git -C /c/tmp/accu-mk1-wave1 log --oneline origin/master..HEAD | head -10
```
Expected: 4 new feature commits (Task 1, 2, 3, 4) on top of the spec commit.

### Step 5.4 — Manual smoke on :3101 (hand back to user)

Hard-refresh `http://localhost:3101` (Ctrl+Shift+R), then verify:
- [ ] **Worksheet drawer:** open a worksheet → each item's old AGE column now shows an SLA dot + duration; hover shows the breakdown tooltip.
- [ ] **Worksheet drop panel:** staged items show the SLA indicator.
- [ ] **Worksheets list page:** each worksheet row shows the worst SLA across its items; a COMPLETED worksheet shows frozen `✓ took Xh` (met) or `— Missed by Yh` (missed) instead of the bare completion date.
- [ ] **Inbox sample table:** a multi-group sample row shows the worst group's SLA.
- [ ] **Inbox service-group card:** shows that group's SLA.
- [ ] Confirm `AgingTimer.tsx` still exists in the tree but is no longer imported anywhere (`grep -rn "AgingTimer" src/` should show only the parked file's own definition).

### Step 5.5 — Report

- Summarize the 4 new commits.
- Note that `AgingTimer.tsx` is parked unused (Knip will flag it; intentional).
- Offer `superpowers:finishing-a-development-branch` once the user is satisfied with live behavior.

If any smoke check fails, capture the specific surface + observation (screenshot via the `playwright-cli` skill for UI issues) and fix before declaring done.

---

## Self-Review Notes

**Spec coverage:**
- `SlaSubject` model + `useSlaForSubjects` + `pickWorstSnapshot` → Task 1.
- `SlaAgeIndicator` compact/full + frozen rendering + memo → Task 2.
- 3 single-group surfaces → Task 3. 2 aggregate surfaces → Task 4.
- Freeze at completion (`completedAt` → `now_override` → met/missed) → Task 1 (hook) + Task 3 (drawer threads worksheet `completed_at`) + Task 4 (list uses `ws.completed_at`).
- Inbox surfaces stay live (no `completedAt`) → Task 3.3, Task 4.1.
- `AgingTimer.tsx` parked, not deleted → no task deletes it; Task 5.4 confirms it's unused.
- No backend / i18n changes → reuses `orderStatus.sla.*` (incl. `missedBy`/`noTierConfigured` added in the prior analysis-services work).

**Placeholder scan:** No TBDs. The "Context note" blocks in Tasks 3-4 instruct reading the file to confirm exact prop/variable names before editing — these are real codebase-navigation steps, not deferred work; the code to write is fully specified.

**Type consistency:** `SlaSubject`, `SlaSubjectSnapshot`, `SlaSubjectsResult` defined in Task 1 and consumed identically in Tasks 2-4. `useSlaForSubjects` returns `{ byKey, isLoading, isError }` — destructured consistently as `byKey`/`isLoading`/`isError` (aliased per surface, e.g. `slaByKey`). `pickWorstSnapshot` defined in Task 1, used in Task 2's renderer and memo comparator. `SlaAgeIndicator` props (`snapshot?`, `snapshots?`, `isLoading`, `isError`, `compact?`) consistent across Task 2 definition and Tasks 3-4 call sites. `i18n` keys referenced (`orderStatus.sla.over/.left/.publishedTook/.missedBy/.loading/.unavailable/.noTierConfigured`) all exist post the analysis-services work.

**Known pre-existing oddity (not in scope):** `src/lib/api.ts` has a duplicate `SlaStatusRequestItem` interface declaration and a stray `SlaStatusReson` typo interface. TypeScript tolerates the duplicate via interface merging. Do NOT fix as part of this plan (no unsolicited refactors).
