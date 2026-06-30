# Flag System — Manageable Types + "Blocked" Status (Phase 1, Plan 5)

> **For agentic workers:** execute task-by-task with TDD; one commit per task on `feat/flag-system-frontend`. You run IN the live, seeded `accumark-flagsfe` stack worktree — verify against it. **npm only.** Use `superpowers:frontend-design` for the settings pane (mirror the existing dark look + shadcn tokens).

**Goal:** Two things. (1) Promote flag **types** from the hardcoded config map to a **user-managed DB catalog** with an admin **Flags settings pane** — types are add/edit/reorder/deactivate, with a per-entity-type scope. (2) Add a new **`Blocked`** flag status (an *active*/open state) to the fixed status set. Statuses remain hardcoded this round (no status-editing UI).

**Approved design (2026-06-30):**
- **Types → `flag_types` table**, seeded from today's 5 built-ins so existing flags are unaffected. Editable per type: `label`, `color`, `kind` (issue/signal), `is_blocking`, **entity-type scope** (global, or restricted to specific entity types), `is_active`. **`slug` is IMMUTABLE** (existing `flag_flags.type` rows reference it). `flag_flags.type` stays the slug string — no FK churn; `kind` stays snapshotted onto `flag_flags.kind` at creation (so editing a type's kind never rewrites history; no backfill).
- **Deletion = DEACTIVATE (soft-delete).** Unused, non-built-in type → hard delete OK. In-use (`SELECT 1 FROM flag_flags WHERE type=:slug`) OR built-in → **block hard delete (409); deactivate instead** (`is_active=false`): hidden from the raise picker, existing flags keep rendering its color/label, reversible. Rationale: existing flags + the audit trail reference the type; deleting rewrites history (ISO 17025 §7.5.2). Built-ins can be deactivated but never hard-deleted.
- **Per-entity scope:** `flag_types.entity_types` = a JSON array of entity-type slugs; **empty `[]` = global (all)**. The raise picker for an entity offers types that are global OR include that entity. New entity types (preps/peptides/curves) auto-appear in the scope picker via a small registry endpoint.
- **Catalog goes DB-backed:** backend type validation (`is_valid_type`/`kind_for_type`) reads the table; the frontend type catalog (colors/labels/order) is fetched via `useFlagTypes()` and **falls back to the static `FLAG_TYPES` map** so pills never render colorless while loading.
- **Admin-gated:** mutations require `require_admin` on the backend (real enforcement, not just hidden buttons); the pane hides edit affordances for non-admins.
- **`Blocked` status** = a 5th status in the **active/open** category (still wants attention): lifecycle `Open → In Progress ⇄ Blocked → Resolved → Closed`. Statuses stay hardcoded; a future round may promote them to a managed catalog (active/done category model).

**Context (read first):** `backend/flags/{catalog,service,routes,schemas,seams}.py`, `backend/database.py` (`_run_migrations`), `backend/models.py` (mirror `SlaTier` at :841), `backend/auth.py` (`require_admin` :127). Frontend precedent to mirror: `src/components/preferences/panes/SlaPane.tsx` + `src/services/sla.ts` + `src/lib/api.ts` SLA section (:4307) + `PreferencesDialog.tsx`. Flag UI consumers of the catalog: `RaiseFlagButton.tsx`, `FlagsHeaderButton.tsx`, `EntityFlagButton.tsx`, `FlagThread.tsx`, `FlagCard.tsx`, `use-flag-stream-glue.ts`.

## Global Constraints
- **Additive.** `flag_flags` schema unchanged except extending the status CHECK constraint. No FK from `flag_flags.type`. Keep `flag_flags.kind` snapshot behavior.
- **Module cohesion:** flag-type routes live in `backend/flags/routes.py` (prefix `/api/flags`, so `/api/flags/types`), NOT in main.py. **Define `/types*` routes ABOVE the `/{flag_id}` route** (literal-before-param).
- **Verification gates** (full `check:all` has ~19 known-unrelated vitest failures — don't gate on it): per task `npm run typecheck` clean, lint/ast/format clean for your files, your new tests green, backend `pytest tests/test_flags_*.py` green; at the end `npm run build`. Run in-container: `docker compose -p accumark-flagsfe exec -T accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_flags_*.py -q"` and `... accu-mk1-frontend sh -c "cd /app && npm run typecheck"`.
- Zustand selector syntax (ast-grep); TanStack Query; `apiFetch`/`getBearerHeaders`; mirror SLA.

---

### Task 1 (backend): `flag_types` table + seed + extend status CHECK for `blocked`

**Files:** `backend/models.py` (+ import in `backend/main.py:42`), `backend/database.py` (`_run_migrations`), test `backend/tests/test_flags_types_model.py`.

- [ ] **Step 1 (test first):** assert a `FlagType` row round-trips with `slug/label/color/kind/is_blocking/is_active/sort_order/entity_types(JSON)`; and that `flag_flags` accepts a flag with `status="blocked"` (proves the CHECK was extended).
- [ ] **Step 2:** ORM model `FlagType(Base)` (`__tablename__="flag_types"`): `id` pk; `slug` Text unique not-null; `label` Text; `color` Text; `kind` Text; `is_blocking` Bool default false; `is_active` Bool default true server_default true; `sort_order` Int default 0; `entity_types` `JSONB().with_variant(JSON(),"sqlite")` default list; `is_builtin` Bool default false; `created_at`/`updated_at`. Import it in `backend/main.py` near :42.
- [ ] **Step 3:** In `backend/database.py` `_run_migrations` list add: (a) `CREATE TABLE IF NOT EXISTS flag_types (...)`; (b) the **seed** — one `INSERT INTO flag_types (...) SELECT ... WHERE NOT EXISTS (SELECT 1 FROM flag_types WHERE slug=...)` per built-in (`blocker`#e5484d issue blocking, `critical`#e8730a issue blocking, `question`#3b82f6 issue, `waiting_on_customer`#8b5cf6 issue, `ready_for_verification`#22c55e signal), `is_builtin=true`, `entity_types='[]'`, `sort_order` 0..4 (mirror `FLAG_TYPE_ORDER`); (c) **extend the status CHECK** — a NEW statement (do NOT edit the existing CREATE TABLE line, it's `IF NOT EXISTS`): `ALTER TABLE flag_flags DROP CONSTRAINT IF EXISTS flag_flags_status_check, ADD CONSTRAINT flag_flags_status_check CHECK (status IN ('open','in_progress','blocked','resolved','closed'))`. ⚠️ Without (c), any write of `blocked` 500s.
- [ ] **Step 4:** run test green. **Commit:** `feat(flags): flag_types table + built-in seed + blocked status constraint`

### Task 2 (backend): types service (validation + CRUD with deactivate/in-use guards)

**Files:** create `backend/flags/types_service.py`; test `backend/tests/test_flags_types_service.py`.

- [ ] **Step 1 (test first):** `list_types(db, entity_type=None, active_only=False)` returns built-ins; `is_valid_type(db,'blocker')` True / unknown False; `kind_for_type(db,'ready_for_verification')=='signal'`; `is_allowed_for_entity(db,slug,'sample')` True when `entity_types=[]` (global) and respects a restricted list; `create_type` then `delete_type` of an UNUSED custom type succeeds; `delete_type` of a built-in OR an in-use type raises `ConflictError` (and `deactivate` sets `is_active=false`); slug is rejected on update (immutable).
- [ ] **Step 2:** Implement: `list_types`, `get_type`, `is_valid_type`, `kind_for_type`, `is_allowed_for_entity` (global when `entity_types` empty), and CRUD — `create_type` (generate slug from label if absent; unique; never duplicate a built-in slug), `update_type` (label/color/kind/is_blocking/entity_types/is_active/sort_order; **ignore/reject slug changes**), `delete_type` (raise `ConflictError` if `is_builtin` or `EXISTS(flag_flags.type==slug)`; else delete), `set_active(db,id,bool)`. Reuse `flags.errors`.
- [ ] **Step 3:** green. **Commit:** `feat(flags): flag-type service — validation, entity scope, deactivate/in-use guards`

### Task 3 (backend): routes + wire create_flag to DB types + entity-types endpoint

**Files:** `backend/flags/routes.py`, `backend/flags/schemas.py`, `backend/flags/service.py`; extend `backend/tests/test_flags_routes.py`.

- [ ] **Step 1 (test first):** `GET /api/flags/types` (any user) lists built-ins; `POST/PUT/DELETE /api/flags/types*` as a non-admin → 403, as admin → works; `DELETE` an in-use/built-in type → 409; creating a flag with a type not allowed for its entity → 400; `GET /api/flags/entity-types` lists registered entity types.
- [ ] **Step 2:** Schemas: `FlagTypeResponse` (from_attributes), `FlagTypeCreate`, `FlagTypeUpdate` (all-optional, **no slug**). Add `"blocked"` to `FlagStatus` Literal (`schemas.py:10`).
- [ ] **Step 3:** Routes in `flags/routes.py` **above `/{flag_id}`**: `GET /types` (`Depends(get_current_user)`, query `entity_type?`, `active_only?`), `POST /types` + `PUT /types/{id}` + `DELETE /types/{id}` (`Depends(require_admin)`; map `ConflictError`→409 via existing `_http`). Add `GET /entity-types` (`get_current_user`) returning the registered entity-type **slugs** from `seams._REGISTRY` (just the keys). ⚠️ The registry's `label` is a per-instance callable ("Vial 42"), NOT a type-level name, so the endpoint returns slugs only; the **frontend resolves display names from `flag-entity.ts` `ENTITY_META`** (which already has "Sample"/"Vial"/"Worksheet"). Unknown slugs fall back to the slug text. Import `from auth import require_admin`.
- [ ] **Step 4:** `service.create_flag`: replace `catalog.is_valid_type(type)` / `catalog.kind_for_type(type)` (service.py:63,73) with `types_service.is_valid_type(db,type)` + `types_service.kind_for_type(db,type)`, and after the entity check add `if not types_service.is_allowed_for_entity(db, type, entity_type): raise BadRequestError(...)`. (Keep the `kind` snapshot onto the flag.)
- [ ] **Step 5:** green (existing + new). **Commit:** `feat(flags): /api/flags/types CRUD (admin) + entity-scope validation + entity-types endpoint`

### Task 4 (backend): `Blocked` status everywhere it's hardcoded

**Files:** `backend/flags/catalog.py`, `backend/flags/service.py`; test `backend/tests/test_flags_blocked_status.py`.

- [ ] **Step 1 (test first):** a flag can transition to `blocked` and is counted as open (appears in `all_open` + `summary`); moving `blocked→open/in_progress` is legal; moving to `blocked` does NOT stamp `resolved_at`.
- [ ] **Step 2:** `catalog.py`: add `"blocked"` to `STATUSES` (:18); in `LEGAL_TRANSITIONS` (:22-27) add a `"blocked"` key (→ open/in_progress/resolved/closed) and add `"blocked"` into the target sets of open/in_progress/resolved/closed. **Centralize** the open set: add `OPEN_STATES = ("open", "in_progress", "blocked")` to `catalog.py` and export it.
- [ ] **Step 3:** `service.py`: replace the three local `open_states = ("open","in_progress")` / `("open","in_progress")` usages (list_flags :101, summary :130, change_status reopen :226) to use `catalog.OPEN_STATES` (so `blocked` is "open" and reopening from blocked clears `resolved_at`).
- [ ] **Step 4:** green. **Commit:** `feat(flags): add Blocked status (active/open) to lifecycle + counts`

### Task 5 (frontend): flag-types data layer + fetched catalog map

**Files:** `src/lib/api.ts` (or flags-api), `src/services/flag-types.ts` (new), `src/components/flags/flag-catalog.ts`; test `src/services/__tests__/flag-types.test.tsx`.

- [ ] **Step 1:** API: `FlagType` interface (`id,slug,label,color,kind,is_blocking,is_active,sort_order,entity_types,is_builtin`) + `getFlagTypes(params?)`, `createFlagType`, `updateFlagType`, `deleteFlagType`, `getFlagEntityTypes()` — mirror `api.ts:4307` SLA fns (bearer headers, throw on !ok).
- [ ] **Step 2:** `src/services/flag-types.ts` mirroring `services/sla.ts`: `flagTypeKeys`, `useFlagTypes(params?)` list query (staleTime 5m), `useCreateFlagType/useUpdateFlagType/useDeleteFlagType` (invalidate `flagTypeKeys` + invalidate `['flags']` so pills recolor; `toast.error` on error), and `useFlagEntityTypes()`.
- [ ] **Step 3:** Add a `useFlagTypesMap()` hook (returns `Record<string, FlagTypeDef>` built from `useFlagTypes({})`), with the static `FLAG_TYPES` (flag-catalog.ts) as `initialData`/fallback so it is never empty. Keep static `FLAG_TYPES`/`FLAG_TYPE_ORDER`/`flagTypeDef` as the fallback seed. ⚠️ **The map MUST include INACTIVE types** (call `useFlagTypes({})` with NO `active_only` filter) — a deactivated type can still own open flags, and their pills/chips must keep resolving its color/label. (`active_only` filtering is only for the raise *picker*, not for color resolution.)
- [ ] **Step 4:** typecheck + test green. **Commit:** `feat(flags-ui): flag-types API + query hooks + fetched catalog map (static fallback)`

### Task 6 (frontend): repoint catalog consumers to fetched types

**Files:** `RaiseFlagButton.tsx`, `FlagsHeaderButton.tsx`, `EntityFlagButton.tsx`, `FlagThread.tsx`, `FlagCard.tsx`, `use-flag-stream-glue.ts`.

- [ ] **Step 1:** **RaiseFlagButton** (type picker, currently iterates `FLAG_TYPE_ORDER` :22,168,175): use `useFlagTypes({ entity_type, active_only: true })` so the picker shows only types allowed for that entity and still active, ordered by `sort_order`, colored from the row.
- [ ] **Step 2:** **FlagsHeaderButton** (count chips :6,45,46): ⚠️ drive the chips off the **`summary.by_type` keys** (the count source of truth) — render one chip per type that actually has open flags — and resolve each chip's color/label/order through `useFlagTypesMap()` (which includes inactive types). Do NOT iterate the *active* type list to build chips: a deactivated type with open flags must still show its count, and a brand-new active-but-zero-flag type needs no chip. Order by the map's `sort_order`.
- [ ] **Step 3:** **flagTypeDef call sites** (EntityFlagButton :122, FlagThread :114, FlagCard :41, use-flag-stream-glue :35/:143): resolve color/label from `useFlagTypesMap()` (falling back to static `flagTypeDef` for unknown slugs). `use-flag-stream-glue.ts` is a hook → use the map hook, or read the query cache via `queryClient.getQueryData(flagTypeKeys...)` if it must resolve at event time. Don't regress the toast.
- [ ] **Step 4:** typecheck + the existing flag component tests green (update any that asserted static colors). **Commit:** `feat(flags-ui): flag pills + pickers use the managed (fetched) type catalog`

### Task 7 (frontend): `Blocked` status in the UI

**Files:** `src/lib/flags-api.ts` (:20), `FlagThread.tsx` (:44-55), `EntityFlagButton.tsx` (:26,:43-48).

- [ ] **Step 1:** Add `"blocked"` to the `FlagStatus` union (flags-api.ts:20). In `FlagThread` add `blocked` to `STATUS_LABELS` (→ "Blocked") + a `STATUS_DOT` color (e.g. amber/orange — pick a token distinct from in-progress) — the status `<select>` auto-includes it. In `EntityFlagButton` add `blocked` to `STATUS_LABELS` and to `OPEN_STATES` (so a blocked flag keeps the button in the "flagged"/open state and is counted).
- [ ] **Step 2:** typecheck + tests green. **Commit:** `feat(flags-ui): surface Blocked status (labels, dot, open-state)`

### Task 8 (frontend): the Flags settings pane

**Files:** create `src/components/preferences/panes/FlagsPane.tsx`; edit `PreferencesDialog.tsx`; `locales/en.json` (+ fr/ar).

- [ ] **Step 1:** `FlagsPane` mirroring `SlaPane`: `isAdmin = useAuthStore(s => s.user?.role === 'admin')`; a `SettingsSection` "Flag Types" listing `useFlagTypes({})` sorted by `sort_order`, each row an editable card (mirror `TierCard`): label (text), color (swatch/hex), kind (issue/signal select), blocking (toggle), **Applies to** (multi-select from `useFlagEntityTypes()`, "All" = empty array), active toggle. Admin-only "Add type" button; non-admins get the read-only branch. **Delete** button: if the API returns 409 (built-in/in-use), surface "In use or built-in — deactivate instead" and offer the active toggle (don't hard-delete). Commit edits on blur via the mutations.
- [ ] **Step 2:** Register in `PreferencesDialog.tsx`: add `'flags'` to the `PreferencePane` union (:36), a `navigationItems` entry (:54, `icon: Flag` from lucide), import `FlagsPane` (:33), and the `{activePane === 'flags' && <FlagsPane />}` render line (:142). Add `preferences.flags*` i18n keys (mirror the SLA block, en.json:71).
- [ ] **Step 3:** typecheck + `npm run build` green. **Commit:** `feat(flags-ui): Flags settings pane — manage types (admin)`

### Task 9: verification + live stack

- [ ] **Step 1:** All gates green (typecheck, lint/ast/format on your files, new vitest + backend pytest, `npm run build`). Diff against HEAD if unsure whether a failure is pre-existing.
- [ ] **Step 2:** In the live `accumark-flagsfe` stack: open Settings → Flags, confirm the 5 built-ins list; add a custom type scoped to `sub_sample`, confirm it appears in a vial's raise picker but NOT a worksheet's; try to delete a built-in/in-use type → blocked with the deactivate path; deactivate a type → gone from the picker, existing flag still renders. Set a flag to **Blocked** → it stays counted as open on the button/flyout. **Leave the stack UP.**
- [ ] **Step 3:** `git push` (updates PR #28). Final report: per-task results, gate outputs, files, the stack URL, the exact `blocked` dot color chosen, and any deviations.

## Self-Review
- Built-ins seeded idempotently; `flag_flags.type` stays slug (no FK); `kind` snapshot preserved (no backfill). ✓
- Deletion = deactivate for built-in/in-use; hard-delete only unused custom. ✓
- The named `flag_flags_status_check` is extended via a dedicated DROP+ADD migration (not the IF-NOT-EXISTS create). ✓
- Frontend never renders colorless: `useFlagTypesMap()` falls back to static `FLAG_TYPES`. ✓
- Admin enforced on the backend (not just hidden buttons). ✓
- `Blocked` joins the centralized `OPEN_STATES` so all open-counts include it. ✓
