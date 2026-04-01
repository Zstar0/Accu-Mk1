---
phase: 15-foundation
verified: 2026-03-31T00:00:00Z
status: gaps_found
score: 8/9 must-haves verified
gaps:
  - truth: "An analyst can be assigned to a SENAITE analysis via API"
    status: partial
    reason: "SENAITE's Analyst field is read-only; the push endpoint (POST /senaite/analyses/{uid}/analyst) was built then removed after live testing confirmed rejection. ANLY-02 as written ('pushes Analyst field to SENAITE via API') is not satisfied. Assignment is deferred to Phase 16 local worksheet_items table. REQUIREMENTS.md marks it checked but the literal requirement cannot be met. No blocker to Phase 16 — the decision is correct and documented."
    artifacts:
      - path: "backend/main.py"
        issue: "set_analysis_analyst endpoint was removed; no SENAITE analyst write path exists"
      - path: "src/lib/api.ts"
        issue: "setAnalysisAnalyst() function was removed"
    missing:
      - "Update ANLY-02 requirement text to reflect actual scope: 'User can assign an analyst to an analysis via local AccuMark assignment (Phase 16)' — or accept deferral as explicit design decision"
human_verification:
  - test: "Service Groups admin UI end-to-end"
    expected: "Table shows groups with color swatches and member counts; slide-out opens for create/edit; color picker selects colors; checkbox membership editor pre-populates current members via getServiceGroupMembers; Save Members updates member count in table; CRUD operations succeed with toast feedback"
    why_human: "skip_checkpoints:true was active during Plan 03 — Task 2 human-verify checkpoint was auto-approved. UI correctness, slide-out animation, and membership persistence need runtime confirmation"
  - test: "Sidebar navigation items render and route correctly"
    expected: "Inbox and Worksheets appear under HPLC Automation; Service Groups appears under LIMS for admin users only (hidden for non-admin); clicking each item renders the correct page"
    why_human: "adminOnly gating on sidebar items requires runtime login with different roles to verify"
---

# Phase 15: Foundation Verification Report

**Phase Goal:** Admins can define service groups that classify analysis services by discipline, users can view and assign SENAITE analysts, and the Worksheets section is accessible in the sidebar under HPLC Automation.
**Verified:** 2026-03-31
**Status:** gaps_found
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Service groups can be created, read, updated, and deleted via API | VERIFIED | `get_service_groups`, `create_service_group`, `update_service_group`, `delete_service_group` all present in main.py (lines 10166–10271); DB queries via `select(ServiceGroup)` with joinedload |
| 2 | Analysis services can be assigned to service groups via membership endpoint | VERIFIED | `set_service_group_members` at line 10296; replaces full membership set via `group.analysis_services = list(services)` |
| 3 | Current member IDs of a service group can be fetched via GET endpoint | VERIFIED | `get_service_group_members` at line 10275; queries `service_group_members` table directly, returns `list[int]` |
| 4 | SENAITE lab contacts (analysts) can be fetched from the application | VERIFIED | `GET /senaite/analysts` at line 10322; proxies SENAITE LabContact API, returns uid/username/fullname |
| 5 | An analyst can be assigned to a SENAITE analysis via API | FAILED | Endpoint was built then removed after live testing — SENAITE's Analyst field is read-only. Assignment deferred to Phase 16 local table |
| 6 | Worksheets section appears in sidebar under HPLC Automation | VERIFIED | AppSidebar.tsx line 95-96: `{ id: 'inbox', label: 'Inbox' }` and `{ id: 'worksheets', label: 'Worksheets' }` added to hplc-analysis subItems |
| 7 | Service Groups sub-item appears under LIMS for admin users | VERIFIED | AppSidebar.tsx line 83: `{ id: 'service-groups', label: 'Service Groups', adminOnly: true }` in LIMS section; filtered at line 181 by `isAdmin` |
| 8 | Hash navigation routes correctly to inbox, worksheets, and worksheet-detail sub-sections | VERIFIED | ui-store.ts HPLCAnalysisSubSection includes 'inbox', 'worksheets', 'worksheet-detail'; WorksheetSubSection type exported; generic `navigateTo(section, subSection)` in AppSidebar handles routing |
| 9 | Clicking Inbox or Worksheets in sidebar renders the correct placeholder page | VERIFIED | MainWindowContent.tsx lines 56-57: `if (activeSubSection === 'inbox') return <WorksheetsInboxPage />` and `if (activeSubSection === 'worksheets') return <WorksheetsListPage />`; both files exist and export default functions |

**Score:** 8/9 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `backend/models.py` | ServiceGroup model + service_group_members M2M table | VERIFIED | `class ServiceGroup(Base)` at line 164; `service_group_members = Table(` at line 188; UniqueConstraint `uq_service_group_member` present; all fields (color, sort_order, description) confirmed |
| `backend/main.py` | CRUD + membership + SENAITE analyst proxy endpoints | VERIFIED (partial) | 6 of 8 planned endpoints exist; `set_analysis_analyst` and `test_analyst_format` removed post-verification (correct decision); `get_senaite_analysts` updated with uid field |
| `src/lib/api.ts` | TypeScript types and fetch functions | VERIFIED (partial) | `ServiceGroup`, `SenaiteAnalyst` interfaces exist (lines 3502–3531); SenaiteAnalyst includes uid field; 7 of 8 API functions present; `setAnalysisAnalyst` correctly removed |
| `src/store/ui-store.ts` | WorksheetSubSection type + extended unions | VERIFIED | `WorksheetSubSection = 'inbox' \| 'worksheets' \| 'worksheet-detail'` at line 12; LIMSSubSection includes 'service-groups' (line 10); HPLCAnalysisSubSection includes all three worksheet values (line 11); ActiveSubSection union updated (line 15) |
| `src/components/layout/AppSidebar.tsx` | New sidebar nav items | VERIFIED | service-groups (adminOnly), inbox, worksheets all present; generic navigateTo call wires click to store |
| `src/components/layout/MainWindowContent.tsx` | Render cases for new sub-sections | VERIFIED | Imports ServiceGroupsPage, WorksheetsInboxPage, WorksheetsListPage; render cases for all three sub-sections present |
| `src/components/hplc/WorksheetsInboxPage.tsx` | Placeholder inbox page | VERIFIED (intentional stub) | Exists; exports `WorksheetsInboxPage`; intentional placeholder for Phase 16 |
| `src/components/hplc/WorksheetsListPage.tsx` | Placeholder worksheets list | VERIFIED (intentional stub) | Exists; exports `WorksheetsListPage`; intentional placeholder for Phase 18 |
| `src/components/hplc/ServiceGroupsPage.tsx` | Full service groups admin page | VERIFIED | 553 lines (exceeds 200-line minimum); all 6 API calls present; SERVICE_GROUP_COLORS imported; Checkbox imported; toast imported; no forbidden `useUIStore()` destructuring |
| `src/lib/service-group-colors.ts` | Shared color map constant | VERIFIED | `SERVICE_GROUP_COLORS` with 8 colors; `ServiceGroupColor` type; `COLOR_OPTIONS` array — all exported |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `backend/main.py` | `backend/models.py` | `select(ServiceGroup)` | WIRED | Line 10173: `select(ServiceGroup).options(joinedload(...))` confirmed |
| `src/lib/api.ts` | `backend/main.py` | fetch to /service-groups | WIRED | Lines 3533-3590: fetch calls to `${API_BASE_URL()}/service-groups` and `/senaite/analysts` |
| `AppSidebar.tsx` | `ui-store.ts` | `navigateTo(section, subSection)` | WIRED | Line 145: `navigateTo = useUIStore(state => state.navigateTo)`; called at line 222 generically for all sub-items including inbox/worksheets/service-groups |
| `MainWindowContent.tsx` | `WorksheetsInboxPage.tsx` | conditional render on activeSubSection | WIRED | Line 56: `if (activeSubSection === 'inbox') return <WorksheetsInboxPage />` |
| `ServiceGroupsPage.tsx` | `src/lib/api.ts` | CRUD + membership API calls | WIRED | Lines 34-39: all 6 functions imported; called within handlers at lines 88, 128, 163-166, 181, 205 |
| `ServiceGroupsPage.tsx` | `service-group-colors.ts` | import of color map | WIRED | Line 29: `SERVICE_GROUP_COLORS` imported; used at lines 317-318 and 434 |

---

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `ServiceGroupsPage.tsx` | `groups` state | `getServiceGroups()` → `GET /service-groups` → `select(ServiceGroup)` DB query | Yes — SQLAlchemy query on service_groups table with joinedload for member_count | FLOWING |
| `ServiceGroupsPage.tsx` | `selectedIds` (membership editor) | `getServiceGroupMembers(id)` → `GET /service-groups/{id}/members` → `select(service_group_members.c.analysis_service_id)` | Yes — direct association table query | FLOWING |
| `GET /service-groups` backend | `groups` list | `db.execute(select(ServiceGroup)...)` | Yes — live DB query | FLOWING |
| `GET /service-groups/{id}/members` backend | member IDs | `db.execute(select(service_group_members.c.analysis_service_id)...)` | Yes — live association table query | FLOWING |
| `GET /senaite/analysts` backend | analysts list | `httpx` proxy to SENAITE LabContact API | Yes — proxied from SENAITE at runtime | FLOWING (runtime) |

---

## Behavioral Spot-Checks

Step 7b: SKIPPED for frontend components (requires running app). Backend Python imports verified via commit evidence and grep.

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| backend/models.py ServiceGroup importable | `python -c "from models import ServiceGroup, service_group_members"` | Confirmed in 15-01-SUMMARY.md; commit `bf57062` | PASS (by commit evidence) |
| ServiceGroupsPage has no Zustand destructure | `grep "useUIStore()" ServiceGroupsPage.tsx` | No matches | PASS |
| ServiceGroupsPage min 200 lines | `wc -l ServiceGroupsPage.tsx` | 553 lines | PASS |
| api.ts ServiceGroup functions count | `grep -c "getServiceGroups|..."` | 7 functions present | PASS |
| WorksheetSubSection type exported | `grep "WorksheetSubSection" ui-store.ts` | Line 12 confirmed | PASS |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SGRP-01 | 15-01 | Admin can create, edit, and delete service groups | SATISFIED | 4 CRUD endpoints in main.py; all wired to DB; ServiceGroupsPage exercises all four |
| SGRP-02 | 15-01 | Admin can assign analysis services via checkbox membership editor | SATISFIED | `GET /service-groups/{id}/members` + `PUT /service-groups/{id}/members` + checkbox editor in ServiceGroupsPage.tsx |
| SGRP-03 | 15-03 | Service groups display with member count and color badge | SATISFIED | ServiceGroupsPage.tsx 553 lines; table shows color swatch via SERVICE_GROUP_COLORS and member_count badge |
| SGRP-04 | 15-01 | Data persists in service_groups + service_group_members tables | SATISFIED | Both tables defined in models.py; SQLAlchemy queries confirmed in main.py |
| ANLY-01 | 15-01 | User can view available SENAITE lab contacts | SATISFIED | `GET /senaite/analysts` endpoint at main.py line 10322; returns uid/username/fullname; `getSenaiteAnalysts()` in api.ts |
| ANLY-02 | 15-01 | User can assign analyst to SENAITE analysis via API push | PARTIAL | Endpoint built and removed — SENAITE Analyst field is read-only (confirmed by live testing in Plan 04). Assignment deferred to Phase 16 local table. Requirement text does not match implemented outcome. |
| ANLY-03 | 15-04 | Analyst field format verified (username vs UID) | SATISFIED | Live SENAITE testing in Plan 04 confirmed field is read-only. Format question answered: format is irrelevant since local assignment is used. Decision documented in 15-04-SUMMARY.md. |
| NAVG-01 | 15-02 | Worksheets section accessible under HPLC Automation | SATISFIED | AppSidebar.tsx lines 95-96; MainWindowContent.tsx lines 56-57; WorksheetsInboxPage and WorksheetsListPage render when navigated |
| NAVG-02 | 15-02 | Hash navigation supports worksheets sub-sections | SATISFIED | ui-store.ts HPLCAnalysisSubSection includes inbox/worksheets/worksheet-detail; WorksheetSubSection exported; hash navigation passes sub-sections dynamically |

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `WorksheetsInboxPage.tsx` | 1-8 | Placeholder component with no real content | Info | Intentional — Phase 16 will replace. Not a blocker. |
| `WorksheetsListPage.tsx` | 1-8 | Placeholder component with no real content | Info | Intentional — Phase 18 will replace. Not a blocker. |

No blocker anti-patterns found. Placeholder pages are correctly documented as intentional stubs with named successor phases.

---

## Human Verification Required

### 1. Service Groups Admin UI End-to-End

**Test:** Navigate to LIMS > Service Groups as an admin user. Create a group named "Core HPLC" with color "blue". Open the editor, scroll to the Members section, check 2-3 analysis services, and save. Reopen the editor and verify the same services are still checked.
**Expected:** Table shows group with blue swatch and correct member count. Member checkboxes pre-populate correctly on second open (confirms `getServiceGroupMembers` round-trip works). Toast notifications appear on save/delete.
**Why human:** Plan 03's Task 2 human-verify checkpoint was auto-approved via `skip_checkpoints:true`. Runtime UI behavior including slide-out animation, color picker selection, and membership persistence cannot be verified programmatically.

### 2. Sidebar Admin Role Gating

**Test:** Log in as a non-admin user and check the LIMS sidebar section. Then log in as an admin and check again.
**Expected:** "Service Groups" is absent for non-admin users; present for admin users.
**Why human:** `adminOnly` filtering at AppSidebar.tsx line 181 requires runtime authentication with two different roles to confirm.

---

## Gaps Summary

One gap blocks full requirement satisfaction:

**ANLY-02 (partial):** The requirement as written — "User can assign an analyst to a SENAITE analysis (pushes Analyst field to SENAITE via API)" — is not satisfied. The push endpoint was deliberately removed after live testing confirmed SENAITE returns "Not allowed to set the field 'Analyst'" for direct API updates. This is a design decision (not a bug), and the correct path forward is Phase 16 local assignment in `worksheet_items`. However, the requirement as written is now technically unachievable, and REQUIREMENTS.md marking it `[x]` overstates Phase 15's delivery.

**Recommended resolution (not blocking Phase 16):** Update ANLY-02 text to "Analyst assignment is implemented locally in AccuMark's worksheet_items table (Phase 16) — SENAITE Analyst field is read-only and cannot be written via API." This aligns the requirement with the discovered constraint and correct design decision.

Two items require human verification before Phase 15 can be marked fully complete: (1) Service Groups admin UI runtime behavior, and (2) admin role gating on sidebar items.

---

_Verified: 2026-03-31_
_Verifier: Claude (gsd-verifier)_
