# Order Explorer + Order Dashboard SLA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the standard SLA indicator (`OrderSlaCell`) on OrderExplorer and OrderDashboard in place of their hardcoded elapsed-time columns, via a new extracted `useSenaiteLookupMap(orders)` hook that OrderStatusPage and CustomerStatusPage are also retrofitted onto.

**Architecture:** Extract the duplicated SENAITE-lookup-map chain (sampleIds → serialized `useQueries(enqueueSenaiteLookup)` → `Map<senaiteId, {data,isLoading,isError}>`) into `useSenaiteLookupMap`. New surfaces call it + the existing `useOrderSlaStatuses(orders, map)` and render `OrderSlaCell` per row. The two existing pages delete their inline copies and call the hook (pure DRY, behavior-preserving).

**Tech Stack:** React 19, TanStack Query (`useQueries`), vitest, shadcn/ui. No backend, schema, or i18n changes.

**Spec:** `docs/superpowers/specs/2026-06-01-order-explorer-dashboard-sla-design.md`

**Worktree:** `C:\tmp\accu-mk1-wave1` — bind-mounted by `accu-mk1-frontend` at `:3101`. All edits here. HMR auto-reloads; restart only if it misses (`docker restart accu-mk1-frontend`).

**Commit convention:** `feat(sla):` / `refactor(sla):` + brief description. One commit per task. `.planning/STATE.md` ALWAYS stays out of commits. Never include `docs/superpowers/handoffs/`.

**Lint note:** Run scoped ESLint from INSIDE the worktree: `npx eslint <files>` (NOT `npm run lint -- <files>`). Pre-existing baseline noise lives in `src/lib/api.ts` / `src/components/OrderStatusPage.tsx` — only flag NEW errors. `Array<T>` forbidden (use `T[]`). Zustand: selector syntax only, no destructuring.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/services/senaite-lookup-map.ts` | NEW | `useSenaiteLookupMap(orders)` — sampleIds collection + serialized `useQueries` + map build. Returns `{ sampleLookupMap, sampleIds, isLoading, isError }`. |
| `src/test/senaite-lookup-map.test.tsx` | NEW | Hook tests. |
| `src/components/OrderExplorer.tsx` | MODIFY | Call the two hooks; replace `processing_time` column cell with `OrderSlaCell`; header → "SLA". |
| `src/components/dashboard/OrderDashboard.tsx` | MODIFY | Call the two hooks; replace orange "Age" cell with `OrderSlaCell`; header → "SLA"; remove dead `formatRelativeDate`. |
| `src/components/OrderStatusPage.tsx` | MODIFY | Retrofit: delete inline chain, use `useSenaiteLookupMap(orders)`. |
| `src/components/CustomerStatusPage.tsx` | MODIFY | Retrofit: delete inline chain, use `useSenaiteLookupMap(orders)`. |

**Reference types/functions (already exist — do not redefine):**
- `ExplorerOrder` (`@/lib/api`) — has `order_id: string`, `sample_results: Record<string, {senaite_id, status, ...}> | null`, `created_at`, `completed_at`, `wp_order_status`, `status`.
- `SenaiteLookupResult` (`@/lib/api`).
- `enqueueSenaiteLookup(id): Promise<SenaiteLookupResult>` (`@/components/explorer/senaite-queue`).
- `useOrderSlaStatuses(orders, sampleLookupMap): { verdictByOrderId, sampleStatusesBySampleId, isLoading, isError }` (`@/services/order-sla`).
- `OrderSlaCell` props: `{ verdict: OrderSlaVerdict | undefined, isLoading?, isError? }` — wait, verify: it's `{ verdict, isLoading, isError }` where `verdict` is required `OrderSlaVerdict`. The call sites pass `verdict={map.get(id)}` which may be `undefined`; `OrderSlaCell` treats undefined verdict via its `color` access. CHECK the actual prop type when wiring (Task 2/3) and pass a fallback if required — see Task 2 note.

---

## Task 1 — Extract `useSenaiteLookupMap` (TDD)

**Files:**
- Create: `src/services/senaite-lookup-map.ts`
- Test: `src/test/senaite-lookup-map.test.tsx`

### Step 1.1 — Write the failing tests

- [ ] Create `src/test/senaite-lookup-map.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { ExplorerOrder, SenaiteLookupResult } from '@/lib/api'

const enqueueSenaiteLookupMock = vi.fn<(id: string) => Promise<SenaiteLookupResult>>()

vi.mock('@/components/explorer/senaite-queue', () => ({
  enqueueSenaiteLookup: (id: string) => enqueueSenaiteLookupMock(id),
}))

const { useSenaiteLookupMap } = await import('@/services/senaite-lookup-map')

function Wrapper({ children }: { children: React.ReactNode }) {
  const [qc] = React.useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  )
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

function makeLookup(sampleId: string): SenaiteLookupResult {
  return {
    sample_id: sampleId,
    sample_uid: `uid-${sampleId}`,
    review_state: 'sample_received',
    date_received: '2026-01-01T09:00:00',
    analyses: [],
  } as unknown as SenaiteLookupResult
}

/** Minimal ExplorerOrder with the only fields the hook reads. */
function makeOrder(
  orderId: string,
  sampleResults: Record<string, { senaite_id: string | null; status?: string }> | null
): ExplorerOrder {
  return {
    order_id: orderId,
    sample_results: sampleResults,
  } as unknown as ExplorerOrder
}

beforeEach(() => {
  enqueueSenaiteLookupMock.mockReset().mockImplementation((id: string) => Promise.resolve(makeLookup(id)))
})

describe('useSenaiteLookupMap', () => {
  it('returns empty map + ids and isLoading false for empty orders', async () => {
    const { result } = renderHook(() => useSenaiteLookupMap([]), { wrapper: Wrapper })
    await waitFor(() => {
      expect(result.current.sampleIds).toEqual([])
      expect(result.current.sampleLookupMap.size).toBe(0)
      expect(result.current.isLoading).toBe(false)
    })
    expect(enqueueSenaiteLookupMock).not.toHaveBeenCalled()
  })

  it('collects unique senaite_ids, skipping failed and null entries', async () => {
    const orders = [
      makeOrder('o1', {
        a: { senaite_id: 'PB-001', status: 'ok' },
        b: { senaite_id: 'PB-002', status: 'failed' }, // skipped: failed
        c: { senaite_id: null, status: 'ok' },         // skipped: null id
      }),
      makeOrder('o2', { d: { senaite_id: 'PB-003', status: 'ok' } }),
      makeOrder('o3', null), // no sample_results
    ]
    const { result } = renderHook(() => useSenaiteLookupMap(orders), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.sampleIds.length).toBe(2))
    expect(result.current.sampleIds).toEqual(['PB-001', 'PB-003'])
  })

  it('dedupes the same senaite_id across multiple orders', async () => {
    const orders = [
      makeOrder('o1', { a: { senaite_id: 'PB-001', status: 'ok' } }),
      makeOrder('o2', { b: { senaite_id: 'PB-001', status: 'ok' } }), // dupe
    ]
    const { result } = renderHook(() => useSenaiteLookupMap(orders), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.sampleIds).toEqual(['PB-001']))
  })

  it('builds a map carrying data/isLoading/isError per id', async () => {
    const orders = [makeOrder('o1', { a: { senaite_id: 'PB-001', status: 'ok' } })]
    const { result } = renderHook(() => useSenaiteLookupMap(orders), { wrapper: Wrapper })
    await waitFor(() => {
      const entry = result.current.sampleLookupMap.get('PB-001')
      expect(entry?.data?.sample_uid).toBe('uid-PB-001')
      expect(entry?.isError).toBe(false)
    })
    expect(result.current.isLoading).toBe(false)
  })

  it('isError aggregates true when a lookup rejects', async () => {
    enqueueSenaiteLookupMock.mockReset().mockRejectedValue(new Error('zope down'))
    const orders = [makeOrder('o1', { a: { senaite_id: 'PB-001', status: 'ok' } })]
    const { result } = renderHook(() => useSenaiteLookupMap(orders), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.sampleLookupMap.get('PB-001')?.isError).toBe(true)
  })
})
```

### Step 1.2 — Run tests to verify they fail

Run:
```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/senaite-lookup-map.test.tsx'
```
Expected: FAIL — `Cannot find module '@/services/senaite-lookup-map'`.

### Step 1.3 — Implement `useSenaiteLookupMap`

- [ ] Create `src/services/senaite-lookup-map.ts`:

```ts
import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { type ExplorerOrder, type SenaiteLookupResult } from '@/lib/api'
import { enqueueSenaiteLookup } from '@/components/explorer/senaite-queue'

export interface SenaiteLookupEntry {
  data?: SenaiteLookupResult
  isLoading: boolean
  isError: boolean
}

export interface SenaiteLookupMapResult {
  /** senaiteId → lookup query state. Keyed by senaite_id (human sample id). */
  sampleLookupMap: Map<string, SenaiteLookupEntry>
  /** Unique senaite_ids collected from the orders (failed/empty skipped). */
  sampleIds: string[]
  /** True while any underlying per-sample lookup is still loading. */
  isLoading: boolean
  /** True if any underlying per-sample lookup errored. */
  isError: boolean
}

/**
 * Per-sample SENAITE lookup map for a list of orders. Extracts the chain that
 * was duplicated inline in OrderStatusPage and CustomerStatusPage: collect the
 * unique senaite_ids referenced by the orders' sample_results, fire one
 * serialized SENAITE lookup per id (via enqueueSenaiteLookup, which throttles
 * to avoid overwhelming Zope), and expose a Map keyed by senaite_id.
 *
 * The query key `['senaite','lookup',id]` is shared across every surface that
 * uses this hook, so a lookup fetched on one page is reused warm on another.
 * Feed the returned `sampleLookupMap` to `useOrderSlaStatuses(orders, map)`.
 */
export function useSenaiteLookupMap(orders: ExplorerOrder[]): SenaiteLookupMapResult {
  // Collect unique sample IDs from the orders (skip failed/empty ones).
  const sampleIds = useMemo(() => {
    const ids: string[] = []
    for (const order of orders) {
      if (!order.sample_results) continue
      for (const entry of Object.values(order.sample_results)) {
        if (
          entry.senaite_id &&
          entry.status !== 'failed' &&
          !ids.includes(entry.senaite_id)
        ) {
          ids.push(entry.senaite_id)
        }
      }
    }
    return ids
  }, [orders])

  // Fetch sample details from SENAITE — serialized to avoid overwhelming Zope.
  const sampleQueries = useQueries({
    queries: sampleIds.map(id => ({
      queryKey: ['senaite', 'lookup', id],
      queryFn: () => enqueueSenaiteLookup(id),
      staleTime: 15 * 60_000,
      retry: 1,
    })),
  })

  const sampleLookupMap = useMemo(() => {
    const map = new Map<string, SenaiteLookupEntry>()
    sampleIds.forEach((id, idx) => {
      map.set(id, {
        data: sampleQueries[idx]?.data,
        isLoading: sampleQueries[idx]?.isLoading ?? true,
        isError: sampleQueries[idx]?.isError ?? false,
      })
    })
    return map
  }, [sampleIds, sampleQueries])

  const isLoading = sampleQueries.some(q => q.isLoading)
  const isError = sampleQueries.some(q => q.isError)

  return { sampleLookupMap, sampleIds, isLoading, isError }
}
```

### Step 1.4 — Run tests to verify they pass

Run:
```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/senaite-lookup-map.test.tsx'
```
Expected: PASS (5 tests).

### Step 1.5 — Scoped lint + typecheck

```bash
npx eslint src/services/senaite-lookup-map.ts src/test/senaite-lookup-map.test.tsx
npm run typecheck
```
Run from inside `C:\tmp\accu-mk1-wave1`. Expected: clean. (If `useQueries` typing needs the `combine` option or an explicit generic, the existing inline usages in OrderStatusPage compile fine without it — mirror them; do not add generics not present there.)

### Step 1.6 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add src/services/senaite-lookup-map.ts src/test/senaite-lookup-map.test.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): extract useSenaiteLookupMap hook for shared per-sample lookups"
```

---

## Task 2 — Wire SLA into OrderExplorer

**Files:**
- Modify: `src/components/OrderExplorer.tsx`

### Step 2.1 — Add imports

- [ ] At the top of `src/components/OrderExplorer.tsx`, add (near the existing `@/services` / `@/components/explorer` imports):

```ts
import { useSenaiteLookupMap } from '@/services/senaite-lookup-map'
import { useOrderSlaStatuses } from '@/services/order-sla'
import { OrderSlaCell } from '@/components/explorer/OrderSlaCell'
```

### Step 2.2 — Call the hooks in the component body

- [ ] Find the `filteredOrders` memo (around line 272-279, the `hideTestOrders` filter that returns `ExplorerOrder[] | undefined`). Immediately AFTER it, add:

```ts
const ordersForSla = filteredOrders ?? []
const { sampleLookupMap, isLoading: slaMapLoading, isError: slaMapError } =
  useSenaiteLookupMap(ordersForSla)
const { verdictByOrderId, isLoading: slaVerdictLoading, isError: slaVerdictError } =
  useOrderSlaStatuses(ordersForSla, sampleLookupMap)
const slaIsLoading = slaMapLoading || slaVerdictLoading
const slaIsError = slaMapError || slaVerdictError
```

These are top-level hook calls (unconditional) — `filteredOrders` may be `undefined` before orders load, so `ordersForSla` coalesces to `[]` (the hooks handle empty input → empty map, `isLoading: false`).

### Step 2.3 — Replace the `processing_time` column cell

- [ ] Find the `processing_time` column def (around line 417-436):

```tsx
    {
      id: 'processing_time',
      header: 'Processing Time',
      size: 120,
      minSize: 80,
      enableSorting: false,
      cell: ({ row }) => {
        const order = row.original
        return (
          <span
            className={cn(
              'font-mono text-sm',
              order.wp_order_status === 'complete' ? 'text-green-600' : 'text-yellow-600'
            )}
          >
            {formatProcessingTime(order.created_at, order.completed_at)}
          </span>
        )
      },
    },
```

Replace the whole object with:

```tsx
    {
      id: 'sla',
      header: 'SLA',
      size: 120,
      minSize: 80,
      enableSorting: false,
      cell: ({ row }) => (
        <OrderSlaCell
          verdict={verdictByOrderId.get(row.original.order_id)}
          isLoading={slaIsLoading}
          isError={slaIsError}
        />
      ),
    },
```

**Prop-type check:** Open `src/components/explorer/OrderSlaCell.tsx` and confirm the `verdict` prop accepts `undefined` (the map `.get()` returns `OrderSlaVerdict | undefined`). The component renders `verdict.color` — if the prop type is non-optional `OrderSlaVerdict`, either (a) it already tolerates undefined at runtime via the loading/error short-circuit (pass `isLoading`/`isError` so it never reads `.color` when undefined), or (b) pass a fallback `verdict={verdictByOrderId.get(row.original.order_id) ?? { color: 'awaiting' }}`. Check how OrderRow/OrderStatusPage pass it (OrderRow passes `slaVerdict={orderSla.verdictByOrderId.get(order.order_id)}` as an optional prop) and match that contract. If OrderSlaCell's `verdict` is required and OrderRow guards before rendering, replicate the guard: render the cell only when a verdict exists, else fall through to loading/awaiting. Use the `{ color: 'awaiting' }` fallback as the safe default if unsure — it produces the `—` awaiting state.

### Step 2.4 — Remove now-dead `formatProcessingTime`

- [ ] `formatProcessingTime` (defined ~line 91) is now unused (it was the only consumer). Confirm with:
```bash
grep -n "formatProcessingTime" /c/tmp/accu-mk1-wave1/src/components/OrderExplorer.tsx
```
If the only hit is the definition, delete the function. If TypeScript/ESLint flags it as unused after the cell swap, that confirms removal is needed. (`formatDate` stays — still used by Created/Completed columns.)

### Step 2.5 — Verify + lint + typecheck

```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/senaite-lookup-map.test.tsx src/test/order-sla.test.tsx src/test/order-sla-cell.test.tsx'
```
Expected: green (no behavior change to those units).

```bash
npx eslint src/components/OrderExplorer.tsx
npm run typecheck
```
Run from inside the worktree. Expected: clean (no NEW errors).

### Step 2.6 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/OrderExplorer.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): SLA column on OrderExplorer (replaces Processing Time)"
```

---

## Task 3 — Wire SLA into OrderDashboard

**Files:**
- Modify: `src/components/dashboard/OrderDashboard.tsx`

### Step 3.1 — Add imports

- [ ] At the top of `src/components/dashboard/OrderDashboard.tsx`, add:

```ts
import { useSenaiteLookupMap } from '@/services/senaite-lookup-map'
import { useOrderSlaStatuses } from '@/services/order-sla'
import { OrderSlaCell } from '@/components/explorer/OrderSlaCell'
```

### Step 3.2 — Hoist the displayed slice + call the hooks

- [ ] Find the derived-data block (around line 186-190):

```ts
  const realOrders = orders.filter(o => !isTestOrder(o))
  const outstandingOrders = realOrders.filter(o => o.wp_order_status !== 'complete' && o.status !== 'failed' && o.status !== 'partial_failure')
  const failedOrders = realOrders.filter(o => o.status === 'failed' || o.status === 'partial_failure')
  const completedOrders = realOrders.filter(o => o.wp_order_status === 'complete')
  const chartData = useMemo(() => buildOrderChart(realOrders), [realOrders])
```

Immediately AFTER `chartData`, add a memoized "displayed orders" slice (the same `[...outstandingOrders, ...failedOrders].slice(0, 25)` the table renders) and the SLA hooks:

```ts
  const displayedOrders = useMemo(
    () => [...outstandingOrders, ...failedOrders].slice(0, 25),
    [outstandingOrders, failedOrders]
  )
  const { sampleLookupMap, isLoading: slaMapLoading, isError: slaMapError } =
    useSenaiteLookupMap(displayedOrders)
  const { verdictByOrderId, isLoading: slaVerdictLoading, isError: slaVerdictError } =
    useOrderSlaStatuses(displayedOrders, sampleLookupMap)
  const slaIsLoading = slaMapLoading || slaVerdictLoading
  const slaIsError = slaMapError || slaVerdictError
```

**Note:** `outstandingOrders`/`failedOrders` are plain `const` filters recomputed each render (new array refs), so `displayedOrders`'s `useMemo` will recompute each render too — acceptable (the hook's internal `sampleIds` memo + the shared query cache absorb it; `sampleIds` only churns when the actual id set changes). Do NOT refactor the existing filters into memos (out of scope).

### Step 3.3 — Use the hoisted slice in the table map

- [ ] Find the table body map (around line 306):

```tsx
                      {[...outstandingOrders, ...failedOrders].slice(0, 25).map(o => {
```

Replace with:

```tsx
                      {displayedOrders.map(o => {
```

### Step 3.4 — Replace the "Age" header + cell

- [ ] Find the "Age" header (around line 302):

```tsx
                        <TableHead className="w-20 text-right">Age</TableHead>
```

Replace with:

```tsx
                        <TableHead className="w-20 text-right">SLA</TableHead>
```

- [ ] Find the Age cell (around line 324-326):

```tsx
                            <TableCell className="text-right text-xs font-mono text-orange-400 w-20">
                              {formatRelativeDate(o.created_at)}
                            </TableCell>
```

Replace with:

```tsx
                            <TableCell className="text-right w-20">
                              <OrderSlaCell
                                verdict={verdictByOrderId.get(o.order_id)}
                                isLoading={slaIsLoading}
                                isError={slaIsError}
                              />
                            </TableCell>
```

(Use the same `verdict` prop contract you settled in Task 2.3 — if a fallback `?? { color: 'awaiting' }` was needed there, use it here too.)

### Step 3.5 — Remove now-dead `formatRelativeDate`

- [ ] `formatRelativeDate` (defined ~line 68-79) was the only consumer of that helper. Confirm:
```bash
grep -n "formatRelativeDate" /c/tmp/accu-mk1-wave1/src/components/dashboard/OrderDashboard.tsx
```
If the only remaining hit is the definition, delete the function (ESLint `no-unused-vars` will flag it otherwise).

### Step 3.6 — Verify + lint + typecheck

```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/senaite-lookup-map.test.tsx src/test/order-sla.test.tsx src/test/order-sla-cell.test.tsx'
```
Expected: green.

```bash
npx eslint src/components/dashboard/OrderDashboard.tsx
npm run typecheck
```
Run from inside the worktree. Expected: clean.

### Step 3.7 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/dashboard/OrderDashboard.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "feat(sla): SLA column on OrderDashboard outstanding-orders queue (replaces Age)"
```

---

## Task 4 — Retrofit OrderStatusPage onto the hook

**Files:**
- Modify: `src/components/OrderStatusPage.tsx`

This is a pure DRY extraction — delete the inline chain, call the hook, keep everything downstream identical. Behavior must not change; the existing `src/test/order-row.test.tsx` is the regression guard.

### Step 4.1 — Add the hook import

- [ ] Add near the existing `@/services/order-sla` import (line ~57):

```ts
import { useSenaiteLookupMap } from '@/services/senaite-lookup-map'
```

### Step 4.2 — Replace the inline chain

- [ ] Find the inline chain (around lines 614-661): the `sampleIds` memo, the `sampleQueries = useQueries({...})` block, and the `sampleLookupMap` memo. The exact current code:

```ts
  // Collect all unique sample IDs from displayed orders (skip failed/empty ones)
  const sampleIds = useMemo(() => {
    const ids: string[] = []
    for (const order of orders) {
      if (order.sample_results) {
        for (const entry of Object.values(order.sample_results)) {
          if (
            entry.senaite_id &&
            entry.status !== 'failed' &&
            !ids.includes(entry.senaite_id)
          ) {
            ids.push(entry.senaite_id)
          }
        }
      }
    }
    return ids
  }, [orders])

  // Fetch sample details from SENAITE — serialized to avoid overwhelming Zope
  const sampleQueries = useQueries({
    queries: sampleIds.map(id => ({
      queryKey: ['senaite', 'lookup', id],
      queryFn: () => enqueueSenaiteLookup(id),
      staleTime: 15 * 60_000,
      retry: 1,
    })),
  })

  // Build lookup map: sampleId → query result
  const sampleLookupMap = useMemo(() => {
    const map = new Map<
      string,
      {
        data?: SenaiteLookupResult
        isLoading: boolean
        isError: boolean
      }
    >()
    sampleIds.forEach((id, idx) => {
      map.set(id, {
        data: sampleQueries[idx]?.data,
        isLoading: sampleQueries[idx]?.isLoading ?? true,
        isError: sampleQueries[idx]?.isError ?? false,
      })
    })
    return map
  }, [sampleIds, sampleQueries])
```

Replace that ENTIRE block with:

```ts
  // Per-sample SENAITE lookup map (shared hook — see useSenaiteLookupMap).
  // `sampleLookupMap` is consumed below by the analysis-state filter
  // (filteredOrders) and by useOrderSlaStatuses; built from the full `orders`
  // set so filtered lookups are always present.
  const { sampleLookupMap } = useSenaiteLookupMap(orders)
```

Leave the `filteredOrders` memo (which reads `sampleLookupMap`), `useOrderSlaStatuses(filteredOrders, sampleLookupMap)`, and `attentionCount` exactly as they are.

### Step 4.3 — Remove now-unused imports

- [ ] `useQueries` and `enqueueSenaiteLookup` are no longer used in this file (the hook owns them now). `SenaiteLookupResult` is STILL used elsewhere in the file (type annotations at lines ~99/129/150/317) — keep it.
  - Change `import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'` → `import { useQuery, useQueryClient } from '@tanstack/react-query'`.
  - Delete `import { enqueueSenaiteLookup } from '@/components/explorer/senaite-queue'`.
  - Verify both are truly unused first:
    ```bash
    grep -n "useQueries\|enqueueSenaiteLookup" /c/tmp/accu-mk1-wave1/src/components/OrderStatusPage.tsx
    ```
    After the Step 4.2 replace, the only hits should be the import lines themselves — then remove them.

### Step 4.4 — Verify no behavior change

```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/order-row.test.tsx'
```
Expected: all pass (unchanged from before the retrofit).

```bash
npx eslint src/components/OrderStatusPage.tsx
npm run typecheck
```
Run from inside the worktree. Expected: clean apart from the known pre-existing baseline error at `OrderStatusPage.tsx:77` (`consistent-type-definitions`) — that one is NOT yours.

### Step 4.5 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/OrderStatusPage.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "refactor(sla): OrderStatusPage uses shared useSenaiteLookupMap"
```

---

## Task 5 — Retrofit CustomerStatusPage onto the hook

**Files:**
- Modify: `src/components/CustomerStatusPage.tsx`

Same pure DRY extraction. Regression guard: `src/test/customer-status-page.test.tsx`.

### Step 5.1 — Add the hook import

- [ ] Add near the existing `@/services/order-sla` import (line ~91):

```ts
import { useSenaiteLookupMap } from '@/services/senaite-lookup-map'
```

### Step 5.2 — Replace the inline chain

- [ ] Find the inline chain (around lines 685-715): the `sampleIds` memo, `sampleQueries = useQueries({...})`, and `sampleLookupMap` memo. It is byte-identical to OrderStatusPage's. The `sampleIds` memo:

```ts
  const sampleIds = useMemo(() => {
    const ids: string[] = []
    for (const order of orders) {
      if (order.sample_results) {
        for (const entry of Object.values(order.sample_results)) {
          if (
            entry.senaite_id &&
            entry.status !== 'failed' &&
            !ids.includes(entry.senaite_id)
          ) {
            ids.push(entry.senaite_id)
          }
        }
      }
    }
    return ids
  }, [orders])

  const sampleQueries = useQueries({
    queries: sampleIds.map(id => ({
      queryKey: ['senaite', 'lookup', id],
      queryFn: () => enqueueSenaiteLookup(id),
      staleTime: 15 * 60_000,
      retry: 1,
    })),
  })

  const sampleLookupMap = useMemo(() => {
    const map = new Map<
      string,
      {
        data?: SenaiteLookupResult
        isLoading: boolean
        isError: boolean
      }
    >()
    sampleIds.forEach((id, idx) => {
      map.set(id, {
        data: sampleQueries[idx]?.data,
        isLoading: sampleQueries[idx]?.isLoading ?? true,
        isError: sampleQueries[idx]?.isError ?? false,
      })
    })
    return map
  }, [sampleIds, sampleQueries])
```

**Read the file first** to capture the exact span (the surrounding variable names and the `// ...` comments differ slightly from OrderStatusPage). Replace that entire block with:

```ts
  // Per-sample SENAITE lookup map (shared hook — see useSenaiteLookupMap).
  const { sampleLookupMap } = useSenaiteLookupMap(orders)
```

Leave the existing `useOrderSlaStatuses(orders, sampleLookupMap)` call and all downstream usages unchanged.

**Caution:** CustomerStatusPage has a SECOND `sampleLookupMap`-shaped type annotation around line 907-910 (a prop type on an inner sub-component). That is NOT the inline chain — do not touch it. Only remove the `useMemo`/`useQueries` chain that PRODUCES the map in the page body (~685-715).

### Step 5.3 — Remove now-unused imports

- [ ] After the replace, check:
```bash
grep -n "useQueries\|enqueueSenaiteLookup" /c/tmp/accu-mk1-wave1/src/components/CustomerStatusPage.tsx
```
- Change `import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'` → drop `useQueries` (verify no other `useQueries` usage remains).
- Delete `import { enqueueSenaiteLookup } from '@/components/explorer/senaite-queue'` (verify no other usage).
- `SenaiteLookupResult` is still used (the inner-component prop type at ~907) — KEEP it.

### Step 5.4 — Verify no behavior change

```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/customer-status-page.test.tsx'
```
Expected: all pass (unchanged).

```bash
npx eslint src/components/CustomerStatusPage.tsx
npm run typecheck
```
Run from inside the worktree. Expected: clean (no NEW errors).

### Step 5.5 — Commit

```bash
git -C /c/tmp/accu-mk1-wave1 add src/components/CustomerStatusPage.tsx
git -C /c/tmp/accu-mk1-wave1 commit -m "refactor(sla): CustomerStatusPage uses shared useSenaiteLookupMap"
```

---

## Task 6 — Final regression sweep + manual smoke

### Step 6.1 — Full SLA + affected-page test suite

```bash
docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/senaite-lookup-map.test.tsx src/test/order-sla.test.tsx src/test/order-sla-cell.test.tsx src/test/order-row.test.tsx src/test/customer-status-page.test.tsx src/test/sla-subjects.test.tsx src/test/sla-age-indicator.test.tsx src/test/sla-resolution.test.ts src/test/sla-breakdown-tooltip.test.tsx'
```
Expected: all pass.

### Step 6.2 — Full typecheck

```bash
npm run typecheck
```
Run from inside the worktree. Expected: clean.

### Step 6.3 — Branch state

```bash
git -C /c/tmp/accu-mk1-wave1 log --oneline origin/master..HEAD | head -8
```
Expected: 5 new commits (Task 1-5) on top of the spec + plan commits.

### Step 6.4 — Manual smoke on :3101 (hand back to user)

Hard-refresh `http://localhost:3101` (Ctrl+Shift+R):
- [ ] **OrderExplorer** (`#accumark-tools/order-explorer`): the table's last data column is now "SLA" (was "Processing Time"), showing red/amber/green dots for in-flight orders, `met ✓` for completed; hover → breakdown tooltip. Pagination still works; switching pages re-resolves SLA (mostly warm).
- [ ] **OrderDashboard** (landing dashboard): the "Outstanding Orders" card's last column is "SLA" (was orange "Age"); shows SLA per outstanding/failed order.
- [ ] **OrderStatusPage** (`#accumark-tools/order-status`): SLA column visually unchanged from before; analysis-state filters + attention count still work (retrofit is invisible).
- [ ] **Customer detail** (`#accumark-tools/customer-detail?id=<n>`): orders still show SLA in their rows (retrofit invisible).
- [ ] No console errors; no lookup burst beyond the displayed page/cap; no double-fetch when navigating between these pages (shared cache).

### Step 6.5 — Report

- Summarize the 5 new commits.
- Note the completed-orders tradeoff (Explorer completed rows show `met ✓`, not a raw duration — Created/Completed columns bracket the span).
- Offer `superpowers:finishing-a-development-branch` once the user is satisfied with live behavior.

If any smoke check fails, capture the surface + observation (screenshot via `playwright-cli` for UI issues) and fix before declaring done.

---

## Self-Review Notes

**Spec coverage:**
- `useSenaiteLookupMap` extraction → Task 1.
- OrderExplorer SLA (replace Processing Time) → Task 2.
- OrderDashboard SLA (replace Age) → Task 3.
- OrderStatusPage retrofit → Task 4. CustomerStatusPage retrofit → Task 5.
- Shared cache reuse → inherent (Task 1 uses the same `['senaite','lookup',id]` key the inline chains used).
- Completed-orders tradeoff → documented in spec; surfaced again in Task 6.5 report.
- No backend / i18n changes → confirmed; headers are hardcoded strings swapped in Tasks 2.3/3.4.

**Placeholder scan:** No TBDs. The `OrderSlaCell` `verdict`-prop nuance (Task 2.3) is a real read-then-decide step with a concrete safe fallback (`?? { color: 'awaiting' }`), not deferred work.

**Type consistency:** `useSenaiteLookupMap` returns `{ sampleLookupMap, sampleIds, isLoading, isError }` (Task 1) — consumed as `{ sampleLookupMap, isLoading: ..., isError: ... }` in Tasks 2/3 and `{ sampleLookupMap }` in Tasks 4/5. `SenaiteLookupEntry` shape (`{data?, isLoading, isError}`) matches what `useOrderSlaStatuses` expects for its `sampleLookupMap` param (verified against its signature: `Map<string, { data?: SenaiteLookupResult; isLoading: boolean; isError: boolean }>`). `verdictByOrderId.get(order.order_id)` keyed by `order_id: string` — matches `OrderSlaResult.verdictByOrderId: Map<string|number, OrderSlaVerdict>`.

**Known pre-existing baseline (not in scope):** `OrderStatusPage.tsx:77` `consistent-type-definitions` ESLint error pre-dates this work — do not fix.
