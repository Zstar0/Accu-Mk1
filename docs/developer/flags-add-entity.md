# Flags — register a new flaggable entity

Make a new thing flaggable (sample preps, peptides, calibration curves, …) with
**three edits and no migration**. This is by design: the Flag System is a
self-contained plug-in (see the design spec
[`2026-06-27-flag-system-design.md`](../superpowers/specs/2026-06-27-flag-system-design.md)
§3 "Extractable Plug-in Module" and §8 "Future / Out-of-Scope").

## The plug-in model

A flag stores an **opaque `(entity_type, entity_id)` string pair** — no foreign
key, no join, no schema coupling to the host domain. The flags tables
(`flag_flags`, `flag_comments`, `flag_events`, `flag_participants`) never
reference `lims_samples` et al.

The **entity registry** (`backend/flags/seams.py`) is the *only* place the flag
module learns what an entity type means. The host registers each type with a
small set of closures; `service.py`/`routes.py` stay entity-agnostic and reach
the host only through `seams.resolve_context(...)` / `seams.resolve_descendants(...)`.

> If you find yourself importing `LimsSubSample` (or any host model) into
> `service.py` or `routes.py`, stop — that knowledge belongs in a
> `register_mk1_entities()` closure.

## The 3 edits

### 1. Backend — register the type (`backend/flags/seams.py`)

Add a `register_entity(...)` call inside `register_mk1_entities()`:

```python
register_entity(
    "<type>",                                 # the entity_type string
    label=<fn(db, eid) -> str>,               # human label, e.g. the human id
    deep_link=<fn(eid) -> str>,               # legacy URL form (kept for compat)
    can_flag=lambda user, eid: True,          # permission gate (usually True)
    context=<fn(db, eid) -> dict | None>,     # serialized EntityContext (below)
    descendants=<fn(db, eid) -> list[tuple]>, # OPTIONAL — roll-up children
)
```

Each closure imports its host models **lazily inside the closure** (mirroring
`_sample_label`) so the module has no import-time host dependency.

**`context`** returns the `EntityContext` dict the frontend consumes (the
registry helper stamps `entity_type`/`entity_id` for you — return the rest):

```python
{
    "label": "P-0071-S01",        # best human label
    "sample_id": "P-0071",        # parent sample's human id, or None
    "analyses": ["PEPT-Total"],   # de-duped service titles, or []
    "lot": None,                  # additive hook — deferred, leave None
    "deep_link": {"kind": "sample", "id": "P-0071"},
}
```

`deep_link.kind` ∈ `sample` | `worksheet` | `none`. `id` is the **argument the
frontend navigator receives** (`navigateToSample(id)` for `sample`,
`openWorksheetDrawer(Number(id))` for `worksheet`). Point it at the closest real
landing page; use `none` only if there genuinely isn't one. Return `None` from
`context` when the row is gone — never raise (the helper swallows errors, but be
explicit).

**`descendants`** is only needed when a parent should **aggregate** its
children's flags (a sample rolling up its vials). Return the child
`(entity_type, entity_id)` pairs; the `include_descendants=true` query expands
the filter to `self ∪ descendants`. Omit it entirely for leaf entities.

### 2. Frontend — presentation metadata (`src/components/flags/flag-entity.ts`)

Add an `ENTITY_META` entry (icon + fallback label + whether the type *can*
deep-link when the server context is absent):

```ts
import { Beaker } from 'lucide-react'
// ...
const ENTITY_META: Record<string, EntityMeta> = {
  // ...existing...
  sample_prep: { Icon: Beaker, label: 'Sample Prep', canDeepLink: true },
}
```

The card's label + navigation come from the server `entity` context at runtime
(`entityDisplayLabel` / `navigateForFlag`); `ENTITY_META` is just the icon and
the graceful fallback when context hasn't resolved.

### 3. Page — drop the button

Mount the stateful button on the entity's page:

```tsx
<EntityFlagButton entityType="sample_prep" entityId={String(prep.id)} />
```

Add `includeDescendants` on a parent surface that should aggregate children;
pass `size="lg"` for a primary page header.

## Per-entity cost

- A real, navigable `deep_link` route (reuse an existing `ui-store` navigator —
  don't invent a new page just for flags).
- A small `context` query (one or two reads — load the row, maybe its parent /
  analyses). Keep it cheap; it runs per flag in a list.

That's it. No new tables, no migration, no change to existing entity types.

## Worked example — `sample_prep`

A Sample Prep lives in `accumark_mk1.sample_preps` and is accessed via
**raw psycopg**, not an ORM model (see `backend/lims_analyses/prep_bridge.py` /
`backend/mk1_db.py`). Resolve it through the existing prep query layer rather
than adding a new SQLAlchemy model. A prep may carry a `lims_sub_sample_pk`, so
its context can borrow the vial's Sample ID + analyses.

```python
def _sample_prep_context(db, eid):
    from mk1_db import get_sample_prep            # existing raw-psycopg accessor
    prep = get_sample_prep(int(eid)) if str(eid).isdigit() else None
    if prep is None:
        return None
    # Preps are viewed on the Sample Preps page; deep-link there.
    return {
        "label": f"Prep {prep['id']}",
        "sample_id": prep.get("sample_id"),       # parent vial/sample human id
        "analyses": [],                           # or the prep's analyte titles
        "lot": None,
        "deep_link": {"kind": "sample_prep", "id": str(prep["id"])},
    }

register_entity(
    "sample_prep",
    label=lambda db, eid: f"Prep {eid}",
    deep_link=lambda eid: f"/#hplc-analysis/sample-preps?id={eid}",
    can_flag=lambda user, eid: True,
    context=_sample_prep_context,
)
```

Then add a `navigateToSamplePrep`-backed case if you introduce a new
`deep_link.kind` (the registry's `kind` and the frontend navigator must agree —
extend `navigateToDeepLink` in `flag-entity.ts` to map `kind:"sample_prep"` →
`navigateToSamplePrep(Number(id))`), add the `ENTITY_META` entry, and drop the
button on `SamplePrepsPage`.

### One-liners for the next two

- **`peptide`** (`client_peptides`, ORM `Peptide`): `context` loads the
  `Peptide` by pk, `label`/`sample_id` from its name; `deep_link.kind:"peptide"`
  → a peptide config navigator (`navigateToPeptide`). Leaf — no `descendants`.
- **`calibration_curve`** (ORM `CalibrationCurve`, `backend/models.py`):
  `context` loads the curve, `label` = its name/id; `deep_link` to wherever
  curves are viewed (or `kind:"none"` until that page exists). Leaf.

## What you do NOT touch

- **Core flag tables / migrations** — flags are keyed by opaque strings; a new
  type needs no schema change.
- **`service.py` / `routes.py`** — they stay entity-agnostic. All host
  knowledge lives in the `register_mk1_entities()` closures.
- **Existing entity types** (`sample`, `sub_sample`, `worksheet`) — additive
  only.
- **The `EntityContext` shape** — produce it from your `context` closure; don't
  add fields without updating both the Pydantic model (`flags/schemas.py`) and
  the TS type (`lib/flags-api.ts`).
