# Phase 18: Worksheets List - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-01
**Phase:** 18-worksheets-list
**Areas discussed:** KPI row design, Worksheet row content, Filter & sort behavior, Click-to-detail interaction

---

## KPI Row Design

| Option | Description | Selected |
|--------|-------------|----------|
| Client-computed KPI cards | Four stat cards computed from existing listWorksheets() response | ✓ |
| Server-side KPI endpoint | New dedicated endpoint for aggregated stats | |
| Inline stats in header | Stats embedded in page header without cards | |

**User's choice:** Client-computed KPI cards (recommended default)
**Notes:** User accepted recommended setup. Stats: Open Worksheets, Items Pending, High Priority count, Avg Age.

---

## Worksheet Row Content

| Option | Description | Selected |
|--------|-------------|----------|
| Compact summary row | Table row with title, analyst, status badge, item count, priority breakdown, oldest age | ✓ |
| Card-based layout | Each worksheet as a card with more visual space | |
| Minimal list | Just title, status, item count | |

**User's choice:** Compact summary row (recommended default)
**Notes:** Reuses existing PriorityBadge, AgingTimer, StateBadge components.

---

## Filter & Sort Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Simple toolbar filters | Segmented status tabs + analyst dropdown, local state | ✓ |
| URL-persisted filters | Filters encoded in hash URL for shareability | |
| Search bar + filters | Free-text search plus dropdown filters | |

**User's choice:** Simple toolbar filters (recommended default)
**Notes:** Status filter uses existing backend param. Analyst filter is client-side post-filter. No URL persistence for v1.

---

## Click-to-Detail Interaction

| Option | Description | Selected |
|--------|-------------|----------|
| Opens clipboard drawer | Row click opens Phase 17 floating drawer, list stays behind | ✓ |
| Navigate to detail page | Standard page navigation to worksheet detail | |

**User's choice:** Opens clipboard drawer (recommended default)
**Notes:** Consistent with Phase 17 D-11 pattern. Sets activeWorksheetId in ui-store.

---

## Claude's Discretion

- Card layout dimensions and spacing for KPI row
- Loading skeleton design
- Empty state design
- Responsive behavior
- Nav item count badge

## Deferred Ideas

None — discussion stayed within phase scope.
