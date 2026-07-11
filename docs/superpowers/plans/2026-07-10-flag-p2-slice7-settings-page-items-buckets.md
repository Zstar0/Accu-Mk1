# Flag P2 Slice 7 — Settings Page, Items, Type-Bucket Board

> **For agentic workers:** execute task-by-task, TDD, per-task commits with both trailers. This plan is intentionally leaner than slices 1–6 — the executor is expected to have deep working context of this codebase; every unknown is named with a content anchor to verify on-branch.

**Goal:** (1) Settings moves from the PreferencesDialog overlay to a full `#settings` page; (2) "Entities" renames to **Items** across flag UI; (3) user-manageable **Items** (virtual item kinds — categories like "General Task", "Purchase Task" with no Mk1 rows behind them); (4) a drag-and-drop **type-bucket board** for scoping flag types to items.

**Origin:** live review feedback from Forrest, 2026-07-10. Extends spec §5 (general tasks) + Phase 1 type catalog.

## Decisions (locked with Forrest)

- Full page, not a bigger dialog. Existing panes move verbatim; the dialog is retired.
- "All items" is a DISTINCT bucket representing the existing global state (`entity_types=[]`) — new item kinds automatically inherit global types; dragging a type out of All-items into specific buckets restricts it.
- Items rename is **UI strings only** — API/DB keep `entity_*` naming (Core-COA naming precedent).
- Virtual item kinds are pure categories: flags anchor to the KIND (`entity_id` NULL enforced); no deep-link/context/state-watch/typeahead affordances (must degrade gracefully, not error).
- "General Task" = seeded builtin kind; existing NULL-anchor flags are BACKFILLED to it (nothing is merged/deployed, safe now, avoids dual representation forever). NULL anchor stays legal at the model layer.
- In-use kinds deactivate rather than delete (mirror flag-types ISO-audit rule). Slug immutable.

---

### Task 1: Settings full page (`#settings`)

- New `src/components/preferences/SettingsPage.tsx`: full-page layout (left nav from the SAME `navigationItems` + pane-content switch currently in `PreferencesDialog.tsx:60-160` — extract the registry + pane-render map to `src/components/preferences/panes.ts(x)` and share). Wide content area (the point of this task — the board in Task 5 needs it).
- Register hash route `#settings` (+ optional `?pane=` deep link) — follow the registration idiom in `src/lib/hash-navigation.ts` / wherever `#hplc-analysis/...` routes mount (verify on-branch; the ast-grep pre-existing errors live in that file — do NOT reformat it).
- Repoint every opener (MainWindow gear at `MainWindow.tsx:188` mount + whatever ui-store action opens the dialog) to navigate to `#settings`. Delete the `<PreferencesDialog />` mount and the Dialog wrapper component once nothing references it. Keep any admin gating exactly as it exists today (verify how the dialog gates — memory says settings became admin-only; match it).
- Tests: route renders the page with nav items; pane switch works; gear navigates. Keep existing pane component tests untouched (panes must not change).

### Task 2: Item kinds backend (`flag_item_kinds`)

- Table + model `flag_item_kinds(id, slug UNIQUE immutable, label, color, is_active, is_builtin, sort_order, created_at, updated_at)`; idempotent DDL in the database.py flags block; seed builtin `general_task` / "General Task" (pick a neutral color). Mirror `flag_types`/`types_service.py` structure — a `kinds_service.py` with the same shape (seed_builtins, CRUD, deactivate-not-delete when `SELECT 1 FROM flag_flags WHERE entity_type=:slug` hits, slug immutability).
- Registry bridge in `seams.py`: virtual kinds resolve like registered entities WITHOUT closures — add a `resolve_virtual_kind(db, entity_type)` consulted by the places that gate on `is_registered` (create_flag validation, entity-link add, routes) and by label resolution (label = kind label; `resolve_context` returns a minimal `{label, deep_link: null}` or None — verify what FlagCard needs to render a kind-anchored flag sensibly). `can_flag` = True; NO state/search resolvers (arm-watch on a virtual kind must 400 with the existing "unsupported" path; typeahead entity-search returns []).
- `create_flag`: `entity_type=<kind slug>` requires `entity_id` NULL (400 otherwise); type scoping via the SAME `entity_types` mechanism (kind slugs join the scoping vocabulary).
- **Backfill migration:** `UPDATE flag_flags SET entity_type='general_task' WHERE entity_type IS NULL` (idempotent by construction). FE compose: "General (no item)" option becomes the kinds list (Task 4 wires UI; keep the API accepting NULL for robustness).
- Admin CRUD routes `/api/flags/item-kinds` (GET list = get_current_user; POST/PUT/DELETE = require_admin; literal routes above `/{flag_id}`).
- Tests: seed, CRUD, in-use deactivate block, create_flag on kind (+ entity_id rejection), backfill idempotence, watch-arm 400, entity-search [].

### Task 3: Items rename (UI strings)

- Flag surfaces: "All entities"→"All items" (FlagsFilterBar), "Related:" chips heading, link-picker labels, RaiseFlagButton anchor selector, any "entity" user-facing string in flag components (grep `src/components/flags` for user-visible "entit" — code identifiers stay). i18n: strings are centralized per Phase 1 (`i18n strings centralized but not extracted`) — follow the existing labelKey/i18n idiom where used, plain strings where the module uses plain strings.
- The filter's "General" option label becomes the kinds list contribution (Task 4).

### Task 4: Items in the compose/filter/admin UI

- Filter dropdown: code kinds (Sample, Sub Sample, Worksheet) + ACTIVE virtual kinds (each filterable by its slug; `filterFlags` entityType match already works on slug equality — the `'general'` sentinel from slice 2 now maps to `general_task` + legacy NULL: keep matching BOTH `entity_type === 'general_task' || entity_type == null` under the General Task option for belt-and-suspenders).
- RaiseFlagButton: anchor selector lists virtual kinds ("General Task", "Purchase Task", …) alongside the page-preset entity; picking a kind posts `entity_type=<slug>, entity_id=null`.
- Settings → Flags pane gains an **Items** section: list + create/rename/recolor/deactivate (mirror the recurring-section admin idiom from slice 5 / the type management CRUD).
- `useItemKinds()` query hook mirroring `useFlagTypes()` (cached, seed fallback).

### Task 5: Type-bucket board (the headline UI)

- In the Flags pane on the NEW full page: **bucket board** — top bucket "All items" (= `entity_types: []`), then one bucket per kind (code kinds + active virtual kinds). Right rail: full type palette (colored chips). Drag a chip into a bucket → adds that kind's slug to the type's `entity_types` (PUT via existing types API); drop on "All items" → clears to `[]` (confirm dialog if it was restricted: "make X available everywhere?"); drag out of a bucket → removes that slug. A type may sit in MULTIPLE buckets (chips render in every bucket whose slug they carry; the palette chip shows a count badge).
- DnD implementation: **check what the order-status kanban uses** (there IS a kanban with draggable sample cards — find its mechanism) and reuse it; if it's bespoke/none, use native HTML5 drag events. **NO new npm dependency without flagging to the orchestrator first.**
- Inactive types render dimmed but draggable (admins may re-scope before reactivating). is_builtin types are scoping-editable (scope was always admin-editable), just not deletable.
- Fallback affordance: each bucket chip has a small ✕ (click-to-remove) so the board is fully usable without DnD (a11y + touch).
- Tests: pure scoping-transition helpers (add/remove/clear semantics incl. multi-bucket) + render test (buckets reflect entity_types; ✕ calls the PUT). DnD interaction itself = visual pass.

### Task 6: Slice gates

Individual gates as established (tsc, eslint on hunks, flag-dir vitest, sequential full-run failure-set diff vs baseline, build, backend suite). No push/PR — orchestrator reviews, pushes, hot-reloads the review stack.
