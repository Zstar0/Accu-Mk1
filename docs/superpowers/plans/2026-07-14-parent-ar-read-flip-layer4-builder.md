# Parent-AR Read-Flip — Layer 4: Native Details Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `mk1` mode of `/registry/sample/{sample_id}/details` is assembled 100% from Mk1 tables + the IS DB — zero SENAITE HTTP — behind a new `sample_details` two-tier read-source page key (default `senaite`), with a nightly reconcile rider replacing the drift-observer coverage the flip retires, and a parity harness as the flip-readiness artifact.

**Architecture:** a new module `backend/sub_samples/registry_details.py` exposes `build_native_details(db, sample_id) -> RegistrySampleReadResult`. It composes existing native pieces: basic info via `registry_read.registry_row_to_display`, remarks via `main._native_sample_remarks` (L2), analyses via a new parent-tier senaite-shape listing in `lims_analyses/service.py` (reusing the shipped vial-tier serializer idiom at `service.py:~1990-2028` — `mk1:{id}` uids, native M/I names + int-as-string uids + option lists), attachments from `lims_parent_attachments` (L3) with a new download route, COA blocks from the IS DB (precedent `main.py:1146-1185`), `senaite_url` constructed from stored fields. The endpoint's `mk1` branch calls the builder INSTEAD of `lookup_senaite_sample`; `senaite` mode unchanged.

**Binding constraints from prior layers (violating any is a review-stopper):**
1. The attachment download route serves `Content-Type`/`Content-Disposition` from the **DB row**, never the storage-key extension (chromatogram snapshots key as `.bin`).
2. Blank M/I after a SENAITE-side retest renders as expected data, not drift (spec §5).
3. The reconcile rider reuses the L1-blinded backfill core — it must never write `method_id`/`instrument_id`.
4. The builder performs zero SENAITE HTTP — enforced by test (SENAITE client mocked to raise).

**Tech Stack:** as previous layers; backend tests via `docker exec readflip-test ...`; FE vitest + tsc. Spec: `docs/superpowers/specs/2026-07-14-parent-ar-read-flip-design.md` §8-§10.

## Global Constraints

- `senaite`-mode responses stay byte-compatible (remarks carve-out already shipped in L2).
- Default read source for `sample_details` is `senaite`; nothing changes for users at deploy.
- Builder never raises for missing sub-resources: empty lists + honest `field_sources`; `registry_missing=True` when the `lims_samples` row is absent.
- Gate: full-suite failure-set diff clean vs the 60-name baseline (`C:\Users\forre\Downloads\Obsidian\TerraVex\TerraVex\Sessions\handoffs\gate-backend-failures-v140-master.txt`); clickup flakes verified standalone before attributing.
- Commit trailers: the exact two lines from `git log -1 --format=%B d158c8b`, on every commit.

---

### Task 1: Parent-tier analyses in senaite shape (`lims_analyses/service.py`)

**Files:**
- Modify: `backend/lims_analyses/service.py` (new function after `list_promotions_for_parent`, ~line 890)
- Test: `backend/tests/test_list_parent_analyses_senaite_shape.py` (new)

**Interfaces:**
- Produces: `list_parent_analyses_senaite_shape(db, parent_sample_id: str) -> list[SenaiteShapeAnalysisResponse]` — Task 2 consumes it.
- Consumes: the existing vial-tier serializer body (`service.py:~1990-2028`) — extract its per-row serialization into a shared private helper rather than duplicating (the reviewer rubric treats verbatim duplication of a logic block as Important; refactor the existing `list_for_host` senaite-flavor path onto the same helper and prove no behavior change by keeping the existing senaite-shape tests green unmodified: `tests/test_lims_analyses_routes.py::test_list_for_host_senaite_shape_returns_phase3_shape` is in the 60-name baseline — use `tests/test_lims_analyses_service.py`'s senaite-shape coverage as the live check, and the full-file failure-set as the gate).

**Behavior contract:**
- Row selection: `lims_sample_pk == parent.id`, `lims_sub_sample_pk IS NULL`, BOTH provenances (`canonical` + `shadow`), current rows only (`retested == False` — the retest-current-row idiom; superseded/retracted rows excluded the same way the slice-2 read idiom does — mirror `resolve_shadow_target`'s notion of "current").
- `review_state` in the output: `mirror_review_state` for `provenance='shadow'` rows (the true SENAITE state), `review_state` for canonical rows.
- M/I: names via FK joins, `method_uid`/`instrument_uid` as int-as-string, option lists identical to the vial-tier flavor (native `instruments`/`hplc_methods`). Blank M/I is legitimate output (binding constraint 2).
- `uid = f"mk1:{row.id}"` — the shipped FE routing then PATCHes natively.
- Analyst names batched (the lightbox `created_by` batched-names idiom), never per-row queries.

**Steps (TDD):**
- [ ] Tests RED: (1) parent with one canonical + one shadow row → both serialized, shadow shows `mirror_review_state`, uids are `mk1:<id>`; (2) retested row excluded, its replacement included; (3) M/I names resolve via FK, NULL M/I serializes as None (not an error); (4) unknown sample → `[]`; (5) the extraction refactor keeps a representative vial-tier senaite-shape assertion green (write one focused test against `list_for_host` senaite flavor pre/post if no live one exists outside the baseline names).
- [ ] Implement (shared serializer helper + new listing).
- [ ] GREEN + full-file runs: `tests/test_list_parent_analyses_senaite_shape.py tests/test_lims_analyses_service.py -q` (failure names limited to baseline).
- [ ] Commit: `feat(readflip-l4): parent-tier analyses in senaite shape (shared serializer)` (+ trailers).

---

### Task 2: The builder module + attachment download route

**Files:**
- Create: `backend/sub_samples/registry_details.py`
- Modify: `backend/main.py` (new download route `GET /registry/sample/{sample_id}/attachments/{attachment_id}/download`; builder import)
- Test: `backend/tests/test_registry_details_builder.py` (new)

**Interfaces:**
- Produces: `build_native_details(db, sample_id) -> RegistrySampleReadResult` (Task 3 wires it); the download route (the builder emits its URLs).
- Consumes: Task 1's listing; `main._native_sample_remarks`; `registry_read.registry_row_to_display` + `OVERLAY_FIELDS`; `LimsParentAttachment`; `photo_storage.get_storage().fetch_photo(key)`; the IS-DB connection idiom + `coa_generations` query shape from `main.py:1146-1185`.

**Field-source contract (spec §8 matrix):**
- Basic info + declared_weight_mg + client fields + dates + profiles: from `lims_samples` via `registry_row_to_display` (same values the overlay uses today; missing → None, `field_sources` still `mk1` — there is no SENAITE fallback in this mode).
- `review_state`: `lims_samples.status`.
- `analytes`: adapter from `lims_samples.analytes` JSON (`[{"name", "declared_quantity"}, ...]`) to the typed `SenaiteAnalyte` — read the model's fields in `main.py` (~12100 region) at build time and map: `raw_name`/name-ish fields from `name`, declared quantity to its field, absent fields None/defaults. One adapter function with its own unit tests; if the typed model has required fields the registry JSON cannot supply, relax with sensible defaults and document each in the adapter docstring.
- `analyses`: Task 1.
- `remarks`: `_native_sample_remarks`.
- `attachments`: `lims_parent_attachments` rows for the sample → `SenaiteAttachment{uid, filename, content_type, attachment_type, download_url}` where `uid = senaite_attachment_uid or f"mk1att:{row.id}"`; `download_url = /registry/sample/{sid}/attachments/{row.id}/download` for `storage='s3'`, the existing `/wizard/senaite/attachment/{uid}` proxy URL for `storage='senaite'`.
- `coa` (SenaiteCOAInfo) + `published_coa`: IS DB `coa_generations` (newest primary/latest — mirror the verification-code overlay's selection at `main.py:1146-1185`); IS DB unavailable → empty blocks + `field_sources["coa"]="unavailable"` (honest, never raises).
- `senaite_url`: constructed from stored client path fields when present on `lims_samples` (inspect columns at build; if insufficient, emit None — link-out is a nicety, not a contract).
- `cached_at`: now-ISO. `read_source="mk1"`, `field_sources` covering every field the endpoint's tests enumerate.

**Download route contract (binding constraint 1):** resolve the row by id + sample match; `storage='s3'` → `get_storage().fetch_photo(storage_key)` streamed with `media_type=row.content_type or 'application/octet-stream'` and `Content-Disposition: inline; filename="<row.filename>"` — NEVER derived from the key extension; `storage='senaite'` rows → 404 with a hint to use the proxy (their download_url never points here); missing S3 object → 404 (logged).

**Steps (TDD):**
- [ ] Tests RED — the zero-SENAITE enforcement test FIRST: builder called with SENAITE client patched to raise on any use (`patch("httpx.AsyncClient", side_effect=AssertionError)` plus `sub_samples.senaite._get` similarly) → must still return a complete result for a seeded sample. Then per-field tests: analytes adapter cases (well-formed, empty, malformed JSON → []), attachments mapping incl. both storages + `mk1att:` uid fallback + download_url routing, download route content-type-from-DB (seed a `.bin`-keyed row with `content_type='text/csv'` → response `text/csv`, disposition carries `row.filename`), COA blocks with a mocked IS-DB cursor (mirror how existing IS-DB tests fake the connection — grep `coa_generations` in `backend/tests/`), registry_missing path.
- [ ] Implement.
- [ ] GREEN: `tests/test_registry_details_builder.py -q`.
- [ ] Commit: `feat(readflip-l4): native details builder + DB-typed attachment download route` (+ trailers).

---

### Task 3: Endpoint flip + `sample_details` page key (backend + FE)

**Files:**
- Modify: `backend/main.py` — `get_sample_read_from_registry`'s mk1 path calls `build_native_details` (no `lookup_senaite_sample` call); keep the function's auth/dependency shape.
- Modify: `src/components/preferences/panes/DataSourcePane.tsx` — add `{ key: 'sample_details', label: 'Sample details' }` + default `'senaite'` (two lines each, mirror `worksheets_inbox`).
- Modify: `src/lib/api.ts` + the five consumer pages' source resolution — follow EXACTLY how the samples-list/inbox pages resolve their page key to a `source` and pass it to `lookupSenaiteSample` (grep `worksheets_inbox` resolution in `api.ts:~4693` and the samples-list precedent; the five lookup consumers: `CustomerStatusPage`, `OrderExplorer`, `OrderStatusPage`, `OrderDashboard`, `SenaiteDashboard`, plus `src/services/senaite-lookup-map.ts`).
- Test: `backend/tests/test_registry_details_flip.py` (new); FE: extend `src/lib/__tests__/lookup-source.test.ts` + one pane test in `src/components/preferences` following the `worksheets_inbox` additions from PR #73.

**Behavior contract:**
- `senaite` mode: byte-identical behavior (still wraps the lookup + overlay; remarks already native from L2).
- `mk1` mode: builder only; response model unchanged (`RegistrySampleReadResult`); the endpoint-level zero-SENAITE test re-asserted at the route layer (mock lookup to raise → mk1 GET succeeds).
- FE: pages resolve `sample_details` source from the two-tier settings; default senaite ⇒ no behavior change until the Handler flips.

**Steps (TDD):** endpoint tests RED (mk1 route serves builder output for a seeded sample with the lookup patched to raise; senaite route untouched) → implement → FE wiring + tests → `npx tsc --noEmit` + targeted vitest → commit `feat(readflip-l4): sample_details read-source flip wiring (default senaite)` (+ trailers).

---

### Task 4: Nightly reconcile rider

**Files:**
- Modify: `backend/main.py` (or the scheduling module the IS-sync tick lives in — locate `is_event_stream`'s scheduling and place beside it)
- Test: `backend/tests/test_parent_mirror_reconcile_rider.py` (new)

**Contract:**
- Env-gated `MK1_PARENT_MIRROR_RECONCILE_ENABLED` (default ON in stacks via envgen conventions — but the CODE default is on/off per spec §8: default on in stacks, prod decided at deploy ⇒ code reads the env var with default `"false"` and the stack env sets it true; document in the rider's docstring + spec deploy note).
- Cadence: once nightly (naive check: run when `datetime.utcnow().hour == 8` UTC ≈ 3am ET on the existing tick loop, or a dedicated asyncio task with 24h sleep — mirror whatever the IS-sync tick's loop idiom is; keep it boring).
- Body: run the backfill core from `scripts/backfill_parent_analysis_shadows.py` (importable `backfill(...)` function) with a fresh checkpoint path per run (full sweep, throttled `--sleep`-equivalent ≥0.5s — SENAITE bulk-scan hazard), M/I-blind by L1 (add one regression assertion: rider run leaves a native M/I value untouched).
- Never-fail: rider exceptions logged, loop continues.
- Tests: gating (env off → never runs), invocation shape (patched backfill core called with throttle + fresh checkpoint), M/I preservation assertion.

**Steps:** TDD → implement → GREEN → commit `feat(readflip-l4): nightly shadow reconcile rider (env-gated, M/I-blind)` (+ trailers).

---

### Task 5: Parity harness (the flip-readiness artifact)

**Files:**
- Create: `backend/scripts/parity_sample_details.py`
- Test: `backend/tests/test_parity_sample_details.py` (new, harness-level: diffing logic only — no live HTTP in tests)

**Contract:** given `--samples P-0001,P-0002,...` (or `--limit N` newest from the registry), fetch both modes via the running backend (`--base-url`, bearer token via env `MK1_PARITY_TOKEN`) or build in-process (`--in-process` mode: call the builder + the lookup directly — requires SENAITE env; this is the stack/UAT mode), and emit a per-sample, per-field diff report (JSON + human summary): equal / mk1-only / senaite-only / differing, with per-field counts across the run. Known-expected differences are classified, not hidden (remarks native-in-both, M/I blank-after-retest, attachment uid `mk1att:` forms) — a `--strict` flag treats only unclassified diffs as failures (exit 1). Tests: the diff/classification logic on fixture payload pairs (equal, differing, known-class).

**Steps:** TDD the differ → implement CLI shell (clone the backfill scripts' argparse discipline) → GREEN → commit `feat(readflip-l4): sample-details parity harness` (+ trailers).

---

### Task 6: Layer gate (controller runs inline)

- [ ] Layer sweep: all new L4 test files + `tests/test_registry_read_endpoint.py tests/test_native_remarks_read.py tests/test_lims_analyses_service.py -q`.
- [ ] Full-suite failure-set diff vs the 60-name baseline.
- [ ] FE: `npx tsc --noEmit`; vitest: lookup-source + preferences + the five consumers' existing test files if present.
- [ ] `git push`.
