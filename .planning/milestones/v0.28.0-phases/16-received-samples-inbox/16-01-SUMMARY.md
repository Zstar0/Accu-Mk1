---
phase: 16-received-samples-inbox
plan: "01"
subsystem: backend
tags: [fastapi, sqlalchemy, senaite, worksheets, inbox]
dependency_graph:
  requires: [Phase 15 service_groups/service_group_members models]
  provides: [SamplePriority model, Worksheet model, WorksheetItem model, GET /worksheets/inbox, PUT /worksheets/inbox/{uid}/priority, GET /worksheets/users, PUT /worksheets/inbox/bulk, POST /worksheets]
  affects: [Phase 16 frontend plans that consume these endpoints]
tech_stack:
  added: []
  patterns: [SQLAlchemy mapped_column 2.0, FastAPI async endpoint, httpx BasicAuth SENAITE proxy, upsert pattern via scalar_one_or_none + add, open-worksheet exclusion filter, stale-data guard 409]
key_files:
  created: []
  modified: [backend/models.py, backend/main.py]
decisions:
  - Staging worksheet (__inbox_staging__) used as parking lot for bulk pre-assignments before real worksheet exists
  - Stale data guard fires individual SENAITE verification calls per UID before worksheet creation (sequential, acceptable for small batches)
  - Orphan worksheet_items from staging worksheet are picked up at create_worksheet time by querying open worksheet_items
  - Open worksheet exclusion uses a set[str] (assigned_uids) built from worksheet_items JOIN worksheets WHERE status='open'
metrics:
  duration: "4 minutes"
  completed: "2026-04-01T03:39:05Z"
  tasks_completed: 2
  files_modified: 2
---

# Phase 16 Plan 01: Received Samples Inbox Backend Summary

**One-liner:** SQLAlchemy models for sample priorities/worksheets and 5 FastAPI inbox endpoints with SENAITE enrichment, service-group grouping, open-worksheet exclusion, and 409 stale-data guard.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add SamplePriority, Worksheet, WorksheetItem models | 2af7c0a | backend/models.py |
| 2 | Add all inbox backend endpoints to main.py | bff81d7 | backend/main.py |

## What Was Built

### Task 1 — New SQLAlchemy Models (backend/models.py)

Three new model classes added after `ServiceGroup`:

- **SamplePriority** (`sample_priorities`): PK is `sample_uid` (str), stores priority string + updated_at. No FK to SENAITE — UID is the join key.
- **Worksheet** (`worksheets`): Full worksheet record with status lifecycle, `assigned_analyst_id` and `created_by` FKs to `users.id` (both SET NULL on delete), notes, timestamps.
- **WorksheetItem** (`worksheet_items`): Per-sample row with FK to `worksheets.id` (CASCADE delete), FK to `service_groups.id` (SET NULL), FK to `users.id` for analyst (SET NULL), instrument_uid, priority, notes.

All tables will be created by `Base.metadata.create_all()` on next startup.

### Task 2 — Pydantic Schemas + 5 Endpoints (backend/main.py)

**Schemas added:** `InboxAnalysisItem`, `InboxServiceGroupSection`, `InboxSampleItem`, `InboxResponse`, `PriorityUpdate`, `BulkInboxUpdate`, `WorksheetCreate`

**Endpoints:**

1. **GET /worksheets/inbox** — Fetches `sample_received` samples from SENAITE, filters out UIDs already in open `worksheet_items` (assigned_uids exclusion set), builds keyword→service-group map from `AnalysisService` JOIN `service_group_members` JOIN `ServiceGroup`, enriches each sample with grouped analyses (fetches per-sample detail if SENAITE doesn't include analyses inline), loads local priorities from `sample_priorities`, loads pre-assignments from open `worksheet_items`, returns `InboxResponse`.

2. **PUT /worksheets/inbox/{sample_uid}/priority** — Validates priority is one of normal/high/expedited, upserts into `sample_priorities` via scalar_one_or_none check.

3. **GET /worksheets/users** — Returns `[{id, email}]` for active users only. Uses `Depends(get_current_user)` not `require_admin` — accessible to standard users for analyst dropdown.

4. **PUT /worksheets/inbox/bulk** — Bulk upserts priorities and/or analyst/instrument pre-assignments. Pre-assignments are parked in a sentinel `__inbox_staging__` worksheet (status=open) that acts as a temporary store until a real worksheet is created.

5. **POST /worksheets** — Stale-data guard: calls SENAITE for each sample UID to confirm `review_state == sample_received`. Returns HTTP 409 with `{stale_uids, message}` if any are stale. If all valid, creates `Worksheet` row + `WorksheetItem` rows (inherits priority from `sample_priorities`, analyst/instrument from any pre-assignment items).

## Deviations from Plan

### Auto-added functionality

**1. [Rule 2 - Missing Critical] Staging worksheet for bulk pre-assignments**
- **Found during:** Task 2 implementation of PUT /worksheets/inbox/bulk
- **Issue:** The plan specified storing analyst/instrument as "orphan items" but provided no mechanism for where to store WorksheetItems before a real worksheet exists (WorksheetItem.worksheet_id is NOT NULL FK).
- **Fix:** Created a sentinel `__inbox_staging__` open worksheet as a parking lot. `create_worksheet` picks up assignments from any open WorksheetItems for those sample_uids regardless of which worksheet they're in.
- **Files modified:** backend/main.py (bulk endpoint)
- **Commit:** bff81d7

## Known Stubs

None — all endpoints are fully wired. Service group grouping falls back to the default group if no matching keyword found.

## Self-Check: PASSED
