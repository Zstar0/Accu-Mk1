# Sample Priority — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Priorities pane, compact glyph on every sample surface, set controls on sample/vial/order/receive pages, and SLA resolution fed by the effective priority instead of the SENAITE-uid lookup.

**Architecture:** One API module (`src/lib/api-priorities.ts`), one TanStack service (`src/services/priorities.ts`), one pure TS resolver mirroring the backend against the shared fixture, one `PriorityGlyph` + one `PrioritySelect` component, then wiring per surface. Lists read the inline `priority` shape the backend now embeds; SLA services take `priority.key` from that shape.

**Tech Stack:** React 19, TanStack Query, Zustand selectors only, shadcn/ui, lucide-react, vitest + @testing-library/react, react-i18next (strings in `/locales/en.json`), npm only.

**Spec:** `docs/superpowers/specs/2026-09-09-sample-priority-design.md`

## Global Constraints

- Prerequisite: backend plan merged (routes under `/priorities`, `priority` embedded in rows).
- Icon enum: `chevrons-up`, `chevron-up`, `minus`, `chevron-down`, `chevrons-down`, `flame`. Color enum: `red`, `amber`, `emerald`, `sky`, `violet`, `zinc`.
- Rows use the bare glyph; cards and headers use the tinted-square variant; Default renders nothing; pulse only when the priority's `pulse` is true.
- Zustand: selector syntax only (ast-grep enforces).
- Every new string goes through `t()` with keys under `priority.*`.
- Gates before each commit: `npm run typecheck && npx eslint <changed files> --max-warnings 0 && npx vitest run <test files>`.
- Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/api-priorities.ts` | fetchers + types for `/priorities/*` |
| `src/lib/priority-resolver.ts` | pure resolver mirror |
| `src/services/priorities.ts` | query keys, hooks, mutations |
| `src/components/common/PriorityGlyph.tsx` | indicator |
| `src/components/common/PrioritySelect.tsx` | set control |
| `src/components/preferences/panes/PrioritiesPane.tsx` | settings |
| `src/components/preferences/panes.tsx` | registration |
| `src/components/preferences/panes/SlaPane.tsx` | list-driven overrides |
| `src/services/sample-sla.ts`, `order-sla.ts`, `analysis-sla.ts`, `src/lib/inbox-sla.ts`, `src/lib/sla-resolution.ts` | key-driven priority |
| surfaces (see Task 7–9) | glyph + controls |
| `src/test/*.test.ts(x)` | tests |

---

### Task 1: API module and service hooks

**Files:**
- Create: `src/lib/api-priorities.ts`
- Create: `src/services/priorities.ts`
- Test: `src/test/priorities-service.test.ts`

**Interfaces:**
- Produces types `Priority {key, name, rank, icon: PriorityIcon, color: PriorityColor, pulse, is_default, is_active, sla_tier_id: number|null}`, `EffectivePriority {key, rank, source_level: 'vial'|'sample'|'order'|'customer'|'default', source_id: string|null}`, `PriorityLevel`, `CustomerPriority`, `CustomerSeen`; fetchers `getPriorities`, `createPriority`, `patchPriority`, `deactivatePriority`, `setDefaultPriority`, `assignPriority`, `assignPriorityBulk`, `resolvePriorities`, `getCustomerPriorities`, `getCustomersSeen`; hooks `usePriorities()`, `useActivePriorities()`, `useAssignPriority()`, `usePriorityMutations()`, `useCustomerPriorities()`; `priorityQueryKeys`.

- [ ] **Step 1: Write the failing test**

```ts
// src/test/priorities-service.test.ts
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('@/lib/api-priorities', () => ({
  getPriorities: vi.fn(async () => [
    { key: 'expedited', name: 'Expedited', rank: 20, icon: 'chevrons-up', color: 'red', pulse: true, is_default: false, is_active: true, sla_tier_id: null },
    { key: 'retired', name: 'Retired', rank: 5, icon: 'minus', color: 'zinc', pulse: false, is_default: false, is_active: false, sla_tier_id: null },
    { key: 'default', name: 'Default', rank: 0, icon: 'minus', color: 'zinc', pulse: false, is_default: true, is_active: true, sla_tier_id: null },
  ]),
}))

import { useActivePriorities } from '@/services/priorities'

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useActivePriorities', () => {
  it('drops inactive rows and keeps rank order', async () => {
    const { result } = renderHook(() => useActivePriorities(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data!.map(p => p.key)).toEqual(['expedited', 'default'])
  })
})
```

(Name the file `.test.tsx` because it contains JSX.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/test/priorities-service.test.tsx`
Expected: FAIL — cannot resolve `@/services/priorities`.

- [ ] **Step 3: Write the API module**

```ts
// src/lib/api-priorities.ts
import { API_BASE_URL, getBearerHeaders, extractErrorMessage } from '@/lib/api'

export type PriorityIcon = 'chevrons-up' | 'chevron-up' | 'minus' | 'chevron-down' | 'chevrons-down' | 'flame'
export type PriorityColor = 'red' | 'amber' | 'emerald' | 'sky' | 'violet' | 'zinc'
export type PriorityLevel = 'customer' | 'order' | 'sample' | 'vial'
export type PrioritySource = PriorityLevel | 'default'

export interface Priority {
  key: string; name: string; rank: number; icon: PriorityIcon; color: PriorityColor
  pulse: boolean; is_default: boolean; is_active: boolean; sla_tier_id: number | null
}
export interface EffectivePriority { key: string; rank: number; source_level: PrioritySource; source_id: string | null }
export interface AssignInput { level: PriorityLevel; id: string; priority_key: string | null; note?: string }
export interface AssignResult { level: PriorityLevel; id: string; old_key: string | null; new_key: string | null; affected_sample_pks: number[] }
export interface CustomerPriority { wp_customer_user_id: number; priority_key: string; note: string | null; updated_at: string | null; customer_name: string | null; customer_email: string | null }
export interface CustomerSeen { wp_customer_user_id: number; customer_name: string | null; customer_email: string | null; last_order_at: string | null }

async function req<T>(path: string, init: RequestInit = {}, fallback = 'Request failed'): Promise<T> {
  const res = await fetch(`${API_BASE_URL()}${path}`, {
    ...init,
    headers: { ...getBearerHeaders(), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })
  if (!res.ok) throw new Error(await extractErrorMessage(res, `${fallback}: ${res.status}`))
  return res.json() as Promise<T>
}

export const getPriorities = () => req<Priority[]>('/priorities')
export const createPriority = (body: Pick<Priority, 'name' | 'rank' | 'icon' | 'color' | 'pulse'> & { sla_tier_id?: number | null }) =>
  req<Priority>('/priorities', { method: 'POST', body: JSON.stringify(body) }, 'Create priority failed')
export const patchPriority = (key: string, body: Partial<Pick<Priority, 'name' | 'rank' | 'icon' | 'color' | 'pulse' | 'is_active' | 'sla_tier_id'>>) =>
  req<Priority>(`/priorities/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify(body) }, 'Save priority failed')
export const deactivatePriority = (key: string) => req<{ key: string }>(`/priorities/${encodeURIComponent(key)}`, { method: 'DELETE' })
export const setDefaultPriority = (key: string) => req<Priority>(`/priorities/default/${encodeURIComponent(key)}`, { method: 'PUT' })
export const assignPriority = (body: AssignInput) => req<AssignResult>('/priorities/assign', { method: 'PUT', body: JSON.stringify(body) }, 'Set priority failed')
export const assignPriorityBulk = (items: AssignInput[]) => req<AssignResult[]>('/priorities/assign/bulk', { method: 'PUT', body: JSON.stringify({ items }) })
export const resolvePriorities = (body: { sample_pks?: number[]; sub_sample_pks?: number[] }) =>
  req<{ samples: Record<string, EffectivePriority>; sub_samples: Record<string, EffectivePriority> }>('/priorities/resolve', { method: 'POST', body: JSON.stringify(body) })
export const getCustomerPriorities = () => req<CustomerPriority[]>('/priorities/customers')
export const getCustomersSeen = (q: string) => req<CustomerSeen[]>(`/priorities/customers/seen?q=${encodeURIComponent(q)}`)
```

(If `extractErrorMessage` or `getBearerHeaders` are not exported from `@/lib/api`, export them there; both exist as module-level functions.)

- [ ] **Step 4: Write the service**

```ts
// src/services/priorities.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  assignPriority, assignPriorityBulk, createPriority, deactivatePriority, getCustomerPriorities,
  getPriorities, patchPriority, setDefaultPriority, type AssignInput, type Priority,
} from '@/lib/api-priorities'
import { slaQueryKeys } from '@/services/sla'

export const priorityQueryKeys = {
  all: ['priorities'] as const,
  customers: ['priorities', 'customers'] as const,
}

export function usePriorities() {
  return useQuery({ queryKey: priorityQueryKeys.all, queryFn: getPriorities, staleTime: 1000 * 60 * 5 })
}

export function useActivePriorities() {
  const q = usePriorities()
  return { ...q, data: q.data?.filter(p => p.is_active) }
}

export function priorityByKey(list: Priority[] | undefined, key: string | null | undefined): Priority | undefined {
  return key ? list?.find(p => p.key === key) : undefined
}

function useInvalidateAfterAssign() {
  const qc = useQueryClient()
  return () => {
    // Every list that embeds `priority` and every SLA consumer re-reads.
    qc.invalidateQueries({ predicate: q => typeof q.queryKey[0] === 'string' && /sample|order|inbox|worksheet|vial|registry|sla/i.test(q.queryKey[0]) })
    // Customer-level assigns land in a key the predicate cannot see.
    qc.invalidateQueries({ queryKey: priorityQueryKeys.customers })
  }
}

export function useAssignPriority() {
  const invalidate = useInvalidateAfterAssign()
  return useMutation({
    mutationFn: (input: AssignInput) => assignPriority(input),
    onSuccess: (res) => { invalidate(); toast.success(res.new_key ? 'Priority set' : 'Priority cleared') },
    onError: (e: Error) => toast.error('Set priority failed', { description: e.message }),
  })
}

export function useAssignPriorityBulk() {
  const invalidate = useInvalidateAfterAssign()
  return useMutation({
    mutationFn: (items: AssignInput[]) => assignPriorityBulk(items),
    onSuccess: (res) => { invalidate(); toast.success(`Priority set on ${res.length} item${res.length === 1 ? '' : 's'}`) },
    onError: (e: Error) => toast.error('Set priority failed', { description: e.message }),
  })
}

export function usePriorityMutations() {
  const qc = useQueryClient()
  const done = (msg: string) => () => {
    qc.invalidateQueries({ queryKey: priorityQueryKeys.all })
    qc.invalidateQueries({ queryKey: slaQueryKeys.priorityTiers })
    toast.success(msg)
  }
  const fail = (e: Error) => toast.error('Priority change failed', { description: e.message })
  return {
    create: useMutation({ mutationFn: createPriority, onSuccess: done('Priority created'), onError: fail }),
    patch: useMutation({ mutationFn: ({ key, body }: { key: string; body: Parameters<typeof patchPriority>[1] }) => patchPriority(key, body), onSuccess: done('Priority saved'), onError: fail }),
    deactivate: useMutation({ mutationFn: deactivatePriority, onSuccess: done('Priority deactivated'), onError: fail }),
    setDefault: useMutation({ mutationFn: setDefaultPriority, onSuccess: done('Default priority changed'), onError: fail }),
  }
}

export function useCustomerPriorities() {
  return useQuery({ queryKey: priorityQueryKeys.customers, queryFn: getCustomerPriorities })
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/test/priorities-service.test.tsx`
Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api-priorities.ts src/services/priorities.ts src/test/priorities-service.test.tsx
git commit -m "feat(priority): api module + TanStack service for /priorities

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Pure resolver mirror against the shared fixture

**Files:**
- Create: `src/lib/priority-resolver.ts`
- Test: `src/test/priority-resolver.test.ts`

**Interfaces:**
- Produces `resolvePriority(explicit: Partial<Record<PriorityLevel, string | null>>, priorities: Pick<Priority, 'key'|'rank'|'is_active'|'is_default'>[]): EffectivePriority` with the same semantics as `backend/priority/resolver.py`.

- [ ] **Step 1: Write the failing test**

```ts
// src/test/priority-resolver.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolvePriority } from '@/lib/priority-resolver'

const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../backend/tests/fixtures/priority_cases.json'), 'utf8'))

describe('resolvePriority mirrors backend/priority/resolver.py', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const eff = resolvePriority(c.explicit, fixture.priorities)
      expect([eff.key, eff.rank, eff.source_level]).toEqual([c.expect.key, c.expect.rank, c.expect.source_level])
    })
  }
  it('throws without a default', () => {
    expect(() => resolvePriority({}, [{ key: 'high', rank: 10, is_active: true, is_default: false }])).toThrow()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/test/priority-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/priority-resolver.ts
import type { EffectivePriority, PriorityLevel } from '@/lib/api-priorities'

const LEVELS: PriorityLevel[] = ['vial', 'sample', 'order', 'customer']
type Info = { key: string; rank: number; is_active: boolean; is_default: boolean }

/** Most specific explicit ACTIVE key wins; unknown/inactive = inherit; else default.
 *  Mirror of backend/priority/resolver.py; both run the shared fixture. */
export function resolvePriority(
  explicit: Partial<Record<PriorityLevel, string | null>>,
  priorities: Info[],
  ids: Partial<Record<PriorityLevel, string>> = {},
): EffectivePriority {
  const byKey = new Map(priorities.map(p => [p.key, p]))
  for (const level of LEVELS) {
    const key = explicit[level]
    if (!key) continue
    const info = byKey.get(key)
    if (!info || !info.is_active) continue
    return { key: info.key, rank: info.rank, source_level: level, source_id: ids[level] ?? null }
  }
  const def = priorities.find(p => p.is_default)
  if (!def) throw new Error('no default priority configured')
  return { key: def.key, rank: def.rank, source_level: 'default', source_id: null }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/test/priority-resolver.test.ts`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/priority-resolver.ts src/test/priority-resolver.test.ts
git commit -m "feat(priority): TS resolver mirror validated against the shared fixture

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: PriorityGlyph

**Files:**
- Create: `src/components/common/PriorityGlyph.tsx`
- Test: `src/test/priority-glyph.test.tsx`

**Interfaces:**
- `PriorityGlyph({ priority: EffectivePriority | null | undefined, size?: 'row' | 'card' | 'header', showLabel?: boolean, className?: string })`. Reads the priority list via `usePriorities()` to get icon/color/pulse/name. Renders `null` for the default key or when the list has not loaded. Tooltip (native `title` + `aria-label`) text: `${name} via ${source}` where source is `customer (${source_id})`, `order ${source_id}`, `sample`, `vial`. Rows: bare icon 14px in `text-{color}-600 dark:text-{color}-400`; card/header: tinted square `bg-{color}-500/10 border border-{color}-500/20` 22/28px. Pulse: `animate-pulse` when `pulse` is true and `motion-safe:`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/test/priority-glyph.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('@/lib/api-priorities', () => ({
  getPriorities: vi.fn(async () => [
    { key: 'expedited', name: 'Expedited', rank: 20, icon: 'chevrons-up', color: 'red', pulse: true, is_default: false, is_active: true, sla_tier_id: null },
    { key: 'high', name: 'High', rank: 10, icon: 'chevron-up', color: 'amber', pulse: false, is_default: false, is_active: true, sla_tier_id: null },
    { key: 'default', name: 'Default', rank: 0, icon: 'minus', color: 'zinc', pulse: false, is_default: true, is_active: true, sla_tier_id: null },
  ]),
}))
import { PriorityGlyph } from '@/components/common/PriorityGlyph'

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('PriorityGlyph', () => {
  it('renders nothing for the default priority', async () => {
    wrap(
      <>
        <div data-testid="default-slot"><PriorityGlyph priority={{ key: 'default', rank: 0, source_level: 'default', source_id: null }} /></div>
        <div data-testid="high-slot"><PriorityGlyph priority={{ key: 'high', rank: 10, source_level: 'order', source_id: '3291' }} /></div>
      </>
    )
    // The sibling glyph resolving proves the priority list has loaded, so the
    // default glyph rendering nothing is the is_default branch, not the
    // not-yet-loaded branch.
    await screen.findByRole('img', { name: /High/ })
    expect(screen.queryByRole('img', { name: /^Default/ })).toBeNull()
    expect(screen.getByTestId('default-slot').childNodes.length).toBe(0)
    expect(screen.getByTestId('high-slot').childNodes.length).toBe(1)
  })
  it('renders the icon with a source tooltip and pulses when configured', async () => {
    wrap(<PriorityGlyph priority={{ key: 'expedited', rank: 20, source_level: 'customer', source_id: '777' }} />)
    const el = await screen.findByRole('img', { name: 'Expedited via customer (777)' })
    expect(el.className).toContain('motion-safe:animate-pulse')
    expect(el.querySelector('svg')).not.toBeNull()
  })
  it('card size is tinted and does not pulse for High', async () => {
    wrap(<PriorityGlyph priority={{ key: 'high', rank: 10, source_level: 'order', source_id: '3291' }} size="card" />)
    const el = await screen.findByRole('img', { name: 'High via order 3291' })
    expect(el.className).toContain('bg-amber-500/10')
    expect(el.className).not.toContain('animate-pulse')
  })
  it('sample-level priority reads "via sample" and header size uses the w-7 box', async () => {
    wrap(<PriorityGlyph priority={{ key: 'high', rank: 10, source_level: 'sample', source_id: null }} size="header" />)
    const el = await screen.findByRole('img', { name: 'High via sample' })
    expect(el.className).toContain('w-7')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/test/priority-glyph.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/components/common/PriorityGlyph.tsx
import { ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, Flame, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { EffectivePriority, PriorityColor, PriorityIcon } from '@/lib/api-priorities'
import { priorityByKey, usePriorities } from '@/services/priorities'

const ICONS: Record<PriorityIcon, typeof ChevronUp> = {
  'chevrons-up': ChevronsUp, 'chevron-up': ChevronUp, minus: Minus,
  'chevron-down': ChevronDown, 'chevrons-down': ChevronsDown, flame: Flame,
}
// Full class strings so Tailwind keeps them.
const TEXT: Record<PriorityColor, string> = {
  red: 'text-red-600 dark:text-red-400', amber: 'text-amber-600 dark:text-amber-400',
  emerald: 'text-emerald-600 dark:text-emerald-400', sky: 'text-sky-600 dark:text-sky-400',
  violet: 'text-violet-600 dark:text-violet-400', zinc: 'text-zinc-600 dark:text-zinc-400',
}
const TINT: Record<PriorityColor, string> = {
  red: 'bg-red-500/10 border-red-500/20', amber: 'bg-amber-500/10 border-amber-500/20',
  emerald: 'bg-emerald-500/10 border-emerald-500/20', sky: 'bg-sky-500/10 border-sky-500/20',
  violet: 'bg-violet-500/10 border-violet-500/20', zinc: 'bg-zinc-500/10 border-zinc-500/20',
}
const SIZE = { row: { box: 'w-[18px] h-[18px]', icon: 14 }, card: { box: 'w-[22px] h-[22px] rounded border', icon: 17 }, header: { box: 'w-7 h-7 rounded-md border', icon: 21 } }

export function priorityTooltip(name: string, p: EffectivePriority): string {
  switch (p.source_level) {
    case 'customer': return `${name} via customer${p.source_id ? ` (${p.source_id})` : ''}`
    case 'order': return `${name} via order${p.source_id ? ` ${p.source_id}` : ''}`
    case 'sample': return `${name} via sample`
    case 'vial': return `${name} via vial`
    default: return name
  }
}

export function PriorityGlyph({ priority, size = 'row', showLabel = false, className }: {
  priority: EffectivePriority | null | undefined
  size?: keyof typeof SIZE
  showLabel?: boolean
  className?: string
}) {
  const { data: list } = usePriorities()
  const def = priorityByKey(list, priority?.key)
  if (!priority || !def || def.is_default) return null
  const Icon = ICONS[def.icon] ?? Minus
  const tip = priorityTooltip(def.name, priority)
  const tinted = size !== 'row'
  return (
    <span
      role="img"
      aria-label={tip}
      title={tip}
      className={cn('inline-flex items-center justify-center shrink-0 align-middle', SIZE[size].box,
        TEXT[def.color], tinted && TINT[def.color], def.pulse && 'motion-safe:animate-pulse', className)}
    >
      <Icon size={SIZE[size].icon} strokeWidth={2.4} aria-hidden="true" />
      {showLabel && <span className="ms-1 text-xs font-medium">{def.name}</span>}
    </span>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/test/priority-glyph.test.tsx`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/components/common/PriorityGlyph.tsx src/test/priority-glyph.test.tsx
git commit -m "feat(priority): PriorityGlyph indicator (bare rows, tinted cards/headers, per-priority pulse)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: PrioritySelect set control

**Files:**
- Create: `src/components/common/PrioritySelect.tsx`
- Test: `src/test/priority-select.test.tsx`

**Interfaces:**
- `PrioritySelect({ level, id, explicitKey: string | null, effective: EffectivePriority | null | undefined, compact?: boolean })`. Options: `__inherit__` labelled `Inherit (${effectiveName} via ${source})` (or `Inherit (Default)`), then active priorities by rank desc. On change calls `useAssignPriority().mutate({ level, id, priority_key })` with `null` for inherit. Uses shadcn `Select`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/test/priority-select.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

vi.mock('@/lib/api-priorities', () => ({
  getPriorities: vi.fn(async () => [
    { key: 'high', name: 'High', rank: 10, icon: 'chevron-up', color: 'amber', pulse: false, is_default: false, is_active: true, sla_tier_id: null },
    { key: 'default', name: 'Default', rank: 0, icon: 'minus', color: 'zinc', pulse: false, is_default: true, is_active: true, sla_tier_id: null },
  ]),
  assignPriority: vi.fn(async (b: unknown) => ({ ...(b as object), old_key: null, new_key: 'high', affected_sample_pks: [1] })),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { assignPriority } from '@/lib/api-priorities'
import { PrioritySelect } from '@/components/common/PrioritySelect'

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('PrioritySelect', () => {
  it('labels the inherit option with the effective source and assigns on change', async () => {
    wrap(<PrioritySelect level="sample" id="42" explicitKey={null}
      effective={{ key: 'high', rank: 10, source_level: 'customer', source_id: 'Acme' }} />)
    const trigger = await screen.findByRole('combobox')
    expect(trigger).toHaveTextContent('Inherit (High via customer (Acme))')
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('option', { name: 'High' }))
    await waitFor(() => expect(assignPriority).toHaveBeenCalledWith({ level: 'sample', id: '42', priority_key: 'high' }))
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/test/priority-select.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/components/common/PrioritySelect.tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { EffectivePriority, PriorityLevel } from '@/lib/api-priorities'
import { priorityByKey, useActivePriorities, useAssignPriority, usePriorities } from '@/services/priorities'
import { priorityTooltip } from '@/components/common/PriorityGlyph'
import { cn } from '@/lib/utils'

const INHERIT = '__inherit__'

export function PrioritySelect({ level, id, explicitKey, effective, compact = false, className }: {
  level: PriorityLevel; id: string; explicitKey: string | null
  effective: EffectivePriority | null | undefined; compact?: boolean; className?: string
}) {
  const { data: all } = usePriorities()
  const { data: active } = useActivePriorities()
  const assign = useAssignPriority()
  const effName = priorityByKey(all, effective?.key)?.name ?? 'Default'
  const inheritLabel = effective && effective.source_level !== 'default'
    ? `Inherit (${priorityTooltip(effName, effective)})` : 'Inherit (Default)'
  // Every active priority is listed, the default included: setting Default
  // explicitly at a lower level deliberately overrides a higher level's value
  // (spec fixture case 8).
  const options = (active ?? []).map(p => ({ key: p.key, label: p.name }))
  // An explicitly-set priority that has since been deactivated (or pruned)
  // still has to be an option, or the controlled value matches no item and the
  // trigger renders blank.
  if (active && explicitKey && !active.some(p => p.key === explicitKey)) {
    const stored = priorityByKey(all, explicitKey)
    options.push({
      key: explicitKey,
      label: stored ? `${stored.name} (inactive)` : `${explicitKey} (unknown)`,
    })
  }
  return (
    <Select
      value={explicitKey ?? INHERIT}
      disabled={assign.isPending || !active}
      onValueChange={v => assign.mutate({ level, id, priority_key: v === INHERIT ? null : v })}
    >
      <SelectTrigger className={cn(compact ? 'h-7 text-xs' : 'h-8 text-sm', className)} aria-label="Priority">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT}>{inheritLabel}</SelectItem>
        {options.map(o => (
          <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
```

(The explicit "Default" option stays in the list on purpose: setting Default explicitly on a sample overrides a higher order/customer value, per spec fixture case 8.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/test/priority-select.test.tsx`
Expected: 1 passed. If Radix Select needs `scrollIntoView`/`ResizeObserver`, `src/test/setup.ts` already stubs both.

- [ ] **Step 5: Commit**

```bash
git add src/components/common/PrioritySelect.tsx src/test/priority-select.test.tsx
git commit -m "feat(priority): PrioritySelect set control with inherit-with-source option

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Priorities pane and SLA pane generalization

**Files:**
- Create: `src/components/preferences/panes/PrioritiesPane.tsx`
- Modify: `src/components/preferences/panes.tsx` (import, `'priorities'` id after `'sla'`, nav entry `{ id: 'priorities', labelKey: 'preferences.priorities', icon: ArrowUpNarrowWide }`, map entry)
- Modify: `src/components/preferences/panes/SlaPane.tsx` (`OVERRIDABLE` → active non-default priorities from `useActivePriorities()`; `InboxPriority` type → `string`)
- Modify: `locales/en.json` (keys `preferences.priorities`, `preferences.priorities.*`)
- Test: `src/components/preferences/panes/__tests__/PrioritiesPane.test.tsx`

**Interfaces:**
- Consumes `usePriorities`, `usePriorityMutations`, `useCustomerPriorities`, `useAssignPriority`, `getCustomersSeen`, `useSlaTiers`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/preferences/panes/__tests__/PrioritiesPane.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const prios = [
  { key: 'expedited', name: 'Expedited', rank: 20, icon: 'chevrons-up', color: 'red', pulse: true, is_default: false, is_active: true, sla_tier_id: 2 },
  { key: 'default', name: 'Default', rank: 0, icon: 'minus', color: 'zinc', pulse: false, is_default: true, is_active: true, sla_tier_id: null },
]
vi.mock('@/lib/api-priorities', () => ({
  getPriorities: vi.fn(async () => prios),
  patchPriority: vi.fn(async (key: string, body: object) => ({ ...prios.find(p => p.key === key)!, ...body })),
  createPriority: vi.fn(), deactivatePriority: vi.fn(), setDefaultPriority: vi.fn(),
  getCustomerPriorities: vi.fn(async () => []), getCustomersSeen: vi.fn(async () => []), assignPriority: vi.fn(),
}))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()),
  getSlaTiers: vi.fn(async () => [{ id: 1, name: 'Standard', target_minutes: 2880, is_default: true, business_hours_only: true, amber_threshold_percent: 20 },
                                    { id: 2, name: 'Fast', target_minutes: 480, is_default: false, business_hours_only: false, amber_threshold_percent: 20 }]) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/store/auth-store', () => ({ useAuthStore: (sel: (s: { user: { role: string } }) => unknown) => sel({ user: { role: 'admin' } }) }))
import { patchPriority } from '@/lib/api-priorities'
import { PrioritiesPane } from '@/components/preferences/panes/PrioritiesPane'

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('PrioritiesPane', () => {
  it('lists priorities by rank with their SLA tier and toggles pulse through PATCH', async () => {
    wrap(<PrioritiesPane />)
    const rows = await screen.findAllByTestId('priority-row')
    expect(rows[0]).toHaveTextContent('Expedited')
    expect(rows[0]).toHaveTextContent('Fast')
    fireEvent.click(screen.getByRole('switch', { name: 'Pulse Expedited' }))
    await waitFor(() => expect(patchPriority).toHaveBeenCalledWith('expedited', { pulse: false }))
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/preferences/panes/__tests__/PrioritiesPane.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pane**

```tsx
// src/components/preferences/panes/PrioritiesPane.tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsSection } from '../shared/SettingsComponents'
import { PriorityGlyph } from '@/components/common/PriorityGlyph'
import { getCustomersSeen, type CustomerSeen, type Priority, type PriorityColor, type PriorityIcon } from '@/lib/api-priorities'
import { useAssignPriority, useCustomerPriorities, usePriorities, usePriorityMutations } from '@/services/priorities'
import { useSlaTiers } from '@/services/sla'

const ICONS: PriorityIcon[] = ['chevrons-up', 'chevron-up', 'minus', 'chevron-down', 'chevrons-down', 'flame']
const COLORS: PriorityColor[] = ['red', 'amber', 'emerald', 'sky', 'violet', 'zinc']
const NONE = '__none__'

export function PrioritiesPane() {
  const { t } = useTranslation()
  const { data: list = [] } = usePriorities()
  const { data: tiers = [] } = useSlaTiers()
  const m = usePriorityMutations()
  const sorted = [...list].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name))
  const patch = (key: string, body: Parameters<typeof m.patch.mutate>[0]['body']) => m.patch.mutate({ key, body })
  const swapRank = (i: number, j: number) => {
    const a = sorted[i], b = sorted[j]
    if (!a || !b) return
    patch(a.key, { rank: b.rank }); patch(b.key, { rank: a.rank })
  }
  const [newName, setNewName] = useState('')

  return (
    <div className="space-y-8">
      <SettingsSection title={t('preferences.priorities.title')}>
        <p className="text-sm text-muted-foreground">{t('preferences.priorities.description')}</p>
        <div className="mt-3 divide-y rounded-md border">
          {sorted.map((p, i) => (
            <div key={p.key} data-testid="priority-row" className="grid grid-cols-[28px_1fr_auto] items-center gap-3 px-3 py-2">
              <PriorityGlyph priority={{ key: p.key, rank: p.rank, source_level: 'sample', source_id: null }} size="card" />
              <div className="flex flex-wrap items-center gap-2">
                <Input defaultValue={p.name} aria-label={`Name ${p.name}`} className="h-8 w-44"
                  onBlur={e => e.target.value !== p.name && patch(p.key, { name: e.target.value })} />
                <span className="font-mono text-xs text-muted-foreground">rank {p.rank}</span>
                <Button variant="ghost" size="icon" aria-label={`Move up ${p.name}`} disabled={i === 0} onClick={() => swapRank(i, i - 1)}><ArrowUp size={14} /></Button>
                <Button variant="ghost" size="icon" aria-label={`Move down ${p.name}`} disabled={i === sorted.length - 1} onClick={() => swapRank(i, i + 1)}><ArrowDown size={14} /></Button>
                <Select value={p.icon} onValueChange={v => patch(p.key, { icon: v as PriorityIcon })}>
                  <SelectTrigger className="h-8 w-40" aria-label={`Icon ${p.name}`}><SelectValue /></SelectTrigger>
                  <SelectContent>{ICONS.map(ic => <SelectItem key={ic} value={ic}>{ic}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={p.color} onValueChange={v => patch(p.key, { color: v as PriorityColor })}>
                  <SelectTrigger className="h-8 w-28" aria-label={`Color ${p.name}`}><SelectValue /></SelectTrigger>
                  <SelectContent>{COLORS.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select>
                <label className="flex items-center gap-1 text-xs">
                  <Switch checked={p.pulse} aria-label={`Pulse ${p.name}`} onCheckedChange={v => patch(p.key, { pulse: v })} /> {t('preferences.priorities.pulse')}
                </label>
                <Select value={p.sla_tier_id == null ? NONE : String(p.sla_tier_id)}
                  onValueChange={v => patch(p.key, { sla_tier_id: v === NONE ? null : Number(v) })}>
                  <SelectTrigger className="h-8 w-52" aria-label={`SLA tier ${p.name}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('preferences.priorities.followProfile')}</SelectItem>
                    {tiers.map(tier => <SelectItem key={tier.id} value={String(tier.id)}>{tier.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <label className="flex items-center gap-1"><input type="radio" name="default-priority" checked={p.is_default}
                  aria-label={`Default ${p.name}`} onChange={() => m.setDefault.mutate(p.key)} /> {t('preferences.priorities.default')}</label>
                <label className="flex items-center gap-1"><Switch checked={p.is_active} disabled={p.is_default} aria-label={`Active ${p.name}`}
                  onCheckedChange={v => patch(p.key, { is_active: v })} /> {t('preferences.priorities.active')}</label>
              </div>
            </div>
          ))}
        </div>
        <form className="mt-3 flex items-center gap-2" onSubmit={e => { e.preventDefault(); if (!newName.trim()) return
          m.create.mutate({ name: newName.trim(), rank: (sorted[0]?.rank ?? 0) + 10, icon: 'chevron-up', color: 'amber', pulse: false }); setNewName('') }}>
          <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder={t('preferences.priorities.newName')} className="h-8 w-56" />
          <Button type="submit" size="sm" variant="outline"><Plus size={14} /> {t('preferences.priorities.add')}</Button>
        </form>
      </SettingsSection>

      <CustomerPrioritiesSection priorities={sorted.filter(p => p.is_active)} />
    </div>
  )
}

function CustomerPrioritiesSection({ priorities }: { priorities: Priority[] }) {
  const { t } = useTranslation()
  const { data: rows = [] } = useCustomerPriorities()
  const assign = useAssignPriority()
  const [q, setQ] = useState(''); const [found, setFound] = useState<CustomerSeen[]>([])
  const search = async () => setFound(await getCustomersSeen(q))
  return (
    <SettingsSection title={t('preferences.priorities.customers')}>
      <p className="text-sm text-muted-foreground">{t('preferences.priorities.customersDescription')}</p>
      <div className="mt-3 flex items-center gap-2">
        <Input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} placeholder={t('preferences.priorities.searchCustomer')} className="h-8 w-72" />
        <Button size="sm" variant="outline" onClick={search}><Search size={14} /></Button>
      </div>
      {found.length > 0 && (
        <ul className="mt-2 divide-y rounded-md border text-sm">
          {found.map(c => (
            <li key={c.wp_customer_user_id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span>{c.customer_name ?? '—'} <span className="text-muted-foreground">{c.customer_email}</span></span>
              <Select onValueChange={v => assign.mutate({ level: 'customer', id: String(c.wp_customer_user_id), priority_key: v })}>
                <SelectTrigger className="h-8 w-44" aria-label={`Set priority for ${c.customer_email}`}><SelectValue placeholder={t('preferences.priorities.setPriority')} /></SelectTrigger>
                <SelectContent>{priorities.map(p => <SelectItem key={p.key} value={p.key}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
            </li>
          ))}
        </ul>
      )}
      <table className="mt-4 w-full text-sm">
        <thead className="text-xs uppercase text-muted-foreground"><tr><th className="text-start">Customer</th><th className="text-start">Priority</th><th className="text-start">Note</th><th /></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.wp_customer_user_id} className="border-t">
              <td className="py-1">{r.customer_name ?? r.wp_customer_user_id} <span className="text-muted-foreground">{r.customer_email}</span></td>
              <td>{priorities.find(p => p.key === r.priority_key)?.name ?? r.priority_key}</td>
              <td className="text-muted-foreground">{r.note}</td>
              <td className="text-end"><Button size="sm" variant="ghost" onClick={() => assign.mutate({ level: 'customer', id: String(r.wp_customer_user_id), priority_key: null })}>{t('preferences.priorities.clear')}</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </SettingsSection>
  )
}
```

Add to `locales/en.json` under `preferences`: `"priorities": "Priorities"` and a `"priorities"` object is not possible with the same key; use `"prioritiesPane": { "title": "Priorities", "description": "Manage sample priorities, their glyph, and the SLA tier each maps to. Default follows the analysis profile or service group tier.", "pulse": "Pulse", "followProfile": "Follow profile / group tier", "default": "Default", "active": "Active", "newName": "New priority name", "add": "Add", "customers": "Customer priorities", "customersDescription": "Set a priority for a customer account; their orders and samples inherit it unless overridden.", "searchCustomer": "Search customers seen on orders", "setPriority": "Set priority", "clear": "Clear" }` and reference `t('preferences.prioritiesPane.*')` in the component (rename the keys above accordingly).

Register in `panes.tsx` and generalize `SlaPane.tsx`: replace `const OVERRIDABLE: ('high' | 'expedited')[] = ['high', 'expedited']` with `const { data: overridable = [] } = useActivePriorities()` and map `overridable.filter(p => !p.is_default)`, passing `p.key` where `priority` was used and `p.name` for the label; change `InboxPriority` imports in the pane to `string`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/preferences/panes/__tests__/PrioritiesPane.test.tsx src/components/preferences/panes/__tests__`
Expected: pass, including the existing pane tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/preferences locales/en.json
git commit -m "feat(priority): Priorities pane (list, glyph, pulse, SLA tier, default, customers); SLA pane overrides follow the list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: SLA services take the effective key

**Files:**
- Modify: `src/lib/sla-resolution.ts` (`InboxPriority` → `string` in `SampleSlaInputs`, `buildGlobalPriorityToTierMap`, `buildPerGroupPriorityToTierMap`; `'normal'` sentinel → `'default'`)
- Modify: `src/services/sample-sla.ts` (lines ~118–130: drop `prioritiesQuery`/`prioByUid`; take `priorityKey` from the lookup's inline `priority?.key ?? 'default'`), `src/services/order-sla.ts`, `src/services/analysis-sla.ts`, `src/services/sla-subjects.ts`, `src/lib/inbox-sla.ts`, `src/hooks/use-inbox-samples.ts`
- Modify: `src/lib/api.ts` — add `priority?: EffectivePriority | null` to `SenaiteSample`/registry row, `SubSample`, inbox item, order row types; keep `InboxPriority` exported as `type InboxPriority = string` with a deprecation comment
- Test: `src/test/sla-resolution.test.ts` (existing; add one case)

**Interfaces:**
- Every SLA input takes `priority: string` (a priority key). The maps are keyed by key. `'default'` never has a row (sparsity contract).

- [ ] **Step 1: Add the failing case**

```ts
it('a custom priority key resolves through the global map', () => {
  const tiers = new Map([[1, { id: 1, name: 'Std', target_minutes: 2880, is_default: true }], [2, { id: 2, name: 'Fast', target_minutes: 240, is_default: false }]])
  const global = buildGlobalPriorityToTierMap([{ id: 9, priority: 'rush', sla_tier_id: 2, service_group_id: null }], tiers as never)
  expect(global.get('rush')?.id).toBe(2)
})
```

- [ ] **Step 2: Run to verify it fails (type error on `'rush'`)**

Run: `npx vitest run src/test/sla-resolution.test.ts && npm run typecheck`
Expected: typecheck FAIL — `'rush'` not assignable to `InboxPriority`.

- [ ] **Step 3: Implement**

In `src/lib/api.ts` line 5628 replace `export type InboxPriority = 'normal' | 'high' | 'expedited'` with:

```ts
/** @deprecated Priority keys are data now (see api-priorities.ts). Kept as a string alias for one release. */
export type InboxPriority = string
```

In `sla-resolution.ts` and each service, replace the `'normal'` default with `'default'` and read the key from the row: in `sample-sla.ts` delete `prioritiesQuery`, `prioByUid` and the `samplePrioritiesLookup` import; set `const priority = lookup.priority?.key ?? 'default'`. Do the same substitution in `order-sla.ts`, `analysis-sla.ts`, `sla-subjects.ts`, `inbox-sla.ts` and `use-inbox-samples.ts` (each currently builds a uid → priority map from the lookup; delete that map and read `item.priority_effective?.key ?? (item.priority === 'normal' ? 'default' : item.priority)` for inbox items, which still carry the legacy string this release).

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/test/sla-resolution.test.ts src/test/*sla* && npm run typecheck`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib src/services src/hooks src/test
git commit -m "feat(priority): SLA resolution keyed by priority key from the inline row shape

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Glyph on list surfaces; replace PriorityBadge

**Files:**
- Modify: `src/components/explorer/SampleCard.tsx`, `src/components/explorer/OrderRow.tsx`, `src/components/intake/OrderListRow.tsx`, `src/components/vial-board/VialBoardKanban.tsx` (vial card), `src/components/hplc/InboxFamilyGroup.tsx`, `src/components/hplc/InboxVialCard.tsx`, `src/components/hplc/WorksheetDrawerItems.tsx`, `src/components/hplc/WorksheetsListPage.tsx`, `src/components/intake/ActiveBoxesPage.tsx`, `src/components/senaite/SenaiteDashboard.tsx` (samples table id cell)
- Delete: `src/components/hplc/PriorityBadge.tsx` (all imports → `PriorityGlyph`)
- Test: `src/test/samples-list-priority-glyph.test.tsx`

**Interfaces:**
- Each surface renders `<PriorityGlyph priority={row.priority} size="row" />` immediately before the sample id in rows, and `size="card"` in the top-right of cards. Inbox family ordering: replace the string-rank map with `priority?.rank ?? 0`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/test/samples-list-priority-glyph.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/api-priorities', () => ({
  getPriorities: vi.fn(async () => [
    { key: 'expedited', name: 'Expedited', rank: 20, icon: 'chevrons-up', color: 'red', pulse: true, is_default: false, is_active: true, sla_tier_id: null },
    { key: 'default', name: 'Default', rank: 0, icon: 'minus', color: 'zinc', pulse: false, is_default: true, is_active: true, sla_tier_id: null },
  ]),
}))
import { SampleCard } from '@/components/explorer/SampleCard'

describe('SampleCard priority glyph', () => {
  it('draws the glyph from the inline priority shape without any extra request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const qc = new QueryClient()
    render(<QueryClientProvider client={qc}>
      <SampleCard sample={{ id: 'PB-0512', uid: 'u1', priority: { key: 'expedited', rank: 20, source_level: 'order', source_id: '3291' } } as never} />
    </QueryClientProvider>)
    expect(await screen.findByRole('img', { name: 'Expedited via order 3291' })).toBeInTheDocument()
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/priorities/resolve'))).toHaveLength(0)
  })
})
```

(Adjust the `SampleCard` prop name/shape to the real one; read the component first.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/test/samples-list-priority-glyph.test.tsx`
Expected: FAIL — no element with that role/name.

- [ ] **Step 3: Implement across surfaces**

For each file: `import { PriorityGlyph } from '@/components/common/PriorityGlyph'` and place the glyph. Row example (samples table id cell in `SenaiteDashboard.tsx`):

```tsx
<span className="inline-flex items-center gap-1.5">
  <PriorityGlyph priority={sample.priority} size="row" />
  <span className="font-mono">{sample.id}</span>
</span>
```

Card example (`InboxVialCard.tsx`, replacing `<PriorityBadge priority={...} />`):

```tsx
<PriorityGlyph priority={item.priority_effective} size="card" className="ms-auto" />
```

Inbox family ordering in `InboxFamilyGroup.tsx` / `use-inbox-samples.ts`: replace the `{ expedited: 2, high: 1, normal: 0 }` style rank map with `Math.max(...vials.map(v => v.priority_effective?.rank ?? 0))`.

`InboxBulkToolbar.tsx`: the priority dropdown lists `useActivePriorities()` and calls `useAssignPriorityBulk()` with `{ level: 'vial', id: String(v.sub_sample_pk), priority_key }` for the selected vials (the inbox items carry the native sub-sample pk; if a selected item has none, skip it and toast the count skipped).

Delete `PriorityBadge.tsx`; `git grep PriorityBadge src` must return nothing.

- [ ] **Step 4: Run tests, typecheck, lint on changed files**

Run: `npx vitest run src/test/samples-list-priority-glyph.test.tsx src/test/*inbox* && npm run typecheck && npx eslint $(git diff --name-only -- 'src/**/*.tsx' 'src/**/*.ts') --max-warnings 0`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(priority): glyph on samples, orders, vial board, inbox, worksheets, boxes; bulk assign in inbox; drop PriorityBadge

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Set controls on sample, sub-sample and order pages

**Files:**
- Modify: `src/components/senaite/SampleDetails.tsx` — basic-info card (parent) and sub-sample page header; header glyph next to the sample-type badge (`isParent` block ~line 4980)
- Modify: `src/components/OrderStatusPage.tsx` — order-level control + effective glyph in the order header
- Modify: `src/lib/api.ts` — `SenaiteLookupResult` gains `priority?: EffectivePriority | null`, `registry_pk?: number | null`, `explicit_priority_key?: string | null`; sub-sample rows gain `priority` and `priority_key`
- Test: `src/test/sample-details-priority-row.test.tsx`

**Interfaces:**
- Sample page: `<PrioritySelect level="sample" id={String(data.registry_pk)} explicitKey={data.explicit_priority_key ?? null} effective={data.priority} />` shown only when `registry_pk` is present (native row); otherwise a read-only glyph + "Set priority after receive" hint.
- Sub-sample page: `level="vial"` with `id={String(subSample.id)}`.
- Order page: `level="order"` with `id={order.order_number}`, `explicitKey={order.priority_key}`, `effective={order.effective_priority}`.
- Backend must expose `registry_pk` and `explicit_priority_key` on the details payload and `priority_key`/`effective_priority` on the order payload (one-line additions to the backend embed task; add to the backend plan's Task 8 if missing when this task starts).

- [ ] **Step 1: Write the failing test**

```tsx
// src/test/sample-details-priority-row.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/api-priorities', () => ({
  getPriorities: vi.fn(async () => [
    { key: 'high', name: 'High', rank: 10, icon: 'chevron-up', color: 'amber', pulse: false, is_default: false, is_active: true, sla_tier_id: null },
    { key: 'default', name: 'Default', rank: 0, icon: 'minus', color: 'zinc', pulse: false, is_default: true, is_active: true, sla_tier_id: null },
  ]),
  assignPriority: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { SamplePriorityRow } from '@/components/senaite/SamplePriorityRow'

describe('SamplePriorityRow', () => {
  it('shows the select for a native sample and the read-only hint otherwise', async () => {
    const qc = new QueryClient()
    const { rerender } = render(<QueryClientProvider client={qc}>
      <SamplePriorityRow registryPk={42} explicitKey={null} effective={{ key: 'high', rank: 10, source_level: 'customer', source_id: 'Acme' }} />
    </QueryClientProvider>)
    expect(await screen.findByRole('combobox', { name: 'Priority' })).toBeInTheDocument()
    rerender(<QueryClientProvider client={qc}>
      <SamplePriorityRow registryPk={null} explicitKey={null} effective={null} />
    </QueryClientProvider>)
    expect(screen.getByText('Set priority after receive')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/test/sample-details-priority-row.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/components/senaite/SamplePriorityRow.tsx
import { PriorityGlyph } from '@/components/common/PriorityGlyph'
import { PrioritySelect } from '@/components/common/PrioritySelect'
import type { EffectivePriority } from '@/lib/api-priorities'

export function SamplePriorityRow({ registryPk, explicitKey, effective, level = 'sample' }: {
  registryPk: number | null | undefined; explicitKey: string | null; effective: EffectivePriority | null | undefined
  level?: 'sample' | 'vial'
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-[11px] text-muted-foreground">Priority</span>
      <span className="flex items-center gap-2">
        <PriorityGlyph priority={effective} size="row" />
        {registryPk ? (
          <PrioritySelect level={level} id={String(registryPk)} explicitKey={explicitKey} effective={effective} compact className="w-56" />
        ) : (
          <span className="text-xs text-muted-foreground">Set priority after receive</span>
        )}
      </span>
    </div>
  )
}
```

Mount it in `SampleDetails.tsx` basic-info card (parent: `registryPk={data.registry_pk}`; sub-sample page: `level="vial"`, `registryPk={subSampleRow.id}`), and put `<PriorityGlyph priority={data.priority} size="header" />` beside the sample-type badge in the header. In `OrderStatusPage.tsx` header add the glyph (`size="header"`, `priority={order.effective_priority}`) and a `PrioritySelect level="order" id={order.order_number} explicitKey={order.priority_key ?? null} effective={order.effective_priority}`.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/test/sample-details-priority-row.test.tsx src/test/generated-coa-fallback-regen.test.tsx && npm run typecheck`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/senaite/SamplePriorityRow.tsx src/components/senaite/SampleDetails.tsx src/components/OrderStatusPage.tsx src/lib/api.ts src/test/sample-details-priority-row.test.tsx
git commit -m "feat(priority): set controls on sample, sub-sample and order pages; header glyphs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Receive wizard

**Files:**
- Modify: `src/components/intake/ReceiveWizard/SampleInfoPanel.tsx` (after the `Order #` stacked field, ~line 99)
- Modify: `src/components/intake/ReceiveWizard/VialDetailsTab.tsx` (vial-level row)
- Modify: `src/components/intake/ReceiveWizard/WizardHeader.tsx` (header glyph beside the order label)
- Modify: `src/components/intake/ReceiveWizard/useParentSampleDetails.ts` (expose `registry_pk`, `explicit_priority_key`, `priority` from the details payload)
- Test: `src/components/intake/ReceiveWizard/__tests__/SampleInfoPanel.priority.test.tsx`

**Interfaces:**
- Consumes `SamplePriorityRow` from Task 8.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/intake/ReceiveWizard/__tests__/SampleInfoPanel.priority.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/api-priorities', () => ({
  getPriorities: vi.fn(async () => [
    { key: 'high', name: 'High', rank: 10, icon: 'chevron-up', color: 'amber', pulse: false, is_default: false, is_active: true, sla_tier_id: null },
    { key: 'default', name: 'Default', rank: 0, icon: 'minus', color: 'zinc', pulse: false, is_default: true, is_active: true, sla_tier_id: null },
  ]),
  assignPriority: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { SampleInfoPanel } from '@/components/intake/ReceiveWizard/SampleInfoPanel'

describe('SampleInfoPanel priority', () => {
  it('renders the Priority row with the effective source when the sample is native', async () => {
    const qc = new QueryClient()
    render(<QueryClientProvider client={qc}>
      <SampleInfoPanel details={{ client: 'Acme', contact: 'J', sample_type: 'Peptide', client_order_number: '3291',
        registry_pk: 42, explicit_priority_key: null, priority: { key: 'high', rank: 10, source_level: 'customer', source_id: 'Acme' } } as never} />
    </QueryClientProvider>)
    expect(await screen.findByRole('combobox', { name: 'Priority' })).toHaveTextContent('Inherit (High via customer (Acme))')
  })
})
```

(Read `SampleInfoPanel`'s real props first and pass whatever else it requires.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/intake/ReceiveWizard/__tests__/SampleInfoPanel.priority.test.tsx`
Expected: FAIL — no combobox.

- [ ] **Step 3: Implement**

`SampleInfoPanel.tsx`, after the `Order #` field:

```tsx
<SamplePriorityRow registryPk={details.registry_pk} explicitKey={details.explicit_priority_key ?? null} effective={details.priority} />
```

`VialDetailsTab.tsx`: `<SamplePriorityRow level="vial" registryPk={vial.id} explicitKey={vial.priority_key ?? null} effective={vial.priority} />` under the vial's assignment fields. `WizardHeader.tsx`: `<PriorityGlyph priority={details?.priority} size="header" />` before the order label.

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `npx vitest run src/components/intake && npm run typecheck && npx eslint src/components/intake --max-warnings 0`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/intake
git commit -m "feat(priority): receive wizard shows and sets priority (sample panel, vial tab, header glyph)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Activity log rendering, full gates, hand-off

**Files:**
- Modify: `src/components/senaite/SampleActivityLog.tsx` — render `source === 'priority_audit'` events with the glyph-colored dot and the description verbatim
- Test: extend an existing activity-log test if present; otherwise `src/test/sample-activity-priority.test.tsx` asserting the description "Priority: Inherit → High" renders.

- [ ] **Step 1: Write the failing test**

```tsx
// src/test/sample-activity-priority.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()),
  getSampleActivity: vi.fn(async () => [
    { timestamp: '2026-09-09T17:00:00Z', type: 'priority', description: 'Priority: Inherit → High', source: 'priority_audit', user_id: 5, note: 'VIP' },
  ]) }))
vi.mock('@/lib/api-priorities', () => ({ getPriorities: vi.fn(async () => []) }))
import { SampleActivityLog } from '@/components/senaite/SampleActivityLog'

describe('SampleActivityLog priority lines', () => {
  it('renders a priority_audit event with its description and note', async () => {
    const qc = new QueryClient()
    render(<QueryClientProvider client={qc}><SampleActivityLog sampleId="PB-0512" /></QueryClientProvider>)
    expect(await screen.findByText('Priority: Inherit → High')).toBeInTheDocument()
    expect(screen.getByText('VIP')).toBeInTheDocument()
  })
})
```

(Read `SampleActivityLog`'s props first; if it takes the events rather than fetching, pass them directly and drop the `getSampleActivity` mock.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/test/sample-activity-priority.test.tsx`
Expected: FAIL — the unknown `source` renders without the description, or the note is not shown.

- [ ] **Step 3: Implement**

In `SampleActivityLog.tsx`, in the per-source render switch, add a branch for `source === 'priority_audit'` that renders an `ArrowUpNarrowWide` icon (lucide) as the row marker, the `description` as the primary text, and `note` in muted text when present.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/test/sample-activity-priority.test.tsx`
Expected: 1 passed.
- [ ] **Step 5:** `npm run check:all` (typecheck, lint, ast:lint, format:check, rust, tests). Fix anything in changed files; pre-existing failures are listed in the vault (App.test, peptide-requests-list, worksheets-inbox-lanes, PackagingPanel) and must be unchanged.
- [ ] **Step 6:** `gitnexus_detect_changes()`; commit; push; PR titled `feat(priority): sample priority — data-driven priorities, four-level resolution, glyphs, SLA mapping` with the spec and both plans linked; release as a Mk1 minor (1.17.0) per the accumark-deploy skill (full deploy; migration runs on backend boot).
