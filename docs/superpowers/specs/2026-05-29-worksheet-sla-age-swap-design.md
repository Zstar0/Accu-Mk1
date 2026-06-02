# Worksheet/Inbox SLA Indicator — replace the AGE field (AgingTimer)

*Spec, 2026-05-29. Follows the SLA tier model, the order-list SLA column (D2), the per-group multi-tier follow-on, and the analysis-services SLA column (`docs/superpowers/specs/2026-05-29-analysis-services-sla-column-design.md`).*

## Summary

Replace the hardcoded "AGE" field — the `AgingTimer` component with its fixed 24h/48h color thresholds — with a configured-SLA status indicator across all five surfaces that currently render it: the worksheet drawer, the worksheet drop panel, the worksheets list page, the inbox sample table, and the inbox service-group card.

Each surface maps its row to one or more normalized `SlaSubject` tuples `(priority, groupId, receivedAt, completedAt?)`. A shared hook resolves each subject's tier (via the existing precedence helpers) and batches one `/sla/status` call; a shared compact indicator renders the result — red/amber/green while live, frozen "took Xh"/"Missed by Yh" once completed — in the same `OrderSlaCell` visual idiom used elsewhere in the app.

## Goals

1. Retire the hardcoded `AgingTimer` thresholds in favor of per-tier SLA targets that respect priority overrides and business-hours configuration.
2. Cover all five `AgingTimer` call sites with one shared hook + one shared indicator (no per-surface duplication).
3. Freeze the indicator at completion (`took Xh` / `Missed by Yh`) where a completion timestamp exists; stay live otherwise.
4. Keep the indicator compact enough to drop into the existing narrow AGE columns; full breakdown on hover.

## Non-goals

- No backend or schema change. `/sla/status` already supports per-item batching and `now_override` freezing.
- No removal of `AgingTimer.tsx` — the component file stays parked (unused) after its imports are removed. (Knip may flag it; acceptable.)
- No new i18n keys — reuses the existing `orderStatus.sla.*` namespace; compact durations come from `formatMinutes`.
- No filtering/sorting by SLA on these surfaces in this iteration.

## Decisions captured during brainstorming

| Decision | Value |
|---|---|
| Scope | All 5 `AgingTimer` surfaces |
| Architecture | One normalized `SlaSubject` model + one batched hook (`useSlaForSubjects`) + one indicator (`SlaAgeIndicator`) — Approach A |
| Completed-state behavior | Freeze elapsed at the completion timestamp and show outcome (`took Xh` met / `Missed by Yh` missed) — same historical treatment as published samples |
| Freeze authority | Worksheet-level `completed_at` freezes all its subjects; surfaces with no completion concept (inbox) stay live |
| `AgingTimer.tsx` | Keep parked, do not delete |
| Visual | Compact `OrderSlaCell` idiom (dot + short duration), hover → `SlaBreakdownTooltip` |

## Architecture

```
<surface row>
   │  maps row → SlaSubject[] (1 for single-group, N for aggregate)
   ▼
useSlaForSubjects(subjects)
   ├── useSlaTiers()          (shared cache)
   ├── useSlaPriorityTiers()  (shared cache)
   ├── useServiceGroups()     (shared cache)
   ├── resolve tier per subject (existing precedence helpers)
   └── one batched POST /sla/status (now_override = completedAt when set)
   ▼
Map<key, SlaSubjectSnapshot>
   ▼
<SlaAgeIndicator snapshot={...} | snapshots={[...]} compact />
   └── pickWorstSnapshot for arrays → SlaBreakdownTooltip on hover
```

The five call sites never touch tier resolution or fetching. They build subject(s), call the hook, and render the indicator.

## Components & files

### New files

| File | Responsibility |
|---|---|
| `src/services/sla-subjects.ts` | `SlaSubject` + `SlaSubjectSnapshot` types, `useSlaForSubjects(subjects)` hook, `pickWorstSnapshot(snapshots)` helper |
| `src/components/hplc/SlaAgeIndicator.tsx` | Presentational indicator (single snapshot or worst-of-array), `React.memo` with structural equality |
| `src/test/sla-subjects.test.tsx` | Hook + worst-pick tests |
| `src/test/sla-age-indicator.test.tsx` | Renderer tests |

### Changed files

| File | Change |
|---|---|
| `src/components/hplc/WorksheetDrawerItems.tsx` | Replace `AgingTimer` (line ~316) with `SlaAgeIndicator`; build 1 subject per item |
| `src/components/hplc/WorksheetDropPanel.tsx` | Replace `AgingTimer` (line ~198) with `SlaAgeIndicator`; build 1 subject per item |
| `src/components/hplc/WorksheetsListPage.tsx` | Replace the `completed_at ? date : AgingTimer` AGE cell (line ~322-337) with `SlaAgeIndicator` fed N subjects (one per `ws.items[]`), worst aggregate |
| `src/components/hplc/InboxSampleTable.tsx` | Replace `AgingTimer` (line ~326) with `SlaAgeIndicator` fed N subjects (one per `sample.analyses_by_group[]`), worst aggregate |
| `src/components/hplc/InboxServiceGroupCard.tsx` | Replace `AgingTimer` (line ~166) with `SlaAgeIndicator`; build 1 subject from `(sample.priority, group.group_id, sample.date_received)` |

`AgingTimer.tsx` itself is left unmodified and unused.

### Types — `sla-subjects.ts`

```ts
import type { InboxPriority, SlaStatus, SlaTier } from '@/lib/api'
import type { SlaColor } from '@/lib/sla-resolution'

export interface SlaSubject {
  /** Stable unique id — used as the /sla/status batch key and the React key.
   *  Caller-supplied so it's unambiguous within a single render (e.g. worksheet
   *  item id, or `${sampleUid}|${groupId}` for inbox groups). */
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
  color: SlaColor        // from classifySampleColor (red|amber|green)
  tier: SlaTier
  priority: InboxPriority
  groupId: number | null
  groupName?: string     // denormalized for the tooltip source line
  isFrozen: boolean      // true when the subject had a completedAt
}
```

### Hook contract — `useSlaForSubjects`

```ts
export interface SlaSubjectsResult {
  byKey: Map<string, SlaSubjectSnapshot>
  isLoading: boolean
  isError: boolean
}

export function useSlaForSubjects(subjects: SlaSubject[]): SlaSubjectsResult
```

**Behavior:**
1. Pull `useSlaTiers`, `useSlaPriorityTiers`, `useServiceGroups` (shared TanStack cache).
2. Build, once (memoized): `tiersById`, `defaultTier`, `groupIdToTier` (`buildGroupIdToTierMap`), `globalPriorityToTier` (`buildGlobalPriorityToTierMap`), `perGroupPriorityToTier` (`buildPerGroupPriorityToTierMap`), `groupNameById`.
3. For each subject with a non-null `receivedAt`, resolve its tier by precedence:
   - per-(priority, groupId) override → global priority override → group's own tier (`groupIdToTier.get(groupId)`) → default tier.
   - If resolution yields no tier, the subject produces no snapshot.
4. Emit one `SlaStatusRequestItem` per resolvable subject: `{ key, received_at: receivedAt, target_minutes, business_hours_only, now_override: completedAt ?? undefined }`.
5. Batch one `/sla/status` POST hashed by a stable key string (cache reuse), `placeholderData: keepPreviousData`.
6. Build `byKey`: for each subject, look up its status by `key`, compute `color = classifySampleColor(status, tier)`, set `isFrozen = Boolean(completedAt)`, attach `groupName`.
7. `isLoading` / `isError` aggregate the underlying queries, gated on whether any applicable subjects exist (mirrors `useSampleSla`'s `applicable` short-circuit so an all-empty subject list doesn't report perpetual loading).

### Worst-pick helper — `pickWorstSnapshot`

```ts
/** Returns the worst snapshot for aggregate surfaces. Live ranking:
 *  red > amber > green (ties: most-over for red, least-%-remaining for amber).
 *  Frozen ranking: missed (breached) > met. When a list mixes live + frozen,
 *  live-red still outranks a frozen-missed (an actively-breaching item is more
 *  urgent than a closed one). Returns null for an empty array. */
export function pickWorstSnapshot(snapshots: SlaSubjectSnapshot[]): SlaSubjectSnapshot | null
```

Ranking detail (highest wins): live-red → frozen-missed → live-amber → live-green → frozen-met. Ties within live-red broken by most-over (lowest `remaining_minutes`); within live-amber by least `remaining_minutes / target_minutes`.

### Renderer contract — `SlaAgeIndicator`

```ts
interface SlaAgeIndicatorProps {
  snapshot?: SlaSubjectSnapshot | null   // single-subject surfaces
  snapshots?: SlaSubjectSnapshot[]       // aggregate surfaces (worst wins)
  isLoading: boolean
  isError: boolean
  compact?: boolean
}
```

- Resolves the effective snapshot: `snapshot ?? pickWorstSnapshot(snapshots ?? [])`.
- Renders the compact `OrderSlaCell` idiom (see Rendering rules). `React.memo` with structural equality on the effective snapshot's visually-meaningful fields (`color`, `isFrozen`, `tier.id/target/amber/businessHours`, `status.elapsed/remaining/breached`, `groupId/groupName`) plus `isLoading`/`isError`/`compact`.
- Active (live red/amber/green) and frozen (met/missed) states wrap in shadcn `Tooltip` → `SlaBreakdownTooltip`. Loading/error/no-snapshot use `title=`.

## Rendering rules (compact form)

| State | Dot | Compact text | Full text (non-compact) | Tooltip |
|---|---|---|---|---|
| Live green | `●` green | `9h` | `9h left` | breakdown |
| Live amber | `●` amber | `2h` | `2h left` | breakdown |
| Live red (breached) | `●` red | `−4h` | `over 4h` | breakdown |
| Frozen met (`!breached`) | `✓` muted | `13h` | `took 13h` | breakdown (frozen) |
| Frozen missed (`breached`) | `—` red | `−5h` | `Missed by 5h` | breakdown (frozen) |
| Loading | `…` muted | — | — | `title=` loading |
| Error | `—` muted | — | — | `title=` unavailable |
| No tier / no received date | `—` muted | — | — | `title=` no tier configured |

Durations come from `formatMinutes` (already day-aware: `2d 3h`). Compact drops the "left"/"over"/"took" word; color + sign carry the meaning. Hover always exposes the full `SlaBreakdownTooltip`. Aggregate surfaces render the worst subject; the tooltip's source line names the driving group.

## Per-surface subject mapping

| Surface | File:line | Row shape | Subjects | completedAt |
|---|---|---|---|---|
| Worksheet drawer | `WorksheetDrawerItems.tsx:~316` | single `(sample,group)` item | 1: `key=String(item.id)`, `priority=item.priority`, `groupId=item.service_group_id`, `receivedAt=item.date_received ?? item.added_at` | worksheet `completed_at` (passed from drawer) when worksheet complete |
| Worksheet drop panel | `WorksheetDropPanel.tsx:~198` | same item shape | 1, same mapping | same |
| Worksheets list | `WorksheetsListPage.tsx:~322-337` | worksheet row | N: one per `ws.items[]`, worst aggregate; each `key=String(item.id)`, `groupId=item.service_group_id`, `priority=item.priority`, `receivedAt=item.date_received ?? item.added_at` | `ws.completed_at` for all subjects |
| Inbox sample table | `InboxSampleTable.tsx:~326` | whole multi-group sample | N: one per `sample.analyses_by_group[]`, worst aggregate; each `key=\`${sample.uid}|${group.group_id}\``, `groupId=group.group_id`, `priority=sample.priority`, `receivedAt=sample.date_received` | none (live) |
| Inbox group card | `InboxServiceGroupCard.tsx:~166` | sample scoped to one group | 1: `key=\`${sample.uid}|${group.group_id}\``, `groupId=group.group_id`, `priority=sample.priority`, `receivedAt=sample.date_received` | none (live) |

Surfaces that render many rows (inbox table, worksheets list, drawer item list) call `useSlaForSubjects` ONCE at the list level with the flattened subjects of all rows, then slice per row by key — one `/sla/status` batch per surface, not per row.

## Edge cases

| Edge | Behavior |
|---|---|
| `receivedAt` null (both `date_received` and `added_at`) | No subject emitted; indicator renders `—`. Matches `AgingTimer` null handling. |
| `groupId` null | Default-tier fallback. No default tier → `—`. |
| Priority string not a valid `InboxPriority` | Coerce to `'normal'` (defensive; matches existing priority handling). |
| Worksheet with zero items | List row → empty subjects → `—`. |
| Multi-group sample, some groups have no tier | Per-group resolution; groups without a tier are skipped; worst of the rest wins. |
| Completed worksheet with mixed item `prep_status` | Worksheet `completed_at` freezes ALL its subjects (worksheet-level completion is authoritative). |
| Frozen aggregate | Any missed → red "Missed by"; else met → green "took". |
| Inbox samples | Always live until they leave the inbox (no `completedAt`). |
| Flicker | `keepPreviousData` on the status query + `React.memo` structural equality on the indicator. |

## Test plan (TDD)

### `sla-subjects.test.tsx` (~8 tests)
1. Empty subjects → empty `byKey`, `isLoading === false`, no `/sla/status` call.
2. Single subject resolves the group's own tier.
3. Global priority override beats the group tier.
4. Per-(priority, groupId) override beats the global priority override.
5. `groupId === null` resolves the default tier; no default → no snapshot.
6. `receivedAt === null` → no batch item for that subject.
7. `completedAt` set → request carries `now_override` and snapshot `isFrozen === true`.
8. `pickWorstSnapshot`: ranks live-red > frozen-missed > live-amber > live-green > frozen-met; empty → null.

### `sla-age-indicator.test.tsx` (~8 tests)
1. Live green: green `●` + `9h` (compact) / `9h left` (non-compact).
2. Live amber: amber `●`.
3. Live red: red `●` + over text, `data-sla-color="red"`.
4. Frozen met: `✓` + took text, `data-sla-color="met"`.
5. Frozen missed: red `—` + missed text, `data-sla-color="missed"`.
6. Loading → `…`; error → `—`; null snapshot → `—`.
7. `snapshots` array prop renders the worst subject.
8. Active/frozen render `SlaBreakdownTooltip`; loading/error use `title=`.

### Manual smoke (post-implementation, on `:3101`)
- Worksheet drawer: open a worksheet, verify each item's AGE cell now shows an SLA dot + duration; hover shows the breakdown.
- Worksheets list: row shows worst SLA across its items; a completed worksheet shows frozen met/missed instead of the bare completion date.
- Inbox sample table: a multi-group sample row shows the worst group's SLA.
- Inbox group card: shows that group's SLA.
- Confirm `AgingTimer.tsx` still exists but is no longer imported.

## Reused as-is

- `src/lib/sla-resolution.ts` — `buildGroupIdToTierMap`, `buildGlobalPriorityToTierMap`, `buildPerGroupPriorityToTierMap`, `classifySampleColor`.
- `src/lib/sla-format.ts` — `formatMinutes` (day-aware), `formatTarget`.
- `src/components/explorer/SlaBreakdownTooltip.tsx`.
- `src/lib/api.ts` — `fetchSlaStatuses`, `SlaStatusRequestItem`, `SlaStatus`, `SlaTier`, `InboxPriority`.
- `src/services/sla.ts`, `src/services/service-groups.ts` — cached queries.

## Files quick-index

- New: `src/services/sla-subjects.ts`, `src/components/hplc/SlaAgeIndicator.tsx`, `src/test/sla-subjects.test.tsx`, `src/test/sla-age-indicator.test.tsx`
- Changed: `WorksheetDrawerItems.tsx`, `WorksheetDropPanel.tsx`, `WorksheetsListPage.tsx`, `InboxSampleTable.tsx`, `InboxServiceGroupCard.tsx`
- Parked unused: `src/components/hplc/AgingTimer.tsx`
