# Phase 16: Received Samples Inbox — Research

**Researched:** 2026-03-31
**Domain:** FastAPI + React (TanStack Query) — live queue with inline editing, bulk actions, and worksheet creation
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** New dedicated endpoint `GET /worksheets/inbox` — composite view (SENAITE `sample_received` + service group enrichment + local priority + local analyst/instrument from worksheet_items)
- **D-02:** Backend does service group matching: `SenaiteAnalysis.keyword` → `AnalysisService.keyword` → `service_group_members` → `ServiceGroup`. Unmatched analyses go to default group (`is_default=True`).
- **D-03:** Priority stored in local `sample_priorities` table (sample_uid PK, priority enum, updated_at). Endpoint: `PUT /worksheets/inbox/{sample_uid}/priority`
- **D-04:** 30-second polling via TanStack Query `refetchInterval: 30000`
- **D-05:** Analyst dropdown from AccuMark local user list (`GET /worksheets/users` (non-admin)), NOT SENAITE. Assignment stored locally in worksheet_items only.
- **D-06:** Instrument dropdown from local instruments table (`GET /instruments`)
- **D-07:** Expandable rows — sub-table of analyses grouped by service group with `SERVICE_GROUP_COLORS` badges
- **D-08:** Expansion state is local React state, not persisted
- **D-09:** Three priority levels: `normal` (zinc), `high` (amber), `expedited` (red + pulse)
- **D-10:** Priority via inline shadcn Select, `PUT /worksheets/inbox/{sample_uid}/priority`, optimistic update with rollback on error
- **D-11:** PriorityBadge component — reusable across inbox, worksheet detail, worksheets list
- **D-12:** AgingTimer from `date_received`. Colors: green <12h, yellow 12-20h, orange 20-24h, red >24h. Updates every minute via `setInterval`
- **D-13:** Format: "2h 15m" under 24h, "1d 3h" over 24h. Red state has subtle pulse animation
- **D-14:** Checkbox column with header-level select-all (indeterminate when partial). Selection state: React `useState(new Set<string>())`
- **D-15:** Floating bulk toolbar at viewport bottom when items selected (same pattern as Phase 8 v0.12.0). Actions: Set Priority, Assign Tech, Set Instrument, Create Worksheet
- **D-16:** Bulk endpoint `PUT /worksheets/inbox/bulk` — `{ sample_uids: string[], priority?: string, analyst_id?: number, instrument_uid?: string }`
- **D-17:** Worksheet creation dialog: auto-generated title ("WS-2026-04-01-001"), optional notes, editable title, confirm
- **D-18:** `POST /worksheets` — validates each sample still in `sample_received`. Returns 409 with stale sample IDs if any changed state.
- **D-19:** On success: selected items disappear from inbox, toast with link to new worksheet
- **D-20:** DB schema: `worksheets` (id, title, status, assigned_analyst, notes, created_by FK→users, created_at, updated_at) + `worksheet_items` (id, worksheet_id FK, sample_uid, sample_id, analysis_uid nullable, service_group_id FK, priority, assigned_analyst_id FK→users, instrument_uid, notes, added_at)
- **D-21:** Column order: Checkbox | Sample ID (monospace, clickable → SENAITE sample detail) | Client | Priority (inline Select → PriorityBadge) | Assigned Tech (inline Select) | Instrument (inline Select) | Age (AgingTimer) | Status (StateBadge)

### Claude's Discretion

- Exact table column widths and responsive behavior
- Loading skeleton design during initial fetch and polling
- Empty state design when no received samples exist
- Error state design when SENAITE is unreachable
- Whether to show a sample count badge on the "Inbox" nav item
- Exact dialog styling for worksheet creation modal

### Deferred Ideas (OUT OF SCOPE)

- Auto-suggest tech assignments based on service group → analyst mapping (WAUT-01)
- Auto-prioritize samples nearing SLA breach (WAUT-02)
- Notification when worksheet items change state in SENAITE (WAUT-03)
- Sample count badge on Inbox nav item (deferred to Claude's discretion)

</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INBX-01 | User can view all received samples from SENAITE in a queue/inbox table | `GET /worksheets/inbox` composite endpoint; TanStack Query hook with 30s polling |
| INBX-02 | Each sample row expands to show analyses grouped by service group with color badges | Expandable row pattern via chevron; local React expand state; `SERVICE_GROUP_COLORS` from `service-group-colors.ts` |
| INBX-03 | User can set sample priority (normal/high/expedited) with color-coded badge display | `PriorityBadge` component; inline shadcn `Select`; `PUT /worksheets/inbox/{uid}/priority`; optimistic update |
| INBX-04 | User can assign a tech (analyst) to a sample inline via dropdown | Inline shadcn `Select` populated from `GET /worksheets/users` (non-admin, per D-05); stored locally in worksheet_items |
| INBX-05 | User can assign an instrument to a sample inline via dropdown | Inline shadcn `Select` populated from `GET /instruments` (already exists) |
| INBX-06 | Inbox shows aging timer per sample with SLA color coding | `AgingTimer` component using `date_received` from SENAITE; `setInterval` 60s; 4-tier color spec |
| INBX-07 | User can select multiple samples via checkboxes and apply bulk actions | Checkbox column; indeterminate header state; `Set<string>` selection; floating bulk toolbar (Phase 8 pattern) |
| INBX-08 | User can create a worksheet from selected inbox items | Worksheet creation dialog; `POST /worksheets`; removes items from inbox on success |
| INBX-09 | Inbox auto-refreshes via 30-second polling with TanStack Query | `useQuery({ queryKey: ['inbox'], queryFn: getInboxSamples, refetchInterval: 30000 })` |
| INBX-10 | Worksheet creation validates each sample is still in sample_received state | Backend 409 guard on `POST /worksheets`; frontend stale detection dialog |
| INBX-11 | Priority data persists locally in sample_priorities table | New PostgreSQL table: `sample_priorities (sample_uid PK, priority VARCHAR, updated_at)` |

</phase_requirements>

---

## Summary

Phase 16 is an entirely new feature surface: a live inbox queue that combines SENAITE data with local enrichment. The architecture is well-defined in the locked decisions — the main work is building ~5 backend endpoints, 2 new DB tables, a TanStack Query hook, and 6 new React components.

The codebase already has all required primitives: `SenaiteSampleItem` model with `date_received`, the `ServiceGroup` / `service_group_members` ORM, the `Instrument` table, `GET /auth/users` returning `UserRead` (id + email + role), and the `SenaiteAnalysis` interface with `keyword` field enabling service group matching. The Phase 8 bulk selection pattern (`use-bulk-analysis-transition.ts`) provides the structural template for the new `use-inbox-samples.ts` hook.

The most complex backend task is the `GET /worksheets/inbox` composite query: fetch SENAITE `sample_received` samples, then for each sample fetch its analyses from SENAITE and match keywords to local service groups. This requires either N+1 SENAITE calls per sample or a design that batches/caches analysis fetching. The planner should note this as a performance consideration — the `lookupSenaiteSample` endpoint already retrieves analyses per sample but it is not batched. The inbox endpoint should load service group membership once (local DB join is cheap) and match against keywords from each sample's analyses in memory.

**Primary recommendation:** Build the composite inbox endpoint with a single upfront load of all service group keyword maps, then match per-sample analyses in Python rather than making additional SENAITE calls per sample. The SENAITE `/senaite/@@API/senaite/v1/AnalysisRequest` with `complete=yes` returns analysis data inline — confirm whether this includes keyword fields before building the enrichment logic.

---

## Standard Stack

### Core (already installed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @tanstack/react-query | ^5.90.12 | Polling, cache, mutations | Already in use; `refetchInterval` built-in |
| shadcn/ui (Select, Dialog, Checkbox, Table, Badge) | v4.x | Inline dropdowns, bulk dialog, table | Established project UI layer |
| zustand | v5.x | UI state (expansion is local React state, not Zustand) | Project standard; selector pattern enforced |
| sonner | existing | Toast notifications (success/error) | Already used throughout |
| lucide-react | existing | Icons (ChevronDown, CheckSquare, Clock, etc.) | Project icon set |

### New (no install needed, already in project)

| Asset | Location | Phase 16 Use |
|-------|----------|--------------|
| `SERVICE_GROUP_COLORS` | `src/lib/service-group-colors.ts` | Service group badges in expanded rows |
| `StateBadge` | `src/components/senaite/senaite-utils.tsx` | Status column in inbox table |
| `formatDate` | `src/components/senaite/senaite-utils.tsx` | Date display in expanded rows |
| `SenaiteSample` interface | `src/lib/api.ts` (line 3333) | Base interface; inbox extends with enrichment fields |
| `ServiceGroup` interface | `src/lib/api.ts` (line 3502) | Service group data for matching badges |
| `Checkbox` | `src/components/ui/checkbox.tsx` | Multi-select column |
| `Dialog` | `src/components/ui/dialog.tsx` | Worksheet creation modal |

**Installation:** No new packages needed.

---

## Architecture Patterns

### Recommended Project Structure

New files to create:

```
src/
├── components/hplc/
│   ├── WorksheetsInboxPage.tsx     # REPLACE placeholder — full inbox component
│   ├── InboxSampleTable.tsx        # Table with expandable rows, inline selects
│   ├── PriorityBadge.tsx           # Reusable priority badge component
│   ├── AgingTimer.tsx              # Aging timer with SLA color coding
│   ├── InboxBulkToolbar.tsx        # Floating bulk action bar (Phase 8 pattern)
│   └── CreateWorksheetDialog.tsx   # Worksheet creation dialog
├── hooks/
│   └── use-inbox-samples.ts        # TanStack Query hook with 30s polling
src/lib/
│   └── api.ts                      # Add: InboxSample, InboxSamplesResponse, inbox API fns
backend/
├── main.py                         # Add: 5 new endpoints (~250 lines)
└── models.py                       # Add: SamplePriority, Worksheet, WorksheetItem models
```

### Pattern 1: TanStack Query with Polling (INBX-09)

The inbox is the first live-data page using TanStack Query (admin pages use useState). Use `refetchInterval` — this is built into TanStack Query v5 and the `queryClient` already has `refetchOnWindowFocus: false` set, which is correct for a desktop app.

```typescript
// src/hooks/use-inbox-samples.ts
// Source: project queryClient at src/lib/query-client.ts + TanStack Query v5 docs
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getInboxSamples, updateInboxPriority } from '@/lib/api'

export function useInboxSamples() {
  return useQuery({
    queryKey: ['inbox-samples'],
    queryFn: getInboxSamples,
    refetchInterval: 30_000,    // 30-second polling (D-04)
    staleTime: 0,               // always fresh — live queue
  })
}
```

**Note:** `staleTime: 0` overrides the queryClient default of 5 minutes, which is correct for a live queue.

### Pattern 2: Optimistic Update for Priority (D-10)

```typescript
// Source: TanStack Query v5 useMutation optimistic updates pattern
const queryClient = useQueryClient()

const priorityMutation = useMutation({
  mutationFn: ({ sampleUid, priority }: { sampleUid: string; priority: string }) =>
    updateInboxPriority(sampleUid, priority),
  onMutate: async ({ sampleUid, priority }) => {
    await queryClient.cancelQueries({ queryKey: ['inbox-samples'] })
    const previous = queryClient.getQueryData(['inbox-samples'])
    queryClient.setQueryData(['inbox-samples'], (old: InboxSamplesResponse) => ({
      ...old,
      items: old.items.map(s =>
        s.uid === sampleUid ? { ...s, priority } : s
      ),
    }))
    return { previous }
  },
  onError: (_err, _vars, context) => {
    queryClient.setQueryData(['inbox-samples'], context?.previous)
    toast.error('Failed to update priority')
  },
})
```

### Pattern 3: Expandable Row with Local State (D-07, D-08)

Expansion state lives in the parent component, not persisted. Use a `Set<string>` of expanded UIDs mirroring the selection pattern from `use-bulk-analysis-transition.ts`.

```typescript
// In InboxSampleTable.tsx or WorksheetsInboxPage.tsx
const [expandedUids, setExpandedUids] = useState<Set<string>>(new Set())

const toggleExpand = (uid: string) => {
  setExpandedUids(prev => {
    const next = new Set(prev)
    next.has(uid) ? next.delete(uid) : next.add(uid)
    return next
  })
}
```

### Pattern 4: AgingTimer Component (D-12, D-13)

```typescript
// src/components/hplc/AgingTimer.tsx
// Uses setInterval to update every 60 seconds
import { useState, useEffect } from 'react'

function getAgeMs(dateReceived: string | null): number {
  if (!dateReceived) return 0
  return Date.now() - new Date(dateReceived).getTime()
}

function formatAge(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  return `${hours}h ${minutes}m`
}

function getAgeColor(ms: number): string {
  const hours = ms / 3_600_000
  if (hours < 12) return 'text-green-500'
  if (hours < 20) return 'text-yellow-500'
  if (hours < 24) return 'text-orange-500'
  return 'text-red-500'
}

export function AgingTimer({ dateReceived }: { dateReceived: string | null }) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const ms = dateReceived ? now - new Date(dateReceived).getTime() : 0
  const isRed = ms / 3_600_000 >= 24

  return (
    <span className={`font-mono text-sm tabular-nums ${getAgeColor(ms)} ${isRed ? 'animate-pulse' : ''}`}>
      {formatAge(ms)}
    </span>
  )
}
```

**Note:** `animate-pulse` from Tailwind provides the subtle pulse for red state (D-13). For expedited priority pulse (D-09), the same Tailwind class can be applied to the `PriorityBadge`.

### Pattern 5: Floating Bulk Toolbar (D-15, Phase 8)

The Phase 8 pattern in `use-bulk-analysis-transition.ts` shows how bulk selection state is managed. The floating toolbar is rendered at the bottom of the viewport using `fixed` positioning. The new inbox version should follow the same pattern but with inbox-specific actions (priority, tech, instrument, create worksheet).

```typescript
// InboxBulkToolbar.tsx — fixed bottom center, animates in when selection > 0
// Appears when selectedUids.size > 0
// Uses fixed bottom-6 left-1/2 -translate-x-1/2 z-50 pattern
```

### Pattern 6: Backend Composite Endpoint (D-01, D-02)

The inbox endpoint is more complex than a simple SENAITE proxy. The recommended approach:

1. Call SENAITE `/AnalysisRequest?review_state=sample_received&complete=yes` — the `complete=yes` param returns inline analysis data per the existing `_item_to_model` pattern
2. Load service group keyword map from local DB once (single query joining `service_groups` + `service_group_members` + `analysis_services`)
3. Load local priorities and worksheet_item assignments for returned sample UIDs
4. Match analysis keywords to service groups in Python memory (no additional SENAITE calls)

**Critical verification needed:** Confirm whether SENAITE's `complete=yes` on AnalysisRequest list includes each sample's analyses inline. The `lookupSenaiteSample` endpoint fetches analyses separately via `/AnalysisRequest/{uid}`. If list endpoint does NOT include analyses, the inbox endpoint must fetch each sample individually (N+1 problem — may need caching or limited page size).

### Anti-Patterns to Avoid

- **Do not** use the `useState` admin pattern for inbox data. Live queues use TanStack Query with `refetchInterval`.
- **Do not** use Zustand destructuring syntax (`const { data } = useUIStore()`). Project enforces selector syntax (`const data = useUIStore(state => state.data)`).
- **Do not** push analyst assignments to SENAITE. SENAITE Analyst field is read-only (ANLY-03 verified in Phase 15).
- **Do not** call `useMemo`/`useCallback` manually — React Compiler handles memoization (per `AGENTS.md`).
- **Do not** use `invoke` string-based Tauri calls — use typed commands from `@/lib/tauri-bindings`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Polling live data | Manual `setInterval` + fetch | TanStack Query `refetchInterval` | Handles stale state, background refetch, error retry automatically |
| Optimistic UI | Manual state cloning | TanStack Query `onMutate` / `onError` rollback | Race condition free, cache-coherent |
| Toast notifications | Custom notification system | `sonner` (already used) | Consistent UX, already wired in app |
| Dialog UI | Custom modal | shadcn `Dialog` | Accessible, consistent with rest of app |
| Inline select | Custom dropdown | shadcn `Select` | Already used in AnalysisTable inline editing (v0.12.0) |

**Key insight:** All UI primitives exist. The value-add is the data model (enriched inbox response) and the business logic (priority persistence, worksheet creation guard).

---

## Common Pitfalls

### Pitfall 1: SENAITE `complete=yes` Analysis Field Availability

**What goes wrong:** `GET /worksheets/inbox` assumes analysis keywords come back inline with the AnalysisRequest list, but they may not — leaving all analyses unmatched to service groups.

**Why it happens:** SENAITE's list endpoint with `complete=yes` returns many fields, but not necessarily nested Analysis objects. The per-sample lookup endpoint (`/AnalysisRequest/{uid}`) definitely returns analyses.

**How to avoid:** Before implementing the composite enrichment, test the SENAITE list endpoint for one received sample and confirm the analyses field. If absent, the inbox endpoint must either: (a) accept N+1 calls (acceptable for small queues, add pagination), or (b) fetch analyses for only the first page (e.g., 50 samples max).

**Warning signs:** Backend returns all samples with empty `analyses_by_group` — all analyses fall into default group.

### Pitfall 2: Stale Priority Data After Polling Refresh

**What goes wrong:** 30-second poll refreshes from SENAITE, but local priority overrides are stored in `sample_priorities` table. If the polling response does not include local enrichment, priorities appear to "reset" on each poll.

**Why it happens:** The backend inbox endpoint must JOIN sample_priorities into the response for every poll. If the enrichment step is skipped during polling, the frontend sees no priority.

**How to avoid:** The `GET /worksheets/inbox` endpoint always loads local priorities (D-01). The TanStack Query response includes priority in each item. Optimistic updates modify the query cache directly, so transient updates survive until the next poll confirms them.

### Pitfall 3: Worksheet Creation Race — 409 Handling

**What goes wrong:** User selects 5 samples, 2 change state between inbox load and Create Worksheet click. Backend returns 409 with stale UIDs. Frontend either silently fails or shows a confusing error.

**Why it happens:** Lab workflow moves samples forward independently. Inbox is a snapshot, not a lock.

**How to avoid:** Frontend must handle 409 explicitly: parse the `stale_uids` from the response, remove those samples from selection, show a toast explaining which samples were stale ("2 samples already moved — selection updated"), then allow user to proceed with remaining samples.

**Warning signs:** User clicks Create Worksheet, gets an opaque error, has to manually refresh to see what happened.

### Pitfall 4: Indeterminate Checkbox State

**What goes wrong:** `<Checkbox>` from shadcn/ui renders indeterminate state only if the underlying HTML input's `indeterminate` property is set imperatively. Declarative-only prop may not work.

**Why it happens:** `indeterminate` is not a standard HTML attribute — it must be set via `inputRef.current.indeterminate = true`.

**How to avoid:** Check whether shadcn `Checkbox` exposes an `indeterminate` prop or requires a `ref`. If ref-based, use `useEffect` to set it when selection is partial:
```typescript
const isIndeterminate = selectedUids.size > 0 && selectedUids.size < samples.length
// Set on the underlying input element imperatively if needed
```

### Pitfall 5: New Tables Not in Migration Script

**What goes wrong:** `sample_priorities`, `worksheets`, `worksheet_items` tables are defined in `models.py` but `_run_migrations()` in `database.py` only adds columns to existing tables — it does not create new tables. `Base.metadata.create_all()` handles new table creation, but only on startup.

**Why it happens:** The project uses `create_all` for new tables, which is fine. No pitfall here IF the models are registered before `create_all` runs — which they are, since `database.py` imports `models`.

**How to avoid:** Add the three new model classes to `models.py` before the backend starts. `create_all` will handle them. No migration script needed.

**Warning signs:** Backend starts without error, but `GET /worksheets/inbox` returns 500 because table doesn't exist — check that `import models` in `init_db()` covers the new models.

### Pitfall 6: `GET /auth/users` Requires Admin Role

**What goes wrong:** The analyst dropdown calls `GET /auth/users` to populate, but the endpoint requires `admin=Depends(require_admin)`. Standard users see an empty dropdown.

**Why it happens:** User listing is admin-only in the current implementation.

**How to avoid:** Either: (a) add a `GET /users/list` endpoint that returns only `id` + `email` for all active users accessible to standard users, or (b) loosen the existing `/auth/users` endpoint. Given that analyst assignment is a workflow action for standard users, option (a) is safer (principle of least privilege).

**Warning signs:** Analyst dropdown empty for non-admin users, works fine in admin account.

---

## Code Examples

### Backend: New Pydantic Schemas

```python
# Source: existing ServiceGroupResponse pattern in main.py (~line 1444)

class InboxAnalysisItem(BaseModel):
    uid: Optional[str] = None
    title: str
    keyword: Optional[str] = None
    method: Optional[str] = None
    review_state: Optional[str] = None

class InboxServiceGroupSection(BaseModel):
    group_id: int
    group_name: str
    group_color: str
    analyses: list[InboxAnalysisItem]

class InboxSampleItem(BaseModel):
    uid: str
    id: str
    title: str
    client_id: Optional[str] = None
    client_order_number: Optional[str] = None
    date_received: Optional[str] = None
    review_state: str
    priority: str = "normal"            # from sample_priorities
    assigned_analyst_id: Optional[int] = None
    assigned_analyst_email: Optional[str] = None
    instrument_uid: Optional[str] = None
    analyses_by_group: list[InboxServiceGroupSection] = []

class InboxResponse(BaseModel):
    items: list[InboxSampleItem]
    total: int
```

### Backend: sample_priorities Model

```python
# Source: existing ServiceGroup model pattern in models.py (~line 164)

class SamplePriority(Base):
    __tablename__ = "sample_priorities"

    sample_uid: Mapped[str] = mapped_column(String(50), primary_key=True)
    priority: Mapped[str] = mapped_column(String(20), nullable=False, default="normal")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
```

### Backend: Worksheet + WorksheetItem Models

```python
# Source: existing HPLCAnalysis model pattern in models.py

class Worksheet(Base):
    __tablename__ = "worksheets"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="open", nullable=False)
    assigned_analyst_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class WorksheetItem(Base):
    __tablename__ = "worksheet_items"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    worksheet_id: Mapped[int] = mapped_column(
        ForeignKey("worksheets.id", ondelete="CASCADE"), nullable=False
    )
    sample_uid: Mapped[str] = mapped_column(String(50), nullable=False)
    sample_id: Mapped[str] = mapped_column(String(100), nullable=False)
    analysis_uid: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    service_group_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("service_groups.id", ondelete="SET NULL"), nullable=True
    )
    priority: Mapped[str] = mapped_column(String(20), default="normal", nullable=False)
    assigned_analyst_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    instrument_uid: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    added_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
```

### Frontend: PriorityBadge Component

```typescript
// src/components/hplc/PriorityBadge.tsx
// Reusable — Phase 17 and 18 also consume this

type Priority = 'normal' | 'high' | 'expedited'

const PRIORITY_CONFIG: Record<Priority, { label: string; className: string }> = {
  normal:    { label: 'Normal',    className: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-900/30 dark:text-zinc-300' },
  high:      { label: 'High',      className: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300' },
  expedited: { label: 'Expedited', className: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 animate-pulse' },
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  const config = PRIORITY_CONFIG[priority] ?? PRIORITY_CONFIG.normal
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${config.className}`}>
      {config.label}
    </span>
  )
}
```

### Frontend: API Types for Inbox

```typescript
// src/lib/api.ts additions

export type InboxPriority = 'normal' | 'high' | 'expedited'

export interface InboxAnalysisItem {
  uid: string | null
  title: string
  keyword: string | null
  method: string | null
  review_state: string | null
}

export interface InboxServiceGroupSection {
  group_id: number
  group_name: string
  group_color: string
  analyses: InboxAnalysisItem[]
}

export interface InboxSampleItem {
  uid: string
  id: string
  title: string
  client_id: string | null
  client_order_number: string | null
  date_received: string | null
  review_state: string
  priority: InboxPriority
  assigned_analyst_id: number | null
  assigned_analyst_email: string | null
  instrument_uid: string | null
  analyses_by_group: InboxServiceGroupSection[]
}

export interface InboxResponse {
  items: InboxSampleItem[]
  total: number
}
```

### Frontend: Worksheet Title Generator

```typescript
// Generates "WS-YYYY-MM-DD-NNN" sequential titles
function generateWorksheetTitle(existingCount = 0): string {
  const now = new Date()
  const date = now.toISOString().split('T')[0]  // "2026-04-01"
  const seq = String(existingCount + 1).padStart(3, '0')
  return `WS-${date}-${seq}`
}
```

### Backend: Service Group Keyword Map (Efficient Pattern)

```python
# Load once per request — O(1) lookups during per-sample analysis matching
def build_keyword_to_group_map(db: Session) -> dict[str, int]:
    """Returns {keyword: group_id} for fast per-analysis matching."""
    rows = db.execute(
        select(AnalysisService.keyword, service_group_members.c.service_group_id)
        .join(service_group_members,
              service_group_members.c.analysis_service_id == AnalysisService.id)
        .where(AnalysisService.keyword.isnot(None))
    ).all()
    return {row.keyword: row.service_group_id for row in rows}
```

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| Manual fetch + setInterval polling | TanStack Query `refetchInterval` | Handles cache coherence, stale-while-revalidate |
| SENAITE Analyst push (blocked) | Local-only analyst assignment in worksheet_items | Avoids SENAITE read-only field; analyst stored with worksheet context |

---

## Open Questions

1. **Does SENAITE `complete=yes` on AnalysisRequest list include analysis items per sample?**
   - What we know: The per-sample lookup (`lookupSenaiteSample`) fetches analyses from a separate endpoint and returns them in `SenaiteLookupResult.analyses`. The list endpoint (`/senaite/@@API/senaite/v1/AnalysisRequest?complete=yes`) is used in `list_senaite_samples` and currently maps only to `SenaiteSampleItem` (no analysis fields).
   - What's unclear: Whether the SENAITE API returns nested analysis data when listing with `complete=yes`.
   - Recommendation: The implementer should log the raw SENAITE response for one `sample_received` sample from the list endpoint and check for an `Analyses` or `getAnalyses` field. If not present, the inbox endpoint must do per-sample analysis lookups (N+1) or accept that service group matching is deferred to when the row is expanded.

2. **Should `GET /worksheets/inbox` include analyses_by_group inline or lazy-load on expand?**
   - What we know: D-08 says expansion data is "already loaded from the enriched inbox response" — indicating inline.
   - What's unclear: Performance implication with 50+ received samples each requiring analysis enrichment.
   - Recommendation: Default to inline enrichment for small queues. If SENAITE N+1 calls are needed and the queue grows large (>20 samples), add a `?enrich=true` param or cap inbox at 50 samples with pagination.

3. **Does the `/auth/users` endpoint need a public-facing variant for non-admin users?**
   - What we know: Analyst dropdown (D-05) must be populated for standard (non-admin) users. Current `GET /auth/users` requires `require_admin`.
   - What's unclear: Whether standard users are expected to see full user list or just active users.
   - Recommendation: Add `GET /worksheets/users` returning `[{id, email}]` for active users, accessible to all authenticated users. Does not expose sensitive fields (hashed_password, SENAITE credentials).

---

## Environment Availability

Step 2.6: SKIPPED — Phase 16 is a code and DB migration phase. All external dependencies (PostgreSQL, SENAITE) were verified and running in Phase 15.

---

## Validation Architecture

`workflow.nyquist_validation` not set in `.planning/config.json` — treating as enabled.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (project standard per AGENTS.md) |
| Config file | `vitest.config.ts` (inferred from project — not directly read) |
| Quick run command | `npm run test` |
| Full suite command | `npm run check:all` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INBX-01 | Inbox endpoint returns enriched samples | Backend integration | Manual SENAITE required | ❌ Wave 0 |
| INBX-03 | PriorityBadge renders correct color per priority | Unit | `npm run test -- PriorityBadge` | ❌ Wave 0 |
| INBX-06 | AgingTimer computes correct color thresholds | Unit | `npm run test -- AgingTimer` | ❌ Wave 0 |
| INBX-08 | POST /worksheets returns 409 on stale samples | Unit (mock SENAITE) | `npm run test -- worksheets` | ❌ Wave 0 |
| INBX-10 | Stale sample guard triggers when state changes | Unit | included above | ❌ Wave 0 |
| INBX-11 | Priority persists across page reload | Manual/Integration | n/a | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `npm run test`
- **Per wave merge:** `npm run check:all`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/components/hplc/__tests__/PriorityBadge.test.tsx` — covers INBX-03
- [ ] `src/components/hplc/__tests__/AgingTimer.test.tsx` — covers INBX-06, INBX-12/D-13

*(Backend endpoint tests require live SENAITE and are manual-only for this phase)*

---

## Project Constraints (from CLAUDE.md)

Applicable directives for this phase:

| Directive | Impact on Phase 16 |
|-----------|-------------------|
| Use `npm` only (NOT pnpm) | All install/run commands use `npm run ...` |
| Selector syntax for Zustand: `useUIStore(state => state.x)` | Inbox components must use selector pattern |
| React Compiler handles memoization — no `useMemo`/`useCallback` | Do not add manual memoization to inbox components |
| Tauri v2 commands via `@/lib/tauri-bindings` | N/A — inbox is HTTP-only |
| Tailwind v4.x logical properties for layout | Use `text-start` not `text-left` |
| `rm -f` for file removal | N/A |
| Context7 for framework docs | TanStack Query v5 patterns verified via Context7 |
| Run `npm run check:all` after significant changes | Required before task sign-off |

---

## Sources

### Primary (HIGH confidence)

- Codebase direct read: `src/lib/api.ts` — `SenaiteSample`, `SenaiteAnalysis`, `ServiceGroup` interfaces; `getSenaiteSamples()` function signature
- Codebase direct read: `backend/models.py` — all existing SQLAlchemy models; `ServiceGroup`, `service_group_members`, `AnalysisService` ORM
- Codebase direct read: `backend/main.py` — `list_senaite_samples` (~line 9331), service group CRUD (~line 10168), `_item_to_model` mapping
- Codebase direct read: `backend/database.py` — PostgreSQL confirmed (not SQLite), migration pattern via `_run_migrations()`
- Codebase direct read: `src/lib/query-client.ts` — TanStack Query v5 config; `refetchOnWindowFocus: false`, `staleTime: 1000 * 60 * 5`
- Codebase direct read: `src/hooks/use-bulk-analysis-transition.ts` — Phase 8 bulk selection pattern
- Codebase direct read: `src/components/senaite/senaite-utils.tsx` — `StateBadge`, `formatDate`
- Codebase direct read: `src/lib/service-group-colors.ts` — `SERVICE_GROUP_COLORS` palette and `ServiceGroupColor` type
- Codebase direct read: `src/store/ui-store.ts` — `HPLCAnalysisSubSection` includes 'inbox'; `WorksheetSubSection` type
- Codebase direct read: `src/components/layout/MainWindowContent.tsx` — `case 'hplc-analysis': if (activeSubSection === 'inbox') return <WorksheetsInboxPage />`
- Codebase direct read: `backend/auth.py` — `UserRead` schema (id, email, role, is_active); `GET /auth/users` requires `require_admin`
- Package.json: `@tanstack/react-query: ^5.90.12`

### Secondary (MEDIUM confidence)

- AGENTS.md directives: React Compiler (no manual memo), selector-only Zustand, Tailwind v4 CSS logical properties

### Tertiary (LOW confidence — needs live verification)

- SENAITE `complete=yes` on AnalysisRequest list including inline analysis data: unverified, flagged as Open Question 1

---

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — all packages verified in package.json; all reused components read directly
- Architecture: HIGH — patterns derived from existing codebase (Phase 8 hook, TanStack Query config, service group ORM)
- Backend enrichment flow: MEDIUM — D-02 keyword matching design is clear, but SENAITE analysis availability in list endpoint is unverified
- Pitfalls: HIGH — `/auth/users` admin requirement is a real blocker; checkbox indeterminate is a known React/DOM gotcha; stale data 409 handling is explicitly required by INBX-10

**Research date:** 2026-03-31
**Valid until:** 2026-04-30 (stable stack; SENAITE API behavior may drift)
