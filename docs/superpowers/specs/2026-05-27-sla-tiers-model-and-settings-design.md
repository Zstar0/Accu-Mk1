# SLA Tiers — model revision + settings UI (A-revised + C)

- **Date:** 2026-05-27
- **Branch:** `feat/order-status-processing-time`
- **Supersedes:** `2026-05-26-sla-model-engine-design.md` **for storage**. The
  one-row-per-`(analysis_service, priority)` `sla_targets` model is replaced by
  a first-class **SLA tier** entity that both service groups and priorities
  reference. `compute_sla_status` and the pure-function engine approach from A
  carry over unchanged; the storage + resolution inputs change.
- **Scope:** revises sub-project A's foundation **and** delivers sub-project C
  (the settings UI). One spec because they share the new model.

## Why the change

A modelled an SLA as a target per `(service, priority)` row — there was no SLA
"tier" you create and assign things to. The lab's actual mental model (and an
existing codebase pattern — Service Groups) is: **named SLA tiers**, with
**service groups** and **priorities** each pointing at a tier. Unassigned →
the default tier. This spec adopts that.

## Concepts

- **SLA tier** — a named turnaround target (`name`, `target_minutes`,
  `business_hours_only`, `is_default`). The reusable unit. Managed on the new
  SLA settings page. Example tiers: "Standard" (24h, default), "Microbiology"
  (48h), "Rush" (4h).
- **Service group → tier** — each `service_groups` row may reference one tier
  (`sla_tier_id`, nullable). A service inherits its group's tier. **Operating
  rule: one analysis service belongs to at most one service group**, so
  service → group → tier is unambiguous. v1 does **not** enforce this in the
  schema (`service_group_members` still allows multi-group; enforcement is
  deferred per the user). Defensive tiebreak if ever violated: pick the group
  with the lowest `sort_order` (then lowest id) — deterministic, and moot while
  the rule holds.
- **Priority → tier** — a sparse mapping (`sla_priority_tiers`) from a priority
  (`normal|high|expedited`) to a tier. Only *overriding* priorities get a row;
  an unmapped priority does not override.

## Resolution

`resolve_sla_tier(priority_map, group_tier, priority, default_tier)` — fixed
precedence, no target comparison:

1. **Priority overrides.** If the sample's `priority` is present in the priority
   map → that tier. *(Per the lab's decision, priority beats the group SLA.)*
2. Else the service's **group** has a tier → that tier.
3. Else the **default** tier.

Sparsity contract (state exactly, do not "complete" it): the priority map holds
a row **only** for priorities that override. Absence of a row — including for
`normal`, and including a `None`/unknown priority — means "does not override,
fall through to step 2." Do **not** insert a `normal → default tier` row to look
complete; it is operationally identical to no row and is a wart.

```python
prio_tier = priority_map.get(priority)   # None if unmapped or priority is None
if prio_tier is not None:
    return prio_tier
if group_tier is not None:
    return group_tier
return default_tier                       # the is_default tier (24h)
```

Returns None only if there is no default tier (defensive; the seed guarantees
one). `compute_sla_status(received_at, target_minutes, now)` is unchanged from
A (raw wall-clock; business-hours math remains sub-project B).

The same chain runs client-side in TS for D2 (cache the tiers + the priority
map once, resolve per sample) — spec'd as a **contract**, mirror of the Python
resolver; implementation lives in the plan.

## Data model / migration

In `database.py:_run_migrations` (idempotent; `IF EXISTS` / `IF NOT EXISTS`;
`accumark_mk1` is dev-only, no real data at risk):

- **DROP** `sla_targets` and its four `uq_sla_*` partial unique indexes and seed.
- **CREATE** `sla_tiers`: `id` PK, `name` (not null), `target_minutes` (int,
  not null), `business_hours_only` (bool, default false), `is_default` (bool,
  default false), `created_at`, `updated_at`. Partial unique index
  `WHERE is_default` (at most one default).
- **CREATE** `sla_priority_tiers`: `priority` VARCHAR(20) PK, `sla_tier_id`
  (FK → `sla_tiers.id`, `ON DELETE CASCADE`, not null), `updated_at`.
- **ALTER** `service_groups` **ADD** `sla_tier_id INTEGER NULL REFERENCES
  sla_tiers(id) ON DELETE SET NULL`.
- **Seed:** one default tier — `name='Standard'`, `target_minutes=1440`,
  `is_default=true` (idempotent via `WHERE NOT EXISTS (... is_default)`). Service
  groups keep `sla_tier_id = NULL` initially → they resolve to the default tier,
  which is the desired backward-compatible behavior (today's 24h goal).

ORM: replace the `SlaTarget` model with `SlaTier` (+ the `sla_priority_tiers`
table / `SlaPriorityTier` model); add `sla_tier_id` + relationship to
`ServiceGroup`.

## API surface (FastAPI)

- **SLA tiers** — mirror `/service-groups`:
  - `GET /sla-tiers` — all tiers (default first). Cached by C and by D2.
  - `POST /sla-tiers`, `PUT /sla-tiers/{id}`, `DELETE /sla-tiers/{id}`.
  - Invariant: exactly one `is_default` tier. Setting default demotes others
    (flush-before-insert, as in A); the default tier cannot be deleted, and a
    tier still referenced by a group/priority is handled by the FK
    (`SET NULL` / `CASCADE`) — deletion is allowed and references clear.
- **Priority → tier mapping:**
  - `GET /sla-priority-tiers` — the sparse map.
  - `PUT /sla-priority-tiers/{priority}` — upsert `{ sla_tier_id }`.
  - `DELETE /sla-priority-tiers/{priority}` — remove an override.
- **Service groups:** extend `ServiceGroupCreate/Update/Response` with
  `sla_tier_id` (nullable). No new endpoints — reuse existing CRUD.
- Optional server-side `GET /sla/resolve?service_id=&priority=` for jobs/
  notifications (not the render path).

Priority values validated at the API edge (`Literal['normal','high',
'expedited']`).

## Frontend

- **New SLA settings pane** in the Preferences modal (`PreferencesDialog`):
  a `'sla'` nav entry + `SlaPane` component. Two sections (shared
  `SettingsSection`):
  1. **Tiers** — Plain-style cards, default tier pinned first with a "Default"
     badge (delete disabled). Each card: `name`, target as **hours + minutes**
     inputs (↔ `target_minutes`), "Only during business hours" toggle (stored;
     a muted hint notes it takes effect once the business-hours calendar (B)
     ships). "Add SLA" button top-right.
  2. **Priority overrides** — a small list mapping `high` / `expedited` to a
     tier via a dropdown ("No override" clears it). `normal` intentionally
     omitted (sparsity).
  - **Access:** everyone sees the pane; **non-admins are read-only** (no Add/
    edit/delete; cards render static). `isAdmin = user?.role === 'admin'`.
- **Service Groups page** (`ServiceGroupsPage`): add one **"SLA tier"** dropdown
  to the group editor (options = tiers + "Use default"). Shows the assigned tier
  in the table/row.
- **Data/arch:** match the other panes — TanStack Query via a new
  `@/services/sla.ts` (`useSlaTiers`, `useCreate/Update/DeleteSlaTier`,
  `useSlaPriorityTiers`, `useSetPriorityTier`), `toast` feedback, all strings
  via `useTranslation` (`locales/*.json`). TS client fns + a `resolveSlaTier`
  TS helper in `src/lib/api.ts` mirroring the Python chain (for D2).

## Out of scope

- Business-hours / holiday calendar → **B**.
- Color-coded SLA column in the order lists → **D2** (resolves client-side off
  the cached tiers + priority map; shows SLA status *and* the existing priority
  badge — they're complementary signals).
- Labels, escalation, breach notifications (Plain has them; we don't).
- **Future (not v1):** a per-group "priority cannot tighten this tier" opt-out,
  for physically time-bound tests (e.g. sterility incubation) where an
  expedited override would promise an unattainable turnaround.

## Notes carried from A

- Pure-function engine (no DB import) so server + TS share the contract.
- Postgres NULL-distinct → partial unique index for the single-default rule.
- `database.py` uses `create_all` + idempotent `_run_migrations` (no Alembic);
  raw `CREATE TABLE IF NOT EXISTS` first for tables needing a seed on first boot.
