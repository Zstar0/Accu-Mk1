# Analysis Services SLA Column — Sample Details Page

*Spec, 2026-05-29. Follows up the D2 SLA work (`docs/superpowers/specs/2026-05-27-d2-sla-column-design.md`) and the per-group multi-tier follow-on.*

## Summary

Add a per-row SLA status column to the Analysis Services list (`AnalysisTable`) on the Sample Details page. Each row resolves its analysis's service group via `keyword → service_id → group_id`, finds the matching per-group snapshot already produced by `useSampleSla`, and renders a colored status indicator using the visual format established by `OrderSlaCell` (Order Status page).

The column gives analysts a per-service red/amber/green at-a-glance when a sample has multiple service groups with different tiers (e.g., a 4h Microbiology service alongside a 24h Identity service on the same sample).

## Goals

1. Surface per-service SLA status inside `AnalysisTable` using the same visual idiom as `OrderSlaCell`.
2. Reuse existing primitives — `useSampleSla`'s per-group snapshots, the keyword→service→group resolution chain, `SlaBreakdownTooltip` — without new network traffic.
3. Make the column sortable by remaining time (ascending = worst first).
4. Keep the table presentation-only: SLA resolution lives in a focused hook, not in `AnalysisTable`.

## Non-goals

- No new backend endpoint or schema change (`/sla/status` already supports per-group batching via `${sample_uid}|${groupKey}` keys).
- No per-analysis clock semantics. Elapsed time is sample-level (received → published-or-now) — colors differ across rows only because tiers differ.
- No SLA on history rows (retested-and-superseded prior analyses).
- No filtering by SLA color in this iteration (sortable, not filterable).

## Decisions captured during brainstorming

| Decision | Value |
|---|---|
| Column intent | Red/amber/green per-row status indicator |
| Clock semantic | Sample-level — same elapsed for all rows; tier varies by row's service-group |
| Visual form | `OrderSlaCell`-style color tag (dot + short text + hover tooltip) |
| Non-active rows | Always show — retracted, rejected, published all render an SLA cell |
| Unmapped services | Fall through to default tier (standard precedence) |
| Sortable | Yes — by remaining time (asc = worst first); unmapped sort to bottom |
| History rows | No SLA (empty `<td>`) |

## Architecture

```
SampleDetails.tsx
    │
    ├── useSampleSla(lookup)        ──► SampleHeaderSla (existing)
    │
    └── useAnalysisSlaMap(lookup)   ──► AnalysisTable
            │                            │
            │                            └── AnalysisRow
            │                                  │
            │                                  └── AnalysisSlaCell
            │                                        │
            │                                        └── SlaBreakdownTooltip (reused)
            │
            ├── (internally calls useSampleSla — shares cache)
            ├── useAnalysisServices()  (shared cache)
            └── useServiceGroups()     (shared cache)
```

Both hooks share the same five underlying TanStack queries (tiers, priority overrides, service groups, analysis services, sample priorities) and the same `/sla/status` round-trip. Calling both from `SampleDetails` causes ONE fetch, not two.

## Components & files

### New files

| File | Purpose |
|---|---|
| `src/services/analysis-sla.ts` | `useAnalysisSlaMap(lookup)` hook returning `Map<keyword, SampleSlaSnapshot>` + pass-through flags |
| `src/components/senaite/AnalysisSlaCell.tsx` | Cell renderer + `React.memo` with structural equality |
| `src/test/analysis-sla.test.tsx` | Hook tests |
| `src/test/analysis-sla-cell.test.tsx` | Cell tests |

### Changed files

| File | Changes |
|---|---|
| `src/components/senaite/AnalysisTable.tsx` | New props (`analysisSlaMap`, `isAnalysisSlaLoading`, `isAnalysisSlaError`, `isAnalysisSlaPublished`); thread through to `AnalysisRow`; add `SortableHeader column="sla" label="SLA"` between Status and Captured; render `<AnalysisSlaCell>` `<td>` in `AnalysisRow`; empty `<td>` in `HistoryRow`; bump empty-state `colSpan` 10 → 11; add `sla` to sort comparator |
| `src/components/senaite/SampleDetails.tsx` | Call `useAnalysisSlaMap(data)` near the existing `useSampleSla` call; pass props into `<AnalysisTable />` |
| `locales/en.json`, `locales/fr.json`, `locales/ar.json` | Add `orderStatus.sla.columnHeader: "SLA"` (identical English across all three files per project convention) |

### Hook contract — `useAnalysisSlaMap`

```typescript
export interface AnalysisSlaMapResult {
  /** keyword → snapshot for the group that keyword's service belongs to.
   *  Empty map when SLA isn't applicable (no lookup, no received date) or
   *  when the underlying queries haven't resolved yet. */
  byKeyword: Map<string, SampleSlaSnapshot>
  isLoading: boolean
  isError: boolean
  isPublished: boolean
  priority: InboxPriority | null
}

export function useAnalysisSlaMap(
  lookup: SenaiteLookupResult | null | undefined
): AnalysisSlaMapResult
```

**Behavior:**
1. Calls `useSampleSla(lookup)` for snapshots + flags. Forwards `isLoading`/`isError`/`isPublished`/`priority`.
2. Calls `useAnalysisServices()` and `useServiceGroups()` (already in TanStack cache from `useSampleSla` internals — no extra network).
3. Builds `keywordToServiceId` (via existing `buildKeywordToServiceIdMap`) and `serviceIdToGroupId` (via existing `buildServiceIdToGroupIdMap`) once, memoized on the underlying query data.
4. Builds a snapshot index `Map<GroupKey, SampleSlaSnapshot>` from `snapshots[]`.
5. Walks `lookup.analyses`; for each `analysis.keyword`:
   - Resolve `service_id = keywordToServiceId.get(keyword)`; if missing → groupKey = `NO_GROUP_KEY`.
   - Resolve `group_id = serviceIdToGroupId.get(service_id)`; if missing → groupKey = `NO_GROUP_KEY`.
   - Look up the snapshot for that groupKey in the snapshot index.
   - If found, add `byKeyword.set(keyword, snapshot)`.
6. Returns `{ byKeyword, isLoading, isError, isPublished, priority }`.

### Cell contract — `AnalysisSlaCell`

```typescript
interface AnalysisSlaCellProps {
  snapshot: SampleSlaSnapshot | null
  priority: InboxPriority | null  // forwarded to SlaBreakdownTooltip
  isLoading: boolean
  isError: boolean
  isPublished: boolean
}
```

Renders in the visual style of `OrderSlaCell`:

| State | Dot | Text | Tooltip |
|---|---|---|---|
| Active green (`!isPublished`, color=green) | `●` green | `9h left` | `SlaBreakdownTooltip` (priority forwarded) |
| Active amber | `●` amber | `2h left` | `SlaBreakdownTooltip` |
| Active red | `●` red | `Over 3h` | `SlaBreakdownTooltip` |
| Published met (`isPublished`, `!breached`) | `✓` muted | `took 13h` | `SlaBreakdownTooltip` (isPublished=true) |
| Published missed (`isPublished`, `breached`) | `—` red | `Missed by 5h` | `SlaBreakdownTooltip` (isPublished=true) |
| Loading | `…` muted | (sr-only "Loading SLA…") | `title=` simple |
| Error | `—` muted | (sr-only "SLA unavailable") | `title=` simple |
| No snapshot (unmapped + no default tier) | `—` muted | `—` | `title=` simple "No SLA tier configured" |

Wrapped in `React.memo` with structural equality on the visually-meaningful fields — same pattern as `OrderSlaCell` to prevent flicker when the parent re-renders with a new map reference but identical snapshot contents.

Equality fields:
- `isLoading`, `isError`, `isPublished`
- `snapshot.color`
- `snapshot.tier?.id`, `tier?.target_minutes`, `tier?.amber_threshold_percent`, `tier?.business_hours_only`
- `snapshot.status?.elapsed_minutes`, `status?.remaining_minutes`, `status?.breached`
- `snapshot.reason?.tierSource`, `reason?.priorityScope`
- `snapshot.groupKey`, `snapshot.groupName`

## Sort wiring

The existing `sortConfig` in `AnalysisTable` already supports arbitrary string column names via the `handleSort` reducer. Add a `sla` case to the comparator:

- **Sort key per row:**
  - Active: `snapshot?.status.remaining_minutes ?? Number.POSITIVE_INFINITY`
  - Published: `snapshot?.status.elapsed_minutes ?? Number.POSITIVE_INFINITY`
- **Direction asc:** worst (most overdue / most elapsed) first.
- **Direction desc:** least urgent first.
- **Rows without snapshots sort to the bottom** in either direction (POSITIVE_INFINITY tiebreak).
- **History rows are unaffected** — they remain grouped beneath their current row.

The sort key formula choice (remaining vs elapsed depending on `isPublished`) lives in `AnalysisTable`, since it's a sort-only concern and doesn't need to leak into the hook.

## Edge cases

| Edge | Behavior |
|---|---|
| Unmapped keyword + default tier exists | Resolves to NO_GROUP_KEY snapshot from `useSampleSla`. Cell renders normally. |
| Unmapped keyword + no default tier | No entry in `byKeyword`. Cell renders muted `—` with `title="No SLA tier configured"`. |
| `analysis.keyword === null` | Treated as unmapped. No entry in `byKeyword`. |
| Sample with zero analyses | Map is empty (iteration over `lookup.analyses` produces nothing). Table renders an empty `<td>` per row — vacuous case since there are no rows. |
| History rows | Empty `<td>` in `HistoryRow`. No SLA shown. |
| Retracted / rejected current rows | SLA still rendered (sample-level clock still ticking). |
| Sample not yet received (`!date_received`) | `useSampleSla` returns empty snapshots, `applicable=false`; hook returns empty map; cells render muted `—`. |
| Sample published | Snapshots have frozen elapsed via existing `now_override` plumbing; cells render `took Xh` / `Missed by Yh`. |
| Flicker resistance | `React.memo` structural equality on the cell + `keepPreviousData` inherited from `useSampleSla`'s `statusQuery`. |

## Test plan (TDD)

### `analysis-sla.test.tsx` — hook tests (~7 tests)

1. Returns empty `byKeyword` map when `lookup` is null.
2. Returns empty `byKeyword` map when `lookup.date_received` is null.
3. Maps each `analysis.keyword` to the snapshot whose `groupKey` matches the analysis's service-group.
4. Multi-group sample: keywords in different groups land on different snapshots.
5. Unmapped keyword falls through to the default-tier snapshot (NO_GROUP_KEY) when a default tier is configured.
6. Unmapped keyword + no default tier configured → no entry in `byKeyword`.
7. Passes through `isLoading`, `isError`, `isPublished`, `priority` from `useSampleSla`.

### `analysis-sla-cell.test.tsx` — cell tests (~9 tests)

1. Active green: renders green `●` + `Xh left` text.
2. Active amber: renders amber `●` + `Xh left` text.
3. Active red: renders red `●` + `Over Xh` text.
4. Published met: renders `✓` + `took Xh` text.
5. Published missed: renders red `—` + `Missed by Xh` text.
6. Loading: renders `…` + sr-only loading label.
7. No snapshot: renders muted `—` + `title="No SLA tier configured"`.
8. `React.memo` structural equality: prop reference churn with identical fields does NOT trigger re-render; color flip DOES.
9. Active/published states render `SlaBreakdownTooltip` content on hover; loading/error/no-snapshot use `title=` only.

### `AnalysisTable` integration (~2 tests)

1. Sort by `sla` column ascending: rows order by `remaining_minutes` ascending (worst first); unmapped rows at bottom.
2. Empty-state row's `colSpan` is 11 (not 10).

### Total new tests
- 7 hook + ~9 cell + 2 integration ≈ 18 new tests.
- Reuses existing `SampleSlaSnapshot`, `SlaTier`, `SlaStatus` fixtures already present in `order-sla.test.tsx` and `sample-sla.test.tsx`.

## i18n

| Key | English |
|---|---|
| `orderStatus.sla.columnHeader` | `SLA` |
| `orderStatus.sla.noTierConfigured` | `No SLA tier configured` |

All existing breakdown keys (`orderStatus.sla.over`, `.left`, `.met`, `.publishedTook`, `.missedBy`, `.tooltipFull`, etc.) are reused unchanged. New keys added to all three locale files (`en.json`, `fr.json`, `ar.json`) with identical English values per project convention.

## Out of scope (potential follow-ons)

- Per-row SLA filter (filter rows by red/amber/green).
- Per-analysis clock semantics (each row's elapsed tied to its own captured/verified timestamp).
- SLA on history rows (currently empty).
- Bulk SLA actions (e.g., "show me all my over-target services across all samples").

## Files quick-index

- New: `src/services/analysis-sla.ts`, `src/components/senaite/AnalysisSlaCell.tsx`, `src/test/analysis-sla.test.tsx`, `src/test/analysis-sla-cell.test.tsx`
- Changed: `src/components/senaite/AnalysisTable.tsx`, `src/components/senaite/SampleDetails.tsx`, `locales/{en,fr,ar}.json`
- Reused as-is: `src/services/sample-sla.ts`, `src/components/explorer/SlaBreakdownTooltip.tsx`, `src/lib/sla-resolution.ts` (helpers only)
