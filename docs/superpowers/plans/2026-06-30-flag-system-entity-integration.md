# Flag System — Entity Integration Implementation Plan (Phase 1, Plan 4 of 4)

> **For agentic workers:** execute task-by-task with TDD; one commit per task on `feat/flag-system-frontend`. You are running IN the existing `flagsfe` stack worktree against a LIVE, seeded stack — use it to verify. **npm only.**

**Goal:** Make flags live on the work itself. Two pieces: (1) **richer flag cards** — resolve real entity context server-side (Sample ID + analytes + a real label + a deep link) so a vial card shows what it's about and links to it; (2) a **stateful flag button** on entity pages (sample / vial / worksheet) that is an obvious indicator when the item is flagged and opens the flag (or a raise-flag compose) on click.

**Design (approved 2026-06-30):**
- Entity context is resolved **server-side via the entity registry** (the existing host seam that already owns label + deep-link) and serialized onto flag responses — no per-card client round-trips, and the flag module core stays entity-agnostic.
- The **parent (sample) button aggregates its sub-samples' flags**; a **sub-sample page shows a button for just that vial**. Parent↔vial hierarchy is host-domain knowledge, so it lives in a new registry seam `descendants(db, id)` — the flag module never learns what a "vial" is.
- **Lot is deferred** — leave an additive `lot: null` field in the context shape; do not fetch it (it lives only in SENAITE; out of scope this round).
- The basic "is this entity flagged" check reuses the EXISTING `GET /api/flags?entity_type&entity_id`; only the aggregate (self + descendants) adds a parameter.

**Context — what's already on `master`/this branch:** Plan 1 REST (`/api/flags*`, list supports `entity_type`/`entity_id` filters), Plan 2 SSE, Plan 3 UI (`FlagsFlyout`, `FlagCard`, `FlagThread`, `RaiseFlagButton`, `flag-entity.ts`, `flags-api.ts`, `use-flags.ts`, `ui-store` flag state, `MainWindow` integration). **Read those before editing.** Backend entity registry + the resolvers you extend: `backend/flags/seams.py` (`EntitySpec`, `register_mk1_entities`, `_sample_label`/`_sub_sample_label`). Flag responses are built in `backend/flags/routes.py` via `FlagResponse.model_validate(orm)` — you will switch list/detail/summary-feeding routes to attach a resolved `entity` context.

## Global Constraints

- **Additive.** No change to existing REST shapes beyond ADDING an optional `entity` object to `FlagResponse`/`FlagDetailResponse` and an optional `include_descendants` query param. No table changes. Module core stays entity-agnostic — all Mk1 knowledge lives in `register_mk1_entities` closures.
- **Module purity:** new behavior goes through `EntitySpec` seams (`context`, `descendants`), resolved by `seams.resolve_context(db, type, id)` / `seams.resolve_descendants(db, type, id)`. `service.py`/`routes.py` never import `models.LimsSubSample` etc. directly for this — only the registry closures do.
- **Frontend:** Zustand selector syntax (ast-grep enforced); TanStack Query for server data; `apiFetch`; mirror existing flag components. Light + dark.
- **Verification gates** (the full `check:all` has ~19 known-unrelated vitest failures — do NOT gate on it): per task, `npm run typecheck` clean, lint/ast/format clean for your files, your NEW tests green (`npx vitest run src/components/flags src/hooks/use-flags`), and backend `pytest tests/test_flags_*.py` green; at the end `npm run build` succeeds. Backend tests run in-container: `docker compose -p accumark-flagsfe exec -T accu-mk1-backend sh -c "cd /app && python -m pytest tests/test_flags_*.py -q"` (install pytest ephemerally if missing).

---

## Data facts (verified — use these exact relationships)

- Vial = `LimsSubSample`: `id` (= flag `entity_id` for `sub_sample`), `sample_id` (e.g. `P-0071-S01`), `vial_sequence`, `parent_sample_pk` → `LimsSample.id`, `.parent_sample` relationship.
- Parent = `LimsSample`: `sample_id` (e.g. `P-0071`) — the human Sample ID. (No lot column — Lot deferred.)
- Vial analyses = `LimsAnalysis WHERE lims_sub_sample_pk == vial.id`; each row's `.title` (and `.keyword`) is the analysis service name. De-dupe titles; a vial may have several.
- A sample's vials (for `descendants`) = `LimsSubSample WHERE parent_sample_pk == sample.id`.

## Entity-context shape (LOCKED — backend produces, frontend consumes)

`FlagResponse.entity` (optional object; null if the registry can't resolve):
```json
{
  "entity_type": "sub_sample",
  "entity_id": "42",
  "label": "P-0071-S01",
  "sample_id": "P-0071",
  "analyses": ["PEPT-Total", "HPLC-PUR"],
  "lot": null,
  "deep_link": { "kind": "sample", "id": "P-0071" }
}
```
- `label`: best human label (vial → its `sample_id`; sample → its `sample_id`; worksheet → `Worksheet {id}`).
- `sample_id`: the parent sample's human id for a vial; the sample's own id for a sample; null for worksheet.
- `analyses`: de-duped service titles tied to the entity (vial → its analyses; sample → omit/empty for now; worksheet → empty).
- `deep_link.kind` ∈ `sample | worksheet | none`; `id` is the argument for the frontend navigator (`navigateToSample(id)` for `sample`, `openWorksheetDrawer(Number(id))` for `worksheet`). For a vial, kind=`sample` + the parent `sample_id` (vials are viewed inside the parent — this fixes the suppressed-arrow gap).

---

### Task 1 (backend): entity registry — `context` + `descendants` seams

**Files:** `backend/flags/seams.py`; test `backend/tests/test_flags_seams_context.py`.

- [ ] **Step 1 (test first):** register Mk1 entities against a SQLite session seeded with a `LimsSample` + two `LimsSubSample` + a couple `LimsAnalysis`, and assert: `resolve_context(db,"sub_sample",vial.id)` returns `{label: vial.sample_id, sample_id: parent.sample_id, analyses: [..titles..], lot: None, deep_link: {kind:"sample", id: parent.sample_id}}`; `resolve_context(db,"sample",s.id)` returns sample label + own sample_id + `deep_link.kind=="sample"`; `resolve_descendants(db,"sample",s.id)` returns the two `("sub_sample", str(vial.id))` pairs; `resolve_descendants(db,"worksheet",x)` returns `[]`.
- [ ] **Step 2:** Extend `EntitySpec` with optional `context: Callable[[Session,str],dict] | None` and `descendants: Callable[[Session,str],list[tuple[str,str]]] | None`. `register_entity(..., context=None, descendants=None)`. Add module helpers `resolve_context(db, entity_type, entity_id) -> dict|None` and `resolve_descendants(db, entity_type, entity_id) -> list[tuple[str,str]]` (return `[]`/`None` when unregistered or resolver absent — never raise into a request). Build the `deep_link`/`label`/`analyses` inside the Mk1 closures in `register_mk1_entities` (import `LimsSample`/`LimsSubSample`/`LimsAnalysis` lazily inside the closures, mirroring `_sample_label`). For `sub_sample.context`, load the vial, then its parent for `sample_id`, and query distinct `LimsAnalysis.title` for analyses; `deep_link={"kind":"sample","id": parent.sample_id}`. For `sample.descendants`, query its sub_samples.
- [ ] **Step 3:** Run the test → green. **Commit:** `feat(flags): entity registry context + descendants seams (Mk1 resolvers)`

### Task 2 (backend): serialize `entity` onto responses + `include_descendants`

**Files:** `backend/flags/schemas.py`, `backend/flags/service.py` (list filter), `backend/flags/routes.py`; extend `backend/tests/test_flags_routes.py`.

- [ ] **Step 1 (test first):** in the route test, create a flag on a sub_sample (seed the lims rows in the test db), GET `/api/flags?tab=all_open`, assert the row carries `entity.sample_id` + `entity.deep_link.kind=="sample"` + non-empty `entity.analyses`. Add a test that `GET /api/flags?entity_type=sample&entity_id=<id>&include_descendants=true` returns flags raised on the sample's vials.
- [ ] **Step 2:** Add `EntityContext` Pydantic model + `entity: Optional[EntityContext] = None` to `FlagResponse` (inherited by `FlagDetailResponse`). In `routes.py`, after building each response, attach `entity = seams.resolve_context(db, r.entity_type, r.entity_id)` (helper `_with_entity(db, flag)` returning the response). Apply to `create_flag`, `list_flags`, `get_flag` responses.
- [ ] **Step 3:** `service.list_flags`: add `include_descendants: bool = False`. When true and an `entity_type`+`entity_id` filter is given, expand the filter to `(self) ∪ resolve_descendants(...)` — match flags whose `(entity_type, entity_id)` is in that set (use a tuple `IN` / `or_` of pairs). Thread the param through the route (`include_descendants: bool = False`).
- [ ] **Step 4:** Run `pytest tests/test_flags_*.py` → green (existing + new). **Commit:** `feat(flags): serialize entity context on responses + include_descendants rollup`

### Task 3 (frontend): types + hooks for entity context & entity flags

**Files:** `src/lib/flags-api.ts`, `src/hooks/use-flags.ts`, `src/components/flags/flag-entity.ts`; test `src/hooks/__tests__/use-flags.test.tsx`.

- [ ] **Step 1:** Add `EntityContext` TS type + `entity?: EntityContext | null` on `FlagResponse`. Add `listEntityFlags(entityType, entityId, includeDescendants)` calling `/api/flags?entity_type&entity_id[&include_descendants=true]`.
- [ ] **Step 2:** `use-flags.ts`: add `useEntityFlags(entityType, entityId, { includeDescendants })` query (key `['flags','entity',entityType,entityId,includeDescendants]`, enabled when ids present). Ensure SSE invalidation (Plan 3's glue invalidates `['flags']`) also refreshes these — confirm the key is under `['flags', ...]`.
- [ ] **Step 3:** `flag-entity.ts`: drive label + deep-link from the server `entity` context when present (fallback to the old `entityLabel` when absent). `navigateToEntity` uses `entity.deep_link` (`kind:"sample"`→`navigateToSample(id)`, `kind:"worksheet"`→`openWorksheetDrawer(Number(id))`). Keep it pure/testable.
- [ ] **Step 4:** typecheck + targeted tests green. **Commit:** `feat(flags-ui): entity-context types + useEntityFlags hook + deep-link from context`

### Task 4 (frontend): richer FlagCard (link + Sample ID + analytes)

**Files:** `src/components/flags/FlagCard.tsx`; update `src/components/flags/__tests__/FlagsFlyout.test.tsx`.

- [ ] **Step 1:** Make the entity chip a real link (whole chip clickable → `navigateToEntity`), using `flag.entity?.label ?? entityLabel(...)`. Keep the keyboard/`stopPropagation` behavior (card click opens thread; chip click navigates).
- [ ] **Step 2:** Add a secondary context line under the title for vials/samples: `Sample {entity.sample_id} · {analyses.join(', ')}` (omit gracefully when absent; truncate long analyte lists). Match the dark mockup's muted style.
- [ ] **Step 3:** Test the card renders the sample id + analytes + that clicking the chip navigates. typecheck + tests green. **Commit:** `feat(flags-ui): flag cards show entity link + Sample ID + analytes`

### Task 5 (frontend): `EntityFlagButton` (stateful indicator)

**Files:** create `src/components/flags/EntityFlagButton.tsx`, `__tests__/EntityFlagButton.test.tsx`.

- [ ] **Step 1 (test first):** render with a mocked `useEntityFlags` returning (a) 0 flags → an outline "Flag" affordance whose click opens the raise compose; (b) 1 open flag → a prominent colored badge whose click calls `openFlagThread(id)`; (c) 3 flags → badge with count "3" whose click opens the flyout filtered to this entity.
- [ ] **Step 2:** Implement `<EntityFlagButton entityType entityId includeDescendants? size? />`:
  - `const flags = useEntityFlags(...)`; `open = flags.filter(status in open/in_progress)`.
  - **Unflagged:** subtle outline button (`🚩 Flag`) → opens `RaiseFlagButton`'s compose (reuse it / extract its popover) prefilled with this entity.
  - **Flagged:** a **bold, filled, colored** flag pill — color = the dominant (most severe) open flag's type color from `flag-catalog`; show the count when >1; sized to be attention-catching (`size="lg"` variant ⇒ larger icon + padding); subtle glow/pulse acceptable. Click: exactly 1 open flag → `openFlagThread(it.id)`; >1 → open the flyout filtered to this entity (Task 6 filter state).
  - Severity order for "dominant": blocker > critical > waiting_on_customer > question > ready_for_verification.
- [ ] **Step 3:** typecheck + tests green. **Commit:** `feat(flags-ui): EntityFlagButton — stateful flag indicator`

### Task 6 (frontend): flyout entity-filter view + wire all three pages

**Files:** `src/store/ui-store.ts` (+test), `src/components/flags/FlagsFlyout.tsx`, and the three host pages.

- [ ] **Step 1:** ui-store: add an optional entity filter `flagsEntityFilter: {type,id,includeDescendants}|null` + `openFlagsForEntity(type,id,opts)` (opens the flyout in a filtered mode) + clear on close. Test it.
- [ ] **Step 2:** `FlagsFlyout`: when `flagsEntityFilter` is set, show a header chip ("Flags on {label} ✕") and list `useEntityFlags(filter)` instead of the tabs (a "clear filter" returns to tabs).
- [ ] **Step 3:** Wire `EntityFlagButton` into the three host surfaces:
  - **Sample details page** (`src/components/senaite/SampleDetails.tsx`): place it **prominently top-right by the sample thumbnail/header**, `entityType="sample"`, `includeDescendants` (aggregates its vials), `size="lg"`.
  - **Vial** surface: upgrade the existing `RaiseFlagButton` usage in `VialsQuickLookDialog.tsx` (and/or the per-vial row) to `EntityFlagButton entityType="sub_sample"` for that vial (no descendants).
  - **Worksheet** surface (`WorksheetDrawerHeader.tsx` or the worksheet page header): `entityType="worksheet"`.
  Find exact mount points by reading each file; match its layout. Keep buttons theme-aware.
- [ ] **Step 4:** typecheck + targeted tests green. **Commit:** `feat(flags-ui): flyout entity filter + flag buttons on sample/vial/worksheet pages`

### Task 7 (docs): developer guide — "register a new flaggable entity"

**Files:** create `docs/developer/flags-add-entity.md`.

The point of this doc is to make the next entity type (sample preps, peptides, calibration curves) a copy-paste. Keep it concise and concrete.

- [ ] **Step 1:** Write `docs/developer/flags-add-entity.md` covering: the plugin model (opaque `(entity_type, entity_id)`, no FK, the entity-registry seam is the ONLY host coupling point); the 3 edits to add a type — (1) backend `register_entity("<type>", label=, deep_link=, context=, can_flag=, descendants=)` in `register_mk1_entities()` with what each closure must return (point at the `EntityContext` shape + `deep_link.kind`), (2) frontend `ENTITY_META` entry in `flag-entity.ts`, (3) drop `<EntityFlagButton entityType="<type>" entityId=… />` on the page; the per-entity costs (a real navigable `deep_link` route + a small `context` query); and a **worked example for `sample_prep`** (note `sample_preps` is raw-psycopg in the same DB — resolve via the existing prep service/query, not a new ORM model) plus a one-liner each for `peptide` (`client_peptides`) and `calibration_curve` (`CalibrationCurve`). State explicitly what you do NOT touch (core tables, migrations, existing entity types). Cross-link the design spec `docs/superpowers/specs/2026-06-27-flag-system-design.md` §3/§8.
- [ ] **Step 2:** **Commit:** `docs(flags): how to register a new flaggable entity`

### Task 8: full verification + refresh the live stack + seed

- [ ] **Step 1:** `npm run typecheck`, lint/ast/format (your files), `npx vitest run src/components/flags src/hooks/use-flags src/store/ui-store`, backend `pytest tests/test_flags_*.py`, and `npm run build` — all green/clean (ignore the ~19 pre-existing unrelated vitest failures; diff against HEAD if unsure).
- [ ] **Step 2:** You are editing the LIVE `flagsfe` worktree; the dev servers reload. Confirm the app still loads at the stack's Mk1 URL and that the seeded vial flags now show Sample ID + analytes + a working link, and that a flagged sample/vial/worksheet shows the prominent button. Re-seed if the data thinned. **Leave the stack UP.**
- [ ] **Step 3:** Push (`git push`) to update PR #28 (or open a follow-up PR if cleaner — your call; note which). Final report: per-task results, gate outputs, files, PR, the stack URL, and any deviations (esp. exact button placements chosen, and Lot left deferred).

## Self-Review
- Module purity: all Mk1 hierarchy/label/analysis knowledge is inside `register_mk1_entities` closures; `service`/`routes` stay generic. ✓
- Additive: only new optional response field + new query param + new component + page mounts. ✓
- Lot deferred with an additive `lot` hook. ✓
- Parent aggregates vials (descendants seam); vial page is self-only. ✓
