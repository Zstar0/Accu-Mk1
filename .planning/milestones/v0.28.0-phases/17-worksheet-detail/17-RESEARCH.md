# Phase 17: Worksheet Detail - Research

**Researched:** 2026-04-01
**Domain:** React/Tauri UI — floating FAB + shadcn Sheet drawer, Zustand state, FastAPI endpoints
**Confidence:** HIGH

## Summary

Phase 17 delivers the "floating clipboard" paradigm: a FAB pinned to `MainWindow.tsx`'s layout that opens a shadcn `Sheet` (right-side slide-out) containing the full worksheet detail view. This is an overlay UI, not a page navigation. All required primitives already exist — `Sheet`, `PriorityBadge`, `AgingTimer`, `SERVICE_GROUP_COLORS`, `WorksheetDropPanel` item rows, and every existing worksheet API call. The primary work is (1) composing a new `WorksheetDrawer` component, (2) extending Zustand `ui-store.ts` with drawer state, (3) two new backend endpoints (`POST /worksheets/{id}/complete` and `POST /worksheets/{id}/items/{uid}/{gid}/reassign`), and (4) wiring the existing hash-navigation system to open the drawer on `worksheet-detail` routes.

The "Start Prep" feature (D-15 through D-17) adds a navigation call from a drawer item to `hplc-analysis/new-analysis` with pre-fill data stored in a small Zustand slice (or ui-store field). The wizard's Step1SampleInfo already handles SENAITE lookup — the pre-fill just seeds the sample ID and other derivable fields, then auto-triggers the lookup.

**Primary recommendation:** Build as three clean layers — (A) backend: 2 new endpoints, (B) api.ts: 2 new typed functions + extend WorksheetListItem to include notes, (C) UI: FAB + WorksheetDrawer component tree wired to ui-store drawer state.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Floating Clipboard Architecture**
- D-01: FAB (clipboard icon) rendered in bottom-right corner, visible on every page. Lives at app shell level (MainWindow or similar), outside any specific page component.
- D-02: Clicking FAB opens a right-side slide-out drawer showing the currently selected worksheet's detail. Overlays content without navigating away.
- D-03: Drawer uses same worksheet data from `GET /worksheets` and `GET /worksheets/{id}`. Shows full detail: header, items, actions.
- D-04: FAB shows badge with item count of active worksheet (or count of open worksheets if none selected).
- D-05: Multiple open worksheets — drawer shows worksheet selector/tabs at top.

**Worksheet Detail Content**
- D-06: Header: editable title (inline edit), assigned tech dropdown, status badge, created date, item count, notes field (expandable textarea).
- D-07: Items list: same card format as inbox sidebar — sample ID, service group badge, priority badge, age timer. Each item has a remove (X) button.
- D-08: "Add Samples" button opens mini inbox modal — simplified inbox card list filtered to unassigned items. User can drag or click to add.
- D-09: "Reassign" action per item — dropdown or modal to pick a different worksheet.
- D-10: "Complete Worksheet" button in header — transitions status to "completed". Requires confirmation dialog. Completed worksheets no longer shown in inbox sidebar or FAB badge.

**Navigation Integration**
- D-11: WorksheetsListPage and `worksheet-detail` hash nav should open the drawer with the specified worksheet, not navigate to a separate page.
- D-12: Hash route `#hplc-analysis/worksheet-detail?id=X` sets the active worksheet in the drawer and opens it.

**What Already Exists (Phase 16)**
- D-13: Sidebar handles rename, tech assign, remove items, delete worksheet. Drawer reuses these endpoints + adds notes, status, add-samples, reassign, complete.
- D-14: Existing endpoints: `GET /worksheets`, `PUT /worksheets/{id}`, `DELETE /worksheets/{id}`, `DELETE /worksheets/{id}/items/{uid}/{gid}`, `POST /worksheets/{id}/add-group`. New: `POST /worksheets/{id}/complete`, `POST /worksheets/{id}/items/{uid}/{gid}/reassign`.

**Start Sample Prep from Worksheet**
- D-15: Each item has "Start Prep" button → navigates to `hplc-analysis/new-analysis` with pre-filled fields (sample ID, peptide, declared weight, method).
- D-16: Navigation uses existing wizard flow with query params or store state to pass pre-fill data. SENAITE lookup auto-triggered.
- D-17: Once prep is started, item shows "Prep started" indicator. Does not block further preps — multiple preps allowed per sample/service group combo.

### Claude's Discretion

- Drawer width and animation
- FAB icon design and positioning details
- Whether the mini inbox modal reuses InboxServiceGroupCard or a simplified version
- Loading/empty states inside the drawer
- Whether completed worksheets are viewable (read-only) or hidden entirely

### Deferred Ideas (OUT OF SCOPE)

- Worksheet printing/export — future milestone
- Worksheet templates — future milestone
- Auto-complete worksheet when all items are processed — future automation (WAUT-03)

</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WSHT-01 | User can view worksheet detail with header (title, analyst, status, created date, item count) | `WorksheetListItem` already has all fields; `GET /worksheets` returns them; `Worksheet` model has `notes`, `status`, `created_at`, `assigned_analyst_id` |
| WSHT-02 | User can edit worksheet title and notes | `PUT /worksheets/{id}` exists (title + analyst); needs `notes` field added; inline edit pattern proven in `WorksheetDropZone` |
| WSHT-03 | Worksheet items table shows sample ID, analysis, service group, priority, tech, instrument, status | `WorksheetListItem.items` has all fields; `instrument_uid` and `assigned_analyst_id` are on `WorksheetItem` model but currently not exposed in list response — needs minor backend extension |
| WSHT-04 | User can add samples to existing worksheet | `POST /worksheets/{id}/add-group` already works; mini inbox modal needs new component using existing `getInboxSamples()` |
| WSHT-05 | User can remove items from worksheet | `DELETE /worksheets/{id}/items/{uid}/{gid}` exists; reuse `removeWorksheetItem()` from api.ts |
| WSHT-06 | User can reassign items to a different worksheet | New endpoint needed: `POST /worksheets/{id}/items/{uid}/{gid}/reassign`; new api.ts function |
| WSHT-07 | User can mark worksheet as completed | New endpoint needed: `POST /worksheets/{id}/complete`; new api.ts function; confirmation dialog pattern already in `AlertDialog` |
| WSHT-08 | Worksheet data persists locally | Already true — SQLite via `worksheets` + `worksheet_items` tables; `notes` column already on `Worksheet` model |

</phase_requirements>

---

## Project Constraints (from CLAUDE.md)

- **npm only** — no pnpm
- **No manual memoization** — React Compiler handles it; no `useMemo`/`useCallback`
- **Zustand selector syntax** — `useUIStore(state => state.X)`, never destructure
- **Zustand callbacks** — use `useStore.getState()` inside event handlers
- **TanStack Query** — all persistent server data through Query; invalidate on mutation
- **shadcn/ui v4, Tailwind v4, React 19, Zustand v5**
- **Tauri v2** — use tauri-specta typed commands for Tauri-level operations (not needed here)
- **Type-safe API** — all calls through functions in `src/lib/api.ts`; no raw `invoke`
- **Zustand devtools** — existing store uses devtools middleware; new state goes in same store
- **CSS logical properties** for RTL compatibility
- **No unsolicited commits**
- **frontend-design skill** — production-grade, intentional aesthetic. Drawer UI should feel like an industrial utility tool (fits lab context), not generic

---

## Standard Stack

### Core (all already installed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@radix-ui/react-dialog` | bundled via shadcn | Sheet/drawer primitive | Already used by `Sheet` component — no new install |
| `zustand` | v5 | Drawer open/close state, active worksheet ID | Project standard for global UI state |
| `@tanstack/react-query` | v5 | Worksheet data fetching + cache invalidation | Project standard for persistent server data |
| `sonner` | current | Toast notifications for mutations | Project standard |
| `lucide-react` | current | Icons (Clipboard, CheckCircle, X, etc.) | Project standard |

### No new installs required

All Phase 17 UI is built from existing shadcn components and project libraries. No new `npm install` commands needed.

---

## Architecture Patterns

### Recommended Structure — New Files

```
src/
├── components/
│   └── hplc/
│       ├── WorksheetDrawer.tsx          # FAB + Sheet + drawer content (main component)
│       ├── WorksheetDrawerHeader.tsx    # Editable header section
│       ├── WorksheetDrawerItems.tsx     # Items list with remove/reassign/start-prep
│       └── AddSamplesModal.tsx          # Mini inbox modal (Dialog, not Sheet)
├── hooks/
│   └── use-worksheet-drawer.ts         # TanStack Query + mutation hooks for drawer
```

Existing files to modify:
- `src/store/ui-store.ts` — add drawer state
- `src/lib/api.ts` — add `completeWorksheet`, `reassignWorksheetItem`; extend types
- `src/components/layout/MainWindow.tsx` — render `<WorksheetDrawer />`
- `src/lib/hash-navigation.ts` — handle `worksheet-detail?id=X` → open drawer
- `backend/main.py` — two new endpoints
- `backend/main.py` — extend `WorksheetUpdate` to include `notes`; extend list response to include `instrument_uid` and `assigned_analyst_id` per item

### Pattern 1: Global Overlay at App Shell

FAB and Sheet render inside `MainWindow.tsx` alongside `CommandPalette` and `PreferencesDialog` — not inside any page component. This ensures it's always available.

```tsx
// Source: existing MainWindow.tsx pattern (CommandPalette, PreferencesDialog)
{/* Global UI Components */}
<CommandPalette />
<PreferencesDialog />
<WorksheetDrawer />   {/* NEW — renders FAB + Sheet */}
<Toaster ... />
```

The Sheet is controlled by Zustand state — no local `useState` in MainWindow.

### Pattern 2: Zustand Drawer State

Add to `ui-store.ts` following the existing pattern (devtools action names required):

```typescript
// New fields
worksheetDrawerOpen: boolean
activeWorksheetId: number | null

// New actions
openWorksheetDrawer: (worksheetId?: number) => void
closeWorksheetDrawer: () => void
setActiveWorksheetId: (id: number | null) => void
```

Selector usage (project rule — never destructure):
```typescript
const drawerOpen = useUIStore(state => state.worksheetDrawerOpen)
const activeId = useUIStore(state => state.activeWorksheetId)
```

Callbacks use `getState()`:
```typescript
const handleOpen = () => {
  useUIStore.getState().openWorksheetDrawer(worksheetId)
}
```

### Pattern 3: Sheet Width Override

Default `SheetContent` uses `sm:max-w-sm` which is too narrow. Override via className:

```tsx
<SheetContent
  side="right"
  className="w-[480px] sm:max-w-[480px]"
>
```

This is Claude's discretion territory (D: drawer width). 480px gives enough room for the items table.

### Pattern 4: TanStack Query for Drawer Data

```typescript
// Source: established project pattern (use-inbox-samples.ts)
const { data: worksheets, isLoading } = useQuery({
  queryKey: ['worksheets'],
  queryFn: () => listWorksheets(),
  staleTime: 0,
  refetchInterval: 30_000,
})
```

The drawer consumes the same `['worksheets']` query key used by `WorksheetDropPanel`. Mutations invalidate `['worksheets']` so both the sidebar and drawer stay in sync.

### Pattern 5: Hash Navigation for `worksheet-detail`

Extend `hash-navigation.ts` to handle `worksheet-detail?id=X`:

```typescript
// In applyNavToStore:
} else if (subSection === 'worksheet-detail' && targetId) {
  store.openWorksheetDrawer(Number(targetId))
} else {
  store.navigateTo(section, subSection)
}

// In buildHash — no hash change needed when drawer opens
// (drawer is overlay, doesn't change page context)
```

Decision D-11 says clicking a worksheet from `WorksheetsListPage` should open the drawer. That page (Phase 18) can call `openWorksheetDrawer(id)` directly — no page navigation needed.

### Pattern 6: Notes Field on PUT /worksheets/{id}

The `Worksheet` model already has `notes: Mapped[Optional[str]]`. The `WorksheetUpdate` Pydantic model currently only accepts `title` and `assigned_analyst`. Add `notes: Optional[str] = None` to `WorksheetUpdate` and handle it in the PUT handler. No migration needed.

### Pattern 7: Complete Endpoint

```python
@app.post("/worksheets/{worksheet_id}/complete")
async def complete_worksheet(
    worksheet_id: int,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    ws = db.execute(select(Worksheet).where(Worksheet.id == worksheet_id)).scalar_one_or_none()
    if not ws:
        raise HTTPException(404, "Worksheet not found")
    if ws.status != "open":
        raise HTTPException(400, f"Worksheet is already {ws.status}")
    ws.status = "completed"
    db.commit()
    return {"status": "completed"}
```

### Pattern 8: Reassign Endpoint

```python
@app.post("/worksheets/{worksheet_id}/items/{sample_uid}/{service_group_id}/reassign")
async def reassign_worksheet_item(
    worksheet_id: int,
    sample_uid: str,
    service_group_id: int,
    data: ReassignRequest,  # { target_worksheet_id: int }
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    item = db.execute(
        select(WorksheetItem).where(
            WorksheetItem.worksheet_id == worksheet_id,
            WorksheetItem.sample_uid == sample_uid,
            WorksheetItem.service_group_id == service_group_id,
        )
    ).scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Item not found")
    target = db.execute(
        select(Worksheet).where(Worksheet.id == data.target_worksheet_id, Worksheet.status == "open")
    ).scalar_one_or_none()
    if not target:
        raise HTTPException(404, "Target worksheet not found or not open")
    item.worksheet_id = data.target_worksheet_id
    db.commit()
    return {"status": "reassigned"}
```

### Pattern 9: Start Prep Navigation (D-15/D-16)

The wizard's `wizard-store.ts` has a `resetWizard()` function and session state. Pre-fill requires a small new Zustand field (or ui-store field):

```typescript
// Add to ui-store.ts
worksheetPrepPrefill: {
  sampleId: string
  peptideId: number | null
  method: string | null
} | null

startPrepFromWorksheet: (prefill: { sampleId: string; peptideId: number | null; method: string | null }) => void
```

Then in `startPrepFromWorksheet`:
1. Set `worksheetPrepPrefill`
2. Call `navigateTo('hplc-analysis', 'new-analysis')`
3. Close the drawer (`closeWorksheetDrawer()`)

`Step1SampleInfo` reads `worksheetPrepPrefill` from ui-store on mount and seeds local form state. After seeding, clears the prefill field.

### Anti-Patterns to Avoid

- **Destructuring Zustand store** — `const { drawerOpen } = useUIStore()` is caught by ast-grep and causes render cascades. Always use selector syntax.
- **Local useState for drawer open** — drawer open/close must live in Zustand (needed by hash-navigation and WorksheetsListPage to open it programmatically).
- **Putting Sheet inside a page component** — drawer must survive page navigation; it belongs at MainWindow level.
- **Fetching worksheet data only inside the drawer** — use the shared `['worksheets']` TanStack Query key so sidebar and drawer are always in sync.
- **Inline `fetch()` calls** — all API calls go through typed functions in `api.ts`.
- **Using `window.location.hash =`** — hash-navigation uses `history.pushState` to avoid feedback loops. Follow the same pattern.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Slide-out drawer | Custom CSS animation + portal | `Sheet` from `src/components/ui/sheet.tsx` | Radix Dialog handles focus trap, ARIA, backdrop, keyboard dismiss |
| Confirmation dialog | Custom modal | `AlertDialog` from shadcn | Already used in `WorksheetDropZone` for delete confirm |
| Toast notifications | Custom toast | `toast()` from sonner | Project standard, already wired |
| Loading skeleton | Spinner component | `animate-pulse` divs | Used throughout Phase 16 components |
| Color badges | Inline style | `SERVICE_GROUP_COLORS[colorKey]` from `service-group-colors.ts` | Shared module, consistent with inbox cards |
| Item row format | New card component | Reuse the `WorksheetDropZone` item row pattern (lines 172-195 in WorksheetDropPanel.tsx) | Same data, same visual language |

---

## Runtime State Inventory

> This is a feature-addition phase (new component, new endpoints). No rename/refactor/migration involved.

None — verified: no stored data, service configs, OS registrations, secrets, or build artifacts need updating for this phase.

---

## Common Pitfalls

### Pitfall 1: Sheet z-index conflict with Toaster

**What goes wrong:** The Toaster (`position="bottom-right"`) and FAB both live in the bottom-right. If the Sheet overlay z-index is less than the Toaster, toasts appear behind the drawer. If the FAB is positioned with `z-index` lower than the Sheet overlay, it's inaccessible when drawer is open.

**Why it happens:** shadcn Sheet uses `z-50`. Sonner Toaster default z-index is also high.

**How to avoid:** FAB should be `z-40` (visible over page content, under the Sheet overlay). When drawer is open, FAB can be hidden or replaced by a close button inside the Sheet. The existing Toaster's z-index is already handled by shadcn — just don't add custom z-index to FAB that conflicts.

**Warning signs:** FAB visible through the drawer backdrop; toasts appearing behind the drawer.

### Pitfall 2: WorksheetUpdate notes field not exposed

**What goes wrong:** The `Worksheet` model has `notes` but `WorksheetUpdate` Pydantic model (main.py line 11094) only has `title` and `assigned_analyst`. The frontend will silently fail to save notes if this field is not added.

**How to avoid:** Add `notes: Optional[str] = None` to `WorksheetUpdate` and handle it in the PUT endpoint handler before this phase ships. Also add `notes` to the `WorksheetListItem` TypeScript interface in api.ts.

### Pitfall 3: Items list missing instrument_uid and assigned_analyst_email

**What goes wrong:** The `/worksheets` list response (main.py lines 11079-11087) includes `sample_id`, `sample_uid`, `service_group_id`, `group_name`, `priority`, `added_at` — but NOT `instrument_uid`, `assigned_analyst_id`, or `assigned_analyst_email` per item. WSHT-03 requires showing tech and instrument in the items table.

**How to avoid:** Extend the list response's item serialization to include `instrument_uid`, `assigned_analyst_id`, `assigned_analyst_email` (resolve email from user table as is done for the worksheet-level analyst). Extend `WorksheetListItem.items` TypeScript type to match.

### Pitfall 4: Hash navigation feedback loop on drawer open

**What goes wrong:** If opening the drawer updates `activeSubSection` to `'worksheet-detail'` in the store, `hash-navigation.ts`'s subscription will push a new hash state. Then on back-navigation the page might attempt to re-render a "worksheet-detail" page that doesn't exist.

**How to avoid:** Drawer open state should NOT change `activeSection`/`activeSubSection`. Use separate Zustand fields (`worksheetDrawerOpen`, `activeWorksheetId`). The hash-navigation should only react to `worksheet-detail` on initial parse (restore) — clicking the FAB does not produce a hash change. Only direct URL entry (`#hplc-analysis/worksheet-detail?id=5`) opens the drawer via hash parse.

### Pitfall 5: Mini inbox modal and DnD context

**What goes wrong:** `InboxServiceGroupCard` uses `useDraggable` from `@dnd-kit/core`, which requires a parent `DndContext`. If the mini inbox modal renders `InboxServiceGroupCard` outside `WorksheetsInboxPage`'s DnD context, drag will fail.

**How to avoid:** The mini inbox modal should either (a) use a simplified click-to-add version without drag, or (b) wrap the modal in its own `DndContext`. Since D-08 says "drag or click", the simplest reliable approach is click-to-add with a simplified card that does not use `useDraggable`. Claude's discretion allows this (D: mini inbox modal implementation).

### Pitfall 6: Start Prep prefill cleared before Step1 mounts

**What goes wrong:** `startPrepFromWorksheet` sets prefill state and navigates to `new-analysis`. If the navigation triggers a component unmount/remount cycle, the prefill field might be read before `Step1SampleInfo` mounts, or cleared by a previous `resetWizard()` call.

**How to avoid:** Store prefill in `ui-store` (not `wizard-store`) so it survives wizard resets. `Step1SampleInfo` reads it on first render and immediately clears it to prevent stale re-use. Use a `useEffect(() => { ... }, [])` mount-once pattern.

---

## Code Examples

### FAB button (bottom-right, fixed in MainWindow layout)

```tsx
// Pattern: absolute positioned in the relative-positioned root div in MainWindow
// z-40 keeps it above page content but below Sheet overlay (z-50)
<button
  onClick={() => useUIStore.getState().openWorksheetDrawer()}
  className="absolute bottom-8 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors"
  aria-label="Open worksheet"
>
  <ClipboardList className="h-5 w-5" />
  {badgeCount > 0 && (
    <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-[10px] text-destructive-foreground font-bold">
      {badgeCount}
    </span>
  )}
</button>
```

### Sheet controlled by Zustand

```tsx
// WorksheetDrawer.tsx
const drawerOpen = useUIStore(state => state.worksheetDrawerOpen)
const closeDrawer = useUIStore(state => state.closeWorksheetDrawer)

<Sheet open={drawerOpen} onOpenChange={(open) => { if (!open) closeDrawer() }}>
  <SheetContent side="right" className="w-[480px] sm:max-w-[480px] p-0">
    {/* drawer content */}
  </SheetContent>
</Sheet>
```

### TanStack Query mutation for complete worksheet

```typescript
// Source: established project mutation pattern (use-inbox-samples.ts)
const queryClient = useQueryClient()

const completeMutation = useMutation({
  mutationFn: (worksheetId: number) => completeWorksheet(worksheetId),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['worksheets'] })
    toast.success('Worksheet completed')
    useUIStore.getState().closeWorksheetDrawer()
  },
  onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
})
```

### Extend WorksheetUpdate backend (notes field)

```python
# backend/main.py — modify WorksheetUpdate
class WorksheetUpdate(BaseModel):
    title: Optional[str] = None
    assigned_analyst: Optional[int] = None
    notes: Optional[str] = None  # ADD THIS

# In update_worksheet handler, after existing title/analyst logic:
if data.notes is not None:
    ws.notes = data.notes
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Page-based worksheet detail | Overlay drawer (Sheet) | D-02 decision | No page navigation; works on any page |
| Separate worksheet-detail page route | FAB + Zustand-controlled Sheet | Phase 17 design | `MainWindowContent` worksheet-detail case becomes drawer-open action |

**Notes field on `PUT /worksheets/{id}`:** Not yet supported in the backend handler, despite the model having it. Must be added in Phase 17.

**Items list completeness:** Current `/worksheets` list response omits per-item tech/instrument. Must be extended for WSHT-03 compliance.

---

## Environment Availability

Step 2.6: SKIPPED — Phase 17 is purely frontend UI + backend Python endpoint additions. No new external dependencies. Python/FastAPI/SQLite stack already running from Phase 16.

---

## Validation Architecture

> `workflow.nyquist_validation` key absent from config.json — treating as enabled.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest v4 |
| Config file | `vite.config.ts` (Vitest inline config) or `vitest.config.ts` |
| Quick run command | `npm run test` |
| Full suite command | `npm run check:all` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| WSHT-01 | Header renders title/analyst/status/date/count | unit | `npm run test -- WorksheetDrawer` | ❌ Wave 0 |
| WSHT-02 | Inline title edit saves; notes textarea saves | unit | `npm run test -- WorksheetDrawerHeader` | ❌ Wave 0 |
| WSHT-03 | Items list renders sample ID, group badge, priority, tech, instrument | unit | `npm run test -- WorksheetDrawerItems` | ❌ Wave 0 |
| WSHT-04 | Add Samples modal opens; click-to-add appends item | unit | `npm run test -- AddSamplesModal` | ❌ Wave 0 |
| WSHT-05 | Remove item calls API and disappears from list | unit | `npm run test -- WorksheetDrawerItems` | ❌ Wave 0 |
| WSHT-06 | Reassign moves item to target worksheet | unit | `npm run test -- WorksheetDrawerItems` | ❌ Wave 0 |
| WSHT-07 | Complete shows confirm dialog; on confirm sets status=completed | unit | `npm run test -- WorksheetDrawer` | ❌ Wave 0 |
| WSHT-08 | Backend persists notes/status — data survives restart | manual | manual DB inspection | n/a |

Note: Given project granularity is "coarse" and this is a UI-heavy phase, the planner may elect to rely on the quality gate (`npm run check:all`) over writing full test suites for every component. WSHT-08 is inherently manual verification of SQLite persistence.

### Wave 0 Gaps

- [ ] `src/components/hplc/__tests__/WorksheetDrawer.test.tsx` — covers WSHT-01, WSHT-07
- [ ] `src/components/hplc/__tests__/WorksheetDrawerItems.test.tsx` — covers WSHT-03, WSHT-05, WSHT-06
- [ ] Framework already installed (Vitest in project); no install step needed

---

## Open Questions

1. **Worksheet selector tabs (D-05) — query key strategy**
   - What we know: the drawer shows tabs when multiple worksheets are open; tab switches set `activeWorksheetId`
   - What's unclear: does switching active worksheet require a separate `GET /worksheets/{id}` detail call, or is all needed data already in the `GET /worksheets` list response?
   - Recommendation: The list response already includes full items array. No separate detail endpoint needed. Use the list data filtered by `activeWorksheetId`. Avoids over-fetching.

2. **"Prep started" indicator storage (D-17)**
   - What we know: once a prep is started, item should show indicator; must not block further preps
   - What's unclear: where is this state stored? `WorksheetItem` has a `notes` column — could use it as a flag. Or add a `prep_started_at` column.
   - Recommendation: Use `WorksheetItem.notes` to store a JSON flag (`"prep_started": true`) as a lightweight approach requiring no migration. The planner should decide if a dedicated column is cleaner.

3. **FAB badge — item count vs open worksheet count**
   - What we know: D-04 says badge shows item count of active worksheet OR count of open worksheets if none selected
   - What's unclear: on first load (no active worksheet set), should badge show total items across all open worksheets, or just count of worksheets?
   - Recommendation: Show total open item count across all non-completed worksheets. More useful signal than worksheet count.

---

## Sources

### Primary (HIGH confidence)

- Direct codebase read — `src/components/ui/sheet.tsx` — Sheet/SheetContent API confirmed (Radix Dialog-based, side prop, portal)
- Direct codebase read — `src/store/ui-store.ts` — Zustand store structure, selector pattern, devtools middleware, all existing state fields
- Direct codebase read — `backend/main.py` lines 11030-11297 — all existing worksheet endpoints, `WorksheetUpdate` model
- Direct codebase read — `backend/models.py` lines 569-610 — `Worksheet` and `WorksheetItem` SQLAlchemy models, confirmed `notes` field exists on both
- Direct codebase read — `src/lib/api.ts` lines 3619-3808 — all TypeScript types and API functions, `WorksheetListItem` shape
- Direct codebase read — `src/lib/hash-navigation.ts` — full hash nav pattern; `applyNavToStore` and `buildHash` extension points
- Direct codebase read — `src/components/hplc/WorksheetDropPanel.tsx` — item row format (lines 172-195), reusable
- Direct codebase read — `src/components/hplc/InboxServiceGroupCard.tsx` — DragData, useDraggable pattern, confirms DnD context requirement
- Direct codebase read — `src/components/layout/MainWindow.tsx` — confirmed CommandPalette/PreferencesDialog placement pattern for global overlays

### Secondary (MEDIUM confidence)

- `.planning/phases/17-worksheet-detail/17-CONTEXT.md` — all locked decisions verified against codebase
- `backend/models.py` line 573: status lifecycle `'open' | 'completed' | 'cancelled'` — confirmed string values for complete endpoint

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries are existing project dependencies, confirmed by direct file reads
- Architecture: HIGH — all patterns directly derived from existing codebase; no speculation
- Pitfalls: HIGH — identified from concrete code inspection (WorksheetUpdate missing notes, items list missing tech/instrument, hash nav feedback loop from store state)
- Backend endpoints: HIGH — SQLAlchemy models confirmed, existing endpoint patterns copied

**Research date:** 2026-04-01
**Valid until:** 2026-05-01 (stable stack; main.py endpoint patterns won't drift)
