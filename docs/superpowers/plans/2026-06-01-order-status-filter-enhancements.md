# Order Status Page Filter Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-select stage filters and an "SLA at-risk" (amber+red) toggle to the Order Status page.

**Architecture:** Two pure, unit-tested helpers (`toggleFilterKey`, `isOrderAtRisk`) hold the logic. `toggleState` switches from single-select to add/remove via `toggleFilterKey`. A new `slaAtRisk` filter flag drives a `displayedOrders` narrowing layer (computed after the existing `orderSla` verdicts) that the render consumers point at. A warning-styled toggle button sits right of "All Orders".

**Tech Stack:** React 19 + TypeScript, Vitest, Tailwind, TanStack Query, Zustand. Web-only; no backend changes.

**Branch:** `feat/order-status-filters` (already created off master).

---

## Testing approach note

The spec mentioned a component test "following the customer-status-page.test.tsx pattern." During planning we found **no OrderStatusPage test harness exists**, and a full one would require mocking `@/lib/api`, `@/lib/api-profiles`, `@/services/senaite-lookup-map`, `@/services/order-sla`, `@/store/ui-store`, and `OrderRow` — disproportionate to this thin glue. Per the project's "tests where they reduce risk, skip performative tests" rule (AGENTS.md), the **logic** is fully covered by pure-helper unit tests (Task 1), and the **integration** (one-line `toggleState`, a `displayedOrders` filter, a button) is verified by typecheck + scoped eslint + manual smoke on `:3101`. This is a deliberate refinement of the spec's testing line — confirm acceptable before execution.

---

## File Structure

- **Create** `src/components/explorer/order-filters.ts` — two pure filter helpers. One responsibility: filter-key + SLA-verdict predicates, no React.
- **Create** `src/test/order-filters.test.ts` — unit tests for the helpers.
- **Modify** `src/components/OrderStatusPage.tsx` — wire helpers, add `slaAtRisk` state, `displayedOrders`, the toggle button, repoint render consumers.

---

## Task 1: Pure filter helpers + unit tests (TDD)

**Files:**
- Create: `src/components/explorer/order-filters.ts`
- Test: `src/test/order-filters.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/test/order-filters.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { toggleFilterKey, isOrderAtRisk } from '@/components/explorer/order-filters'
import type { OrderSlaVerdict } from '@/lib/sla-resolution'

describe('toggleFilterKey', () => {
  it('appends a key when absent', () => {
    expect(toggleFilterKey([], 'received')).toEqual(['received'])
    expect(toggleFilterKey(['pending'], 'received')).toEqual(['pending', 'received'])
  })
  it('removes a key when present', () => {
    expect(toggleFilterKey(['received'], 'received')).toEqual([])
    expect(toggleFilterKey(['pending', 'received'], 'pending')).toEqual(['received'])
  })
  it('does not mutate the input array', () => {
    const input = ['pending']
    toggleFilterKey(input, 'received')
    expect(input).toEqual(['pending'])
  })
})

describe('isOrderAtRisk', () => {
  const v = (color: OrderSlaVerdict['color']): OrderSlaVerdict => ({ color })
  it('is true for red and amber (approaching or overdue)', () => {
    expect(isOrderAtRisk(v('red'))).toBe(true)
    expect(isOrderAtRisk(v('amber'))).toBe(true)
  })
  it('is false for green/met/awaiting/loading/error', () => {
    for (const c of ['green', 'met', 'awaiting', 'loading', 'error'] as const) {
      expect(isOrderAtRisk(v(c))).toBe(false)
    }
  })
  it('is false for undefined (no verdict yet)', () => {
    expect(isOrderAtRisk(undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/order-filters.test.ts'`
Expected: FAIL — cannot resolve `@/components/explorer/order-filters` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/components/explorer/order-filters.ts`:

```ts
import type { OrderSlaVerdict } from '@/lib/sla-resolution'

/** Toggle a key in a filter-key array: remove it if present, append it if
 *  absent. Pure — never mutates the input. Drives multi-select stage filters. */
export function toggleFilterKey(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]
}

/** An order is "at risk" when its SLA verdict is approaching the target (amber)
 *  or overdue (red). green / met / awaiting / loading / error / no-verdict are
 *  not at risk. Drives the "SLA at-risk" filter toggle. */
export function isOrderAtRisk(verdict: OrderSlaVerdict | undefined): boolean {
  return verdict?.color === 'red' || verdict?.color === 'amber'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/order-filters.test.ts'`
Expected: PASS (8 assertions across 6 it-blocks).

- [ ] **Step 5: Commit**

```bash
git add src/components/explorer/order-filters.ts src/test/order-filters.test.ts
git commit -m "feat(order-status): pure filter helpers (toggleFilterKey, isOrderAtRisk)"
```

---

## Task 2: Multi-select stage filters

**Files:**
- Modify: `src/components/OrderStatusPage.tsx` (import; `toggleState` at lines 551-555)

- [ ] **Step 1: Add the import**

In `src/components/OrderStatusPage.tsx`, add to the import block near the other `@/components/explorer/*` imports (e.g. after the `OrderRow` import, line 54):

```ts
import { toggleFilterKey, isOrderAtRisk } from '@/components/explorer/order-filters'
```

(`isOrderAtRisk` is used in Task 3; importing both now keeps one import line.)

- [ ] **Step 2: Rewrite `toggleState` to add/remove**

Replace the current single-select handler (lines 551-555):

```ts
  const toggleState = (key: string) => {
    updateFilters({
      activeStates: orderFilters.activeStates[0] === key ? [] : [key],
    })
  }
```

with:

```ts
  const toggleState = (key: string) => {
    updateFilters({
      activeStates: toggleFilterKey(orderFilters.activeStates, key),
    })
  }
```

No other change — the stage buttons already render multi-active state (`active = orderFilters.activeStates.includes(btn.key)`, line 954) and `sampleMatchesAnalysisFilter` already ORs across the array (`helpers.tsx:192`). The "Active" button (clears `activeStates`) is the clear-all.

- [ ] **Step 3: Typecheck**

Run: `cd /c/tmp/accu-mk1-wave1 && npm run typecheck`
Expected: clean (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/components/OrderStatusPage.tsx
git commit -m "feat(order-status): multi-select stage filters via toggleFilterKey"
```

---

## Task 3: "SLA at-risk" toggle (amber + red)

**Files:**
- Modify: `src/components/OrderStatusPage.tsx` (`OrderFilters` interface ~494; `loadOrderFilters` default ~514; after `orderSla` ~650; button after line 816; render consumers at 1028, 1048, 1054, 1069, 1085, 1088)

- [ ] **Step 1: Add `slaAtRisk` to the `OrderFilters` interface**

In the `OrderFilters` interface (lines 494-505), add the field after `hideTestOrders: boolean`:

```ts
  hideTestOrders: boolean
  slaAtRisk: boolean
```

- [ ] **Step 2: Add the default**

In `loadOrderFilters`'s returned default object (lines 514-525), add after `hideTestOrders: true,`:

```ts
    hideTestOrders: true,
    slaAtRisk: false,
```

- [ ] **Step 3: Add `displayedOrders` + `atRiskCount` after `orderSla`**

Immediately after the `orderSla` line (line 650, `const orderSla = useOrderSlaStatuses(filteredOrders, sampleLookupMap)`), add:

```ts
  // Count of at-risk orders in the current filtered set — drives the toggle's
  // badge regardless of whether the toggle is on.
  const atRiskCount = useMemo(
    () =>
      filteredOrders.filter(o =>
        isOrderAtRisk(orderSla.verdictByOrderId.get(o.order_id))
      ).length,
    [filteredOrders, orderSla.verdictByOrderId]
  )

  // When the SLA toggle is on, narrow to orders approaching/over their target.
  // Computed AFTER orderSla (which runs on the full filteredOrders), so verdicts
  // for the narrowed subset are always present. Loading-SLA orders are excluded
  // while the toggle is on (only known-at-risk shown).
  const displayedOrders = useMemo(
    () =>
      orderFilters.slaAtRisk
        ? filteredOrders.filter(o =>
            isOrderAtRisk(orderSla.verdictByOrderId.get(o.order_id))
          )
        : filteredOrders,
    [filteredOrders, orderFilters.slaAtRisk, orderSla.verdictByOrderId]
  )
```

- [ ] **Step 4: Add the toggle button right of "All Orders"**

Insert between the "All Orders" `</Button>` (line 816) and the "Hide test orders" `<label>` (line 818):

```tsx
            </Button>

            <Button
              variant={orderFilters.slaAtRisk ? 'default' : 'outline'}
              size="sm"
              onClick={() => updateFilters({ slaAtRisk: !orderFilters.slaAtRisk })}
              title="Show only orders approaching or past their SLA target"
              className={cn(
                orderFilters.slaAtRisk &&
                  'bg-amber-500 text-white border-amber-500 hover:bg-amber-600'
              )}
            >
              ⚠ SLA at-risk
              {!ordersLoading && atRiskCount > 0 && (
                <Badge variant="secondary" className="ml-1.5">
                  {atRiskCount}
                </Badge>
              )}
            </Button>

            <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap cursor-pointer ml-1">
```

(`Button`, `Badge`, and `cn` are already imported and used in this file.)

- [ ] **Step 5: Repoint render consumers from `filteredOrders` to `displayedOrders`**

Make these exact replacements in the render/JSX (leave the `filteredOrders` definition at 622 and `useOrderSlaStatuses(filteredOrders, ...)` at 650 UNCHANGED):

1. Line ~1028 (count):
   `` : `${filteredOrders.length} order${filteredOrders.length !== 1 ? 's' : ''} displayed`} ``
   →
   `` : `${displayedOrders.length} order${displayedOrders.length !== 1 ? 's' : ''} displayed`} ``

2. Line ~1048 (empty-state gate):
   `{filteredOrders.length === 0 && !ordersLoading && (`
   →
   `{displayedOrders.length === 0 && !ordersLoading && (`

3. Line ~1054 (table-view gate):
   `{filteredOrders.length > 0 && orderFilters.viewMode === 'table' && (`
   →
   `{displayedOrders.length > 0 && orderFilters.viewMode === 'table' && (`

4. Line ~1069 (table map):
   `{filteredOrders.map(order => (`
   →
   `{displayedOrders.map(order => (`

5. Line ~1085 (kanban gate):
   `{filteredOrders.length > 0 && orderFilters.viewMode === 'kanban' && (`
   →
   `{displayedOrders.length > 0 && orderFilters.viewMode === 'kanban' && (`

6. Line ~1088 (kanban orders prop):
   `orders={filteredOrders}`
   →
   `orders={displayedOrders}`

- [ ] **Step 6: Typecheck**

Run: `cd /c/tmp/accu-mk1-wave1 && npm run typecheck`
Expected: clean.

- [ ] **Step 7: Scoped lint**

Run: `cd /c/tmp/accu-mk1-wave1 && npx eslint src/components/OrderStatusPage.tsx src/components/explorer/order-filters.ts src/test/order-filters.test.ts`
Expected: clean (no new errors).

- [ ] **Step 8: Commit**

```bash
git add src/components/OrderStatusPage.tsx
git commit -m "feat(order-status): SLA at-risk toggle filters to amber+red orders"
```

---

## Task 4: Verify full suite + manual smoke

- [ ] **Step 1: Run the helper test + the SLA suite (no regressions)**

Run: `docker exec accu-mk1-frontend sh -c 'cd /app && npx vitest run src/test/order-filters.test.ts src/test/order-sla.test.tsx src/test/order-row.test.tsx'`
Expected: all pass.

- [ ] **Step 2: Manual smoke on :3101** (ask the user to verify — No Dev Server rule)

On the Order Status page:
1. Click two stage chips (e.g. "Received" + "Pending") → both highlight; the list shows orders matching either. Click one again → it de-selects, the other stays. "Active" clears all.
2. Click "⚠ SLA at-risk" (right of "All Orders") → list narrows to amber/red orders; badge shows the at-risk count; toggling off restores. Confirm it stacks with a stage filter (AND).
3. Refresh the page → both filter states persist (localStorage).

---

## Self-Review

- **Spec coverage:** multi-select stage filters (Task 2 + Task 1 helper), at-risk toggle amber+red (Task 3 + Task 1 helper), placement right of "All Orders" (Task 3 Step 4), AND-combination + persistence (Task 3 Steps 1-3, displayedOrders + localStorage), loading-excluded (displayedOrders comment). Testing line refined per the note above (flagged for confirmation).
- **Placeholders:** none — all steps have concrete code/commands.
- **Type consistency:** `toggleFilterKey(string[], string): string[]` and `isOrderAtRisk(OrderSlaVerdict | undefined): boolean` used identically in Tasks 1-3; `OrderSlaVerdict.color` values match `OrderSlaColor`.
