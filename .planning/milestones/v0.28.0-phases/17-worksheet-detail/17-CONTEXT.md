# Phase 17: Worksheet Detail - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Users can open any worksheet to view and manage its contents — edit title/notes, see all items with full details, add more samples, remove items, reassign items between worksheets, and mark complete. The detail view is implemented as a **global floating clipboard drawer** accessible from any page, not a standalone page.

</domain>

<decisions>
## Implementation Decisions

### Floating Clipboard Architecture
- **D-01:** A floating action button (clipboard icon) is rendered in the bottom-right corner of the screen, visible on every page of the app. It lives at the app shell level (MainWindow or similar), outside any specific page component.
- **D-02:** Clicking the FAB opens a slide-out drawer (right side) showing the currently selected worksheet's detail view. The drawer overlays content without navigating away from the current page.
- **D-03:** The drawer uses the same worksheet data from `GET /worksheets` and `GET /worksheets/{id}` endpoints. It shows the full detail view: header, items, actions.
- **D-04:** The FAB shows a small badge with the number of items in the active worksheet (or the count of open worksheets if no specific one is selected).
- **D-05:** If multiple worksheets are open, the drawer shows a worksheet selector/tabs at the top to switch between them.

### Worksheet Detail Content (inside the drawer)
- **D-06:** Header section: editable title (inline edit), assigned tech dropdown, status badge, created date, item count, notes field (expandable textarea).
- **D-07:** Items list: same card format as the inbox sidebar — sample ID, service group badge, priority badge, age timer. Each item has a remove (X) button.
- **D-08:** "Add Samples" button opens a mini inbox modal — a simplified version of the inbox card list filtered to unassigned items only. User can drag or click to add items to the current worksheet.
- **D-09:** "Reassign" action per item — dropdown or modal to pick a different worksheet to move the item to.
- **D-10:** "Complete Worksheet" button in the header — transitions status to "completed". Completed worksheets are no longer shown in the inbox sidebar or the FAB badge. Requires confirmation dialog.

### Navigation Integration
- **D-11:** The existing `WorksheetsListPage` (Phase 18 placeholder) and the `worksheet-detail` hash nav route should open the drawer with the specified worksheet, not navigate to a separate page. This means clicking a worksheet from the sidebar or from the worksheets list page opens the drawer.
- **D-12:** The hash route `#hplc-analysis/worksheet-detail?id=X` sets the active worksheet in the drawer and opens it.

### What Already Exists (from Phase 16)
- **D-13:** The inbox sidebar already handles: rename, tech assign, remove items, delete worksheet. The drawer reuses these API endpoints but provides a richer UI with notes, status, add-samples, reassign, and complete actions.
- **D-14:** Backend endpoints already exist: `GET /worksheets`, `PUT /worksheets/{id}`, `DELETE /worksheets/{id}`, `DELETE /worksheets/{id}/items/{uid}/{gid}`, `POST /worksheets/{id}/add-group`. New endpoints needed: `POST /worksheets/{id}/complete`, `POST /worksheets/{id}/items/{uid}/{gid}/reassign`.

### Start Sample Prep from Worksheet
- **D-15:** Each item in the worksheet drawer has a "Start Prep" button that navigates to the New Analysis / Sample Prep page with pre-filled fields: sample ID (from SENAITE), peptide (from the service group's linked peptide via AnalysisService.peptide_id), and any other derivable fields (declared weight, method).
- **D-16:** The navigation uses the existing wizard flow (`hplc-analysis/new-analysis`) with query params or store state to pass the pre-fill data. The SENAITE lookup step can be auto-triggered since we already have the sample ID.
- **D-17:** Once a prep is started from a worksheet item, the item should show a "Prep started" indicator (not block further preps — a sample may need multiple preps for different service groups).

### Claude's Discretion
- Drawer width and animation
- FAB icon design and positioning details
- Whether the mini inbox modal reuses InboxServiceGroupCard or a simplified version
- Loading/empty states inside the drawer
- Whether completed worksheets are viewable (read-only) or hidden entirely

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing worksheet components (Phase 16)
- `src/components/hplc/WorksheetDropPanel.tsx` — Sidebar worksheet cards with rename, tech, delete, remove-item (pattern to extend)
- `src/components/hplc/InboxServiceGroupCard.tsx` — Draggable card format (reuse for mini inbox modal)
- `src/components/hplc/WorksheetsInboxPage.tsx` — DnD context, worksheet API wiring patterns

### API endpoints
- `src/lib/api.ts` — WorksheetListItem type, listWorksheets, updateWorksheet, deleteWorksheet, removeWorksheetItem, addGroupToWorksheet
- `backend/main.py` — All worksheet CRUD endpoints (~line 11030+)

### App shell
- `src/components/layout/MainWindow.tsx` — Where the FAB should be rendered
- `src/components/layout/MainWindowContent.tsx` — Page routing, worksheet-detail case
- `src/store/ui-store.ts` — UI state for drawer open/close, active worksheet ID

### Existing UI patterns
- `src/components/hplc/SamplePrepHplcFlyout.tsx` — Slide-out flyout/drawer pattern used elsewhere in the app
- `src/components/ui/sheet.tsx` — shadcn Sheet component (slide-out drawer primitive)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `WorksheetDropPanel` items display — reuse the item row format (sample ID, group badge, priority, age)
- `Sheet` component from shadcn/ui — use for the drawer overlay
- `PriorityBadge`, `AgingTimer` — already built and working
- `SERVICE_GROUP_COLORS` — for group badges in the drawer
- All worksheet API functions in api.ts

### Established Patterns
- Slide-out panels use the same backdrop + animation pattern (see AnalysisServicesPage, ServiceGroupsPage)
- shadcn `Sheet` would be cleaner than custom animation
- Global UI state in Zustand (ui-store.ts) for drawer visibility

### Integration Points
- `MainWindow.tsx` — render FAB here (always visible)
- `ui-store.ts` — add `worksheetDrawerOpen: boolean`, `activeWorksheetId: number | null`
- `hash-navigation.ts` — route `worksheet-detail` to open drawer instead of page

</code_context>

<specifics>
## Specific Ideas

- User described it as "a floating icon, probably in the bottom right of the screen that maybe looks like a clipboard"
- "Clicking this will open your current worksheet as an overlay"
- "This can work on any page of the site giving quick access to the worksheet items"
- The drawer should feel like a persistent tool the manager carries around, not a page navigation

</specifics>

<deferred>
## Deferred Ideas

- Worksheet printing/export — future milestone
- Worksheet templates — future milestone
- Auto-complete worksheet when all items are processed — future automation (WAUT-03)

</deferred>

---

*Phase: 17-worksheet-detail*
*Context gathered: 2026-04-01*
