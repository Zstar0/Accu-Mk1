# Sub-project D2 — Order-list SLA column + per-tier amber threshold

- **Date:** 2026-05-27
- **Branch:** `feat/order-status-processing-time`
- **Depends on:** A (tier model — `2026-05-27-sla-tiers-model-and-settings-design.md`), B (business-hours engine — `2026-05-27-sla-business-hours-design.md`). D2 consumes `POST /sla/status` (B) and reads/extends `sla_tiers` (A).
- **Scope:** D2 = (1) a new **SLA column** on every `OrderRow` (table view), (2) replacing the **hardcoded 24/48h goalNote** in `OrderStatusPage`'s card view with the same real-tier SLA logic, (3) a new **per-tier `amber_threshold_percent`** stored on `sla_tiers` and edited in `SlaPane`. **Out of scope:** live ticking timers, sortable/filterable SLA column, server-side SLA history. **Backend endpoints:** D2 primarily consumes existing endpoints (`POST /sla/status` from B; `/sla-tiers` CRUD from A picks up the new column via schemas). The **one possible new endpoint** is a minimal `GET /sample-priorities?sample_uids=…` bulk-read — only if an existing bulk surface isn't already serving that need (resolved during planning; see *Open implementation question*).

## Goal

The Order Status page (and the customer-detail order list) should show, per order, a single RAG verdict against the **real** tier-based SLA (priority > group > default; business-hours-aware via B's engine), starting the clock at the sample's `date_received` (lab check-in). The amber threshold is configurable per tier from the existing SLA settings pane.

## Decisions (locked)

1. **Surface:** a new **"SLA"** column on `OrderRow` (between Timing and Samples), so it appears wherever `OrderRow` is rendered — currently `/explorer` Order Status (table view) and the Customer detail page. The card/Kanban view in `OrderStatusPage` replaces its inline `goalNote` block with a per-sample SLA indicator that uses the same logic.
2. **Granularity:** order-level cell, computed by **aggregating per-sample** statuses → **worst-active sample drives the verdict** (most-over for red; least-percent-remaining for amber). Published samples excluded (clock stopped); not-yet-received samples = no clock.
3. **Tier fidelity:** **full model** — `priority > group-tier > default`. When a sample's analyses span multiple service groups, pick the **tightest** group tier (smallest `target_minutes`).
4. **Clock:** per sample, starts at `lookup.date_received` (lab check-in), matching D1's "Lab" outstanding line. Business-hours arithmetic comes from B's `POST /sla/status` (server-side).
5. **Color thresholds:** `elapsed > target` → **red**; else if `(remaining/target)*100 < tier.amber_threshold_percent` → **amber**; else → **green**. Palette mirrors the existing processing-time field (`text-green-600`, `text-amber-500`, `text-red-500`, `text-muted-foreground`).
6. **Amber threshold is per-tier**, stored as `sla_tiers.amber_threshold_percent INTEGER NOT NULL DEFAULT 20` (range 1–100). Edited inline on each `SlaPane` tier card.
7. **Refetch:** snapshot-on-load. D2 re-runs when the orders query refetches and on the existing "Refresh all data" button. **No live ticking.**
8. **No new backend endpoints.** D2 consumes `POST /sla/status` (B) and the existing tier/service-group/analysis-service/priority endpoints. The amber threshold round-trips through the existing `/sla-tiers` CRUD (already schema-driven).

## Architecture / data flow

Per page render of the order list:

1. **Cache (TanStack Query)** — already-existing or trivially-added hooks:
   - `getSlaTiers()` (A) — includes the new `amber_threshold_percent`.
   - `getSlaPriorityTiers()` (A) — sparse priority overrides.
   - `getServiceGroups()` (A) — each carries `sla_tier_id` and `member_ids: number[]`.
   - `getExplorerAnalysisServices()` (existing) — `id`, `keyword`. (Used to map SENAITE analysis keywords → AccuMark `analysis_services.id`.)
   - **Bulk per-sample priorities** keyed by `sample_uid` — *uses the existing endpoint surface*; one batched call covering all currently-visible orders' sample UIDs. (If a bulk endpoint doesn't yet exist client-side, a thin wrapper around the existing `SamplePriority` lookups counts as "existing surface" — no new server endpoint required. Implementer confirms during planning; if a true bulk fetch endpoint isn't there, this MAY become the only new backend addition. Flag as the one open implementation question.)

2. **Resolve per sample** (received-but-unpublished only):
   - `priority`: `sampleLookupMap.get(senaiteId).data.sample_uid → SamplePriority.priority` (sparse; absent → `'normal'`).
   - `group-tier`: for each `lookup.analyses[]`, map `keyword → analysis_services.id → group whose member_ids contains it → group.sla_tier_id → tier`. If multiple groups → **tightest** by `target_minutes`. If unmapped → `null`.
   - Apply `resolveSlaTier(priorityMap, groupTier, priority, defaultTier)` (TS, from A; sub-project B did not change it).

3. **Batch call** — one `POST /sla/status` request, one item per received-but-unpublished sample:
   ```
   { key: sample_uid,
     received_at: lookup.date_received,           // ISO string, naive UTC
     target_minutes: tier.target_minutes,
     business_hours_only: tier.business_hours_only }
   ```
   Response: `{ items: [{ key, status: { target_minutes, elapsed_minutes, remaining_minutes, breached } | null }] }`. B's loaded-once guarantee already proven (`test_loaded_once_query_count_is_constant_regardless_of_batch_size`).

4. **Color per sample** (client-side, using each sample's resolved tier's `amber_threshold_percent`):
   - `status.breached` → `red`.
   - `(status.remaining_minutes / status.target_minutes) * 100 < tier.amber_threshold_percent` → `amber`.
   - else → `green`.

5. **Aggregate per order**:
   - Start with the set of received-but-unpublished samples in the order.
   - If empty AND every sample is `published` → **`met`**.
   - If empty AND none received → **`awaiting`**.
   - Else: pick the **worst** sample (red over amber over green; within a color, prefer most-over for red, least-percent-remaining for amber). That sample's color, `remaining_minutes`/`elapsed_minutes`, and tier name drive the cell + tooltip.

## Backend changes (small)

### Migration
Append to `database._run_migrations`:
```sql
ALTER TABLE sla_tiers ADD COLUMN IF NOT EXISTS amber_threshold_percent INTEGER NOT NULL DEFAULT 20
```
Idempotent. Existing rows acquire the default `20`. No backfill required.

### Model
In `models.py:SlaTier`, add:
```python
amber_threshold_percent: Mapped[int] = mapped_column(
    Integer, nullable=False, default=20
)
```

### Pydantic schemas
- `SlaTierResponse` — add `amber_threshold_percent: int`.
- `SlaTierCreate` — add `amber_threshold_percent: int = 20`.
- `SlaTierUpdate` — add `amber_threshold_percent: Optional[int] = None`.
- Validation (on create + update): `1 <= amber_threshold_percent <= 100` → `422` otherwise.

No endpoint changes — the existing tier CRUD picks up the field via the schemas.

## Frontend changes

### `SlaPane.tsx` (touch-up of sub-project C)
Each `TierCard` gains a small numeric input alongside the existing target hours/minutes and business-hours toggle:
```
Amber at [__] % remaining
```
Bound to the tier's `amber_threshold_percent`, saved via the existing `useUpdateSlaTier` (same blur-to-save pattern the other fields use). Add an i18n key `preferences.sla.amberThreshold` (e.g. `"Amber at"`) and `preferences.sla.percentRemaining` (e.g. `"% remaining"`) to all three locale files (English in all, matching the existing convention).

### New `src/lib/sla-resolution.ts` (pure, unit-tested)
- `buildServiceToGroupTierMap(groups, analysisServices, tiersById)` → `Map<analysisServiceId, SlaTier>` (the tightest group-tier per service id when a service appears in multiple groups with tiers).
- `resolveSampleTier(lookup, priority, serviceToGroupTier, priorityToTier, defaultTier, tiersById)` → `SlaTier | null`. Maps `lookup.analyses` to group-tiers, picks the tightest, then applies `resolveSlaTier(priorityMap, groupTier, priority, defaultTier)` (the existing TS resolver from A).
- `classifySampleColor(status, tier)` → `'red' | 'amber' | 'green'`.
- `aggregateOrderSlaVerdict(samples)` → `OrderSlaVerdict { color, label, tooltip, drivingSampleId? }` where `color` ∈ `'red'|'amber'|'green'|'met'|'awaiting'`.

### New `src/services/order-sla.ts` (TanStack Query hook)
`useOrderSlaStatuses(orders, sampleLookupMap)`:
- Uses existing tier/group/service hooks (load once, cached).
- Bulk-fetches priorities for all visible `sample_uid`s (one call; see open question in the data-flow Cache step).
- Builds batch items for all received-but-unpublished samples across the given orders → calls `fetchSlaStatuses` (Task 7 of B).
- Returns `{ verdictByOrderId: Map<orderId, OrderSlaVerdict>, sampleStatusBySampleId: Map<senaiteId, { status, color, tier }>, isLoading, isError }`.
- Re-runs when `orders` or `sampleLookupMap` shape changes (TanStack Query dependency).

### New `src/components/explorer/OrderSlaCell.tsx`
A small render-only component taking `{ verdict: OrderSlaVerdict, isLoading?: boolean }`. Outputs the RAG dot + concise text + tooltip per the cell-rendering table below.

### `OrderRow.tsx`
- Add a new `<td>` between the Timing and Samples columns rendering `<OrderSlaCell verdict={...} />`.
- Read the verdict from a new prop `slaVerdict?: OrderSlaVerdict | null` injected by the parent (`OrderStatusPage` / `CustomerStatusPage`), which in turn pulls from `useOrderSlaStatuses`.
- Update the parent table headers in both `OrderStatusPage` and `CustomerStatusPage` to add an "SLA" column header in the matching position.

### `OrderStatusPage.tsx` card view
Replace the inline `goalNote` block (the `if (date_received && review_state !== 'published')` branch at ~lines 277–292) with a small `<SampleSlaIndicator status={sampleStatusBySampleId.get(senaiteId)} />` consuming the per-sample statuses from the same hook. Same RAG color, same tooltip semantics — just real tier-based instead of hardcoded 24/48h.

### i18n keys (en/fr/ar, identical English, matching existing convention)
```
"orderStatus.sla": "SLA",
"orderStatus.sla.left": "{{time}} left",
"orderStatus.sla.over": "over by {{time}}",
"orderStatus.sla.met": "Met",
"orderStatus.sla.awaiting": "Awaiting sample",
"orderStatus.sla.unavailable": "SLA unavailable",
"orderStatus.sla.tooltipFull": "{{tier}} • target {{target}} • {{elapsed}} elapsed{{businessSuffix}} • sample {{sampleId}}",
"orderStatus.sla.businessSuffix": " (business hours)",
"preferences.sla.amberThreshold": "Amber at",
"preferences.sla.percentRemaining": "% remaining",
```

## Cell rendering (mirrors processing-time palette)

| State | Cell content | Color class | Tooltip |
|---|---|---|---|
| Red (breached) | `● over by 12h` | `text-red-500` | `Standard • target 48h • 60h elapsed (business hours) • sample PB-0056` |
| Amber (at-risk) | `● 3h left` | `text-amber-500` | same + below-threshold note |
| Green (healthy) | `● 18h left` | `text-green-600` | same |
| Met (all published) | `✓` | `text-muted-foreground` | `All samples published` |
| Awaiting (no received) | `—` | `text-muted-foreground` | `Awaiting sample` |
| Loading | `…` | `text-muted-foreground` | `Loading SLA…` |
| Error / unavailable | `—` | `text-muted-foreground` | `SLA unavailable` |

Times are formatted via `formatTimeSince`-style hours/days (e.g. `3h`, `2d 4h`). No live ticking — values reflect the server snapshot at last refetch.

## Refetch / error handling

- D2 invalidates with the orders query (`useExplorerOrders` / equivalent). The "Refresh all data" button already invalidates that key; D2's hook keys are downstream (`['order-sla', orderIdsHash]`) and re-resolve automatically.
- Any of the cached tier/group/analysis-service/priority fetches fails → the hook returns `isError: true`; the column shows `unavailable` (muted `—`) per row; one debounced toast `"SLA unavailable"`.
- `/sla/status` fails → same fallback. Rows still render with all other content.
- A sample with no resolvable tier (e.g. unmapped service, no priority, no default) → falls back to the **default tier** if present (matches the Python engine's behavior); if absent → that sample contributes no status and is excluded from the aggregate.
- Mixed-state orders (some samples loading, some loaded) → show `…` until all relevant samples are resolved (no flicker between partial verdicts).

## Tests

### Backend (small)
- `backend/tests/test_sla_schema.py` — extend: assert `amber_threshold_percent` defaults to `20` after migration.
- `backend/tests/test_api_sla_tiers.py` — extend:
  - GET round-trip includes `amber_threshold_percent`.
  - POST/PUT accept and persist a custom value.
  - POST/PUT with `amber_threshold_percent < 1` or `> 100` returns `422`.
  - PUT can update the threshold without touching other fields.

### Frontend
- `src/test/sla-resolution.test.ts` — pure-function tests for:
  - `buildServiceToGroupTierMap` — single-group, multi-group with tightest-tier wins.
  - `resolveSampleTier` — precedence (priority > group > default); multi-group tightest; missing analyses; unmapped service falls through to default.
  - `classifySampleColor` — green/amber/red boundaries with various `amber_threshold_percent` values; breached strict `>`.
  - `aggregateOrderSlaVerdict` — worst-active selection (red over amber over green); all-published → `met`; none-received → `awaiting`; mixed → worst.
- `src/test/order-sla.test.ts` — hook-level test (mock `fetchSlaStatuses`): correct batch items built (one per received-but-unpublished sample, key = `sample_uid`); verdict map keyed by `orderId`; error → `isError: true` propagation.
- `src/test/order-sla-cell.test.tsx` — render all 7 states (red, amber, green, met, awaiting, loading, error) with stable test IDs (`data-testid="order-sla-cell"`, `data-sla-color="red|amber|green|met|awaiting|loading|error"`).
- `src/test/order-row.test.tsx` — extend: the new `SLA` cell renders the verdict; absence of verdict → loading state.
- `src/test/sla-pane.test.tsx` (or add to existing) — the `amber_threshold_percent` input renders with the tier value and PUTs on blur.

### Live smoke
- After implementation, in `:3101` (browser-authed): the `/explorer` Order Status page shows the new SLA column; each row's color is consistent with its samples' `date_received` + resolved tier; toggling a tier's amber threshold from the SLA pane refreshes the displayed amber/green boundary on the next refetch.

## Open implementation question to resolve during planning

**Per-sample priority bulk fetch.** D2 needs all visible orders' samples' priorities in one call. The existing surface includes per-sample priority access (e.g. `PUT /worksheets/inbox/{sample_uid}/priority`), but a *bulk read* may not yet exist client-side. The planner should:
1. Grep for an existing bulk read (e.g. `getSamplePriorities`, an inbox list that returns priorities, a worksheet endpoint that returns priorities per sample) and use it if present.
2. If absent, decide: (a) issue parallel singletons (acceptable for ~tens of samples per page); (b) add one minimal `GET /sample-priorities?sample_uids=a,b,c` endpoint — the **only** backend addition D2 would make. Recommendation: (b) if the per-page sample count regularly exceeds ~20.

This is the single point of design flexibility; everything else is locked.

## Out of scope (defer to later sub-projects)

- Sortable/filterable by the SLA column (`orderBy=sla_remaining`).
- Live ticking timer (would invalidate the snapshot model + need per-second re-rendering).
- A per-group amber-threshold override (per-tier already covers the common cases).
- Server-side SLA event log / historical metrics.
- Per-sample priority editing UI inside the explorer (assumes priorities are set elsewhere).
- Pagination-aware batching (when the order list paginates, batch per page — the current hook already does this naturally since `orders` is the input).
