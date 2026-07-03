# Fix: 409 Conflict when adding a Flag Type

*Design spec — 2026-07-02*

## Problem

In prod (Mk1 1.0.19), **`POST /api/flags/types` returns 409 Conflict** on every attempt to add a flag type after the first one. Reported by the user from **Preferences → Flags** in prod.

## Root cause (proven against prod)

The "Add Type" button in `src/components/preferences/panes/FlagsPane.tsx` (~line 114) creates a placeholder with a **fixed default label** — `t('preferences.flags.newTypeDefaultName')` = **"New type"** — and sends **no slug**:

```tsx
createType.mutate({ label: t('preferences.flags.newTypeDefaultName'), color: '#3b82f6', kind: 'issue' })
```

The backend `flags/types_service.create_type` (line 104-106) derives the slug from the label and hard-409s on any collision:

```python
slug = (slug or _slugify(label)).strip()      # _slugify("New type") -> "new_type"
if get_type_by_slug(db, slug) is not None:    # matches ANY existing type, active or not
    raise ConflictError(f"flag type slug {slug!r} already exists")
```

`slug` is `unique` + immutable (`flag_flags.type` references it). So:

1. First "Add Type" → slug `new_type` created; user renames the label to "Re-Test" (slug stays `new_type`).
2. Every subsequent "Add Type" → label "New type" → slug `new_type` → **collides → 409**.

**Prod evidence:** `flag_types` row `id=6 slug='new_type' label='Re-Test'` (the renamed first type — it exists and works), plus a run of `POST /api/flags/types → 409 Conflict` in the backend log. **No data fix needed** — id=6 is legitimate.

## The fix (backend-only)

When the slug is **derived from the label** (the caller passed no explicit slug — which the UI never does), **auto-uniquify** it instead of 409-ing. An **explicitly-provided** slug that collides must still 409 (that's real user intent).

In `backend/flags/types_service.py`:

```python
def _unique_slug(db: Session, base: str) -> str:
    """First free slug in the base, base_2, base_3, ... sequence."""
    if get_type_by_slug(db, base) is None:
        return base
    n = 2
    while get_type_by_slug(db, f"{base}_{n}") is not None:
        n += 1
    return f"{base}_{n}"
```

and change `create_type` so:

```python
def create_type(db, *, label, color, kind, slug=None, is_blocking=False,
                entity_types=None, sort_order=None, is_active=True):
    explicit = bool(slug and slug.strip())
    slug = (slug or _slugify(label)).strip()
    if explicit:
        if get_type_by_slug(db, slug) is not None:
            raise ConflictError(f"flag type slug {slug!r} already exists")
    else:
        slug = _unique_slug(db, slug)   # create-then-rename UX: never collide on the derived slug
    ...
```

The slug is internal (users see the label, not the slug), so `new_type_2`, `new_type_3`, … never surface in the UI.

## Scope

- **Backend-only:** `backend/flags/types_service.py` (`create_type` + new `_unique_slug` helper). No frontend, schema, or migration change. No prod data change.
- Ships as **Mk1 1.0.20** (backend; `deploy.sh --skip-release`, same flow as 1.0.15–1.0.19).

## Testing (pytest, `backend/tests/`)

Extend the existing flag-types test file (find it under `backend/tests/`; the flag-types suite already exists from Plan 5):

1. **Two types, same label → distinct slugs, no 409:** `create_type(label="New type", ...)` twice → first slug `new_type`, second slug `new_type_2`; both succeed.
2. **Explicit colliding slug still 409s:** `create_type(label="X", slug="new_type", ...)` when `new_type` exists → raises `ConflictError`.
3. Existing tests stay green.

## Secondary observation (out of scope, note as follow-up)

The backend log showed **paired** `POST /api/flags/types` (the create button occasionally double-fires) despite `disabled={createType.isPending}`. After the slug fix a double-fire would create two "New type" placeholders (`new_type_2` + `new_type_3`) rather than 409 — harmless but messy. A follow-up could guard the button (e.g. dedupe in-flight). Not required for this fix.

## Deploy / verification

`ruff check . && mypy app` (IS gate style — but this is Mk1 backend; run the backend's own checks + `pytest tests/test_flags_types*.py`), then deploy Mk1 1.0.20 and confirm from prod: add two types back-to-back via Preferences → Flags → both succeed (slugs `new_type_2`, `new_type_3`). PR held for sign-off.
