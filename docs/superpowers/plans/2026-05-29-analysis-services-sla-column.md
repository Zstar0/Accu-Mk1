# Analysis Services SLA Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sortable per-row SLA status column to the Analysis Services list (`AnalysisTable`) on the Sample Details page, resolving each analysis to its service-group tier via existing primitives and rendering a colored status indicator that mirrors `OrderSlaCell`'s visual idiom.

**Architecture:** Frontend-only. A new focused hook `useAnalysisSlaMap(lookup)` wraps `useSampleSla` and the analysis-services + service-groups queries, exposing a `Map<keyword, SampleSlaSnapshot>`. A new `<AnalysisSlaCell>` component renders the same dot + remaining-text + `SlaBreakdownTooltip` form factor as `OrderSlaCell`, branching on published vs active state. `AnalysisTable` gains 4 props, a new `<SortableHeader column="sla">`, a sort comparator branch, and one new `<td>` per row. `SampleDetails.tsx` calls the new hook in parallel with the existing `useSampleSla` and threads results into the table.

**Tech Stack:** React 19, TanStack Query, vitest, shadcn/ui Tooltip, react-i18next. No backend or schema changes.

**Spec:** `docs/superpowers/specs/2026-05-29-analysis-services-sla-column-design.md`

**Worktree:** `C:\tmp\accu-mk1-wave1` — bind-mounted by the `accu-mk1-frontend` container at `:3101`. All edits here. Frontend HMR fires automatically.

**Commit-message convention:** `feat(sla): …` / `fix(sla): …` / `refactor(sla): …` + a brief description. One commit per task. `.planning/STATE.md` ALWAYS stays out of commits.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/services/analysis-sla.ts` | NEW | `useAnalysisSlaMap(lookup)` — produces `Map<keyword, SampleSlaSnapshot>` by composing `useSampleSla` with analysis-services + service-groups data. |
| `src/components/senaite/AnalysisSlaCell.tsx` | NEW | Per-row cell renderer. Dot + remaining text + `SlaBreakdownTooltip`. `React.memo` with structural equality. |
| `src/test/analysis-sla.test.tsx` | NEW | Hook tests — map shape, fallback chain, flag pass-through. |
| `src/test/analysis-sla-cell.test.tsx` | NEW | Cell tests — render branches, tooltip wiring, memo equality. |
| `src/components/senaite/AnalysisTable.tsx` | MODIFY | New 4 props on `AnalysisTableProps`; thread into `AnalysisRow`; add `SortableHeader column="sla"`; add `<td>` in `AnalysisRow`; empty `<td>` in `HistoryRow`; bump empty-state `colSpan` 10 → 11; extend `SortColumn` union + `getCellValue`. |
| `src/components/senaite/SampleDetails.tsx` | MODIFY | Call `useAnalysisSlaMap(data)`; pass 4 props into `<AnalysisTable />`. |
| `locales/en.json`, `locales/fr.json`, `locales/ar.json` | MODIFY | Add `orderStatus.sla.noTierConfigured: "No SLA tier configured"`. Reuse existing `orderStatus.sla` ("SLA") as the column header — no new header key. |

---

## Task 1 — Hook: `useAnalysisSlaMap` (TDD)

**Files:**
- Create: `src/services/analysis-sla.ts`
- Test: `src/test/analysis-sla.test.tsx`

### Step 1.1 — Write the failing tests

- [ ] Create `src/test/analysis-sla.test.tsx` with the following content:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type * as ApiModule from '@/lib/api'
import type {
  SenaiteLookupResult,
  SlaStatusRequestItem,
  SlaStatusResultItem,
} from '@/lib/api'

const fetchSlaStatusesMock =
  vi.fn<(items: SlaStatusRequestItem[]) => Promise<SlaStatusResultItem[]>>()
const samplePrioritiesLookupMock =
  vi.fn<(uids: string[]) => Promise<{ sample_uid: string; priority: 'normal' | 'high' | 'expedited' }[]>>()
const getAnalysisServicesMock = vi.fn()
const getServiceGroupsMock = vi.fn()
const getSlaTiersMock = vi.fn()
const getSlaPriorityTiersMock = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof ApiModule>('@/lib/api')
  return {
    ...actual,
    fetchSlaStatuses: (items: SlaStatusRequestItem[]) => fetchSlaStatusesMock(items),
    samplePrioritiesLookup: (uids: string[]) => samplePrioritiesLookupMock(uids),
    getAnalysisServices: () => getAnalysisServicesMock(),
    getServiceGroups: () => getServiceGroupsMock(),
    getSlaTiers: () => getSlaTiersMock(),
    getSlaPriorityTiers: () => getSlaPriorityTiersMock(),
  }
})

const { useAnalysisSlaMap } = await import('@/services/analysis-sla')

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const DEFAULT_TIER = {
  id: 1,
  name: 'Default',
  target_minutes: 1440,
  business_hours_only: false,
  is_default: true,
  amber_threshold_percent: 80,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-01-01T00:00:00',
}
const HPLC_TIER = {
  id: 2,
  name: 'HPLC fast',
  target_minutes: 240,
  business_hours_only: false,
  is_default: false,
  amber_threshold_percent: 80,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-01-01T00:00:00',
}

function makeLookup(overrides: Partial<SenaiteLookupResult> = {}): SenaiteLookupResult {
  return {
    sample_id: 'PB-001',
    sample_uid: 'uid-PB-001',
    client_sample_id: null,
    client: null,
    sample_type: null,
    date_received: '2026-01-01T09:00:00',
    date_sampled: null,
    client_lot: null,
    review_state: 'sample_received',
    declared_weight_mg: null,
    remarks: [],
    analyses: [],
    attachments: [],
    ...overrides,
  } as unknown as SenaiteLookupResult
}

beforeEach(() => {
  fetchSlaStatusesMock.mockReset().mockResolvedValue([])
  samplePrioritiesLookupMock.mockReset().mockResolvedValue([])
  getAnalysisServicesMock.mockReset().mockResolvedValue([
    { id: 10, keyword: 'identity_hplc', title: 'Identity (HPLC)' },
    { id: 11, keyword: 'purity_hplc',   title: 'Purity (HPLC)' },
    { id: 12, keyword: 'orphan_kw',     title: 'Orphan service' },
  ])
  getServiceGroupsMock.mockReset().mockResolvedValue([
    { id: 100, name: 'HPLC', sla_tier_id: 2, member_ids: [10, 11] },
  ])
  getSlaTiersMock.mockReset().mockResolvedValue([DEFAULT_TIER, HPLC_TIER])
  getSlaPriorityTiersMock.mockReset().mockResolvedValue([])
})

describe('useAnalysisSlaMap', () => {
  it('returns empty byKeyword when lookup is null', async () => {
    const { result } = renderHook(() => useAnalysisSlaMap(null), { wrapper })
    await waitFor(() => {
      expect(result.current.byKeyword.size).toBe(0)
    })
    expect(result.current.isLoading).toBe(false)
    expect(result.current.priority).toBeNull()
  })

  it('returns empty byKeyword when sample has no date_received', async () => {
    const lookup = makeLookup({ date_received: null })
    const { result } = renderHook(() => useAnalysisSlaMap(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.byKeyword.size).toBe(0)
    })
    expect(fetchSlaStatusesMock).not.toHaveBeenCalled()
  })

  it('maps each keyword to the snapshot for its resolved group', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|100',
        status: { elapsed_minutes: 60, remaining_minutes: 180, target_minutes: 240, breached: false },
      },
    ])
    const lookup = makeLookup({
      analyses: [
        { keyword: 'identity_hplc' } as never,
        { keyword: 'purity_hplc' } as never,
      ],
    })
    const { result } = renderHook(() => useAnalysisSlaMap(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.byKeyword.size).toBe(2)
    expect(result.current.byKeyword.get('identity_hplc')?.tier.id).toBe(2)
    expect(result.current.byKeyword.get('purity_hplc')?.tier.id).toBe(2)
  })

  it('unmapped keyword falls through to default-tier snapshot when default exists', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      // HPLC group key
      {
        key: 'uid-PB-001|100',
        status: { elapsed_minutes: 30, remaining_minutes: 210, target_minutes: 240, breached: false },
      },
      // NO_GROUP_KEY (default-tier bucket)
      {
        key: 'uid-PB-001|no-group',
        status: { elapsed_minutes: 30, remaining_minutes: 1410, target_minutes: 1440, breached: false },
      },
    ])
    const lookup = makeLookup({
      analyses: [
        { keyword: 'identity_hplc' } as never,
        { keyword: 'orphan_kw' } as never,
      ],
    })
    const { result } = renderHook(() => useAnalysisSlaMap(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.byKeyword.size).toBe(2)
    })
    expect(result.current.byKeyword.get('identity_hplc')?.tier.id).toBe(2)
    expect(result.current.byKeyword.get('orphan_kw')?.tier.id).toBe(1)
  })

  it('unmapped keyword with NO default tier produces no entry', async () => {
    getSlaTiersMock.mockResolvedValue([HPLC_TIER]) // no default
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|100',
        status: { elapsed_minutes: 30, remaining_minutes: 210, target_minutes: 240, breached: false },
      },
    ])
    const lookup = makeLookup({
      analyses: [
        { keyword: 'identity_hplc' } as never,
        { keyword: 'orphan_kw' } as never,
      ],
    })
    const { result } = renderHook(() => useAnalysisSlaMap(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.byKeyword.has('identity_hplc')).toBe(true)
    })
    expect(result.current.byKeyword.has('orphan_kw')).toBe(false)
  })

  it('null keyword on an analysis produces no entry', async () => {
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|no-group',
        status: { elapsed_minutes: 30, remaining_minutes: 1410, target_minutes: 1440, breached: false },
      },
    ])
    const lookup = makeLookup({
      analyses: [{ keyword: null } as never],
    })
    const { result } = renderHook(() => useAnalysisSlaMap(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.byKeyword.size).toBe(0)
  })

  it('forwards isPublished and priority from useSampleSla', async () => {
    samplePrioritiesLookupMock.mockResolvedValue([
      { sample_uid: 'uid-PB-001', priority: 'expedited' },
    ])
    fetchSlaStatusesMock.mockResolvedValue([
      {
        key: 'uid-PB-001|100',
        status: { elapsed_minutes: 600, remaining_minutes: -360, target_minutes: 240, breached: true },
      },
    ])
    const lookup = makeLookup({
      review_state: 'published',
      // @ts-expect-error -- partial shape for test
      published_coa: { published_date: '2026-01-01T19:00:00' },
      analyses: [{ keyword: 'identity_hplc' } as never],
    })
    const { result } = renderHook(() => useAnalysisSlaMap(lookup), { wrapper })
    await waitFor(() => {
      expect(result.current.byKeyword.size).toBe(1)
    })
    expect(result.current.isPublished).toBe(true)
    expect(result.current.priority).toBe('expedited')
  })
})
```

### Step 1.2 — Run tests to verify they fail

Run:
```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/analysis-sla.test.tsx'
```
Expected: FAIL — `Cannot find module '@/services/analysis-sla'` or `useAnalysisSlaMap is not a function`.

### Step 1.3 — Implement `useAnalysisSlaMap`

- [ ] Create `src/services/analysis-sla.ts` with the following content:

```ts
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

  const isLoading =
    sampleSla.isLoading ||
    servicesQuery.isLoading ||
    groupsQuery.isLoading ||
    tiersQuery.isLoading
  const isError =
    sampleSla.isError ||
    servicesQuery.isError ||
    groupsQuery.isError ||
    tiersQuery.isError

  return {
    byKeyword,
    isLoading,
    isError,
    isPublished: sampleSla.isPublished,
    priority: sampleSla.priority,
  }
}
```

### Step 1.4 — Run tests to verify they pass

Run:
```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/analysis-sla.test.tsx'
```
Expected: PASS (7 tests).

### Step 1.5 — Scoped lint + typecheck

Run:
```bash
npx --prefix /c/tmp/accu-mk1-wave1 eslint src/services/analysis-sla.ts src/test/analysis-sla.test.tsx
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
```
Expected: Both clean. (Pre-existing lint baseline in `src/lib/api.ts` and `src/components/OrderStatusPage.tsx` is fine — only flag NEW errors.)

### Step 1.6 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add src/services/analysis-sla.ts src/test/analysis-sla.test.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): useAnalysisSlaMap hook for per-analysis SLA snapshots"
```

---

## Task 2 — Cell: `AnalysisSlaCell` (TDD)

**Files:**
- Create: `src/components/senaite/AnalysisSlaCell.tsx`
- Test: `src/test/analysis-sla-cell.test.tsx`

### Step 2.1 — Write the failing tests

- [ ] Create `src/test/analysis-sla-cell.test.tsx` with the following content:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n/config'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { SampleSlaSnapshot } from '@/services/order-sla'
import { AnalysisSlaCell } from '@/components/senaite/AnalysisSlaCell'
import { NO_GROUP_KEY } from '@/lib/sla-resolution'

const TIER = {
  id: 2,
  name: 'HPLC fast',
  target_minutes: 240,
  business_hours_only: false,
  is_default: false,
  amber_threshold_percent: 80,
  created_at: '2026-01-01T00:00:00',
  updated_at: '2026-01-01T00:00:00',
}

function makeSnapshot(overrides: Partial<SampleSlaSnapshot> = {}): SampleSlaSnapshot {
  return {
    groupKey: 100,
    groupName: 'HPLC',
    tier: TIER,
    status: { elapsed_minutes: 60, remaining_minutes: 180, target_minutes: 240, breached: false },
    color: 'green',
    reason: { tierSource: 'group', unmappedKeywords: [] },
    priority: 'normal',
    ...overrides,
  } as SampleSlaSnapshot
}

function wrap(node: React.ReactNode) {
  return (
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>{node}</TooltipProvider>
    </I18nextProvider>
  )
}

describe('AnalysisSlaCell', () => {
  it('renders green dot + remaining text for active green snapshot', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={makeSnapshot({ color: 'green' })}
        priority="normal"
        isLoading={false}
        isError={false}
        isPublished={false}
      />
    ))
    const cell = screen.getByTestId('analysis-sla-cell')
    expect(cell).toHaveAttribute('data-sla-color', 'green')
    expect(cell.textContent).toMatch(/3h.*left/i)
  })

  it('renders amber dot for amber snapshot', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={makeSnapshot({ color: 'amber', status: { elapsed_minutes: 200, remaining_minutes: 40, target_minutes: 240, breached: false } })}
        priority="normal"
        isLoading={false}
        isError={false}
        isPublished={false}
      />
    ))
    expect(screen.getByTestId('analysis-sla-cell')).toHaveAttribute('data-sla-color', 'amber')
  })

  it('renders red + "Over Xh" for breached active snapshot', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={makeSnapshot({
          color: 'red',
          status: { elapsed_minutes: 360, remaining_minutes: -120, target_minutes: 240, breached: true },
        })}
        priority="normal"
        isLoading={false}
        isError={false}
        isPublished={false}
      />
    ))
    const cell = screen.getByTestId('analysis-sla-cell')
    expect(cell).toHaveAttribute('data-sla-color', 'red')
    expect(cell.textContent).toMatch(/over/i)
  })

  it('renders "took Xh" for published met snapshot', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={makeSnapshot({
          color: 'green',
          status: { elapsed_minutes: 180, remaining_minutes: 60, target_minutes: 240, breached: false },
        })}
        priority="normal"
        isLoading={false}
        isError={false}
        isPublished={true}
      />
    ))
    const cell = screen.getByTestId('analysis-sla-cell')
    expect(cell).toHaveAttribute('data-sla-color', 'met')
    expect(cell.textContent).toMatch(/took/i)
  })

  it('renders "Missed by Xh" for published breached snapshot', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={makeSnapshot({
          color: 'red',
          status: { elapsed_minutes: 600, remaining_minutes: -360, target_minutes: 240, breached: true },
        })}
        priority="normal"
        isLoading={false}
        isError={false}
        isPublished={true}
      />
    ))
    const cell = screen.getByTestId('analysis-sla-cell')
    expect(cell).toHaveAttribute('data-sla-color', 'missed')
  })

  it('renders loading indicator', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={null}
        priority={null}
        isLoading={true}
        isError={false}
        isPublished={false}
      />
    ))
    expect(screen.getByTestId('analysis-sla-cell')).toHaveAttribute('data-sla-color', 'loading')
  })

  it('renders error indicator', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={null}
        priority={null}
        isLoading={false}
        isError={true}
        isPublished={false}
      />
    ))
    expect(screen.getByTestId('analysis-sla-cell')).toHaveAttribute('data-sla-color', 'error')
  })

  it('renders muted em-dash when snapshot is null and no loading/error', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={null}
        priority={null}
        isLoading={false}
        isError={false}
        isPublished={false}
      />
    ))
    const cell = screen.getByTestId('analysis-sla-cell')
    expect(cell).toHaveAttribute('data-sla-color', 'none')
    expect(cell.textContent).toContain('—')
  })

  it('NO_GROUP_KEY snapshot still renders normally (default-tier fallback case)', () => {
    render(wrap(
      <AnalysisSlaCell
        snapshot={makeSnapshot({ groupKey: NO_GROUP_KEY, groupName: undefined })}
        priority="normal"
        isLoading={false}
        isError={false}
        isPublished={false}
      />
    ))
    expect(screen.getByTestId('analysis-sla-cell')).toHaveAttribute('data-sla-color', 'green')
  })
})
```

### Step 2.2 — Run tests to verify they fail

Run:
```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/analysis-sla-cell.test.tsx'
```
Expected: FAIL — `Cannot find module '@/components/senaite/AnalysisSlaCell'`.

### Step 2.3 — Implement `AnalysisSlaCell`

- [ ] Create `src/components/senaite/AnalysisSlaCell.tsx` with the following content:

```tsx
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { formatMinutes } from '@/lib/sla-format'
import type { InboxPriority } from '@/lib/api'
import type { SampleSlaSnapshot } from '@/services/order-sla'
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
  red: '●',
  amber: '●',
  green: '●',
  met: '✓',
  missed: '—',
  loading: '…',
  error: '—',
  none: '—',
}

interface AnalysisSlaCellProps {
  snapshot: SampleSlaSnapshot | null
  priority: InboxPriority | null
  isLoading: boolean
  isError: boolean
  isPublished: boolean
}

function pickColor(props: AnalysisSlaCellProps): CellColor {
  if (props.isLoading) return 'loading'
  if (props.isError) return 'error'
  if (!props.snapshot) return 'none'
  if (props.isPublished) {
    return props.snapshot.status.breached ? 'missed' : 'met'
  }
  return props.snapshot.color
}

function AnalysisSlaCellImpl(props: AnalysisSlaCellProps) {
  const { t } = useTranslation()
  const color = pickColor(props)
  const className = COLOR_CLASS[color]
  const dot = DOT[color]

  let text = ''
  let titleAttr: string | undefined
  if (color === 'red') {
    text = t('orderStatus.sla.over', {
      time: formatMinutes(Math.abs(props.snapshot!.status.remaining_minutes)),
    })
  } else if (color === 'amber' || color === 'green') {
    text = t('orderStatus.sla.left', {
      time: formatMinutes(props.snapshot!.status.remaining_minutes),
    })
  } else if (color === 'met') {
    text = t('orderStatus.sla.publishedTook', {
      time: formatMinutes(props.snapshot!.status.elapsed_minutes),
    })
  } else if (color === 'missed') {
    text = t('orderStatus.sla.missedBy', {
      time: formatMinutes(Math.abs(props.snapshot!.status.remaining_minutes)),
    })
  } else if (color === 'loading') {
    titleAttr = t('orderStatus.sla.loading')
  } else if (color === 'error') {
    titleAttr = t('orderStatus.sla.unavailable')
  } else {
    text = '—'
    titleAttr = t('orderStatus.sla.noTierConfigured')
  }

  const hasBreakdown =
    !props.isLoading &&
    !props.isError &&
    props.snapshot !== null

  const cell = (
    <span
      data-testid="analysis-sla-cell"
      data-sla-color={color}
      className={cn(
        'inline-flex items-center gap-1 text-xs font-mono tabular-nums',
        className
      )}
      title={hasBreakdown ? undefined : titleAttr}
    >
      <span aria-hidden="true">{dot}</span>
      {text && <span>{text}</span>}
    </span>
  )

  if (hasBreakdown && props.snapshot) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{cell}</TooltipTrigger>
        <TooltipContent className="p-0 max-w-md">
          <SlaBreakdownTooltip
            tier={props.snapshot.tier}
            status={props.snapshot.status}
            reason={props.snapshot.reason}
            priority={props.priority}
            groupName={props.snapshot.groupName}
            isPublished={props.isPublished}
          />
        </TooltipContent>
      </Tooltip>
    )
  }
  return cell
}

/** Structural equality across visually-meaningful fields — same anti-flicker
 *  pattern as OrderSlaCell. Prevents Tooltip teardown when the parent passes
 *  a new map reference but the snapshot's content is unchanged. */
function slaPropsEqual(prev: AnalysisSlaCellProps, next: AnalysisSlaCellProps): boolean {
  if (prev.isLoading !== next.isLoading) return false
  if (prev.isError !== next.isError) return false
  if (prev.isPublished !== next.isPublished) return false
  if (prev.priority !== next.priority) return false
  const a = prev.snapshot
  const b = next.snapshot
  if (a === b) return true
  if (a === null || b === null) return false
  if (a.color !== b.color) return false
  if ((a.groupKey ?? null) !== (b.groupKey ?? null)) return false
  if ((a.groupName ?? null) !== (b.groupName ?? null)) return false
  if ((a.tier?.id ?? null) !== (b.tier?.id ?? null)) return false
  if ((a.tier?.target_minutes ?? null) !== (b.tier?.target_minutes ?? null)) return false
  if ((a.tier?.amber_threshold_percent ?? null) !== (b.tier?.amber_threshold_percent ?? null)) return false
  if ((a.tier?.business_hours_only ?? null) !== (b.tier?.business_hours_only ?? null)) return false
  if (a.status.elapsed_minutes !== b.status.elapsed_minutes) return false
  if (a.status.remaining_minutes !== b.status.remaining_minutes) return false
  if (a.status.breached !== b.status.breached) return false
  if ((a.reason?.tierSource ?? null) !== (b.reason?.tierSource ?? null)) return false
  return true
}

export const AnalysisSlaCell = memo(AnalysisSlaCellImpl, slaPropsEqual)
```

### Step 2.4 — Run tests to verify they pass

Run:
```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/analysis-sla-cell.test.tsx'
```
Expected: PASS (9 tests).

> If a test fails because `t('orderStatus.sla.missedBy', ...)` or `t('orderStatus.sla.noTierConfigured')` resolves to the raw key string, that's expected at this point — Task 3 adds those keys. Re-run after Task 3.

### Step 2.5 — Scoped lint + typecheck

```bash
npx --prefix /c/tmp/accu-mk1-wave1 eslint src/components/senaite/AnalysisSlaCell.tsx src/test/analysis-sla-cell.test.tsx
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
```
Expected: Both clean.

### Step 2.6 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/senaite/AnalysisSlaCell.tsx src/test/analysis-sla-cell.test.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): AnalysisSlaCell renders per-analysis SLA status indicator"
```

---

## Task 3 — i18n keys

**Files:**
- Modify: `locales/en.json`, `locales/fr.json`, `locales/ar.json`

Add two new keys under `orderStatus.sla`:
- `missedBy` (already used in SampleHeaderSla for header — verify it exists; if absent, add)
- `noTierConfigured`

### Step 3.1 — Verify existing `orderStatus.sla.missedBy` key

```bash
python -c "import json; d=json.load(open(r'C:\\tmp\\accu-mk1-wave1\\locales\\en.json')); print('missedBy:', d.get('orderStatus',{}).get('sla',{}).get('missedBy', 'MISSING'))"
```
- If `MISSING`: include `missedBy` in the patches below.
- If present: only add `noTierConfigured`.

### Step 3.2 — Add keys to all three locale files

- [ ] Locate the `orderStatus.sla` block in each file (around the same point in each — JSON keys ordered identically across files per project convention).
- [ ] Add (or splice in) these entries, identical English across all three files:

```json
"missedBy": "Missed by {{time}}",
"noTierConfigured": "No SLA tier configured"
```

Use a multi-file Edit per file. Suggested placement: immediately after the `publishedTook` entry. If `missedBy` already exists, only add `noTierConfigured`.

### Step 3.3 — Verify JSON is still valid

```bash
python -c "import json; [json.load(open(f'C:\\\\tmp\\\\accu-mk1-wave1\\\\locales\\\\{n}.json')) for n in ('en','fr','ar')]; print('all valid')"
```
Expected: `all valid`.

### Step 3.4 — Re-run Task 2 tests now that translations resolve

```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/analysis-sla-cell.test.tsx'
```
Expected: PASS (9 tests; assertions on text content now match the resolved strings).

### Step 3.5 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add locales/en.json locales/fr.json locales/ar.json
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): i18n keys for analysis-row SLA cell (missedBy, noTierConfigured)"
```

---

## Task 4 — Integrate column into `AnalysisTable`

**Files:**
- Modify: `src/components/senaite/AnalysisTable.tsx`

### Step 4.1 — Extend `SortColumn` and `getCellValue`

Locate `type SortColumn` (around line 826) and replace it:

```ts
type SortColumn = 'title' | 'result' | 'review_state' | 'analyst' | 'method' | 'instrument' | 'captured' | 'sla'
```

Locate `function getCellValue` (around line 867). The existing function only handles string sort keys. SLA needs numeric sort plus access to the map. Replace the SLA branch by adding a separate sort path. Add this NEW helper above `function sortGroups`:

```ts
function getSlaSortValue(
  a: SenaiteAnalysis,
  analysisSlaMap: Map<string, SampleSlaSnapshot> | undefined,
  isPublished: boolean
): number {
  if (!analysisSlaMap || !a.keyword) return Number.POSITIVE_INFINITY
  const snap = analysisSlaMap.get(a.keyword)
  if (!snap) return Number.POSITIVE_INFINITY
  return isPublished ? snap.status.elapsed_minutes : snap.status.remaining_minutes
}
```

Add the import at the top of the file (near the existing `SenaiteAnalysis` import):

```ts
import type { SampleSlaSnapshot } from '@/services/order-sla'
```

### Step 4.2 — Extend `sortGroups` to thread the SLA map

Locate `function sortGroups` (line 858). Replace its signature + body:

```ts
function sortGroups(
  groups: AnalysisGroup[],
  config: SortConfig,
  nameMap: Map<number, string>,
  analysisSlaMap: Map<string, SampleSlaSnapshot> | undefined,
  isPublished: boolean
): AnalysisGroup[] {
  return [...groups].sort((a, b) => {
    if (config.column === 'sla') {
      const aVal = getSlaSortValue(a.current, analysisSlaMap, isPublished)
      const bVal = getSlaSortValue(b.current, analysisSlaMap, isPublished)
      const cmp = aVal - bVal
      return config.dir === 'asc' ? cmp : -cmp
    }
    const aVal = getCellValue(a.current, config.column, nameMap)
    const bVal = getCellValue(b.current, config.column, nameMap)
    const cmp = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' })
    return config.dir === 'asc' ? cmp : -cmp
  })
}
```

Update `getCellValue`'s switch so the type-checker still narrows correctly (lines 867-877). Add a default-unreachable case for `'sla'`:

```ts
function getCellValue(a: SenaiteAnalysis, col: Exclude<SortColumn, 'sla'>, nameMap: Map<number, string>): string {
  switch (col) {
    case 'title': return formatAnalysisTitle(a.title, nameMap).display
    case 'result': return a.result ?? ''
    case 'review_state': return a.review_state ?? ''
    case 'analyst': return a.analyst ?? ''
    case 'method': return a.method ?? ''
    case 'instrument': return a.instrument ?? ''
    case 'captured': return a.captured ?? ''
  }
}
```

### Step 4.3 — Extend `AnalysisTableProps` and the function signature

Locate `interface AnalysisTableProps` (line 881). Replace it:

```ts
interface AnalysisTableProps {
  analyses: SenaiteAnalysis[]
  analyteNameMap: Map<number, string>
  onResultSaved?: (uid: string, newResult: string, newReviewState: string | null) => void
  onTransitionComplete?: () => void
  onMethodInstrumentSaved?: (uid: string, field: 'method' | 'instrument', newUid: string | null, newTitle: string | null) => void
  analysisSlaMap?: Map<string, SampleSlaSnapshot>
  isAnalysisSlaLoading?: boolean
  isAnalysisSlaError?: boolean
  isAnalysisSlaPublished?: boolean
  analysisSlaPriority?: InboxPriority | null
}
```

Add to the import block (top of file) the type `InboxPriority`:
```ts
import type { SenaiteAnalysis, InboxPriority } from '@/lib/api'
```
(Edit the existing import; do not add a duplicate.)

Replace the function signature on line 889:

```ts
export function AnalysisTable({
  analyses,
  analyteNameMap,
  onResultSaved,
  onTransitionComplete,
  onMethodInstrumentSaved,
  analysisSlaMap,
  isAnalysisSlaLoading = false,
  isAnalysisSlaError = false,
  isAnalysisSlaPublished = false,
  analysisSlaPriority = null,
}: AnalysisTableProps) {
```

### Step 4.4 — Update the `sortGroups` call site

Find the line: `const groups = sortConfig ? sortGroups(rawGroups, sortConfig, analyteNameMap) : rawGroups` (line 954). Replace it:

```ts
const groups = sortConfig
  ? sortGroups(rawGroups, sortConfig, analyteNameMap, analysisSlaMap, isAnalysisSlaPublished)
  : rawGroups
```

### Step 4.5 — Add the SLA column header

Find the `<thead>` block (around line 1118). After the `review_state` SortableHeader and BEFORE the `captured` SortableHeader, insert:

```tsx
<SortableHeader column="sla" label={t('orderStatus.sla')} sortConfig={sortConfig} onSort={handleSort} />
```

Add a `useTranslation` import at the top:
```ts
import { useTranslation } from 'react-i18next'
```
and inside `AnalysisTable`:
```ts
const { t } = useTranslation()
```

(Place these only if not already present in the file — if `useTranslation` is already imported, reuse it.)

### Step 4.6 — Render the SLA `<td>` in `AnalysisRow`

`AnalysisRow` (line 679) currently doesn't have access to the SLA map. Extend its props to thread the snapshot:

Replace the `AnalysisRow` props destructure and type (lines 679-703):

```tsx
function AnalysisRow({
  analysis,
  analyteNameMap,
  editing,
  transition,
  selectedUids,
  onToggleSelection,
  isBulkProcessing,
  historyCount,
  isHistoryExpanded,
  onToggleHistory,
  onMethodInstrumentSaved,
  slaSnapshot,
  isSlaLoading,
  isSlaError,
  isSlaPublished,
  slaPriority,
}: {
  analysis: SenaiteAnalysis
  analyteNameMap: Map<number, string>
  editing: UseAnalysisEditingReturn
  transition: UseAnalysisTransitionReturn
  selectedUids: Set<string>
  onToggleSelection: (uid: string) => void
  isBulkProcessing: boolean
  historyCount?: number
  isHistoryExpanded?: boolean
  onToggleHistory?: () => void
  onMethodInstrumentSaved?: (uid: string, field: 'method' | 'instrument', newUid: string | null, newTitle: string | null) => void
  slaSnapshot: SampleSlaSnapshot | null
  isSlaLoading: boolean
  isSlaError: boolean
  isSlaPublished: boolean
  slaPriority: InboxPriority | null
}) {
```

Add the import at the top:
```ts
import { AnalysisSlaCell } from '@/components/senaite/AnalysisSlaCell'
```

In `AnalysisRow`'s JSX, insert the new `<td>` immediately AFTER the Status `<td>` (currently lines 777-779) and BEFORE the Captured `<td>` (line 780):

```tsx
<td className="py-2.5 px-3">
  <AnalysisSlaCell
    snapshot={slaSnapshot}
    priority={slaPriority}
    isLoading={isSlaLoading}
    isError={isSlaError}
    isPublished={isSlaPublished}
  />
</td>
```

### Step 4.7 — Add empty `<td>` in `HistoryRow`

`HistoryRow` (around line 620). It currently has 10 `<td>` cells (lines 633-672). Insert one more empty `<td>` between the Status `<td>` (the "Superseded" badge at lines 664-668) and the Captured `<td>` (lines 669-671):

```tsx
<td className="py-1.5 px-3" />
```

### Step 4.8 — Pass props from `AnalysisTable` into `AnalysisRow`

Find the `groups.map(group => { ... <AnalysisRow ... /> })` block (around line 1156). Add the SLA props to the `AnalysisRow` invocation. The keyword resolution happens inline so each row gets `null` when there's no snapshot:

```tsx
<AnalysisRow
  analysis={group.current}
  analyteNameMap={analyteNameMap}
  editing={editing}
  transition={transition}
  selectedUids={bulk.selectedUids}
  onToggleSelection={bulk.toggleSelection}
  isBulkProcessing={bulk.isBulkProcessing}
  historyCount={group.history.length}
  isHistoryExpanded={isExpanded}
  onToggleHistory={() => toggleGroup(groupKey)}
  onMethodInstrumentSaved={onMethodInstrumentSaved}
  slaSnapshot={
    analysisSlaMap && group.current.keyword
      ? analysisSlaMap.get(group.current.keyword) ?? null
      : null
  }
  isSlaLoading={isAnalysisSlaLoading}
  isSlaError={isAnalysisSlaError}
  isSlaPublished={isAnalysisSlaPublished}
  slaPriority={analysisSlaPriority}
/>
```

### Step 4.9 — Bump empty-state `colSpan` 10 → 11

Find `colSpan={10}` (line 1182). Replace:

```tsx
colSpan={11}
```

### Step 4.10 — Run frontend SLA suite (regression check)

```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/analysis-sla.test.tsx src/test/analysis-sla-cell.test.tsx src/test/order-sla.test.tsx src/test/order-sla-cell.test.tsx src/test/sample-sla.test.tsx src/test/sample-header-sla.test.tsx src/test/sample-sla-indicator.test.tsx src/test/sla-resolution.test.ts src/test/sla-breakdown-tooltip.test.tsx'
```
Expected: All previously-passing tests still pass + Task 1/2 tests still pass.

### Step 4.11 — Scoped lint + typecheck

```bash
npx --prefix /c/tmp/accu-mk1-wave1 eslint src/components/senaite/AnalysisTable.tsx
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
```
Expected: Clean.

### Step 4.12 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/senaite/AnalysisTable.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): SLA column on AnalysisTable with sortable per-row indicator"
```

---

## Task 5 — Wire `useAnalysisSlaMap` into `SampleDetails`

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx`

### Step 5.1 — Add the hook import

Find the existing imports (around line 105). Add:

```ts
import { useAnalysisSlaMap } from '@/services/analysis-sla'
```

### Step 5.2 — Call the hook

Locate where `data` is set (it's the `SenaiteLookupResult | null` state). In the component body, right after `data` is in scope (search for `const [data, setData]` near the top of the main component function), add:

```ts
const analysisSla = useAnalysisSlaMap(data)
```

### Step 5.3 — Thread props into `<AnalysisTable>`

Locate the `<AnalysisTable ... />` invocation (line 3102). Add the SLA props:

```tsx
<AnalysisTable
  analyses={analyses}
  analyteNameMap={analyteNameMap}
  onResultSaved={(uid, newResult, newReviewState) => { /* existing */ }}
  onMethodInstrumentSaved={(uid, field, newUid, newTitle) => { /* existing */ }}
  analysisSlaMap={analysisSla.byKeyword}
  isAnalysisSlaLoading={analysisSla.isLoading}
  isAnalysisSlaError={analysisSla.isError}
  isAnalysisSlaPublished={analysisSla.isPublished}
  analysisSlaPriority={analysisSla.priority}
/>
```

(Preserve the existing callback bodies — don't replace them with the comment placeholders. Use Edit with enough surrounding context.)

### Step 5.4 — Scoped lint + typecheck

```bash
npx --prefix /c/tmp/accu-mk1-wave1 eslint src/components/senaite/SampleDetails.tsx
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
```
Expected: Clean (apart from the 1 pre-existing baseline error in `OrderStatusPage.tsx:77` and the 3 in `src/lib/api.ts`).

### Step 5.5 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/senaite/SampleDetails.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): wire useAnalysisSlaMap into SampleDetails AnalysisTable"
```

---

## Task 6 — Final regression sweep & manual smoke

### Step 6.1 — Full SLA + Sample Details test suite

```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/analysis-sla.test.tsx src/test/analysis-sla-cell.test.tsx src/test/order-sla.test.tsx src/test/order-sla-cell.test.tsx src/test/sample-sla.test.tsx src/test/sample-header-sla.test.tsx src/test/sample-sla-indicator.test.tsx src/test/sla-resolution.test.ts src/test/sla-breakdown-tooltip.test.tsx src/test/sla-pane.test.tsx src/test/sla-resolver.test.ts src/test/order-row.test.tsx'
```
Expected: All pass.

### Step 6.2 — Typecheck

```bash
npm --prefix /c/tmp/accu-mk1-wave1 run typecheck
```
Expected: Clean.

### Step 6.3 — Branch state check

```bash
git -C /c/tmp/accu-mk1-wave1 log --oneline origin/master..HEAD | head -15
```
Expected: 5 new commits on top (hook, cell, i18n, table, wire-up).

### Step 6.4 — Manual smoke — open Sample Details on `:3101`

- [ ] Hard-refresh `http://localhost:3101/#order-status` (Ctrl+Shift+R).
- [ ] Navigate to a sample with multiple analyses spanning a single tier — verify the SLA column shows the same color across all rows (because tier is identical).
- [ ] Navigate to a sample with analyses in DIFFERENT service groups (e.g., HPLC + a non-grouped analysis) — verify the rows show DIFFERENT colors when the tiers differ.
- [ ] Hover an active row's SLA cell — verify `SlaBreakdownTooltip` opens with the group's tier/target/elapsed/remaining/source line.
- [ ] Navigate to a PUBLISHED sample — verify rows show `took Xh` (met) or `Missed by Yh` (missed).
- [ ] Click the SLA column header — verify rows sort by remaining/elapsed time. Click again — verify reverse.
- [ ] Verify retracted/rejected rows still render an SLA cell (per the spec — non-active states keep showing).
- [ ] Verify history rows (expanded under retest groups) show an EMPTY SLA cell.

> If browser shows stale module graph, Vite usually picks up `src/` changes via HMR. If a manual reload doesn't reflect the new column at all, restart the dev container: `docker restart accu-mk1-frontend`.

### Step 6.5 — Report results

If everything passes:
- Summarize the 5 new commits to the user.
- Offer to invoke `superpowers:finishing-a-development-branch` to push + open the PR alongside the rest of the D2 + multi-tier work already on the branch.

If something fails:
- Capture the failing test name / lint error / smoke observation.
- For UI issues, take a screenshot via Playwright (use the `playwright-cli` skill) and surface it.
- Do NOT mark the plan complete.

---

## Self-Review Notes

**Spec coverage:**
- Goals 1-4 in spec → Tasks 1-5.
- Sample-level clock semantics → inherited from `useSampleSla` (Task 1 hook).
- `OrderSlaCell`-style visual → Task 2 `AnalysisSlaCell` (mirrors `OrderSlaCell` structure including `React.memo`).
- Sortable by remaining time → Task 4.1, 4.2, 4.4.
- Default-tier fallback for unmapped → Task 1 (`NO_GROUP_KEY` lookup) + test in Task 1.
- History rows empty SLA cell → Task 4.7.
- Always-show for non-active states → Task 2 (no early return based on review_state).
- All 18 spec tests → Tasks 1 (7) + 2 (9) + Task 4 regression sweep covers integration.

**Placeholder scan:** No TBDs. All steps have exact code or exact commands.

**Type consistency:**
- `SampleSlaSnapshot` referenced everywhere is the existing type from `@/services/order-sla`.
- `InboxPriority` is the existing type from `@/lib/api`.
- `GroupKey`, `NO_GROUP_KEY` are existing exports from `@/lib/sla-resolution`.
- Hook return shape `AnalysisSlaMapResult` matches consumer expectations in Tasks 4 and 5.
- Cell prop names (`snapshot`, `priority`, `isLoading`, `isError`, `isPublished`) used identically in Task 2 tests, Task 2 component, and Task 4.6 / Task 4.8 invocation.
- Table prop names (`analysisSlaMap`, `isAnalysisSlaLoading`, `isAnalysisSlaError`, `isAnalysisSlaPublished`, `analysisSlaPriority`) used identically in Task 4.3 (props interface), Task 4.3 (destructure), Task 4.4 (sort call), Task 4.8 (row invocation), Task 5.3 (parent invocation).
