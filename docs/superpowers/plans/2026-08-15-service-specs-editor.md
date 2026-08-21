# Service Specs Editor + Peptide Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin UI + API for `analysis_service_specs` with a new peptide-level spec tier, so new native families get their COA specs without code or SQL.

**Architecture:** Extend the existing table with a nullable `peptide_id` FK (three row tiers: peptide / matrix / wildcard); teach `coa/spec_rules.resolve_spec` a peptide-first precedence chain anchored on identity-service FKs; add three REST routes in `main.py`; render an editor subsection in `AnalysisServicesPage`'s detail panel via a new `ServiceSpecsSection` component.

**Tech Stack:** FastAPI + SQLAlchemy (backend, raw-SQL idempotent boot migrations in `database.py` — NOT alembic), React + plain `useState`/`api.ts` fetchers (the page's house pattern — NOT TanStack).

**Spec:** `docs/superpowers/specs/2026-08-15-service-specs-editor-design.md` (rulings R1-R6 there are binding).

## Global Constraints

- Base `b30d9fc0`; branch `feat/spec-ownership-s2-specs-editor`; worktree `C:\tmp\Accu-Mk1-specs-editor`.
- Backend venv python: `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe` (run pytest from `backend/`).
- EVERY spec write calls `catalog/service_spec_audit.record_spec_change(db, spec, before=..., actor_user_id=...)`. No spec write touches `catalog_change_log` (documented exemption). Rows are deactivated, never deleted — no DELETE route.
- An unresolvable peptide NEVER aborts a COA (R4); blends skip the peptide tier (R5); peptide anchor = identity-service `peptide_id` FK, never `_fuzzy_match_peptide` (R6).
- The existing fail-closed no-spec abort must be preserved (extended message OK, weakening NOT OK).
- Frontend: npm only; match `AnalysisServicesPage.tsx` conventions (useState + `@/lib/api` fetchers + `load()` callback); rich hover tooltips are the house default.
- Full-suite gates are failure-SET diffs vs the 68F/14E baseline — never zero-failures.
- Commit after each task; `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

### Task 1: Schema — peptide_id column, tier CHECK, index rework

**Files:**
- Modify: `backend/database.py` (the migration list region that created `analysis_service_specs`, ~:1559-1586)
- Modify: `backend/models.py:200-235` (`AnalysisServiceSpec`)
- Modify: `backend/catalog/service_spec_audit.py` (`snapshot_spec`)
- Test: `backend/tests/test_analysis_service_spec_model.py` (extend)

**Interfaces:**
- Produces: `AnalysisServiceSpec.peptide_id: Optional[int]` column; DB objects `ck_analysis_service_specs_tier`, `uq_analysis_service_specs_peptide`, `uq_analysis_service_specs_wildcard` (replacing `uq_analysis_service_specs_null_matrix`); `snapshot_spec()` dict gains `"peptide_id"`.

- [ ] **Step 1: Write failing model tests** (extend `test_analysis_service_spec_model.py`, following its existing fixtures/session pattern):

```python
def test_tier_check_rejects_peptide_and_matrix_together(db_session, svc, peptide):
    spec = AnalysisServiceSpec(
        analysis_service_id=svc.id, matrix="Peptide", peptide_id=peptide.id,
        rule_kind="range", max_value=Decimal("1"),
    )
    db_session.add(spec)
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_one_active_peptide_row_per_service_peptide(db_session, svc, peptide):
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svc.id, peptide_id=peptide.id,
        rule_kind="range", max_value=Decimal("1")))
    db_session.flush()
    db_session.add(AnalysisServiceSpec(
        analysis_service_id=svc.id, peptide_id=peptide.id,
        rule_kind="range", max_value=Decimal("2")))
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_wildcard_and_peptide_rows_coexist(db_session, svc, peptide):
    db_session.add_all([
        AnalysisServiceSpec(analysis_service_id=svc.id,
                            rule_kind="range", max_value=Decimal("1")),
        AnalysisServiceSpec(analysis_service_id=svc.id, peptide_id=peptide.id,
                            rule_kind="range", max_value=Decimal("2")),
    ])
    db_session.flush()  # must NOT raise — the old null_matrix index would have collided these


def test_snapshot_spec_carries_peptide_id(db_session, svc, peptide):
    spec = AnalysisServiceSpec(analysis_service_id=svc.id, peptide_id=peptide.id,
                               rule_kind="range", max_value=Decimal("1"))
    db_session.add(spec); db_session.flush()
    assert snapshot_spec(spec)["peptide_id"] == peptide.id
```

A `peptide` fixture may need creating beside the file's existing `svc` fixture — mirror how other tests construct `Peptide` rows (grep `Peptide(` in `backend/tests/` and copy the minimal shape).

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv-or-global-python -m pytest tests/test_analysis_service_spec_model.py -q` (use the Global Constraints venv path)
Expected: new tests FAIL (`peptide_id` unexpected kwarg).

- [ ] **Step 3: models.py** — inside `AnalysisServiceSpec`: add column and rework `__table_args__`:

```python
peptide_id = Column(Integer, ForeignKey("peptides.id"), nullable=True)
```

In `__table_args__`: add tier CHECK + peptide index; change the old NULL-matrix index into the both-NULL wildcard:

```python
CheckConstraint(
    "NOT (matrix IS NOT NULL AND peptide_id IS NOT NULL)",
    name="ck_analysis_service_specs_tier",
),
Index(
    "uq_analysis_service_specs_peptide",
    "analysis_service_id", "peptide_id",
    unique=True,
    postgresql_where=text("active AND peptide_id IS NOT NULL"),
    sqlite_where=text("active AND peptide_id IS NOT NULL"),
),
Index(
    "uq_analysis_service_specs_wildcard",
    "analysis_service_id",
    unique=True,
    postgresql_where=text("active AND matrix IS NULL AND peptide_id IS NULL"),
    sqlite_where=text("active AND matrix IS NULL AND peptide_id IS NULL"),
),
```

Delete the old `uq_analysis_service_specs_null_matrix` Index entry. Update the class docstring: three tiers, peptide bound by FK.

- [ ] **Step 4: database.py** — append to the migration list (idempotent raw-SQL house style; keep the existing `analysis_service_specs` entries untouched, add AFTER them):

```python
# --- spec-ownership slice 2: peptide tier ---
"ALTER TABLE analysis_service_specs ADD COLUMN IF NOT EXISTS peptide_id "
"INTEGER REFERENCES peptides(id)",
# Named CHECK, added only if absent (union-preserve idiom, ck_lims_sub_sample_events_one_host precedent)
"""DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_analysis_service_specs_tier'
          AND conrelid = 'analysis_service_specs'::regclass
    ) THEN
        ALTER TABLE analysis_service_specs
            ADD CONSTRAINT ck_analysis_service_specs_tier
                CHECK (NOT (matrix IS NOT NULL AND peptide_id IS NOT NULL));
    END IF;
END $$""",
"CREATE UNIQUE INDEX IF NOT EXISTS uq_analysis_service_specs_peptide "
"ON analysis_service_specs (analysis_service_id, peptide_id) "
"WHERE active AND peptide_id IS NOT NULL",
# The old null_matrix slot must not collide peptide rows with the wildcard:
# retire it and re-key the wildcard on BOTH columns NULL. DROP IF EXISTS is
# idempotent; an older image booting later recreates the old index (its list
# still carries the CREATE) — accepted LAST-BOOT-WINS class, documented here.
"DROP INDEX IF EXISTS uq_analysis_service_specs_null_matrix",
"CREATE UNIQUE INDEX IF NOT EXISTS uq_analysis_service_specs_wildcard "
"ON analysis_service_specs (analysis_service_id) "
"WHERE active AND matrix IS NULL AND peptide_id IS NULL",
```

Also update the inline CREATE TABLE at :1559 to include `peptide_id INTEGER REFERENCES peptides(id)` and the tier CHECK inline, and swap its two index statements to the new trio (fresh installs must never create the retired index). NOTE: match the ACTUAL list syntax at the insertion site (each entry is a py string in a list).

- [ ] **Step 5: `service_spec_audit.snapshot_spec`** — add `"peptide_id": spec.peptide_id,` to the dict.

- [ ] **Step 6: Run the model test file**

Expected: all PASS (old tests too — especially any that asserted the old null_matrix behavior; if one pins the OLD index name/behavior, update it to the wildcard semantics and say so in the commit).

- [ ] **Step 7: Commit** — `feat(spec-ownership): peptide tier schema — peptide_id column, tier CHECK, wildcard index re-key`

---

### Task 2: Resolver — peptide-first precedence + identity anchor

**Files:**
- Modify: `backend/coa/spec_rules.py` (`resolve_spec`)
- Modify: `backend/coa/native_sections.py` (`:161-203` region — matrix derivation + abort message)
- Test: `backend/tests/test_spec_rules.py` (extend), `backend/tests/test_native_sections_specs.py` (new; if an existing native-sections test file covers spec resolution, extend it instead — check first)

**Interfaces:**
- Consumes: Task 1's `peptide_id` column.
- Produces: `resolve_spec(db, service_id, matrix, peptide_id=None)` (new optional param, default preserves every other caller); `sample_peptide_id(db, parent_pk) -> Optional[int]` in `spec_rules.py`.

- [ ] **Step 1: Write failing resolver tests** (extend `test_spec_rules.py`, reusing its session/spec-row fixtures):

```python
def test_resolve_prefers_peptide_over_matrix_over_wildcard(db_session, svc, peptide):
    wild = _spec(svc, max_value=1)                      # helper per file conventions
    mat  = _spec(svc, matrix="Peptide", max_value=2)
    pep  = _spec(svc, peptide_id=peptide.id, max_value=3)
    assert resolve_spec(db_session, svc.id, "Peptide", peptide_id=peptide.id).id == pep.id
    assert resolve_spec(db_session, svc.id, "Peptide", peptide_id=None).id == mat.id
    assert resolve_spec(db_session, svc.id, None, peptide_id=None).id == wild.id


def test_resolve_peptide_tier_falls_through_when_absent(db_session, svc, peptide):
    mat = _spec(svc, matrix="Peptide", max_value=2)
    assert resolve_spec(db_session, svc.id, "Peptide", peptide_id=peptide.id).id == mat.id


def test_sample_peptide_id_unique_anchor(db_session, parent_with_identity):
    # parent whose family rows reference exactly one peptide-linked service
    assert sample_peptide_id(db_session, parent_with_identity.id) == EXPECTED_PEPTIDE_ID


def test_sample_peptide_id_blend_or_none_returns_none(db_session, parent_two_peptides, parent_no_identity):
    assert sample_peptide_id(db_session, parent_two_peptides.id) is None
    assert sample_peptide_id(db_session, parent_no_identity.id) is None
```

Build the three parent fixtures with the file's existing model-construction helpers (parent `LimsSample` + `LimsSubSample` + `LimsAnalysis` rows joined to `AnalysisService(peptide_id=...)`); two-peptide parent = two services with different `peptide_id`.

- [ ] **Step 2: Run to verify failure** — `pytest tests/test_spec_rules.py -q` → FAIL (unexpected kwarg / missing function).

- [ ] **Step 3: Implement in `spec_rules.py`:**

```python
def resolve_spec(db: Session, service_id: int, matrix: Optional[str],
                 peptide_id: Optional[int] = None):
    """Active spec by precedence: (service, peptide) -> (service, matrix) ->
    (service, wildcard) -> None. peptide_id=None skips tier 1 (unresolved
    peptide / blend / non-peptide matrix — R4/R5: coarsen, never abort)."""
    from models import AnalysisServiceSpec

    if peptide_id is not None:
        row = db.execute(
            select(AnalysisServiceSpec).where(
                AnalysisServiceSpec.analysis_service_id == service_id,
                AnalysisServiceSpec.peptide_id == peptide_id,
                AnalysisServiceSpec.active.is_(True),
            )
        ).scalar_one_or_none()
        if row is not None:
            return row
    if matrix is not None:
        row = db.execute(
            select(AnalysisServiceSpec).where(
                AnalysisServiceSpec.analysis_service_id == service_id,
                AnalysisServiceSpec.matrix == matrix,
                AnalysisServiceSpec.active.is_(True),
            )
        ).scalar_one_or_none()
        if row is not None:
            return row
    return db.execute(
        select(AnalysisServiceSpec).where(
            AnalysisServiceSpec.analysis_service_id == service_id,
            AnalysisServiceSpec.matrix.is_(None),
            AnalysisServiceSpec.peptide_id.is_(None),
            AnalysisServiceSpec.active.is_(True),
        )
    ).scalar_one_or_none()


def sample_peptide_id(db: Session, parent_pk: int) -> Optional[int]:
    """The parent's peptide anchor (R6): the DISTINCT peptide_id over every
    family analysis whose service is peptide-linked. Exactly one -> that id;
    zero or many (bac water / blends / unresolved) -> None (R4/R5)."""
    from models import AnalysisService, LimsAnalysis, LimsSubSample

    ids = db.execute(
        select(AnalysisService.peptide_id)
        .join(LimsAnalysis, LimsAnalysis.analysis_service_id == AnalysisService.id)
        .outerjoin(LimsSubSample, LimsSubSample.id == LimsAnalysis.lims_sub_sample_pk)
        .where(
            AnalysisService.peptide_id.is_not(None),
            (LimsAnalysis.lims_sample_pk == parent_pk)
            | (LimsSubSample.parent_sample_pk == parent_pk),
        )
        .distinct()
    ).scalars().all()
    return ids[0] if len(ids) == 1 else None
```

CRITICAL: the wildcard arm now also requires `peptide_id IS NULL` — without it a peptide row could masquerade as the default.

- [ ] **Step 4: Wire `native_sections.py`** — at `:162`:

```python
matrix = normalize_matrix(parent.sample_type_title)
peptide_id = sample_peptide_id(db, parent.id)
```

(import `sample_peptide_id` from `coa.spec_rules` in the existing import line at `:25`). At the `resolve_spec` call site pass `peptide_id=peptide_id`. Extend the no-spec abort message to name the tiers consulted:

```python
raise NativeSectionsError(
    f"native sections: profile '{prof.key}' member service "
    f"'{svc.keyword}' (id={svc.id}) has no active spec "
    f"(tiers consulted: peptide={peptide_id!r}, matrix={matrix!r}, wildcard) "
    f"on {sample_id} — file one in analysis_service_specs"
)
```

- [ ] **Step 5: Run** `pytest tests/test_spec_rules.py tests/test_native_sections_validation.py -q` (plus whatever native-sections test files exist matching `test_native_sections*`) — all PASS; the pre-existing abort-path test must still pass with the extended message (fix its assertion to a substring that survives, e.g. `"has no active spec"` — never delete it).

- [ ] **Step 6: Commit** — `feat(spec-ownership): peptide-first spec resolution anchored on identity-service FK`

---

### Task 3: API routes — list/create/patch specs

**Files:**
- Modify: `backend/main.py` (beside the `/analysis-services` routes, after `:3391`)
- Test: `backend/tests/test_service_spec_routes.py` (new; copy client/auth fixtures from an existing route test file, e.g. the analysis-services route tests)

**Interfaces:**
- Consumes: Task 1 column; `record_spec_change`, `snapshot_spec` from `catalog/service_spec_audit.py`.
- Produces: `GET /analysis-services/{service_id}/specs` → `list[ServiceSpecResponse]`; `POST /analysis-services/{service_id}/specs` → 201 `ServiceSpecResponse`; `PATCH /analysis-service-specs/{spec_id}` → `ServiceSpecResponse`. `ServiceSpecResponse` fields: `id, analysis_service_id, matrix, peptide_id, peptide_code, rule_kind, min_value, max_value, equals_value, unit, display_override, active, updated_at` (numerics serialized as `str | None`).

- [ ] **Step 1: Failing route tests** (shape per the file you copied fixtures from):

```python
def test_create_and_list_wildcard_spec(client, svc):
    r = client.post(f"/analysis-services/{svc.id}/specs",
                    json={"rule_kind": "range", "max_value": "0.5", "unit": "µg/g"})
    assert r.status_code == 201
    body = client.get(f"/analysis-services/{svc.id}/specs").json()
    assert [s["max_value"] for s in body] == ["0.5"]

def test_create_rejects_both_tiers(client, svc, peptide):
    r = client.post(f"/analysis-services/{svc.id}/specs",
                    json={"rule_kind": "range", "max_value": "1",
                          "matrix": "Peptide", "peptide_id": peptide.id})
    assert r.status_code == 422

def test_create_conflict_on_second_active_wildcard(client, svc):
    p = {"rule_kind": "range", "max_value": "1"}
    assert client.post(f"/analysis-services/{svc.id}/specs", json=p).status_code == 201
    assert client.post(f"/analysis-services/{svc.id}/specs", json=p).status_code == 409

def test_create_rejects_unknown_matrix(client, svc):
    r = client.post(f"/analysis-services/{svc.id}/specs",
                    json={"rule_kind": "range", "max_value": "1", "matrix": "Plasma"})
    assert r.status_code == 422

def test_patch_deactivates_and_audits(client, db_session, svc):
    sid = client.post(f"/analysis-services/{svc.id}/specs",
                      json={"rule_kind": "range", "max_value": "1"}).json()["id"]
    r = client.patch(f"/analysis-service-specs/{sid}", json={"active": False})
    assert r.status_code == 200 and r.json()["active"] is False
    audits = db_session.execute(select(AuditLog).where(
        AuditLog.operation == "analysis_service_spec_changed")).scalars().all()
    assert audits[-1].details["before"]["active"] is True
    assert audits[-1].details["after"]["active"] is False
    assert audits[-1].details["actor_user_id"] is not None

def test_rule_shape_422(client, svc):
    r = client.post(f"/analysis-services/{svc.id}/specs", json={"rule_kind": "range"})
    assert r.status_code == 422
```

- [ ] **Step 2: Run to verify 404s/fails.**

- [ ] **Step 3: Implement in `main.py`.** Pydantic (beside the other response models):

```python
_SPEC_MATRICES = ("Peptide", "Bacteriostatic Water")  # normalize_matrix output vocabulary; extend deliberately, never free-text

class ServiceSpecResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    analysis_service_id: int
    matrix: Optional[str] = None
    peptide_id: Optional[int] = None
    peptide_code: Optional[str] = None
    rule_kind: str
    min_value: Optional[str] = None
    max_value: Optional[str] = None
    equals_value: Optional[str] = None
    unit: Optional[str] = None
    display_override: Optional[str] = None
    active: bool
    updated_at: Optional[datetime] = None

class ServiceSpecCreate(BaseModel):
    matrix: Optional[str] = None
    peptide_id: Optional[int] = None
    rule_kind: Literal["range", "equals"]
    min_value: Optional[str] = None
    max_value: Optional[str] = None
    equals_value: Optional[str] = None
    unit: Optional[str] = None
    display_override: Optional[str] = None

class ServiceSpecPatch(BaseModel):
    rule_kind: Optional[Literal["range", "equals"]] = None
    min_value: Optional[str] = None
    max_value: Optional[str] = None
    equals_value: Optional[str] = None
    unit: Optional[str] = None
    display_override: Optional[str] = None
    active: Optional[bool] = None
```

Shared validation helper + serializer (module-level, near the routes):

```python
def _validate_spec_shape(*, rule_kind, min_value, max_value, equals_value,
                         matrix, peptide_id, db):
    if matrix is not None and peptide_id is not None:
        raise HTTPException(422, "a spec row is peptide-tier OR matrix-tier, not both")
    if matrix is not None and matrix not in _SPEC_MATRICES:
        raise HTTPException(422, f"matrix must be one of {_SPEC_MATRICES}")
    if peptide_id is not None and db.get(Peptide, peptide_id) is None:
        raise HTTPException(422, f"peptide {peptide_id} does not exist")
    if rule_kind == "range":
        if equals_value is not None or (min_value is None and max_value is None):
            raise HTTPException(422, "range rule needs min and/or max, and no equals_value")
    else:  # equals
        if equals_value is None or min_value is not None or max_value is not None:
            raise HTTPException(422, "equals rule needs equals_value only")


def _spec_response(db, spec) -> ServiceSpecResponse:
    code = None
    if spec.peptide_id is not None:
        pep = db.get(Peptide, spec.peptide_id)
        code = pep.code if pep else None
    return ServiceSpecResponse(
        id=spec.id, analysis_service_id=spec.analysis_service_id,
        matrix=spec.matrix, peptide_id=spec.peptide_id, peptide_code=code,
        rule_kind=spec.rule_kind,
        min_value=str(spec.min_value) if spec.min_value is not None else None,
        max_value=str(spec.max_value) if spec.max_value is not None else None,
        equals_value=spec.equals_value, unit=spec.unit,
        display_override=spec.display_override, active=spec.active,
        updated_at=spec.updated_at,
    )
```

(Check the actual `Peptide` model attribute for the short code — the Peptides page shows e.g. `5A1MQ`; use that attribute name, `code` here is a stand-in to verify at implementation time.) Routes:

```python
@app.get("/analysis-services/{service_id}/specs",
         response_model=list[ServiceSpecResponse])
def list_service_specs(service_id: int, db: Session = Depends(get_db),
                       _current_user=Depends(get_current_user)):
    if db.get(AnalysisService, service_id) is None:
        raise HTTPException(404, "analysis service not found")
    rows = db.execute(
        select(AnalysisServiceSpec)
        .where(AnalysisServiceSpec.analysis_service_id == service_id,
               AnalysisServiceSpec.active.is_(True))
        .order_by(AnalysisServiceSpec.peptide_id.is_(None),
                  AnalysisServiceSpec.matrix.is_(None),
                  AnalysisServiceSpec.id)
    ).scalars().all()
    return [_spec_response(db, s) for s in rows]


@app.post("/analysis-services/{service_id}/specs",
          response_model=ServiceSpecResponse, status_code=201)
def create_service_spec(service_id: int, req: ServiceSpecCreate,
                        db: Session = Depends(get_db),
                        current_user=Depends(get_current_user)):
    from catalog.service_spec_audit import record_spec_change

    if db.get(AnalysisService, service_id) is None:
        raise HTTPException(404, "analysis service not found")
    _validate_spec_shape(rule_kind=req.rule_kind, min_value=req.min_value,
                         max_value=req.max_value, equals_value=req.equals_value,
                         matrix=req.matrix, peptide_id=req.peptide_id, db=db)
    spec = AnalysisServiceSpec(
        analysis_service_id=service_id, matrix=req.matrix,
        peptide_id=req.peptide_id, rule_kind=req.rule_kind,
        min_value=Decimal(req.min_value) if req.min_value is not None else None,
        max_value=Decimal(req.max_value) if req.max_value is not None else None,
        equals_value=req.equals_value, unit=req.unit,
        display_override=req.display_override,
        updated_by_id=current_user.id,
    )
    db.add(spec)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "an active spec already exists for this tier — deactivate it first")
    record_spec_change(db, spec, before=None, actor_user_id=current_user.id)
    db.commit(); db.refresh(spec)
    return _spec_response(db, spec)


@app.patch("/analysis-service-specs/{spec_id}", response_model=ServiceSpecResponse)
def patch_service_spec(spec_id: int, req: ServiceSpecPatch,
                       db: Session = Depends(get_db),
                       current_user=Depends(get_current_user)):
    from catalog.service_spec_audit import record_spec_change, snapshot_spec

    spec = db.get(AnalysisServiceSpec, spec_id)
    if spec is None:
        raise HTTPException(404, "spec not found")
    before = snapshot_spec(spec)
    fields = req.model_dump(exclude_unset=True)
    merged = {
        "rule_kind": fields.get("rule_kind", spec.rule_kind),
        "min_value": fields.get("min_value",
                                str(spec.min_value) if spec.min_value is not None else None),
        "max_value": fields.get("max_value",
                                str(spec.max_value) if spec.max_value is not None else None),
        "equals_value": fields.get("equals_value", spec.equals_value),
    }
    _validate_spec_shape(matrix=spec.matrix, peptide_id=spec.peptide_id, db=db, **merged)
    for k, v in fields.items():
        if k in ("min_value", "max_value") and v is not None:
            v = Decimal(v)
        setattr(spec, k, v)
    spec.updated_by_id = current_user.id
    record_spec_change(db, spec, before=before, actor_user_id=current_user.id)
    db.commit(); db.refresh(spec)
    return _spec_response(db, spec)
```

Imports to confirm at top of file (all likely present): `Decimal`, `IntegrityError`, `Literal`, `AnalysisServiceSpec`, `Peptide`, `AuditLog` (tests only).

- [ ] **Step 4: Run the new test file** — all PASS.
- [ ] **Step 5: Run neighbors** — `pytest tests/test_analysis_service_spec_model.py tests/test_spec_rules.py -q` still green.
- [ ] **Step 6: Commit** — `feat(spec-ownership): service-spec CRUD routes with audited writes`

---

### Task 4: FE api client — spec types + fetchers

**Files:**
- Modify: `src/lib/api.ts` (beside the analysis-services fetchers, ~:2460-2560)
- Test: types compile via `npm run check:all` typecheck (no dedicated unit test — fetchers here follow the file's untested-fetcher convention)

**Interfaces:**
- Produces: `AnalysisServiceSpecRecord` type; `listServiceSpecs(serviceId): Promise<AnalysisServiceSpecRecord[]>`; `createServiceSpec(serviceId, payload): Promise<AnalysisServiceSpecRecord>`; `patchServiceSpec(specId, payload): Promise<AnalysisServiceSpecRecord>`.

- [ ] **Step 1: Add types + fetchers** (copy the fetch/headers/error idiom from `listAnalysisServices` at ~:2460 verbatim — same `API_BASE_URL()`, same auth header helper, same error handling):

```typescript
export interface AnalysisServiceSpecRecord {
  id: number
  analysis_service_id: number
  matrix: string | null
  peptide_id: number | null
  peptide_code: string | null
  rule_kind: 'range' | 'equals'
  min_value: string | null
  max_value: string | null
  equals_value: string | null
  unit: string | null
  display_override: string | null
  active: boolean
  updated_at: string | null
}

export interface ServiceSpecPayload {
  matrix?: string | null
  peptide_id?: number | null
  rule_kind: 'range' | 'equals'
  min_value?: string | null
  max_value?: string | null
  equals_value?: string | null
  unit?: string | null
  display_override?: string | null
}
```

with `listServiceSpecs` (GET `/analysis-services/${serviceId}/specs`), `createServiceSpec` (POST, JSON body), `patchServiceSpec` (PATCH `/analysis-service-specs/${specId}`, body `Partial<ServiceSpecPayload> & { active?: boolean }`).

- [ ] **Step 2:** `npm run typecheck` (or the check:all typecheck target) passes.
- [ ] **Step 3: Commit** — `feat(spec-ownership): api client for service specs`

---

### Task 5: FE editor — ServiceSpecsSection in the detail panel

**Files:**
- Create: `src/components/hplc/ServiceSpecsSection.tsx`
- Modify: `src/components/hplc/AnalysisServicesPage.tsx` (detail panel render, where the selected service's edit form lives ~:454+; pass `peptides` down — already loaded at `:66`)
- Test: `src/components/hplc/__tests__/ServiceSpecsSection.test.tsx` if the repo has component tests for this area (check `src/components/hplc/__tests__/`); otherwise rely on typecheck + lint + manual UAT (state which applies in the task report)

**Interfaces:**
- Consumes: Task 4 fetchers/types; the page's `PeptideRecord[]` state.
- Produces: `<ServiceSpecsSection serviceId={number} peptides={PeptideRecord[]} />`.

- [ ] **Step 1: Component.** Follow the page's house style (useState + load callback + inline handlers; styling via the page's existing class/utility conventions — copy the visual idiom of an existing subsection). Behavior spec:

- Loads specs on mount / serviceId change via `listServiceSpecs`.
- Renders active rows as a small table: tier chip (`peptide_code` ?? `matrix` ?? 'All'), readable rule (`≤ max` / `≥ min` / `min – max` / `= equals_value` plus unit), display override if set, Deactivate button (confirm via the page's existing confirm idiom; calls `patchServiceSpec(id, { active: false })` then reloads).
- "Add spec" form: tier select (All / Matrix / Peptide) → conditional matrix dropdown (`Peptide`, `Bacteriostatic Water`) or searchable peptide select over the `peptides` prop (filter on code/name substring, the page's search-input idiom); rule-kind toggle (range/equals) → conditional min/max inputs or equals input; unit; display override. Submit → `createServiceSpec` → reload; 409 surfaces the server message inline (the "deactivate it first" flow); empty-required-fields disable the submit.
- Header shows count: `Specs (N)`; a rich hover tooltip on the header explains precedence: "Peptide-specific overrides Matrix overrides All. COA generation fails closed if no tier matches."
- Component stays under ~250 lines; extract `ruleLabel(spec)` helper for the readable rule.

- [ ] **Step 2: Wire into the page.** In the detail panel (the `service` edit region starting ~:454), render `<ServiceSpecsSection serviceId={service.id} peptides={peptides} />` after the existing form sections; thread the `peptides` state from the page root. In the service LIST rows, no change (spec-count badge would need a bulk endpoint — YAGNI'd out; the count lives in the section header).

- [ ] **Step 3:** `npm run check:all` — typecheck + lint + ast:lint green (fix what it flags; the ast-grep rules ban Zustand destructuring — not used here).
- [ ] **Step 4: Component test if the area has them** (per Files note): render with mocked fetchers, assert rows render + add-form validation disables submit until shape is valid.
- [ ] **Step 5: Commit** — `feat(spec-ownership): specs editor section on Analysis Services`

---

### Task 6: Gates, ledger, arc note

**Files:**
- Modify: `.superpowers/sdd/2026-08-15-specs-editor/progress.md` (the SDD ledger this execution creates)
- No product code.

- [ ] **Step 1: Backend full suite** — `pytest tests/ -q` from `backend/`; record the failure SET and diff vs the 68F/14E baseline (sorted sets in `C:\tmp\Accu-Mk1-s9-demand\.superpowers\sdd\2026-08-14-s9-demand-dehardcode-mk1\task-7-report.md`). New failures = stop and fix; baseline failures = pass.
- [ ] **Step 2: FE gate** — `npm run check:all` clean (modulo pre-existing baseline noise, recorded).
- [ ] **Step 3: Ledger** — write the slice summary: rulings honored (R1-R6), deviations, deferred minors, the LAST-BOOT-WINS note on the retired index, and the arc-activation recipe (mount/cherry-pick onto `arcitest`, author the 4 HM specs through the UI, deactivate the interim hand-SQL rows via the editor as its first exercise).
- [ ] **Step 4: Commit** — `docs(spec-ownership): slice-2 ledger + gates record`

---

## Self-review notes (already applied)

- Spec→plan coverage: R1-R6 all land (T1 schema, T2 resolver/anchor, T3 audit-wired routes, T5 editor); fail-closed abort preserved (T2 step 5 explicitly forbids weakening); no DELETE route anywhere.
- The spec's "TanStack Query" and "alembic migration" lines were wrong for this codebase — plan follows the actual conventions (useState+fetchers; raw-SQL idempotent migrations). The spec file gets a one-line erratum in the ledger rather than a rewrite.
- `peptide_code` attribute name on the `Peptide` model is flagged for implementation-time verification (T3 step 3 note).
- Type consistency: `min_value/max_value` travel as strings over the wire in both directions; `Decimal` only at the DB boundary.
