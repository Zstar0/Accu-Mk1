# Methods Controlled Documents Implementation Plan (slice 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn method rows into controlled documents: draft/active/retired lifecycle with revision-as-new-row, immutable issued content, defaults that ride activation, S3 attachments, and audited CRUD.

**Architecture:** `status`+`revision` columns kept in lockstep with the existing `active` boolean (no reader migrates); three lifecycle verbs (`new-revision`, `activate`, `retire`); a `method_attachments` table on the existing `photo_storage` abstraction; `catalog/change_log.py` audit on every method/instrument write path.

**Tech Stack:** as slices 1–2. Attachments use `sub_samples/photo_storage.get_storage()` (S3 in prod via `MK1_PHOTO_S3_BUCKET`, filesystem fallback in tests).

**Spec:** `docs/superpowers/specs/2026-08-19-methods-controlled-documents-design.md` (R0, R9–R12 binding).

## Recon corrections to the spec (cite, don't re-derive)

1. **There is no `log_update`** — the update-audit primitive is `catalog/change_log.apply_and_log(db, row, fields: dict, *, entity_type, entity_pk, user_id)` which does the setattr for you and logs one row iff something changed. `log_create(db, row, fields: Iterable[str], ...)` requires `db.flush()` first so the PK exists. Actor idiom is `user_id=getattr(current_user, "id", None)`.
2. **`hplc_methods.name` unique is a CONSTRAINT (`hplc_methods_name_key`), not an index** — drop with `ALTER TABLE ... DROP CONSTRAINT IF EXISTS`, and mirror the model change (`unique=True` off the column, `UniqueConstraint("name", "revision")` in `__table_args__`) or SQLite tests diverge from Postgres.
3. **`photo_storage.save_photo(sample_id, photo_bytes, filename)`'s first arg is just a key segment** (`_build_rel_key(sample_id, filename)`); pass `f"method-{method_id}"`. Download must serve Content-Type/Disposition **from the DB row, never the key extension** (binding constraint on the existing attachment route, main.py:20726 — same rule here).
4. **`senaite_id` is UNIQUE on hplc_methods** — a revision clone copying it would violate the constraint; R0 already forbids copying it. The clone explicitly excludes it.

## Global Constraints

- **R0: zero new SENAITE coupling** (attachments `storage='s3'` only; clones never copy `senaite_id`).
- **Branch:** `feat/methods-controlled-docs` cut from the slice-2 tip, same worktree `C:\tmp\Accu-Mk1-methods`.
- Interpreter, baseline-diff gating, npm-only, JSX typographic quotes: as slice 1's Global Constraints.
- Slice 1–2 interfaces consumed: `method_services` + one-default partial unique; `supersedes_id`; `MethodResponse` shape; `_method_service_rows`; `stamp_method_instrument`/`STAMPABLE_STATES` (unused here but must keep passing); pickers filter on `active` — the lockstep rule is what keeps them correct.

---

### Task 1: Schema — status/revision + index migrations

**Files:**
- Modify: `backend/models.py` (HplcMethod: new columns, name-unique restructure), `backend/database.py` (append before `]`)
- Test: `backend/tests/test_methods_lifecycle.py` (new; same harness as `tests/test_methods_catalog.py`)

**Interfaces:**
- Produces: `HplcMethod.status` (`'draft'|'active'|'retired'`), `revision: int`, `activated_at`, `retired_at`. Uniqueness: `(name, revision)`, `(code, revision)` where code not null, one `status='active'` row per code. **Lockstep invariant produced for all later tasks: `active is True ⇔ status == 'active'` — only the lifecycle verbs (Task 3–4) and the backfill write either field.**

- [ ] **Step 1: Failing test**

```python
def test_lifecycle_columns_and_same_name_revisions(db_session):
    m1 = HplcMethod(name="ICP-MS", code="AM-E-1", revision=1, status="active",
                    active=True, origin="mk1")
    m2 = HplcMethod(name="ICP-MS", code="AM-E-1", revision=2, status="draft",
                    active=False, origin="mk1", supersedes_id=None)
    db_session.add_all([m1, m2])
    db_session.commit()   # (name,1)+(name,2) legal now; plain name-unique would raise
    assert m2.activated_at is None
```

- [ ] **Step 2: FAIL** (unknown kwargs / IntegrityError on name). **Step 3: Implement.** Model: remove `unique=True` from `name`; add

```python
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="active",
                                        server_default="active")
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1,
                                          server_default="1")
    activated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    retired_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        UniqueConstraint("name", "revision", name="uq_hplc_methods_name_revision"),
        Index("uq_hplc_methods_code_active", "code", unique=True,
              postgresql_where=sa_text("status = 'active' AND code IS NOT NULL"),
              sqlite_where=sa_text("status = 'active' AND code IS NOT NULL")),
        Index("uq_hplc_methods_code_revision", "code", "revision", unique=True,
              postgresql_where=sa_text("code IS NOT NULL"),
              sqlite_where=sa_text("code IS NOT NULL")),
    )
```

Migrations (append; order matters — columns before indexes):

```python
        # --- Methods controlled documents (slice 3): lifecycle ---
        "ALTER TABLE hplc_methods ADD COLUMN IF NOT EXISTS status VARCHAR(10) NOT NULL DEFAULT 'active'",
        "ALTER TABLE hplc_methods ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE hplc_methods ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP",
        "ALTER TABLE hplc_methods ADD COLUMN IF NOT EXISTS retired_at TIMESTAMP",
        # Lockstep backfill (idempotent: lifecycle verbs are the only writers after this)
        "UPDATE hplc_methods SET status = 'retired' WHERE active = FALSE AND status = 'active'",
        # (name) unique constraint -> (name, revision); revisions share the name
        "ALTER TABLE hplc_methods DROP CONSTRAINT IF EXISTS hplc_methods_name_key",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_hplc_methods_name_revision ON hplc_methods (name, revision)",
        # code: slice-1 index -> revision-aware pair
        "DROP INDEX IF EXISTS uq_hplc_methods_code",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_hplc_methods_code_revision ON hplc_methods (code, revision) WHERE code IS NOT NULL",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_hplc_methods_code_active ON hplc_methods (code) WHERE status = 'active' AND code IS NOT NULL",
```

Add `status/revision/activated_at/retired_at` to `MethodResponse`.

- [ ] **Step 4: PASS + slice-1 suite still green** (`tests/test_methods_catalog.py`). **Step 5: Commit** — `feat(methods): lifecycle columns + revision-aware uniqueness`.

---

### Task 2: PUT rework — immutability + audited edits + no direct `active`

**Files:**
- Modify: `backend/main.py` `update_method` (4138)
- Test: extend `test_methods_lifecycle.py`

**Interfaces:**
- Produces: locked-field set constant `METHOD_LOCKED_FIELDS = ("name", "code", "technique", "reference", "procedure_summary", "size_peptide", "starting_organic_pct", "temperature_mct_c", "dissolution")` (module-level near `COA_ARCHETYPES`). A method is **content-locked** when `status != 'draft'` OR any `lims_analyses.method_id` references it. PUT on a locked method touching a locked field → 409 listing the offending fields. `notes`, `department_id`, `instrument_ids` stay editable always. `active` in the body → 400 "use the lifecycle verbs". Edits flow through `apply_and_log(db, method, fields, entity_type="method", entity_pk=method.id, user_id=...)`; `instrument_ids` keeps its relationship-set path (not a column — outside apply_and_log).

- [ ] **Step 1: Failing tests** (this file needs the `db_session`/`client` fixtures plus the `_svc` helper — copy all three from `tests/test_methods_catalog.py`; the locked-field tests that require the `activate` verb live in **Task 3's** test step, so each task's suite is green at its own commit):

```python
def test_create_mints_draft(client, db_session):
    b = client.post("/hplc/methods", json={"name": "KF", "technique": "KF"}).json()
    assert b["status"] == "draft" and b["active"] is False and b["revision"] == 1


def test_active_not_settable_via_put(client, db_session):
    mid = client.post("/hplc/methods", json={"name": "KF3"}).json()["id"]
    assert client.put(f"/hplc/methods/{mid}", json={"active": False}).status_code == 400


def test_put_writes_change_log(client, db_session):
    from models import CatalogChangeLog
    mid = client.post("/hplc/methods", json={"name": "KF4"}).json()["id"]
    client.put(f"/hplc/methods/{mid}", json={"notes": "x"})
    logs = db_session.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "method")).scalars().all()
    assert any(l.action == "update" and "notes" in l.details["changed"] for l in logs)
```

**Locking gate note:** the immutability guard implemented here is only *exercisable* once `activate` exists — its tests live in Task 3's step 1 (`test_locked_field_edit_409_names_fields`, `test_notes_and_department_stay_editable_when_locked`). Task 2's commit gates on the three tests above.

- [ ] **Step 2: FAIL.** **Step 3: Implement** in `update_method`:

```python
    fields = data.model_dump(exclude_unset=True)
    if "active" in fields:
        raise HTTPException(400, "active is managed by the lifecycle verbs "
                                 "(activate / retire) — not settable directly")
    referenced = db.execute(select(func.count()).select_from(LimsAnalysis)
                            .where(LimsAnalysis.method_id == method_id)).scalar()
    locked = method.status != "draft" or bool(referenced)
    if locked:
        offending = sorted(set(fields) & set(METHOD_LOCKED_FIELDS))
        if offending:
            raise HTTPException(
                409, f"method '{method.name}' rev {method.revision} is issued — "
                     f"locked fields: {', '.join(offending)}; create a new revision instead")
    instrument_ids = fields.pop("instrument_ids", None)
    apply_and_log(db, method, fields, entity_type="method", entity_pk=method.id,
                  user_id=getattr(current_user, "id", None))
    if instrument_ids is not None:
        ...  # keep the existing relationship-set block verbatim
```

**Also in `create_method` (this task):** new rows mint `status="draft"`, `active=False` (lockstep) — set both explicitly on the constructor; append `db.flush()` + `log_create(db, method, METHOD_LOG_FIELDS, entity_type="method", entity_pk=method.id, user_id=getattr(current_user, "id", None))` before commit, with `METHOD_LOG_FIELDS = ("name", "code", "technique", "reference", "department_id", "status", "revision", "origin")`. Update slice-1 tests that asserted implicit active-on-create if any (they asserted fields, not active — verify). Route signature: `_current_user` becomes `current_user` where the actor is now used.

- [ ] **Step 4: partial PASS per ordering note.** **Step 5: Commit** — `feat(methods): drafts at create, immutability guard, audited edits`.

---

### Task 3: `new-revision` + `activate` verbs

**Files:**
- Modify: `backend/main.py` (two routes after `put_method_services`)
- Test: extend `test_methods_lifecycle.py`

**Interfaces:**
- Produces:
  - `POST /hplc/methods/{method_id}/new-revision` → 201 `MethodResponse` — allowed from `active`/`retired` (400 from `draft`); clone: all content fields + `department_id` + `notes`, `revision = (max revision of same name) + 1`, `status='draft'`, `active=False`, `supersedes_id = source.id`, **never `senaite_id`** (R0/recon 4), `origin='mk1'`; clones `method_services` rows with `is_default=False` (R11) and `instrument_methods` links as-is.
  - `POST /hplc/methods/{method_id}/activate` → 200 `MethodResponse` — draft only (400 otherwise). One transaction: for each service the `supersedes_id` source holds a default on (regardless of source status), flip the source link's `is_default` off and this revision's link for the same service on (insert the link if the clone lost it); if the source is still `active`: source → `retired` + `active=False` + `retired_at=utcnow`; self → `status='active'`, `active=True`, `activated_at=utcnow`. Audit both rows via `apply_and_log`.

- [ ] **Step 1: Failing tests**

```python
def test_locked_field_edit_409_names_fields(client, db_session):
    mid = client.post("/hplc/methods", json={"name": "KF-L", "technique": "KF"}).json()["id"]
    client.post(f"/hplc/methods/{mid}/activate")
    r = client.put(f"/hplc/methods/{mid}", json={"procedure_summary": "changed"})
    assert r.status_code == 409
    assert "procedure_summary" in r.json()["detail"]


def test_notes_and_department_stay_editable_when_locked(client, db_session):
    mid = client.post("/hplc/methods", json={"name": "KF-L2"}).json()["id"]
    client.post(f"/hplc/methods/{mid}/activate")
    r = client.put(f"/hplc/methods/{mid}", json={"notes": "bench tip"})
    assert r.status_code == 200 and r.json()["notes"] == "bench tip"


def _icp_world(client, db):
    lead = _svc(db, "LEAD-PPM"); db.commit()
    mid = client.post("/hplc/methods", json={"name": "ICP-MS G", "code": "AM-G-1"}).json()["id"]
    client.post(f"/hplc/methods/{mid}/activate")
    client.put(f"/hplc/methods/{mid}/services",
               json=[{"analysis_service_id": lead.id, "is_default": True}])
    return mid, lead


def test_new_revision_clones_without_defaults_or_senaite(client, db_session):
    mid, lead = _icp_world(client, db_session)
    r = client.post(f"/hplc/methods/{mid}/new-revision")
    assert r.status_code == 201
    d = r.json()
    assert d["status"] == "draft" and d["revision"] == 2 and d["supersedes_id"] == mid
    assert d["senaite_id"] is None
    links = client.get(f"/hplc/methods/{d['id']}/services").json()
    assert links[0]["analysis_service_id"] == lead.id and links[0]["is_default"] is False


def test_activate_moves_defaults_and_retires_predecessor(client, db_session):
    mid, lead = _icp_world(client, db_session)
    rev2 = client.post(f"/hplc/methods/{mid}/new-revision").json()["id"]
    r = client.post(f"/hplc/methods/{rev2}/activate")
    assert r.status_code == 200
    old = client.get("/hplc/methods").json()
    old_row = next(m for m in old if m["id"] == mid)
    new_row = next(m for m in old if m["id"] == rev2)
    assert old_row["status"] == "retired" and old_row["active"] is False
    assert new_row["status"] == "active" and new_row["active"] is True
    # default moved (R11)
    svc_rows = client.get("/analysis-services").json()
    assert next(s for s in svc_rows if s["id"] == lead.id)["default_method_id"] == rev2


def test_activate_after_manual_retire_still_moves_defaults(client, db_session):
    """R11 amendment: defaults come from the SUPERSEDED row regardless of status."""
    mid, lead = _icp_world(client, db_session)
    rev2 = client.post(f"/hplc/methods/{mid}/new-revision").json()["id"]
    client.post(f"/hplc/methods/{mid}/retire")   # Task 4 provides retire; ordering as Task 2's note
    r = client.post(f"/hplc/methods/{rev2}/activate")
    assert r.status_code == 200
    svc_rows = client.get("/analysis-services").json()
    assert next(s for s in svc_rows if s["id"] == lead.id)["default_method_id"] == rev2


def test_drafts_invisible_to_default_resolution(client, db_session):
    mid, lead = _icp_world(client, db_session)
    client.post(f"/hplc/methods/{mid}/new-revision")   # draft exists
    svc_rows = client.get("/analysis-services").json()
    assert next(s for s in svc_rows if s["id"] == lead.id)["default_method_id"] == mid  # rev1 still
```

- [ ] **Step 2: FAIL.** **Step 3: Implement** (activate's default move — flag-off-then-on inside one transaction, the partial unique forbids any other order):

```python
@app.post("/hplc/methods/{method_id}/new-revision", response_model=MethodResponse, status_code=201)
async def new_method_revision(method_id: int, db: Session = Depends(get_db),
                              current_user=Depends(get_current_user)):
    src = db.get(HplcMethod, method_id)
    if not src:
        raise HTTPException(404, f"Method {method_id} not found")
    if src.status == "draft":
        raise HTTPException(400, "already a draft — edit it directly")
    max_rev = db.execute(select(func.max(HplcMethod.revision))
                         .where(HplcMethod.name == src.name)).scalar() or src.revision
    clone = HplcMethod(
        name=src.name, code=src.code, technique=src.technique,
        department_id=src.department_id, reference=src.reference,
        procedure_summary=src.procedure_summary, size_peptide=src.size_peptide,
        starting_organic_pct=src.starting_organic_pct,
        temperature_mct_c=src.temperature_mct_c, dissolution=src.dissolution,
        notes=src.notes, origin="mk1", status="draft", active=False,
        revision=max_rev + 1, supersedes_id=src.id,
        # senaite_id deliberately NOT copied (R0; also unique)
    )
    clone.instruments = list(src.instruments)
    db.add(clone)
    db.flush()
    for link in db.execute(select(method_services).where(
            method_services.c.method_id == src.id)).all():
        db.execute(method_services.insert().values(
            method_id=clone.id, analysis_service_id=link.analysis_service_id,
            is_default=False))
    log_create(db, clone, METHOD_LOG_FIELDS, entity_type="method",
               entity_pk=clone.id, user_id=getattr(current_user, "id", None))
    db.commit()
    db.refresh(clone)
    return _method_to_response(db, clone)


@app.post("/hplc/methods/{method_id}/activate", response_model=MethodResponse)
async def activate_method(method_id: int, db: Session = Depends(get_db),
                          current_user=Depends(get_current_user)):
    m = db.get(HplcMethod, method_id)
    if not m:
        raise HTTPException(404, f"Method {method_id} not found")
    if m.status != "draft":
        raise HTTPException(400, f"only drafts activate (this row is {m.status})")
    src = db.get(HplcMethod, m.supersedes_id) if m.supersedes_id else None
    if src is not None:
        defaults = db.execute(select(method_services.c.analysis_service_id).where(
            method_services.c.method_id == src.id,
            method_services.c.is_default.is_(True))).scalars().all()
        for service_id in defaults:
            db.execute(method_services.update()
                       .where(method_services.c.method_id == src.id,
                              method_services.c.analysis_service_id == service_id)
                       .values(is_default=False))
            updated = db.execute(method_services.update()
                                 .where(method_services.c.method_id == m.id,
                                        method_services.c.analysis_service_id == service_id)
                                 .values(is_default=True))
            if updated.rowcount == 0:
                db.execute(method_services.insert().values(
                    method_id=m.id, analysis_service_id=service_id, is_default=True))
        if src.status == "active":
            apply_and_log(db, src, {"status": "retired", "active": False,
                                    "retired_at": datetime.utcnow()},
                          entity_type="method", entity_pk=src.id,
                          user_id=getattr(current_user, "id", None))
    apply_and_log(db, m, {"status": "active", "active": True,
                          "activated_at": datetime.utcnow()},
                  entity_type="method", entity_pk=m.id,
                  user_id=getattr(current_user, "id", None))
    db.commit()
    db.refresh(m)
    return _method_to_response(db, m)
```

- [ ] **Step 4: PASS (minus the retire-dependent test — Task 4).** **Step 5: Commit** — `feat(methods): new-revision + activate with default handover`.

---

### Task 4: `retire` verb

**Files:** Modify `backend/main.py` (route beside activate); test extend.

**Interfaces:** `POST /hplc/methods/{method_id}/retire` → 200 `MethodResponse` — active only (400 otherwise); sets `status='retired'`, `active=False`, `retired_at`; audited. Defaults are left in place on the junction — the slice-1 fail-open rule (`default_method_id` requires `HplcMethod.active`) makes them inert, and a later activation harvests them (Task 3's superseded-row read).

- [ ] **Step 1: Failing test**

```python
def test_retire_fail_open_defaults(client, db_session):
    mid, lead = _icp_world(client, db_session)
    r = client.post(f"/hplc/methods/{mid}/retire")
    assert r.status_code == 200 and r.json()["status"] == "retired"
    svc_rows = client.get("/analysis-services").json()
    assert next(s for s in svc_rows if s["id"] == lead.id)["default_method_id"] is None
    # stamped history untouched: FK intact, DELETE still guarded
    assert client.post(f"/hplc/methods/{mid}/retire").status_code == 400  # not active anymore
```

- [ ] **Step 2: FAIL. Step 3: Implement** (mirror activate's shape; ~12 lines). **Step 4: PASS — the whole `test_methods_lifecycle.py` file is now green, including Task 2/3's ordering-deferred tests.** **Step 5: Commit** — `feat(methods): retire verb`.

---

### Task 5: Method attachments

**Files:**
- Modify: `backend/models.py` (new model), `backend/database.py` (CREATE TABLE), `backend/main.py` (3 routes after the lifecycle verbs)
- Test: extend `test_methods_lifecycle.py` (filesystem storage: `monkeypatch.setenv` nothing — with `MK1_PHOTO_S3_BUCKET` unset, `get_storage()` is filesystem; set `MK1_PHOTO_DIR`-equivalent per `FilesystemPhotoStorage`'s env — copy the env fixture from whichever existing test exercises `photo_storage` (grep `FilesystemPhotoStorage` in tests) into this file)

**Interfaces:**
- Produces: model

```python
class MethodAttachment(Base):
    """Controlled-document file on a method revision (slice 3). storage='s3'
    only (R0) — via photo_storage, which is filesystem-backed in dev/tests."""
    __tablename__ = "method_attachments"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    method_id: Mapped[int] = mapped_column(
        ForeignKey("hplc_methods.id", ondelete="CASCADE"), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    storage: Mapped[str] = mapped_column(String(20), nullable=False, default="s3")
    storage_key: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    uploaded_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
```

  plus matching `CREATE TABLE IF NOT EXISTS method_attachments (...)` DDL; routes:
  - `POST /hplc/methods/{method_id}/attachments` (multipart `file`) → 201 `{id, filename, content_type, size_bytes, created_at}`; filename truncated to 255; key = `get_storage().save_photo(f"method-{method_id}", file_bytes, filename)`; `log_create` with `("filename", "content_type", "size_bytes")`, `entity_type="method_attachment"`.
  - `GET /hplc/methods/{method_id}/attachments` → list (same shape).
  - `GET /hplc/methods/{method_id}/attachments/{attachment_id}/download` → bytes; Content-Type/Disposition **from the row** (recon 3); 404 on missing object via `PhotoNotFoundError`.
  - `DELETE /hplc/methods/{method_id}/attachments/{attachment_id}` → 200 only while the method's `status == 'draft'` (409 otherwise, "attachments on an issued method are part of the controlled record"); deletes the object best-effort then the row; `log_delete`.

- [ ] **Step 1: Failing tests**

```python
def _draft(client, name="ATT-M"):
    return client.post("/hplc/methods", json={"name": name}).json()["id"]


def test_attachment_upload_list_download(client, db_session, tmp_path, monkeypatch):
    # force filesystem storage rooted in tmp (copy the exact env/monkeypatch
    # shape from the existing photo_storage test — grep FilesystemPhotoStorage
    # in tests/ and reuse its fixture verbatim)
    mid = _draft(client)
    r = client.post(f"/hplc/methods/{mid}/attachments",
                    files={"file": ("sop-am-elem-001.pdf", b"%PDF-fake", "application/pdf")})
    assert r.status_code == 201
    att = r.json()
    assert att["filename"] == "sop-am-elem-001.pdf" and att["size_bytes"] == 9
    listed = client.get(f"/hplc/methods/{mid}/attachments").json()
    assert [a["id"] for a in listed] == [att["id"]]
    dl = client.get(f"/hplc/methods/{mid}/attachments/{att['id']}/download")
    assert dl.status_code == 200 and dl.content == b"%PDF-fake"
    assert dl.headers["content-type"].startswith("application/pdf")


def test_attachment_delete_draft_only(client, db_session, tmp_path, monkeypatch):
    mid = _draft(client, "ATT-M2")
    att = client.post(f"/hplc/methods/{mid}/attachments",
                      files={"file": ("sop.pdf", b"x", "application/pdf")}).json()
    client.post(f"/hplc/methods/{mid}/activate")
    assert client.delete(f"/hplc/methods/{mid}/attachments/{att['id']}").status_code == 409
    # uploads stay allowed on issued methods
    r = client.post(f"/hplc/methods/{mid}/attachments",
                    files={"file": ("amendment.pdf", b"y", "application/pdf")})
    assert r.status_code == 201
```

- [ ] **Step 2: FAIL. Step 3: Implement per the interface block.** **Step 4: PASS. Step 5: Commit** — `feat(methods): controlled-document attachments`.

---

### Task 6: Instrument CRUD audit (retro-covers slice 1)

**Files:** Modify `backend/main.py` `create_instrument`/`update_instrument` (slice-1 routes); test extend.

**Interfaces:** `INSTRUMENT_LOG_FIELDS = ("name", "instrument_type", "brand", "model", "department_id", "active", "origin")`; create → `db.flush()` + `log_create(... entity_type="instrument" ...)`; update → replace the setattr loop with `apply_and_log`. Route deps switch `_current_user` → `current_user`.

- [ ] **Step 1: Failing test**

```python
def test_instrument_crud_audited(client, db_session):
    from models import CatalogChangeLog
    iid = client.post("/instruments", json={"name": "Audit-Inst"}).json()["id"]
    client.patch(f"/instruments/{iid}", json={"brand": "Agilent"})
    logs = db_session.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "instrument",
        CatalogChangeLog.entity_pk == iid)).scalars().all()
    actions = {l.action for l in logs}
    assert actions == {"create", "update"}
    upd = next(l for l in logs if l.action == "update")
    assert upd.details["changed"]["brand"]["after"] == "Agilent"
```

**Step 2: FAIL. Step 3: Implement. Step 4: PASS. Step 5: Commit** — `feat(instruments): audited create/edit`.

---

### Task 7: FE — lifecycle UI on MethodPanel + status on MethodsPage

**Files:**
- Modify: `src/lib/api.ts` (HplcMethod += `status`, `revision`, `activated_at`, `retired_at`; fns `newMethodRevision(id)`, `activateMethod(id)`, `retireMethod(id)`, `getMethodAttachments(id)`, `uploadMethodAttachment(id, file: File)`, `deleteMethodAttachment(id, attachmentId)`, download URL helper `methodAttachmentDownloadUrl(id, attachmentId)`)
- Modify: `src/components/hplc/MethodPanel.tsx`, `src/components/hplc/MethodsPage.tsx`
- Test: `src/test/method-lifecycle-ui.test.tsx` (new)

**Interfaces:** Consumes Tasks 1–5 endpoints. Upload uses `FormData` + the house `getBearerHeaders()` (no content-type — browser sets the boundary).

- [ ] **Step 1: Failing test** (mock `@/lib/api` incl. `getMethodServices`/`getMethodAttachments`; render `MethodPanel` directly with a method fixture — it takes `{method, onUpdated}`):

```tsx
const ACTIVE_M = { id: 1, name: 'ICP-MS', code: 'AM-E-1', status: 'active', revision: 2,
  active: true, supersedes_id: 9, instrument_ids: [], instruments: [], services: [],
  common_peptides: [], technique: 'ICP-MS', notes: null, procedure_summary: 'locked text',
  /* …remaining HplcMethod fields nulled… */ } as never

it('active method offers Retire + New Revision, never Activate', async () => {
  render(<MethodPanel method={ACTIVE_M} onUpdated={vi.fn()} />)
  expect(await screen.findByRole('button', { name: /retire/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /new revision/i })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^activate$/i })).not.toBeInTheDocument()
})

it('locks issued content in edit mode, keeps notes editable', async () => {
  const user = userEvent.setup()
  render(<MethodPanel method={ACTIVE_M} onUpdated={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: /edit/i }))
  expect(screen.queryByLabelText(/procedure summary/i)).not.toBeInTheDocument()
  expect(screen.getByText('locked text')).toBeInTheDocument()   // read-only DetailRow
  expect(screen.getByLabelText(/notes/i)).toBeInTheDocument()
})

it('draft shows badge + Activate; delete on attachments only while draft', async () => {
  const draft = { ...ACTIVE_M, status: 'draft', active: false } as never
  vi.mocked(getMethodAttachments).mockResolvedValue([
    { id: 5, filename: 'sop.pdf', content_type: 'application/pdf', size_bytes: 9,
      created_at: '2026-08-19T00:00:00Z' }] as never)
  render(<MethodPanel method={draft} onUpdated={vi.fn()} />)
  expect(await screen.findByText(/draft/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /activate/i })).toBeInTheDocument()
  expect(await screen.findByText('sop.pdf')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /delete attachment/i })).toBeInTheDocument()
})
```
- [ ] **Step 2: FAIL.** **Step 3: Implement.**
  - **MethodsPage table:** status Badge column (`draft` amber outline / `active` default / `retired` secondary — mirror the Active/Inactive badge idiom from InstrumentsPage) + `rev N` mono suffix by the name when `revision > 1`.
  - **MethodPanel header:** status Badge + verbs — `Activate` (drafts), `Retire` + `New Revision` (active), `New Revision` (retired) — each behind the house hand-rolled confirm modal pattern (clone MethodsPage's delete-confirm card 428-462); Activate's confirm copy names the predecessor being retired ("Activates rev N and retires rev N-1; its service defaults move to this revision").
  - **Edit mode:** compute `locked = method.status !== 'draft'`; render locked fields as `DetailRow`s (never inputs) with a `Lock` icon in the label when locked; `notes` + department + instruments remain editable; Save sends only editable fields when locked (never rely on the server 409 alone, but surface it via toast if it fires).
  - **Revision history section** (`border-t pt-4` idiom): walk the chain client-side from the already-loaded methods list (`supersedes_id` links both directions: predecessors via the chain, successors via `methods.find(x => x.supersedes_id === m.id)`); render `rev N — status — activated_at` rows; clicking one calls the existing `setSelectedId`-equivalent through a new optional prop `onSelectMethod?: (id: number) => void` wired from MethodsPage.
  - **Attachments section:** file input (`<input type="file">` in a Button-styled label), list rows `filename · size · date` with a Download anchor (`href={methodAttachmentDownloadUrl(...)}` `target="_blank"`) and a Delete `X` shown only while draft.
- [ ] **Step 4: vitest PASS + slice-1 FE suites** (`src/test/methods-catalog-fields.test.tsx` — update its method fixtures to carry `status: 'active', revision: 1`). **Step 5: Commit** — `feat(methods-ui): lifecycle verbs, revision history, attachments`.

---

### Task 8: FE — `coa_method_text` suggest on the profile editor

**Files:** Modify `src/components/hplc/AnalysisProfilesPage.tsx` (COA Section block); Test: extend `src/test/analysis-profiles-coa-display.test.tsx`-adjacent new file `src/test/coa-method-text-suggest.test.tsx`.

**Interfaces:** Consumes `getAnalysisServices` (rows now carry `default_method_id`) + `getMethods` (for name/code/technique/reference). Pure client-side derivation — no new endpoint.

- [ ] **Step 1: Failing test** (harness = copy of `src/test/analysis-profiles-coa-display.test.tsx`'s mocks/wrapper/PROFILE fixture, extended: PROFILE has `member_service_ids: [5]`; `getAnalysisServices` returns `[{ id: 5, keyword: 'LEAD-PPM', title: 'Lead', default_method_id: 11, … }]`; `getMethods` returns `[{ id: 11, code: 'AM-ELEM-001', technique: 'ICP-MS', reference: 'USP <232>/<233>', name: 'ICP-MS', status: 'active', … }]`):

```tsx
it('suggest fills coa_method_text from member default methods, never automatically', async () => {
  const user = userEvent.setup()
  render(<AnalysisProfilesPage />, { wrapper })
  await user.click(await screen.findByText('Heavy Metals'))
  const field = await screen.findByLabelText(/^method$/i)
  expect(field).toHaveValue('')                            // never auto-filled
  await user.click(screen.getByRole('button', { name: /suggest from methods/i }))
  expect(field).toHaveValue('AM-ELEM-001 — ICP-MS per USP <232>/<233>')
})

it('suggest disabled when no member default resolves', async () => {
  vi.mocked(getAnalysisServices).mockResolvedValue(
    [{ id: 5, keyword: 'LEAD-PPM', title: 'Lead', default_method_id: null }] as never)
  const user = userEvent.setup()
  render(<AnalysisProfilesPage />, { wrapper })
  await user.click(await screen.findByText('Heavy Metals'))
  expect(await screen.findByRole('button', { name: /suggest from methods/i })).toBeDisabled()
})
```
- [ ] **Step 2: FAIL.** **Step 3: Implement** — beside the existing `coa_method_text` input (`Method` label, from #106), a ghost `Suggest from methods` button; derivation: member service ids → `default_method_id` set → distinct methods → for each: `` `${m.code ?? m.name}${m.technique ? ` — ${m.technique}` : ''}${m.reference ? ` per ${m.reference}` : ''}` `` → joined with `'; '`; sets the form field only (authored-override contract unchanged).
- [ ] **Step 4: vitest PASS.** **Step 5: Commit** — `feat(profiles-ui): suggest COA method text from member methods`.

---

### Task 9: Gates

- [ ] Backend full suite → failure-set diff vs `../.baseline_ids.txt` → empty. Pay attention to slice-1/2 method tests: create now mints drafts — Tasks 2–4 already updated the affected assertions; the diff proves nothing else regressed.
- [ ] FE: `npx vitest run src/test/method-lifecycle-ui.test.tsx src/test/coa-method-text-suggest.test.tsx src/test/methods-catalog-fields.test.tsx src/test/instruments-page-local.test.tsx` → pass; `npx tsc --noEmit`; eslint+prettier on touched files.
- [ ] Commit stragglers. No push.

## Cross-slice consistency notes for the executor

- Slice 1's `create_method` mints `active=True` implicitly; **this slice flips creates to `status='draft'`/`active=False`** (Task 2). Slice-1 tests asserting create-then-immediately-usable defaults (`default_method_id` resolving to a just-created method in `test_default_method_id_fail_open`) must activate the method first — Task 2 updates those tests in the same commit, with the reviewer checking each edit is the minimal activation insert, not an assertion weakening.
- The `_method_to_response(db, method)` signature (db-threaded in slice 1 Task 3) is assumed everywhere here.
- Nothing in this slice touches `stamp_method_instrument`, the bulk verb, promote, or the COA label — historical prints are exercised by the existing suites.
