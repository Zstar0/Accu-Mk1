# Native Manage Analyses + parent-row lifecycle — design

*2026-08-18. Brainstormed with the Handler; rulings A / explicit-only / profile-level / approach Y
recorded inline. Builds on PR #97 (native parent placeholder rows, `provenance='ordered'`) and
PR #98 (amendment audit), which are in the catalog-arc base (`b30d9fc0`), and on spec 4's custody
edges (`VialProfileAssignment`). Citations are against the arc composition
`C:/tmp/Accu-Mk1-arcitest` (`integration/catalog-arc-itest` @ `96dd0f14`); the devbox arcitest
Mk1 (`~/worktrees/mk1-arcitest` @ `9714cd42`) is the same base plus PR #106. **Build base: `b30d9fc0`**
(the #98 tip) — every S-slice is based there and merged into the composition; this slice follows the
same convention. Custody edges exist at that base; S4's `catalog_snapshot` does not (see §4.2 Re-sync).*

## 1. Problem

Two live gaps, both proven on `arcitest` on 2026-08-18 against today's fresh order `PB-0156`:

1. **Parent placeholder rows only mint at registration.** `_native_placeholders_at_registration_bg`
   (`backend/main.py:15150`, scheduled unconditionally from `POST /s2s/lims-samples` at
   `main.py:20104`) is the **only** call site of `seed_parent_placeholders`
   (`backend/lims_analyses/parent_placeholders.py:29`). The comment at `main.py:15158` ("check-in
   re-seeds via the same function later") and `tests/test_parent_placeholders.py:183` are false —
   nothing re-runs it. Consequences: a profile with zero members at signal time (PB-0156's
   `moisture`, member `MOISTURE-KF` added minutes later) → no parent row and no vial-tier row on
   `PB-0156-S04` (`kf`), forever; IS unreachable at signal → nothing (and `catalog_snapshot` stays
   NULL); a post-order add-on → nothing (the IS `order-services-updated` webhook rewrites the payload
   and never re-signals Mk1); `reprovision-snapshot` (`main.py:20735`) deliberately touches only the
   snapshot (`:20756-20762`). Evidence: `PB-0156` has 0 `ordered` rows; the DB's only 4 are
   `P-0156`'s hand re-signaled ones from 08-17.
2. **Manage Analyses is half-native.** The overlay in `src/components/senaite/SampleDetails.tsx`
   (`:6353-6604`) already works on native vial pages — `add_analysis_to_native_vial`
   (`backend/lims_analyses/service.py:2645`, via `main.py:9696`) and `delete_pristine_analysis`
   (`:2741`, via `main.py:9839`) — but its picker is SENAITE's catalog through the IS proxy
   (`GET /explorer/analysis-services`, `main.py:9685`), so `origin='mk1'` services with no
   `senaite_uid` never appear, and the FE sends only `service.uid`. Native **parent-tier** rows have
   no add, no remove, and are not listed in the overlay at all (it iterates the SENAITE-sourced
   `analyses`). On the card an `ordered` row is `Unassigned` with zero verbs
   (`AnalysisTable.tsx:357-368`, `verbPolicy="parent-native"`).

The lab needs to add and remove native analyses on the parent and on vials after an order is
placed, and the parent must reflect the current state of what is on the sample.

## 2. Rulings (Handler, 2026-08-18)

| # | Ruling | Consequence |
|---|---|---|
| A | **Provision-on-sample.** Adding on the parent mints the placeholder(s) **and** puts the analysis on the host vial when one exists; when none exists the placeholder stands alone and seeds when a matching-role vial appears. | Parent = truth of "what is on this sample"; vial rows follow. |
| — | Manage Analyses is a **lab-side override with no billing linkage** (parity with the SENAITE overlay; the WP add-on tool remains the paid path). | No IS/WP writes from this feature. |
| 2 | Heal for existing orders is an **explicit, admin-gated "Re-sync from order"** action. No automatic re-seed at role-flip/check-in. IS→Mk1 re-signal on add-on purchase = deferred follow-up. | One new admin route; `set_assignment_role` is not re-wired for placeholders (only the §4.3 union hook). |
| P | **Profile-level add, service-level remove.** | Add reuses the registration seed byte-for-byte; remove matches the overlay's per-row trash. |
| Y | **Dedicated native routes under `/api/lims-analyses` + a native block in the same overlay.** | Explorer routes untouched; identity is `analysis_service_id`. |
| R1 | Parent placeholder removal is a **soft remove** (`review_state='rejected'` + audited transition + parent-scoped `LimsSubSampleEvent`), not a hard delete. | The row and its transitions survive; partial-index slot freed for re-add; row shows in the card's Invalid tab. Alternative (rejected): hard delete + event only. Cost if wrong: low, reversible. |
| R2 | Fix the one reader that still counts placeholders: `backend/coa/spec_rules.py:101-119` `sample_peptide_id` gains `provenance='canonical'`. | One-line, tested; placeholders will now be minted more often. Cost if wrong: low. |

Open (Handler may veto at review): none blocking. R1/R2 are controller rulings recorded above.

## 3. Non-goals

- Automatic placeholder re-seed at check-in/role-flip (ruling 2).
- IS `order-services-updated` → Mk1 `POST /s2s/lims-samples` re-signal (follow-up, cross-repo).
- Vial **demand** from lab-added profiles (`compute_vial_plan` still derives from WP services; the lab creates/flips a vial by hand when needed).
- Guarding the raw `POST /api/lims-analyses` creator (`routes.py:143`, tier-agnostic, no provenance) — ledgered follow-up.
- Managing HPLC analyte-family services (owned by Replace Analyte) or SENAITE-origin services (unchanged SENAITE path).
- Any change to `promote_to_parent`, `_TIER_ALLOWED_KINDS` (`state_machine.py:151-159`), `write_custody_edges`, `reprovision-snapshot`, or `catalog_snapshot` semantics.
- Prune of placeholders on order edits (removal is a human decision → Manage Analyses).

## 4. Backend design

### 4.1 Data model — no schema change

- Lab-added parent rows reuse **`provenance='ordered'`** so every reader, index and suppression rule
  keeps working: `list_native_parent_analyses_senaite_shape` (`service.py:992`, suppression
  `:1056-1063`), registry inbox (`sub_samples/registry_inbox.py:102`), families
  (`families/service.py:124`), workflow engine (`workflow/engine.py:50-61`), COA
  (`coa/native_sections.py:110`, `coa/source_resolver.py:288,441`), variance
  (`coa/variance_series.py:101`), and the partial unique index
  `uq_lims_analyses_parent_service_ordered` (`database.py:1610-1615`, excludes
  `retracted`/`rejected` — which is what makes R1's soft remove re-addable).
- `seed_parent_placeholders` inserts rows **without** any transition today (registration rows are
  "ordered", nothing more to say). Lab-driven mints get a *why*: `seed_parent_placeholders` gains
  keyword-only `reason: str | None = None` and `created_by_user_id: int | None = None`; when
  `reason` is given each created row also gets an `auto` transition (`from_state=None`,
  `to_state='unassigned'`, `reason`, `details={"changed": {}}`, `user_id`) written by a helper
  `record_placeholder_created(db, row, *, reason, user_id)` that lives in `lims_analyses/service.py`
  (inside the amendment-audit AST guard's scope, `tests/test_amendment_audit.py:265`; bump the
  `>= 11` floor at `:285` per new site). Reasons: `manage_analyses:add profile=<key>` ·
  `manage_analyses:vial_add` · `resync_from_order`. Soft removes write a `reject` transition
  (`reason='manage_analyses:remove'`).
- **Bug fix folded in:** `seed_parent_placeholders`'s `exists` check (`parent_placeholders.py:57-61`)
  ignores `review_state`, so a soft-removed (`rejected`) placeholder would report `existing` and block
  a re-add. It must filter `review_state NOT IN ('rejected','retracted')` — exactly the partial
  index's predicate.
- Vial-side truth is the **custody edge** (`VialProfileAssignment`, `models.py:2047`,
  `relation in ('host','rider')`, `superseded_at`, `assigned_by_id`). Since spec 4 the seeder
  reads edges first and ignores `wp_services` whenever edges exist
  (`lims_analyses/seeder.py:193-236`), so adding a profile to an existing vial **is** writing an
  edge.

### 4.2 Service functions (all in `backend/lims_analyses/service.py` unless noted)

**`add_profile_to_parent(db, *, parent, profile, user_id) -> AddProfileResult`**
1. Validate: `profile.active`; members non-empty; every member `AnalysisService.origin == 'mk1'`
   (same predicate as `_ordered_native_profiles`, `coa/native_sections.py:62-79`). Violations → 422
   with a specific `detail` (`profile_not_native` / `profile_inactive` / `profile_has_no_members`).
2. Placeholders: `seed_parent_placeholders(db, parent=parent, services={profile.key: True})`
   (`parent_placeholders.py:29`, insert-only, returns `created/existing/skipped`). If every member
   already has a live row (`ordered` or non-dead `canonical`) → 409 `profile_already_on_sample`.
   Stamp `reason` on the created rows' transitions (`seed_parent_placeholders` → `create_analysis`
   writes the `auto` transition at `service.py:242-249`; thread a `reason` kwarg through — additive,
   default `None`).
3. Hosts: `hosts = [sub for sub in parent's vials if sub.assignment_role == profile.fulfillment_role]`
   (`fulfillment_dim == 'role'` only; a rider profile with `ride_host_roles` resolves via
   `resolve_catalog_fulfillment(db, {profile.key: True}, snapshot=None)` and hosts on the returned
   role — same algorithm as check-in). For each host: if no current edge for `profile.id`, add
   `VialProfileAssignment(relation='host', assigned_at=now, assigned_by_id=user_id)`; `db.flush()`;
   then `seed_analyses_for_vial(db, sub_sample=sub, role=sub.assignment_role, wp_services={profile.key: True}, parent_sample_id=parent.sample_id, created_by_user_id=user_id, commit=False)`
   (`seeder.py:556`; edge-driven, idempotent — skips `existing_service_ids`). Do **not** call
   `write_custody_edges` (it supersedes every current edge).
4. Writes a parent-scoped `LimsSubSampleEvent(lims_sample_pk=parent.id, event='native_profile_added', details={profile_key, profile_name, placeholders_created, hosts:[…]}, user_id)`.
5. One transaction, caller commits. Result: `{profile_key, placeholders_created, placeholders_existing, hosts: [{vial_id, edge_created, vial_rows_created}], no_host_vial: bool}`.

**`remove_parent_native_analysis(db, *, parent, analysis_id, confirm, user_id) -> RemoveResult`**
(keyed by the placeholder row; identity by its `analysis_service_id`)
1. Row must be `provenance='ordered'`, `lims_sample_pk == parent.id`, `lims_sub_sample_pk IS NULL`,
   not already `rejected` → else 404/409.
2. Live canonical row for the same `analysis_service_id` (`review_state NOT IN (retracted, rejected)`)
   → 409 `promoted_result_exists` (retest/retract owns it).
3. Classify vial-tier rows for that service on the parent's vials: *pristine* = `unassigned` AND
   `result_value IS NULL` AND `retested=false` AND no promotion link (the `delete_pristine_analysis`
   predicate, `:2796-2817`); *worked* = anything else not already `rejected`/`retracted`.
   Worked and `not confirm` → 412 with `{worked: [...vial ids...]}` (the overlay reuses
   `RemovalConfirmModal`). Worked and `confirm` → `apply_transition(kind='reject', reason='manage_analyses:remove', details={"changed": {}})` per row (vial tier allows `reject`).
   Pristine → `delete_pristine_analysis` per row (writes `LimsSubSampleEvent` before the hard delete,
   `:2820-2830`).
4. Custody: for each vial where no live vial-tier row of that profile's members remains, stamp
   `superseded_at=now` on its current edge for that profile (so the seeder can't resurrect it).
   Profile resolution: the profiles that contain this service AND whose members are all mk1; if the
   service belongs to several, supersede only edges whose profile has no remaining live member rows
   on that vial.
5. Placeholder soft remove (R1): `review_state='rejected'` and a `LimsAnalysisTransition(kind='reject', from_state='unassigned', to_state='rejected', reason='manage_analyses:remove', details={"changed": {}}, user_id=…)` written **directly** by this function (the generic
   `apply_transition` tier gate forbids parent `reject` — that gate is untouched; this is a
   placeholder-only primitive, documented at the site).
6. Writes a parent-scoped `LimsSubSampleEvent(lims_sample_pk=parent.id, event='native_analysis_removed', details={keyword, analysis_service_id, vial_rows_deleted, vial_rows_rejected, edges_superseded}, user_id)`.
7. One transaction. Result: `{analysis_id, vial_rows_deleted, vial_rows_rejected, edges_superseded}`.

**`resync_parent_from_order(db, *, parent, user_id) -> ResyncResult`** (admin)
1. `raw = fetch_sample_services(parent.sample_id)` (`sub_samples/service.py:1192`); exception or
   `None` → 502, zero writes.
2. `seed_parent_placeholders(db, parent=parent, services=raw['services'], package=raw.get('package'))`
   with `reason='resync_from_order'`.
3. For every ordered native profile (`_ordered_native_profiles(db, services, package, require_archetype=False)`) and every existing vial whose `assignment_role` matches its resolved host role: add the missing edge (never supersede) and `seed_analyses_for_vial(... commit=False)` as in add.
4. `catalog_snapshot` is **not** touched (S4 is not in the build base; its `reprovision-snapshot`
   route owns snapshot repair). Ledgered follow-up: once S4 and this slice are both merged, Re-sync
   may stamp a NULL snapshot (closes the IS-down-at-registration gap G5).
5. Writes a parent-scoped `LimsSubSampleEvent(lims_sample_pk=parent.id, event='native_resync', details={counts…}, user_id)`.
6. Result: `{placeholders_created, edges_created, vial_rows_created}`.

**`ensure_parent_placeholder(db, *, parent, service, user_id, reason)`** — one row for one service
(used by the native **vial** add, §4.5). Same insert-only/idempotent contract as
`seed_parent_placeholders` but per service; no-op if a live `ordered` or `canonical` row exists.

**`list_native_profiles_for_parent(db, *, parent)`** — active profiles whose members are all mk1,
each with `members[{service_id, keyword, title}]`, `fulfillment_role`, `on_sample: 'none'|'partial'|'full'`
(from live parent rows by service id) and `host_vials: [vial ids with matching role]`.

### 4.3 The one hook outside the new routes — role-flip union

`set_assignment_role` (`sub_samples/service.py:1936-1943`) resolves `services_map` from the IS
once and hands it to both `write_custody_edges` and `seed_analyses_for_vial`. Add, right after
`services_map` is resolved (only on the `role real + parent_sid` branch):

```python
services_map = {**(services_map or {}), **_placeholder_profile_keys(db, parent_row)}
```

where `_placeholder_profile_keys` returns `{profile.key: True}` for every active all-mk1 profile
that has ≥1 member with a live `ordered` row on the parent. For a normal order this adds nothing
(those keys are already in `services_map`); for a lab-added profile it lets
`resolve_catalog_fulfillment` (`sub_samples/catalog_demand.py:46`) resolve the host **live** —
its documented post-order-add-on branch (`:60-68`, logs `catalog_snapshot.fallback_live`) — so the
edge is written and the seeder seeds. This is what makes ruling A's "seeds when a matching vial
appears" true. Snapshot untouched.

### 4.4 Routes (`backend/lims_analyses/routes.py`, prefix `/api/lims-analyses`)

| Method | Path | Auth | Body / query | → |
|---|---|---|---|---|
| GET | `/parent/{sample_id}/native-profiles` | user | — | `list_native_profiles_for_parent` |
| POST | `/parent/{sample_id}/profiles` | user | `{profile_id: int}` (FK to `analysis_profiles.id`; keys are display only) | `add_profile_to_parent` → 201 `AddProfileResult`; 404 sample/profile; 409 already; 422 not native/inactive/empty |
| DELETE | `/parent/{sample_id}/native-analyses/{analysis_id}` | user | `?confirm=true` | `remove_parent_native_analysis` → 200; 404; 409 promoted; 412 worked+unconfirmed (body = impact) |
| POST | `/parent/{sample_id}/resync-from-order` | `require_admin` | — | `resync_parent_from_order` → 200; 502 IS |

Existing explorer routes: `POST /explorer/samples/{id}/analyses` native branch (at the build base
`main.py:9266-9310`; composition `:9719-9763`) additionally (a) reads `keyword` from the body and
passes it to `add_analysis_to_native_vial(keyword=…)` (the base passes `keyword=None`, so mk1-only
services with no `senaite_uid` are unreachable today), and (b) calls `ensure_parent_placeholder`
after the add (reason `manage_analyses:vial_add`). The FE sends `{service_uid?, keyword,
analysis_service_id}`; the base resolves by keyword, the composition (S3) also accepts the id —
expect a trivial merge conflict at that call site. Nothing else in `main.py` changes.

`GET /analysis-services` (`main.py:3358`, local table) gains `?origin=mk1&active=true` filters
(additive query params) to feed the native vial picker.

### 4.5 Audit & activity

- Row-level: lab-minted placeholders carry an `auto` transition with `reason` (§4.1); soft-removed
  placeholders carry a `reject` transition; vial-tier deletes keep the existing vial-scoped
  `LimsSubSampleEvent` (`analysis_removed`, `service.py:2745` at base); rejected vial rows carry
  their `reject` transition. Custody edges carry `assigned_by_id` / `superseded_at`.
- Sample-level: three **parent-scoped** `LimsSubSampleEvent` rows (`lims_sample_pk=parent.id`,
  `sub_sample_pk=NULL` — the model already allows it, `models.py:1933-1936` at base, and
  `GET /samples/{id}/activity` already reads them in its "Section B (parent-hosted)" branch,
  `main.py:1424-1447` at base): `native_profile_added`, `native_analysis_removed`, `native_resync`.
  That branch gains three `elif se.event == …` label lines (e.g. `"Residual Moisture added
  (native) — 1 analysis on PB-0156-S04"`); unknown events already fall back to the raw event name,
  so nothing breaks if the label is missing. `list_analysis_change_events_for_parent`
  (`service.py:1447` at base) is **unchanged** — its `{"changed": {}}`-is-silent contract stands.

### 4.6 R2 — `sample_peptide_id`

`backend/coa/spec_rules.py:108-119`: add `LimsAnalysis.provenance == 'canonical'` to the anchor
query. Test: an `ordered` placeholder on a peptide-linked service must not change the resolved
`peptide_id`.

## 5. Frontend design

Files: `src/components/senaite/SampleDetails.tsx` (overlay), `src/lib/api.ts` (client),
`src/lib/native-parent-analyses.ts` (query key), `src/components/senaite/RemovalConfirmModal.tsx`
(reused unchanged).

### 5.1 Parent pages (`parentSampleId === null`) — "Native (Accu-Mk1)" block in the overlay

Rendered inside the existing Manage Analyses panel (`SampleDetails.tsx:6382-6604`) **below** the
SENAITE "Current analyses" list and above the SENAITE picker; shown when the sample has ≥1 native
parent row **or** `native-profiles` returns ≥1 profile (absent on legacy-only data). SENAITE block
untouched.

- **Current native analyses** — source = the card's query (`listNativeParentAnalysesShaped`,
  `api.ts:6040`, key `NATIVE_PARENT_ANALYSES_QUERY_KEY`), so the list and the card can never
  disagree. Row: keyword (mono) · title · badge (`Ordered` for `provenance='ordered'`, else the
  state label) · host chip (`kf · PB-0156-S04` / `no host vial`, from `native-profiles.host_vials`
  by role) · trash. Trash enabled only on `ordered` rows; disabled on canonical rows with title
  "Promoted result — use retest/retract on the card". Rejected placeholders are not listed (they
  live in the card's Invalid tab).
- **Add profile** — list from `GET …/native-profiles`: name · member keywords (small mono) · host
  hint (`→ PB-0156-S04` or `no kf vial yet — placeholder only`) · Plus. `on_sample === 'full'`
  hidden; `'partial'` shown with "adds N missing". Search box shared with the SENAITE picker.
- **Re-sync from order** — button in the block header, only when `useAuthStore().user.role ===
  'admin'`; no confirm; toast "Re-synced: N placeholders, N edges, N vial analyses" or the 502
  message. Invalidates the native-parent query, sub-samples, and `refreshSample`.
- Cascade help (`:6399-6439`) gains one sentence: "Native profiles added here are also placed on
  the matching vial(s); if none exists yet, the analysis seeds when a vial gets that role."
- Remove → `DELETE …/native-analyses/{id}`; on 412 open `RemovalConfirmModal` with the returned
  worked-vial list; confirm → same call with `?confirm=true`.

### 5.2 Native vial pages (`me.external_lims_uid` starts `mk1://`, `SampleDetails.tsx:4190`)

- Picker source: `listNativeAnalysisServices()` → `GET /analysis-services?origin=mk1&active=true`
  (new client fn) instead of `listAnalysisServices()` (IS proxy). Rows keyed by `id`.
- `handleAddAnalysis` (`:4114`) sends `{analysis_service_id, service_uid?}`; `addAnalysisToSample`
  (`api.ts:1680`) gains the optional field.
- The existing native-vial remove path is unchanged (`api.ts:1779` → `DELETE /explorer/...`); it
  starts sending `analysis_service_id` too (`main.py:9844` already accepts it).
- SENAITE vials and SENAITE parents: byte-identical behavior.

### 5.3 States & feedback

Loading spinners per action (existing pattern `addingService` / `removingKeyword` → add
`addingProfile` / `removingNativeId` / `resyncing`); toasts on success/failure with the backend
`detail`; the block re-queries after every mutation. No optimistic updates.

## 6. Error handling summary

| Case | Response |
|---|---|
| Profile inactive / non-native member / zero members | 422 with specific `detail`; UI toast |
| Profile fully on sample | 409; UI hides it anyway |
| Partial (some members exist) | 201, only missing minted |
| No host vial | 201, `no_host_vial=true`; UI hint before and toast after ("placeholder only — seeds when a `kf` vial is assigned, or use Re-sync") |
| Remove: canonical exists | 409 |
| Remove: worked vial rows, unconfirmed | 412 + impact → modal |
| Re-sync: IS down / 404 | 502, zero writes |
| Re-sync: non-admin | 403 |
| Any DB error mid-action | single transaction → rollback, 500, nothing partial |

## 7. Testing

- **Backend** `backend/tests/test_native_manage_analyses_parent.py` (SQLite fixtures, existing
  helpers from `test_parent_placeholders.py` / `test_native_manage_analyses.py`): add with host
  vial (placeholders + edge + vial rows), without (placeholders only, `no_host_vial`), partial,
  409, 422×3; role-flip union hook seeds a lab-added profile on a later matching-role vial and
  adds nothing for a normal order; remove: 409 canonical, 412 worked → confirm rejects, pristine →
  vial rows deleted + placeholder `rejected` + `reject` transition + edge superseded; re-add after
  remove creates a fresh placeholder; Re-sync: mints missing placeholders/edges/rows, never
  supersedes a lab-added edge, IS failure → 502 + zero writes, admin-only; parent-scoped events
  written and labeled by the activity endpoint; `seed_parent_placeholders` re-add after `rejected`;
  R2 test; amendment-audit guard floor updated. Real-Postgres index behavior (soft-removed placeholder → re-add) proven on
  arcitest, not SQLite (fixtures never run `_run_migrations()`).
- **Full backend suite**: failure-**set** diff against the composition baseline (never a count).
- **Frontend** (vitest + msw): native block gating (rows/profiles/none), trash enable rules, 412 →
  modal → confirm, picker source switch on mk1 vials vs SENAITE vials, admin-only Re-sync;
  `npm run check:all` (npm only).
- **arcitest acceptance** (`PB-0156`): Add "Residual Moisture" → parent card shows `MOISTURE-KF`
  Ordered; `PB-0156-S04` gets `MOISTURE-KF` unassigned; custody edge host=moisture on S04; Re-sync
  → all-zero counts; remove → placeholder in Invalid tab, S04 row gone, edge superseded; re-add
  works. Second case: add Heavy Metals on a sample with no `hm` vial → placeholders only; flip a
  vial to `hm` → 4 rows seed via the union hook.

## 8. Rollout / risk

- Additive only: no schema change, no state-machine change, no touch to promote/COA/publish paths.
- Branch `feat/native-manage-analyses` off `b30d9fc0` (#98 tip; custody edges present), merged into
  the arc composition for testing like every S-slice; belongs to the Mk1 wave of the release plan
  v2. No IS/WP change in this slice.
- Threat model: authenticated lab users can now add/remove native rows on the parent (already
  possible on vials and on SENAITE ARs); Re-sync is admin-only; every write is audited via
  transitions/events/edges; nothing external is called except the existing IS read on Re-sync.
- Rollback: revert the Mk1 commits; rows already minted are ordinary `ordered`/`rejected` rows
  the existing readers already handle.

## 9. Follow-ups (ledgered)

1. IS `order-services-updated` → Mk1 re-signal (`POST /s2s/lims-samples`) so add-on purchases mint
   placeholders without Re-sync.
2. Guard the raw `POST /api/lims-analyses` creator (`routes.py:143`): require provenance / tier
   checks or remove it.
3. Empty-members profile guard at save time (warn / fail-closed on activation) — the PB-0156 cause.
4. Vial demand from lab-added profiles (`compute_vial_plan` reads WP services only).
5. Re-sync stamps a NULL `catalog_snapshot` once S4 + this slice are both merged (G5).
6. *(In this slice, docs-only touch, listed here so it is not lost:)* correct the false comment at
   `main.py:15158` and the test docstring at `test_parent_placeholders.py:183` — nothing re-seeds
   automatically; Re-sync is the heal.
