# Parent-AR Read-Flip — Layer 3: Attachments Native Record + Dual-Write Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mk1 gains the native record of parent-AR attachments: new `lims_parent_attachments` table; both AR-attachment upload paths (Select-Vial-Image via `upload_senaite_attachment`, and the receive flow's step-1 image) keep their SENAITE upload (COABuilder dependency) and additionally store a frozen S3 snapshot + native row, best-effort; a one-time backfill sweeps historical AR attachment lists into `storage='senaite'` rows and ADOPTS uid-less capture-time rows.

**Architecture (spec §7, amended with the snapshot decision):** the SENAITE upload stays the hard, user-visible step — unchanged failure behavior. The native side (S3 snapshot via `sub_samples.photo_storage.get_storage()` + `LimsParentAttachment` insert) runs AFTER SENAITE success, best-effort: its failure is logged, never fails the response, and the backfill's idempotent re-run reconciles (spec §9.5). The READ side (serving the lookup's `attachments` from this table) is **Layer 4's builder**, not this layer. Deletion UI does not exist today — nothing to wire.

**Tech Stack:** FastAPI + SQLAlchemy + Postgres idempotent DDL (migrations-before-create_all — full CREATE TABLE in the list); `sub_samples/photo_storage.py` (`get_storage()`, `save_photo(sample_id, bytes, filename) -> key`, `set_storage_for_tests(...)`); pytest via `docker exec readflip-test sh -c "cd /app && python -m pytest <files> -q"`; FE vitest for the one API-shape change.

**Spec:** `docs/superpowers/specs/2026-07-14-parent-ar-read-flip-design.md` §7 (amended 2026-07-14: S3 snapshot at capture; `receive_image` kind; uid-adoption dedup).

## Global Constraints

- SENAITE upload behavior byte-identical on both paths (same requests, same failure responses); the native block runs only after SENAITE success and NEVER raises into the response (log `parent_attachment.capture_failed` on failure).
- All schema additive, `lims_` prefix, idempotent DDL.
- Snapshot semantics: capture stores the exact uploaded bytes under a NEW key — never a pointer to the live vial-photo key.
- Gate: full-suite failure-set diff clean vs `C:\Users\forre\Downloads\Obsidian\TerraVex\TerraVex\Sessions\handoffs\gate-backend-failures-v140-master.txt` (60 names; two `test_clickup_task_retry` time-window flakes are known-intermittent — verify by standalone rerun before attributing).
- Commit trailers on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01L7mtRqLeMEzMfN5oCSUxAA`

---

### Task 1: `lims_parent_attachments` schema + model

**Files:**
- Modify: `backend/models.py` (add `LimsParentAttachment` directly after `LimsSampleRemark`)
- Modify: `backend/database.py` (append to the `migrations` list after the `lims_sample_remarks` dedup-index entry)
- Test: `backend/tests/test_lims_parent_attachments_schema.py` (new)

**Interfaces:**
- Produces: `LimsParentAttachment` model — Tasks 2-4 import it from `models`:
  `id (PK)`, `lims_sample_pk (FK lims_samples CASCADE, NOT NULL)`,
  `kind (String(30), NOT NULL)` CHECK in ('vial_image','packaging_image','receive_image','manual'),
  `source_sub_sample_pk (FK lims_sub_samples SET NULL, nullable)`,
  `filename (String(255), NOT NULL)`, `content_type (String(100), nullable)`,
  `storage (String(10), NOT NULL)` CHECK in ('s3','senaite'),
  `storage_key (Text, nullable)`, `senaite_attachment_uid (String(50), nullable)`,
  `render_in_report (Boolean, NOT NULL, default False)`,
  `created_by_user_id (FK users SET NULL, nullable)`,
  `created_at (DateTime, NOT NULL, default utcnow)`.

- [ ] **Step 1: Write the failing schema test** — clone the structure of `backend/tests/test_lims_sample_remarks_schema.py` (Layer 2's Task 1, same house pattern: live dev DB, TEST-prefixed sample id `TEST-PATT-SCHEMA-P1`, FK-safe cleanup via parent delete). Three tests:
  1. `test_model_round_trip_and_cascade` — insert parent + one `LimsParentAttachment(kind='vial_image', filename='v-1.png', storage='s3', storage_key='k/x.png', render_in_report=True)`, read back all fields, delete parent → attachment gone (CASCADE).
  2. `test_kind_and_storage_checks_reject_unknown` — raw-SQL INSERT with `kind='bogus'` must raise; same for `storage='zodb'` (use `pytest.raises` + `db.rollback()` between).
  3. `test_uid_partial_unique` — two raw inserts with the same `senaite_attachment_uid='TEST-UID-1'` → second must not create a row (`ON CONFLICT DO NOTHING`, count==1); two inserts with NULL uid both land (partial index ignores NULLs, count==2 for those).

- [ ] **Step 2: Run to verify RED** — `ImportError: cannot import name 'LimsParentAttachment'`.

- [ ] **Step 3: Add the model** (after `LimsSampleRemark` in `backend/models.py`):

```python
class LimsParentAttachment(Base):
    """Native record of a parent-AR attachment (read-flip spec §7).

    Dual-write era: SENAITE keeps receiving the upload (COABuilder reads AR
    attachments until the section-5 re-wire); Mk1 records what/when/who and,
    for capture-time rows, a FROZEN S3 snapshot of the exact bytes
    (storage='s3') — never a pointer to the live vial-photo key (snapshot
    semantics: a retake must not change what was attached). Backfilled
    historical rows point at SENAITE's copy (storage='senaite') served via
    the existing attachment proxy. senaite_attachment_uid is NULL on
    capture-time rows (the Plone form upload returns no uid); the backfill
    sweep adopts them by (lims_sample_pk, filename) match.
    """
    __tablename__ = "lims_parent_attachments"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    lims_sample_pk: Mapped[int] = mapped_column(
        ForeignKey("lims_samples.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    source_sub_sample_pk: Mapped[Optional[int]] = mapped_column(
        ForeignKey("lims_sub_samples.id", ondelete="SET NULL"), nullable=True
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    storage: Mapped[str] = mapped_column(String(10), nullable=False)
    storage_key: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    senaite_attachment_uid: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    render_in_report: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    def __repr__(self) -> str:
        return (f"<LimsParentAttachment(id={self.id}, "
                f"sample_pk={self.lims_sample_pk}, kind='{self.kind}')>")
```

- [ ] **Step 4: Add the idempotent DDL** (append after the `uq_lims_sample_remarks_dedup` entry in `backend/database.py`):

```python
        # ── parent-AR attachments native record (read-flip spec §7) ──
        """
        CREATE TABLE IF NOT EXISTS lims_parent_attachments (
            id                     SERIAL PRIMARY KEY,
            lims_sample_pk         INTEGER NOT NULL REFERENCES lims_samples(id) ON DELETE CASCADE,
            kind                   VARCHAR(30) NOT NULL
                                   CHECK (kind IN ('vial_image','packaging_image','receive_image','manual')),
            source_sub_sample_pk   INTEGER REFERENCES lims_sub_samples(id) ON DELETE SET NULL,
            filename               VARCHAR(255) NOT NULL,
            content_type           VARCHAR(100),
            storage                VARCHAR(10) NOT NULL CHECK (storage IN ('s3','senaite')),
            storage_key            TEXT,
            senaite_attachment_uid VARCHAR(50),
            render_in_report       BOOLEAN NOT NULL DEFAULT FALSE,
            created_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at             TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_lims_parent_attachments_sample "
        "ON lims_parent_attachments (lims_sample_pk, created_at)",
        # Backfill idempotency: one native row per SENAITE attachment uid.
        # Partial — capture-time rows are uid-less until the sweep adopts them.
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_parent_attachments_uid "
        "ON lims_parent_attachments (senaite_attachment_uid) "
        "WHERE senaite_attachment_uid IS NOT NULL",
```

NOTE the CHECK constraints here are in the CREATE TABLE only (new table ⇒
first boot creates it with the full list; no DROP/re-ADD pair ⇒ no
last-boot-wins hazard).

- [ ] **Step 5:** `init_db()` in the container, then run the test file → 3 passed.

- [ ] **Step 6: Commit** — `feat(readflip-l3): lims_parent_attachments schema — native AR-attachment record` (+ trailers).

---

### Task 2: Capture in `upload_senaite_attachment` + Select-Vial-Image lineage

**Files:**
- Modify: `backend/main.py` — `upload_senaite_attachment` (~line 13190): two new OPTIONAL form fields + best-effort native block after SENAITE success
- Modify: `src/lib/api.ts` — `uploadSenaiteAttachment` (~line 3758): two new optional args appended to the FormData
- Modify: `src/components/senaite/SampleDetails.tsx` — `SelectVialImageDialog.handleSelect` (~line 2261): pass `native_kind='vial_image'` + `source_sample_id=vial.sample_id`
- Test: `backend/tests/test_parent_attachment_capture.py` (new); FE: `src/lib/__tests__/upload-attachment-fields.test.ts` (new)

**Interfaces:**
- Consumes: `LimsParentAttachment` (Task 1); `sub_samples.photo_storage.get_storage()` / `set_storage_for_tests(...)`; the SENAITE-HTTP mock idiom for wizard endpoints (see `tests/test_receive_remarks_native.py` — broad `httpx.AsyncClient` patch; this endpoint also fetches the sample page HTML, so the mock's GET responses need a minimal HTML body with an `_authenticator` input and an `<option>` for the attachment type — build one tiny helper).
- Produces: the endpoint's new optional form fields `native_kind` (default `"manual"`, validated against the model's kinds) and `source_sample_id` (vial sample-id string, resolved to `lims_sub_samples.id`; unresolvable → NULL lineage, still captured).

- [ ] **Step 1: Backend tests first (RED).** In `test_parent_attachment_capture.py` (TEST-prefixed rows, FK-safe cleanup, `set_storage_for_tests` with an in-memory fake recording `save_photo` calls and returning a deterministic key):
  1. `test_upload_captures_snapshot_and_native_row` — happy path with `native_kind=vial_image`, `source_sample_id=<seeded vial>`: response success unchanged; fake storage received the exact uploaded bytes under the PARENT sample id; one `LimsParentAttachment` row with kind/source pk/filename/content_type, `storage='s3'`, the fake's key, `render_in_report=True`, `created_by_user_id=<acting user>`, `senaite_attachment_uid IS NULL`.
  2. `test_upload_senaite_failure_skips_native` — SENAITE POST mocked to 500: response failure (unchanged contract), zero native rows, zero storage calls.
  3. `test_upload_native_failure_never_breaks_response` — fake storage raises: response STILL success, zero native rows, a `parent_attachment.capture_failed` warning logged (assert via `caplog`).
  4. `test_upload_defaults_manual_kind_no_source` — no new form fields sent: row lands with `kind='manual'`, `source_sub_sample_pk IS NULL`.

- [ ] **Step 2: RED run** (fields ignored today; no table writes).

- [ ] **Step 3: Backend implementation.** In `upload_senaite_attachment`:
  - Signature gains `native_kind: str = Form("manual")`, `source_sample_id: Optional[str] = Form(None)`.
  - After the existing success determination (the `att_resp.status_code in (200, 301, 302)` path that returns success), insert the best-effort block BEFORE the return (mirror `_insert_remark`'s closure + `run_in_threadpool` pattern):

```python
            # Native record + frozen S3 snapshot (read-flip spec §7) —
            # best-effort AFTER SENAITE success; never fails the response.
            # Snapshot semantics: store THESE bytes under a new key; never
            # point at the live vial-photo key (retakes must not mutate
            # what was attached).
            def _capture_native() -> None:
                from sub_samples.photo_storage import get_storage
                kind = native_kind if native_kind in (
                    "vial_image", "packaging_image", "receive_image", "manual"
                ) else "manual"
                cdb = SessionLocal()
                try:
                    row = cdb.execute(
                        select(LimsSample).where(
                            LimsSample.external_lims_uid == sample_uid)
                    ).scalar_one_or_none()
                    if row is None:
                        logger.warning(
                            "parent_attachment.capture_failed uid=%s "
                            "err=no-registry-row", sample_uid)
                        return
                    source_pk = None
                    if source_sample_id:
                        sub = cdb.execute(
                            select(LimsSubSample).where(
                                LimsSubSample.sample_id == source_sample_id)
                        ).scalar_one_or_none()
                        source_pk = sub.id if sub is not None else None
                    key = get_storage().save_photo(
                        row.sample_id, file_bytes, filename)
                    cdb.add(LimsParentAttachment(
                        lims_sample_pk=row.id,
                        kind=kind,
                        source_sub_sample_pk=source_pk,
                        filename=filename,
                        content_type=content_type,
                        storage="s3",
                        storage_key=key,
                        render_in_report=True,
                        created_by_user_id=getattr(current_user, "id", None),
                    ))
                    cdb.commit()
                except Exception as cap_err:  # noqa: BLE001
                    try:
                        cdb.rollback()
                    except Exception:
                        pass
                    logger.warning(
                        "parent_attachment.capture_failed uid=%s err=%s",
                        sample_uid, cap_err)
                finally:
                    cdb.close()

            from fastapi.concurrency import run_in_threadpool
            await run_in_threadpool(_capture_native)
```

  - Add `LimsParentAttachment`, `LimsSubSample` to main.py's models import if missing; `from database import SessionLocal` stays function-local per house style.
  - IMPORTANT: read the real function first — the success path may be structured differently than assumed; anchor the block immediately before the SUCCESS return only (failure returns bypass it).

- [ ] **Step 4: FE changes.** `uploadSenaiteAttachment(sampleUid, file, attachmentType, nativeKind?, sourceSampleId?)` — append `native_kind`/`source_sample_id` to the FormData when provided. `SelectVialImageDialog.handleSelect` passes `'vial_image'`, `vial.sample_id`. Hand-match style; do NOT prettier-format `api.ts` or `SampleDetails.tsx` wholesale.

- [ ] **Step 5: FE test.** `src/lib/__tests__/upload-attachment-fields.test.ts` — stub `fetch`, call `uploadSenaiteAttachment('UID-1', file, 'Sample Image', 'vial_image', 'aP-0001-V1')`, assert the FormData body contains `native_kind=vial_image` and `source_sample_id=aP-0001-V1`; second case omits them → fields absent (backward compat).

- [ ] **Step 6: GREEN runs.** Backend: `python -m pytest tests/test_parent_attachment_capture.py -q`. FE: `npx vitest run src/lib/__tests__/upload-attachment-fields.test.ts` and `npx tsc --noEmit`.

- [ ] **Step 7: Commit** — `feat(readflip-l3): AR-attachment upload captures native row + frozen S3 snapshot` (+ trailers).

---

### Task 3: Capture in the receive flow's step-1 image upload

**Files:**
- Modify: `backend/main.py` — `receive_senaite_sample`'s step-1 image-upload success branch (the `steps_done.append("image_uploaded")` site, ~line 13680)
- Test: extend `backend/tests/test_parent_attachment_capture.py` (same harness) or the receive harness in `tests/test_receive_remarks_native.py` — implementer's call; keep one file per concern if it stays readable

**Interfaces:**
- Consumes: Task 2's `_capture_native` shape — but do NOT copy the closure wholesale: extract the shared core into a module-level helper `_capture_parent_attachment_bg(*, sample_uid, file_bytes, filename, content_type, kind, source_sample_id, user_id)` in `main.py` (same never-raise contract, own session), call it from BOTH endpoints via `run_in_threadpool`. Refactor Task 2's endpoint to use it in this task (single implementation, two call sites).
- Produces: receive-path rows with `kind='receive_image'`, `filename=f"{req.sample_id}-receive-image.png"` (the receive upload hardcodes PNG bytes — verify against the actual step-1 code and match its filename/content-type reality).

- [ ] **Step 1: Tests (RED):**
  1. `test_receive_image_captures_native_row` — receive happy path with an image: one row, `kind='receive_image'`, `storage='s3'`, snapshot bytes == decoded image bytes, `created_by_user_id` = acting user; receive response unchanged.
  2. `test_receive_without_image_no_row` — no image in request → zero attachment rows.
  3. `test_receive_capture_failure_never_breaks_receive` — fake storage raises → receive still succeeds end-to-end (`success is True`), zero rows, warning logged.

- [ ] **Step 2: RED run.**

- [ ] **Step 3: Implement** — extract `_capture_parent_attachment_bg`, refactor Task 2's call site onto it, add the receive step-1 call (after `steps_done.append("image_uploaded")`, `kind="receive_image"`, `source_sample_id=None`). Re-run Task 2's tests to prove the refactor kept them green.

- [ ] **Step 4: GREEN run** — capture file + `tests/test_receive_remarks_native.py` + `tests/test_sample_transition_log.py` (receive blast radius).

- [ ] **Step 5: Commit** — `feat(readflip-l3): receive-flow image joins the native capture path (shared helper)` (+ trailers).

---

### Task 4: Historical sweep — AR attachment lists → native rows (+ uid adoption)

**Files:**
- Create: `backend/scripts/backfill_lims_parent_attachments.py`
- Test: `backend/tests/test_backfill_lims_parent_attachments.py` (new)

**Interfaces:**
- Consumes: `sub_samples.senaite.fetch_parent_metadata(sample_id)` — the complete AR detail whose `Attachment` key lists refs; each needs a detail fetch for `AttachmentFile` metadata (filename, content type) — model the two-step on COABuilder's reader (`senaite_client.py:320-356` fetches each attachment object). Import as `from sub_samples import senaite as sen`; clone the Layer-2 remarks-backfill shell (registry cursor, throttle, checkpoint, dry-run, per-sample error isolation, stats JSON).
- Produces: rows `storage='senaite'`, `storage_key=NULL`, `senaite_attachment_uid=<uid>`, `render_in_report` from the attachment object when present else False, `created_at` from the object's created when parseable else epoch sentinel; **adoption:** before inserting, if a uid-less native row matches `(lims_sample_pk, filename)`, UPDATE it with the uid (+count `adopted`) instead of inserting.

- [ ] **Step 1: Tests (RED), cloning the remarks-backfill harness** (`db_factory`, patched `sen` fetches, `_run`, tmp checkpoints; patch BOTH `sen.fetch_parent_metadata` and whatever per-attachment fetch helper you add to `sub_samples/senaite.py` — add `fetch_attachment_meta(uid) -> dict` there if none exists, mirroring `fetch_parent_metadata`'s two-step shape):
  1. insert two attachments (uid A1/A2, filenames, content types) → 2 rows `storage='senaite'` with uids, stats match.
  2. idempotent re-run (checkpoint deleted) → 0 inserted, 2 dup.
  3. dry-run → nothing written, would-insert counts.
  4. adoption: pre-seed a uid-less capture row `(pk, filename='v-1.png')`; sweep meets uid A9 with the same filename → row UPDATED with uid (adopted==1), no new row.
  5. malformed attachment refs skipped + counted, no exception.

- [ ] **Step 2: RED run** (module missing).

- [ ] **Step 3: Implement the script** — remarks-backfill shell verbatim; per-sample core: `meta.get("Attachment", [])` list of refs → per-ref detail fetch → `(uid, filename, content_type, render_in_report, created)`; adoption UPDATE first, else `INSERT ... ON CONFLICT DO NOTHING` riding the partial unique index; stats `{fetched, attachments_seen, inserted, dup, adopted, skipped_malformed, unparseable_created, errors}`.

- [ ] **Step 4: GREEN run.**

- [ ] **Step 5: Commit** — `feat(readflip-l3): historical AR-attachment sweep with uid adoption` (+ trailers).

---

### Task 5: Layer gate — sweep + full-suite diff + push (controller runs inline)

- [ ] Layer files + receive/upload blast radius: `tests/test_lims_parent_attachments_schema.py tests/test_parent_attachment_capture.py tests/test_backfill_lims_parent_attachments.py tests/test_receive_remarks_native.py tests/test_sample_transition_log.py -q`
- [ ] Full-suite failure-set diff vs the 60-name baseline (standalone-rerun any clickup flakes before attributing).
- [ ] FE: `npx tsc --noEmit` + the new vitest file.
- [ ] `git push`.
