# Admin Edit-User Flyout — User Management

*Design spec — 2026-07-02*

## Purpose

Give admins a single, discoverable way to edit a user's profile from the **User Management** page: click a user row to open a right-side **edit flyout** (visually mirroring the Instruments page slide-out) and set the user's **first name, last name, email, role, and active status**. Today the page can toggle role/active and reset passwords via small action icons, but there is no way to set a user's name or correct an email.

## Scope

**Frontend-only.** No backend, API-layer, or migration work.

The backend and data layer already support everything this feature needs:

- **`PUT /auth/users/{user_id}`** (`backend/main.py` `update_user`, `admin=Depends(require_admin)`) already accepts `first_name`, `last_name`, `email`, `role`, `is_active`; validates `role ∈ {standard, admin}`; and rejects a duplicate email with `400 "Email already in use"`.
- **`updateUser(userId, data)`** (`src/lib/auth-api.ts`) and its `UserUpdateInput` type already carry all five fields.

So this feature is a new flyout UI wired to the existing `updateUser()` call.

**Out of scope (YAGNI):** the existing "Add User" create dialog (unchanged); reset-password (stays its own action); any backend/endpoint change; email *format* enforcement server-side (added client-side only).

## Reference patterns (existing code to follow)

- **Slide-out shell to mirror:** `src/components/hplc/InstrumentsPage.tsx` — a hand-rolled right panel (fixed backdrop `fixed inset-0 z-40 bg-black/30` + fixed panel `fixed right-0 top-0 z-50 … w-full max-w-xl border-l bg-background shadow-xl`, `@keyframes slideInRight`/`fadeIn`, sticky header with title + `X`). Note: that flyout is **read-only** — we reuse its *shell*, not its body.
- **Form idiom to copy:** `src/components/auth/ProfilePage.tsx` `NameSection` and the "Add User" dialog in `UserManagement.tsx` — plain `useState`, shadcn `Input`/`Label`/`Select`/`Switch`/`Button`, `toast` on success/error. The repo does **not** use react-hook-form; do not introduce it.
- **Self-edit guard precedent:** `UserManagement.tsx` hides role/active toggles when `user.id === currentUser?.id`.

## UI design

**Trigger.** Each user `TableRow` becomes clickable (`onClick` → `setSelectedUserId(user.id)`), mirroring the Instruments row-click. Any interactive control remaining in the Actions cell calls `stopPropagation` so it doesn't also open the flyout.

**Flyout** — new component `src/components/auth/UserEditFlyout.tsx`:

- Reproduces the Instruments slide-out shell (backdrop + `max-w-xl` right panel + `slideInRight`/`fadeIn`, sticky header "Edit user" + `X`). Closes on backdrop click and `X`.
- Body is an **edit form** (local `useState`, seeded from the selected user):
  - **First name** — `Input`, optional (model allows null).
  - **Last name** — `Input`, optional.
  - **Email** — `Input`, required; client-side format check (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`).
  - **Role** — `Select` (Standard / Admin).
  - **Active** — `Switch`.
  - **Save** (primary) + **Cancel**/`X`.
- **Save gating:** disabled unless (a) at least one field changed from the loaded user AND (b) email is non-empty and format-valid.
- **Self-edit guard:** when the selected user is the current user, **Role and Active are disabled** (prevents self-demotion / self-deactivation lockout); name and email stay editable.

**Actions column change.** Remove the now-redundant **role-toggle** and **active-toggle** icons (they live in the flyout now). **Keep** the **reset-password** icon (a distinct action), calling `stopPropagation`. The "Add User" button/dialog is unchanged.

## Data flow

1. Row click → `selectedUserId` set → flyout renders, form seeded from that user.
2. Admin edits fields → Save.
3. Save builds a **minimal patch** of only changed fields and calls `updateUser(id, patch)`.
4. **Success:** success `toast`, re-run `loadUsers()`, close flyout.
5. **Error:** the backend `400 "Email already in use"` (and any other error) surfaces as an inline field error / `toast`; flyout stays open with entered values.

## Error handling & validation

- Client-side: email required + format-valid before Save enables; empty name fields are allowed and sent as cleared (backend does `.strip() or None`).
- Server-side (unchanged): duplicate-email `400`, invalid-role `400` — surfaced to the user, not swallowed.
- No optimistic update; list refetches after a confirmed `200`.

## Access control

No new gating needed. The page is already admin-only (`MainWindowContent.tsx` `activeSubSection === 'user-management' && isAdmin`; `AppSidebar.tsx` `adminOnly`), and the endpoint is `require_admin`. The flyout is only ever reachable by an admin.

## ISO 17025 alignment

- **Attribution (7.5.1) is preserved:** audit/records key on the immutable `user.id`; editing a user's display name or email does not rewrite history — name resolves for display only. Correcting a misspelled name/email therefore *improves* traceability without altering past attribution.
- **Change control (7.11.2):** edits go through the existing admin-gated endpoint; email-uniqueness is enforced so identity stays unambiguous. No new data path or store is introduced.

## Testing

Vitest component tests (repo style, no react-hook-form):

- Flyout opens on row click and pre-fills the selected user's fields.
- Save sends **only** changed fields to `updateUser` (mocked) and refreshes on success.
- Invalid/empty email disables Save.
- Editing the current user disables Role and Active but leaves name/email editable.
- Backend `400 "Email already in use"` surfaces without closing the flyout.

## Files

- **New:** `src/components/auth/UserEditFlyout.tsx`, `src/components/auth/__tests__/UserEditFlyout.test.tsx`.
- **Edit:** `src/components/auth/UserManagement.tsx` (row-click state + render flyout; drop the two redundant toggle icons; keep reset-password with `stopPropagation`).
- **No change:** `auth-api.ts` (already has `updateUser`/`UserUpdateInput`), backend, migrations.

## Verification

`npx tsc --noEmit`, the new vitest suite, and `npm run build` all green before PR. PR held for the user's sign-off per standing rule (never auto-merge).
