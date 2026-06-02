# Spec: SLA breakdown tooltip — "Received" as first field

*2026-06-01. Small follow-on to the SLA coverage stack.*

## What

Add the sample's **received date/time** (SLA clock start) as the **first field** in
the shared `SlaBreakdownTooltip`, above the existing `Tier:` line. Renders on every
surface that hosts the tooltip (single shared component).

Example:

```
SLA — over by 5d 13h
─────────────────────
Received: Jun 1, 02:32 PM      ← NEW first field
Tier: Standard
  ↳ Default tier ...
─────────────────────
Target: 48h (2d) (business hours)
Elapsed: 7d 13h
Remaining: -5d 13h
─────────────────────
Driving sample: BW-0002
```

## Decisions (resolved)

- **Source:** the SLA clock start = `received_at` (`lookup.date_received` /
  `subject.receivedAt`). Already in scope at every snapshot/verdict build site.
- **Format:** reuse `formatDate` from `components/explorer/helpers.tsx` — the SAME
  formatter `SampleDetails` already uses for "Received {date}", so the timestamp
  renders identically on the same page. (en-US, no year — NOT runtime-locale;
  matches every other date in the app + deferred-i18n preference.)
- **Optionality:** `receivedAt?: string | null` on all carrier types (consistent
  with existing optional `groupName?`/`reason?`). Tooltip omits the line when absent.
- **Both modes:** renders first in live AND `isPublished` (historical) mode — the
  received instant is the clock start regardless. Not nested under any live-only branch.

## Change set

**Types (optional field):**
1. `SlaBreakdownTooltipProps.receivedAt?: string | null` (`SlaBreakdownTooltip.tsx`)
2. `OrderSlaVerdict.drivingReceivedAt?: string | null` (`sla-resolution.ts`)
3. `SampleSlaSnapshot.receivedAt?: string | null` (`order-sla.ts`)
4. `SlaSubjectSnapshot.receivedAt?: string | null` (`sla-subjects.ts`)

**Population (source already in scope):**
5. `aggregateOrderSlaVerdict` → `drivingReceivedAt: driver.lookup?.date_received ?? null`
6. `order-sla.ts` snapshot build → `receivedAt: s.lookup.date_received`
7. `sample-sla.ts` snapshot build → `receivedAt: lookup?.date_received ?? null`
8. `sla-subjects.ts` snapshot build → `receivedAt: subject.receivedAt`
   (`analysis-sla.ts` forwards `useSampleSla` snapshots — gets it for free.)

**Render:** `SlaBreakdownTooltip` renders `Received: {formatDate(receivedAt)}` as the
first field of the tier block when `receivedAt` present.

**5 call-site pass-throughs:** OrderSlaCell, SampleSlaIndicator (`renderRow`),
SampleHeaderSla (`renderSnapshotSpan`), AnalysisSlaCell, SlaAgeIndicator.

**Memo equality:** add `receivedAt` one-liners (defensive — functionally derivable
from `elapsed_minutes` which is already compared; cannot cause stale render).

**i18n:** add `orderStatus.sla.breakdown.received` = `"Received:"` to en/fr/ar
(identical English, translation deferred).

**Tests (TDD):** `sla-breakdown-tooltip.test.tsx` — renders Received as first field
when set; omitted when null; present in both live and published modes.

## Verification

- `npm run typecheck` (missed population site → type error)
- SLA suite (15-file vitest list from handoff)
- Scoped `npx eslint <changed files>` from inside worktree (NOT `npm run lint`)
