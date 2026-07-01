---
title: "Departments admin page (Catalog v1 management UI)"
date: 2026-06-30
status: draft
authors: [ZeroSignal, forrestp]
---

# Departments admin page

## Summary

Add an admin-only **Departments** page to the Accu-Mk1 LIMS nav that lists the catalog departments and lets an admin **create, edit, and delete** them through a right slide-out flyout. It closely mirrors the existing **Instruments** page (list + search + row-click flyout), with two deltas: the header action button is **"Add Department"** (not "Sync from Senaite"), and the flyout is **editable** (Instruments' is read-only).

This is the first piece of the catalog-management UI the Test-Catalog v1 spec anticipated ("turn 'edit 20 literals and pray' into 'add rows in the Accu-Mk1 UI'"). It builds directly on the `departments` model + `GET`/`POST /departments` endpoints shipped in Plan 1A.

## Context

- **Model (1A):** `Department(id, name UNIQUE, sort_order, color, is_system, created_at, updated_at)`.
- **API (1A):** `GET /departments` (ordered by `sort_order, name`) and `POST /departments` (dup-name check). Both currently gated by `get_current_user` (any authenticated user).
- **FE (1A):** the `Department` TypeScript interface exists in `src/lib/api.ts`; there are **no** department client functions yet.
- **`department_id` FK:** `service_groups.department_id` and `analysis_services.department_id` both reference `departments(id)` **`ON DELETE SET NULL`**. This makes deletion of an in-use department a routing hazard (see "Delete guard").
- **Template:** `src/components/hplc/InstrumentsPage.tsx` — header + action button + search + `Card`/`Table` list + a `fixed` right slide-out panel with backdrop and `slideInRight` animation. Cloned for layout; the detail panel is replaced with an editable form.
- **Color palette:** `src/lib/service-group-colors.ts` exports `SERVICE_GROUP_COLORS` + `COLOR_OPTIONS` ({value,label}[]) — reused for the department color swatch picker so department colors match the app's color system.

## Scope

**In:**
1. `Departments` nav entry (LIMS section, admin-only) + routing.
2. `DepartmentsPage.tsx` — list (name+color, sort_order, service-group count, system badge), search, "Add Department" button.
3. Editable flyout: **Add mode** (empty form → POST) and **Edit mode** (pre-filled → PUT), plus a read-only Service Groups list and a guarded Delete.
4. Backend: `DepartmentUpdate` schema, `PUT /departments/{id}`, `DELETE /departments/{id}` (with guard); admin-gating on POST/PUT/DELETE.
5. api.ts client functions: `getDepartments`, `createDepartment`, `updateDepartment`, `deleteDepartment`.

**Out (YAGNI / later):**
- Editing `is_system` (reserved system flag — read-only in the UI).
- Reassigning a department's groups/services from this page (delete is *blocked* when dependents exist; reassignment happens on the Service Groups / Analysis Services pages).
- Managing the group↔department relationship from here (that lives on Service Groups).
- Audit fields on `departments` (see ISO 17025 note).

## Navigation & page

Add to the **LIMS** section in `src/components/layout/AppSidebar.tsx`, immediately after `service-groups`:

```ts
{ id: 'departments', label: 'Departments', adminOnly: true },
```

Route it in `src/components/layout/MainWindowContent.tsx`: `if (activeSubSection === 'departments') return <DepartmentsPage />`.

`DepartmentsPage.tsx` (cloned from `InstrumentsPage.tsx`):
- **Header:** icon (`Layers` or `Building2`) + title "Departments" + subtitle "Top-level lab benches that route the catalog" + a right-aligned **"Add Department"** button (opens the flyout in Add mode).
- **Search:** filters by name (case-insensitive substring).
- **Table columns:** **Name** (with a small color dot from the palette), **Sort Order**, **Service Groups** (count badge), **System** (a "System" badge when `is_system`, else `—`). Row click → flyout Edit mode. A trailing `ChevronRight`.
- **Empty state:** "No departments yet. Click 'Add Department' to create one."

## Flyout (editable)

Same slide-out shell as Instruments (backdrop + `slideInRight`), but the body is a form with local state.

**Add mode** (from the button; no selected id):
- Fields: **Name** (text, required), **Color** (swatch picker over `COLOR_OPTIONS`), **Sort Order** (number input, default `0`).
- Footer: **Create** (disabled until Name is non-empty) + **Cancel**. Create → `createDepartment({name, color, sort_order})` → on success toast, close, refresh list. On 400 (dup name) → inline error + error toast.

**Edit mode** (row click; selected department):
- Same three fields, pre-filled and editable. `is_system` rendered as a read-only badge (no toggle).
- A **counts** line: "Service Groups: {group_count} · Services: {service_count}" (from the department response — accurate, includes ungrouped services).
- **Service Groups (N)** — read-only list of the service groups whose `department_id` equals this department, each showing the group name + its `member_count`, sourced from `getServiceGroups()` filtered client-side. Empty → "No service groups in this department."
- Footer: **Save** (`updateDepartment(id, {name, color, sort_order})`), **Delete** (guarded, see below), **Cancel**. Save → toast, close, refresh. Dup-name (400) → inline error.

**Timestamps** footer (created/updated), same as Instruments.

## Delete guard (load-bearing)

Because `department_id` is `ON DELETE SET NULL`, deleting an in-use department would silently NULL the `department_id` of its service groups and analysis services — and post-Plan-1B a NULL-department analytical service is **excluded from HPLC-vial mirroring** (fail-closed). So deletion must be refused when it would orphan anything.

`DELETE /departments/{id}` (admin):
- `404` if not found.
- `409` if `is_system` — system departments (e.g. the reserved "Xtra" overflow bucket) are never deletable.
- `409` if any `service_groups.department_id == id` **or** any `analysis_services.department_id == id`, with a message naming the counts: `"Department 'X' still has N service group(s) and M service(s). Reassign them before deleting."`
- Otherwise delete + `commit`, return `204`.

Frontend: the Delete button opens a confirm dialog ("Delete department 'X'? This cannot be undone."). On `409`, surface the server message as an error toast and keep the flyout open. On success, close + refresh.

## Backend additions

In `backend/main.py`, near the existing department routes (~line 13805):

```python
class DepartmentUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None
    # is_system intentionally omitted — not user-editable.
```

- `PUT /departments/{id}` (admin): load or 404; if `name` provided and differs, reject (400) when another department already uses it; apply provided fields; `commit`; return `DepartmentResponse`.
- `DELETE /departments/{id}` (admin): the guard above.
- Add `_current_user=Depends(require_admin)` to `create_department`, `update_department`, `delete_department`. `get_departments` stays `get_current_user`.

`require_admin` already exists (`backend/auth.py` — checks `role == "admin"`).

### Response counts (`group_count`, `service_count`)

`DepartmentResponse` gains two computed, read-only fields so the list + flyout can show accurate counts without a second round-trip:
- `group_count: int` — `COUNT(service_groups WHERE department_id = id)`.
- `service_count: int` — `COUNT(analysis_services WHERE department_id = id)`.

**`service_count` is a direct department count, NOT a sum of group member counts** — deriving it from groups would miss the ungrouped analytical services (e.g. the `ANALYTE-N-*` rows tagged Analytical in Plan 1A/1B), the exact case that motivated the fail-closed work. Compute both in a small helper used by `get_departments`, `create_department` (returns 0/0 for a fresh row), `update_department`, so every department response carries them. The `DELETE` guard reuses the same two counts for its 409 message.

## api.ts additions

```ts
export interface DepartmentInput { name: string; color?: string; sort_order?: number }
export async function getDepartments(): Promise<Department[]>
export async function createDepartment(data: DepartmentInput): Promise<Department>
export async function updateDepartment(id: number, data: Partial<DepartmentInput>): Promise<Department>
export async function deleteDepartment(id: number): Promise<void>
```

The existing `Department` interface (api.ts:4173) gains `group_count: number` and `service_count: number` to match the extended response. Follow the existing api.ts fetch-wrapper conventions (auth header, error unwrapping). The flyout's groups list reuses the existing `getServiceGroups()`.

## Testing

**Backend (pytest):**
- `PUT`: updates fields; rejects a name already used by another department (400); 404 on missing.
- `DELETE`: 204 on a department with no dependents; 409 when a service group or analysis service references it; 409 when `is_system`; 404 on missing.
- Admin-gating: POST/PUT/DELETE reject a non-admin (403); GET allows any authenticated user.

**Frontend (vitest):**
- List renders rows; search filters by name.
- Flyout Add mode: Create disabled until name present; submits `{name,color,sort_order}`.
- Flyout Edit mode: pre-fills; Save submits changed fields; `is_system` shows as a read-only badge; the service-groups list filters by `department_id`.
- `npm run typecheck` clean.

## Build & test approach

- Branch `feat/catalog-departments-admin` off the rebased catalog code (`catalog-rebase-trial` = current `origin/master` + Plans 1A/1B), built in the laptop worktree `C:/tmp/Accu-Mk1-departments`.
- Tested live by re-mounting the devbox `catalog` stack onto this worktree (`accumark-stack mount catalog --mk1 ~/worktrees/Accu-Mk1-departments`, after pushing + creating the devbox worktree), so it runs on the same stack + `tester@accumark.local` admin already in use. Iteration: laptop edit → push → devbox worktree `git pull` → vite HMR.

## ISO 17025 alignment

Editing the test catalog (departments) is a **change-control surface** (7.5.2/8.4 traceable amendments; 8.3 document control of test definitions). The `departments` table currently records only `created_at`/`updated_at` — **no `created_by`/`changed_by`**, so who changed a department is not captured. This v1 does not add audit fields (out of scope), but it is a known gap to close when catalog editing broadens (align with the audit-field posture noted for the catalog spec). The delete guard (refusing to orphan groups/services) is itself a data-integrity control that preserves the fail-closed routing invariant from Plan 1B.

## Out of scope

- Assignment-page rendering from departments (later catalog phase).
- The `vials_required` / `is_assignable` fields (those live on service groups / services, not departments).
- Bulk reordering (drag-to-reorder) — sort_order is a plain number field in v1.
