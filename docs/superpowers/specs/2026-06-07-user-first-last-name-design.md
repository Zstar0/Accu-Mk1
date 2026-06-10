# User First/Last Name — Design

*2026-06-07 · branch `subvial/continue` · status: approved*

## Problem

`User` has only `email` — no human name. The lab wants real names on the profile
page and shown wherever a user/analyst currently appears as an email: the Analyst
column (vial analyses), the worksheet analyst (header + assign dropdown), activity-log
@mentions, and the User Management list. This also retires the email-fallback the
analyst-from-worksheet feature shipped as a deviation (the serializer can now return a
real name).

## User decision

Names appear **everywhere a user shows** (all four sites), not just the Analyst column.

## Display rule (single, mirrored backend + FE)

```
"First Last"          when both set
"First" / "Last"      when only one set
email                 when neither set
```

- Backend: `user_display_name(user) -> str` (new helper, `backend/auth.py` or a small
  `backend/users_display.py` — pick whichever keeps `auth.py` from bloating; it's
  imported by the serializer + endpoints).
- FE: `displayName(u: {first_name?, last_name?, email})` and
  `resolveUserName(email, directory)` in a new `src/lib/user-display.ts`.
- Both produce byte-identical output for the same inputs (test both).

## Data + migration

`User` (models.py:16) gains:

```python
first_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
last_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
```

Migration: add to the idempotent list in `backend/database.py:_run_migrations`
(~line 133, beside the `senaite_password_encrypted` ALTER):

```python
"ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)",
"ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)",
```

Per-statement try/except already wraps each (database.py ~625); runs every startup,
idempotent.

## Editing

- **Self-serve `PATCH /auth/me`** (NEW) — body `{first_name?: str|null, last_name?: str|null}`;
  updates the authenticated user only; returns `UserRead`. (The existing
  `PUT /auth/users/{id}` is admin-only and also mutates role/active — wrong tool for
  self-edit.) Trim whitespace; empty string → NULL.
- **Admin `PUT /auth/users/{id}`** — `UserUpdate` gains `first_name`/`last_name` so
  User Management can set them.
- `UserRead` (auth.py:60) + `_user_to_read` (main.py:10500) carry `first_name`/`last_name`.
  `GET /auth/me` already returns the user.

## The four display sites

1. **Analyst column** — `list_analyses_in_senaite_shape`
   (`lims_analyses/service.py:960-1011`) already bulk-loads `User` rows for
   `analyst_user_id`. Change the map to store the User row (or a precomputed display
   name) and set `analyst=user_display_name(user)` instead of `.email`. Zero FE change
   (the column renders the `analyst` string as-is).

2. **Worksheet analyst** — `GET /worksheets/users` (main.py:13975) SELECT adds
   `first_name`/`last_name`; `WorksheetUser` type (api.ts:4394) gains them; the assign
   dropdown and `WorksheetDrawerHeader` (`assigned_analyst_email` render, line ~51)
   use `displayName`, fall back to email. If the worksheet response exposes the analyst
   only as `assigned_analyst_email`, resolve via the loaded users list FE-side (the
   dropdown already loads them) rather than adding a backend name field — confirm at
   plan time which is cleaner.

3. **Activity-log @mentions** (`UserTag`, `SampleActivityLog.tsx:158`) — events carry
   emails in `details.by`/`details.analyst`. Add a **user directory**:
   - NEW `GET /auth/directory` (auth-only, not admin) → `[{id, email, first_name,
     last_name}]` for ALL users (active + inactive, so historical analysts resolve).
   - FE `useUserDirectory()` hook → `Map<email, displayName>`.
   - `UserTag` takes the directory (via context or prop) and renders the resolved
     name, falling back to `shortUser(email)` when the email isn't found.

4. **User Management** (`UserManagement.tsx`) — list row shows `displayName` + email;
   `AuthUser` (auth-store) + `listUsers` (auth-api.ts:108) carry the fields. Admin edit
   form gains First/Last inputs writing through `PUT /auth/users/{id}`.

## Out of scope

- Writing names INTO activity event payloads (we resolve at render).
- Inbox filters (queued — separate spec).
- Renaming `/worksheets/users` (keep it; add fields).
- Required-name enforcement (names stay optional; email is the identity key).

## Testing

**Backend (pytest):**
- `user_display_name`: both names, first-only, last-only, neither (→email), and
  whitespace-only (→email).
- Migration idempotency: the two ALTERs run twice without error (or assert the columns
  exist after startup — mirror any existing migration test).
- `PATCH /auth/me`: sets names on the caller; empty string → NULL; does not let a
  non-admin change role/active (it only accepts the two fields).
- Serializer: stamped analysis with a named user → `analyst == "First Last"`; named
  via only first → "First"; unnamed user → email (extends the existing
  `test_worksheet_analyst_stamp.py::test_senaite_shape_surfaces_analyst_email`).
- `/auth/directory`: returns all users with name fields; auth-required.

**FE (vitest):**
- `displayName` / `resolveUserName`: the four fallback cases + unknown-email fallback
  to `shortUser`.

FE form save, directory resolution in the activity log, worksheet dropdown names, and
User Management display are UAT.

## Risks / gotchas

- **`shortUser(email)` fallback must remain** for activity @mentions referencing users
  absent from the directory (deleted accounts, legacy events) — never render a raw
  email or blank.
- The serializer bulk-load currently selects `User` then reads `.email`; ensure the
  changed map keeps a single query (don't introduce per-row lookups).
- `PATCH /auth/me` must NOT accept `role`/`is_active`/`email` — restrict the Pydantic
  body to the two name fields so it can't be used for privilege escalation.
- Two Mk1 databases exist, but `users` lives in the main Postgres (`accumark_mk1`) —
  the ALTERs target the main DB's migration list, not the mk1_db side.
