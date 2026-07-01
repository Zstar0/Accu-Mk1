# Flag System — multi-flag creation affordances (staff-review round)

*Design approved 2026-07-01. Follows the 2026-06-30/07-01 flag-system frontend arc (PR #28).*

## Context / problem

Staff review surfaced three asks:

1. The un-scoped flyout's top-right **Add Flag** drops into a manual entity-type/ID
   form — nobody knows raw entity IDs. It should flag *the page you're on*.
2. Staff believe the system supports only **one flag per item**; real workflows need
   several (e.g. an endotoxin question and an HPLC question on the same sample).
3. Multi-flag items should show a **count badge** ("floating number circle") and
   clicking should list that item's flags, then drill into one.

Code reality (verified): the data model already supports multiple flags per entity —
`create_flag` has no uniqueness guard and `flag_flags` has no unique constraint on
`(entity_type, entity_id)`. Ask 3's behavior (count when >1, click → entity-scoped
flyout list → drill in) is **already built** in both `EntityFlagButton` and
`FlagIndicator`. The system *feels* one-per-item because once an entity is flagged
there is **no discoverable way to raise a second flag** on it: the detail-page button
flips to "view the flag" and the only "add another" path is the scoped flyout's tiny
`+`. This spec therefore targets the **creation affordances** plus a badge restyle.
**No backend or API changes.**

## Design

### 1. Active entity context (new, enabler)

New ui-store state: `activeFlagEntity: { type: string; id: string; label: string } | null`,
maintained as a small **stack** (`pushActiveFlagEntity` / `popActiveFlagEntity`) so
overlays compose: SampleDetails registers the sample; opening VialsQuickLookDialog
pushes the vial; closing it restores the sample. `activeFlagEntity` reads the top.

Registering surfaces (the three that mount `EntityFlagButton` today):

| Surface | Entity |
|---|---|
| `SampleDetails` | `sample` |
| `VialsQuickLookDialog` | `sub_sample` (vial) |
| `WorksheetDrawerHeader` | `worksheet` |

Push on mount, pop on unmount. Client-side only.

### 2. Context-aware flyout Add Flag

In the **un-scoped** flyout header (`FlagsFlyout`):

- `activeFlagEntity` set → **Add Flag** renders as a `RaiseFlagButton` preset to that
  entity; button label/compose header carry the entity label ("Add flag on {label}").
- `activeFlagEntity` null → the Add Flag button is **hidden** (decision: option A).
  The manual entity-type/ID form in `RaiseFlagButton`'s generic mode becomes
  unreachable from the UI; leave the code path (used by tests) but nothing renders it.

The **scoped** flyout header keeps its existing preset `+` (already correct).

### 3. "Raise another flag" on a flagged entity

`EntityFlagButton`, flagged state: add a small secondary **`+` icon button** next to
the type-colored "Flagged" pill (decision: option A — lightest, most discoverable).

- The pill keeps today's behavior: 1 open flag → open its thread; >1 → entity-scoped
  flyout list.
- The `+` opens the raise-flag compose preset to this entity, always — this is the
  discoverable "add another flag" that closes ask 2.
- Style: outline/ghost, same height as the pill, `aria-label="Raise another flag"`.

### 4. Count-badge restyle

Both `EntityFlagButton` and `FlagIndicator` currently render the >1 count as an
inline chip/number beside the icon. Restyle to a **floating number circle** badge
overlapping the flag icon's top-right corner (absolute-positioned, `--flag-unread`-style
dedicated sizing, `99+` cap preserved). Exact look tuned live at `:5552`. Behavior
(click → scoped list → drill in) unchanged.

## Out of scope

- Backend/API/DB changes — none needed; multiples already persist and list.
- The searchable entity picker fallback (option C) for the context-free flyout —
  deferred; Add Flag simply hides for now.
- Any change to flag visibility/authorization.

## ISO 17025 alignment

No new records or attribution paths: flags already carry creator/assignee attribution
and timestamped events (7.5.1); this change only adds UI entry points to the existing
`create_flag` path. No traceability impact.

## Security note (re-review trigger)

The 2026-07-01 security review of PR #28 found no exploitable issues, resting on the
"all authenticated users are trusted staff" model (admin-only user creation, no public
signup). **If a customer-facing role or public signup is ever added to the Mk1
backend, per-flag/per-entity authorization must be added** to `GET /flags/{id}`, the
activity feed's entity resolution, and mention/watcher paths. This spec changes none
of those surfaces.

## Testing

- ui-store: push/pop stack semantics (overlay restores underlying context).
- `FlagsFlyout`: Add Flag hidden with null context; preset compose with context set.
- `EntityFlagButton`: `+` renders in flagged state and opens preset compose; pill
  behavior unchanged (1 → thread, >1 → scoped list).
- Badge: count renders in the floating-circle badge at >1, absent at 1, `99+` cap.
