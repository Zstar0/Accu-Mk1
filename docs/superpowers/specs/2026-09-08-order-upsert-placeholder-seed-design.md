# Order-Upsert Placeholder Seeding — Design

*2026-09-08. Approved by Handler in-session ("option 2"): seed native parent-tier
placeholders from the Integration Service's post-commit order upsert, which
carries the per-sample services, instead of Mk1 calling back to IS from a
registration-time background task.*

*Code citations: Accu-Mk1 `origin/master` @ `2b495ff1`, Integration Service
`origin/master` @ `60b7bb3`. Worktrees: `C:\tmp\Accu-Mk1-order-seed`
(branch `feat/order-upsert-placeholder-seed`) and
`C:\tmp\integration-service-order-seed` (branch `feat/order-upsert-sample-services`).*

## 1. Problem

Evidence sample: **P-2689 on prod** (parent pk 3238, registered 2026-09-02
18:53 as sample 3 of a 4-sample order with P-2687/P-2688/P-2690). All seven
vials are Model-D native (`mk1://` uids): S01 hplc core, S02/S03 hm core,
S04 endo85 core, S05 pcr core, S06/S07 hplc variance. The vial tier holds
15 rows, including `unassigned` canonical rows for ARSENIC-PPM,
CADMIUM-PPM, LEAD-PPM, MECURY-PPM (S02), ENDOTOXIN-USP85LAL (S04) and
STERILITY-PCR (S05) — all `origin='mk1'` services. The parent tier holds
exactly 6 rows: 3 SENAITE shadows + 3 promoted canonicals, all HPLC. It has
**zero `provenance='ordered'` rows**, live or dead.

In mk1 read mode the parent Analyses table is the parent-tier surface
(`lims_analyses.service.list_parent_analyses_senaite_shape`, reached via
`sub_samples/registry_details.py:199`): canonical + shadow + ordered rows
hosted on the parent. Vials Quick Look reads vial-tier rows per sub-sample
(`listLimsAnalysesForSubSample`). So the four native tests are visible in
Quick Look and invisible on the parent page until each is promoted.

Root cause — a cross-service ordering race, verified on both sides:

1. IS registers an order's samples in a loop
   (`app/services/order_processor.py:486`): create the SENAITE AR (`:567`),
   then immediately POST the registration signal to Mk1 (`:583`,
   `AccuMk1Adapter` → `POST /s2s/lims-samples`).
2. IS assigns `db_record.sample_results` (`:830`) and commits (`:846`) only
   **after the whole loop**.
3. Mk1's signal handler (`backend/main.py:21731`) schedules
   `_native_placeholders_at_registration_bg(sample_id)` as a FastAPI
   `BackgroundTask`, which calls back `GET /explorer/orders/sample-services?
   sample_id=…`. That endpoint (`app/api/desktop.py:820`) resolves the sample
   by scanning `order_submissions.sample_results` — not yet committed for
   this order.
4. IS returns 404 → `fetch_sample_services` returns `None` → the task hits
   `if not raw: return` (`main.py:16509`) and exits **silently**: no
   placeholders, no `catalog_snapshot` stamp, no log line (prod logs at
   WARNING; the success path logs at INFO).
5. The last sample of a batch wins the race (IS commits milliseconds after
   its signal returns); single-sample orders always win.

Prod data matches exactly. Nine parents carry live native vial-tier rows and
no placeholder: P-2586 (08-29), P-2655 (09-01 18:31), P-2659 and P-2660
(09-01 21:17), P-2687/P-2688/P-2689 (09-02 18:53), P-2693/P-2694
(09-02 21:05). In every batch the final member has its placeholders.

Secondary consequence: the same silent return skips the once-only
`catalog_snapshot` stamp, so check-in for those samples seeded from the live
catalog rather than the order as bought.

## 2. Locked decisions (Handler, 2026-09-08)

- **Tell, don't ask.** The order upsert (`POST /s2s/orders/upsert`) already
  fires after IS commits and already stamps every sample. Each sample stamp
  gains the per-sample `services` dict and `package`; Mk1 seeds placeholders
  and stamps the catalog snapshot from that payload. No callback needed.
- The registration signal (`/s2s/lims-samples`) keeps its background
  seeding as a **fallback only** (idempotent, so double-seeding is a no-op),
  but it may never fail silently again: a missing services answer logs at
  WARNING with the sample id.
- **No silent returns in any S2S background task** — that is the
  observability fix that would have surfaced this on 08-29.
- A **convergence heal** exists as a script (Mk1 has no job queue or
  scheduler — `clickup_webhook.py:469` documents the absence): find parents
  with live native vial-tier rows whose services have no parent-tier row,
  and seed them from IS. It heals the nine now and can be cron'd via
  `docker exec` later.
- Backward compatible in both directions: stamps without `services` behave
  exactly as today; an old IS talking to the new Mk1, or the reverse, loses
  nothing.
- Deploy order: **Mk1 first** (accepts the optional fields), **then IS**.
- Out of scope, ledgered as follow-up: transactional outbox in IS + inbox in
  Mk1 (durable, replayable S2S delivery replacing best-effort
  `BackgroundTasks`).

## 3. Out of scope

- Any SENAITE surface (R0 posture from prior slices: zero new SENAITE
  coupling — this slice touches only the IS↔Mk1 contract).
- FE changes: the mk1 main table already renders `ordered` placeholders
  (Mk1 1.9.1, PR #138).
- The outbox/inbox platform slice (§2, follow-up).
- Changing what `seed_parent_placeholders` mints (profile resolution, origin
  gate, idempotency) — reused verbatim.

## 4. Design

### S1 — IS: sample stamps carry services and package

**File:** `app/services/order_upsert.py` (`build_order_upsert`).

Each stamp becomes
`{"senaite_sample_id", "line_item_ids", "services", "package"}` where
`services = sample.get("services") or {}` and `package = sample.get("package")`
— the same two fields `GET /explorer/orders/sample-services` returns from
`payload.samples[slot-1]` (`app/api/desktop.py:915-919`). A stamp is emitted
whenever the slot has a `senaite_id`; the current `and items` guard is
dropped because wpstar does not emit `line_item_ids` today (documented at
the top of `order_upsert.py`), which means today's prod upserts carry **no
stamps at all**. `line_item_ids` stays `[]` when absent.

Pure function, no IO; the adapter (`app/adapters/accumk1.py:upsert_orders`)
sends the dict unchanged.

### S2 — Mk1: shared seeder module

**New file:** `backend/lims_analyses/order_seed.py`.

```python
def seed_parent_from_services(db, *, parent, services, package, source) -> dict
```

Extracted from the body of `_native_placeholders_at_registration_bg`:

1. `raw = _apply_variance_override(parent.sample_id, {"services": services, "package": package})`
   — parity with the callback path, which applied the lab-side variance
   override inside `fetch_sample_services`.
2. `stats = seed_parent_placeholders(db, parent=parent, services=raw["services"], package=raw["package"])`.
3. Once-only snapshot: `if parent.catalog_snapshot is None:` compute via
   `compute_catalog_snapshot(db, services, package)` inside its own
   try/except (a snapshot failure must not undo the seed — same isolation
   the bg task already has).
4. `logger.info("registry.native_placeholder_seed source=%s sample_id=%s created=%s existing=%s skipped=%s", …)`.
5. Returns `stats`. **Does not commit** — the caller owns the transaction.

```python
def find_parents_missing_native_placeholders(db) -> list[tuple[LimsSample, set[int]]]
```

Pure read used by the heal script: for every parent with sub-samples
(`LimsSubSample.parent_sample_pk == parent.id`), the set of
`analysis_service_id`s carried by **live** vial-tier rows
(`review_state not in ("rejected", "retracted")`) on `origin='mk1'`
services, minus the service ids present at parent tier as a live
`canonical` or any `ordered` row. Returns the parents whose difference is
non-empty, with that set.

### S3 — Mk1: order upsert seeds from the stamp

**File:** `backend/main.py` (`S2SOrderSampleStamp`, `S2SOrdersUpsertResponse`,
`s2s_upsert_orders`).

- `S2SOrderSampleStamp` gains `services: Optional[dict] = None` and
  `package: Optional[str] = None`.
- `S2SOrdersUpsertResponse` gains `placeholders_created: int = 0`.
- Handler: the existing loop keeps stamping, with one guard — set
  `wc_line_item_ids` only when `line_item_ids` is non-empty (today's code
  would overwrite a stamped list with `[]` once IS starts sending stamps
  without line items). After the existing `db.commit()`, a second phase runs
  per sample stamp that carries `services`: look the sample up again, call
  `seed_parent_from_services(..., source="order_upsert")`, `db.commit()`;
  on any exception `db.rollback()`, log
  `registry.order_upsert_seed_failed sample_id=… err=…` at WARNING, and
  continue. Two phases so a seeding failure can never roll back the order
  stamps, and one failing sample never blocks its siblings.

### S4 — Mk1: the registration fallback stops being silent

**File:** `backend/main.py` (`_native_placeholders_at_registration_bg`).

Body becomes: fetch services from IS; if `None`, log
`registry.native_placeholder_seed_skipped sample_id=%s reason=no_services_from_is`
at WARNING and return; otherwise open the session, load the parent, call
`seed_parent_from_services(..., source="registration_signal")`, commit.
Hardening contract unchanged (own session, never raises, `db` guarded in
`finally`).

### S5 — Mk1: convergence heal script

**New file:** `backend/scripts/heal_missing_placeholders.py`.

`python scripts/heal_missing_placeholders.py [--apply] [--sample P-2689 …]`.
Dry-run by default: prints each parent from
`find_parents_missing_native_placeholders` with the missing service
keywords. With `--apply`: for each, `fetch_sample_services(sample_id)`
(None → print `SKIP no services from IS`), then
`seed_parent_from_services(source="heal")` + commit, printing the stats.
`--sample` restricts to the given ids. Exit 0 always on a completed run; the
per-sample outcome is the report.

## 5. Contract and compatibility

| Direction | Old peer | Behaviour |
|---|---|---|
| New Mk1, old IS | stamps carry no `services` | Phase 2 no-ops; registration fallback still seeds (racy as today, but now logs when it loses) |
| Old Mk1, new IS | pydantic ignores the extra stamp fields | today's behaviour exactly |
| New Mk1, new IS | stamps carry services | seeded post-commit; fallback is a no-op via idempotency |

Existing IS unit tests for `build_order_upsert` change shape (stamps now
carry two more keys and appear without line items); those assertions are
updated deliberately, not worked around.

## 6. Testing

- IS `tests/unit/test_order_upsert_builder.py`: stamps carry
  `services`/`package`; a slot with `senaite_id` and no `line_item_ids`
  still produces a stamp with `line_item_ids == []`; a slot without
  `senaite_id` produces none.
- Mk1 `backend/tests/test_order_seed.py`: mints one `ordered` row per
  ordered native profile member; idempotent on a second call (`existing`);
  stamps `catalog_snapshot` once and never restamps; a snapshot failure
  leaves the seeded rows in place; `find_parents_missing_native_placeholders`
  finds a parent with a live native vial row and no parent row, ignores it
  once an `ordered` row exists, ignores a `senaite`-origin vial row.
- Mk1 `backend/tests/test_s2s_orders_upsert.py`: a stamp with `services`
  seeds placeholders and reports `placeholders_created`; re-upsert reports
  0 created (idempotent); a stamp with empty `line_item_ids` does not clear
  an existing `wc_line_item_ids`; a seeding exception still returns 200
  with the stamp applied.
- Mk1 `backend/tests/test_native_placeholders_bg.py`: with
  `fetch_sample_services` patched to return `None`, the bg task logs the
  `registry.native_placeholder_seed_skipped` warning and mints nothing.
- Test gate = failure-SET diff against a baseline captured before Task 1 in
  each repo (both suites carry documented pre-existing failures).

## 7. Rollout and heal

1. Mk1: version `1.15.1`, CHANGELOG entry, `bash scripts/deploy.sh` per the
   `accumark-deploy` skill; health `{"status":"ok","version":"1.15.1"}`.
2. IS: `bash scripts/deploy.sh` (no alembic migration in this slice).
3. On the droplet: `docker exec accu-mk1-backend python scripts/heal_missing_placeholders.py`
   (dry run, expect the nine), then `--apply`.
4. Verify: the P-2689 read-only probe shows six `ordered` parent-tier rows
   (4× heavy-metals keywords, ENDOTOXIN-USP85LAL, STERILITY-PCR);
   `https://accumk1.valenceanalytical.com/#senaite/sample-details?id=P-2689`
   lists them under their profile sections with live vial-state badges.
5. Guard: register a 2-sample test order on arcitest (or watch the next
   multi-sample prod order) and confirm both samples carry placeholders.

## 8. Follow-ups (ledgered, not in this slice)

- Transactional outbox (IS) + inbox (Mk1) for all S2S events; retire
  `BackgroundTasks` for cross-service work.
- Cron the heal script (`docker exec … --apply`) nightly until the outbox
  lands.
- Registration shadow sync (`_shadow_analyses_at_registration_bg`) has the
  same silent-skip shape for SENAITE outages; give it the same WARNING.
