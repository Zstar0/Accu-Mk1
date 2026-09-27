# Mk1-native retest, plan 4 of 4: Mk1 frontend (Retest overlay + chips)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the lab start a retest from the parent sample-details page (Retest overlay: Retest / Carry per profile, Add services with prices, Paid / Free, auto check-in, reason) and make carried / retesting / added lines visible on the analyses table and the original's page.

**Architecture:** New `RetestDialog` component + `use-retest` hooks built on plan 1's endpoints (`GET /api/samples/{id}/retest-options`, `POST /api/samples/{id}/retest`, `GET /samples/{id}/retest-info`). Chips derive from data the page already loads: promotions (`contribution_kind === 'carried'`) and the retest-info rider (`retest` / `add` profile keys) joined to rows by `profile_section_key`. `SampleDetails.tsx` gets a menu item, a dialog mount, one extra prop on `AnalysisTable`, and a richer "Retested as" line. One tiny backend addition (Task 0) exposes the rider's sets on the retest sample's own `retest-info`.

**Tech Stack:** React 19, TanStack Query, Zustand (selector syntax only), shadcn/ui (`@/components/ui/*`), Tailwind v4, sonner toasts, vitest + @testing-library/react. **npm only.**

**Spec:** `docs/superpowers/specs/2026-09-23-mk1-native-retest-design.md` sections 2, 4.1, 4.2, 4.3 (read first). Backend contract: `backend/lims_analyses/retest_routes.py` (this branch).

## Global Constraints

- Additive only: no existing prop or function signature changes; new props optional.
- Zustand: `useUIStore(s => s.field)` one field at a time, never destructure (ast-grep rule). `use*` hooks live in `src/hooks/`, never `src/lib/`.
- `SampleDetails.tsx` is 7.5k lines with no render-test harness: keep its edits to the four named touch points; all logic lives in the new files, which ARE tested.
- Copy is hardcoded English like the rest of the sample page (no i18n on this page). No em dashes in code, copy, or commits (use `·`, `,` or a plain hyphen).
- Overlay rules (spec 4.1): every original profile defaults to **Carry** when carry-eligible and to **Retest (locked)** when not; Create is disabled until at least one profile is Retest OR at least one add-on is ticked OR variance points > 0; the Paid / Free control is hidden when nothing is set to Retest; Add rows show only catalog add-ons the original does not have AND that have a `wp_type` (the WP-sellable set); Variance row enabled only when `variance.allowed` and an HPLC profile is set to Retest; prices render "price unavailable" (never 0) when `prices_available` is false; a running total ("Delta") sums added prices + variance `(points - 1) * point_price`.
- Gate: `npm run typecheck && npm run lint && npm run ast:lint && npm run format:check` clean for the changed files (run `npx prettier --write <new files>` before committing) and `npx vitest run src/test/<new tests>` green; the full `npm run test:run` failure set compared against the branch base (34 known failures per memory; zero net-new).
- Commit only the files each task names, `git add <paths>` + `git commit -- <paths>`; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Branch `feat/native-retest-ui` (cut from `feat/native-retest-backend`); the PR targets `feat/native-retest-backend`.

## Shared vocabulary (exact names later tasks use)

```ts
// src/lib/api.ts additions (Task 1)
export interface RetestForwardLink { sample_id: string; order_id: number | null; created_at: string | null;
  status?: string | null; retest?: string[]; carry?: string[]; add?: string[] }
export interface SampleRetestInfo { ...existing...; source?: 'mk1' | 'integration_db';
  retest?: string[]; carry?: string[]; add?: string[] }          // present when is_retest (Task 0)
export interface RetestOptionProfile { key: string; name: string; carry_eligible: boolean; state: string | null }
export interface RetestOptionAddon { key: string; name: string; wp_type: string | null; price: number | null; vials: number | null }
export interface RetestOptions { sample_id: string; status: string | null; order_number: string | null;
  profiles: RetestOptionProfile[]; addons: RetestOptionAddon[];
  variance: { point_price: number | null; allowed: boolean }; prices_available: boolean }
export interface RetestRequestBody { retest: string[]; carry: string[];
  add: { profiles: string[]; variance_points: number; additional_vials: number } | null;
  auto_checkin: boolean; fee: 'paid' | 'free'; reason: string }
export interface RetestCreated { order_id?: number; order_number?: string; status?: string; payment_url?: string | null }
export function getRetestOptions(sampleId: string): Promise<RetestOptions>
export function createRetest(sampleId: string, body: RetestRequestBody): Promise<RetestCreated>   // throws Error(detail) on 4xx/5xx
// ParentPromotionInfo.sources[] gains parent_sample_id?: string | null
export const HPLC_PROFILE_KEYS = ['hplcpurity_identity', 'hplc-purity-identity'] as const
```

---

### Task 0: `retest-info` exposes the rider's sets on the retest sample itself (backend)

**Files:**
- Modify: `backend/main.py` (`get_sample_retest_info`, the `if row.retest_of_sample_id:` block ~line 951)
- Test: `backend/tests/test_retest_info_mk1_first.py` (extend the first test)

**Interfaces:**
- Produces: when `is_retest`, the top-level response also carries `"retest": [...]`, `"carry": [...]`, `"add": [...]` (profile keys from `catalog_snapshot["retest"]`; empty lists when the rider is absent, e.g. a legacy WP-made retest).

- [ ] **Step 1: Extend the failing test.** In `test_mk1_lineage_wins_and_skips_the_integration_db`, after the P-3017 assertions add:
  ```python
  assert body["retest"] == ["hplcpurity_identity"] and body["carry"] == ["heavy_metals"] and body["add"] == []
  ```
  Run `python -m pytest tests/test_retest_info_mk1_first.py -q` from `backend/`: FAIL with KeyError `'retest'`.
- [ ] **Step 2: Implement.** Inside the `if row.retest_of_sample_id:` block add:
  ```python
            result["retest"] = rider.get("retest") or []
            result["carry"] = rider.get("carry") or []
            result["add"] = (rider.get("add") or {}).get("profiles") or []
  ```
- [ ] **Step 3: Run** the same test file: PASS. Also `python -m pytest tests/test_retest_routes.py -q` unchanged.
- [ ] **Step 4: Commit** `backend/main.py backend/tests/test_retest_info_mk1_first.py`: `feat(retest): retest-info exposes the spec's retest/carry/add sets on the retest sample`.

---

### Task 1: API types + fetchers

**Files:**
- Modify: `src/lib/api.ts` (next to `SampleRetestInfo` ~line 7100 and `ParentPromotionInfo` ~line 7374)
- Test: `src/test/retest-api.test.ts` (new)

**Interfaces:** the "Shared vocabulary" block above, verbatim.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRetest, getRetestOptions } from '@/lib/api'

vi.mock('@/store/auth-store', () => ({ getAuthToken: () => 'tok' }))

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300, status,
    json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)),
  })
  vi.stubGlobal('fetch', fn)
  return fn
}
afterEach(() => vi.unstubAllGlobals())

describe('retest api', () => {
  it('getRetestOptions hits /api/samples/{id}/retest-options with auth', async () => {
    const fn = stubFetch(200, { sample_id: 'P-1', profiles: [], addons: [], variance: { point_price: null, allowed: false }, prices_available: false, status: null, order_number: null })
    const out = await getRetestOptions('P-1')
    expect(out.sample_id).toBe('P-1')
    const [url, init] = fn.mock.calls[0]
    expect(String(url)).toMatch(/\/api\/samples\/P-1\/retest-options$/)
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' })
  })
  it('createRetest posts the body and returns WP json', async () => {
    const fn = stubFetch(200, { order_number: 'WP-7920', payment_url: 'https://x' })
    const body = { retest: ['hplc-purity-identity'], carry: ['heavy_metals'], add: null, auto_checkin: true, fee: 'paid' as const, reason: 'r' }
    const out = await createRetest('P-1', body)
    expect(out.order_number).toBe('WP-7920')
    const [, init] = fn.mock.calls[0]
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual(body)
  })
  it('createRetest surfaces the server detail on 400', async () => {
    stubFetch(400, { detail: "every profile on P-1 must be retested or carried; missing: ['heavy_metals']" })
    await expect(createRetest('P-1', { retest: ['x'], carry: [], add: null, auto_checkin: false, fee: 'free', reason: 'r' }))
      .rejects.toThrow(/heavy_metals/)
  })
  it('createRetest falls back to a status message when detail is absent', async () => {
    stubFetch(502, {})
    await expect(createRetest('P-1', { retest: ['x'], carry: [], add: null, auto_checkin: false, fee: 'free', reason: 'r' }))
      .rejects.toThrow(/502/)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/test/retest-api.test.ts`: FAIL (exports missing).
- [ ] **Step 3: Implement** in `src/lib/api.ts`. Extend `RetestForwardLink` and `SampleRetestInfo` with the optional fields from the vocabulary block (keep existing fields). Add `parent_sample_id?: string | null` to the inline `sources` element type of `ParentPromotionInfo`. Then add, next to `getSampleRetestInfo`:

```ts
export const HPLC_PROFILE_KEYS = ['hplcpurity_identity', 'hplc-purity-identity'] as const

export interface RetestOptionProfile { key: string; name: string; carry_eligible: boolean; state: string | null }
export interface RetestOptionAddon { key: string; name: string; wp_type: string | null; price: number | null; vials: number | null }
export interface RetestOptions {
  sample_id: string
  status: string | null
  order_number: string | null
  profiles: RetestOptionProfile[]
  addons: RetestOptionAddon[]
  variance: { point_price: number | null; allowed: boolean }
  prices_available: boolean
}
export interface RetestRequestBody {
  retest: string[]
  carry: string[]
  add: { profiles: string[]; variance_points: number; additional_vials: number } | null
  auto_checkin: boolean
  fee: 'paid' | 'free'
  reason: string
}
export interface RetestCreated { order_id?: number; order_number?: string; status?: string; payment_url?: string | null }

export function getRetestOptions(sampleId: string): Promise<RetestOptions> {
  return apiFetch<RetestOptions>(`/api/samples/${encodeURIComponent(sampleId)}/retest-options`)
}

export async function createRetest(sampleId: string, body: RetestRequestBody): Promise<RetestCreated> {
  const response = await fetch(`${API_BASE_URL()}/api/samples/${encodeURIComponent(sampleId)}/retest`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    const detail = err?.detail
    throw new Error((typeof detail === 'string' ? detail : detail?.message) || `Retest request failed: ${response.status}`)
  }
  return response.json()
}
```

- [ ] **Step 4: Run** the test: PASS. `npm run typecheck` clean.
- [ ] **Step 5: Commit** `src/lib/api.ts src/test/retest-api.test.ts`: `feat(retest-ui): retest-options / create-retest api + richer retest-info types`.

---

### Task 2: Pure chip logic

**Files:**
- Create: `src/lib/retest-chips.ts`
- Test: `src/test/retest-chips.test.ts` (new)

**Interfaces:**
```ts
export type RetestLineChip = 'retesting' | 'added' | null
export function retestChipFor(
  row: Pick<SenaiteAnalysis, 'provenance' | 'profile_section_key'>,
  info: Pick<SampleRetestInfo, 'is_retest' | 'retest' | 'add'> | null | undefined
): RetestLineChip                       // 'retesting' when an ORDERED row's section key is in info.retest; 'added' when in info.add; else null
export function isCarriedPromotion(p: Pick<ParentPromotionInfo, 'sources'> | undefined): boolean   // any source has contribution_kind 'carried'
export function carriedSourceLabel(p: Pick<ParentPromotionInfo, 'sources'>): string   // 'P-9001-S02' (vial) or 'P-9001' (parent_sample_id) or 'original'
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { retestChipFor, isCarriedPromotion, carriedSourceLabel } from '@/lib/retest-chips'

const info = { is_retest: true, retest: ['hplc-purity-identity'], add: ['rapid-sterility-pcr'] }

describe('retestChipFor', () => {
  it('flags ordered rows of retested and added profiles', () => {
    expect(retestChipFor({ provenance: 'ordered', profile_section_key: 'hplc-purity-identity' }, info)).toBe('retesting')
    expect(retestChipFor({ provenance: 'ordered', profile_section_key: 'rapid-sterility-pcr' }, info)).toBe('added')
  })
  it('never flags canonical rows, other profiles, or non-retest samples', () => {
    expect(retestChipFor({ provenance: 'canonical', profile_section_key: 'hplc-purity-identity' }, info)).toBeNull()
    expect(retestChipFor({ provenance: 'ordered', profile_section_key: 'heavy_metals' }, info)).toBeNull()
    expect(retestChipFor({ provenance: 'ordered', profile_section_key: 'hplc-purity-identity' }, { is_retest: false })).toBeNull()
    expect(retestChipFor({ provenance: 'ordered', profile_section_key: null }, info)).toBeNull()
    expect(retestChipFor({ provenance: 'ordered', profile_section_key: 'hplc-purity-identity' }, null)).toBeNull()
  })
})

describe('carried promotions', () => {
  const carried = { sources: [{ sample_id: 'P-9001-S02', contribution_kind: 'carried', parent_sample_id: 'P-9001' }] }
  it('detects carried links', () => {
    expect(isCarriedPromotion(carried)).toBe(true)
    expect(isCarriedPromotion({ sources: [{ sample_id: 'P-1-S01', contribution_kind: 'chosen' }] })).toBe(false)
    expect(isCarriedPromotion(undefined)).toBe(false)
  })
  it('labels the vial, else the parent sample, else "original"', () => {
    expect(carriedSourceLabel(carried)).toBe('P-9001-S02')
    expect(carriedSourceLabel({ sources: [{ sample_id: null, contribution_kind: 'carried', parent_sample_id: 'P-9001' }] })).toBe('P-9001')
    expect(carriedSourceLabel({ sources: [{ sample_id: null, contribution_kind: 'carried' }] })).toBe('original')
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/test/retest-chips.test.ts`: FAIL (module missing).
- [ ] **Step 3: Implement** `src/lib/retest-chips.ts`:

```ts
import type { ParentPromotionInfo, SampleRetestInfo, SenaiteAnalysis } from './api'

export type RetestLineChip = 'retesting' | 'added' | null

/** Chip for an ORDERED placeholder line on a retest sample: the profile is
 *  being re-run ('retesting') or was bought new on the retest ('added'). */
export function retestChipFor(
  row: Pick<SenaiteAnalysis, 'provenance' | 'profile_section_key'>,
  info: Pick<SampleRetestInfo, 'is_retest' | 'retest' | 'add'> | null | undefined
): RetestLineChip {
  if (!info?.is_retest || row.provenance !== 'ordered' || !row.profile_section_key) return null
  if (info.retest?.includes(row.profile_section_key)) return 'retesting'
  if (info.add?.includes(row.profile_section_key)) return 'added'
  return null
}

export function isCarriedPromotion(p: Pick<ParentPromotionInfo, 'sources'> | undefined): boolean {
  return Boolean(p?.sources.some(s => s.contribution_kind === 'carried'))
}

/** Where a carried result came from: the original vial, else the original sample. */
export function carriedSourceLabel(p: Pick<ParentPromotionInfo, 'sources'>): string {
  const s = p.sources.find(x => x.contribution_kind === 'carried') ?? p.sources[0]
  return s?.sample_id ?? s?.parent_sample_id ?? 'original'
}
```

- [ ] **Step 4: Run** the test: PASS.
- [ ] **Step 5: Commit** `src/lib/retest-chips.ts src/test/retest-chips.test.ts`: `feat(retest-ui): pure chip logic for carried / retesting / added lines`.

---

### Task 3: Chips on the analyses table

**Files:**
- Modify: `src/components/senaite/PromotedFromBadge.tsx`
- Modify: `src/components/senaite/AnalysisTable.tsx` (`AnalysisTableProps` ~2017, `AnalysisRow` props ~1514 and its title cell ~1663, the `AnalysisTable` -> `AnalysisRow` prop pass-through)
- Test: `src/test/promoted-from-badge.test.tsx` (new), `src/test/retest-line-chip.test.tsx` (new)

**Interfaces:**
- `PromotedFromBadge` renders a violet "Carried from <label>" variant when `isCarriedPromotion(promotion)`; the link still targets the vial (or the parent sample id when there is no vial). Tooltip: `Carried from <parent_sample_id ?? label>, promoted <date> by <email>`.
- New exported `RetestLineChip({ kind }: { kind: 'retesting' | 'added' })` in `AnalysisTable.tsx` next to `VarianceChip`: violet outline "Retesting" / emerald outline "Added", `title` explaining it.
- `AnalysisTableProps.retestInfo?: SampleRetestInfo | null` (optional, threaded to `AnalysisRow`), used only to render `RetestLineChip` after the `PromotedFromBadge` in the title cell.

- [ ] **Step 1: Write the failing tests**

`src/test/promoted-from-badge.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PromotedFromBadge } from '@/components/senaite/PromotedFromBadge'

const base = { keyword: 'ARSENIC-PPM', parent_analysis_id: 1, promoted_at: '2026-09-26T03:13:56', promoted_by_email: 'josh@x' }

describe('PromotedFromBadge', () => {
  it('renders the classic "from" link for a chosen promotion', () => {
    render(<PromotedFromBadge promotion={{ ...base, sources: [{ sample_id: 'P-1-S01', contribution_kind: 'chosen' }] }} />)
    expect(screen.getByText(/^from/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'P-1-S01' })).toHaveAttribute('href', '/#senaite/sample-details?id=P-1-S01')
    expect(screen.queryByText(/carried/i)).not.toBeInTheDocument()
  })
  it('renders "Carried from <vial>" for a carried promotion, linking the original vial', () => {
    render(<PromotedFromBadge promotion={{ ...base, sources: [{ sample_id: 'P-9001-S02', contribution_kind: 'carried', parent_sample_id: 'P-9001' }] }} />)
    expect(screen.getByText(/carried from/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'P-9001-S02' })).toHaveAttribute('href', '/#senaite/sample-details?id=P-9001-S02')
    expect(screen.getByLabelText(/carried from original/i)).toHaveAttribute('title', expect.stringMatching(/Carried from P-9001/))
  })
  it('falls back to the parent sample when the carried source has no vial', () => {
    render(<PromotedFromBadge promotion={{ ...base, sources: [{ sample_id: null, contribution_kind: 'carried', parent_sample_id: 'P-9001' }] }} />)
    expect(screen.getByRole('link', { name: 'P-9001' })).toHaveAttribute('href', '/#senaite/sample-details?id=P-9001')
  })
})
```

`src/test/retest-line-chip.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RetestLineChip } from '@/components/senaite/AnalysisTable'

describe('RetestLineChip', () => {
  it('renders both kinds with explanatory titles', () => {
    render(<><RetestLineChip kind="retesting" /><RetestLineChip kind="added" /></>)
    expect(screen.getByText('Retesting')).toHaveAttribute('title', expect.stringMatching(/re-run on this retest/i))
    expect(screen.getByText('Added')).toHaveAttribute('title', expect.stringMatching(/added on this retest/i))
  })
})
```

- [ ] **Step 2: Run** both: FAIL.
- [ ] **Step 3: Implement**

`PromotedFromBadge.tsx`: import `isCarriedPromotion, carriedSourceLabel` from `@/lib/retest-chips` and `RefreshCw` from lucide. When carried:

```tsx
  if (isCarriedPromotion(promotion)) {
    const src = promotion.sources.find(s => s.contribution_kind === 'carried') ?? promotion.sources[0]
    const label = carriedSourceLabel(promotion)
    const target = src?.sample_id ?? src?.parent_sample_id ?? null
    const origin = src?.parent_sample_id ?? label
    return (
      <span
        title={`Carried from ${origin}, promoted ${datePart} by ${byWhom}`}
        aria-label="Carried from original"
        className="inline-flex items-center gap-1 rounded-md border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300 shrink-0"
      >
        <RefreshCw size={10} className="shrink-0" />
        {'Carried from '}
        {target ? (
          <a href={`/#senaite/sample-details?id=${target}`} className="underline underline-offset-2 hover:text-foreground" onClick={e => e.stopPropagation()}>
            {label}
          </a>
        ) : (
          label
        )}
      </span>
    )
  }
```
placed after the `if (!promotion) return null` line (compute `datePart` / `byWhom` before it).

`AnalysisTable.tsx`: add next to `VarianceChip`:

```tsx
export function RetestLineChip({ kind }: { kind: 'retesting' | 'added' }) {
  const retesting = kind === 'retesting'
  return (
    <span
      title={retesting
        ? 'This service is being re-run on this retest; a new vial result will be promoted here.'
        : 'This service was added on this retest; it was not on the original sample.'}
      className={retesting
        ? 'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/20'
        : 'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/20'}
    >
      {retesting ? 'Retesting' : 'Added'}
    </span>
  )
}
```
Add `retestInfo?: SampleRetestInfo | null` to `AnalysisTableProps` and to `AnalysisRow`'s props (import the type from `@/lib/api`, `retestChipFor` from `@/lib/retest-chips`), pass it through wherever `AnalysisTable` renders `<AnalysisRow ... promotions={promotions}` (add `retestInfo={retestInfo}`), and in the title cell right after the `<PromotedFromBadge .../>` line:

```tsx
          {(() => { const chip = retestChipFor(analysis, retestInfo); return chip ? <RetestLineChip kind={chip} /> : null })()}
```

- [ ] **Step 4: Run** `npx vitest run src/test/promoted-from-badge.test.tsx src/test/retest-line-chip.test.tsx src/test/analysis-table*.test.tsx` (existing table tests must keep their result) and `npm run typecheck`.
- [ ] **Step 5: Commit** the four files: `feat(retest-ui): Carried-from badge and Retesting / Added chips on the analyses table`.

---

### Task 4: Hooks

**Files:**
- Create: `src/hooks/use-retest.ts`
- Test: `src/test/use-retest.test.tsx` (new)

**Interfaces:**
```ts
export const RETEST_OPTIONS_KEY = 'retest-options'
export function useRetestOptions(sampleId: string | null, enabled: boolean)   // useQuery, key [RETEST_OPTIONS_KEY, sampleId], staleTime 30s, retry false
export function useCreateRetest(sampleId: string, opts: { onCreated?: (r: RetestCreated) => void })
  // useMutation over createRetest; onSuccess: toast.success(`Retest order ${r.order_number ?? ''} created`, { description: r.payment_url ? 'Waiting for payment; the sample is created when the order completes.' : 'The sample is created when the order completes.' }); invalidates ['ordered-products', sampleId] and [RETEST_OPTIONS_KEY, sampleId]; calls opts.onCreated
  // onError: toast.error('Retest failed', { description: e.message })
```

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return { ...actual, getRetestOptions: vi.fn(), createRetest: vi.fn() }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { createRetest, getRetestOptions } from '@/lib/api'
import { toast } from 'sonner'
import { useCreateRetest, useRetestOptions } from '@/hooks/use-retest'

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { qc, Wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> }
}

describe('useRetestOptions', () => {
  it('fetches only when enabled', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({ sample_id: 'P-1', status: null, order_number: null, profiles: [], addons: [], variance: { point_price: null, allowed: false }, prices_available: false })
    const { Wrapper } = wrapper()
    const { result, rerender } = renderHook(({ on }) => useRetestOptions('P-1', on), { wrapper: Wrapper, initialProps: { on: false } })
    expect(getRetestOptions).not.toHaveBeenCalled()
    rerender({ on: true })
    await waitFor(() => expect(result.current.data?.sample_id).toBe('P-1'))
  })
})

describe('useCreateRetest', () => {
  it('toasts with the order number and the payment hint, invalidates, calls onCreated', async () => {
    vi.mocked(createRetest).mockResolvedValue({ order_number: 'WP-7920', payment_url: 'https://x' })
    const { qc, Wrapper } = wrapper()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const onCreated = vi.fn()
    const { result } = renderHook(() => useCreateRetest('P-1', { onCreated }), { wrapper: Wrapper })
    await act(async () => { await result.current.mutateAsync({ retest: ['x'], carry: [], add: null, auto_checkin: false, fee: 'paid', reason: 'r' }) })
    expect(toast.success).toHaveBeenCalledWith('Retest order WP-7920 created', expect.objectContaining({ description: expect.stringMatching(/waiting for payment/i) }))
    expect(spy).toHaveBeenCalledWith({ queryKey: ['ordered-products', 'P-1'] })
    expect(onCreated).toHaveBeenCalledWith({ order_number: 'WP-7920', payment_url: 'https://x' })
  })
  it('toasts the server detail on failure', async () => {
    vi.mocked(createRetest).mockRejectedValue(new Error('Integration Service returned 502'))
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useCreateRetest('P-1', {}), { wrapper: Wrapper })
    await act(async () => { await result.current.mutateAsync({ retest: ['x'], carry: [], add: null, auto_checkin: false, fee: 'paid', reason: 'r' }).catch(() => undefined) })
    expect(toast.error).toHaveBeenCalledWith('Retest failed', { description: 'Integration Service returned 502' })
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/test/use-retest.test.tsx`: FAIL.
- [ ] **Step 3: Implement** `src/hooks/use-retest.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { createRetest, getRetestOptions } from '@/lib/api'
import type { RetestCreated, RetestRequestBody } from '@/lib/api'

export const RETEST_OPTIONS_KEY = 'retest-options'

export function useRetestOptions(sampleId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [RETEST_OPTIONS_KEY, sampleId],
    queryFn: () => getRetestOptions(sampleId as string),
    enabled: enabled && Boolean(sampleId),
    staleTime: 30_000,
    retry: false,
  })
}

export function useCreateRetest(sampleId: string, opts: { onCreated?: (r: RetestCreated) => void }) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: RetestRequestBody) => createRetest(sampleId, body),
    onSuccess: r => {
      toast.success(`Retest order ${r.order_number ?? ''} created`.replace('  ', ' ').trim(), {
        description: r.payment_url
          ? 'Waiting for payment; the sample is created when the order completes.'
          : 'The sample is created when the order completes.',
      })
      queryClient.invalidateQueries({ queryKey: ['ordered-products', sampleId] })
      queryClient.invalidateQueries({ queryKey: [RETEST_OPTIONS_KEY, sampleId] })
      opts.onCreated?.(r)
    },
    onError: (e: Error) => {
      toast.error('Retest failed', { description: e.message })
    },
  })
}
```

- [ ] **Step 4: Run** the test: PASS; `npm run ast:lint` clean (hooks in `hooks/`).
- [ ] **Step 5: Commit** `src/hooks/use-retest.ts src/test/use-retest.test.tsx`: `feat(retest-ui): useRetestOptions / useCreateRetest hooks`.

---

### Task 5: `RetestDialog`

**Files:**
- Create: `src/components/senaite/RetestDialog.tsx`
- Test: `src/test/retest-dialog.test.tsx` (new)

**Interfaces:**
```ts
export interface RetestDialogProps { open: boolean; sampleId: string; onClose: () => void; onCreated?: (r: RetestCreated) => void }
export function RetestDialog(props: RetestDialogProps): JSX.Element
// exported pure helper for tests + the Delta line:
export function retestDelta(sel: { addons: RetestOptionAddon[]; variancePoints: number; pointPrice: number | null }): number | null  // null when any selected price is null
export function buildRetestBody(state: RetestFormState, options: RetestOptions): RetestRequestBody
```
Layout (spec 4.1), top to bottom inside `Dialog` / `DialogContent className="max-w-2xl"`:
1. `DialogTitle`: `Retest {sampleId}` (or `Add services to {sampleId}` when nothing is set to Retest and something is added; `Retest + add services` when both).
2. Explanation block (3 short lines): creates a WP retest order against order `{options.order_number}`; when the order completes Mk1 creates a new sample; ticked services get new vials, the rest are carried as verified results linked to this sample; nothing changes on this sample or its COA.
3. **Services table**: one row per `options.profiles`: name, state pill (`StatusBadge`-like text, plain), a two-way toggle rendered as two `Button` `variant={selected ? 'default' : 'outline'} size="sm"` labelled `Retest` / `Carry`. Carry disabled with `title="Not verified on this sample; must be retested"` when `!carry_eligible`. Default: `carry_eligible ? 'carry' : 'retest'`.
4. **Add services** block: rows for `options.addons.filter(a => a.wp_type)`: `Checkbox` + name + `($price · N vials)` or `(price unavailable)`; plus a **Variance** row (shown only when `options.variance.allowed`): `Checkbox` + points `Input type="number" min=2 max=10` (default 3), disabled unless an `HPLC_PROFILE_KEYS` member is set to Retest; plus `ship vials` `Input type="number" min=0 max=20` (default 0). A `Delta: $X.XX` line from `retestDelta` (or `Delta: price unavailable`).
5. **Fee**: `RadioGroup` Paid / Free, default Paid; hidden when no profile is set to Retest.
6. **Auto check-in** `Switch` (default off) with the one-line rule text: on = extra vial on hand, the sample lands Received; off = sample lands Due, vials are seeded at check-in.
7. **Reason** `Textarea` (required).
8. Footer: Cancel; Create (`disabled` until `reason.trim()` and (any retest || any addon || variancePoints > 0) and `!mutation.isPending`). On success: `onCreated?.(r)` then `onClose()`; on a 400 the hook already toasted, keep the dialog open.
Loading: while `useRetestOptions` is pending show a `Spinner`; on error show the message and a Retry button.
`onOpenChange={v => { if (!v && !pending) onClose() }}` like `CancelSampleDialog`.

`buildRetestBody`: `retest` = keys toggled Retest (locked ones included); `carry` = the rest; `add` = `{ profiles: tickedAddonKeys, variance_points: varianceTicked ? points : 0, additional_vials: shipVials }` or `null` when all three are empty/zero; `fee` = the radio (send `'free'` when the Fee control is hidden? No: send the default `'paid'`; the server ignores it when `retest` is empty); `auto_checkin`; `reason.trim()`.

- [ ] **Step 1: Write the failing tests** (`src/test/retest-dialog.test.tsx`)

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type * as ApiModule from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof ApiModule>()
  return { ...actual, getRetestOptions: vi.fn(), createRetest: vi.fn() }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { createRetest, getRetestOptions } from '@/lib/api'
import { RetestDialog, retestDelta } from '@/components/senaite/RetestDialog'

const OPTIONS = {
  sample_id: 'P-9001', status: 'published', order_number: 'WP-3134',
  profiles: [
    { key: 'hplc-purity-identity', name: 'HPLC Purity + Identity', carry_eligible: true, state: 'published' },
    { key: 'heavy_metals', name: 'Heavy Metals', carry_eligible: true, state: 'published' },
    { key: 'endotoxin-usp85-lal', name: 'Endotoxin USP85 LAL', carry_eligible: false, state: 'parent_to_verify' },
  ],
  addons: [
    { key: 'rapid-sterility-pcr', name: 'Rapid Sterility Screening (PCR)', wp_type: 'sterility_pcr', price: 230, vials: 1 },
    { key: 'fentanyl', name: 'Fentanyl Screening', wp_type: null, price: null, vials: 0 },
  ],
  variance: { point_price: 76.5, allowed: true },
  prices_available: true,
}

function renderDialog(onCreated = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  render(<QueryClientProvider client={qc}><RetestDialog open sampleId="P-9001" onClose={onClose} onCreated={onCreated} /></QueryClientProvider>)
  return { onClose, onCreated }
}

beforeEach(() => { vi.mocked(getRetestOptions).mockResolvedValue(OPTIONS); vi.mocked(createRetest).mockReset() })

describe('RetestDialog', () => {
  it('defaults eligible profiles to Carry, locks ineligible ones to Retest, lists only WP-sellable add-ons', async () => {
    renderDialog()
    const hm = await screen.findByTestId('retest-row-heavy_metals')
    expect(within(hm).getByRole('button', { name: 'Carry' })).toHaveAttribute('aria-pressed', 'true')
    const endo = screen.getByTestId('retest-row-endotoxin-usp85-lal')
    expect(within(endo).getByRole('button', { name: 'Retest' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(endo).getByRole('button', { name: 'Carry' })).toBeDisabled()
    expect(screen.getByText(/Rapid Sterility Screening \(PCR\)/)).toBeInTheDocument()
    expect(screen.queryByText(/Fentanyl Screening/)).not.toBeInTheDocument()
    expect(screen.getByText(/\$230\.00/)).toBeInTheDocument()
  })

  it('gates Create on a reason and something to do; hides Fee when nothing is retested', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({ ...OPTIONS, profiles: OPTIONS.profiles.filter(p => p.carry_eligible) })
    renderDialog()
    const create = await screen.findByRole('button', { name: /^create/i })
    expect(create).toBeDisabled()
    expect(screen.queryByText(/^fee$/i)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'customer asked' } })
    expect(create).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/Rapid Sterility Screening/))
    expect(create).toBeEnabled()
    expect(screen.getByText(/Delta/)).toHaveTextContent('$230.00')
  })

  it('variance needs an HPLC profile set to Retest and prices the replicates', async () => {
    renderDialog()
    const variance = await screen.findByLabelText(/^variance$/i)
    expect(variance).toBeDisabled()
    const hplc = screen.getByTestId('retest-row-hplc-purity-identity')
    fireEvent.click(within(hplc).getByRole('button', { name: 'Retest' }))
    expect(variance).toBeEnabled()
    fireEvent.click(variance)
    expect(screen.getByText(/Delta/)).toHaveTextContent('$153.00')   // (3 - 1) * 76.5
    expect(screen.getByText(/^fee$/i)).toBeInTheDocument()
  })

  it('submits the spec shape and closes on success', async () => {
    vi.mocked(createRetest).mockResolvedValue({ order_number: 'WP-7920', payment_url: 'https://pay' })
    const { onClose, onCreated } = renderDialog()
    const hplc = await screen.findByTestId('retest-row-hplc-purity-identity')
    fireEvent.click(within(hplc).getByRole('button', { name: 'Retest' }))
    fireEvent.click(screen.getByLabelText(/Rapid Sterility Screening/))
    fireEvent.change(screen.getByLabelText(/ship vials/i), { target: { value: '2' } })
    fireEvent.click(screen.getByLabelText(/free/i))
    fireEvent.click(screen.getByLabelText(/auto check-in/i))
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'purity re-run' } })
    fireEvent.click(screen.getByRole('button', { name: /^create/i }))
    await waitFor(() => expect(createRetest).toHaveBeenCalledWith('P-9001', {
      retest: ['hplc-purity-identity', 'endotoxin-usp85-lal'],
      carry: ['heavy_metals'],
      add: { profiles: ['rapid-sterility-pcr'], variance_points: 0, additional_vials: 2 },
      auto_checkin: true, fee: 'free', reason: 'purity re-run',
    }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onCreated).toHaveBeenCalledWith({ order_number: 'WP-7920', payment_url: 'https://pay' })
  })

  it('stays open on a server error', async () => {
    vi.mocked(createRetest).mockRejectedValue(new Error('Integration Service returned 502'))
    const { onClose } = renderDialog()
    const hplc = await screen.findByTestId('retest-row-hplc-purity-identity')
    fireEvent.click(within(hplc).getByRole('button', { name: 'Retest' }))
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^create/i }))
    await waitFor(() => expect(createRetest).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows "price unavailable" instead of numbers when IS has no prices', async () => {
    vi.mocked(getRetestOptions).mockResolvedValue({ ...OPTIONS, prices_available: false, variance: { point_price: null, allowed: true },
      addons: [{ ...OPTIONS.addons[0], price: null }] })
    renderDialog()
    expect(await screen.findAllByText(/price unavailable/i)).not.toHaveLength(0)
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument()
  })
})

describe('retestDelta', () => {
  it('sums add-on prices and variance replicates, null when a price is missing', () => {
    expect(retestDelta({ addons: [{ key: 'a', name: 'a', wp_type: 'x', price: 200, vials: 1 }], variancePoints: 3, pointPrice: 76.5 })).toBe(353)
    expect(retestDelta({ addons: [], variancePoints: 0, pointPrice: null })).toBe(0)
    expect(retestDelta({ addons: [{ key: 'a', name: 'a', wp_type: 'x', price: null, vials: 1 }], variancePoints: 0, pointPrice: null })).toBeNull()
    expect(retestDelta({ addons: [], variancePoints: 3, pointPrice: null })).toBeNull()
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/test/retest-dialog.test.tsx`: FAIL (module missing).
- [ ] **Step 3: Implement** `src/components/senaite/RetestDialog.tsx`. Use `Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter` from `@/components/ui/dialog`, `Button`, `Checkbox`, `Input`, `Label`, `RadioGroup, RadioGroupItem`, `Switch`, `Textarea`, `Spinner` from `@/components/ui/*`, `RefreshCw` icon. Each profile row: `<div data-testid={`retest-row-${p.key}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 py-1.5 border-b border-border/40">` with the name, a muted state text, and the two toggle buttons carrying `aria-pressed`. Add-on checkboxes and the variance checkbox must be labelled through `<Label htmlFor>` so `getByLabelText` works (name for add-ons, literally `Variance` for the variance row, `ship vials`, `Auto check-in`, `Reason`, and the radio items `Paid` / `Free`). Money: `formatMoney = (n: number) => `$${n.toFixed(2)}``. Keep state in one `useState<RetestFormState>` reset when `options` loads (`useEffect` keyed on `options?.sample_id`). `retestDelta` and `buildRetestBody` are module-level exports.
- [ ] **Step 4: Run** the test file (PASS), then `npm run typecheck && npm run lint && npm run ast:lint` and `npx prettier --write src/components/senaite/RetestDialog.tsx src/test/retest-dialog.test.tsx`.
- [ ] **Step 5: Commit** the two files: `feat(retest-ui): RetestDialog (Retest / Carry, Add services, fee, auto check-in, reason)`.

---

### Task 6: Wire the page

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` (four touch points: imports/state, Actions menu item, dialog mount, the "Retested as" line; plus `retestInfo={retestInfo}` on both `<AnalysisTable` usages)

- [ ] **Step 1: Read** the Actions menu block (search `data-testid="schedule-publish-menu"`), the dialog mount block (search `<CancelSampleDialog`), the "Retested as" block (search `↳ Retested as:`), and the retest-info `useEffect` (search `getSampleRetestInfo`).
- [ ] **Step 2: Implement**
  - Import `RetestDialog` and `RefreshCw` (already imported) ; add `const [retestOpen, setRetestOpen] = useState(false)` next to `cancelOpen`.
  - Extract the retest-info fetch into a local `const loadRetestInfo = useCallback(...)` used by the existing effect, so it can be re-run after creation (keep the cancellation flag behaviour).
  - Menu item, placed right before the Cancel item (parent only, always enabled):
    ```tsx
    {isParent && (
      <DropdownMenuItem onClick={() => setRetestOpen(true)} className="cursor-pointer" data-testid="retest-menu">
        <RefreshCw className="h-4 w-4 mr-2" />
        Retest / add services…
      </DropdownMenuItem>
    )}
    ```
  - Mount next to `CancelSampleDialog`:
    ```tsx
    {isParent && (
      <RetestDialog open={retestOpen} sampleId={data.sample_id} onClose={() => setRetestOpen(false)} onCreated={() => loadRetestInfo(data.sample_id)} />
    )}
    ```
  - "Retested as" line: for each `r` in `retested_as`, keep the button and append a muted `<span className="text-[10px] text-muted-foreground">` with `r.status ? ` (${r.status.replace(/_/g, ' ')})` : ''`, and set the button `title` to `Created ${date}${r.retest?.length ? ` · retesting ${r.retest.join(', ')}` : ''}${r.carry?.length ? ` · carrying ${r.carry.join(', ')}` : ''}${r.add?.length ? ` · added ${r.add.join(', ')}` : ''}`.
  - Pass `retestInfo={retestInfo}` to both `<AnalysisTable` usages (the read-flip main table and the `NativeParentAnalysesCard` one; the card needs the value threaded through its props: add an optional `retestInfo?: SampleRetestInfo | null` prop to `NativeParentAnalysesCard`).
- [ ] **Step 3: Verify** `npm run typecheck && npm run lint && npm run ast:lint && npm run format:check` (format: run prettier on the touched files only) and `npm run test:run` failure-set diff vs the branch base (record both lists).
- [ ] **Step 4: Commit** `src/components/senaite/SampleDetails.tsx`: `feat(retest-ui): Retest menu item, dialog mount, richer Retested-as line, chips wired`.

---

### Task 7: Stack UAT, screenshots, PR

- [ ] **Step 1:** On the devbox, point the mounted Mk1 worktree at this branch: `cd ~/worktrees/mk1-retest && git fetch origin && git checkout -B retest/mk1-ui origin/feat/native-retest-ui` (vite HMR picks it up; if the backend changed in Task 0, `docker compose -p accumark-retest restart accu-mk1-backend`).
- [ ] **Step 2:** Screenshots with `playwright-cli -s=retest-ui` against `http://100.73.137.3:5532`: (a) P-9001 Actions menu open showing "Retest / add services…"; (b) the RetestDialog with defaults; (c) the dialog after toggling HPLC to Retest + ticking PCR + Variance (Delta visible, Fee visible); (d) the 502 toast after Create (WP route absent, expected); (e) P-5000 analyses table with `Carried from P-9001-S02` badges and `Retesting` / `Added` chips; (f) P-9001 "Retested as: P-5000 (sample received)" line. Save under `docs/superpowers/e2e/2026-09-26-native-retest-ui/`.
- [ ] **Step 3:** Commit the PNGs, push `feat/native-retest-ui`, open the PR with base `feat/native-retest-backend`, title `feat(retest-ui): Retest overlay, Carried / Retesting / Added chips, Retested-as detail (plan 4)`, body: spec link, task list, gate results, screenshots table, note that Create returns 502 until plan 3 (WP) ships. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review against the spec
- 4.1 overlay: explanation block, per-profile Retest/Carry with eligibility lock, Add services (wp-sellable only, prices, vials, variance points gated on HPLC retest, ship vials, Delta), Fee hidden when nothing retested, auto check-in rule text, required reason, Create gating, success message with payment hint: Task 5 (+ Task 4 toast).
- 4.2 chips: `Carried from P-xxxx-Sxx` (Task 3 badge), `Retesting` / `Added` on ordered placeholders (Tasks 2, 3), original's "Retested as" panel (Task 6, extends the existing line rather than adding a panel; the spec's "panel" is satisfied by the line + tooltip, ruling recorded here).
- 4.3 receive page: no change needed (snapshot already filtered).
- Types match plan 1's `retest_routes.py` responses and `retest-info` (+ Task 0 addition).
