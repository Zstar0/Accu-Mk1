---
phase: 16-received-samples-inbox
verified: 2026-03-31T00:00:00Z
status: gaps_found
score: 9/11 must-haves verified
gaps:
  - truth: "User can assign a tech (analyst) to a sample inline via dropdown"
    status: failed
    reason: "Assigning tech/instrument via PUT /worksheets/inbox/bulk stores worksheet_items in __inbox_staging__ worksheet (status='open'). The inbox exclusion filter in GET /worksheets/inbox excludes all samples whose UIDs appear in worksheet_items joined to worksheets WHERE status='open'. On the next 30-second poll those samples disappear from the inbox, breaking inline assignment (INBX-04)."
    artifacts:
      - path: "backend/main.py"
        issue: "__inbox_staging__ worksheet created with status='open' at line 10741. The exclusion filter at lines 10479-10486 then hides those samples from the inbox on next poll."
    missing:
      - "Change __inbox_staging__ worksheet status to a value other than 'open' (e.g., 'pre_assigned' or 'staging') so the exclusion filter does not treat it as a real open worksheet."
      - "Update the exclusion filter query (line 10482) to only exclude worksheets with status='open' AND title != '__inbox_staging__', OR update the inbox assignment query (line 10523-10530) to also look for staging worksheets."
      - "Alternatively: store pre-assignments in a separate table (e.g., inbox_assignments) not subject to the open-worksheet exclusion logic."

  - truth: "User can assign an instrument to a sample inline via dropdown"
    status: failed
    reason: "Same root cause as INBX-04. Instrument assignment goes through the same PUT /worksheets/inbox/bulk path, causing identical disappearance from inbox after the next 30s poll."
    artifacts:
      - path: "backend/main.py"
        issue: "Same __inbox_staging__ / status='open' conflict as INBX-04."
    missing:
      - "Fix the staging worksheet status (same fix as INBX-04 — both gaps share the same root cause)."
human_verification:
  - test: "End-to-end inbox workflow"
    expected: "Table loads with SENAITE received samples, rows expand to show analyses grouped by service group with color badges, polling refreshes every 30s, bulk toolbar appears on selection, Create Worksheet dialog opens with auto-generated WS-YYYY-MM-DD-001 title"
    why_human: "Requires live SENAITE connection and running backend to verify real data flow, optimistic updates, and 30s polling behavior in the browser network tab"
---

# Phase 16: Received Samples Inbox Verification Report

**Phase Goal:** Users see all SENAITE received samples in a live queue with aging timers and SLA color coding, can set priority and assign tech/instrument inline or in bulk, and can create a worksheet from selected samples in one action.
**Verified:** 2026-03-31
**Status:** gaps_found
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | GET /worksheets/inbox returns enriched samples with analyses grouped by service group | VERIFIED | backend/main.py lines 10437-10633: full SENAITE fetch, keyword-to-group map, N+1 analysis fetch fallback, priority_map, analyses_by_group grouping |
| 2 | GET /worksheets/inbox excludes samples already assigned to open worksheets | VERIFIED | lines 10479-10486: `open_worksheet_uids_rows` query JOIN on `Worksheet.status == "open"`, filtered via `assigned_uids` set |
| 3 | PUT /worksheets/inbox/{uid}/priority persists priority in sample_priorities table | VERIFIED | lines 10636-10662: upsert with `scalar_one_or_none + add`, validates against `{"normal","high","expedited"}` |
| 4 | GET /worksheets/users returns user list accessible to non-admin users | VERIFIED | line 10665: uses `Depends(get_current_user)` not `require_admin`; returns `id + email` only |
| 5 | SamplePriority, Worksheet, WorksheetItem tables exist in database | VERIFIED | models.py lines 550-606: all three classes defined with correct `__tablename__` values |
| 6 | Inbox page shows a table of all SENAITE received samples with auto-refresh | VERIFIED | WorksheetsInboxPage.tsx: `useInboxSamples()` with `refetchInterval: 30_000`, routed at `activeSubSection === 'inbox'` in MainWindowContent.tsx |
| 7 | Expanding a sample row reveals analyses grouped by service group with color badges | VERIFIED | InboxSampleTable.tsx lines 63-115: `ExpandedAnalyses` component maps `analyses_by_group`, uses `SERVICE_GROUP_COLORS` for badge styling |
| 8 | User can set sample priority inline with color-coded badge display | VERIFIED | InboxSampleTable.tsx lines 232-259: inline Select with PriorityBadge; WorksheetsInboxPage wires to `usePriorityMutation` with optimistic update |
| 9 | User can assign a tech (analyst) to a sample inline via dropdown | FAILED | Inline assignment calls `bulkUpdateMutation` → `PUT /worksheets/inbox/bulk` → creates `__inbox_staging__` with `status='open'` → sample disappears from inbox on next 30s poll (exclusion filter hits it) |
| 10 | User can assign an instrument to a sample inline via dropdown | FAILED | Same root cause as truth 9 |
| 11 | Selecting samples shows floating bulk toolbar with bulk actions | VERIFIED | WorksheetsInboxPage.tsx line 174: `{selectedUids.size > 0 && <InboxBulkToolbar ...>}` |
| 12 | Create Worksheet validates sample state (409 stale guard) and removes stale UIDs from selection on failure | VERIFIED | backend stale guard at lines 10787-10822; frontend 409 handler in WorksheetsInboxPage.tsx lines 207-214 removes stale UIDs from Set |
| 13 | AgingTimer shows live age with SLA color thresholds (green/yellow/orange/red) | VERIFIED | AgingTimer.tsx: `getAgeColor` function with 4 thresholds: <12h green, 12-20h yellow, 20-24h orange, >=24h red+animate-pulse |

**Score:** 9/11 truths verified (2 failed — share one root cause)

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `backend/models.py` | SamplePriority, Worksheet, WorksheetItem SQLAlchemy models | VERIFIED | All 3 classes at lines 550-606, correct tablenames and FK relationships |
| `backend/main.py` | 5 inbox endpoints + Pydantic schemas | VERIFIED | GET /worksheets/inbox, PUT /worksheets/inbox/{uid}/priority, GET /worksheets/users, PUT /worksheets/inbox/bulk, POST /worksheets all registered. 7 Pydantic schemas at lines 10385-10435 |
| `src/lib/api.ts` | InboxSampleItem type + 5 API functions | VERIFIED | Types at lines 3607-3640, functions at 3658-3714 including 409 staleUids handler |
| `src/hooks/use-inbox-samples.ts` | TanStack Query hook with 30s polling + 4 mutations | VERIFIED | `refetchInterval: 30_000`, `staleTime: 0`, exports useInboxSamples, usePriorityMutation, useBulkUpdateMutation, useCreateWorksheetMutation |
| `src/components/hplc/PriorityBadge.tsx` | Reusable priority badge with 3 levels | VERIFIED | 3 color variants, `animate-pulse` on expedited, dark mode variants |
| `src/components/hplc/AgingTimer.tsx` | Live aging timer with SLA color coding | VERIFIED | 4-tier color thresholds, 60s setInterval, `animate-pulse` on red, `font-mono tabular-nums` |
| `src/components/hplc/InboxSampleTable.tsx` | Table with 8 columns, expandable rows, inline editing | VERIFIED | All 8 columns (expand+checkbox+sampleId+client+priority+tech+instrument+age+status), local `expandedUids` state, SERVICE_GROUP_COLORS in expanded rows |
| `src/components/hplc/WorksheetsInboxPage.tsx` | Full inbox page replacing placeholder | VERIFIED | Loading/error/empty states, useInboxSamples wired, bulk toolbar slot present and wired |
| `src/components/hplc/InboxBulkToolbar.tsx` | Floating bulk action toolbar | VERIFIED | `fixed bottom-6 left-1/2 -translate-x-1/2 z-50`, Set Priority / Assign Tech / Set Instrument / Create Worksheet / Clear |
| `src/components/hplc/CreateWorksheetDialog.tsx` | Worksheet creation dialog | VERIFIED | `generateWorksheetTitle()` produces WS-YYYY-MM-DD-001, editable title input, optional notes textarea, isPending loading state |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| backend/main.py | backend/models.py | SamplePriority, Worksheet, WorksheetItem imports | WIRED | line 38: all 3 models in import statement |
| backend/main.py | SENAITE API | httpx AnalysisRequest query with `review_state=sample_received` | WIRED | lines 10451-10474 |
| src/hooks/use-inbox-samples.ts | src/lib/api.ts | imports getInboxSamples, updateInboxPriority, bulkUpdateInbox, createWorksheet | WIRED | lines 2-9 |
| src/hooks/use-inbox-samples.ts | @tanstack/react-query | useQuery with refetchInterval: 30_000 | WIRED | lines 14-21 |
| src/components/hplc/WorksheetsInboxPage.tsx | src/hooks/use-inbox-samples.ts | useInboxSamples, usePriorityMutation, useBulkUpdateMutation, useCreateWorksheetMutation | WIRED | lines 9-13 |
| src/components/hplc/WorksheetsInboxPage.tsx | src/components/hplc/InboxBulkToolbar.tsx | rendered when selectedUids.size > 0 | WIRED | line 174 |
| src/components/hplc/WorksheetsInboxPage.tsx | src/components/hplc/CreateWorksheetDialog.tsx | open={worksheetDialogOpen}, 409 onError handler | WIRED | lines 194-220 |
| src/components/hplc/InboxSampleTable.tsx | src/components/hplc/PriorityBadge.tsx | PriorityBadge in priority column | WIRED | lines 19, 245-257 |
| src/components/hplc/InboxSampleTable.tsx | src/components/hplc/AgingTimer.tsx | AgingTimer in age column | WIRED | lines 20, 314 |
| src/components/hplc/InboxSampleTable.tsx | src/lib/service-group-colors.ts | SERVICE_GROUP_COLORS for group badges | WIRED | lines 23-25, 73-82 |
| src/components/hplc/InboxBulkToolbar.tsx | src/hooks/use-inbox-samples.ts | useBulkUpdateMutation (via WorksheetsInboxPage prop wiring) | WIRED | WorksheetsInboxPage lines 180-186 |
| src/components/hplc/CreateWorksheetDialog.tsx | src/hooks/use-inbox-samples.ts | useCreateWorksheetMutation with 409 stale guard (via WorksheetsInboxPage) | WIRED | WorksheetsInboxPage lines 199-219 |
| src/components/hplc/WorksheetsInboxPage.tsx | src/components/layout/MainWindowContent.tsx | imported and rendered at activeSubSection === 'inbox' | WIRED | MainWindowContent.tsx lines 10, 56 |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| WorksheetsInboxPage.tsx | `inboxData.items` | `useInboxSamples()` → `getInboxSamples()` → `GET /worksheets/inbox` → SENAITE AnalysisRequest API + local DB enrichment | Yes — SENAITE live query + priority/assignment joins | FLOWING |
| WorksheetsInboxPage.tsx | `users` | `useQuery(['worksheet-users'])` → `getWorksheetUsers()` → `GET /worksheets/users` → DB `SELECT id, email FROM users WHERE is_active` | Yes — live DB query | FLOWING |
| WorksheetsInboxPage.tsx | `instruments` | `useQuery(['instruments'])` → `getInstruments()` → existing instruments endpoint | Yes — existing endpoint, pre-phase-16 | FLOWING |
| InboxSampleTable.tsx | `analyses_by_group` | Passed from inbox response — populated by backend SENAITE analysis fetch with keyword-to-group mapping | Yes — real analysis data from SENAITE | FLOWING |
| AgingTimer.tsx | `dateReceived` | Passed as `sample.date_received` from inbox items | Yes — `getDateReceived` from SENAITE response | FLOWING |

**Note on staging worksheet data flow:** The `PUT /worksheets/inbox/bulk` path stores `assigned_analyst_id` and `instrument_uid` in `worksheet_items` (via `__inbox_staging__`). The `GET /worksheets/inbox` endpoint reads these back at Step 5 (lines 10521-10531) and includes them in `InboxSampleItem.assigned_analyst_id` / `instrument_uid`. The data DOES flow back to the frontend — the problem is the exclusion filter (Step 2) removes those samples from the response entirely before Step 5 runs. This is the bug.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `SamplePriority`, `Worksheet`, `WorksheetItem` importable from models | `python -c "from models import SamplePriority, Worksheet, WorksheetItem; print('OK')"` | Not run (requires backend env) | SKIP — needs running backend |
| TypeScript compiles without errors | `npx tsc --noEmit` | exit code 0, no output | PASS |
| Inbox types exported from api.ts | `grep "InboxSampleItem\|InboxResponse\|InboxPriority" src/lib/api.ts` | Found at lines 3607, 3624, 3639 | PASS |
| 30-second polling configured | `grep "refetchInterval.*30" src/hooks/use-inbox-samples.ts` | Found at line 18: `refetchInterval: 30_000` | PASS |
| Stale guard returns 409 | `grep "status_code=409\|stale_uids" backend/main.py` | Found at lines 10815-10822 | PASS |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| INBX-01 | 16-01, 16-03 | User can view all received samples from SENAITE in a queue/inbox table | SATISFIED | GET /worksheets/inbox + WorksheetsInboxPage + InboxSampleTable |
| INBX-02 | 16-01, 16-03 | Each sample row expands to show analyses grouped by service group with color badges | SATISFIED | ExpandedAnalyses in InboxSampleTable.tsx uses analyses_by_group from backend |
| INBX-03 | 16-01, 16-02, 16-03 | User can set sample priority with color-coded badge display | SATISFIED | PUT /worksheets/inbox/{uid}/priority + usePriorityMutation (optimistic) + PriorityBadge |
| INBX-04 | 16-01, 16-03 | User can assign a tech (analyst) to a sample inline via dropdown | BLOCKED | Staging worksheet (status='open') causes sample exclusion from inbox on next poll after assignment |
| INBX-05 | 16-01, 16-03 | User can assign an instrument to a sample inline via dropdown | BLOCKED | Same root cause as INBX-04 |
| INBX-06 | 16-02, 16-03 | Inbox shows aging timer per sample with SLA color coding | SATISFIED | AgingTimer.tsx: green <12h, yellow 12-20h, orange 20-24h, red+pulse >=24h |
| INBX-07 | 16-04 | User can select multiple samples via checkboxes and apply bulk actions | SATISFIED | InboxBulkToolbar.tsx with 3 bulk actions; InboxSampleTable checkbox selection |
| INBX-08 | 16-04 | User can create a worksheet from selected inbox items | SATISFIED | POST /worksheets endpoint + CreateWorksheetDialog + WorksheetsInboxPage wiring |
| INBX-09 | 16-02, 16-03 | Inbox auto-refreshes via 30-second polling with TanStack Query | SATISFIED | `refetchInterval: 30_000` in useInboxSamples |
| INBX-10 | 16-01, 16-04 | Worksheet creation validates each sample is still in sample_received state | SATISFIED | POST /worksheets stale guard: SENAITE verification loop, HTTP 409 with stale_uids, frontend removes stale UIDs from selection |
| INBX-11 | 16-01, 16-02 | Priority data persists locally in sample_priorities table | SATISFIED | SamplePriority model + upsert in PUT /worksheets/inbox/{uid}/priority |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| backend/main.py | 10741 | `__inbox_staging__` worksheet created with `status="open"` — conflicts with open-worksheet exclusion filter | Blocker | Samples assigned a tech or instrument via inline or bulk dropdown disappear from the inbox on the next 30-second poll (INBX-04, INBX-05 broken) |
| backend/main.py | 10714 | Comment says `status='pre_assigned'` but code uses `status="open"` — comment and implementation disagree | Warning | Misleading; indicates the intended status was not applied |

---

### Human Verification Required

#### 1. End-to-end inbox workflow

**Test:** Start backend (`cd backend && python main.py`), start frontend dev server, navigate to HPLC Automation > Inbox in the sidebar. Walk through: (a) table loads or shows empty state, (b) row expansion shows service-group-grouped analyses with color badges, (c) inline priority change shows optimistic badge update, (d) checkbox selection shows floating bulk toolbar, (e) Create Worksheet dialog opens with auto-generated WS-YYYY-MM-DD-001 title, (f) creating worksheet removes samples from inbox and shows toast.
**Expected:** All steps work end-to-end. Items disappear from inbox only after worksheet creation — NOT after tech/instrument assignment.
**Why human:** Requires live SENAITE connection, running backend, and browser to verify real-time data flow, network polling (visible in DevTools Network tab), and UI behavior.

---

### Gaps Summary

Two requirements are blocked by a single root-cause bug in `backend/main.py`.

**Root cause:** The `PUT /worksheets/inbox/bulk` endpoint stores analyst and instrument pre-assignments in `worksheet_items` by creating a sentinel `Worksheet` record named `__inbox_staging__`. This worksheet is created with `status="open"`. The `GET /worksheets/inbox` exclusion filter (Step 2, lines 10479-10486) queries all `worksheet_items` in worksheets where `status='open'` and removes those sample UIDs from the inbox response. This means the moment a user assigns a tech or instrument to a sample — inline (single-sample) or via the bulk toolbar — that sample is added to the staging worksheet and silently disappears from the inbox on the next 30-second poll.

The comment at line 10714 says the intent was `status='pre_assigned'`, which confirms this is a coding error, not a design decision.

**Fix required:** Change the `__inbox_staging__` worksheet status to a value other than `'open'` (the comment suggests `'pre_assigned'`), and update the assignment-loading query in the inbox endpoint (lines 10521-10530) to also look for that staging status when reading pre-assignments.

Both INBX-04 and INBX-05 are unblocked by this single change.

---

_Verified: 2026-03-31_
_Verifier: Claude (gsd-verifier)_
