# Methods Foundation Implementation Plan (slice 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize `hplc_methods` into the catalog's methods table, link methods to analysis services with per-service defaults, and make instruments locally creatable — so every test family can have documented methods and registered instruments.

**Architecture:** Additive columns on `hplc_methods` + a new `method_services` m2m (default flag, partial-unique one-default-per-service) + local instrument CRUD. No new tables of record beyond the m2m; every existing consumer (`lims_analyses.method_id` FK, promote, COA `_method_label`, `instrument_methods`) keeps working untouched.

**Tech Stack:** FastAPI + SQLAlchemy (backend/main.py monolith + database.py boot migrations), React 18 + TS + Tailwind v4 (plain `useState`+`load()` on these pages — NOT react-query), pytest (in-memory SQLite + TestClient), vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-methods-foundation-design.md` (rulings R0–R4 there are binding).

## Global Constraints

- **R0: zero new SENAITE coupling.** New rows never carry `senaite_id`/`senaite_uid`; no API accepts them; `/instruments/sync` untouched; `MethodCreate` DROPS its `senaite_id` field (R0 supersedes the old create shape) and `AddMethodForm` drops the input.
- **Additive-only:** no renames, no drops (except where this plan explicitly says "guard added"), existing HPLC flows untouched.
- **Worktree:** `C:\tmp\Accu-Mk1-methods`, branch `feat/methods-foundation` cut from `b0ba8573` (`feat/coa-display-fields` head). Create with `git -C "C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1" worktree add C:/tmp/Accu-Mk1-methods -b feat/methods-foundation b0ba8573`, then `cmd /c "mklink /J C:\tmp\Accu-Mk1-methods\node_modules C:\tmp\Accu-Mk1-manage-analyses\node_modules"`. Do NOT create a `backend/.env` (an empty-token .env fakes +23 failures).
- **Test interpreter:** `C:\Users\forre\OneDrive\Documents\GitHub\Accumark-Workspace\Accu-Mk1\backend\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider` run from the worktree's `backend/`.
- **Gates are failure-SET diffs, never zero-failures.** Task 1 captures the baseline (`baseline_ids.txt`); the final task diffs against it.
- **FE:** npm only. Pages touched here use the `load()` refresh idiom — do NOT introduce react-query to them.
- **Audit actor idiom** (used in later slices; harmless now): `user_id=getattr(current_user, "id", None)` — never bare `current_user.id`.
- **New m2m tables need BOTH**: a `Table()` in `models.py` (ORM + SQLite tests) AND a `CREATE TABLE IF NOT EXISTS` string appended immediately before the `]` at `database.py:1723` (live Postgres).
- Prose in JSX uses typographic quotes (`’ “ ”`) — house eslint forbids ASCII `'`/`"` in JSX text.

---

### Task 1: Schema — method catalog columns, `method_services`, instrument department

**Files:**
- Modify: `backend/models.py` (HplcMethod ~568-594, Instrument ~153-175, new Table near `instrument_methods` at ~547)
- Modify: `backend/database.py` (append migration strings before the `]` at ~line 1723)
- Test: `backend/tests/test_methods_catalog.py` (new)

**Interfaces:**
- Produces: `HplcMethod.code/technique/department_id/reference/procedure_summary/supersedes_id/origin` columns; `method_services` Table (cols: `id, method_id, analysis_service_id, is_default`); `HplcMethod.services` relationship; `Instrument.department_id`, `Instrument.origin`. Later tasks import `from models import method_services`.

- [ ] **Step 0: capture the backend baseline** (once, before any edit)

```bash
cd C:/tmp/Accu-Mk1-methods/backend
C:/Users/forre/OneDrive/Documents/GitHub/Accumark-Workspace/Accu-Mk1/backend/.venv/Scripts/python.exe -m pytest -q -p no:cacheprovider -rf 2>&1 | grep -E "^(FAILED|ERROR) tests/" | sort > ../.baseline_ids.txt
wc -l ../.baseline_ids.txt
```

- [ ] **Step 1: Write the failing test**

```python
"""Slice 1 foundation: generic method columns + method_services + local instruments.
Harness: in-memory SQLite, same idiom as tests/test_manage_native_routes.py."""
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import models  # noqa: F401
from database import Base
from models import AnalysisService, HplcMethod, Instrument, method_services


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _svc(db, kw):
    s = AnalysisService(title=kw.title(), keyword=kw, origin="mk1", active=True,
                        variance_capable=False)
    db.add(s)
    db.flush()
    return s


def test_method_generic_columns_and_service_links(db_session):
    m = HplcMethod(name="Elemental Impurities by ICP-MS", code="AM-ELEM-001",
                   technique="ICP-MS", reference="USP <232>/<233>",
                   procedure_summary="Microwave digestion; ICP-MS quant.",
                   origin="mk1", active=True)
    db_session.add(m)
    lead = _svc(db_session, "LEAD-PPM")
    db_session.flush()
    db_session.execute(method_services.insert().values(
        method_id=m.id, analysis_service_id=lead.id, is_default=True))
    db_session.commit()

    row = db_session.execute(select(HplcMethod).where(HplcMethod.code == "AM-ELEM-001")).scalar_one()
    assert row.technique == "ICP-MS"
    assert row.origin == "mk1"
    assert row.supersedes_id is None
    link = db_session.execute(select(method_services)).one()
    assert link.is_default is True


def test_instrument_department_and_origin_columns(db_session):
    i = Instrument(name="Agilent 7900 ICP-MS", instrument_type="ICP-MS",
                   department_id=None, origin="mk1", active=True)
    db_session.add(i)
    db_session.commit()
    got = db_session.execute(select(Instrument)).scalar_one()
    assert got.origin == "mk1"
    assert got.senaite_id is None and got.senaite_uid is None
```

- [ ] **Step 2: Run to verify it fails** — `... -m pytest -q tests/test_methods_catalog.py` → FAIL (`cannot import name 'method_services'` / unknown kwargs).

- [ ] **Step 3: Implement models.** In `models.py`, next to `instrument_methods` (~547) add:

```python
# M2M junction: method <-> analysis service (slice 1, methods foundation).
# is_default: at most one default per service, enforced by a partial unique
# index (Postgres AND SQLite both support partial indexes — declared below
# so the app-level 400 in the routes has a real DB backstop in tests too).
method_services = Table(
    "method_services",
    Base.metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("method_id", Integer, ForeignKey("hplc_methods.id", ondelete="CASCADE"), nullable=False),
    Column("analysis_service_id", Integer, ForeignKey("analysis_services.id", ondelete="CASCADE"), nullable=False),
    Column("is_default", Boolean, nullable=False, default=False, server_default=sa_text("false")),
    UniqueConstraint("method_id", "analysis_service_id", name="uq_method_service"),
    Index("uq_method_service_default", "analysis_service_id", unique=True,
          postgresql_where=sa_text("is_default"), sqlite_where=sa_text("is_default")),
)
```

(Import `Index` and `text as sa_text` from sqlalchemy at the top if not present.) On `HplcMethod` add columns + relationship; on `Instrument` add `department_id` + `origin`:

```python
    # Slice 1 (methods foundation): generic catalog identity. NULL technique
    # is legal; the HPLC columns above are only meaningful for technique='HPLC'.
    code: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    technique: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    department_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), nullable=True)
    reference: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    procedure_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    supersedes_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("hplc_methods.id", ondelete="SET NULL"), nullable=True)
    # 'senaite' only on legacy clone-time rows; every new row is 'mk1' (R0).
    origin: Mapped[str] = mapped_column(String(20), nullable=False, default="mk1",
                                        server_default="mk1")
    services: Mapped[list["AnalysisService"]] = relationship(
        "AnalysisService", secondary=method_services)
```

```python
    # Slice 1: scoping for pickers; 'senaite' only on sync-created rows (R0).
    department_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("departments.id", ondelete="SET NULL"), nullable=True)
    origin: Mapped[str] = mapped_column(String(20), nullable=False, default="mk1",
                                        server_default="mk1")
```

- [ ] **Step 4: Implement migrations.** Append before the `]` at `database.py:1723`:

```python
        # --- Methods foundation (slice 1): generic method catalog ---
        "ALTER TABLE hplc_methods ADD COLUMN IF NOT EXISTS code VARCHAR(50)",
        "ALTER TABLE hplc_methods ADD COLUMN IF NOT EXISTS technique VARCHAR(100)",
        "ALTER TABLE hplc_methods ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL",
        "ALTER TABLE hplc_methods ADD COLUMN IF NOT EXISTS reference VARCHAR(500)",
        "ALTER TABLE hplc_methods ADD COLUMN IF NOT EXISTS procedure_summary TEXT",
        "ALTER TABLE hplc_methods ADD COLUMN IF NOT EXISTS supersedes_id INTEGER REFERENCES hplc_methods(id) ON DELETE SET NULL",
        "ALTER TABLE hplc_methods ADD COLUMN IF NOT EXISTS origin VARCHAR(20) NOT NULL DEFAULT 'mk1'",
        # Provenance backfill: only clone-time rows carry senaite_id; new rows
        # never do (R0), so this stays a no-op forever after first boot.
        "UPDATE hplc_methods SET origin = 'senaite' WHERE senaite_id IS NOT NULL AND origin = 'mk1'",
        # Technique backfill: the table only ever held HPLC methods pre-slice.
        # Date-gated so a future non-HPLC row created without technique is
        # never silently relabeled on a later boot.
        "UPDATE hplc_methods SET technique = 'HPLC' WHERE technique IS NULL AND created_at < TIMESTAMP '2026-08-21 00:00:00'",
        # code uniqueness (among rows that have one)
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_hplc_methods_code ON hplc_methods (code) WHERE code IS NOT NULL",
        """
        CREATE TABLE IF NOT EXISTS method_services (
            id SERIAL PRIMARY KEY,
            method_id INTEGER NOT NULL REFERENCES hplc_methods(id) ON DELETE CASCADE,
            analysis_service_id INTEGER NOT NULL REFERENCES analysis_services(id) ON DELETE CASCADE,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            CONSTRAINT uq_method_service UNIQUE (method_id, analysis_service_id)
        )
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_method_service_default ON method_services (analysis_service_id) WHERE is_default",
        # Instruments: local creation + picker scoping
        "ALTER TABLE instruments ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL",
        "ALTER TABLE instruments ADD COLUMN IF NOT EXISTS origin VARCHAR(20) NOT NULL DEFAULT 'mk1'",
        "UPDATE instruments SET origin = 'senaite' WHERE senaite_id IS NOT NULL AND origin = 'mk1'",
```

- [ ] **Step 5: Run tests** → PASS. Also run one adjacent suite to catch model fallout: `-m pytest -q tests/test_manage_native.py` → same result as baseline.

- [ ] **Step 6: Commit** — `git add backend/models.py backend/database.py backend/tests/test_methods_catalog.py && git commit -m "feat(methods): generic method columns, method_services m2m, local instrument columns"`

---

### Task 2: Methods API — generic fields on CRUD, R0 create shape

**Files:**
- Modify: `backend/main.py` — `MethodCreate` (2898), `MethodUpdate` (2910), `MethodResponse` (2945), `create_method` (4116), `update_method` (4138)
- Test: `backend/tests/test_methods_catalog.py` (extend)

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `MethodResponse` now carries `code, technique, department_id, reference, procedure_summary, supersedes_id, origin`. `MethodCreate` fields: `name, instrument_ids, code, technique, department_id, reference, procedure_summary, size_peptide, starting_organic_pct, temperature_mct_c, dissolution, notes` — **no `senaite_id`** (R0). `MethodUpdate` = same optionals + `active` (no `senaite_id`, no `origin`, no `supersedes_id`).

- [ ] **Step 1: Write the failing tests** (append; the route-test client mirrors `tests/test_manage_native_routes.py` — TestClient with `get_db`/`get_current_user` overridden; copy that file's `_client` helper verbatim into this file and expose it as a fixture: `@pytest.fixture\ndef client(db_session):\n    yield from _client(db_session, admin=True)` — match however `_client` is actually shaped in that file, generator or return):

```python
def test_create_method_generic_fields_and_r0(client, db_session):
    r = client.post("/hplc/methods", json={
        "name": "Residual Moisture by KF", "code": "AM-KF-001",
        "technique": "KF", "reference": "USP <921>",
        "procedure_summary": "Karl Fischer titration.",
        "senaite_id": "MET-SHOULD-BE-IGNORED",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["code"] == "AM-KF-001" and body["technique"] == "KF"
    assert body["origin"] == "mk1"
    assert body["senaite_id"] is None  # R0: field not accepted at create


def test_create_method_duplicate_code_400(client, db_session):
    client.post("/hplc/methods", json={"name": "M1", "code": "AM-X-1"})
    r = client.post("/hplc/methods", json={"name": "M2", "code": "AM-X-1"})
    assert r.status_code == 400
    assert "code" in r.json()["detail"].lower()


def test_update_method_generic_fields(client, db_session):
    mid = client.post("/hplc/methods", json={"name": "M3"}).json()["id"]
    r = client.put(f"/hplc/methods/{mid}", json={"technique": "PCR", "reference": "USP <71>"})
    assert r.status_code == 200
    assert r.json()["technique"] == "PCR"
```

- [ ] **Step 2: Run to verify failure** (422/missing-field assertions).

- [ ] **Step 3: Implement.** `MethodCreate`: delete the `senaite_id` field; add `code/technique/department_id/reference/procedure_summary` (all `Optional[...] = None`). `MethodUpdate`: same additions; delete `senaite_id`. `MethodResponse`: add all new fields + `origin: str = "mk1"` + `supersedes_id: Optional[int] = None`. In `create_method`: drop the senaite_id dup-check block; add before constructing:

```python
    if data.code:
        dup_code = db.execute(select(HplcMethod).where(HplcMethod.code == data.code)).scalar_one_or_none()
        if dup_code:
            raise HTTPException(400, f"Method code '{data.code}' already exists on '{dup_code.name}'")
    if data.department_id is not None and not db.get(Department, data.department_id):
        raise HTTPException(400, f"Department {data.department_id} not found")
```

(`Department` is already imported in main.py for the departments CRUD; verify, add import if scoped.) Constructor stays `HplcMethod(**data.model_dump(exclude={"instrument_ids"}))` — `origin` lands via model default `'mk1'`. In `update_method` add the same code-dup (excluding self: `HplcMethod.id != method_id`) and department checks.

- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** — `feat(methods): generic fields on method CRUD; R0 create shape`.

---

### Task 3: Method↔service links — GET/PUT services, defaults, `default_method_id`

**Files:**
- Modify: `backend/main.py` — new routes after `delete_method` (~4170); `AnalysisServiceResponse` (2412) + the GET `/analysis-services` list route (find it via `select(AnalysisService)` near the response model; single list route)
- Test: `backend/tests/test_methods_catalog.py` (extend)

**Interfaces:**
- Produces:
  - `GET /hplc/methods/{method_id}/services` → `list[MethodServiceOut]` where `MethodServiceOut = {analysis_service_id: int, keyword: str|None, title: str, is_default: bool}`
  - `PUT /hplc/methods/{method_id}/services` body `list[MethodServiceLinkIn]` where `MethodServiceLinkIn = {analysis_service_id: int, is_default: bool = False}` — replace-set semantics, 400 on cross-method default conflict
  - `MethodResponse.services: list[MethodServiceOut] = []` (filled by `_method_to_response`)
  - `AnalysisServiceResponse.default_method_id: Optional[int] = None` — fail-open: NULL unless the default link's method is `active`. **Slice 2's pickers consume this exact field.**

- [ ] **Step 1: Failing tests**

```python
def _mk_method(client, name, **kw):
    return client.post("/hplc/methods", json={"name": name, **kw}).json()["id"]


def test_put_services_links_and_defaults(client, db_session):
    lead = _svc(db_session, "LEAD-PPM"); ars = _svc(db_session, "ARSENIC-PPM")
    db_session.commit()
    mid = _mk_method(client, "ICP-MS", code="AM-ELEM-001", technique="ICP-MS")
    r = client.put(f"/hplc/methods/{mid}/services", json=[
        {"analysis_service_id": lead.id, "is_default": True},
        {"analysis_service_id": ars.id, "is_default": True},
    ])
    assert r.status_code == 200
    got = client.get(f"/hplc/methods/{mid}/services").json()
    assert {(s["analysis_service_id"], s["is_default"]) for s in got} == {(lead.id, True), (ars.id, True)}


def test_second_default_for_service_400(client, db_session):
    lead = _svc(db_session, "LEAD-PPM"); db_session.commit()
    m1 = _mk_method(client, "ICP-MS A"); m2 = _mk_method(client, "ICP-MS B")
    client.put(f"/hplc/methods/{m1}/services", json=[{"analysis_service_id": lead.id, "is_default": True}])
    r = client.put(f"/hplc/methods/{m2}/services", json=[{"analysis_service_id": lead.id, "is_default": True}])
    assert r.status_code == 400
    assert "ICP-MS A" in r.json()["detail"]  # names the conflicting method
    # non-default link is fine
    r2 = client.put(f"/hplc/methods/{m2}/services", json=[{"analysis_service_id": lead.id, "is_default": False}])
    assert r2.status_code == 200


def test_default_method_id_fail_open(client, db_session):
    lead = _svc(db_session, "LEAD-PPM"); db_session.commit()
    mid = _mk_method(client, "ICP-MS C")
    client.put(f"/hplc/methods/{mid}/services", json=[{"analysis_service_id": lead.id, "is_default": True}])
    rows = client.get("/analysis-services").json()
    row = next(s for s in rows if s["id"] == lead.id)
    assert row["default_method_id"] == mid
    client.put(f"/hplc/methods/{mid}", json={"active": False})
    rows = client.get("/analysis-services").json()
    row = next(s for s in rows if s["id"] == lead.id)
    assert row["default_method_id"] is None  # fail-open (§4.2)
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.**

```python
class MethodServiceLinkIn(BaseModel):
    analysis_service_id: int
    is_default: bool = False


class MethodServiceOut(BaseModel):
    analysis_service_id: int
    keyword: Optional[str] = None
    title: str
    is_default: bool


def _method_service_rows(db: Session, method_id: int) -> list[MethodServiceOut]:
    rows = db.execute(
        select(method_services.c.analysis_service_id, method_services.c.is_default,
               AnalysisService.keyword, AnalysisService.title)
        .join(AnalysisService, AnalysisService.id == method_services.c.analysis_service_id)
        .where(method_services.c.method_id == method_id)
        .order_by(AnalysisService.keyword)
    ).all()
    return [MethodServiceOut(analysis_service_id=r[0], is_default=r[1], keyword=r[2], title=r[3])
            for r in rows]


@app.get("/hplc/methods/{method_id}/services", response_model=list[MethodServiceOut])
async def get_method_services(method_id: int, db: Session = Depends(get_db),
                              _current_user=Depends(get_current_user)):
    if not db.get(HplcMethod, method_id):
        raise HTTPException(404, f"Method {method_id} not found")
    return _method_service_rows(db, method_id)


@app.put("/hplc/methods/{method_id}/services", response_model=list[MethodServiceOut])
async def put_method_services(method_id: int, links: list[MethodServiceLinkIn],
                              db: Session = Depends(get_db),
                              current_user=Depends(get_current_user)):
    """Replace-set semantics (profile-members precedent). One default per
    service across ALL methods — 400 names the conflicting method; the
    partial unique index is the backstop."""
    method = db.get(HplcMethod, method_id)
    if not method:
        raise HTTPException(404, f"Method {method_id} not found")
    seen: set[int] = set()
    for ln in links:
        if ln.analysis_service_id in seen:
            raise HTTPException(400, f"service {ln.analysis_service_id} listed twice")
        seen.add(ln.analysis_service_id)
        if not db.get(AnalysisService, ln.analysis_service_id):
            raise HTTPException(400, f"analysis service {ln.analysis_service_id} not found")
        if ln.is_default:
            conflict = db.execute(
                select(HplcMethod.name)
                .join(method_services, method_services.c.method_id == HplcMethod.id)
                .where(method_services.c.analysis_service_id == ln.analysis_service_id,
                       method_services.c.is_default.is_(True),
                       method_services.c.method_id != method_id)
            ).scalar_one_or_none()
            if conflict:
                raise HTTPException(
                    400, f"service {ln.analysis_service_id} already has default method "
                         f"'{conflict}' — clear that default first")
    db.execute(method_services.delete().where(method_services.c.method_id == method_id))
    for ln in links:
        db.execute(method_services.insert().values(
            method_id=method_id, analysis_service_id=ln.analysis_service_id,
            is_default=ln.is_default))
    db.commit()
    return _method_service_rows(db, method_id)
```

Add `services: list[MethodServiceOut] = []` to `MethodResponse` and one line in `_method_to_response`: `resp.services = _method_service_rows(db, method.id)` — note `_method_to_response` has no `db` param today; add `db` as a parameter and update its 4 call sites in the method routes. For `default_method_id`: add the field to `AnalysisServiceResponse`; in the GET `/analysis-services` list route, after loading services, one grouped query:

```python
    default_map = dict(db.execute(
        select(method_services.c.analysis_service_id, method_services.c.method_id)
        .join(HplcMethod, HplcMethod.id == method_services.c.method_id)
        .where(method_services.c.is_default.is_(True), HplcMethod.active.is_(True))
    ).all())
```

then set `resp.default_method_id = default_map.get(svc.id)` when building each response row.

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** — `feat(methods): method-services links with one-default-per-service + default_method_id`.

---

### Task 4: DELETE referential guard

**Files:** Modify `backend/main.py:4161` (`delete_method`); test extend.

**Interfaces:** Produces: DELETE → 409 `{"detail": "..."}` when any `lims_analyses.method_id` references the method.

- [ ] **Step 1: Failing test**

```python
def test_delete_method_referenced_by_analysis_409(client, db_session):
    from models import LimsAnalysis, LimsSample
    mid = _mk_method(client, "ICP-MS D")
    svc = _svc(db_session, "CADMIUM-PPM")
    parent = LimsSample(sample_id="P-9001")
    db_session.add(parent); db_session.flush()
    db_session.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                                keyword="CADMIUM-PPM", title="Cadmium",
                                review_state="verified", provenance="canonical",
                                method_id=mid))
    db_session.commit()
    r = client.delete(f"/hplc/methods/{mid}")
    assert r.status_code == 409
    assert "deactivate" in r.json()["detail"].lower()
    assert db_session.get(HplcMethod, mid) is not None
```

- [ ] **Step 2: Run → FAIL** (currently 200). **Step 3: Implement** — in `delete_method`, after the 404 check:

```python
    from models import LimsAnalysis
    ref = db.execute(select(func.count()).select_from(LimsAnalysis)
                     .where(LimsAnalysis.method_id == method_id)).scalar()
    if ref:
        raise HTTPException(
            409, f"Method '{method.name}' is referenced by {ref} analyses and is part "
                 f"of their traceability record — deactivate it instead of deleting")
```

- [ ] **Step 4: PASS.** **Step 5: Commit** — `fix(methods): refuse deleting a method referenced by analyses`.

---

### Task 5: Instruments — local POST/PATCH + response fields

**Files:** Modify `backend/main.py` — `InstrumentResponse` (2393), new `InstrumentCreate`/`InstrumentUpdate` models beside it, new routes after `sync_instruments` (~3340). Test extend.

**Interfaces:**
- Produces: `POST /instruments` (201) body `{name, instrument_type?, brand?, model?, department_id?}`; `PATCH /instruments/{id}` same fields all optional + `active`; `InstrumentResponse` gains `department_id: Optional[int]`, `origin: str`. **No senaite fields accepted anywhere (R0).**

- [ ] **Step 1: Failing tests**

```python
def test_create_instrument_local(client, db_session):
    r = client.post("/instruments", json={"name": "Agilent 7900 ICP-MS",
                                          "instrument_type": "ICP-MS",
                                          "senaite_uid": "should-be-ignored"})
    assert r.status_code == 201
    b = r.json()
    assert b["origin"] == "mk1" and b["senaite_id"] is None and b["senaite_uid"] is None


def test_create_instrument_duplicate_name_400(client, db_session):
    client.post("/instruments", json={"name": "KF Titrator V20"})
    assert client.post("/instruments", json={"name": "KF Titrator V20"}).status_code == 400


def test_patch_instrument(client, db_session):
    iid = client.post("/instruments", json={"name": "KF Titrator V30"}).json()["id"]
    r = client.patch(f"/instruments/{iid}", json={"brand": "Mettler Toledo", "active": False})
    assert r.status_code == 200
    assert r.json()["brand"] == "Mettler Toledo" and r.json()["active"] is False
```

- [ ] **Step 2: FAIL (405/404).** **Step 3: Implement**

```python
class InstrumentCreate(BaseModel):
    name: str
    instrument_type: Optional[str] = None
    brand: Optional[str] = None
    model: Optional[str] = None
    department_id: Optional[int] = None


class InstrumentUpdate(BaseModel):
    name: Optional[str] = None
    instrument_type: Optional[str] = None
    brand: Optional[str] = None
    model: Optional[str] = None
    department_id: Optional[int] = None
    active: Optional[bool] = None


@app.post("/instruments", response_model=InstrumentResponse, status_code=201)
async def create_instrument(data: InstrumentCreate, db: Session = Depends(get_db),
                            _current_user=Depends(get_current_user)):
    """Local instrument registration (R0: never carries SENAITE identity)."""
    if db.execute(select(Instrument).where(Instrument.name == data.name)).scalar_one_or_none():
        raise HTTPException(400, f"Instrument named '{data.name}' already exists")
    if data.department_id is not None and not db.get(Department, data.department_id):
        raise HTTPException(400, f"Department {data.department_id} not found")
    inst = Instrument(**data.model_dump())
    db.add(inst)
    db.commit()
    db.refresh(inst)
    return InstrumentResponse.model_validate(inst)


@app.patch("/instruments/{instrument_id}", response_model=InstrumentResponse)
async def update_instrument(instrument_id: int, data: InstrumentUpdate,
                            db: Session = Depends(get_db),
                            _current_user=Depends(get_current_user)):
    inst = db.get(Instrument, instrument_id)
    if not inst:
        raise HTTPException(404, f"Instrument {instrument_id} not found")
    fields = data.model_dump(exclude_unset=True)
    if "name" in fields and fields["name"] != inst.name:
        if db.execute(select(Instrument).where(Instrument.name == fields["name"],
                                               Instrument.id != instrument_id)).scalar_one_or_none():
            raise HTTPException(400, f"Instrument named '{fields['name']}' already exists")
    if fields.get("department_id") is not None and not db.get(Department, fields["department_id"]):
        raise HTTPException(400, f"Department {fields['department_id']} not found")
    for k, v in fields.items():
        setattr(inst, k, v)
    db.commit()
    db.refresh(inst)
    return InstrumentResponse.model_validate(inst)
```

Add `department_id: Optional[int] = None` and `origin: str = "mk1"` to `InstrumentResponse`.

- [ ] **Step 4: PASS.** **Step 5: Commit** — `feat(instruments): local create/edit; department + origin on the wire`.

---

### Task 6: FE api layer

**Files:** Modify `src/lib/api.ts` — `Instrument` (2099), `HplcMethod` (2134), `HplcMethodInput` (2151), method CRUD (2627-2671), instrument CRUD (2371-2391); find the analysis-service record type used by `getAnalysisServices` and add `default_method_id`.
Test: `src/test/methods-api-types.test.ts` is NOT needed — types are compile-checked; the page tests in Tasks 7-8 exercise the functions. This task gates on `npx tsc --noEmit`.

**Interfaces (produced, consumed by Tasks 7-8 and slice 2):**

```ts
export interface MethodServiceLink {
  analysis_service_id: number
  keyword: string | null
  title: string
  is_default: boolean
}
// HplcMethod gains: code, technique, department_id, reference,
// procedure_summary, supersedes_id, origin, services: MethodServiceLink[]
// HplcMethodInput gains: code?, technique?, department_id?, reference?,
// procedure_summary?  — and DROPS senaite_id (R0)
// Instrument gains: department_id: number | null; origin: string
export async function getMethodServices(methodId: number): Promise<MethodServiceLink[]>
export async function putMethodServices(methodId: number,
  links: { analysis_service_id: number; is_default: boolean }[]): Promise<MethodServiceLink[]>
export interface InstrumentInput {
  name: string; instrument_type?: string | null; brand?: string | null
  model?: string | null; department_id?: number | null
}
export async function createInstrument(data: InstrumentInput): Promise<Instrument>
export async function updateInstrument(id: number,
  data: Partial<InstrumentInput & { active: boolean }>): Promise<Instrument>
```

- [ ] **Step 1:** Make the type/function edits following the exact fetch idiom of `createMethod` (error body `err?.detail` narrowing). **Step 2:** `npx tsc --noEmit` → clean. **Step 3: Commit** — `feat(api): method services, local instruments, catalog method fields`.

---

### Task 7: FE MethodsPage + MethodPanel — generic fields + Covered Services

**Files:**
- Modify: `src/components/hplc/MethodsPage.tsx` (AddMethodForm 520-610: drop Senaite ID input, add Code/Technique/Department inputs; table: add a Technique column after Method)
- Modify: `src/components/hplc/MethodPanel.tsx` (edit+detail fields; new Covered Services section; group HPLC params)
- Test: `src/test/methods-catalog-fields.test.tsx` (new)

**Interfaces:** Consumes Task 6 functions. Departments come from the existing `getDepartments()` api fn (used by AnalysisProfilesPage).

- [ ] **Step 1: Failing test** (vi.mock `@/lib/api` — these pages use plain load(), so mock `getMethods`/`getInstruments`/`getDepartments`/`getAnalysisServices`/`getMethodServices`/`putMethodServices`/`createMethod`; mock `sonner`):

```tsx
it('create form offers code/technique/department and no senaite id', async () => {
  const user = userEvent.setup()
  render(<MethodsPage />)
  await user.click(await screen.findByRole('button', { name: /add method/i }))
  expect(screen.getByLabelText(/code/i)).toBeInTheDocument()
  expect(screen.getByLabelText(/technique/i)).toBeInTheDocument()
  expect(screen.getByLabelText(/department/i)).toBeInTheDocument()
  expect(screen.queryByLabelText(/senaite id/i)).not.toBeInTheDocument()
})

it('method panel manages covered services with a default toggle', async () => {
  vi.mocked(getMethodServices).mockResolvedValue([
    { analysis_service_id: 5, keyword: 'LEAD-PPM', title: 'Lead', is_default: true },
  ])
  const user = userEvent.setup()
  render(<MethodsPage />)
  await user.click(await screen.findByText('Elemental Impurities by ICP-MS'))
  expect(await screen.findByText(/covered services/i)).toBeInTheDocument()
  expect(screen.getByText('LEAD-PPM')).toBeInTheDocument()
  expect(screen.getByText(/default/i)).toBeInTheDocument()
})
```

(Seed `getMethods` with one method named `Elemental Impurities by ICP-MS` carrying the new fields.)

- [ ] **Step 2: FAIL.** **Step 3: Implement.**
  - **AddMethodForm:** remove the Senaite ID block (verbatim block at 574-581); add three fields in the same `space-y-2` idiom — Code (`Input`, placeholder `AM-ELEM-001`), Technique (`Input`, placeholder `ICP-MS`), Department (raw `<select>` over `getDepartments()` result, loaded alongside instruments in the form's mount effect). `createMethod({...})` gains `code`, `technique`, `department_id`.
  - **MethodPanel:** add state + Save wiring for `code/technique/reference/procedureSummary/departmentId` mirroring the existing field states; render as `DetailRow`s read-only / `Input`+`Textarea` in edit mode. Wrap the four HPLC params (`size_peptide`, `starting_organic_pct`, `temperature_mct_c`, `dissolution`) under a sub-heading using the house section idiom: `<div className="border-t pt-4"><h4 className="mb-3 text-sm font-semibold text-muted-foreground">HPLC parameters</h4>…</div>`.
  - **Covered Services section** (new, after Assigned Peptides, same `border-t pt-4` idiom): loads `getMethodServices(method.id)` on mount into local state; renders each link as a row `{keyword ?? title}` + `Default` Badge when `is_default` + (edit mode) a per-row Checkbox for default and an `X` remove button; edit-mode add-select over `getAnalysisServices()` filtered to ones not yet linked (mirror the `unassignedPeptides` derivation). Every mutation composes the full link list and calls `putMethodServices(method.id, links)` then reloads + `toast.success('Services updated')`; surface the 400 detail via `toast.error` (default-conflict message from the backend names the other method).
  - **MethodsPage table:** add a `Technique` column rendering `m.technique ?? '—'`.

- [ ] **Step 4: vitest PASS** (`npx vitest run src/test/methods-catalog-fields.test.tsx`). **Step 5: Commit** — `feat(methods-ui): catalog fields + covered-services editor`.

---

### Task 8: FE InstrumentsPage — local add/edit, sync demoted

**Files:** Modify `src/components/hplc/InstrumentsPage.tsx`; Test: `src/test/instruments-page-local.test.tsx` (new).

**Interfaces:** Consumes `createInstrument`/`updateInstrument`/`getDepartments` from Task 6.

- [ ] **Step 1: Failing test**

```tsx
it('offers Add Instrument as the primary action and demotes sync', async () => {
  render(<InstrumentsPage />)
  expect(await screen.findByRole('button', { name: /add instrument/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /legacy/i })).toBeInTheDocument()  // sync relabeled
  expect(screen.queryByText(/synced from senaite lims/i)).not.toBeInTheDocument()
})

it('creates a local instrument', async () => {
  const user = userEvent.setup()
  vi.mocked(createInstrument).mockResolvedValue({ id: 9, name: 'Agilent 7900 ICP-MS' } as never)
  render(<InstrumentsPage />)
  await user.click(await screen.findByRole('button', { name: /add instrument/i }))
  await user.type(screen.getByLabelText(/name/i), 'Agilent 7900 ICP-MS')
  await user.type(screen.getByLabelText(/type/i), 'ICP-MS')
  await user.click(screen.getByRole('button', { name: /^create$/i }))
  await waitFor(() => expect(createInstrument).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Agilent 7900 ICP-MS', instrument_type: 'ICP-MS' })))
})
```

- [ ] **Step 2: FAIL.** **Step 3: Implement.**
  - Header: primary `<Button onClick={() => setShowAddForm(true)}><Plus …/>Add Instrument</Button>`; Sync button becomes `variant="ghost"` labeled `Sync from SENAITE (legacy)`; header subtitle changes from "Lab instruments synced from Senaite LIMS" to "Lab instruments — register and manage locally".
  - `AddInstrumentForm`: clone the `AddMethodForm` card shape (name/type/brand/model/department fields; department is a raw `<select>` over `getDepartments()`); submit → `createInstrument` → `onSaved()` closes + `load()`.
  - `InstrumentPanel`: add an `editing` mode exactly like `MethodPanel` (Edit/Save/Cancel in the header; fields name/type/brand/model/department/active-Checkbox; Save → `updateInstrument(inst.id, {...})` → `onUpdated()`), keep the read-only `DetailRow` grid + add rows for Department and Origin (render `origin === 'senaite' ? 'SENAITE (legacy)' : 'Mk1'`).

- [ ] **Step 4: vitest PASS.** **Step 5: Commit** — `feat(instruments-ui): local add/edit; sync demoted to legacy`.

---

### Task 9: Gates

- [ ] Backend full suite: `... -m pytest -q -p no:cacheprovider -rf 2>&1 | grep -E "^(FAILED|ERROR) tests/" | sort > ../.after_ids.txt` then `diff ../.baseline_ids.txt ../.after_ids.txt` → **empty diff required** (new tests all pass by definition of tasks 1-5).
- [ ] FE: `npx vitest run src/test/methods-catalog-fields.test.tsx src/test/instruments-page-local.test.tsx` → all pass; `npx tsc --noEmit` → clean; `npx eslint <touched files>` → clean; `npx prettier --check <touched files>` → clean (prettier --write the new files first).
- [ ] Commit any stragglers. Do NOT push (controller owns push/PR and the arcitest deploy).

## Recon corrections honored by this plan (vs the spec text)

1. There is no `log_update` in `catalog/change_log.py` — CRUD audit is slice 3 (`apply_and_log`), nothing here pretends otherwise.
2. `MethodResponse.services` requires threading `db` into `_method_to_response` (4 call sites) — Task 3 owns it.
3. The FE methods/instruments pages are plain `load()` pages — no react-query is introduced (spec silent; recon-binding).
