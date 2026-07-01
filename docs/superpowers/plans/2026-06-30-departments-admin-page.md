# Departments Admin Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only **Departments** page to Accu-Mk1 (cloned from the Instruments page) that lists catalog departments and lets an admin create, edit, and delete them via an editable slide-out flyout, backed by new `PUT`/`DELETE /departments/{id}` endpoints.

**Architecture:** Additive. Extends the Plan 1A departments API (`GET`/`POST /departments`, `Department` model) with an update + guarded-delete endpoint and computed counts; adds one new frontend page + four api.ts client functions + a nav entry. No existing behavior changes.

**Tech Stack:** Python 3 / FastAPI, SQLAlchemy 2.0, pytest (against the mounted **`catalog`** devbox stack — see Global Constraints). Frontend: React + TypeScript, shadcn/ui (`Card`/`Table`/`Button`/`Input`/`Badge`), `sonner` toasts, Vitest 4. Spec: `docs/superpowers/specs/2026-06-30-departments-admin-page-design.md`.

## Global Constraints

- **Additive only.** New endpoints/fields/page extend the 1A catalog; do not change existing routing or the 1A `GET`/`POST /departments` behavior (except adding admin-gating to POST).
- **`is_system` is never user-editable.** Omit it from `DepartmentUpdate`; render it read-only in the UI.
- **Delete guard is load-bearing.** `DELETE` must 409 when `is_system` OR any `service_groups`/`analysis_services` reference the department (`department_id` FK is `ON DELETE SET NULL` — an unguarded delete silently NULLs services' departments and drops analytical ones from HPLC mirroring). (spec: "Delete guard")
- **`service_count` is a direct `COUNT(analysis_services WHERE department_id=id)`**, NOT a sum of group member counts (which would miss ungrouped analytical services like `ANALYTE-N-*`). (spec: "Response counts")
- **Admin-gating:** POST/PUT/DELETE use `require_admin` (`backend/auth.py`); GET stays `get_current_user`. The nav item + page are `adminOnly`.
- **Test environment (cross-machine):** the laptop worktree `C:/tmp/Accu-Mk1-departments` has no Python. **Backend pytest runs on the devbox `catalog` stack** (mounted to `~/worktrees/Accu-Mk1-departments`, `uvicorn --reload`). Backend test cycle: `git commit` + `git push`, then `ssh forrestparker@100.73.137.3 'git -C ~/worktrees/Accu-Mk1-departments pull -q'`, then `ssh forrestparker@100.73.137.3 'docker exec accumark-catalog-accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_departments_admin.py -q"'`. Given the round-trip cost, verify **GREEN after implementation** (tests still assert real behavior); a separate RED run is optional. **Frontend** vitest + `npm run typecheck` run locally on the laptop worktree — no stack needed.
- **npm only** (never pnpm). **Never `git add -A`** — stage explicit paths.
- Follow existing patterns: clone `src/components/hplc/InstrumentsPage.tsx` for layout; reuse `src/lib/service-group-colors.ts` (`COLOR_OPTIONS`) for the color picker.

---

## File Structure

- **Modify** `backend/main.py` — `DepartmentUpdate` schema; `group_count`/`service_count` on `DepartmentResponse` + a `_department_counts` helper wired into `get_departments`/`create_department`/`update_department`; `PUT /departments/{id}`; `DELETE /departments/{id}`; add `require_admin` to `create_department`.
- **Create** `backend/tests/test_departments_admin.py` — PUT / DELETE / counts / admin-gating tests.
- **Modify** `src/lib/api.ts` — extend `Department` interface with `group_count`/`service_count`; add `DepartmentInput` + `getDepartments`/`createDepartment`/`updateDepartment`/`deleteDepartment`.
- **Create** `src/components/hplc/DepartmentsPage.tsx` — the page (list + search + Add button + editable flyout with delete).
- **Modify** `src/components/layout/AppSidebar.tsx` — add the `departments` LIMS nav item.
- **Modify** `src/components/layout/MainWindowContent.tsx` — route `departments` → `<DepartmentsPage />`.
- **Create** `src/lib/__tests__/departments-page.test.tsx` — vitest for list/filter + flyout create/edit state.

**Task order:** 1 (PUT + counts) → 2 (DELETE) → 3 (api.ts) → 4 (page + nav). Backend before frontend so the api.ts client targets real endpoints.

---

## Task 1: Backend — `DepartmentUpdate`, response counts, `PUT /departments/{id}`, admin-gate POST

**Files:**
- Modify: `backend/main.py` (schemas ~line 2099-2116; routes ~line 13805-13838)
- Test: `backend/tests/test_departments_admin.py` (create)

**Interfaces:**
- Produces: `DepartmentResponse` now includes `group_count: int`, `service_count: int`. `PUT /departments/{id}` accepts `{name?, color?, sort_order?}`, returns `DepartmentResponse`, 400 on duplicate name, 404 if missing, 403 for non-admin. `create_department`/`update_department` responses carry the counts. Helper `_department_counts(db, dept_id) -> tuple[int, int]`.

- [ ] **Step 1: Write the tests**

Create `backend/tests/test_departments_admin.py`:

```python
"""Departments admin API: update, counts, admin-gating. Runs against the live
catalog DB (SessionLocal) via TestClient; all rows created here use a ZZDEPT-
prefix and are deleted in teardown so nothing persists."""
import pytest
from fastapi.testclient import TestClient
import main
from database import SessionLocal
from models import Department, User, ServiceGroup, AnalysisService
from auth import get_password_hash, create_access_token


@pytest.fixture
def client():
    return TestClient(main.app)


def _token(role: str) -> str:
    db = SessionLocal()
    try:
        email = f"zzdept-{role}@test.local"
        u = db.query(User).filter_by(email=email).one_or_none()
        if u is None:
            u = User(email=email, hashed_password=get_password_hash("x"), role=role, is_active=True)
            db.add(u); db.commit(); db.refresh(u)
        return create_access_token({"sub": str(u.id)})
    finally:
        db.close()


def _auth(role="admin"):
    return {"Authorization": f"Bearer {_token(role)}"}


@pytest.fixture
def dept():
    db = SessionLocal()
    d = Department(name="ZZDEPT-A", color="blue", sort_order=5)
    db.add(d); db.commit(); db.refresh(d)
    did = d.id
    db.close()
    yield did
    db = SessionLocal()
    row = db.get(Department, did)
    if row: db.delete(row); db.commit()
    db.close()


def test_response_carries_counts(client, dept):
    r = client.get("/departments", headers=_auth())
    assert r.status_code == 200
    row = next(d for d in r.json() if d["id"] == dept)
    assert row["group_count"] == 0 and row["service_count"] == 0


def test_put_updates_fields(client, dept):
    r = client.put(f"/departments/{dept}", json={"name": "ZZDEPT-A2", "color": "green", "sort_order": 9}, headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "ZZDEPT-A2" and body["color"] == "green" and body["sort_order"] == 9
    assert "group_count" in body and "service_count" in body


def test_put_rejects_duplicate_name(client, dept):
    db = SessionLocal(); other = Department(name="ZZDEPT-OTHER"); db.add(other); db.commit(); oid = other.id; db.close()
    try:
        r = client.put(f"/departments/{dept}", json={"name": "ZZDEPT-OTHER"}, headers=_auth())
        assert r.status_code == 400
    finally:
        db = SessionLocal(); db.delete(db.get(Department, oid)); db.commit(); db.close()


def test_put_404_missing(client):
    assert client.put("/departments/99999999", json={"name": "X"}, headers=_auth()).status_code == 404


def test_put_requires_admin(client, dept):
    assert client.put(f"/departments/{dept}", json={"name": "Nope"}, headers=_auth("standard")).status_code == 403


def test_post_requires_admin(client):
    assert client.post("/departments", json={"name": "ZZDEPT-NEW"}, headers=_auth("standard")).status_code == 403
```

- [ ] **Step 2: Implement the schema + counts helper + PUT + admin-gate**

In `backend/main.py`, add after `DepartmentResponse` (~line 2116):

```python
class DepartmentUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None
    # is_system intentionally omitted — not user-editable.
```

Add `group_count`/`service_count` to `DepartmentResponse`:

```python
class DepartmentResponse(BaseModel):
    id: int
    name: str
    sort_order: int
    color: str
    is_system: bool
    group_count: int = 0
    service_count: int = 0
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
```

Add a counts helper + a serializer near the department routes (~line 13805):

```python
def _department_counts(db: Session, dept_id: int) -> tuple[int, int]:
    from models import ServiceGroup, AnalysisService
    from sqlalchemy import func
    groups = db.query(func.count(ServiceGroup.id)).filter(ServiceGroup.department_id == dept_id).scalar() or 0
    services = db.query(func.count(AnalysisService.id)).filter(AnalysisService.department_id == dept_id).scalar() or 0
    return groups, services


def _department_out(db: Session, dept) -> "DepartmentResponse":
    g, s = _department_counts(db, dept.id)
    return DepartmentResponse(
        id=dept.id, name=dept.name, sort_order=dept.sort_order, color=dept.color,
        is_system=dept.is_system, group_count=g, service_count=s,
        created_at=dept.created_at, updated_at=dept.updated_at,
    )
```

Update `get_departments` to return serialized rows with counts:

```python
@app.get("/departments", response_model=list[DepartmentResponse])
async def get_departments(db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Return all departments ordered by sort_order, name (with group/service counts)."""
    from models import Department
    rows = db.execute(select(Department).order_by(Department.sort_order, Department.name)).scalars().all()
    return [_department_out(db, d) for d in rows]
```

Change `create_department` to admin-gated + return counts:

```python
@app.post("/departments", response_model=DepartmentResponse, status_code=201)
async def create_department(data: DepartmentCreate, db: Session = Depends(get_db), _current_user=Depends(require_admin)):
    """Create a new department (admin)."""
    from models import Department
    if db.execute(select(Department).where(Department.name == data.name)).scalar_one_or_none():
        raise HTTPException(400, f"Department '{data.name}' already exists")
    dept = Department(**data.model_dump()); db.add(dept); db.commit(); db.refresh(dept)
    return _department_out(db, dept)
```

Add the PUT route:

```python
@app.put("/departments/{department_id}", response_model=DepartmentResponse)
async def update_department(department_id: int, data: DepartmentUpdate, db: Session = Depends(get_db), _current_user=Depends(require_admin)):
    """Update a department's name/color/sort_order (admin). is_system is immutable."""
    from models import Department
    dept = db.get(Department, department_id)
    if dept is None:
        raise HTTPException(404, "Department not found")
    if data.name is not None and data.name != dept.name:
        clash = db.execute(select(Department).where(Department.name == data.name, Department.id != department_id)).scalar_one_or_none()
        if clash:
            raise HTTPException(400, f"Department '{data.name}' already exists")
        dept.name = data.name
    if data.color is not None:
        dept.color = data.color
    if data.sort_order is not None:
        dept.sort_order = data.sort_order
    db.commit(); db.refresh(dept)
    return _department_out(db, dept)
```

Ensure `require_admin` is imported (it's in the `from auth import ...` block at ~line 45; add it if absent).

- [ ] **Step 3: Verify GREEN on the catalog stack**

```bash
git add backend/main.py backend/tests/test_departments_admin.py
git commit -m "feat(catalog): department PUT + response counts + admin-gate POST"
git push -u origin feat/catalog-departments-admin
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/Accu-Mk1-departments pull -q && docker exec accumark-catalog-accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_departments_admin.py -q"'
```
Expected: all tests PASS (uvicorn --reload picks up the pulled code). If `require_admin`/`create_access_token` import paths differ, fix and re-run.

---

## Task 2: Backend — `DELETE /departments/{id}` with guard

**Files:**
- Modify: `backend/main.py` (add DELETE route near the others)
- Test: `backend/tests/test_departments_admin.py` (append)

**Interfaces:**
- Consumes: `_department_counts` (Task 1).
- Produces: `DELETE /departments/{id}` → 204 (no dependents), 409 (`is_system` or has dependents), 404 (missing), 403 (non-admin).

- [ ] **Step 1: Append the tests**

Add to `backend/tests/test_departments_admin.py`:

```python
def test_delete_ok_no_dependents(client):
    db = SessionLocal(); d = Department(name="ZZDEPT-DEL"); db.add(d); db.commit(); did = d.id; db.close()
    r = client.delete(f"/departments/{did}", headers=_auth())
    assert r.status_code == 204
    db = SessionLocal(); assert db.get(Department, did) is None; db.close()


def test_delete_blocked_by_service(client, dept):
    db = SessionLocal()
    svc = AnalysisService(keyword="ZZDEPT-SVC", title="zz", department_id=dept)
    db.add(svc); db.commit(); sid = svc.id; db.close()
    try:
        r = client.delete(f"/departments/{dept}", headers=_auth())
        assert r.status_code == 409
        assert "service" in r.json()["detail"].lower()
    finally:
        db = SessionLocal(); db.delete(db.get(AnalysisService, sid)); db.commit(); db.close()


def test_delete_blocked_when_system(client):
    db = SessionLocal(); d = Department(name="ZZDEPT-SYS", is_system=True); db.add(d); db.commit(); did = d.id; db.close()
    try:
        assert client.delete(f"/departments/{did}", headers=_auth()).status_code == 409
    finally:
        db = SessionLocal(); db.delete(db.get(Department, did)); db.commit(); db.close()


def test_delete_requires_admin(client, dept):
    assert client.delete(f"/departments/{dept}", headers=_auth("standard")).status_code == 403


def test_delete_404_missing(client):
    assert client.delete("/departments/99999999", headers=_auth()).status_code == 404
```

- [ ] **Step 2: Implement the DELETE route**

Add to `backend/main.py` after `update_department`:

```python
@app.delete("/departments/{department_id}", status_code=204)
async def delete_department(department_id: int, db: Session = Depends(get_db), _current_user=Depends(require_admin)):
    """Delete a department (admin). Refused for system departments or any with
    dependent groups/services — the department_id FK is ON DELETE SET NULL, so
    deleting one in use would silently orphan its services' department (and drop
    analytical services from HPLC mirroring)."""
    from models import Department
    dept = db.get(Department, department_id)
    if dept is None:
        raise HTTPException(404, "Department not found")
    if dept.is_system:
        raise HTTPException(409, f"Department '{dept.name}' is a system department and cannot be deleted.")
    groups, services = _department_counts(db, department_id)
    if groups or services:
        raise HTTPException(409, f"Department '{dept.name}' still has {groups} service group(s) and {services} service(s). Reassign them before deleting.")
    db.delete(dept); db.commit()
    return None
```

- [ ] **Step 3: Verify GREEN on the catalog stack**

```bash
git add backend/main.py backend/tests/test_departments_admin.py
git commit -m "feat(catalog): guarded DELETE /departments/{id}"
git push
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/Accu-Mk1-departments pull -q && docker exec accumark-catalog-accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_departments_admin.py -q"'
```
Expected: all department-admin tests PASS.

---

## Task 3: Frontend — api.ts client + types

**Files:**
- Modify: `src/lib/api.ts` (`Department` interface ~line 4173; add functions)

**Interfaces:**
- Consumes: `PUT`/`DELETE /departments/{id}`, extended `GET`/`POST` (Tasks 1-2).
- Produces: `Department` (now with `group_count`/`service_count`), `DepartmentInput`, `getDepartments()`, `createDepartment(data)`, `updateDepartment(id, data)`, `deleteDepartment(id)`.

- [ ] **Step 1: Extend the interface + add the client functions**

In `src/lib/api.ts`, extend the `Department` interface (~line 4173):

```ts
export interface Department {
  id: number
  name: string
  sort_order: number
  color: string
  is_system: boolean
  group_count: number
  service_count: number
  created_at: string
  updated_at: string
}

export interface DepartmentInput {
  name: string
  color?: string
  sort_order?: number
}
```

Add the client functions (match the file's existing fetch-wrapper style — find how `getInstruments`/`syncInstruments` call the API and mirror it exactly: same base URL constant, auth header helper, and error handling). Illustrative shape:

```ts
export async function getDepartments(): Promise<Department[]> {
  return apiFetch('/departments')
}
export async function createDepartment(data: DepartmentInput): Promise<Department> {
  return apiFetch('/departments', { method: 'POST', body: JSON.stringify(data) })
}
export async function updateDepartment(id: number, data: Partial<DepartmentInput>): Promise<Department> {
  return apiFetch(`/departments/${id}`, { method: 'PUT', body: JSON.stringify(data) })
}
export async function deleteDepartment(id: number): Promise<void> {
  await apiFetch(`/departments/${id}`, { method: 'DELETE' })
}
```

**Important:** replace `apiFetch(...)` with whatever wrapper `getInstruments` actually uses in this file (e.g. a local `request()`/`apiClient` helper). Read `getInstruments` + `getServiceGroups` first and copy their exact call convention, including how JSON bodies and headers are set and how a 204 (no body) is handled for `deleteDepartment`.

- [ ] **Step 2: Typecheck**

Run (in `C:/tmp/Accu-Mk1-departments`): `npm run typecheck`
Expected: no new errors (a pre-existing `qrcode.react` error in `LabelTemplate.tsx` is unrelated — ignore it).

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(catalog): api.ts department client (get/create/update/delete)"
```

---

## Task 4: Frontend — DepartmentsPage (list + editable flyout + delete) + nav + routing

**Files:**
- Create: `src/components/hplc/DepartmentsPage.tsx`
- Modify: `src/components/layout/AppSidebar.tsx` (LIMS subItems ~line 85-91)
- Modify: `src/components/layout/MainWindowContent.tsx` (route ~line 61-65)
- Test: `src/lib/__tests__/departments-page.test.tsx` (create)

**Interfaces:**
- Consumes: `getDepartments`/`createDepartment`/`updateDepartment`/`deleteDepartment`/`Department`/`DepartmentInput` (Task 3); `getServiceGroups`/`ServiceGroup` (existing); `COLOR_OPTIONS`/`SERVICE_GROUP_COLORS` (`src/lib/service-group-colors.ts`).

- [ ] **Step 1: Add the nav item + route**

In `src/components/layout/AppSidebar.tsx`, add to the `lims` `subItems` array, right after `service-groups`:

```ts
{ id: 'departments', label: 'Departments', adminOnly: true },
```

In `src/components/layout/MainWindowContent.tsx`, add an import and a branch alongside the other LIMS pages:

```ts
import { DepartmentsPage } from '@/components/hplc/DepartmentsPage'
// ...inside the LIMS section switch, next to service-groups:
if (activeSubSection === 'departments') return <DepartmentsPage />
```

- [ ] **Step 2: Write the DepartmentsPage**

Create `src/components/hplc/DepartmentsPage.tsx` by cloning `src/components/hplc/InstrumentsPage.tsx`'s structure (header + search + `Card`/`Table` list + `fixed` slide-out with backdrop + the `slideInRight`/`fadeIn` `<style>` block) and changing:

- **State:** `departments: Department[]`, `groups: ServiceGroup[]` (for the flyout list), `loading`, `error`, `searchInput`, `selectedId: number | null`, and a `mode: 'view' | 'add'` — `add` opens an empty flyout, a row click opens edit on the selected department. Load with `Promise.all([getDepartments(), getServiceGroups()])`.
- **Header button:** `<Button onClick={() => { setSelectedId(null); setMode('add') }}>Add Department</Button>` (Plus icon) — replaces "Sync from Senaite".
- **Table columns:** Name (with a color dot: `SERVICE_GROUP_COLORS[dept.color]` background), Sort Order, Service Groups (`<Badge>{dept.group_count}</Badge>`), System (`dept.is_system ? <Badge>System</Badge> : '—'`), trailing `ChevronRight`. Row `onClick` → `setSelectedId(dept.id); setMode('view')`.
- **Search:** filter by `name` (case-insensitive).
- **Flyout:** open when `mode === 'add' || selectedId !== null`. A single `DepartmentFlyout` component (below) handles both modes.

Add the flyout component in the same file:

```tsx
function DepartmentFlyout({
  mode, department, groups, onClose, onSaved,
}: {
  mode: 'add' | 'view'
  department: Department | null
  groups: ServiceGroup[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(department?.name ?? '')
  const [color, setColor] = useState(department?.color ?? 'blue')
  const [sortOrder, setSortOrder] = useState(department?.sort_order ?? 0)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const deptGroups = department ? groups.filter(g => g.department_id === department.id) : []

  const save = async () => {
    setSaving(true); setErr(null)
    try {
      if (mode === 'add') {
        await createDepartment({ name: name.trim(), color, sort_order: sortOrder })
        toast.success('Department created')
      } else if (department) {
        await updateDepartment(department.id, { name: name.trim(), color, sort_order: sortOrder })
        toast.success('Department updated')
      }
      onSaved()
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Save failed'
      setErr(m); toast.error(m)
    } finally { setSaving(false) }
  }

  const del = async () => {
    if (!department) return
    if (!window.confirm(`Delete department '${department.name}'? This cannot be undone.`)) return
    setSaving(true); setErr(null)
    try {
      await deleteDepartment(department.id)
      toast.success('Department deleted'); onSaved()
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Delete failed'
      setErr(m); toast.error(m)
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-5">
      {err && <div className="text-sm text-destructive">{err}</div>}
      <div className="space-y-1">
        <label className="text-sm font-medium">Name</label>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="Department name" />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Color</label>
        <div className="flex flex-wrap gap-2">
          {COLOR_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setColor(opt.value)}
              className={`h-7 w-7 rounded-full border-2 ${color === opt.value ? 'border-foreground' : 'border-transparent'}`}
              style={{ background: 'currentColor' }}
              title={opt.label}
            >
              <span className={`block h-full w-full rounded-full ${SERVICE_GROUP_COLORS[opt.value]?.dot ?? ''}`} />
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Sort Order</label>
        <Input type="number" value={sortOrder} onChange={e => setSortOrder(Number(e.target.value))} className="max-w-32" />
      </div>

      {mode === 'view' && department && (
        <>
          <div className="text-xs text-muted-foreground">
            {department.is_system && <Badge variant="outline" className="mr-2">System</Badge>}
            Service Groups: {department.group_count} · Services: {department.service_count}
          </div>
          <div className="border-t pt-4">
            <h4 className="mb-2 text-sm font-semibold text-muted-foreground">Service Groups ({deptGroups.length})</h4>
            {deptGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground">No service groups in this department.</p>
            ) : (
              <div className="space-y-1">
                {deptGroups.map(g => (
                  <div key={g.id} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
                    <span>{g.name}</span>
                    <Badge variant="secondary" className="text-xs">{g.member_count} service{g.member_count !== 1 ? 's' : ''}</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <div className="flex items-center gap-2 border-t pt-4">
        <Button onClick={save} disabled={saving || !name.trim()}>
          {mode === 'add' ? 'Create' : 'Save'}
        </Button>
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        {mode === 'view' && department && !department.is_system && (
          <Button variant="destructive" className="ml-auto" onClick={del} disabled={saving}>Delete</Button>
        )}
      </div>
    </div>
  )
}
```

Wire the flyout into the slide-out shell (from Instruments), passing `mode`, the selected `department` (or `null` for add), `groups`, `onClose={() => { setSelectedId(null); setMode('view') }}`, and `onSaved={async () => { setSelectedId(null); setMode('view'); await load() }}`. Import: `useState, useEffect, useCallback`, the icons (`Plus`, `Search`, `ChevronRight`, `X`, `Layers`, `Loader2`, `AlertCircle`), `Card/CardContent`, `Button`, `Input`, `Badge`, `Table*`, `toast` from `sonner`, the api functions + types, and `COLOR_OPTIONS`/`SERVICE_GROUP_COLORS`.

> **Note on `SERVICE_GROUP_COLORS[...].dot`:** read `src/lib/service-group-colors.ts` first and use the actual shape — if entries are plain class strings, use `SERVICE_GROUP_COLORS[opt.value]` directly; if they're objects, use the correct key. Match reality; do not invent a `.dot` key if it doesn't exist.

- [ ] **Step 3: Write the vitest**

Create `src/lib/__tests__/departments-page.test.tsx` (mock the api module; assert list renders, search filters, Add opens an empty form with Create disabled until a name is typed, and a row opens edit pre-filled). Mirror the testing-library patterns already used in the repo's `*.test.tsx` files (find one that renders a component with mocked `@/lib/api` and copy its setup). Cover:

```tsx
// 1. renders a row per department from a mocked getDepartments
// 2. typing in search narrows the visible rows by name
// 3. clicking "Add Department" shows the flyout with an empty Name and a disabled Create button; typing a name enables it
// 4. clicking a row shows the flyout pre-filled with that department's name + a Delete button (hidden when is_system)
```

Write the actual assertions against the real component API (render `<DepartmentsPage />` with `vi.mock('@/lib/api', ...)` returning two departments, one `is_system`). Do not leave the test as comments — implement the four cases.

- [ ] **Step 4: Test + typecheck locally**

Run (in `C:/tmp/Accu-Mk1-departments`):
```bash
npm run test:run -- src/lib/__tests__/departments-page.test.tsx
npm run typecheck
```
Expected: vitest PASS; typecheck clean (ignore the pre-existing unrelated `qrcode.react` error).

- [ ] **Step 5: Commit + deploy to the catalog stack**

```bash
git add src/components/hplc/DepartmentsPage.tsx src/components/layout/AppSidebar.tsx src/components/layout/MainWindowContent.tsx src/lib/__tests__/departments-page.test.tsx
git commit -m "feat(catalog): Departments admin page (list + editable flyout + delete)"
git push
ssh forrestparker@100.73.137.3 'git -C ~/worktrees/Accu-Mk1-departments pull -q'
```
Then hard-refresh Mk1 at `http://100.73.137.3:5592` (vite HMR) → log in as `tester@accumark.local` → LIMS → Departments.

---

## Final verification

- [ ] Backend: `ssh forrestparker@100.73.137.3 'docker exec accumark-catalog-accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_departments_admin.py -q"'` → all PASS.
- [ ] Frontend: `npm run test:run -- src/lib/__tests__/departments-page.test.tsx` PASS; `npm run typecheck` clean (modulo the pre-existing `qrcode.react` error).
- [ ] Live smoke on `catalog` stack: Departments appears in the LIMS nav (admin only); list shows existing departments with group counts; **Add Department** creates one; row-click edits name/color/sort_order and saves; **Delete** on an empty department works; Delete on a department with services is refused with the 409 toast.
- [ ] `git status` shows only the intended files committed.

## Self-Review (completed during authoring)

**Spec coverage:** nav+page (Task 4), editable flyout add/edit (Task 4), guarded delete (Task 2 + Task 4 UI), PUT (Task 1), counts incl. accurate `service_count` (Task 1), admin-gating (Tasks 1-2), api.ts client (Task 3), Service Groups list in flyout (Task 4), color picker reuse (Task 4). All spec sections mapped. ✓

**Placeholder scan:** the FE tasks intentionally defer exact fetch-wrapper + color-shape + testing-library details to "read the existing file and match it" with explicit instructions (the repo's conventions are the source of truth, and inventing them would be wrong) — these are directed reads, not hand-waves. Backend tasks carry complete code. No `TODO`/`handle edge cases`.

**Type consistency:** `DepartmentInput`/`Department` (with `group_count`/`service_count`) used identically across Tasks 3-4; `_department_counts`/`_department_out` defined in Task 1 and reused in Task 2; endpoint shapes match the api.ts client.
