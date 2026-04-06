# Phase 15: Foundation - Research

**Researched:** 2026-03-31
**Domain:** SQLAlchemy CRUD + FastAPI endpoints + Zustand nav wiring + SENAITE LabContact API
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Service Groups management lives as a new sub-item under the existing **LIMS** nav section (alongside Instruments, Methods, Peptides, Analysis Services).
- **D-02:** Admin UI uses the same table + slide-out detail panel pattern established by AnalysisServicesPage, InstrumentsPage, and MethodsPage.
- **D-03:** Group membership editor uses a checkbox list of analysis services in the slide-out panel, similar to how peptide-method associations work.
- **D-04:** Predefined color palette (8-10 named colors) stored as string keys (e.g., "blue", "amber", "emerald", "red", "violet", "zinc", "rose", "sky"). Maps to Tailwind badge variant classes. No free-form color picker.
- **D-05:** Color preview shown as a small swatch/badge in the service groups table and in the slide-out editor.
- **D-06:** Worksheets pages are sub-items under the existing `hplc-analysis` section. New sub-items: "Inbox" (received samples queue), "Worksheets" (worksheets list).
- **D-07:** New type `WorksheetSubSection` added to ui-store.ts. HPLCAnalysisSubSection expanded with `'inbox' | 'worksheets' | 'worksheet-detail'`.
- **D-08:** Hash navigation extended in hash-navigation.ts to support the new sub-sections.
- **D-09:** Analyst assignment endpoint follows the exact same httpx pattern as method-instrument assignment (main.py lines ~9892-9950): `POST /senaite/@@API/senaite/v1/update/{uid}` with `{"Analyst": value}`.
- **D-10:** Phase 15 includes a test/verification step to confirm whether SENAITE's Analyst field accepts a username string or requires a UID.
- **D-11:** GET analysts endpoint queries SENAITE's lab contacts: `GET /senaite/@@API/senaite/v1/LabContact?complete=yes` (or similar). Returns a list of `{username, fullname}` for dropdown population.
- **D-12:** `service_groups` table: id, name (unique), description (nullable), color (string key from predefined palette), sort_order (integer), created_at, updated_at.
- **D-13:** `service_group_members` association table: id, service_group_id FK (cascade delete), analysis_service_id FK (cascade delete), unique constraint on (service_group_id, analysis_service_id).
- **D-14:** Uses the same SQLAlchemy pattern as existing `peptide_methods` M2M junction table (models.py lines 164-172).

### Claude's Discretion

- Exact slide-out panel layout and field ordering for service group editor
- Loading/error state patterns (follow existing AnalysisServicesPage patterns)
- Exact icon choice for Worksheets nav items
- Whether to add a "Service Groups" sub-item to LIMS or make it a section within the existing Analysis Services page

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SGRP-01 | Admin can create, edit, and delete service groups (name, description, color, sort order) | CRUD pattern from `/hplc/methods` endpoints; SQLAlchemy model pattern from existing models; Form pattern from MethodsPage |
| SGRP-02 | Admin can assign analysis services to service groups via checkbox-based membership editor | M2M pattern from `peptide_methods` table; Checkbox component confirmed present at `src/components/ui/checkbox.tsx` |
| SGRP-03 | Service groups display in admin UI with member service count and color badge | Badge component at `src/components/ui/badge.tsx`; inline className approach for color since Badge only has 4 variants |
| SGRP-04 | Service group data persists in local database (service_groups + service_group_members tables) | PostgreSQL via SQLAlchemy + `_run_migrations()` pattern in database.py; `Base.metadata.create_all` handles new tables on startup |
| ANLY-01 | User can view available SENAITE lab contacts (analysts) from the application | SENAITE REST endpoint `GET /senaite/@@API/senaite/v1/LabContact?complete=yes`; httpx AsyncClient with `_get_senaite_auth` |
| ANLY-02 | User can assign an analyst to a SENAITE analysis | `POST /senaite/@@API/senaite/v1/update/{uid}` with `{"Analyst": value}`; mirrors method-instrument endpoint exactly |
| ANLY-03 | Analyst assignment verified against SENAITE (confirm field format: username vs UID) | Test endpoint needed; field name is `Analyst`; format TBD via live verification |
| NAVG-01 | Worksheets section accessible under HPLC Automation in sidebar navigation | AppSidebar.tsx navItems array; `hplc-analysis` section subItems; no special plumbing needed |
| NAVG-02 | Hash navigation supports worksheets section and sub-sections (inbox, list, detail) | hash-navigation.ts VALID_SECTIONS already includes `hplc-analysis`; sub-sections flow through `navigateTo` without special handling |

</phase_requirements>

## Summary

Phase 15 is a foundation phase: three parallel workstreams (service groups data model + admin UI, navigation wiring, SENAITE analyst integration) that together unblock Phase 16 (Inbox). The codebase is well-patterned and all three workstreams have clear, verified templates to follow.

The database is **PostgreSQL** (not SQLite — STATE.md note was inaccurate). New tables are added by: (1) defining SQLAlchemy models in models.py, and (2) adding `CREATE TABLE IF NOT EXISTS`-equivalent statements in the `_run_migrations()` list in database.py, OR just letting `Base.metadata.create_all()` handle new tables (safe for brand-new tables with no column-addition migration needed). The simpler path for net-new tables is to define the models and let `create_all` run on startup.

The navigation wiring is purely additive: add sub-section string literals to the TypeScript union type in ui-store.ts, add entries to AppSidebar.tsx's `navItems` array, and add render cases to MainWindowContent.tsx. The hash-navigation system already handles the `hplc-analysis` section without any changes to VALID_SECTIONS.

The highest-risk item is the SENAITE Analyst field format (username vs UID). This must be verified against a live SENAITE instance before Phase 16 builds any bulk flows.

**Primary recommendation:** Execute the three workstreams in dependency order — data model first, then backend endpoints, then frontend admin UI — and treat the ANLY-03 analyst format verification as a gate before calling the phase complete.

## Standard Stack

### Core (verified from codebase)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| SQLAlchemy 2.0 | installed | ORM models, queries | All existing models use this |
| FastAPI | installed | Backend endpoints | All routes in main.py |
| httpx | installed | SENAITE API calls | Used throughout main.py |
| Pydantic v2 | installed | Request/response schemas | All BaseModel classes |
| React + Zustand v5 | installed | Frontend state | ui-store.ts, all admin pages |
| shadcn/ui | installed | UI primitives | Table, Badge, Button, Input, Checkbox |
| Tailwind v4 | installed | Styling | All class-based styling |
| sonner | installed | Toast notifications | All admin pages use `toast` from sonner |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| lucide-react | installed | Icons | All icons in sidebar and admin pages |
| class-variance-authority (cva) | installed | Badge variant extension | When adding color variants to Badge |

**No new packages needed.** All required libraries are already installed.

## Architecture Patterns

### Recommended Project Structure for New Files
```
backend/
└── models.py              # Add ServiceGroup, ServiceGroupMember models
└── main.py                # Add service group CRUD + analyst endpoints

src/
├── store/
│   └── ui-store.ts        # Extend HPLCAnalysisSubSection union + LIMSSubSection
├── lib/
│   └── api.ts             # Add ServiceGroup types + API functions
├── components/
│   ├── layout/
│   │   ├── AppSidebar.tsx        # Add nav sub-items
│   │   └── MainWindowContent.tsx # Add render cases
│   └── hplc/
│       ├── ServiceGroupsPage.tsx # New admin page (mirrors AnalysisServicesPage)
│       ├── WorksheetsInboxPage.tsx  # New placeholder
│       └── WorksheetsListPage.tsx   # New placeholder
```

### Pattern 1: SQLAlchemy M2M Junction Table (verified from models.py lines 164-172)
**What:** Core table for many-to-many association
**When to use:** `service_group_members` table
```python
# Source: backend/models.py lines 164-172
service_group_members = Table(
    "service_group_members",
    Base.metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("service_group_id", Integer, ForeignKey("service_groups.id", ondelete="CASCADE"), nullable=False),
    Column("analysis_service_id", Integer, ForeignKey("analysis_services.id", ondelete="CASCADE"), nullable=False),
    UniqueConstraint("service_group_id", "analysis_service_id", name="uq_service_group_member"),
)
```

### Pattern 2: SQLAlchemy Mapped Model with created_at/updated_at (verified from models.py)
**What:** Standard model definition for service_groups table
```python
# Source: backend/models.py — AnalysisService model pattern
class ServiceGroup(Base):
    __tablename__ = "service_groups"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    color: Mapped[str] = mapped_column(String(50), nullable=False, default="blue")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    analysis_services: Mapped[list["AnalysisService"]] = relationship(
        "AnalysisService", secondary=service_group_members
    )
```

### Pattern 3: FastAPI CRUD Endpoints (verified from main.py lines 1994-2037)
**What:** Standard GET/POST/PUT/DELETE for a resource
**When to use:** Service groups endpoints

```python
# Source: backend/main.py lines 1994-2037 (methods CRUD pattern)
@app.get("/service-groups", response_model=list[ServiceGroupResponse])
async def get_service_groups(db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    groups = db.execute(select(ServiceGroup).order_by(ServiceGroup.sort_order, ServiceGroup.name)).scalars().all()
    return [ServiceGroupResponse.model_validate(g) for g in groups]

@app.post("/service-groups", response_model=ServiceGroupResponse, status_code=201)
async def create_service_group(data: ServiceGroupCreate, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    existing = db.execute(select(ServiceGroup).where(ServiceGroup.name == data.name)).scalar_one_or_none()
    if existing:
        raise HTTPException(400, f"Service group '{data.name}' already exists")
    group = ServiceGroup(**data.model_dump())
    db.add(group)
    db.commit()
    db.refresh(group)
    return ServiceGroupResponse.model_validate(group)

@app.put("/service-groups/{group_id}", response_model=ServiceGroupResponse)
async def update_service_group(group_id: int, data: ServiceGroupUpdate, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    group = db.execute(select(ServiceGroup).where(ServiceGroup.id == group_id)).scalar_one_or_none()
    if not group:
        raise HTTPException(404, f"Service group {group_id} not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(group, field, value)
    db.commit()
    db.refresh(group)
    return ServiceGroupResponse.model_validate(group)

@app.delete("/service-groups/{group_id}")
async def delete_service_group(group_id: int, db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    group = db.execute(select(ServiceGroup).where(ServiceGroup.id == group_id)).scalar_one_or_none()
    if not group:
        raise HTTPException(404, f"Service group {group_id} not found")
    db.delete(group)
    db.commit()
    return {"message": f"Service group '{group.name}' deleted"}
```

### Pattern 4: M2M Membership Endpoint
**What:** Replace-all membership endpoint (simpler than add/remove individual)
```python
@app.put("/service-groups/{group_id}/members")
async def set_service_group_members(
    group_id: int,
    data: ServiceGroupMembersRequest,  # {"analysis_service_ids": [1, 2, 3]}
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    group = db.execute(
        select(ServiceGroup).options(joinedload(ServiceGroup.analysis_services))
        .where(ServiceGroup.id == group_id)
    ).scalar_one_or_none()
    if not group:
        raise HTTPException(404, f"Service group {group_id} not found")
    services = db.execute(
        select(AnalysisService).where(AnalysisService.id.in_(data.analysis_service_ids))
    ).scalars().all()
    group.analysis_services = list(services)
    db.commit()
    return {"count": len(services)}
```

### Pattern 5: SENAITE Analyst Endpoints (verified from main.py lines 9892-9950)
```python
# GET analysts — proxy to SENAITE LabContact
@app.get("/senaite/analysts")
async def get_senaite_analysts(current_user=Depends(get_current_user)):
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=5.0),
        auth=_get_senaite_auth(current_user),
        follow_redirects=True,
    ) as client:
        resp = await client.get(
            f"{SENAITE_URL}/senaite/@@API/senaite/v1/LabContact",
            params={"complete": "yes", "limit": 200},
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])
        return [{"username": i.get("getUsername"), "fullname": i.get("getFullname", i.get("title", ""))} for i in items]

# POST analyst assignment — mirrors method-instrument pattern exactly
@app.post("/senaite/analyses/{uid}/analyst")
async def set_analysis_analyst(uid: str, req: AnalystAssignRequest, current_user=Depends(get_current_user)):
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=5.0),
        auth=_get_senaite_auth(current_user),
        follow_redirects=True,
    ) as client:
        resp = await client.post(
            f"{SENAITE_URL}/senaite/@@API/senaite/v1/update/{uid}",
            json={"Analyst": req.analyst_value},
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])
        return {"success": bool(items), "analyst_stored": items[0].get("Analyst") if items else None}
```

### Pattern 6: Zustand Navigation Extension (verified from ui-store.ts)
```typescript
// src/store/ui-store.ts — extend the union types
export type LIMSSubSection = 'instruments' | 'methods' | 'peptide-config' | 'analysis-services' | 'service-groups'
export type HPLCAnalysisSubSection = 'overview' | 'new-analysis' | 'import-analysis' | 'analysis-history' | 'sample-preps' | 'inbox' | 'worksheets' | 'worksheet-detail'
```

### Pattern 7: AppSidebar Nav Item Addition (verified from AppSidebar.tsx)
```typescript
// src/components/layout/AppSidebar.tsx
// Add to lims subItems array:
{ id: 'service-groups', label: 'Service Groups', adminOnly: true }

// Add to hplc-analysis subItems array:
{ id: 'inbox', label: 'Inbox' },
{ id: 'worksheets', label: 'Worksheets' },
```

### Pattern 8: Color Badge (inline className approach)
**Why:** The Badge component only has `default | secondary | destructive | outline` variants. Color-keyed badges use `className` directly.
```typescript
// Color map — use in ServiceGroupsPage and eventually Inbox
const COLOR_CLASSES: Record<string, string> = {
  blue:    'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300',
  amber:   'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300',
  emerald: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300',
  red:     'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300',
  violet:  'bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300',
  zinc:    'bg-zinc-100 text-zinc-800 border-zinc-200 dark:bg-zinc-900/30 dark:text-zinc-300',
  rose:    'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300',
  sky:     'bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300',
}

// Usage — Badge with inline color
<Badge className={cn(COLOR_CLASSES[group.color] ?? COLOR_CLASSES.blue)}>
  {group.name}
</Badge>
```

### Pattern 9: Admin Page Frontend (verified from AnalysisServicesPage.tsx)
```typescript
// useState + useCallback + useEffect — NO TanStack Query on admin pages
const [groups, setGroups] = useState<ServiceGroupRecord[]>([])
const [loading, setLoading] = useState(true)
const [error, setError] = useState<string | null>(null)
const [selectedId, setSelectedId] = useState<number | null>(null)

const load = useCallback(async () => {
  setLoading(true)
  setError(null)
  try {
    const data = await getServiceGroups()
    setGroups(data)
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to load service groups')
  } finally {
    setLoading(false)
  }
}, [])

useEffect(() => { load() }, [load])
```

### Anti-Patterns to Avoid
- **Using TanStack Query on admin pages:** All existing admin pages (Instruments, Methods, AnalysisServices) use direct fetch + useState. Match this pattern.
- **Free-form color picker:** D-04 locks this to predefined palette — no `<input type="color">`.
- **Zustand destructuring:** `const { navigateTo } = useUIStore()` — causes render cascades. Use selector syntax: `const navigateTo = useUIStore(state => state.navigateTo)`.
- **String-based invoke:** Never use `invoke('command')` — this project uses tauri-specta typed commands for Tauri calls, but direct `fetch` for local backend API calls.
- **SQLite assumption:** The database is PostgreSQL. database.py uses `psycopg2` with `accumark_mk1` database.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Color badge display | Custom CSS color components | Badge with className override | Badge component already handles sizing, border-radius, font-weight |
| Slide-out panel animation | Custom CSS animation component | Inline `style={{ animation: 'slideInRight 0.25s ease-out' }}` | Already used in AnalysisServicesPage — copy verbatim |
| Checkbox membership editor | Custom checkbox UI | shadcn/ui `Checkbox` at `@/components/ui/checkbox` | Already installed |
| SENAITE auth | Custom auth header logic | `_get_senaite_auth(current_user)` | Handles user-credential fallback to admin |
| Table primitives | HTML table | shadcn/ui `Table, TableHeader, TableBody, TableRow, TableCell, TableHead` | Already used on all admin pages |
| Toast notifications | Custom notification system | `toast` from `sonner` | Already imported on all admin pages |
| DB migration | Alembic | `_run_migrations()` in database.py | Project pattern: lightweight ALTER TABLE list, new tables handled by `create_all` |

**Key insight:** Every UI primitive needed for this phase is already installed and used on neighboring pages. The implementation is largely copy-adapt-extend work.

## Common Pitfalls

### Pitfall 1: PostgreSQL vs SQLite Assumption
**What goes wrong:** STATE.md mentions SQLite but the database is PostgreSQL. Code using SQLite-specific syntax (e.g., `AUTOINCREMENT` instead of `autoincrement=True`, `TEXT` vs Mapped types) will fail.
**Why it happens:** Stale documentation; database.py clearly shows `psycopg2`.
**How to avoid:** Follow existing models.py patterns exactly. Use `Mapped[Optional[str]]`, not raw `Column(String)`.
**Warning signs:** `OperationalError: could not connect to server` if PG isn't running; `psycopg2.errors` in logs.

### Pitfall 2: New Tables Need create_all to Run
**What goes wrong:** Adding models.py classes is not enough — `init_db()` must run (on next backend startup) to actually create the tables.
**Why it happens:** `create_all` only creates missing tables, doesn't alter existing ones.
**How to avoid:** Models for brand-new tables (`service_groups`, `service_group_members`) are safe to add and will be created by `create_all` on startup. No migration entry needed in `_run_migrations()` for net-new tables.
**Warning signs:** `relation "service_groups" does not exist` in backend logs.

### Pitfall 3: SENAITE Analyst Field Format Unknown
**What goes wrong:** Sending a username string when SENAITE expects a UID (or vice versa) results in the field silently not updating or a 400 error.
**Why it happens:** SENAITE's REST API is inconsistent across field types — reference fields (like `Analyst`) may require UID while scalar fields accept strings.
**How to avoid:** D-10 mandates a test/verification step. Create a dedicated test endpoint that sends both formats and reads back the stored value.
**Warning signs:** SENAITE update returns 200 with `items` but `Analyst` field in response is null or unchanged.

### Pitfall 4: HPLCAnalysisSubSection Union Causes Type Errors if Incomplete
**What goes wrong:** Adding `'inbox'` to the sidebar navItems array without adding it to the TypeScript union type causes TypeScript errors in `navigateTo(section, subSection)` calls.
**Why it happens:** `navigateTo` is typed as `(section: ActiveSection, subSection: ActiveSubSection)` and `ActiveSubSection` is a union of all sub-section types.
**How to avoid:** Update `HPLCAnalysisSubSection` in ui-store.ts first, before adding sidebar items or MainWindowContent cases.
**Warning signs:** TypeScript error "Argument of type 'inbox' is not assignable to parameter of type 'ActiveSubSection'".

### Pitfall 5: SENAITE LabContact Username Field
**What goes wrong:** LabContact objects from SENAITE use `getUsername` (getter method name), not `username`. Mapping incorrectly produces null usernames.
**Why it happens:** SENAITE's REST API serializes Plone content using getter method names for some fields.
**How to avoid:** Use `i.get("getUsername")` when parsing LabContact items (see pattern in sync_analysis_services where `getCategoryTitle` is used for category resolution).
**Warning signs:** Analyst dropdown shows empty strings or nulls.

### Pitfall 6: M2M Relationship Needs joinedload for Member Count
**What goes wrong:** Querying service groups without `options(joinedload(ServiceGroup.analysis_services))` causes N+1 queries when computing member counts.
**Why it happens:** SQLAlchemy lazy-loads relationships by default.
**How to avoid:** Add `joinedload` in the GET endpoint, or query count separately. The methods endpoint example: `select(HplcMethod).options(joinedload(HplcMethod.instrument), joinedload(HplcMethod.peptides))`.

### Pitfall 7: Slide-out Panel Backdrop on LIMS (adminOnly)
**What goes wrong:** The slide-out panel `fixed inset-0` overlay appears over the sidebar, which looks wrong if the sidebar is collapsible.
**Why it happens:** `z-40` backdrop + `z-50` panel sit above all content — the pattern is copied from AnalysisServicesPage where it works correctly.
**How to avoid:** Use the exact same z-index values as AnalysisServicesPage (`z-40` for backdrop, `z-50` for panel). Do not change.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Alembic migrations | `_run_migrations()` + `create_all` | Established in project | Add ALTER TABLE entries for column additions; new tables via `create_all` |
| TanStack Query everywhere | TanStack Query only for persistent data; useState for admin pages | Established in AGENTS.md | Admin pages (Instruments, Methods, etc.) use useState + useCallback |
| SQLite | PostgreSQL | Long established | database.py uses psycopg2 |

## Open Questions

1. **SENAITE Analyst field format (ANLY-03 — highest risk)**
   - What we know: The endpoint is `POST /update/{uid}` with `{"Analyst": value}`; method-instrument uses UIDs for Method and Instrument fields
   - What's unclear: Does `Analyst` accept a username string, a UID, or a user path?
   - Recommendation: Implement a test endpoint `POST /senaite/analyses/{uid}/analyst-test` that sends both formats and returns the raw SENAITE response for inspection. This must be resolved before Phase 16.

2. **SENAITE LabContact API endpoint URL**
   - What we know: D-11 specifies `GET /senaite/@@API/senaite/v1/LabContact?complete=yes`
   - What's unclear: Some SENAITE instances use `LabContact` portal type search; others expose it differently. May need `?portal_type=LabContact` query.
   - Recommendation: Try the direct URL first; if it returns empty, fall back to `search?portal_type=LabContact&complete=yes`.

3. **Service Groups adminOnly flag**
   - What we know: D-01 places Service Groups under LIMS as an admin concept
   - What's unclear: Should the sidebar sub-item use `adminOnly: true` (like User Management)?
   - Recommendation: Mark `adminOnly: true` — service group management is a configuration operation only admins should perform.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| PostgreSQL | Data model (service_groups tables) | Assumed ✓ | Per deployment | — |
| SENAITE instance | ANLY-01, ANLY-02, ANLY-03 | Assumed ✓ | Per deployment | Endpoints return 502 with informative error |
| httpx | SENAITE API calls | ✓ | installed | — |
| shadcn/ui Checkbox | SGRP-02 membership editor | ✓ | installed at `src/components/ui/checkbox.tsx` | — |

**Missing dependencies with no fallback:** None identified.
**Note:** SENAITE availability is required for ANLY-03 live verification. Backend endpoints include graceful `SENAITE_URL is None` guards matching existing patterns.

## Validation Architecture

> `workflow.nyquist_validation` is absent from config.json — treating as enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (backend/tests/) |
| Config file | none detected — uses pytest defaults |
| Quick run command | `cd backend && python -m pytest tests/ -x -q` |
| Full suite command | `cd backend && python -m pytest tests/` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SGRP-01 | Create, update, delete service group via API | unit (FastAPI TestClient) | `pytest tests/test_service_groups.py -x` | ❌ Wave 0 |
| SGRP-02 | Set membership via PUT /service-groups/{id}/members | unit | `pytest tests/test_service_groups.py::test_set_members -x` | ❌ Wave 0 |
| SGRP-03 | Response includes member count | unit | `pytest tests/test_service_groups.py::test_member_count -x` | ❌ Wave 0 |
| SGRP-04 | Tables exist in PostgreSQL after startup | integration | `pytest tests/test_service_groups.py::test_tables_exist -x` | ❌ Wave 0 |
| ANLY-01 | GET /senaite/analysts returns list | manual/smoke | manual — requires live SENAITE | — |
| ANLY-02 | POST analyst assignment returns success | manual/smoke | manual — requires live SENAITE | — |
| ANLY-03 | Analyst field format verified | manual | manual inspection of SENAITE response | — |
| NAVG-01 | Worksheets sub-items render in sidebar | smoke | visual inspection after `npm run dev` | — |
| NAVG-02 | Hash navigation round-trips for inbox/worksheets | smoke | visual inspection | — |

### Sampling Rate
- **Per task commit:** `cd backend && python -m pytest tests/test_service_groups.py -x -q`
- **Per wave merge:** `cd backend && python -m pytest tests/ -q`
- **Phase gate:** Full backend test suite green + ANLY-03 verified manually before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `backend/tests/test_service_groups.py` — covers SGRP-01 through SGRP-04
- [ ] Test fixtures for authenticated test client (check if `backend/tests/conftest.py` exists)

## Project Constraints (from CLAUDE.md)

- **npm only** — use `npm install`, `npm run`, never `pnpm`
- **Tauri v2 docs only** — not v1
- **No TanStack Query on admin pages** — useState + useCallback pattern
- **Zustand selector syntax** — `const x = useUIStore(state => state.x)` not destructuring
- **tauri-specta typed commands** — for Tauri commands; direct `fetch` for backend API calls
- **No manual useMemo/useCallback for memoization** — React Compiler handles it
- **Run `npm run check:all` after significant changes**
- **No dev server** — ask user to run and report back
- **No unsolicited commits**
- **`rm -f` for file deletion**
- **Modern Rust formatting** — `format!("{variable}")` not `format!("{}", variable)`
- **Version targets:** Tauri v2.x, shadcn/ui v4.x, Tailwind v4.x, React 19.x, Zustand v5.x, Vite v7.x, Vitest v4.x
- **frontend-design skill** available at `.claude/skills/frontend-design/` — user requested for worksheet/service group screens

## Sources

### Primary (HIGH confidence)
- `backend/models.py` — verified M2M junction pattern, AnalysisService model, all SQLAlchemy imports
- `backend/main.py` lines 9892-9950 — verified httpx AsyncClient + `_get_senaite_auth` pattern
- `backend/main.py` lines 1994-2037 — verified CRUD endpoint pattern (methods)
- `backend/database.py` — verified PostgreSQL engine, `_run_migrations()` pattern, `create_all`
- `src/store/ui-store.ts` — verified union types, `navigateTo` signature
- `src/lib/hash-navigation.ts` — verified VALID_SECTIONS, sub-section passthrough
- `src/components/layout/AppSidebar.tsx` — verified navItems structure, adminOnly flag
- `src/components/layout/MainWindowContent.tsx` — verified section switch pattern
- `src/components/hplc/AnalysisServicesPage.tsx` — verified slide-out panel animation pattern
- `src/components/ui/badge.tsx` — verified available variants (4 only: default/secondary/destructive/outline)
- `src/components/ui/checkbox.tsx` — confirmed present

### Secondary (MEDIUM confidence)
- SENAITE LabContact API: `GET /senaite/@@API/senaite/v1/LabContact?complete=yes` — inferred from D-11 and existing SENAITE API patterns in main.py. Needs live verification.
- SENAITE `getUsername` field name — inferred from `getCategoryTitle` pattern in sync_analysis_services and general SENAITE convention.

### Tertiary (LOW confidence)
- SENAITE Analyst field accepts username vs UID — cannot determine without live test. Flagged as risk item.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries confirmed installed, versions from AGENTS.md
- Architecture: HIGH — all patterns directly verified from source files
- Pitfalls: HIGH for PostgreSQL/TypeScript issues (verified code); MEDIUM for SENAITE API details (runtime behavior)
- SENAITE field format: LOW — requires live verification (ANLY-03)

**Research date:** 2026-03-31
**Valid until:** 2026-05-01 (stable domain; SENAITE API behavior requires re-verification if SENAITE version changes)
