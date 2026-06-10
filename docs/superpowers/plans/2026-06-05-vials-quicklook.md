# Vials Quick Look Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Vials Quick Look" button in the Analyses section of parent sample pages that opens a wide dialog stacking every vial's fully interactive `AnalysisTable`.

**Architecture:** Frontend-only (Approach A from the spec at `docs/superpowers/specs/2026-06-05-vials-quicklook-design.md`). A new `VialsQuickLookDialog` fetches vials + per-vial analyses + parent-line states with TanStack Query (`enabled: open`), and renders the existing `AnalysisTable` per vial with the same props the vial page passes. Shared display/compute logic moves to a small helpers file to avoid a circular import.

**Tech Stack:** React + TypeScript, TanStack Query (`useQuery`/`useQueries`), shadcn `Dialog`, vitest + Testing Library. All tests/typecheck run inside the `accumark-subvial-accu-mk1-frontend` container.

**Deviations from the spec (verified against code):**
- The vial page loads analyses with local `useState` (`resolveSampleData`, `SampleDetails.tsx:2095-2200`), NOT TanStack Query. There is no query key to match. The dialog uses its own `['quicklook-vial-analyses', subSamplePk]` keys; vial pages refetch on mount so cross-surface staleness cannot occur. Transitions in the dialog call `onParentDataStale` so the parent page refreshes.
- `SubSample` (api.ts:4812) has no review-state field. The vial header shows the role badge, analysis count, and received date — no status badge.
- Spec tests 1-2 (button gating) are covered by UAT, not vitest: rendering the full 3,600-line `SampleDetails` in jsdom is not an established pattern in this suite. The gating logic is a two-condition inline expression.

**Worktree / environment:**
- Repo: `C:/tmp/Accu-Mk1-subvial`, branch `subvial/continue` (push to PR #9 freely).
- FE tests: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run <path>"`
- Typecheck: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit"` — exactly 2 pre-existing errors are expected (`WorksheetsInboxPage.tsx(356,38)` possibly-undefined, `SampleDetails.tsx` unused `subSamples` at ~1885). A third error is yours.
- Known FE flake: `peptide-requests-list.test.tsx` — not a regression.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Helpers file — `computePrimaryAnalysisUids`, `RoleHeaderBadge`, `patchAnalysisInList`

`SampleDetails.tsx` computes primary-analysis UIDs inline (lines 1956-1972) and defines `ROLE_HEADER_BADGES`/`RoleHeaderBadge` inline (lines 1218-1243). The dialog needs both; importing from `SampleDetails` would create a circular import (SampleDetails will import the dialog). Move them to a helpers file and re-point SampleDetails.

**Files:**
- Create: `src/components/senaite/vial-quicklook-helpers.tsx`
- Modify: `src/components/senaite/SampleDetails.tsx` (lines ~1218-1243 and ~1956-1972)
- Test: `src/test/vial-quicklook-helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/test/vial-quicklook-helpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  computePrimaryAnalysisUids,
  patchAnalysisInList,
} from '@/components/senaite/vial-quicklook-helpers'
import type { SenaiteAnalysis } from '@/lib/api'

const mkAnalysis = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis =>
  ({
    uid: 'mk1:1',
    keyword: 'ENDO',
    title: 'Endotoxin',
    result: '',
    review_state: 'unassigned',
    service_group_name: 'Microbiology',
    ...over,
  }) as SenaiteAnalysis

describe('computePrimaryAnalysisUids', () => {
  const analyses = [
    mkAnalysis({ uid: 'mk1:1', keyword: 'ENDO', service_group_name: 'Microbiology' }),
    mkAnalysis({ uid: 'mk1:2', keyword: 'STER-PCR', service_group_name: 'Microbiology' }),
    mkAnalysis({ uid: 'mk1:3', keyword: 'PUR-HPLC', service_group_name: 'Analytics' }),
  ]

  it('hplc role marks Analytics-group analyses primary', () => {
    expect(computePrimaryAnalysisUids(analyses, 'hplc')).toEqual(new Set(['mk1:3']))
  })

  it('endo role marks ENDO-prefixed keywords primary', () => {
    expect(computePrimaryAnalysisUids(analyses, 'endo')).toEqual(new Set(['mk1:1']))
  })

  it('ster role marks STER-prefixed keywords primary', () => {
    expect(computePrimaryAnalysisUids(analyses, 'ster')).toEqual(new Set(['mk1:2']))
  })

  it('xtra and null roles mark nothing primary', () => {
    expect(computePrimaryAnalysisUids(analyses, 'xtra').size).toBe(0)
    expect(computePrimaryAnalysisUids(analyses, null).size).toBe(0)
  })

  it('skips analyses without a uid', () => {
    const noUid = [mkAnalysis({ uid: undefined as unknown as string, keyword: 'ENDO' })]
    expect(computePrimaryAnalysisUids(noUid, 'endo').size).toBe(0)
  })
})

describe('patchAnalysisInList', () => {
  it('patches result and review_state on the matching uid only', () => {
    const list = [
      mkAnalysis({ uid: 'mk1:1', result: '', review_state: 'unassigned' }),
      mkAnalysis({ uid: 'mk1:2', result: '5.0', review_state: 'to_be_verified' }),
    ]
    const out = patchAnalysisInList(list, 'mk1:1', '9.9', 'to_be_verified')
    expect(out[0]).toMatchObject({ result: '9.9', review_state: 'to_be_verified' })
    expect(out[1]).toBe(list[1]) // untouched rows keep identity
  })

  it('keeps the existing review_state when newReviewState is undefined', () => {
    const list = [mkAnalysis({ uid: 'mk1:1', review_state: 'unassigned' })]
    const out = patchAnalysisInList(list, 'mk1:1', '1.0', undefined)
    expect(out[0]).toMatchObject({ result: '1.0', review_state: 'unassigned' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/vial-quicklook-helpers.test.ts"`
Expected: FAIL — cannot resolve `@/components/senaite/vial-quicklook-helpers`.

- [ ] **Step 3: Create the helpers file**

Create `src/components/senaite/vial-quicklook-helpers.tsx`. The badge code is MOVED verbatim from `SampleDetails.tsx:1218-1243`; the uid computation is the loop body from `SampleDetails.tsx:1956-1972` as a pure function.

```tsx
/**
 * Shared helpers for the vial analyses surfaces (SampleDetails vial mode and
 * VialsQuickLookDialog). Extracted from SampleDetails.tsx so the quick-look
 * dialog can use them without a circular import.
 */
import { cn } from '@/lib/utils'
import type { SenaiteAnalysis } from '@/lib/api'

// --- Role header badge ---
// Mirrors the palette in VialDetailsTab.tsx / VialsList.tsx / SenaiteDashboard.tsx /
// InboxVialCard.tsx. Moved here from SampleDetails.tsx (was the fifth inline copy);
// dedup of the remaining copies is a tracked fast-follow, not in scope here.
export const ROLE_HEADER_BADGES: Record<string, { label: string; cls: string }> = {
  hplc: { label: 'HPLC',   cls: 'bg-sky-500/15 text-sky-700 border-sky-500/40 dark:text-sky-300' },
  endo: { label: 'ENDO',   cls: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40 dark:text-emerald-300' },
  ster: { label: 'STERYL', cls: 'bg-violet-500/15 text-violet-700 border-violet-500/40 dark:text-violet-300' },
  xtra: { label: 'XTRA',   cls: 'bg-zinc-500/15 text-zinc-700 border-zinc-500/40 dark:text-zinc-300' },
}

export function RoleHeaderBadge({ role }: { role: string }) {
  const b = ROLE_HEADER_BADGES[role]
  if (!b) return null
  return (
    <span
      className={cn(
        'inline-block text-[10px] leading-none px-1.5 py-0.5 rounded border uppercase tracking-wide font-medium',
        b.cls,
      )}
      title={`Vial assignment: ${b.label}`}
    >
      {b.label}
    </span>
  )
}

/**
 * Build the set of analysis UIDs that are "primary" for a vial-assignment
 * role — used to highlight (not filter) rows in the analyses table. Mapping:
 *   hplc → analyses in service_group 'Analytics'
 *   endo → keyword starts with 'ENDO' (within Microbiology)
 *   ster → keyword starts with 'STER' (within Microbiology)
 *   xtra → no primary analyses (vial parked for backup)
 */
export function computePrimaryAnalysisUids(
  analyses: SenaiteAnalysis[],
  role: string | null
): Set<string> {
  const set = new Set<string>()
  if (!role) return set
  for (const a of analyses) {
    if (!a.uid) continue
    const kw = (a.keyword ?? '').toUpperCase()
    const groupName = a.service_group_name ?? ''
    if (role === 'hplc') {
      if (groupName === 'Analytics') set.add(a.uid)
    } else if (role === 'endo') {
      if (kw.startsWith('ENDO')) set.add(a.uid)
    } else if (role === 'ster') {
      if (kw.startsWith('STER')) set.add(a.uid)
    }
  }
  return set
}

/**
 * Immutable single-row patch used by onResultSaved/onMethodInstrumentSaved
 * cache updates. Mirrors the setData mapping in SampleDetails.tsx:3592-3604.
 */
export function patchAnalysisInList(
  list: SenaiteAnalysis[],
  uid: string,
  newResult: string,
  newReviewState: string | undefined
): SenaiteAnalysis[] {
  return list.map(a =>
    a.uid === uid
      ? { ...a, result: newResult, review_state: newReviewState ?? a.review_state }
      : a
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/vial-quicklook-helpers.test.ts"`
Expected: PASS (7 tests).

- [ ] **Step 5: Re-point SampleDetails at the helpers**

In `src/components/senaite/SampleDetails.tsx`:

1. Delete the `ROLE_HEADER_BADGES` const and `RoleHeaderBadge` function (the block at lines ~1218-1243, including the `// --- Role header badge ---` comment).
2. Add to the imports near the other `./` senaite imports:

```typescript
import {
  RoleHeaderBadge,
  computePrimaryAnalysisUids,
} from './vial-quicklook-helpers'
```

3. Replace the `primaryAnalysisUids` useMemo (lines ~1949-1972 — keep the explanatory comment above it if you like, the helper carries its own copy) with:

```typescript
const primaryAnalysisUids = useMemo(
  () => computePrimaryAnalysisUids(data?.analyses ?? [], currentAssignment),
  [data, currentAssignment]
)
```

- [ ] **Step 6: Run the full FE suite + typecheck (behavior must be unchanged)**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/"`
Expected: only the known `peptide-requests-list` flake may fail; everything else PASS.

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit"`
Expected: exactly the 2 known pre-existing errors.

- [ ] **Step 7: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add src/components/senaite/vial-quicklook-helpers.tsx src/components/senaite/SampleDetails.tsx src/test/vial-quicklook-helpers.test.ts
git commit -m "refactor(fe): extract role badge + primary-uid helpers for vials quick look

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `VialsQuickLookDialog` component

**Files:**
- Create: `src/components/senaite/VialsQuickLookDialog.tsx`
- Test: `src/test/vials-quicklook.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/test/vials-quicklook.test.tsx`. Mock `@/lib/api` partially (keep real exports so `AnalysisTable`'s imports resolve), and stub `navigateToSample` on the UI store.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { VialsQuickLookDialog } from '@/components/senaite/VialsQuickLookDialog'
import { useUIStore } from '@/store/ui-store'
import type { SenaiteAnalysis, SubSampleListResponse } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    listSubSamples: vi.fn(),
    listLimsAnalysesForSubSample: vi.fn(),
    listParentLineStates: vi.fn(),
    fetchSubSamplePhotoUrl: vi.fn(),
  }
})

import {
  listSubSamples,
  listLimsAnalysesForSubSample,
  listParentLineStates,
  fetchSubSamplePhotoUrl,
} from '@/lib/api'

const mkAnalysis = (over: Partial<SenaiteAnalysis>): SenaiteAnalysis =>
  ({
    uid: 'mk1:1',
    keyword: 'ENDO',
    title: 'Endotoxin',
    result: '',
    review_state: 'unassigned',
    service_group_name: 'Microbiology',
    ...over,
  }) as SenaiteAnalysis

const SUBS: SubSampleListResponse = {
  parent: {
    sample_id: 'P-0144',
    external_lims_uid: null,
    peptide_name: 'BPC-157',
    status: 'received',
    sub_sample_count: 2,
    last_synced_at: '2026-06-05T00:00:00Z',
    assignment_role: 'hplc',
  },
  sub_samples: [
    {
      id: 22,
      sample_id: 'P-0144-S02',
      parent_sample_id: 'P-0144',
      vial_sequence: 2,
      received_at: '2026-06-01T00:00:00Z',
      received_by_user_id: null,
      photo_external_uid: null,
      remarks: null,
      assignment_role: 'endo',
    },
    {
      id: 21,
      sample_id: 'P-0144-S01',
      parent_sample_id: 'P-0144',
      vial_sequence: 1,
      received_at: '2026-06-01T00:00:00Z',
      received_by_user_id: null,
      photo_external_uid: 'attach-uid-1',
      remarks: null,
      assignment_role: 'hplc',
    },
  ],
}

function renderDialog(onOpenChange = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <VialsQuickLookDialog
        open
        onOpenChange={onOpenChange}
        parentSampleId="P-0144"
        analyteNameMap={new Map()}
      />
    </QueryClientProvider>
  )
  return { onOpenChange }
}

beforeEach(() => {
  vi.mocked(listSubSamples).mockResolvedValue(SUBS)
  vi.mocked(listParentLineStates).mockResolvedValue({ states: {} })
  vi.mocked(fetchSubSamplePhotoUrl).mockResolvedValue('blob:fake-photo-1')
  vi.mocked(listLimsAnalysesForSubSample).mockImplementation(async pk =>
    pk === 21
      ? [mkAnalysis({ uid: 'mk1:101', keyword: 'PUR-HPLC', title: 'Purity (HPLC)', service_group_name: 'Analytics' })]
      : [mkAnalysis({ uid: 'mk1:201', keyword: 'ENDO', title: 'Endotoxin' })]
  )
})

describe('VialsQuickLookDialog', () => {
  it('renders one section per vial ordered by vial_sequence with role badges', async () => {
    renderDialog()
    const headers = await screen.findAllByTestId('quicklook-vial-header')
    expect(headers).toHaveLength(2)
    expect(headers[0]).toHaveTextContent('P-0144-S01')
    expect(headers[0]).toHaveTextContent('HPLC')
    expect(headers[1]).toHaveTextContent('P-0144-S02')
    expect(headers[1]).toHaveTextContent('ENDO')
    // each vial's analyses render through AnalysisTable
    expect(await screen.findByText('Purity (HPLC)')).toBeInTheDocument()
    expect(await screen.findByText('Endotoxin')).toBeInTheDocument()
  })

  it('shows the empty state for a vial with no analyses', async () => {
    vi.mocked(listLimsAnalysesForSubSample).mockResolvedValue([])
    renderDialog()
    const empties = await screen.findAllByText('No analyses assigned')
    expect(empties).toHaveLength(2)
  })

  it('isolates a failing vial: error + retry shown while sibling renders rows', async () => {
    vi.mocked(listLimsAnalysesForSubSample).mockImplementation(async pk => {
      if (pk === 22) throw new Error('boom')
      return [mkAnalysis({ uid: 'mk1:101', keyword: 'PUR-HPLC', title: 'Purity (HPLC)', service_group_name: 'Analytics' })]
    })
    renderDialog()
    expect(await screen.findByText('Purity (HPLC)')).toBeInTheDocument()
    expect(await screen.findByText(/Failed to load analyses/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('vial ID click navigates and closes the dialog', async () => {
    const navigateToSample = vi.fn()
    useUIStore.setState({ navigateToSample })
    const { onOpenChange } = renderDialog()
    const link = await screen.findByRole('button', { name: 'P-0144-S01' })
    await userEvent.click(link)
    expect(navigateToSample).toHaveBeenCalledWith('P-0144-S01')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows the photo thumb for vials with a photo, placeholder otherwise', async () => {
    renderDialog()
    const img = await screen.findByAltText('P-0144-S01 photo')
    expect(img).toHaveAttribute('src', 'blob:fake-photo-1')
    // S02 has photo_external_uid: null → placeholder, and no fetch for it
    expect(screen.getByText('no photo')).toBeInTheDocument()
    expect(fetchSubSamplePhotoUrl).toHaveBeenCalledTimes(1)
    expect(fetchSubSamplePhotoUrl).toHaveBeenCalledWith('P-0144-S01')
  })

  it('collapse toggle hides a vial table without unmounting siblings', async () => {
    renderDialog()
    await screen.findByText('Purity (HPLC)')
    const toggles = screen.getAllByRole('button', { name: /collapse vial/i })
    await userEvent.click(toggles[0]!)
    await waitFor(() => {
      expect(screen.queryByText('Purity (HPLC)')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Endotoxin')).toBeInTheDocument()
  })
})
```

Note: if the store exposes `navigateToSample` differently than `useUIStore.setState({ navigateToSample })` allows (check `src/store/ui-store.ts`), adapt the stub — the assertion stays the same.

- [ ] **Step 2: Run tests to verify they fail**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/vials-quicklook.test.tsx"`
Expected: FAIL — cannot resolve `@/components/senaite/VialsQuickLookDialog`.

- [ ] **Step 3: Implement the component**

Create `src/components/senaite/VialsQuickLookDialog.tsx`:

```tsx
/**
 * Vials Quick Look — a wide dialog on parent sample pages stacking every
 * vial's fully interactive AnalysisTable (same fields and behaviors as the
 * vial detail pages). Spec: docs/superpowers/specs/2026-06-05-vials-quicklook-design.md
 *
 * Data: one listSubSamples + one listParentLineStates + N parallel
 * listLimsAnalysesForSubSample (TanStack Query, enabled only while open).
 * The vial pages load analyses with local state and refetch on mount, so the
 * dialog's 'quicklook-*' query keys are private to this surface.
 */
import { useEffect, useState } from 'react'
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  listSubSamples,
  listLimsAnalysesForSubSample,
  listParentLineStates,
  fetchSubSamplePhotoUrl,
} from '@/lib/api'
import type { SenaiteAnalysis, SubSample } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import { AnalysisTable } from './AnalysisTable'
import {
  RoleHeaderBadge,
  computePrimaryAnalysisUids,
  patchAnalysisInList,
} from './vial-quicklook-helpers'

interface VialsQuickLookDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Parent sample ID, e.g. "P-0144". Only rendered on parent pages. */
  parentSampleId: string
  /** Slot number → display peptide name, computed by SampleDetails. */
  analyteNameMap: Map<number, string>
  /**
   * Called after a transition completes in any vial table. Promote/retest can
   * mutate parent-AR rows, so the parent page underneath should refresh.
   */
  onParentDataStale?: () => void
}

const vialAnalysesKey = (subSamplePk: number) =>
  ['quicklook-vial-analyses', subSamplePk] as const

/**
 * Vial photo thumbnail. Mirrors the private VialThumb in
 * intake/ReceiveWizard/VialsList.tsx:44 (fetchSubSamplePhotoUrl is
 * module-level cached, so repeated opens are free). Kept local — VialThumb
 * is not exported and dedup of the wizard copies is out of scope.
 */
function VialPhotoThumb({ sampleId, hasPhoto }: { sampleId: string; hasPhoto: boolean }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!hasPhoto) {
      setUrl(null)
      return
    }
    let cancelled = false
    void fetchSubSamplePhotoUrl(sampleId)
      .then(u => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [sampleId, hasPhoto])

  return (
    <div className="w-12 h-12 rounded bg-muted/60 border shrink-0 overflow-hidden flex items-center justify-center">
      {url ? (
        <img src={url} alt={`${sampleId} photo`} className="w-full h-full object-cover" />
      ) : (
        <span className="text-[8px] text-muted-foreground">no photo</span>
      )}
    </div>
  )
}

export function VialsQuickLookDialog({
  open,
  onOpenChange,
  parentSampleId,
  analyteNameMap,
  onParentDataStale,
}: VialsQuickLookDialogProps) {
  const navigateToSample = useUIStore(state => state.navigateToSample)
  const queryClient = useQueryClient()
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())

  const { data: subData } = useQuery({
    queryKey: ['sub-samples', parentSampleId],
    queryFn: () => listSubSamples(parentSampleId),
    enabled: open,
  })
  const vials = [...(subData?.sub_samples ?? [])].sort(
    (a, b) => a.vial_sequence - b.vial_sequence
  )

  const { data: lineStatesData, refetch: refetchLineStates } = useQuery({
    queryKey: ['quicklook-parent-line-states', parentSampleId],
    queryFn: () => listParentLineStates(parentSampleId),
    enabled: open,
  })
  const parentLineStates = lineStatesData?.states

  const analysesQueries = useQueries({
    queries: vials.map(v => ({
      queryKey: vialAnalysesKey(v.id),
      queryFn: () => listLimsAnalysesForSubSample(v.id),
      enabled: open,
    })),
  })

  const toggleCollapsed = (pk: number) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(pk)) next.delete(pk)
      else next.add(pk)
      return next
    })
  }

  const goToVial = (sampleId: string) => {
    onOpenChange(false)
    navigateToSample(sampleId)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[90vw] xl:max-w-[1400px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Vials — {parentSampleId}</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto flex-1 space-y-4 pr-1">
          {vials.length === 0 && (
            <div className="flex justify-center py-8">
              <Loader2 size={18} className="animate-spin text-muted-foreground" />
            </div>
          )}
          {vials.map((vial, i) => (
            <VialSection
              key={vial.id}
              vial={vial}
              query={analysesQueries[i]!}
              analyteNameMap={analyteNameMap}
              parentLineStates={parentLineStates}
              isCollapsed={collapsed.has(vial.id)}
              onToggleCollapsed={() => toggleCollapsed(vial.id)}
              onNavigate={() => goToVial(vial.sample_id)}
              onResultSaved={(uid, newResult, newReviewState) => {
                queryClient.setQueryData<SenaiteAnalysis[]>(
                  vialAnalysesKey(vial.id),
                  prev => prev && patchAnalysisInList(prev, uid, newResult, newReviewState)
                )
              }}
              onMethodInstrumentSaved={(uid, field, newUid, newTitle) => {
                queryClient.setQueryData<SenaiteAnalysis[]>(
                  vialAnalysesKey(vial.id),
                  prev =>
                    prev?.map(a =>
                      a.uid === uid
                        ? field === 'method'
                          ? { ...a, method: newTitle, method_uid: newUid }
                          : { ...a, instrument: newTitle, instrument_uid: newUid }
                        : a
                    )
                )
              }}
              onTransitionComplete={() => {
                queryClient.invalidateQueries({ queryKey: vialAnalysesKey(vial.id) })
                refetchLineStates()
                onParentDataStale?.()
              }}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface VialSectionProps {
  vial: SubSample
  query: {
    data?: SenaiteAnalysis[]
    isLoading: boolean
    isError: boolean
    refetch: () => void
  }
  analyteNameMap: Map<number, string>
  parentLineStates: Record<string, string> | undefined
  isCollapsed: boolean
  onToggleCollapsed: () => void
  onNavigate: () => void
  onResultSaved: (uid: string, newResult: string, newReviewState?: string) => void
  onMethodInstrumentSaved: (
    uid: string,
    field: 'method' | 'instrument',
    newUid: string,
    newTitle: string
  ) => void
  onTransitionComplete: () => void
}

function VialSection({
  vial,
  query,
  analyteNameMap,
  parentLineStates,
  isCollapsed,
  onToggleCollapsed,
  onNavigate,
  onResultSaved,
  onMethodInstrumentSaved,
  onTransitionComplete,
}: VialSectionProps) {
  const analyses = query.data ?? []
  const primaryUids = computePrimaryAnalysisUids(analyses, vial.assignment_role)

  return (
    <div className="rounded-md border">
      <div
        data-testid="quicklook-vial-header"
        className="flex items-center gap-2 px-3 py-2 bg-muted/40"
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          aria-label={isCollapsed ? 'Expand vial' : 'Collapse vial'}
          onClick={onToggleCollapsed}
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </Button>
        <VialPhotoThumb
          sampleId={vial.sample_id}
          hasPhoto={!!vial.photo_external_uid}
        />
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 font-mono text-sm"
          onClick={onNavigate}
        >
          {vial.sample_id}
        </Button>
        {vial.assignment_role && <RoleHeaderBadge role={vial.assignment_role} />}
        <span className="text-xs text-muted-foreground ml-auto">
          {analyses.length} {analyses.length === 1 ? 'analysis' : 'analyses'}
          {' · received '}
          {new Date(vial.received_at).toLocaleDateString()}
        </span>
      </div>
      {!isCollapsed && (
        <div className="p-2">
          {query.isLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
            </div>
          ) : query.isError ? (
            <div className="flex items-center gap-3 px-2 py-3 text-sm text-destructive">
              Failed to load analyses for this vial.
              <Button variant="outline" size="sm" onClick={() => query.refetch()}>
                Retry
              </Button>
            </div>
          ) : analyses.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              No analyses assigned
            </p>
          ) : (
            <AnalysisTable
              analyses={analyses}
              analyteNameMap={analyteNameMap}
              primaryAnalysisUids={primaryUids}
              primaryRole={vial.assignment_role}
              parentLineStates={parentLineStates}
              onResultSaved={onResultSaved}
              onMethodInstrumentSaved={onMethodInstrumentSaved}
              onTransitionComplete={onTransitionComplete}
            />
          )}
        </div>
      )}
    </div>
  )
}
```

Implementation notes for the executor:
- Verify `AnalysisTable`'s prop types (`AnalysisTableProps` in `AnalysisTable.tsx:~1340`) — if `onResultSaved`'s `newReviewState` parameter type differs (e.g. `string | null`), match it exactly.
- Verify `useUIStore` exposes `navigateToSample` (it does — `SampleDetails.tsx:1811`).
- If shadcn's `DialogContent` width classes don't take effect, the component uses `cn()` with tailwind-merge so the `max-w-[90vw]` override wins; check `src/components/ui/dialog.tsx` if not.
- Do NOT pass SLA props — they are optional and out of scope (spec).
- Do NOT pass `promotionsByKeyword` — vial-tier tables never show the promoted-from badge (mirrors `SampleDetails.tsx:3590`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/vials-quicklook.test.tsx"`
Expected: PASS (6 tests). If `AnalysisTable` throws on missing optional fixture fields, extend `mkAnalysis` with the fields it reads (check the error, add the field with a sensible value) — do not weaken assertions.

- [ ] **Step 5: Commit**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add src/components/senaite/VialsQuickLookDialog.tsx src/test/vials-quicklook.test.tsx
git commit -m "feat(fe): vials quick-look dialog with per-vial interactive AnalysisTable

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire the button into the Analyses section of SampleDetails

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` (button row at ~3477-3490; dialog render near the other dialogs at the bottom of the JSX; one new state hook near `manageAnalysesOpen` at ~1866)

- [ ] **Step 1: Add state + imports**

In `src/components/senaite/SampleDetails.tsx`:

1. Import the dialog (with the other senaite imports) and the `Eye` icon (add to the existing `lucide-react` import list):

```typescript
import { VialsQuickLookDialog } from './VialsQuickLookDialog'
```

2. Add state next to `manageAnalysesOpen` (~line 1866):

```typescript
const [vialsQuickLookOpen, setVialsQuickLookOpen] = useState(false)
```

- [ ] **Step 2: Replace the Manage Analyses button row**

Replace the block at ~3477-3490:

```tsx
        {/* Manage Analyses */}
        {data.review_state && (
          <div className="mb-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={openManageAnalyses}
            >
              <Plus size={13} />
              Manage Analyses
            </Button>
          </div>
        )}
```

with:

```tsx
        {/* Manage Analyses + Vials Quick Look */}
        {data.review_state && (
          <div className="mb-2 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={openManageAnalyses}
            >
              <Plus size={13} />
              Manage Analyses
            </Button>
            {parentSampleId === null && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                disabled={subSamples.length === 0}
                title={subSamples.length === 0 ? 'No vials yet' : undefined}
                onClick={() => setVialsQuickLookOpen(true)}
              >
                <Eye size={13} />
                Vials Quick Look
              </Button>
            )}
          </div>
        )}
```

`Eye` must be added to the `lucide-react` import. `subSamples` is already in scope (line ~1885) — note this LIKELY clears the known pre-existing tsc unused-variable error for `subSamples`; if so, the typecheck baseline drops to 1 known error. Report that, don't chase it.

- [ ] **Step 3: Render the dialog**

Immediately after the `<AnalysisTable ... />` usage ends (~line 3626), add:

```tsx
        {parentSampleId === null && data.sample_id && (
          <VialsQuickLookDialog
            open={vialsQuickLookOpen}
            onOpenChange={setVialsQuickLookOpen}
            parentSampleId={data.sample_id}
            analyteNameMap={analyteNameMap}
            onParentDataStale={() => refreshSample(data.sample_id)}
          />
        )}
```

- [ ] **Step 4: Full suite + typecheck**

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/vitest run src/test/"`
Expected: all pass except (possibly) the known peptide-requests-list flake.

Run: `MSYS_NO_PATHCONV=1 docker exec accumark-subvial-accu-mk1-frontend sh -c "cd /app && node_modules/.bin/tsc --noEmit"`
Expected: the `WorksheetsInboxPage.tsx(356,38)` error, and the `SampleDetails` unused-`subSamples` error ONLY if Step 2 didn't consume it. No new errors.

- [ ] **Step 5: Commit and push**

```bash
cd C:/tmp/Accu-Mk1-subvial
git add src/components/senaite/SampleDetails.tsx
git commit -m "feat(fe): Vials Quick Look button in parent Analyses section

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
```

---

### Task 4: Live UAT on the subvial stack (user-driven)

No code. Drive the user through:

1. Browser: `http://localhost:5532`, login `forrest@valenceanalytical.com / test123`, API override `sessionStorage.setItem('accu_mk1_api_url_override','http://localhost:5530')` if a fresh tab.
2. Open parent sample **P-0144** → Analyses section → **Vials Quick Look** button appears next to Manage Analyses (button gating check: open any vial page, e.g. P-0144-S01 — button must NOT appear).
3. Dialog: every vial listed in sequence order, role badges tinted, counts correct, photo thumbnails render for vials that have intake photos ("no photo" placeholder otherwise). P-0144 has known retest-sibling noise — expect folded retest chains on vial #2259's line.
4. Interactivity: edit a result inline on one vial → saves; run a transition → row updates and the parent page refreshes underneath when the dialog closes; verify lock icons appear for any keyword whose parent line is verified.
5. Vial ID click → navigates to the vial page, dialog closes.
6. Watch for the spec's nested-dialog risk: open the bulk-promote flow from inside a vial table in the dialog and confirm it renders/stacks correctly.
