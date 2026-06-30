# Receive Sample — Order-List Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is executed by **devbox `claude -p` workers** in `~/worktrees/Accu-Mk1-boxing` on branch `feat/order-first-checkin-boxing`; the worker reads the codebase for exact signatures where this plan points to a "mirror" source.

**Goal:** Rework the Receive Sample page's order flow — remove the dead step sidebar, make By-Order items mirror the Order Status table (Created, linked email, expected vials, SLA), add Process + multi-order combine, and a capacity-driven boxing stage.

**Architecture:** Additive on top of the existing order-first feature. The By-Order list joins SENAITE due-samples to their `ExplorerOrder` for display data. `OrderReceiveSession` generalizes to `orders: OrderGroup[]` (length-1 = today). Boxing gains a right vial panel + per-box capacity/auto-assign with idempotent auto-create. One new backend endpoint (`DELETE /api/boxes/{id}`, empty-only).

**Tech Stack:** React 19, TypeScript, TanStack Query, shadcn/ui, Tailwind v4, @dnd-kit (boxing), Vitest (frontend), FastAPI + pytest (backend). Spec: `docs/superpowers/specs/2026-06-30-receive-sample-order-list-rework-design.md`.

## Global Constraints

- **npm only** (never pnpm). Frontend: `npx tsc --noEmit`, `npx vitest run`.
- **Additive only.** No change to the existing single-order receive/boxing behavior. A failing existing test defaults to "stale test" — do not change production behavior to satisfy a test without flagging.
- **Path-limit every commit** (`git commit -- <files>`); never `git add -A`/`git add .`. **Never stage `vite.config.ts` or `package-lock.json`** (keep unstaged).
- **LIMS tables use the `lims_` prefix.** Boxes live in `lims_boxes`.
- Backend box tests need pytest installed into the running container first: `docker exec accumark-boxing-accu-mk1-backend sh -lc "cd /app && pip install -q pytest"`.
- Zustand: selector syntax only (`useStore(s => s.x)`), never destructure the store.
- Verification stack (already mounted): backend container `accumark-boxing-accu-mk1-backend`, frontend `accumark-boxing-accu-mk1-frontend`.

---

## File map

| File | Responsibility | Phase |
|---|---|---|
| `src/components/intake/ReceiveSample.tsx` | Page shell: full-width Samples view; By-order table wiring; selection + Process; ExplorerOrder fetch + SLA hook | 1, 2 |
| `src/lib/inbox-orders.ts` | Grouping + `ExplorerOrder` join (`EnrichedOrderGroup`, `enrichOrderGroups`) | 1 |
| `src/components/intake/OrderListRow.tsx` (new) | One order's 2-row table item (checkbox, order#, linked email, Created, SLA, Process; row 2 chips + expected vials) | 1, 2 |
| `src/components/intake/OrderExpectedVials.tsx` (new) | Per-order lazy expected-vials cell (`getOrderBoxLabelSummary` sum) | 1 |
| `src/components/intake/OrderReceiveSession.tsx` | `orders: OrderGroup[]`; per-order rail separators; per-order boxing sections; header | 2 |
| `src/components/intake/ReceiveWizard/BoxStep.tsx` | Two-pane + right vial panel; capacity + Auto-assign; idempotent auto-create; remove empty box | 3 |
| `src/lib/api.ts` | `deleteBox(boxId)` client fn | 3 |
| backend boxes route + service (find: `grep -rn "boxes" app/` ) | `DELETE /api/boxes/{id}` (empty-only) | 3 |

---

# PHASE 1 — Cleanup + enriched By-Order list (Parts A + B)

Delivers: a single full-width Samples view; By-Order mode is a 2-row table mirroring Order Status (Created, linked email, expected vials, SLA) with a per-row **Process** button that opens the existing single-order `OrderReceiveSession`. No checkboxes/combine yet (Phase 2).

### Task 1.1: Remove the legacy step sidebar + Step-2 flow

**Files:**
- Modify: `src/components/intake/ReceiveSample.tsx`

**Interfaces:**
- Produces: a `ReceiveSample` that renders only the Samples view (heading, `Show Test Samples`, `By order`/`By sample` toggle, the list) + the existing `ReceiveWizard` modal (By sample) and `OrderReceiveSession` mount (By order). No `currentStep`, no footer.

- [ ] **Step 1:** Read `ReceiveSample.tsx` fully. Identify everything used ONLY by Step 2: `INTAKE_STEPS`, `IntakeStep`, `currentStep`, `completedSteps`, `selectedSample`, `lookup*`, `receive*`, `remarks`, `capturedPhotoUrl`, `pendingLookupId`, handlers `handleNext`/`handleBack`/`handleLookup`/`handleReceiveSample`/`handleCheckInAnother`, the `popstate` effect, and Step-2-only imports (`PhotoCapture`, `lookupSenaiteSample`, `receiveSenaiteSample`, step-only icons, `Card`/`CardHeader` if unused after).
- [ ] **Step 2:** Delete the left step `<nav>` sidebar `<div>`, the Step-2 JSX block (lookup card → COA → PhotoCapture → Check-In card), and the navigation footer. Keep the wrapper as a single full-width column: `<div className="flex h-full flex-col">` → ScrollArea → the Step-1 Samples content → the `ReceiveWizard` modal + `OrderReceiveSession` mount. Remove now-orphaned state/handlers/imports.
- [ ] **Step 3:** Run `docker exec accumark-boxing-accu-mk1-frontend sh -lc "cd /app && npx tsc --noEmit"` → expect 0 errors (no unused-var/import errors).
- [ ] **Step 4:** Run `docker exec accumark-boxing-accu-mk1-frontend sh -lc "cd /app && npx vitest run src/components/intake"` (and any ReceiveSample test). If a test referenced the removed Step-2 flow, it is stale — update it to the new single-view structure (do not re-add Step 2). Expect pass.
- [ ] **Step 5:** Commit: `git commit -- src/components/intake/ReceiveSample.tsx -m "refactor(receive): remove dead step sidebar + legacy Step-2 receive flow"`

### Task 1.2: ExplorerOrder join in inbox-orders

**Files:**
- Modify: `src/lib/inbox-orders.ts`
- Test: `src/lib/__tests__/inbox-orders.test.ts` (create if absent; check `src/test/` too — match the repo's existing test location convention)

**Interfaces:**
- Consumes: `OrderGroup` (existing), `ExplorerOrder` (from `@/lib/api`).
- Produces:
  ```ts
  export interface EnrichedOrderGroup extends OrderGroup {
    order: ExplorerOrder | null
  }
  export function enrichOrderGroups(
    groups: OrderGroup[],
    orders: ExplorerOrder[]
  ): EnrichedOrderGroup[]
  ```
  Match by `group.orderKey === order.order_number`. `orderKey === null` (No order) or no match → `order: null`.

- [ ] **Step 1: Write failing tests.**
  ```ts
  import { describe, it, expect } from 'vitest'
  import { enrichOrderGroups, type EnrichedOrderGroup } from '@/lib/inbox-orders'
  const grp = (orderKey: string | null) => ({
    orderKey, orderLabel: orderKey ?? 'No order', clientId: 'acme', samples: [],
  })
  const ord = (order_number: string, customer_id: number | null = 7) =>
    ({ order_number, customer_id, created_at: '2026-06-24T00:00:00Z' } as any)
  describe('enrichOrderGroups', () => {
    it('matches a group to its ExplorerOrder by order_number', () => {
      const [r] = enrichOrderGroups([grp('WP-1042')], [ord('WP-1042')])
      expect(r.order?.order_number).toBe('WP-1042')
    })
    it('leaves order null when no ExplorerOrder matches', () => {
      const [r] = enrichOrderGroups([grp('WP-9999')], [ord('WP-1042')])
      expect(r.order).toBeNull()
    })
    it('leaves order null for the No-order group', () => {
      const [r] = enrichOrderGroups([grp(null)], [ord('WP-1042')])
      expect(r.order).toBeNull()
    })
  })
  ```
- [ ] **Step 2:** Run `... npx vitest run src/lib/__tests__/inbox-orders.test.ts` → FAIL (`enrichOrderGroups` not exported).
- [ ] **Step 3: Implement.**
  ```ts
  export interface EnrichedOrderGroup extends OrderGroup {
    order: ExplorerOrder | null
  }
  export function enrichOrderGroups(
    groups: OrderGroup[],
    orders: ExplorerOrder[],
  ): EnrichedOrderGroup[] {
    const byNumber = new Map(orders.map(o => [o.order_number, o]))
    return groups.map(g => ({
      ...g,
      order: g.orderKey ? (byNumber.get(g.orderKey) ?? null) : null,
    }))
  }
  ```
  Add `import type { ExplorerOrder } from '@/lib/api'` at top.
- [ ] **Step 4:** Run the test → PASS. Run `... npx tsc --noEmit` → 0 errors.
- [ ] **Step 5:** Commit: `git commit -- src/lib/inbox-orders.ts src/lib/__tests__/inbox-orders.test.ts -m "feat(receive): join order groups to ExplorerOrder (EnrichedOrderGroup)"`

### Task 1.3: OrderExpectedVials cell + email deep-link helper

**Files:**
- Create: `src/components/intake/OrderExpectedVials.tsx`
- Test: `src/components/intake/__tests__/OrderExpectedVials.test.tsx` (or repo convention)

**Interfaces:**
- Consumes: `getOrderBoxLabelSummary(orderNumber)` from `@/lib/api` → `{ counts: { hplc, endo, ster } }`.
- Produces:
  ```ts
  export function OrderExpectedVials({ orderNumber }: { orderNumber: string | null }): JSX.Element
  // renders the integer sum hplc+endo+ster, '—' while loading or when orderNumber is null
  export function customerDetailHash(customerId: number | null): string
  // `#accumark-tools/customer-detail?id={id}` when id != null, else `#accumark-tools/customers`
  ```
  Put `customerDetailHash` in `src/lib/inbox-orders.ts` (pure, easy to unit test) and re-export, OR colocate; choose inbox-orders.ts for testability.

- [ ] **Step 1: Write failing test for `customerDetailHash`** (in `inbox-orders.test.ts`):
  ```ts
  it('builds a customer deep-link hash when customer_id is set', () => {
    expect(customerDetailHash(7)).toBe('#accumark-tools/customer-detail?id=7')
  })
  it('falls back to the customers list when customer_id is null', () => {
    expect(customerDetailHash(null)).toBe('#accumark-tools/customers')
  })
  ```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** `customerDetailHash` in `inbox-orders.ts`:
  ```ts
  export function customerDetailHash(customerId: number | null): string {
    return customerId != null
      ? `#accumark-tools/customer-detail?id=${encodeURIComponent(String(customerId))}`
      : '#accumark-tools/customers'
  }
  ```
  Confirm the route shape against `src/lib/hash-navigation.ts` (subSection `customer-detail`, `?id=`). If it differs, match the file.
- [ ] **Step 4:** Implement `OrderExpectedVials.tsx` (mirror the existing `VialCount` in `ReceiveSample.tsx` for the lazy-query pattern):
  ```tsx
  import { useQuery } from '@tanstack/react-query'
  import { getOrderBoxLabelSummary } from '@/lib/api'
  export function OrderExpectedVials({ orderNumber }: { orderNumber: string | null }) {
    const { data, isLoading } = useQuery({
      queryKey: ['order-expected-vials', orderNumber],
      queryFn: () => getOrderBoxLabelSummary(orderNumber as string),
      enabled: !!orderNumber,
      staleTime: 60_000,
    })
    if (!orderNumber || isLoading) return <span className="text-muted-foreground">—</span>
    const c = data?.counts
    const total = c ? c.hplc + c.endo + c.ster : 0
    return <span>{total} expected vial{total !== 1 ? 's' : ''}</span>
  }
  ```
- [ ] **Step 5:** Run tests + `tsc` → PASS / 0 errors. Commit: `git commit -- src/lib/inbox-orders.ts src/lib/__tests__/inbox-orders.test.ts src/components/intake/OrderExpectedVials.tsx -m "feat(receive): expected-vials cell + customer deep-link helper"`

### Task 1.4: OrderListRow (2-row item, mirror OrderRow) + wire By-Order table + SLA

**Files:**
- Create: `src/components/intake/OrderListRow.tsx`
- Modify: `src/components/intake/ReceiveSample.tsx`
- Test: `src/components/intake/__tests__/OrderListRow.test.tsx`

**Interfaces:**
- `OrderListRow` props:
  ```ts
  interface OrderListRowProps {
    group: EnrichedOrderGroup
    slaVerdict?: OrderSlaVerdict      // from useOrderSlaStatuses; undefined → OrderSlaCell isLoading
    onProcess: (group: EnrichedOrderGroup) => void
  }
  ```
- Reads: `getOrderEmail(order)` (`@/components/explorer/helpers`), `customerDetailHash`, `OrderExpectedVials`, `<OrderSlaCell>` (`@/components/explorer/OrderSlaCell`), `formatDate` (lift the existing helper from ReceiveSample or import).
- Worker MUST read `src/components/explorer/OrderRow.tsx` for the exact 2-row markup + left-border-by-state pattern, `src/components/OrderStatusPage.tsx` for the `useOrderSlaStatuses` call + how a per-order `OrderSlaVerdict` is selected, and `src/services/order-sla.ts` for the hook signature. Mirror them.

- [ ] **Step 1: Write failing test** for OrderListRow:
  ```tsx
  // Renders a linked email when customer_id is set; plain text when null.
  // Use @testing-library/react; render inside a <table><tbody> wrapper.
  // group with order = { order_number:'WP-1042', customer_id:7, payload:{billing:{email:'a@b.com'}}, created_at:'2026-06-24T00:00:00Z' }
  // expect an <a href="#accumark-tools/customer-detail?id=7"> containing 'a@b.com'
  // group with order.customer_id = null → email present but NOT a link (no <a>)
  ```
  (Mock `getOrderBoxLabelSummary` and the SLA cell as needed; keep the test focused on the email-link branch + Created text.)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement OrderListRow.tsx** — a primary `<tr>` (checkbox cell placeholder for Phase 2 — omit for now) + a secondary spanning `<tr>`:
  - Primary `<tr>` cells: Order # (mono); client + email (email wrapped in `<a href={customerDetailHash(order.customer_id)}>` only when `getOrderEmail(order)` is non-null AND `order.customer_id != null`; else plain text / '—'); Created via `formatDate(order?.created_at)`; `<OrderSlaCell verdict={slaVerdict ?? { color: 'awaiting' }} isLoading={!slaVerdict} />`; a `<Button onClick={() => onProcess(group)}>Process</Button>`.
  - Secondary `<tr>`: `<td colSpan=…>` with `samples.length` samples · `<OrderExpectedVials orderNumber={group.orderKey} />` · sample-type/analyte chips.
  - Left border tinted by worst sample state — mirror OrderRow's helper if cheap; else a neutral border for now (note as a follow-up).
- [ ] **Step 4: Wire ReceiveSample By-Order mode.**
  - Add `getExplorerOrders` import; add a query: `useQuery({ queryKey:['explorer','orders','receive'], queryFn:()=>getExplorerOrders(undefined,200,0), staleTime:30_000 })`. (Confirm return type — array vs `{items}` — against `OrderStatusPage.tsx`.)
  - `const enriched = enrichOrderGroups(orderGroups, explorerOrders ?? [])`.
  - Page-level SLA: call `useOrderSlaStatuses(...)` exactly as OrderStatusPage does, over the due samples; build a lookup from order_number → verdict.
  - Replace the current `receiveMode === 'order'` button list with a `<Table>`: header (Order # · Client / Email · Created · SLA · ` ` for Process; second-row content is unlabeled), body maps `enriched` → `<OrderListRow group … slaVerdict={verdictFor(g)} onProcess={setSelectedOrder /* single-order, opens existing OrderReceiveSession */} />`.
  - `onProcess(group)` sets `selectedOrder` to that group (Phase-1 single-order; `OrderReceiveSession` still takes `order` until Phase 2).
- [ ] **Step 5:** `tsc` 0 errors; vitest pass. Commit: `git commit -- src/components/intake/OrderListRow.tsx src/components/intake/__tests__/OrderListRow.test.tsx src/components/intake/ReceiveSample.tsx -m "feat(receive): By-Order table mirrors Order Status (email, Created, expected vials, SLA)"`
- [ ] **Step 6: Phase-1 e2e check (manual/HMR):** By-Order list shows the table; an order with a customer shows a linked email; Created shows; SLA badge renders; Process opens the single-order session. Report to orchestrator for UAT.

---

# PHASE 2 — Process selection + multi-order combine (Part C)

Delivers: checkboxes + selection bar + combine; `OrderReceiveSession` takes `orders: OrderGroup[]` with per-order rail separators + per-order boxing sections.

### Task 2.1: Generalize OrderReceiveSession to orders[]

**Files:**
- Modify: `src/components/intake/OrderReceiveSession.tsx`
- Modify: `src/components/intake/ReceiveSample.tsx` (update the mount to pass `orders={[selectedOrder]}`)
- Test: `src/components/intake/__tests__/OrderReceiveSession.test.tsx` (rail grouping + boxing sections)

**Interfaces:**
- Props: `{ orders: OrderGroup[]; onClose: () => void }`. Length 1 reproduces today's behavior.
- Produces internally: a flattened `samples` walk (`orders.flatMap(o => o.samples)`); rail rendered per order with a `─ {orderLabel} ─` separator before each order's rows; boxing stage = `orders.map(o => <BoxStep orderKey={o.orderKey ?? firstSampleId} … sampleIds={o.samples.map(s=>s.id)} />)` stacked with the same separators; header: 1 order → `Receive {orderLabel}`, N → `Receive {N} orders`.

- [ ] **Step 1: Write failing test** — render with two orders; assert both order labels appear as rail separators and all samples render; navigate to boxing (set index past the union length) and assert two BoxStep sections (mock BoxStep to a sentinel that echoes its `orderKey`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Change `order: OrderGroup` → `orders: OrderGroup[]`. Compute `const samples = orders.flatMap(o => o.samples)`; `total = samples.length`; keep `index`/`onBoxing` logic over the flattened list. Rail: iterate `orders`, for each render a separator row then its `SampleRailRow`s (compute the global index offset so `active`/`setIndex` still line up). Boxing main area: when `onBoxing`, render the stacked per-order `BoxStep` sections (each in its own separator-headed block). Header label per the rule. Keep `useParentSampleDetails` on the active sample (now indexed into the flattened list).
- [ ] **Step 4:** Update ReceiveSample mount: `<OrderReceiveSession orders={[selectedOrder]} … />`. `tsc` 0 errors; vitest pass.
- [ ] **Step 5:** Commit: `git commit -- src/components/intake/OrderReceiveSession.tsx src/components/intake/ReceiveSample.tsx src/components/intake/__tests__/OrderReceiveSession.test.tsx -m "feat(receive): OrderReceiveSession accepts orders[] (per-order rail + boxing sections)"`

### Task 2.2: Checkbox selection + selection bar + combine

**Files:**
- Modify: `src/components/intake/OrderListRow.tsx` (add checkbox cell)
- Modify: `src/components/intake/ReceiveSample.tsx` (selection state, bar, Process semantics)
- Test: extend `ReceiveSample`/`OrderListRow` tests for selection behavior.

**Interfaces:**
- `OrderListRow` props gain: `selected: boolean; onToggle: (orderKey: string) => void`. Render a leading `<Checkbox checked={selected} onCheckedChange=…>` cell (skip toggle for the No-order group whose orderKey is null, or key it by a sentinel — choose: only selectable when `orderKey` is non-null).
- `ReceiveSample`: `const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())`. Selection bar appears when `selectedKeys.size >= 1`: `{size} orders selected · [Process together] · [Clear]`.
- Process semantics: `onProcess(group)` → if `group.orderKey` is in a `selectedKeys` set of size ≥2 → open combined (`setSelectedOrders(enriched.filter(g => selectedKeys.has(g.orderKey!)))`); else open single (`setSelectedOrders([group])`). "Process together" opens the combined set. Replace `selectedOrder: OrderGroup|null` with `selectedOrders: OrderGroup[]|null` and pass to `OrderReceiveSession orders={selectedOrders}`.

- [ ] **Step 1: Write failing tests** — (a) checking 2 rows then clicking one row's Process opens a session containing both orders' samples; (b) clicking Process on an unchecked row opens just that order; (c) selection bar shows the count and Clear empties it.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** the checkbox cell, `selectedKeys` state, the sticky selection bar, and the single-vs-combined Process logic; swap the mount to `selectedOrders`.
- [ ] **Step 4:** `tsc` 0 errors; vitest pass.
- [ ] **Step 5:** Commit: `git commit -- src/components/intake/OrderListRow.tsx src/components/intake/ReceiveSample.tsx <test files> -m "feat(receive): order checkboxes + combine multiple orders into one session"`
- [ ] **Step 6: Phase-2 e2e check:** combine two orders, confirm rail shows both with separators and boxing shows two sections. Report for UAT.

---

# PHASE 3 — Capacity-driven boxing (Part C boxing)

Delivers: right unboxed-vial panel, per-box Capacity + Auto-assign, idempotent auto-create (first + trailing), removable empty boxes, `DELETE /api/boxes/{id}`.

### Task 3.1: Backend DELETE /api/boxes/{id} (empty-only)

**Files:**
- Modify: backend boxes route + service (find via `grep -rn "lims_boxes\|/boxes\|def create_box\|assign_vials" app/`). Add the delete endpoint + service fn alongside the existing list/create/assign/print.
- Test: the existing boxes test module (`grep -rn "boxes" tests/` — e.g. `tests/test_boxes_routes.py`, `tests/test_boxes_service.py`).

**Interfaces:**
- `DELETE /api/boxes/{box_id}` → 204 on success; **404** if the box does not exist; **409** (or 400) if the box has ≥1 assigned vial (`lims_sub_samples.box_id == box_id`). Service: `delete_box(db, box_id)` raises a typed error when non-empty.

- [ ] **Step 1: Write failing tests** (mirror the style in the existing boxes test files):
  - `test_delete_empty_box_removes_it`: create a box (no vials) → DELETE → 204 → it's gone from `list_order_boxes`.
  - `test_delete_box_with_vials_is_rejected`: create box, assign a vial → DELETE → 409 → box still present.
  - `test_delete_missing_box_404`.
- [ ] **Step 2:** Install pytest + run: `docker exec accumark-boxing-accu-mk1-backend sh -lc "cd /app && pip install -q pytest && python -m pytest tests/test_boxes_routes.py tests/test_boxes_service.py -q"` → FAIL.
- [ ] **Step 3: Implement** `delete_box` service (guard: count sub-samples with that `box_id`; raise if > 0) + the route (`@router.delete('/boxes/{box_id}', status_code=204)`), mapping the guard error to 409 and missing to 404. Mirror the existing create/assign handlers for session + error patterns.
- [ ] **Step 4:** Run the tests → PASS.
- [ ] **Step 5:** Commit: `git commit -- <backend route file> <backend service file> <backend test files> -m "feat(boxes): DELETE /api/boxes/{id} for empty boxes (404 missing, 409 non-empty)"`

### Task 3.2: deleteBox API client

**Files:**
- Modify: `src/lib/api.ts`
- Test: covered via BoxStep test in 3.3 (or a tiny direct test if api.ts has a test module).

**Interfaces:**
- Produces: `export async function deleteBox(boxId: number): Promise<void>` — `DELETE ${API_BASE_URL()}/boxes/{boxId}` with `getBearerHeaders()`; throw on non-2xx (mirror the existing `createBox`/`assignVialsToBox` fns nearby).

- [ ] **Step 1:** Implement `deleteBox` mirroring `createBox` (same base URL, headers, error handling).
- [ ] **Step 2:** `tsc` 0 errors.
- [ ] **Step 3:** Commit: `git commit -- src/lib/api.ts -m "feat(api): deleteBox client"`

### Task 3.3: BoxStep — right panel, capacity + Auto-assign, auto-create, remove

**Files:**
- Modify: `src/components/intake/ReceiveWizard/BoxStep.tsx`
- Test: `src/components/intake/ReceiveWizard/__tests__/BoxStep.test.tsx` (create; mock `@/lib/api` box fns)

**Interfaces:**
- No prop changes (`{ orderKey, orderLabel, clientId, sampleIds }`).
- Internal: per-box capacity state `const [capacities, setCapacities] = useState<Record<number, number>>({})`; default a box's capacity to its role's current unboxed count when first rendered. `autoCreatedRef = useRef<Set<string>>(new Set())` keyed `${orderKey}:${role}`.
- Auto-assign(box): pick `take = max(0, capacity - box.vial_count)` of the role's unboxed vials (`vials.filter(v => v.assignment_role === role && !v.box_id)`), call `assignVialsToBox(box.id, takenIds)`, invalidate `['order-boxes', orderKey]` + `['order-vials', orderKey]`.

- [ ] **Step 1: Write failing tests** (mock api): given a parent with N assigned HPLC vials and no boxes, on render exactly **one** `createBox(orderKey,'hplc')` is called (not for empty roles); a re-render/refetch does **not** call `createBox` again (idempotent); after Auto-assign leaves a remainder, a second `createBox(orderKey,'hplc')` fires once; clicking remove on an empty box calls `deleteBox(id)`; Auto-assign calls `assignVialsToBox` with at most `capacity` ids.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - **Layout:** wrap the role columns + a right `Unboxed vials` panel in a two-pane flex inside the existing `DndContext`. The panel lists `vials.filter(v => !v.box_id)` grouped by role as draggable `VialChip`s (reuse existing chip). Keep the in-column drop targets (BoxCard) as the manual override.
  - **Auto-create effect:** `useEffect` gated on `!boxesQ.isLoading && !vialsQ.isLoading`. For each role, compute `assigned = vials.filter(v => v.assignment_role === role && v.assignment_role !== 'xtra')`, `unboxed = assigned.filter(v => !v.box_id)`, `roleBoxes = boxes.filter(b => b.role === role)`. If `unboxed.length > 0 && roleBoxes.length === 0 && !autoCreatedRef.current.has(key)` → add key to ref, `await createBox(orderKey, role)`, invalidate boxes. (The ref guards the in-flight window; once a box exists `roleBoxes.length===0` is false so it won't refire. Clear the ref entry when a box of that role appears, so a later remainder can create the trailing box — OR gate the trailing case on "unboxed>0 and no EMPTY box of that role exists": prefer `const hasEmpty = roleBoxes.some(b => b.vial_count === 0); if (unboxed.length>0 && !hasEmpty) createBox(...)` with the ref guarding double-fire within a render cycle. Use the `hasEmpty` form — it covers both first-box and trailing-box with one rule.)
  - **BoxCard:** add a `Capacity` number input (value from `capacities[box.id] ?? unboxedCountForRole`, onChange updates state) + an `Auto-assign` button (calls the assign logic) + a remove `×` button shown only when `box.vial_count === 0` (calls `deleteBox(box.id)` then invalidate).
- [ ] **Step 4:** `tsc` 0 errors; `... npx vitest run src/components/intake/ReceiveWizard` → PASS.
- [ ] **Step 5:** Commit: `git commit -- src/components/intake/ReceiveWizard/BoxStep.tsx src/components/intake/ReceiveWizard/__tests__/BoxStep.test.tsx -m "feat(boxing): right vial panel + capacity Auto-assign + idempotent auto-create + remove empty box"`
- [ ] **Step 6: Phase-3 e2e check:** enter boxing → first box per active role waits → set capacity → Auto-assign fills → remainder spawns the next box → remove an empty box. Report for UAT.

---

## Self-review (filled by plan author)

- **Spec coverage:** A (1.1) · B join (1.2) · expected vials + email link (1.3) · 2-row table + SLA (1.4) · orders[] combine (2.1, 2.2) · boxing right panel + capacity/auto-assign + auto-create + remove (3.3) · DELETE endpoint (3.1) · deleteBox client (3.2). ISO/Decisions are properties of the above tasks. No spec requirement is unmapped.
- **Type consistency:** `EnrichedOrderGroup`/`enrichOrderGroups` (1.2) consumed in 1.4/2.2; `customerDetailHash` (1.3) used in 1.4; `OrderExpectedVials` (1.3) used in 1.4; `orders: OrderGroup[]` (2.1) consumed by 2.2 mount; `deleteBox` (3.2) consumed by 3.3.
- **Open reads for the worker (not placeholders — exact-signature lookups):** `useOrderSlaStatuses` signature + per-order verdict selection (mirror `OrderStatusPage.tsx` + `src/services/order-sla.ts`); `OrderRow.tsx` 2-row markup + left-border-by-state; `hash-navigation.ts` customer-detail route shape; `getExplorerOrders` return type; backend boxes route/service/test paths.
- **Verification per phase:** Phase 1 frontend tsc+vitest; Phase 2 tsc+vitest; Phase 3 backend pytest (pytest installed into container first) + frontend tsc+vitest.
