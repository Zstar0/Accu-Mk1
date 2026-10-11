# Endotoxin Worksheet v2 (slices 1 + 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mk1's endotoxin worksheet becomes Dennis's 2 mL tool on a full page (prep, sample dilution, results with reader-export import), with cartridges from a method-linked consumables catalog, without touching analyses or COAs.

**Architecture:** Additive backend: a `consumable_types` catalog with a per-kind spec registry, a draft-only `method_consumables` link and revision-locked `run_parameters` on methods, `instruments.serial_number`, and new nullable worksheet and item columns; endo method resolution is batched and pinned per worksheet at first print or first reading. The 2 mL maths and the reader-file parser are TypeScript ports of Dennis's `calc.js` that run in the browser; the server stores inputs, readings and the reader record, and validates them. A new full-page route renders the three numbered boxes; the endo flyout becomes a read-only summary; stock worksheets render and print exactly as before.

**Tech Stack:** FastAPI + SQLAlchemy 2 (Postgres in prod, SQLite in unit tests), idempotent `_run_migrations` in `backend/database.py`; React + TypeScript + TanStack Query + zustand, vitest + Testing Library; npm only.

**Spec:** `docs/superpowers/specs/2026-10-10-endo-worksheet-v2-design.md` (approved 2026-10-10). Dennis's source of truth: `ValenceAnalytical/tools-dennis` at `5ef2a62`, `tools/endotoxin-log/` (local clone `C:/tmp/tools-dennis`).

## Global Constraints

- Additive only: no existing column, endpoint, component or test changes meaning. Stock worksheets render, print and export byte-identically to today.
- No new writes to `lims_analyses` beyond the existing MCS-tick instrument stamp (the reader import sets Ran through the same `_apply_bench_ticks` path); no results, units or limits reach analyses or a COA; never write `method_id` onto analyses or worksheet items.
- Accu-Mk1 frontend uses npm only (never pnpm). Frontend tests: `npx vitest run <file>`. Backend single files: `cd backend && python -m pytest tests/<file>.py -q` (never bare `python`). The full backend suite runs only inside a stack container, one suite at a time (Task 20).
- No em dashes anywhere: code, strings, tests, comments, commit messages.
- Catalog tables carry no `lims_` prefix (`consumable_types`, `method_consumables`); never name anything `results`.
- New GET routes under `/worksheets/` with a static path segment register before `/worksheets/{worksheet_id}`.
- New endpoints declare pydantic request and response models.
- Every new user-facing colour has a dark-mode variant.
- Allowed cartridges and run parameters change only on draft methods (409 otherwise).
- Cartridge `kind` and `specs` lock once any worksheet or item references the type (409); types are retired, never deleted.
- The worksheet's endo method is resolved in a fixed number of queries, only on `GET /worksheets/{id}`, the item PATCH response and the reader-import response; never on list endpoints, never per item.
- Reader-export test data is Dennis's made-up export only; real results never enter git.
- Commits are pathspec commits on `feat/endo-worksheet-v2`: `git commit -m "<type>(endo-v2): <summary>" -- <paths>`, message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Working limits in this release are Dennis's (350 EU per vial, 0.25 EU/mL), labelled "not yet the COA spec"; the COA spec is untouched.

## Review Focus

The inputs and conditions the spec implies that are most likely to bite a person using this, each pinned by a test in its owning task:

1. **Reader export variants** (UTF-8 BOM, CRLF line endings, trailing blank lines, padded cells) must parse to the same tests as the clean file; a non-EndoScan CSV must fail with a readable message, not a stack trace. Task 9.
2. **Reading text as people type it** (`< 0.05`, ` 0.8 `) must be accepted; `0,8`, `-1`, `<0`, `abc` must be refused with a clear message on both sides. Tasks 6 and 8.
3. **A worksheet completed by someone else while an import is in flight** must return 409 and change no row. Task 7.
4. **A retired cartridge that historical rows used** must still serialize with its sensitivity and still compute, while disappearing from pickers. Tasks 2, 5 and 13.
5. **A vial that was retested** (a retracted endo analysis plus a current retest row) must resolve its method and match reader tests through the current row. Task 5.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `backend/models.py` | New tables and columns | 1 |
| `backend/database.py` | Idempotent migrations and the one-time 2 mL switch | 1 |
| `backend/scripts/backfill_endo_worksheets.py` | Historical worksheets created as `stock` | 1 |
| `backend/catalog/consumables.py` (new) | Kind registry, spec validation, in-use check | 2 |
| `backend/catalog/method_run_params.py` (new) | Run-parameter defaults and validation | 3 |
| `backend/main.py` | Consumables, method, instrument and worksheet endpoints | 2 to 7 |
| `backend/worksheets_endo.py` (new) | Reading parse, step validation, method resolution and pinning, serial lookup | 5 |
| `backend/tests/test_endo_v2_*.py` (new) | Backend tests per task | 1 to 7 |
| `src/lib/endo-prep-2ml.ts` (new) | 2 mL maths port | 8 |
| `src/lib/endo-reader.ts` (new) | EndoScan-V parse, match, validity, record | 9 |
| `src/lib/api.ts`, `src/hooks/use-worksheet-drawer.ts` | API client, types, optimistic merge | 10 |
| `src/components/hplc/ConsumablesPage.tsx` (new) + nav files | Consumables admin | 11 |
| `src/components/hplc/MethodConsumablesSection.tsx`, `MethodRunParamsSection.tsx` (new), `MethodPanel.tsx`, `InstrumentsPage.tsx` | Method sections, instrument serial | 12 |
| `src/lib/endo-worksheet-2ml.ts` (new), `src/components/hplc/endo/EndoWorksheetPage.tsx`, `EndoRunHeader.tsx` (new), `EndoWorksheetTable.tsx`, `ui-store.ts`, `hash-navigation.ts` | Page route, glue, header, Box 1 | 13 |
| `src/components/hplc/endo/EndoSampleDilutionBox.tsx` (new) | Box 2 | 14 |
| `src/components/hplc/endo/EndoResultsBox.tsx`, `EndoReadingInput.tsx` (new) | Box 3 | 15 |
| `src/components/hplc/endo/EndoReaderImportDialog.tsx` (new) | Reader import UI | 16 |
| `src/components/hplc/endo/EndoFlyoutSummary.tsx` (new), `WorksheetDrawer.tsx`, `EndoPrepLine.tsx` | Read-only flyout, mixed line | 17 |
| `src/lib/endo-bench-sheet-2ml.ts` (new), `EndoWorksheetActions.tsx` | 2 mL paper and CSV | 18 |
| `src/components/hplc/ServiceEndoJudgedPanel.tsx` (new), `AnalysisServicesPage.tsx` | Service panel | 19 |

## Task order and dependencies

Tasks 1 to 7 (backend) run in order. Tasks 8 and 9 (pure TypeScript) can run any time. Task 10 needs Tasks 1 to 7's payload shapes. Tasks 11 and 12 need 10. Task 13 needs 8, 10. Tasks 14 to 17 need 13 (16 also needs 9). Task 18 needs 8 and 13. Task 19 needs 10. Task 20 runs last.

## Execution conventions

- Every command block assumes the shell starts at the repo root `C:/tmp/Accu-Mk1-endo-v2`. Backend tests: `cd backend && python -m pytest tests/<file>.py -q`. Frontend tests: `npx vitest run <file>`. Commit blocks use `git -C /c/tmp/Accu-Mk1-endo-v2` (or run from the root) so a persisted `cd backend` cannot break pathspecs.
- `node_modules` is not installed in the worktree: run `npm ci` once before the first frontend test step.
- A new file must be `git add`ed before its pathspec commit, or `git commit -- <path>` fails with "did not match any file(s) known to git". Files in this worktree are LF (`git ls-files --eol` shows `i/lf w/lf`); check `git diff --stat -- <paths>` shows small diffs before committing (Accu-Mk1's local `core.autocrlf=false` can turn a CRLF rewrite into a whole-file diff).
- Tasks 1 to 4 and Task 8 and 9 code was run while drafting (backend snippets in a scratch copy of `backend/` on SQLAlchemy 2.0.35, FastAPI 0.115.0, pydantic 2.9.0, the migration test on a throwaway Postgres 16; the TypeScript ports under the repo's own vitest, tsc, eslint and prettier settings, 29 of 29 passing). Tasks 5 to 7 and 10 to 19 were drafted against the real code but not run: treat their quoted PASS/FAIL outputs as expectations and fix forward with a test first if one differs.
- Frontend lint runs with `--max-warnings 0`: no non-null assertions, `noUncheckedIndexedAccess` is on (guard every index read), and helpers that are not components live in `src/lib/*.ts` (`react-refresh/only-export-components`).
- Appendix A lists every place a draft departed from the shared contract and how it was reconciled; read it before starting a task that consumes another task's names.

---

### Task 1: Schema foundation (models, migration, one-time 2 mL switch, backfill writes stock)

**Files:**
- Modify: `backend/models.py`:
  - `class Instrument`: `__table_args__` with the serial index, plus `serial_number`.
  - `class HplcMethod`: `run_parameters`.
  - New `class ConsumableType`, its part-number `Index`, and the `method_consumables` table, inserted after `class HplcMethod`.
  - `class Worksheet`: three columns.
  - `class WorksheetItem`: nine columns.
- Modify: `backend/database.py`: new `_ENDO_V2_DDL` and `_run_endo_v2_migrations(bind)`, called from `init_db` after `_ensure_documents_space_column(engine)`.
- Modify: `backend/main.py`: `delete_method` returns 409 when a worksheet pins the method.
- Modify: `backend/scripts/backfill_endo_worksheets.py`: `run_backfill` builds each `Worksheet(...)` with `endo_prep="stock"`.
- Test (create): `backend/tests/test_endo_v2_schema.py`
- Test (create): `backend/tests/test_endo_v2_migration_pg.py`
- Test (modify): `backend/tests/test_backfill_endo_worksheets.py`

**Interfaces:**
- Consumes:
  - `database.Base`
  - `scheduled_publish.DEFAULT_TZ`
  - table `business_hours_config` (the source `scheduled_publish.lab_tz` reads)
- Produces:
  - `models.ConsumableType` (table `consumable_types`)
  - `models.method_consumables` (Table; PK `(method_id, consumable_type_id)`; columns `kind`, `is_default`)
  - `HplcMethod.run_parameters: Mapped[Optional[dict]]`
  - `Instrument.serial_number: Mapped[Optional[str]]`
  - `Worksheet.endo_prep` (ORM default `"2ml"`), `Worksheet.cartridge_type_id`, `Worksheet.endo_method_id`
  - `WorksheetItem.prep_form`, `.prep_water_ml`, `.prep_total_dilution`, `.prep_steps`, `.cartridge_type_id`, `.result_reading`, `.result_reader`, `.result_entered_at`, `.result_entered_by_user_id`
  - `database._run_endo_v2_migrations(bind) -> None`
  - Index names `uq_consumable_types_kind_name`, `uq_consumable_types_part_number`, `uq_method_consumable_default`, `uq_instruments_serial_number`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_endo_v2_schema.py`:

```python
"""Endo worksheet v2 schema (spec 2026-10-10 section 3). In-memory SQLite +
dependency overrides, the test_worksheet_endo_prep.py idiom. The Postgres
migration itself is covered by test_endo_v2_migration_pg.py."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from database import Base, get_db
from models import ConsumableType, HplcMethod, Instrument, Worksheet, method_consumables


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _cols(db, table):
    return {c["name"] for c in inspect(db.get_bind()).get_columns(table)}


def test_new_tables_and_columns_exist(db):
    assert {"id", "kind", "name", "manufacturer", "part_number", "instrument_id", "specs",
            "active", "origin", "created_at", "updated_at"} <= _cols(db, "consumable_types")
    assert _cols(db, "method_consumables") == {"method_id", "consumable_type_id", "kind", "is_default"}
    assert "run_parameters" in _cols(db, "hplc_methods")
    assert "serial_number" in _cols(db, "instruments")
    assert {"endo_prep", "cartridge_type_id", "endo_method_id"} <= _cols(db, "worksheets")
    assert {"prep_form", "prep_water_ml", "prep_total_dilution", "prep_steps", "cartridge_type_id",
            "result_reading", "result_reader", "result_entered_at",
            "result_entered_by_user_id"} <= _cols(db, "worksheet_items")


def test_new_worksheet_defaults_to_2ml(db):
    ws = Worksheet(title="Endo 10/10/2026", status="open")
    db.add(ws)
    db.commit()
    db.refresh(ws)
    assert ws.endo_prep == "2ml"


def test_new_consumable_type_defaults(db):
    t = ConsumableType(kind="endo_cartridge", name="Endosafe 0.05")
    db.add(t)
    db.commit()
    db.refresh(t)
    assert (t.specs, t.active, t.origin) == ({}, True, "mk1")


def test_duplicate_instrument_serial_rejected_by_index(db):
    db.add_all([Instrument(name="MCS A", serial_number="SN-1"), Instrument(name="MCS B", serial_number=None),
                Instrument(name="MCS C", serial_number=None)])
    db.commit()  # two NULL serials are fine
    db.add(Instrument(name="MCS D", serial_number="SN-1"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_part_number_unique_per_manufacturer_by_index(db):
    db.add_all([
        ConsumableType(kind="endo_cartridge", name="A", manufacturer="CR", part_number="PTS2005"),
        ConsumableType(kind="endo_cartridge", name="B", manufacturer="Other", part_number="PTS2005"),
        ConsumableType(kind="endo_cartridge", name="C", part_number="X1"),
    ])
    db.commit()
    db.add(ConsumableType(kind="endo_cartridge", name="D", manufacturer=None, part_number="X1"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_one_default_per_method_per_kind_by_index(db):
    m = HplcMethod(name="Endotoxin", status="draft", active=False)
    a = ConsumableType(kind="endo_cartridge", name="A")
    b = ConsumableType(kind="endo_cartridge", name="B")
    db.add_all([m, a, b])
    db.flush()
    db.execute(method_consumables.insert().values(
        method_id=m.id, consumable_type_id=a.id, kind="endo_cartridge", is_default=True))
    with pytest.raises(IntegrityError):
        db.execute(method_consumables.insert().values(
            method_id=m.id, consumable_type_id=b.id, kind="endo_cartridge", is_default=True))
    db.rollback()


def test_delete_method_pinned_by_a_worksheet_is_refused(client, db):
    m = HplcMethod(name="Endotoxin", status="active", active=True)
    db.add(m)
    db.flush()
    db.add(Worksheet(title="Endo 10/10/2026", status="open", endo_method_id=m.id))
    db.commit()
    r = client.delete(f"/hplc/methods/{m.id}")
    assert r.status_code == 409, r.text
    assert "pinned" in r.json()["detail"]
    assert db.get(HplcMethod, m.id) is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_endo_v2_schema.py -q`
Expected: collection error `ImportError: cannot import name 'ConsumableType' from 'models'`.

- [ ] **Step 3: Implement the models**

In `backend/models.py`, `class Instrument`, insert directly after `__tablename__ = "instruments"`:

```python
    __table_args__ = (
        # Endo worksheet v2 (spec 2026-10-10 section 3.5): unique among rows that have one.
        Index("uq_instruments_serial_number", "serial_number", unique=True,
              postgresql_where=text("serial_number IS NOT NULL"),
              sqlite_where=text("serial_number IS NOT NULL")),
    )
```

In `class Instrument`, insert after the `origin` column (just above `# Relationships`):

```python
    # Endo worksheet v2: the reader import stamps the instrument by this serial.
    serial_number: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
```

In `class HplcMethod`, insert after `retired_at` (just above `# Relationships`):

```python
    # Endo worksheet v2 (spec 2026-10-10 section 3.4): revision-locked run
    # parameters keyed by block, e.g. {"endotoxin": {"std_total_dilution": 250}}.
    # Validated by catalog/method_run_params.py; a missing key means Dennis's value.
    run_parameters: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
```

Insert directly after `class HplcMethod` ends (after its `__repr__`, before `class MethodAttachment`):

```python
class ConsumableType(Base):
    """A kind of consumable the lab buys, e.g. an endotoxin cartridge (endo
    worksheet v2, spec 2026-10-10 section 3.1). `kind` is a key of
    catalog/consumables.py CONSUMABLE_KINDS and `specs` holds that kind's
    numbers. Retired with active=False, never deleted. Once a worksheet or a
    worksheet item references a type, its kind and specs are locked."""
    __tablename__ = "consumable_types"
    __table_args__ = (UniqueConstraint("kind", "name", name="uq_consumable_types_kind_name"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    manufacturer: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    part_number: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    instrument_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("instruments.id", ondelete="SET NULL"), nullable=True)
    specs: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict,
                                        server_default=text("'{}'"))
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True,
                                         server_default=text("true"))
    origin: Mapped[str] = mapped_column(String(20), nullable=False, default="mk1",
                                        server_default="mk1")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<ConsumableType(id={self.id}, kind='{self.kind}', name='{self.name}')>"


# A part number is unique per manufacturer; no manufacturer counts as ''.
# Declared after the class because an expression index needs the columns.
Index("uq_consumable_types_part_number",
      func.coalesce(ConsumableType.manufacturer, ""), ConsumableType.part_number,
      unique=True,
      postgresql_where=ConsumableType.part_number.is_not(None),
      sqlite_where=ConsumableType.part_number.is_not(None))


# M2M junction: method <-> consumable type (spec 2026-10-10 section 3.3).
# kind is copied from the type so "one default per method per kind" is an
# index. Edited on draft methods only; new-revision copies every row WITH
# is_default (the default belongs to one method, so it cannot clash).
method_consumables = Table(
    "method_consumables",
    Base.metadata,
    Column("method_id", Integer, ForeignKey("hplc_methods.id", ondelete="CASCADE"), primary_key=True),
    Column("consumable_type_id", Integer, ForeignKey("consumable_types.id"), primary_key=True),
    Column("kind", String(40), nullable=False),
    Column("is_default", Boolean, nullable=False, default=False, server_default=text("false")),
    Index("uq_method_consumable_default", "method_id", "kind", unique=True,
          postgresql_where=text("is_default"), sqlite_where=text("is_default")),
)
```

In `class Worksheet`, insert after `updated_at` (just above its `__repr__`):

```python
    # Endo worksheet v2 (spec 2026-10-10 section 3.6). endo_prep picks the prep
    # maths per worksheet: '2ml' (Dennis's 2 mL prep, the default for new rows)
    # or 'stock' (the 1 mg/mL stock maths). Non-endo worksheets carry it
    # harmlessly. No server_default here on purpose: database.
    # _run_endo_v2_migrations adds the column bare, switches existing rows once,
    # and only then sets the DB default (spec 3.8).
    endo_prep: Mapped[Optional[str]] = mapped_column(String(10), nullable=True, default="2ml")
    # The run's cartridge, and the method revision pinned at first print or
    # first reading. Plain FKs: a used type or a pinned method must not vanish.
    cartridge_type_id: Mapped[Optional[int]] = mapped_column(ForeignKey("consumable_types.id"), nullable=True)
    endo_method_id: Mapped[Optional[int]] = mapped_column(ForeignKey("hplc_methods.id"), nullable=True)
```

In `class WorksheetItem`, insert after `well_pos` (just above its `__repr__`):

```python
    # Endo worksheet v2 (spec 2026-10-10 section 3.7), read on 2 mL worksheets
    # only. NULL means "worked out from the sample" or "the method's standard".
    # prep_volume_ml above keeps its stock meaning.
    prep_form: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)  # powder | liquid | bac
    prep_water_ml: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    prep_total_dilution: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # [[sample_ul, ratio] or null, [sample_ul] or null, [sample_ul] or null]
    prep_steps: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    cartridge_type_id: Mapped[Optional[int]] = mapped_column(ForeignKey("consumable_types.id"), nullable=True)
    # The reading exactly as the instrument shows it ("<0.05", "0.8", "0"),
    # the reader's record for the test, and who entered it when.
    result_reading: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    result_reader: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    result_entered_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    result_entered_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
```

`models.py` already imports `Index`, `Table`, `Column`, `UniqueConstraint`, `JSON`, `func` and `text`, so no import changes are needed.

- [ ] **Step 4: Run test to verify the model tests pass and the delete guard fails**

Run: `cd backend && python -m pytest tests/test_endo_v2_schema.py -q`
Expected: `1 failed, 6 passed`. The failure is `test_delete_method_pinned_by_a_worksheet_is_refused` with `assert 200 == 409` (`{"message":"Method 'Endotoxin' deleted"}`).

- [ ] **Step 5: Implement the delete guard**

In `backend/main.py`, `delete_method`, insert directly above `    db.delete(method)`:

```python
    # Endo worksheet v2: a pinned revision is the record a worksheet's results
    # were computed with (spec 2026-10-10 section 4.1); the FK is a plain one.
    pinned = db.execute(select(func.count()).select_from(Worksheet)
                        .where(Worksheet.endo_method_id == method_id)).scalar()
    if pinned:
        raise HTTPException(
            409, f"Method '{method.name}' is pinned by {pinned} worksheet(s) and is part "
                 f"of their results record. Retire it instead of deleting")
```

(`Worksheet`, `select` and `func` are already imported at the top of `main.py`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_endo_v2_schema.py -q`
Expected: `7 passed`.

- [ ] **Step 7: Write the failing backfill test**

Append to `backend/tests/test_backfill_endo_worksheets.py`:

```python


def test_backfilled_worksheets_are_stock(db_session):
    # Spec 2026-10-10 section 3.8: these runs were prepped the old way, and the
    # endo_prep column default ('2ml') would otherwise give them 2 mL maths.
    _seed(db_session)
    run_backfill(db_session, [_run()], apply=True, today=date(2026, 9, 18))
    ws = db_session.execute(select(Worksheet).where(Worksheet.title == "Endo 09/11/2026 #3")).scalar_one()
    assert ws.endo_prep == "stock"
```

- [ ] **Step 8: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_backfill_endo_worksheets.py -q`
Expected: `1 failed, 6 passed`, with `AssertionError: assert '2ml' == 'stock'` in `test_backfilled_worksheets_are_stock`.

- [ ] **Step 9: Implement the backfill change**

In `backend/scripts/backfill_endo_worksheets.py`, `run_backfill`, in the `ws = Worksheet(` call, insert directly after `status=entry["status"],`:

```python
                    # Prepped the old way: without this the column default
                    # would give these runs 2 mL maths (spec 2026-10-10 3.8).
                    endo_prep="stock",
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_backfill_endo_worksheets.py -q`
Expected: `7 passed`.

- [ ] **Step 11: Write the failing Postgres migration test**

Create `backend/tests/test_endo_v2_migration_pg.py`:

```python
"""Endo worksheet v2 migration on Postgres (spec 2026-10-10 section 3.8).

The switch uses Postgres-only SQL (AT TIME ZONE, ALTER COLUMN SET DEFAULT), so
this file runs only when MK1_TEST_POSTGRES_URL names a Postgres it may write to,
and skips everywhere else. Inside the stack container (Task 20):

    MK1_TEST_POSTGRES_URL="postgresql+psycopg2://$MK1_DB_USER:$MK1_DB_PASSWORD@$MK1_DB_HOST:$MK1_DB_PORT/$MK1_DB_NAME" \\
        python -m pytest tests/test_endo_v2_migration_pg.py -q

Everything runs in a throwaway schema that is dropped afterwards, never in the
database's own tables (test_per_substance_reconciler.py's SessionLocal idiom
would rewrite real worksheets).
"""
import os
from datetime import datetime

import pytest
from sqlalchemy import create_engine, inspect, text

import models  # noqa: F401  (register the tables on Base, as init_db does)
import flags.models  # noqa: F401
import documents.models  # noqa: F401
import groups.models  # noqa: F401
import boards.models  # noqa: F401
from database import Base, _run_endo_v2_migrations

URL = os.environ.get("MK1_TEST_POSTGRES_URL")
SCHEMA = "endo_v2_migration_test"

pytestmark = pytest.mark.skipif(not URL, reason="set MK1_TEST_POSTGRES_URL to run the Postgres migration test")

NEW_ITEM_COLUMNS = ("prep_form", "prep_water_ml", "prep_total_dilution", "prep_steps", "cartridge_type_id",
                    "result_reading", "result_reader", "result_entered_at", "result_entered_by_user_id")


@pytest.fixture
def pg():
    admin = create_engine(URL)
    with admin.begin() as c:
        c.execute(text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        c.execute(text(f"CREATE SCHEMA {SCHEMA}"))
    engine = create_engine(URL, connect_args={"options": f"-csearch_path={SCHEMA}"})
    try:
        Base.metadata.create_all(engine)
        # create_all builds the old tables WITH the new columns; drop them to get
        # the shape a deployed database has before this release (create_all never
        # alters an existing table, which is why the migration exists).
        with engine.begin() as c:
            c.execute(text("ALTER TABLE worksheets DROP COLUMN endo_prep, "
                           "DROP COLUMN cartridge_type_id, DROP COLUMN endo_method_id"))
            c.execute(text("ALTER TABLE worksheet_items "
                           + ", ".join(f"DROP COLUMN {col}" for col in NEW_ITEM_COLUMNS)))
            c.execute(text("ALTER TABLE instruments DROP COLUMN serial_number"))
            c.execute(text("ALTER TABLE hplc_methods DROP COLUMN run_parameters"))
            c.execute(text("INSERT INTO business_hours_config (id, open_time, close_time, timezone, working_days, "
                           "created_at, updated_at) "
                           "VALUES (1, '09:00', '17:00', 'America/Los_Angeles', '[0, 1, 2, 3, 4]', NOW(), NOW())"))
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as c:
            c.execute(text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        admin.dispose()


def _ws(conn, title, status, created_at):
    return conn.execute(text(
        "INSERT INTO worksheets (title, status, created_at, updated_at) "
        "VALUES (:t, :s, :c, :c) RETURNING id"), {"t": title, "s": status, "c": created_at}).scalar()


def _preps(engine):
    with engine.connect() as c:
        return dict(c.execute(text("SELECT title, endo_prep FROM worksheets")).all())


def test_switch_runs_once_in_lab_time_and_never_reflips(pg):
    with pg.begin() as c:
        # Naive UTC, as the app stores it. 08:00 UTC on 10-08 is 01:00 on 10-08 in
        # Los Angeles; 05:00 UTC on 10-08 is still 10-07 there.
        _ws(c, "open-1008-lab", "open", datetime(2026, 10, 8, 8, 0))
        _ws(c, "open-1007-lab", "open", datetime(2026, 10, 8, 5, 0))
        _ws(c, "staging-1009", "staging", datetime(2026, 10, 9, 12, 0))
        _ws(c, "completed-1009", "completed", datetime(2026, 10, 9, 12, 0))
        _ws(c, "open-0930", "open", datetime(2026, 9, 30, 12, 0))

    _run_endo_v2_migrations(pg)

    assert _preps(pg) == {
        "open-1008-lab": "2ml",
        "open-1007-lab": "stock",
        "staging-1009": "2ml",
        "completed-1009": "stock",
        "open-0930": "stock",
    }
    insp = inspect(pg)
    assert set(NEW_ITEM_COLUMNS) <= {col["name"] for col in insp.get_columns("worksheet_items")}
    assert "serial_number" in {col["name"] for col in insp.get_columns("instruments")}
    assert "run_parameters" in {col["name"] for col in insp.get_columns("hplc_methods")}
    with pg.connect() as c:
        indexes = set(c.execute(text("SELECT indexname FROM pg_indexes WHERE schemaname = :s"),
                                {"s": SCHEMA}).scalars())
    assert {"uq_instruments_serial_number", "uq_consumable_types_part_number",
            "uq_method_consumable_default"} <= indexes

    # The lab switches one worksheet back to stock; a new worksheet takes the default.
    with pg.begin() as c:
        c.execute(text("UPDATE worksheets SET endo_prep = 'stock' WHERE title = 'open-1008-lab'"))
        _ws(c, "new-after-release", "open", datetime(2026, 10, 12, 16, 0))

    _run_endo_v2_migrations(pg)   # the next boot

    assert _preps(pg) == {
        "open-1008-lab": "stock",
        "open-1007-lab": "stock",
        "staging-1009": "2ml",
        "completed-1009": "stock",
        "open-0930": "stock",
        "new-after-release": "2ml",
    }
```

- [ ] **Step 12: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_endo_v2_migration_pg.py -q`
Expected: collection error `ImportError: cannot import name '_run_endo_v2_migrations' from 'database'`. The module-level import runs even when the env var is unset.

- [ ] **Step 13: Implement the migration**

In `backend/database.py`, insert directly above `def init_db():`:

```python
# Endo worksheet v2 (spec 2026-10-10 section 3.8), steps 1 and 2. The new
# tables come from create_all; their partial indexes are repeated here so a
# table create_all built before an index was declared still gets it. Columns
# are added WITHOUT defaults: a default here would fill every existing
# worksheet with '2ml'.
_ENDO_V2_DDL = (
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_consumable_types_part_number "
    "ON consumable_types (coalesce(manufacturer, ''), part_number) WHERE part_number IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_method_consumable_default "
    "ON method_consumables (method_id, kind) WHERE is_default",
    "ALTER TABLE hplc_methods ADD COLUMN IF NOT EXISTS run_parameters JSON",
    "ALTER TABLE instruments ADD COLUMN IF NOT EXISTS serial_number VARCHAR(100)",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_instruments_serial_number "
    "ON instruments (serial_number) WHERE serial_number IS NOT NULL",
    "ALTER TABLE worksheets ADD COLUMN IF NOT EXISTS endo_prep VARCHAR(10)",
    "ALTER TABLE worksheets ADD COLUMN IF NOT EXISTS cartridge_type_id INTEGER REFERENCES consumable_types(id)",
    "ALTER TABLE worksheets ADD COLUMN IF NOT EXISTS endo_method_id INTEGER REFERENCES hplc_methods(id)",
    "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS prep_form VARCHAR(10)",
    "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS prep_water_ml FLOAT",
    "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS prep_total_dilution FLOAT",
    "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS prep_steps JSON",
    "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS cartridge_type_id INTEGER REFERENCES consumable_types(id)",
    "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS result_reading VARCHAR(40)",
    "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS result_reader JSON",
    "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS result_entered_at TIMESTAMP",
    "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS result_entered_by_user_id INTEGER "
    "REFERENCES users(id) ON DELETE SET NULL",
)


def _run_endo_v2_migrations(bind) -> None:
    """Endo worksheet v2 schema (spec 2026-10-10 section 3.8). Runs AFTER
    create_all: the new FK columns reference consumable_types, which create_all
    builds (the _ensure_documents_space_column precedent). One transaction, so
    the 2 mL switch is all or nothing. A failure raises: the ORM maps every
    column added here.

    Step 3, the one-time switch, is guarded on endo_prep IS NULL: open and
    staging worksheets made on or after the lab date 2026-10-08 go to '2ml',
    every other row to 'stock'. Step 4 sets the '2ml' default last. After the
    first boot no row is NULL, so later boots change nothing and a worksheet
    switched back to stock stays there. SQLite test fixtures get everything
    from create_all, so this is Postgres-only."""
    if bind.dialect.name != "postgresql":
        return
    from sqlalchemy import text
    from scheduled_publish import DEFAULT_TZ
    with bind.begin() as conn:
        for sql in _ENDO_V2_DDL:
            conn.execute(text(sql))
        # The lab time zone, as scheduled_publish.lab_tz reads it.
        lab_tz = conn.execute(text(
            "SELECT timezone FROM business_hours_config WHERE id = 1")).scalar() or DEFAULT_TZ
        conn.execute(text(
            "UPDATE worksheets SET endo_prep = '2ml' "
            "WHERE endo_prep IS NULL AND status <> 'completed' "
            "AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE :lab_tz)::date >= DATE '2026-10-08'"),
            {"lab_tz": lab_tz})
        conn.execute(text("UPDATE worksheets SET endo_prep = 'stock' WHERE endo_prep IS NULL"))
        conn.execute(text("ALTER TABLE worksheets ALTER COLUMN endo_prep SET DEFAULT '2ml'"))
```

In `init_db`, insert directly after the line `    _ensure_documents_space_column(engine)`:

```python
    # Endo worksheet v2: new columns, partial indexes and the one-time 2 mL
    # switch, after create_all and before any seed reads these tables.
    _run_endo_v2_migrations(engine)
```

- [ ] **Step 14: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_endo_v2_migration_pg.py -q`
Expected without the env var: `1 skipped`.

Optional local check (Bash syntax) against a throwaway container, using the already-pulled `postgres:16-alpine` image:

```bash
docker run --rm -d --name endo-v2-pgtest -e POSTGRES_PASSWORD=test -p 127.0.0.1:55499:5432 postgres:16-alpine
cd backend && MK1_TEST_POSTGRES_URL="postgresql+psycopg2://postgres:test@127.0.0.1:55499/postgres" python -m pytest tests/test_endo_v2_migration_pg.py -q
docker rm -f endo-v2-pgtest
```

Expected with the env var: `1 passed`. Task 20 runs it with the env var inside the stack container.

- [ ] **Step 15: Run the neighbouring suites (no regressions)**

Run: `cd backend && python -m pytest tests/test_endo_v2_schema.py tests/test_backfill_endo_worksheets.py tests/test_worksheet_endo_prep.py tests/test_methods_lifecycle.py tests/test_methods_catalog.py -q`
Expected: all pass, with no failures.

- [ ] **Step 16: Commit**

```bash
git -C /c/tmp/Accu-Mk1-endo-v2 add backend/tests/test_endo_v2_schema.py backend/tests/test_endo_v2_migration_pg.py
git -C /c/tmp/Accu-Mk1-endo-v2 commit -m "feat(endo-v2): schema foundation, one-time 2 mL switch, backfill writes stock" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/models.py backend/database.py backend/main.py backend/scripts/backfill_endo_worksheets.py backend/tests/test_endo_v2_schema.py backend/tests/test_endo_v2_migration_pg.py backend/tests/test_backfill_endo_worksheets.py
```

---

### Task 2: Consumables catalog API, kind registry, lock on use

**Files:**
- Create: `backend/catalog/consumables.py`
- Modify: `backend/main.py`:
  - Add the import line `from models import ConsumableType` after the long `from models import ...` line.
  - Add the new section `Consumables catalog`, with pydantic models, helpers `_blank_to_none`, `_consumable_out` and `_consumable_conflict`, and routes `list_consumable_kinds`, `list_consumables`, `create_consumable` and `update_consumable`. It goes after `update_instrument` and before the `Analysis Service Endpoints` section comment.
- Modify: `backend/tests/test_catalog_change_log_guard.py`: add `create_consumable` and `update_consumable` to `WIRED_FUNCTIONS`.
- Test (create): `backend/tests/test_consumables_api.py`

**Interfaces:**
- Consumes (Task 1):
  - `models.ConsumableType`
  - `Worksheet.cartridge_type_id`
  - `WorksheetItem.cartridge_type_id`
- Consumes (existing): `catalog.change_log.log_create`, `catalog.change_log.apply_and_log`.
- Produces in `backend/catalog/consumables.py`:
  - `CONSUMABLE_KINDS: dict[str, dict]`
  - `class ConsumableSpecError(ValueError)`
  - `validate_specs(kind: str, specs: dict) -> dict`
  - `consumable_in_use(db, type_id: int) -> bool`
  - `used_type_ids(db) -> set[int]`
  - `CONSUMABLE_LOG_FIELDS`
  - `kinds_payload() -> list[dict]`
- Produces in `main.py`: `_blank_to_none(value: Optional[str]) -> Optional[str]`, reused by Task 4.
- Produces endpoints:
  - `GET /consumables/kinds` returns `list[ConsumableKindOut]`.
  - `GET /consumables` (`?kind=`, `?active=`) returns `list[ConsumableTypeResponse]`.
  - `POST /consumables` returns 201 and `ConsumableTypeResponse`.
  - `PATCH /consumables/{type_id}` returns `ConsumableTypeResponse`.
- Response fields:
  - `ConsumableTypeResponse`: `id, kind, name, manufacturer, part_number, instrument_id, specs, active, origin, in_use, created_at, updated_at`.
  - `ConsumableKindOut`: `{key, label, specs: [{key, label, unit, type, required}]}`.
- Catalog log entity type: `"consumable_type"`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_consumables_api.py`:

```python
"""Consumables catalog API (endo worksheet v2, spec 2026-10-10 sections 3.1,
3.2, 9 and 10). In-memory SQLite + dependency overrides, the
test_worksheet_endo_prep.py idiom."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from catalog.consumables import ConsumableSpecError, validate_specs
from database import Base, get_db
from models import CatalogChangeLog, Instrument, Worksheet, WorksheetItem

CART = {"kind": "endo_cartridge", "name": "Endosafe 0.05", "manufacturer": "Charles River",
        "part_number": "PTS2005", "specs": {"sensitivity_eu_ml": 0.05}}


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _create(client, **over):
    r = client.post("/consumables", json={**CART, **over})
    assert r.status_code == 201, r.text
    return r.json()


def _use_on_worksheet(db, type_id):
    ws = Worksheet(title="Endo 10/10/2026", status="open", cartridge_type_id=type_id)
    db.add(ws)
    db.commit()
    return ws


def _use_on_item(db, type_id):
    ws = Worksheet(title="Endo 10/11/2026", status="open")
    db.add(ws)
    db.flush()
    db.add(WorksheetItem(worksheet_id=ws.id, sample_uid="mk1://v1", sample_id="P-1-S02",
                         cartridge_type_id=type_id))
    db.commit()


def _logs(db, type_id):
    return db.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "consumable_type",
        CatalogChangeLog.entity_pk == type_id).order_by(CatalogChangeLog.id)).scalars().all()


# --- registry ---------------------------------------------------------------


def test_kinds_endpoint_serves_the_registry(client):
    r = client.get("/consumables/kinds")
    assert r.status_code == 200
    assert r.json() == [{
        "key": "endo_cartridge", "label": "Endotoxin cartridge",
        "specs": [{"key": "sensitivity_eu_ml", "label": "Sensitivity", "unit": "EU/mL",
                   "type": "positive_float", "required": True}],
    }]


@pytest.mark.parametrize("specs", [
    {}, {"sensitivity_eu_ml": None}, {"sensitivity_eu_ml": 0}, {"sensitivity_eu_ml": -0.05},
    {"sensitivity_eu_ml": True}, {"sensitivity_eu_ml": "0.05"}, {"sensitivity_eu_ml": float("nan")},
    {"sensitivity_eu_ml": float("inf")}, {"sensitivity_eu_ml": 0.05, "lot": 7}, [0.05],
])
def test_validate_specs_rejects(specs):
    with pytest.raises(ConsumableSpecError):
        validate_specs("endo_cartridge", specs)


def test_validate_specs_rejects_unknown_kind_and_returns_floats():
    with pytest.raises(ConsumableSpecError, match="unknown kind"):
        validate_specs("pipette_tip", {})
    assert validate_specs("endo_cartridge", {"sensitivity_eu_ml": 1}) == {"sensitivity_eu_ml": 1.0}


# --- create -----------------------------------------------------------------


def test_create_returns_the_row_and_logs_it(client, db):
    inst = Instrument(name="Nexgen-MCS")
    db.add(inst)
    db.commit()
    body = _create(client, instrument_id=inst.id)
    assert {k: body[k] for k in ("kind", "name", "manufacturer", "part_number", "instrument_id",
                                 "specs", "active", "origin", "in_use")} == {
        "kind": "endo_cartridge", "name": "Endosafe 0.05", "manufacturer": "Charles River",
        "part_number": "PTS2005", "instrument_id": inst.id, "specs": {"sensitivity_eu_ml": 0.05},
        "active": True, "origin": "mk1", "in_use": False}
    [log] = _logs(db, body["id"])
    assert log.action == "create"
    assert log.details["changed"]["specs"]["after"] == {"sensitivity_eu_ml": 0.05}


@pytest.mark.parametrize("over", [
    {"kind": "pipette_tip"},
    {"specs": {}},
    {"specs": {"sensitivity_eu_ml": 0}},
    {"specs": {"sensitivity_eu_ml": 0.05, "lot": "A1"}},
    {"name": "   "},
    {"instrument_id": 999},
])
def test_create_rejects_bad_input_with_400(client, over):
    r = client.post("/consumables", json={**CART, **over})
    assert r.status_code == 400, r.text


def test_create_duplicate_kind_and_name_is_409(client):
    _create(client)
    r = client.post("/consumables", json={**CART, "part_number": "OTHER"})
    assert r.status_code == 409
    assert "already exists" in r.json()["detail"]


def test_part_number_unique_per_manufacturer(client):
    _create(client)
    r = client.post("/consumables", json={**CART, "name": "Copy"})
    assert r.status_code == 409
    assert "PTS2005" in r.json()["detail"]
    # Same part number, another manufacturer: fine.
    _create(client, name="Other make", manufacturer="Lonza")
    # No manufacturer counts as '' (the index's coalesce), so two blanks collide.
    _create(client, name="No make 1", manufacturer=None, part_number="X1")
    r = client.post("/consumables", json={**CART, "name": "No make 2", "manufacturer": "", "part_number": "X1"})
    assert r.status_code == 409


def test_blank_part_numbers_never_collide(client):
    _create(client, part_number="")
    body = _create(client, name="Endosafe 0.01", part_number="  ", specs={"sensitivity_eu_ml": 0.01})
    assert body["part_number"] is None


# --- edit, lock on use, retire ---------------------------------------------


def test_patch_unused_type_edits_specs_and_logs(client, db):
    t = _create(client)
    r = client.patch(f"/consumables/{t['id']}", json={"specs": {"sensitivity_eu_ml": 0.005}})
    assert r.status_code == 200, r.text
    assert r.json()["specs"] == {"sensitivity_eu_ml": 0.005}
    upd = _logs(db, t["id"])[-1]
    assert upd.action == "update"
    assert upd.details["changed"]["specs"] == {"before": {"sensitivity_eu_ml": 0.05},
                                               "after": {"sensitivity_eu_ml": 0.005}}


@pytest.mark.parametrize("use", [_use_on_worksheet, _use_on_item])
def test_used_type_locks_specs_and_kind(client, db, use):
    t = _create(client)
    use(db, t["id"])
    r = client.patch(f"/consumables/{t['id']}", json={"specs": {"sensitivity_eu_ml": 0.01}})
    assert r.status_code == 409
    assert "specs" in r.json()["detail"]
    db.expire_all()
    assert client.get("/consumables").json()[0]["specs"] == {"sensitivity_eu_ml": 0.05}


def test_used_type_names_both_locked_fields(client, db, monkeypatch):
    # A second kind, so a kind change can pass validation and reach the lock.
    from catalog import consumables
    monkeypatch.setitem(consumables.CONSUMABLE_KINDS, "endo_cartridge_b",
                        consumables.CONSUMABLE_KINDS["endo_cartridge"])
    t = _create(client)
    _use_on_worksheet(db, t["id"])
    r = client.patch(f"/consumables/{t['id']}", json={"kind": "endo_cartridge_b",
                                                      "specs": {"sensitivity_eu_ml": 0.01}})
    assert r.status_code == 409
    assert "kind, specs" in r.json()["detail"]


def test_used_type_accepts_unchanged_specs_and_other_fields(client, db):
    t = _create(client)
    _use_on_worksheet(db, t["id"])
    r = client.patch(f"/consumables/{t['id']}", json={
        "kind": "endo_cartridge", "specs": {"sensitivity_eu_ml": 0.05},
        "name": "Endosafe 0.05 (PTS)", "manufacturer": "CR", "part_number": "PTS2005-B"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["name"], body["part_number"], body["in_use"]) == ("Endosafe 0.05 (PTS)", "PTS2005-B", True)


def test_retire_and_rf4_retired_type_in_use_still_listed_with_specs(client, db):
    t = _create(client)
    _use_on_item(db, t["id"])
    r = client.patch(f"/consumables/{t['id']}", json={"active": False})
    assert r.status_code == 200, r.text
    assert r.json()["active"] is False
    retired = client.get("/consumables", params={"active": "false"}).json()
    assert [(row["id"], row["specs"], row["in_use"]) for row in retired] == [
        (t["id"], {"sensitivity_eu_ml": 0.05}, True)]
    assert client.get("/consumables", params={"active": "true"}).json() == []
    assert [row["id"] for row in client.get("/consumables").json()] == [t["id"]]
    assert _logs(db, t["id"])[-1].details["changed"]["active"] == {"before": True, "after": False}


def test_list_filters_by_kind(client):
    _create(client)
    assert len(client.get("/consumables", params={"kind": "endo_cartridge"}).json()) == 1
    assert client.get("/consumables", params={"kind": "pipette_tip"}).json() == []


def test_patch_rejects_nulls_bad_specs_duplicates_and_missing(client):
    a = _create(client)
    b = _create(client, name="Endosafe 0.01", part_number="PTS2001", specs={"sensitivity_eu_ml": 0.01})
    for body in ({"name": None}, {"name": " "}, {"kind": None}, {"specs": None}, {"active": None},
                 {"specs": {"sensitivity_eu_ml": -1}}, {"kind": "pipette_tip"}, {"instrument_id": 999}):
        assert client.patch(f"/consumables/{a['id']}", json=body).status_code == 400, body
    assert client.patch(f"/consumables/{a['id']}", json={"name": b["name"]}).status_code == 409
    assert client.patch(f"/consumables/{a['id']}", json={"part_number": "PTS2001"}).status_code == 409
    assert client.patch("/consumables/999", json={"name": "x"}).status_code == 404


def test_there_is_no_delete(client):
    t = _create(client)
    assert client.delete(f"/consumables/{t['id']}").status_code == 405
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_consumables_api.py -q`
Expected: collection error `ModuleNotFoundError: No module named 'catalog.consumables'`.

- [ ] **Step 3: Implement the registry module**

Create `backend/catalog/consumables.py`:

```python
"""Consumables catalog (endo worksheet v2, spec 2026-10-10 sections 3.1 and 3.2).

A kind is one CONSUMABLE_KINDS entry plus rows in consumable_types; `specs`
holds the kind's numbers and is validated here. Once a worksheet or a worksheet
item references a type, its kind and specs are locked: a wrong number is fixed
by retiring the type and adding a new one, so every result keeps the numbers it
was computed with.
"""
import math

from sqlalchemy import select, union
from sqlalchemy.orm import Session

from models import Worksheet, WorksheetItem

# Spec entry fields are what GET /consumables/kinds serves to build the admin form.
CONSUMABLE_KINDS: dict[str, dict] = {
    "endo_cartridge": {
        "label": "Endotoxin cartridge",
        "specs": {
            # The cartridge's lambda: its sensitivity is the LOD.
            "sensitivity_eu_ml": {"label": "Sensitivity", "unit": "EU/mL",
                                  "type": "positive_float", "required": True},
        },
    },
}

CONSUMABLE_LOG_FIELDS = ("kind", "name", "manufacturer", "part_number", "instrument_id", "specs", "active")


class ConsumableSpecError(ValueError):
    """A kind or specs value the registry refuses (the routes answer 400)."""


def validate_specs(kind: str, specs: dict) -> dict:
    """Return `specs` checked against the kind's registry entry: known kind,
    a dict, no unknown keys, every required key present, numbers positive and
    finite. Raises ConsumableSpecError naming the problem."""
    entry = CONSUMABLE_KINDS.get(kind)
    if entry is None:
        raise ConsumableSpecError(f"unknown kind '{kind}'; known: {', '.join(sorted(CONSUMABLE_KINDS))}")
    if not isinstance(specs, dict):
        raise ConsumableSpecError("specs must be an object")
    unknown = sorted(set(specs) - set(entry["specs"]))
    if unknown:
        raise ConsumableSpecError(f"unknown spec(s) for {kind}: {', '.join(unknown)}")
    clean = {}
    for key, field in entry["specs"].items():
        value = specs.get(key)
        if value is None:
            if field["required"]:
                raise ConsumableSpecError(f"{key} is required for {kind}")
            continue
        # bool is an int in Python; a checkbox value is not a number here.
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or value <= 0):
            raise ConsumableSpecError(f"{key} must be a positive number")
        clean[key] = float(value)
    return clean


def consumable_in_use(db: Session, type_id: int) -> bool:
    """True once a worksheet (run cartridge) or a worksheet item (row
    cartridge) references the type."""
    for col in (Worksheet.cartridge_type_id, WorksheetItem.cartridge_type_id):
        if db.execute(select(col).where(col == type_id).limit(1)).first() is not None:
            return True
    return False


def used_type_ids(db: Session) -> set[int]:
    """Every referenced type id in one query, for list endpoints."""
    q = union(
        select(Worksheet.cartridge_type_id).where(Worksheet.cartridge_type_id.is_not(None)),
        select(WorksheetItem.cartridge_type_id).where(WorksheetItem.cartridge_type_id.is_not(None)),
    )
    return set(db.execute(q).scalars().all())


def kinds_payload() -> list[dict]:
    """The registry as GET /consumables/kinds serves it."""
    return [
        {"key": key, "label": entry["label"],
         "specs": [{"key": sk, **field} for sk, field in entry["specs"].items()]}
        for key, entry in CONSUMABLE_KINDS.items()
    ]
```

- [ ] **Step 4: Run test to verify the registry passes and the routes fail**

Run: `cd backend && python -m pytest tests/test_consumables_api.py -q`
Expected: `20 failed, 11 passed`.
- The 11 passing tests are the `test_validate_specs_*` tests.
- Every route test fails, because no `/consumables` route exists yet. The failures look like `assert 404 == 201` in `_create`, or 404 where another status is asserted.

- [ ] **Step 5: Implement the routes**

In `backend/main.py`, add this line directly below the long `from models import AuditLog, Settings, ... method_services, LimsOrder` line:

```python
from models import ConsumableType  # endo worksheet v2
```

In `backend/main.py`, insert directly above the `# ─── Analysis Service Endpoints ───` section comment, below `update_instrument`:

```python
# ─── Consumables catalog (endo worksheet v2, spec 2026-10-10 sections 3.1, 3.2, 9) ───


class ConsumableTypeCreate(BaseModel):
    kind: str
    name: str
    manufacturer: Optional[str] = None
    part_number: Optional[str] = None
    instrument_id: Optional[int] = None
    specs: dict = {}


class ConsumableTypeUpdate(BaseModel):
    """All optional. Retire with active=false; there is no delete."""
    kind: Optional[str] = None
    name: Optional[str] = None
    manufacturer: Optional[str] = None
    part_number: Optional[str] = None
    instrument_id: Optional[int] = None
    specs: Optional[dict] = None
    active: Optional[bool] = None


class ConsumableTypeResponse(BaseModel):
    id: int
    kind: str
    name: str
    manufacturer: Optional[str] = None
    part_number: Optional[str] = None
    instrument_id: Optional[int] = None
    specs: dict
    active: bool
    origin: str
    in_use: bool = False
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ConsumableSpecFieldOut(BaseModel):
    key: str
    label: str
    unit: Optional[str] = None
    type: str
    required: bool


class ConsumableKindOut(BaseModel):
    key: str
    label: str
    specs: list[ConsumableSpecFieldOut]


def _blank_to_none(value: Optional[str]) -> Optional[str]:
    """R-P1-2 edge normalization: a blank string never reaches a partial unique index."""
    if value is None:
        return None
    return value.strip() or None


def _consumable_out(row: ConsumableType, in_use: bool) -> ConsumableTypeResponse:
    out = ConsumableTypeResponse.model_validate(row)
    out.in_use = in_use
    return out


def _consumable_conflict(db: Session, *, kind: str, name: str, manufacturer: Optional[str],
                         part_number: Optional[str], exclude_id: Optional[int] = None) -> Optional[str]:
    """The 409 message for a duplicate (kind, name) or a duplicate part number
    under the same manufacturer (none counts as ''), mirroring the two unique
    indexes on consumable_types; None when the row is unique."""
    q = select(ConsumableType.id).where(ConsumableType.kind == kind, ConsumableType.name == name)
    if exclude_id is not None:
        q = q.where(ConsumableType.id != exclude_id)
    if db.execute(q).first() is not None:
        return f"a {kind} named '{name}' already exists"
    if part_number is not None:
        q = select(ConsumableType.name).where(
            ConsumableType.part_number == part_number,
            func.coalesce(ConsumableType.manufacturer, "") == (manufacturer or ""))
        if exclude_id is not None:
            q = q.where(ConsumableType.id != exclude_id)
        other = db.execute(q).scalars().first()
        if other is not None:
            return f"part number '{part_number}' is already on '{other}'"
    return None


@app.get("/consumables/kinds", response_model=list[ConsumableKindOut])
async def list_consumable_kinds(_current_user=Depends(get_current_user)):
    """The kind registry, for the admin form."""
    from catalog.consumables import kinds_payload
    return kinds_payload()


@app.get("/consumables", response_model=list[ConsumableTypeResponse])
async def list_consumables(kind: Optional[str] = None, active: Optional[bool] = None,
                           db: Session = Depends(get_db), _current_user=Depends(get_current_user)):
    """Every consumable type, retired ones included unless ?active=true.
    in_use comes from one query, never one per row."""
    from catalog.consumables import used_type_ids
    q = select(ConsumableType).order_by(ConsumableType.kind, ConsumableType.name)
    if kind is not None:
        q = q.where(ConsumableType.kind == kind)
    if active is not None:
        q = q.where(ConsumableType.active == active)
    used = used_type_ids(db)
    return [_consumable_out(row, row.id in used) for row in db.execute(q).scalars().all()]


@app.post("/consumables", response_model=ConsumableTypeResponse, status_code=201)
async def create_consumable(data: ConsumableTypeCreate, db: Session = Depends(get_db),
                            current_user=Depends(get_current_user)):
    from catalog.consumables import CONSUMABLE_LOG_FIELDS, ConsumableSpecError, validate_specs
    name = _blank_to_none(data.name)
    if name is None:
        raise HTTPException(400, "name is required")
    try:
        specs = validate_specs(data.kind, data.specs)
    except ConsumableSpecError as e:
        raise HTTPException(400, str(e))
    manufacturer = _blank_to_none(data.manufacturer)
    part_number = _blank_to_none(data.part_number)
    if data.instrument_id is not None and not db.get(Instrument, data.instrument_id):
        raise HTTPException(400, f"Instrument {data.instrument_id} not found")
    conflict = _consumable_conflict(db, kind=data.kind, name=name, manufacturer=manufacturer,
                                    part_number=part_number)
    if conflict:
        raise HTTPException(409, conflict)
    row = ConsumableType(kind=data.kind, name=name, manufacturer=manufacturer,
                         part_number=part_number, instrument_id=data.instrument_id, specs=specs)
    db.add(row)
    db.flush()
    log_create(db, row, CONSUMABLE_LOG_FIELDS, entity_type="consumable_type", entity_pk=row.id,
               user_id=getattr(current_user, "id", None))
    db.commit()
    db.refresh(row)
    return _consumable_out(row, False)


@app.patch("/consumables/{type_id}", response_model=ConsumableTypeResponse)
async def update_consumable(type_id: int, data: ConsumableTypeUpdate, db: Session = Depends(get_db),
                            current_user=Depends(get_current_user)):
    """Edit or retire a consumable type. Once a worksheet or an item uses it,
    a change to kind or specs is 409 naming the fields (resending the stored
    value is fine); name, manufacturer, part number, instrument and active
    stay editable."""
    from catalog.consumables import ConsumableSpecError, consumable_in_use, validate_specs
    row = db.get(ConsumableType, type_id)
    if not row:
        raise HTTPException(404, f"Consumable type {type_id} not found")
    fields = data.model_dump(exclude_unset=True)
    for f in ("name", "manufacturer", "part_number"):
        if f in fields:
            fields[f] = _blank_to_none(fields[f])
    for f in ("kind", "name", "specs", "active"):
        if f in fields and fields[f] is None:
            raise HTTPException(400, f"{f} cannot be empty")
    if "kind" in fields or "specs" in fields:
        try:
            specs = validate_specs(fields.get("kind", row.kind), fields.get("specs", row.specs))
        except ConsumableSpecError as e:
            raise HTTPException(400, str(e))
        if "specs" in fields:
            fields["specs"] = specs
        changed = [f for f in ("kind", "specs") if f in fields and fields[f] != getattr(row, f)]
        if changed and consumable_in_use(db, type_id):
            raise HTTPException(
                409, f"'{row.name}' is in use; locked: {', '.join(changed)}. "
                     f"Retire it and add a new one to change these")
    if fields.get("instrument_id") is not None and not db.get(Instrument, fields["instrument_id"]):
        raise HTTPException(400, f"Instrument {fields['instrument_id']} not found")
    conflict = _consumable_conflict(
        db, kind=fields.get("kind", row.kind), name=fields.get("name", row.name),
        manufacturer=fields.get("manufacturer", row.manufacturer),
        part_number=fields.get("part_number", row.part_number), exclude_id=type_id)
    if conflict:
        raise HTTPException(409, conflict)
    apply_and_log(db, row, fields, entity_type="consumable_type", entity_pk=row.id,
                  user_id=getattr(current_user, "id", None))
    db.commit()
    db.refresh(row)
    return _consumable_out(row, consumable_in_use(db, type_id))
```

(`log_create`, `apply_and_log`, `select`, `func`, `Instrument`, `BaseModel`, `Optional` and `datetime` are already imported at module level in `main.py`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_consumables_api.py -q`
Expected: `31 passed`.

- [ ] **Step 7: Register the new routes with the change-log guard**

In `backend/tests/test_catalog_change_log_guard.py`, `WIRED_FUNCTIONS`, insert directly after `    "reprovision_catalog_snapshot",`:

```python
    # Endo worksheet v2 (spec 2026-10-10 section 10): consumables catalog.
    "create_consumable",
    "update_consumable",
```

Run: `cd backend && python -m pytest tests/test_catalog_change_log_guard.py tests/test_consumables_api.py -q`
Expected: `32 passed`.

- [ ] **Step 8: Commit**

```bash
git -C /c/tmp/Accu-Mk1-endo-v2 add backend/catalog/consumables.py backend/tests/test_consumables_api.py
git -C /c/tmp/Accu-Mk1-endo-v2 commit -m "feat(endo-v2): consumables catalog API with kind registry and lock on use" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/catalog/consumables.py backend/main.py backend/tests/test_consumables_api.py backend/tests/test_catalog_change_log_guard.py
```

---

### Task 3: Method consumables (draft-only, cloned on new revision) and method run_parameters

**Files:**
- Create: `backend/catalog/method_run_params.py`
- Modify: `backend/main.py`:
  - The Task 2 import line becomes `from models import ConsumableType, method_consumables`.
  - `METHOD_LOCKED_FIELDS` gains `"run_parameters"`.
  - `class MethodUpdate` and `class MethodResponse` gain `run_parameters`.
  - `update_method` validates `run_parameters`.
  - `new_method_revision` copies `run_parameters` and `method_consumables` with `is_default`.
  - New `MethodConsumableLinkIn`, `MethodConsumableOut`, `_method_consumable_rows`, `get_method_consumables` and `put_method_consumables`, placed above the `Methods controlled documents (slice 3): lifecycle verbs` section comment.
- Modify: `backend/tests/test_catalog_change_log_guard.py`: add `put_method_consumables` to `WIRED_FUNCTIONS`.
- Test (create): `backend/tests/test_method_consumables_run_params.py`

**Interfaces:**
- Consumes (Task 1): `models.method_consumables`, `models.ConsumableType`, `HplcMethod.run_parameters`.
- Consumes (existing): `catalog.change_log.log_members`.
- Produces in `backend/catalog/method_run_params.py`:
  - `ENDO_RUN_PARAM_DEFAULTS = {"std_total_dilution": 250, "recon_water_ml": 2, "spike_recovery_min_pct": 50, "spike_recovery_max_pct": 200, "cv_limit_pct": 25}`
  - `MIN_STD_TOTAL_DILUTION = 20`
  - `validate_run_parameters(value: Optional[dict]) -> Optional[dict]`, which raises `ValueError`
- Produces endpoints:
  - `GET /hplc/methods/{id}/consumables` returns `list[MethodConsumableOut]`.
  - `PUT /hplc/methods/{id}/consumables` takes body `list[{"consumable_type_id": int, "is_default": bool}]` and returns `list[MethodConsumableOut]`. It returns 409 unless the method is a draft and 400 on bad links.
- `MethodConsumableOut` = `{consumable_type_id, kind, name, specs, active, is_default}`.
- `MethodResponse.run_parameters`.
- Catalog log: `entity_type="method"` with fields `consumables` and `consumable_defaults`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_method_consumables_run_params.py`:

```python
"""Method consumables and run parameters (endo worksheet v2, spec 2026-10-10
sections 3.3, 3.4 and 10). In-memory SQLite + dependency overrides, the
test_worksheet_endo_prep.py idiom."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from catalog.method_run_params import ENDO_RUN_PARAM_DEFAULTS, validate_run_parameters
from database import Base, get_db
from models import CatalogChangeLog, ConsumableType


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _cart(db, name, lam, active=True):
    t = ConsumableType(kind="endo_cartridge", name=name, specs={"sensitivity_eu_ml": lam}, active=active)
    db.add(t)
    db.commit()
    return t.id


def _draft(client, name="Endotoxin"):
    r = client.post("/hplc/methods", json={"name": name, "technique": "LAL"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _put(client, mid, links):
    return client.put(f"/hplc/methods/{mid}/consumables", json=links)


# --- method consumables ------------------------------------------------------


def test_draft_method_takes_a_replace_set_with_one_default(client, db):
    c05, c01, c005 = _cart(db, "Endosafe 0.05", 0.05), _cart(db, "Endosafe 0.01", 0.01), _cart(db, "Endosafe 0.005", 0.005)
    mid = _draft(client)
    assert client.get(f"/hplc/methods/{mid}/consumables").json() == []
    r = _put(client, mid, [{"consumable_type_id": c05, "is_default": True}, {"consumable_type_id": c01}])
    assert r.status_code == 200, r.text
    assert r.json() == [
        {"consumable_type_id": c01, "kind": "endo_cartridge", "name": "Endosafe 0.01",
         "specs": {"sensitivity_eu_ml": 0.01}, "active": True, "is_default": False},
        {"consumable_type_id": c05, "kind": "endo_cartridge", "name": "Endosafe 0.05",
         "specs": {"sensitivity_eu_ml": 0.05}, "active": True, "is_default": True},
    ]
    # Replace-set: the second PUT is the whole list.
    r = _put(client, mid, [{"consumable_type_id": c005, "is_default": True}])
    assert [(x["consumable_type_id"], x["is_default"]) for x in r.json()] == [(c005, True)]
    assert client.get(f"/hplc/methods/{mid}/consumables").json() == r.json()


def test_put_is_logged_including_a_change_of_default_alone(client, db):
    c05, c01 = _cart(db, "Endosafe 0.05", 0.05), _cart(db, "Endosafe 0.01", 0.01)
    mid = _draft(client)
    _put(client, mid, [{"consumable_type_id": c05, "is_default": True}, {"consumable_type_id": c01}])
    _put(client, mid, [{"consumable_type_id": c05}, {"consumable_type_id": c01, "is_default": True}])
    changes = [log.details["changed"] for log in db.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "method", CatalogChangeLog.entity_pk == mid,
        CatalogChangeLog.action == "update").order_by(CatalogChangeLog.id)).scalars()]
    assert changes == [
        {"consumables": {"before": [], "after": sorted([c05, c01])}},
        {"consumable_defaults": {"before": [], "after": [c05]}},
        {"consumable_defaults": {"before": [c05], "after": [c01]}},
    ]


@pytest.mark.parametrize("verb", ["activate", "retire"])
def test_non_draft_method_consumables_are_409(client, db, verb):
    c05 = _cart(db, "Endosafe 0.05", 0.05)
    mid = _draft(client)
    _put(client, mid, [{"consumable_type_id": c05, "is_default": True}])
    client.post(f"/hplc/methods/{mid}/activate")
    if verb == "retire":
        client.post(f"/hplc/methods/{mid}/retire")
    r = _put(client, mid, [])
    assert r.status_code == 409
    assert "new revision" in r.json()["detail"]
    assert len(client.get(f"/hplc/methods/{mid}/consumables").json()) == 1


def test_put_rejects_bad_links_with_400(client, db):
    c05, c01 = _cart(db, "Endosafe 0.05", 0.05), _cart(db, "Endosafe 0.01", 0.01)
    old = _cart(db, "Old 0.25", 0.25, active=False)
    mid = _draft(client)
    for links in (
        [{"consumable_type_id": c05, "is_default": True}, {"consumable_type_id": c01, "is_default": True}],
        [{"consumable_type_id": 999}],
        [{"consumable_type_id": old}],
        [{"consumable_type_id": c05}, {"consumable_type_id": c05}],
    ):
        assert _put(client, mid, links).status_code == 400, links
    assert client.get(f"/hplc/methods/{mid}/consumables").json() == []
    assert client.get("/hplc/methods/999/consumables").status_code == 404
    assert _put(client, 999, []).status_code == 404


def test_new_revision_copies_consumables_with_default_and_run_parameters(client, db):
    c05, c01 = _cart(db, "Endosafe 0.05", 0.05), _cart(db, "Endosafe 0.01", 0.01)
    mid = _draft(client)
    _put(client, mid, [{"consumable_type_id": c05, "is_default": True}, {"consumable_type_id": c01}])
    client.put(f"/hplc/methods/{mid}", json={"run_parameters": {"endotoxin": {"cv_limit_pct": 20}}})
    client.post(f"/hplc/methods/{mid}/activate")
    r = client.post(f"/hplc/methods/{mid}/new-revision")
    assert r.status_code == 201, r.text
    rev2 = r.json()
    assert rev2["run_parameters"] == {"endotoxin": {"cv_limit_pct": 20}}
    links = client.get(f"/hplc/methods/{rev2['id']}/consumables").json()
    assert [(x["consumable_type_id"], x["is_default"]) for x in links] == [(c01, False), (c05, True)]
    # The source revision keeps its own links.
    assert len(client.get(f"/hplc/methods/{mid}/consumables").json()) == 2


# --- run parameters --------------------------------------------------------


@pytest.mark.parametrize("value", [
    [], "x", {"hplc": {}}, {"endotoxin": []}, {"endotoxin": {"water": 2}},
    {"endotoxin": {"std_total_dilution": 0}}, {"endotoxin": {"recon_water_ml": -2}},
    {"endotoxin": {"cv_limit_pct": True}}, {"endotoxin": {"cv_limit_pct": "25"}},
    {"endotoxin": {"cv_limit_pct": float("inf")}},
    {"endotoxin": {"spike_recovery_min_pct": 200, "spike_recovery_max_pct": 200}},
    {"endotoxin": {"spike_recovery_min_pct": 250}},   # above the default max of 200
    {"endotoxin": {"spike_recovery_max_pct": 40}},    # below the default min of 50
    {"endotoxin": {"std_total_dilution": 19}},
])
def test_validate_run_parameters_rejects(value):
    with pytest.raises(ValueError):
        validate_run_parameters(value)


def test_validate_run_parameters_accepts_and_normalizes():
    assert validate_run_parameters(None) is None
    assert validate_run_parameters({}) is None
    assert validate_run_parameters({"endotoxin": {}}) is None
    assert validate_run_parameters({"endotoxin": {"cv_limit_pct": None}}) is None
    assert validate_run_parameters({"endotoxin": {"std_total_dilution": 20, "recon_water_ml": None}}) == {
        "endotoxin": {"std_total_dilution": 20}}
    full = {"endotoxin": dict(ENDO_RUN_PARAM_DEFAULTS)}
    assert validate_run_parameters(full) == full


def test_put_method_sets_validates_and_clears_run_parameters(client, db):
    mid = _draft(client)
    r = client.put(f"/hplc/methods/{mid}", json={"run_parameters": {"endotoxin": {"std_total_dilution": 500}}})
    assert r.status_code == 200, r.text
    assert r.json()["run_parameters"] == {"endotoxin": {"std_total_dilution": 500}}
    listed = next(m for m in client.get("/hplc/methods").json() if m["id"] == mid)
    assert listed["run_parameters"] == {"endotoxin": {"std_total_dilution": 500}}
    r = client.put(f"/hplc/methods/{mid}", json={"run_parameters": {"endotoxin": {"std_total_dilution": 10}}})
    assert r.status_code == 400
    assert "std_total_dilution" in r.json()["detail"]
    r = client.put(f"/hplc/methods/{mid}", json={"run_parameters": None})
    assert r.status_code == 200 and r.json()["run_parameters"] is None
    logs = db.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "method", CatalogChangeLog.entity_pk == mid,
        CatalogChangeLog.action == "update")).scalars().all()
    assert [log.details["changed"]["run_parameters"]["after"] for log in logs] == [
        {"endotoxin": {"std_total_dilution": 500}}, None]


def test_run_parameters_lock_once_issued(client, db):
    mid = _draft(client)
    client.post(f"/hplc/methods/{mid}/activate")
    r = client.put(f"/hplc/methods/{mid}", json={"run_parameters": {"endotoxin": {"cv_limit_pct": 20}}})
    assert r.status_code == 409
    assert "run_parameters" in r.json()["detail"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_method_consumables_run_params.py -q`
Expected: collection error `ModuleNotFoundError: No module named 'catalog.method_run_params'`.

- [ ] **Step 3: Implement the run parameter validator**

Create `backend/catalog/method_run_params.py`:

```python
"""Method run parameters (endo worksheet v2, spec 2026-10-10 section 3.4).

Stored on hplc_methods.run_parameters, keyed by block so validation never
depends on the free-text technique:

    {"endotoxin": {"std_total_dilution": 250, "recon_water_ml": 2,
                   "spike_recovery_min_pct": 50, "spike_recovery_max_pct": 200,
                   "cv_limit_pct": 25}}

Every key is optional; a missing key means Dennis's value below. Content-locked
with the method's other fields (main.py METHOD_LOCKED_FIELDS).
"""
import math
from typing import Optional

ENDO_RUN_PARAM_DEFAULTS = {
    "std_total_dilution": 250,
    "recon_water_ml": 2,
    "spike_recovery_min_pct": 50,
    "spike_recovery_max_pct": 200,
    "cv_limit_pct": 25,
}

# The standard step 1 at 1:10 times the fixed step 3 at 1:2.
MIN_STD_TOTAL_DILUTION = 20


def validate_run_parameters(value: Optional[dict]) -> Optional[dict]:
    """Return the value to store, or raise ValueError naming the problem.
    None clears. A key sent as null means "use the default" and is dropped;
    a block left empty is dropped, and nothing left at all stores None."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("run_parameters must be an object")
    unknown = sorted(set(value) - {"endotoxin"})
    if unknown:
        raise ValueError(f"unknown run_parameters block(s): {', '.join(unknown)}")
    block = value.get("endotoxin")
    if block is None:
        return None
    if not isinstance(block, dict):
        raise ValueError("run_parameters.endotoxin must be an object")
    unknown = sorted(set(block) - set(ENDO_RUN_PARAM_DEFAULTS))
    if unknown:
        raise ValueError(f"unknown endotoxin run parameter(s): {', '.join(unknown)}")
    clean = {}
    for key, v in block.items():
        if v is None:
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0:
            raise ValueError(f"endotoxin.{key} must be a positive number")
        clean[key] = v
    effective = {**ENDO_RUN_PARAM_DEFAULTS, **clean}
    if effective["spike_recovery_min_pct"] >= effective["spike_recovery_max_pct"]:
        raise ValueError("endotoxin.spike_recovery_min_pct must be below spike_recovery_max_pct "
                         f"(effective {effective['spike_recovery_min_pct']} and "
                         f"{effective['spike_recovery_max_pct']})")
    if effective["std_total_dilution"] < MIN_STD_TOTAL_DILUTION:
        raise ValueError(f"endotoxin.std_total_dilution must be at least {MIN_STD_TOTAL_DILUTION} "
                         "(step 1 at 1:10 times step 3 at 1:2)")
    return {"endotoxin": clean} if clean else None
```

- [ ] **Step 4: Run test to verify the validator passes and the routes fail**

Run: `cd backend && python -m pytest tests/test_method_consumables_run_params.py -q`
Expected: `8 failed, 15 passed`.
- The 15 passing tests are `test_validate_run_parameters_*`.
- The 8 failures are route tests:
  - 404 on `/hplc/methods/{id}/consumables`.
  - `KeyError: 'run_parameters'` on method responses.
  - 200 where 409 is expected, because `MethodUpdate` silently ignores `run_parameters` today.

- [ ] **Step 5: Implement the method changes**

In `backend/main.py`, change the Task 2 import line to:

```python
from models import ConsumableType, method_consumables  # endo worksheet v2
```

Replace the `METHOD_LOCKED_FIELDS` tuple with:

```python
METHOD_LOCKED_FIELDS = ("name", "code", "technique", "reference", "procedure_summary",
                        "size_peptide", "starting_organic_pct", "temperature_mct_c",
                        "dissolution", "run_parameters")
```

In `class MethodUpdate`, insert after `active: Optional[bool] = None`:

```python
    # Endo worksheet v2: validated by catalog/method_run_params.py; null clears.
    run_parameters: Optional[dict] = None
```

In `class MethodResponse`, insert after `services: list[MethodServiceOut] = []`:

```python
    run_parameters: Optional[dict] = None
```

In `update_method`, insert directly above `    instrument_ids = fields.pop("instrument_ids", None)`, which is below the locked-fields 409:

```python
    if "run_parameters" in fields:
        from catalog.method_run_params import validate_run_parameters
        try:
            fields["run_parameters"] = validate_run_parameters(fields["run_parameters"])
        except ValueError as e:
            raise HTTPException(400, str(e))
```

`apply_and_log` already logs `run_parameters` with the other applied fields. `MethodCreate` deliberately does not take `run_parameters`: they are set by PUT on the draft (spec 3.4).

In `new_method_revision`:

1. Replace the docstring's last line `    links. Never copies senaite_id (R0; also globally unique)."""` with:

```python
    links. Never copies senaite_id (R0; also globally unique). Endo worksheet
    v2: also run_parameters, and method_consumables WITH is_default (a
    consumable default belongs to this method alone, so it cannot clash)."""
```

2. In the `clone = HplcMethod(` call, replace `        revision=max_rev + 1, supersedes_id=src.id,` with:

```python
        revision=max_rev + 1, supersedes_id=src.id, run_parameters=src.run_parameters,
```

3. Insert directly after the `method_services` clone loop, whose last line is `            is_default=False))`, and above `    from catalog.change_log import log_create`:

```python
    for link in db.execute(select(method_consumables).where(
            method_consumables.c.method_id == src.id)).all():
        db.execute(method_consumables.insert().values(
            method_id=clone.id, consumable_type_id=link.consumable_type_id,
            kind=link.kind, is_default=link.is_default))
```

Insert directly above the `# ─── Methods controlled documents (slice 3): lifecycle verbs ───` section comment (it sits below `put_method_services`):

```python
class MethodConsumableLinkIn(BaseModel):
    consumable_type_id: int
    is_default: bool = False


class MethodConsumableOut(BaseModel):
    consumable_type_id: int
    kind: str
    name: str
    specs: dict
    active: bool
    is_default: bool


def _method_consumable_rows(db: Session, method_id: int) -> list[MethodConsumableOut]:
    rows = db.execute(
        select(method_consumables.c.consumable_type_id, method_consumables.c.kind,
               ConsumableType.name, ConsumableType.specs, ConsumableType.active,
               method_consumables.c.is_default)
        .join(ConsumableType, ConsumableType.id == method_consumables.c.consumable_type_id)
        .where(method_consumables.c.method_id == method_id)
        .order_by(method_consumables.c.kind, ConsumableType.name)
    ).all()
    return [MethodConsumableOut(consumable_type_id=r[0], kind=r[1], name=r[2], specs=r[3],
                                active=r[4], is_default=r[5]) for r in rows]


@app.get("/hplc/methods/{method_id}/consumables", response_model=list[MethodConsumableOut])
async def get_method_consumables(method_id: int, db: Session = Depends(get_db),
                                 _current_user=Depends(get_current_user)):
    if not db.get(HplcMethod, method_id):
        raise HTTPException(404, f"Method {method_id} not found")
    return _method_consumable_rows(db, method_id)


@app.put("/hplc/methods/{method_id}/consumables", response_model=list[MethodConsumableOut])
async def put_method_consumables(method_id: int, links: list[MethodConsumableLinkIn],
                                 db: Session = Depends(get_db),
                                 current_user=Depends(get_current_user)):
    """Replace-set (the put_method_services precedent) on DRAFT methods only:
    a method's allowed consumables change only through a new revision (Handler
    ruling 2026-10-10). Each type must exist and be active; the link's kind is
    copied from the type, never sent; at most one default per kind."""
    method = db.get(HplcMethod, method_id)
    if not method:
        raise HTTPException(404, f"Method {method_id} not found")
    if method.status != "draft":
        raise HTTPException(
            409, f"method '{method.name}' rev {method.revision} is {method.status}; consumables "
                 f"change only on a draft. Create a new revision instead")
    picked: list[tuple[ConsumableType, bool]] = []
    defaults: dict[str, int] = {}
    for ln in links:
        if any(t.id == ln.consumable_type_id for t, _ in picked):
            raise HTTPException(400, f"consumable type {ln.consumable_type_id} listed twice")
        t = db.get(ConsumableType, ln.consumable_type_id)
        if t is None:
            raise HTTPException(400, f"consumable type {ln.consumable_type_id} not found")
        if not t.active:
            raise HTTPException(400, f"consumable type '{t.name}' is retired")
        if ln.is_default:
            if t.kind in defaults:
                raise HTTPException(400, f"more than one default {t.kind}")
            defaults[t.kind] = t.id
        picked.append((t, ln.is_default))
    before = db.execute(select(method_consumables.c.consumable_type_id, method_consumables.c.is_default)
                        .where(method_consumables.c.method_id == method_id)).all()
    db.execute(method_consumables.delete().where(method_consumables.c.method_id == method_id))
    for t, is_default in picked:
        db.execute(method_consumables.insert().values(
            method_id=method_id, consumable_type_id=t.id, kind=t.kind, is_default=is_default))
    # Two fields, so a change of default alone is still logged.
    user_id = getattr(current_user, "id", None)
    log_members(db, entity_type="method", entity_pk=method_id, user_id=user_id, field="consumables",
                before_ids=sorted(r[0] for r in before), after_ids=sorted(t.id for t, _ in picked))
    log_members(db, entity_type="method", entity_pk=method_id, user_id=user_id,
                field="consumable_defaults", before_ids=sorted(r[0] for r in before if r[1]),
                after_ids=sorted(defaults.values()))
    db.commit()
    return _method_consumable_rows(db, method_id)
```

(`log_members` is already imported at module level in `main.py`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_method_consumables_run_params.py -q`
Expected: `23 passed`.

- [ ] **Step 7: Register the route with the change-log guard and run the method suites**

In `backend/tests/test_catalog_change_log_guard.py`, `WIRED_FUNCTIONS`, insert directly after `    "update_consumable",`:

```python
    "put_method_consumables",
```

Run: `cd backend && python -m pytest tests/test_catalog_change_log_guard.py tests/test_method_consumables_run_params.py tests/test_methods_lifecycle.py tests/test_methods_catalog.py tests/test_api_service_methods.py tests/test_methods_stamping.py -q`
Expected: all pass, with no failures.

- [ ] **Step 8: Commit**

```bash
git -C /c/tmp/Accu-Mk1-endo-v2 add backend/catalog/method_run_params.py backend/tests/test_method_consumables_run_params.py
git -C /c/tmp/Accu-Mk1-endo-v2 commit -m "feat(endo-v2): method consumables (draft-only, cloned on new revision) and run parameters" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/catalog/method_run_params.py backend/main.py backend/tests/test_method_consumables_run_params.py backend/tests/test_catalog_change_log_guard.py
```

---

### Task 4: Instrument serial_number

**Files:**
- Modify: `backend/main.py`:
  - `InstrumentResponse`, `InstrumentCreate` and `InstrumentUpdate` gain `serial_number`.
  - `INSTRUMENT_LOG_FIELDS` gains `"serial_number"`.
  - New helper `_instrument_holding_serial`.
  - `create_instrument` and `update_instrument` normalize the serial and answer 409 on a duplicate.
- Test (create): `backend/tests/test_instrument_serial.py`

**Interfaces:**
- Consumes:
  - `Instrument.serial_number` and the `uq_instruments_serial_number` index (Task 1).
  - `_blank_to_none` in `main.py` (Task 2).
- Produces:
  - `POST /instruments` and `PATCH /instruments/{id}` accept `serial_number`.
  - `InstrumentResponse.serial_number`.
  - A duplicate serial returns 409.
  - The catalog change log records `serial_number` on create and update.
  - Helper `_instrument_holding_serial(db, serial, exclude_id=None) -> Optional[str]`. Requirement for Task 7's `instrument_id_for_serial`: strip the reader's serial and match it exactly against the stored (already stripped) value.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_instrument_serial.py`:

```python
"""Instrument serial numbers (endo worksheet v2, spec 2026-10-10 sections 3.5
and 10): the reader import stamps the instrument by serial. In-memory SQLite +
dependency overrides, the test_worksheet_endo_prep.py idiom."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from database import Base, get_db
from models import CatalogChangeLog


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_create_and_list_carry_the_serial(client):
    r = client.post("/instruments", json={"name": "Nexgen-MCS", "serial_number": " NX-1234 "})
    assert r.status_code == 201, r.text
    assert r.json()["serial_number"] == "NX-1234"
    assert [i["serial_number"] for i in client.get("/instruments").json()] == ["NX-1234"]
    # Blank means none, so blanks never collide.
    assert client.post("/instruments", json={"name": "A", "serial_number": ""}).json()["serial_number"] is None
    assert client.post("/instruments", json={"name": "B", "serial_number": "  "}).json()["serial_number"] is None


def test_duplicate_serial_is_409_on_create_and_patch(client):
    client.post("/instruments", json={"name": "Nexgen-MCS", "serial_number": "NX-1234"})
    r = client.post("/instruments", json={"name": "Nexgen-MCS 2", "serial_number": "NX-1234"})
    assert r.status_code == 409
    assert "Nexgen-MCS" in r.json()["detail"]
    other = client.post("/instruments", json={"name": "Nexgen-MCS 2"}).json()
    r = client.patch(f"/instruments/{other['id']}", json={"serial_number": "NX-1234"})
    assert r.status_code == 409


def test_patch_sets_keeps_and_clears_the_serial(client):
    inst = client.post("/instruments", json={"name": "Nexgen-MCS"}).json()
    r = client.patch(f"/instruments/{inst['id']}", json={"serial_number": "NX-1234"})
    assert r.status_code == 200 and r.json()["serial_number"] == "NX-1234"
    # Re-sending its own serial is not a duplicate.
    r = client.patch(f"/instruments/{inst['id']}", json={"serial_number": "NX-1234", "brand": "Charles River"})
    assert r.status_code == 200, r.text
    r = client.patch(f"/instruments/{inst['id']}", json={"serial_number": None})
    assert r.status_code == 200 and r.json()["serial_number"] is None


def test_serial_changes_are_in_the_catalog_change_log(client, db):
    iid = client.post("/instruments", json={"name": "Nexgen-MCS", "serial_number": "NX-1"}).json()["id"]
    client.patch(f"/instruments/{iid}", json={"serial_number": "NX-2"})
    logs = db.execute(select(CatalogChangeLog).where(
        CatalogChangeLog.entity_type == "instrument", CatalogChangeLog.entity_pk == iid)
        .order_by(CatalogChangeLog.id)).scalars().all()
    assert logs[0].action == "create"
    assert logs[0].details["changed"]["serial_number"] == {"before": None, "after": "NX-1"}
    assert logs[1].details["changed"]["serial_number"] == {"before": "NX-1", "after": "NX-2"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_instrument_serial.py -q`
Expected: `4 failed`, with `KeyError: 'serial_number'` and `assert 201 == 409`. `InstrumentCreate` drops the unknown key (`extra = "ignore"`), and the response has no `serial_number`.

- [ ] **Step 3: Implement**

In `backend/main.py`:

`class InstrumentResponse`: insert after `origin: str = "mk1"`:

```python
    serial_number: Optional[str] = None
```

`class InstrumentCreate`: insert after `department_id: Optional[int] = None`:

```python
    serial_number: Optional[str] = None
```

`class InstrumentUpdate`: insert after `active: Optional[bool] = None`:

```python
    serial_number: Optional[str] = None
```

Replace the `INSTRUMENT_LOG_FIELDS` tuple with:

```python
INSTRUMENT_LOG_FIELDS = ("name", "instrument_type", "brand", "model", "department_id",
                         "active", "origin", "serial_number")
```

Insert directly below the `# ─── Instrument Endpoints (Local CRUD) ───` section comment and above `@app.post("/instruments", ...)`:

```python
def _instrument_holding_serial(db: Session, serial: str, exclude_id: Optional[int] = None) -> Optional[str]:
    """Name of the instrument that already carries `serial`, else None (the
    uq_instruments_serial_number partial index is the backstop)."""
    q = select(Instrument.name).where(Instrument.serial_number == serial)
    if exclude_id is not None:
        q = q.where(Instrument.id != exclude_id)
    return db.execute(q).scalars().first()
```

In `create_instrument`, insert directly above `    inst = Instrument(**data.model_dump())`:

```python
    data.serial_number = _blank_to_none(data.serial_number)
    if data.serial_number is not None:
        holder = _instrument_holding_serial(db, data.serial_number)
        if holder is not None:
            raise HTTPException(409, f"serial number '{data.serial_number}' is already on '{holder}'")
```

In `update_instrument`, insert directly above `    from catalog.change_log import apply_and_log`:

```python
    if "serial_number" in fields:
        fields["serial_number"] = _blank_to_none(fields["serial_number"])
        if fields["serial_number"] is not None:
            holder = _instrument_holding_serial(db, fields["serial_number"], exclude_id=instrument_id)
            if holder is not None:
                raise HTTPException(409, f"serial number '{fields['serial_number']}' is already on '{holder}'")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_instrument_serial.py tests/test_methods_lifecycle.py -q`
Expected: `33 passed`. This includes the existing `test_instrument_crud_audited`.

- [ ] **Step 5: Commit**

```bash
git -C /c/tmp/Accu-Mk1-endo-v2 add backend/tests/test_instrument_serial.py
git -C /c/tmp/Accu-Mk1-endo-v2 commit -m "feat(endo-v2): instrument serial number, unique, audited" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/main.py backend/tests/test_instrument_serial.py
```

---

### Task 5: Worksheet run fields, endo method resolution and pinning, serializer

**Files:**
- Create: `backend/worksheets_endo.py`
- Modify: `backend/main.py`:
  - `_serialize_worksheets`: one batched cartridge-sensitivity lookup, four worksheet keys and ten item keys.
  - `get_worksheet_by_id`: adds `endo_method`.
  - `WorksheetUpdate` and `update_worksheet`: the run fields `endo_prep` and `cartridge_type_id`.
  - `record_worksheet_printed`: pins the method.
- Modify: `backend/tests/test_worksheets_list_sync.py`. `test_get_worksheet_by_id_matches_list_shape` is stale, because the single GET now adds `endo_method`.
- Test: Create `backend/tests/test_endo_v2_worksheets.py` (Tasks 6 and 7 append to it).

**Interfaces:**
- Consumes (Tasks 1 to 4):
  - `ConsumableType` and `method_consumables` (`method_id`, `consumable_type_id`, `kind`, `is_default`).
  - `HplcMethod.run_parameters`, `Instrument.serial_number`.
  - `Worksheet.endo_prep` (ORM default `"2ml"`), `Worksheet.cartridge_type_id`, `Worksheet.endo_method_id`.
  - The `WorksheetItem` columns `prep_form`, `prep_water_ml`, `prep_total_dilution`, `prep_steps`, `cartridge_type_id`, `result_reading`, `result_reader`, `result_entered_at`, `result_entered_by_user_id`.
  - From `main.py` (existing): `_bench_kind_for_item`, imported lazily.
- Produces, in `backend/worksheets_endo.py`:
  - Constants: `ENDO_PREP_VALUES`, `ENDO_FORMS`, `ENDO_CARTRIDGE`, `CARTRIDGE_REFUSED`.
  - Functions: `parse_reading(text) -> tuple[bool, float]`, `validate_prep_steps(value) -> list`, `resolve_endo_method(db, worksheet) -> Optional[dict]`, `allowed_cartridge_ids(db, worksheet) -> set[int]`, `pin_endo_method(db, worksheet, user_id) -> bool`, `instrument_id_for_serial(db, serial) -> Optional[int]`, `cartridge_sensitivities(db, ids) -> dict[int, Optional[float]]`.
- Produces, the `endo_method` shape: `{"id", "name", "revision", "status", "run_parameters", "cartridges": [{"id", "name", "sensitivity_eu_ml", "is_default", "active"}]}`.
  - `run_parameters` is the method's stored column as is: `{"endotoxin": {...}}` or `null`. The browser fills in missing keys from `ENDO_RUN_PARAM_DEFAULTS`.
  - `cartridges` lists every `endo_cartridge` link on the method, retired ones included (`active: false`).
  - Allowed cartridges: a method that links one or more allows only its active ones. A method that links none falls back to every active endo cartridge, with no default, the same as when no method resolves (lead decision 2026-10-10).
- Produces, serializer keys on every worksheet: `endo_prep`, `cartridge_type_id`, `cartridge_sensitivity_eu_ml`, `endo_method_id`. `endo_method` appears on `GET /worksheets/{id}` only.
- Produces, serializer keys on every item: `prep_form`, `prep_water_ml`, `prep_total_dilution`, `prep_steps`, `cartridge_type_id`, `cartridge_sensitivity_eu_ml`, `result_reading`, `result_reader`, `result_entered_at` (ISO + "Z"), `result_entered_by_user_id`.
- Produces, `PUT /worksheets/{id}`: accepts `endo_prep` and `cartridge_type_id`. Either one, when sent, gets a 409 on a completed worksheet and an audit row (`endo_prep_set` / `endo_cartridge_set`) with `old` and `new`.
- Produces, `POST /worksheets/{id}/printed`: also pins the method (audit `endo_method_pinned`).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_endo_v2_worksheets.py`:

```python
"""Endo worksheet v2 on the server (spec
docs/superpowers/specs/2026-10-10-endo-worksheet-v2-design.md, sections 3.6,
3.7, 4 and 8 to 10): the run and row fields, the worksheet's endo method
(resolved in a fixed number of queries, pinned at first print or first
reading) and the reader import. In-memory SQLite + dependency overrides, no
live stack; the test_worksheet_endo_prep.py pattern."""
import json
from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import worksheets_endo
from auth import get_current_user
from database import Base, get_db
from main import app
from models import (
    AnalysisService, AuditLog, ConsumableType, HplcMethod, Instrument, LimsAnalysis,
    LimsSample, LimsSubSample, Worksheet, WorksheetItem, method_consumables,
)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


# --- Task 5: reading and step grammar ----------------------------------------


@pytest.mark.parametrize("text, expected", [
    ("0.8", (False, 0.8)),
    ("0", (False, 0.0)),
    (".5", (False, 0.5)),
    ("<0.05", (True, 0.05)),
    ("< 0.05", (True, 0.05)),
    (" 0.8 ", (False, 0.8)),
])
def test_parse_reading_accepts_the_instrument_display(text, expected):
    assert worksheets_endo.parse_reading(text) == expected


@pytest.mark.parametrize("text", [
    "", "   ", "abc", "0,8", "-1", "<0", "< 0", "1.", "1e3", "0.8 EU", "1" * 41,
])
def test_parse_reading_refuses_anything_else_with_a_reason(text):
    with pytest.raises(ValueError, match="reading"):
        worksheets_endo.parse_reading(text)


def test_validate_prep_steps_keeps_standard_and_own_values():
    assert worksheets_endo.validate_prep_steps([None, None, None]) == [None, None, None]
    assert worksheets_endo.validate_prep_steps([[20, 5], [30], None]) == [[20, 5], [30], None]
    # A null field inside a step means "standard" for that field (Dennis's stepsOf).
    assert worksheets_endo.validate_prep_steps([[None, 4], None, [100]]) == [[None, 4], None, [100]]


@pytest.mark.parametrize("bad", [
    "steps",
    [],
    [None, None],
    [None, None, None, None],
    [[], None, None],
    [[0, 10], None, None],          # sample uL must be above zero
    [[20, 0.5], None, None],        # step 1 ratio below 1
    [None, [20, 3], None],          # only step 1 carries a ratio
    [None, None, [-5]],
    [["20"], None, None],
    [[True], None, None],
    [[float("inf")], None, None],
    [{"sampleUl": 20}, None, None],
])
def test_validate_prep_steps_refuses_malformed_values(bad):
    with pytest.raises(ValueError):
        worksheets_endo.validate_prep_steps(bad)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_endo_v2_worksheets.py -q`
Expected: collection error, `ModuleNotFoundError: No module named 'worksheets_endo'`.

- [ ] **Step 3: Implement the module with the grammar helpers**

Create `backend/worksheets_endo.py`:

```python
"""Endotoxin worksheet v2 on the server (spec
docs/superpowers/specs/2026-10-10-endo-worksheet-v2-design.md, sections 3.6,
3.7, 4 and 10).

This module holds the values the run and row fields accept, the worksheet's
endo method, its allowed cartridges and the reader-serial lookup. The method
is resolved in a fixed number of queries and pinned at first print or first
reading. The 2 mL maths runs in the browser (src/lib/endo-prep-2ml.ts). The
server validates and stores what the bench typed or the reader exported. It
never writes a method onto analyses or worksheet items."""
import math
import re
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import (
    AuditLog, ConsumableType, HplcMethod, Instrument, LimsAnalysis, LimsSubSample,
    WorksheetItem, method_consumables, method_services,
)

ENDO_PREP_VALUES = ("2ml", "stock")
ENDO_FORMS = ("powder", "liquid", "bac")
# The consumable kind a worksheet's cartridges come from (catalog/consumables.py).
ENDO_CARTRIDGE = "endo_cartridge"
CARTRIDGE_REFUSED = ("That cartridge is retired, not an endotoxin cartridge, "
                     "or not allowed by this worksheet's method")
# worksheet_items.result_reading is String(40); Postgres refuses longer text.
_READING_MAX = 40
# Dead rows never speak for a vial: a retracted original keeps its old service
# while the current retest row carries the live one.
_DEAD_STATES = ("rejected", "retracted")


def parse_reading(text: str) -> tuple[bool, float]:
    """The instrument's display as typed: "0.8", "0", "<0.05" or "< 0.05".
    Returns (is_less_than, value). Raises ValueError with a readable reason.
    Same grammar as Dennis's parseResult (calc.js at 5ef2a62): whitespace is
    ignored, then an optional "<" and a plain decimal. A "<" needs a value
    above zero (spec 3.7)."""
    s = (text or "").strip()
    if not s:
        raise ValueError("A reading cannot be empty; send null to clear it")
    if len(s) > _READING_MAX:
        raise ValueError(f"A reading is at most {_READING_MAX} characters")
    m = re.fullmatch(r"(<)?([0-9]*\.?[0-9]+)", re.sub(r"\s+", "", s))
    if not m:
        raise ValueError(f"'{s}' is not a reading: type a number such as 0.8, "
                         "or < and a number such as <0.05")
    lt, value = bool(m.group(1)), float(m.group(2))
    if lt and value <= 0:
        raise ValueError("A '<' reading needs a number above zero, such as <0.05")
    return lt, value


def validate_prep_steps(value) -> list:
    """A row's own step values (spec 3.7): exactly three entries, one per
    step. Each entry is null (standard), or [sample_ul, ratio] for step 1 and
    [sample_ul] for steps 2 and 3. A null field inside an entry means standard
    for that field. sample_ul > 0; step 1 ratio >= 1. Raises ValueError."""
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError("prep_steps needs exactly three entries, one per step")
    for i, entry in enumerate(value, start=1):
        if entry is None:
            continue
        width = 2 if i == 1 else 1
        if not isinstance(entry, list) or not 1 <= len(entry) <= width:
            shape = "[sample_ul, ratio]" if i == 1 else "[sample_ul]"
            raise ValueError(f"prep_steps step {i} must be {shape} or null")
        for v in entry:
            if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float))
                                  or not math.isfinite(v)):
                raise ValueError(f"prep_steps step {i} values must be numbers or null")
        if entry[0] is not None and entry[0] <= 0:
            raise ValueError(f"prep_steps step {i}: sample uL must be greater than zero")
        if i == 1 and len(entry) == 2 and entry[1] is not None and entry[1] < 1:
            raise ValueError("prep_steps step 1: ratio must be at least 1")
    return value
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_endo_v2_worksheets.py -q`
Expected: all pass (6 + 11 + 1 + 13 parametrized cases).

- [ ] **Step 5: Write the failing test for resolution, pinning and the serializer**

Append to `backend/tests/test_endo_v2_worksheets.py`:

```python
# --- Task 5: method resolution, pinning, serializer -------------------------


def _cartridge(db, name, sensitivity, *, kind="endo_cartridge", active=True):
    ct = ConsumableType(kind=kind, name=name, active=active, origin="mk1",
                        specs={"sensitivity_eu_ml": sensitivity} if sensitivity is not None else {})
    db.add(ct)
    db.flush()
    return ct


def _service(db, keyword="ENDOTOXIN-USP85LAL"):
    svc = AnalysisService(title=f"Endotoxin ({keyword})", keyword=keyword, origin="mk1",
                          active=True, variance_capable=False)
    db.add(svc)
    db.flush()
    return svc


def _method(client, db, name, service, cartridges=(), run_parameters=None):
    """An active method, the default for `service`, allowing `cartridges`
    ((type, is_default) pairs). The links go in while it is a draft, because
    method consumables are draft-only (Task 3)."""
    mid = client.post("/hplc/methods", json={"name": name, "technique": "LAL"}).json()["id"]
    for ct, is_default in cartridges:
        db.execute(method_consumables.insert().values(
            method_id=mid, consumable_type_id=ct.id, kind=ct.kind, is_default=is_default))
    if run_parameters is not None:
        db.get(HplcMethod, mid).run_parameters = run_parameters
    db.commit()
    client.put(f"/hplc/methods/{mid}/services",
               json=[{"analysis_service_id": service.id, "is_default": True}])
    assert client.post(f"/hplc/methods/{mid}/activate").status_code == 200
    return mid


def _ws(db, title="Endo 10/09/2026", status="open"):
    ws = Worksheet(title=title, status=status)
    db.add(ws)
    db.flush()
    return ws


def _vial_item(db, ws, n, service, *, state="assigned", role="endo85"):
    """Vial P-3001-S<n> on `ws`, with one analysis on `service` in `state`."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == "P-3001")).scalar_one_or_none()
    if parent is None:
        parent = LimsSample(sample_id="P-3001", external_lims_uid="SEN-P-3001",
                            declared_total_quantity="10.00", sample_type_title="Peptide",
                            analytes=json.dumps([{"name": "BPC-157", "declared_quantity": None}]))
        db.add(parent)
        db.flush()
    vial = LimsSubSample(sample_id=f"P-3001-S{n:02d}", parent_sample_pk=parent.id,
                         vial_sequence=n, external_lims_uid=f"mk1://endo-{n}",
                         assignment_role=role)
    db.add(vial)
    db.flush()
    row = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=service.id,
                       keyword=service.keyword, title=service.title, review_state=state,
                       provenance="canonical")
    item = WorksheetItem(worksheet_id=ws.id, sample_uid=vial.external_lims_uid,
                         sample_id=vial.sample_id)
    db.add_all([row, item])
    db.flush()
    return item, row


@contextmanager
def _count_sql(db):
    """Every SQL statement the session's engine runs inside the block (the
    counter in test_flags_context_batch.py)."""
    seen: list[str] = []

    def _on(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", _on)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", _on)


_WS_KEYS = ("endo_prep", "cartridge_type_id", "cartridge_sensitivity_eu_ml", "endo_method_id")
_ITEM_KEYS = ("prep_form", "prep_water_ml", "prep_total_dilution", "prep_steps",
              "cartridge_type_id", "cartridge_sensitivity_eu_ml", "result_reading",
              "result_reader", "result_entered_at", "result_entered_by_user_id")


def test_worksheet_and_item_carry_the_new_keys(client, db):
    ws = _ws(db)
    _vial_item(db, ws, 1, _service(db))
    db.commit()
    body = client.get(f"/worksheets/{ws.id}").json()
    assert {k: body[k] for k in _WS_KEYS} == {
        "endo_prep": "2ml", "cartridge_type_id": None,
        "cartridge_sensitivity_eu_ml": None, "endo_method_id": None}
    assert body["endo_method"] is None
    assert {k: body["items"][0][k] for k in _ITEM_KEYS} == dict.fromkeys(_ITEM_KEYS)
    listed = client.get("/worksheets").json()[0]
    assert {k: listed[k] for k in _WS_KEYS} == {k: body[k] for k in _WS_KEYS}
    # The list endpoint never resolves the method (spec 4.1, cost).
    assert "endo_method" not in listed


def test_endo_method_resolves_to_the_single_active_default_method(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    _cartridge(db, "Endosafe 0.005", 0.005)  # active, but not on the method
    mid = _method(client, db, "Endotoxin", svc, [(c05, True), (c01, False)],
                  run_parameters={"endotoxin": {"cv_limit_pct": 20}})
    # An HPLC row on the same worksheet has its own method; only endo rows count.
    hplc_svc = _service(db, "BPC157-PURITY")
    _method(client, db, "BPC-157 purity", hplc_svc)
    ws = _ws(db)
    _vial_item(db, ws, 1, svc)
    _vial_item(db, ws, 2, svc)
    _vial_item(db, ws, 3, hplc_svc, role="hplc")
    db.commit()

    method = client.get(f"/worksheets/{ws.id}").json()["endo_method"]
    assert {k: method[k] for k in ("id", "name", "revision", "status")} == {
        "id": mid, "name": "Endotoxin", "revision": 1, "status": "active"}
    # The stored column as is; the browser fills missing keys with Dennis's values.
    assert method["run_parameters"] == {"endotoxin": {"cv_limit_pct": 20}}
    assert sorted((c["name"], c["sensitivity_eu_ml"], c["is_default"], c["active"])
                  for c in method["cartridges"]) == [
        ("Endosafe 0.01", 0.01, False, True), ("Endosafe 0.05", 0.05, True, True)]
    # A method that lists cartridges restricts the choice to them.
    assert worksheets_endo.allowed_cartridge_ids(db, ws) == {c05.id, c01.id}


def test_a_method_that_lists_no_cartridges_allows_every_active_endo_cartridge(client, db):
    # Before the lab links cartridges to the method (spec 12, launch step 3)
    # the bench is not blocked: same fallback as when no method resolves.
    svc = _service(db)
    mid = _method(client, db, "Endotoxin", svc)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    _cartridge(db, "Endosafe retired", 0.05, active=False)
    _cartridge(db, "Pipette tip", None, kind="pipette_tip")
    ws = _ws(db)
    _vial_item(db, ws, 1, svc)
    db.commit()
    method = client.get(f"/worksheets/{ws.id}").json()["endo_method"]
    assert method["id"] == mid
    assert method["cartridges"] == []  # so no default either
    assert worksheets_endo.allowed_cartridge_ids(db, ws) == {c05.id, c01.id}


def test_endo_method_is_null_when_rows_disagree_or_any_row_resolves_nothing(client, db):
    svc_a = _service(db, "ENDOTOXIN-USP85LAL")
    svc_b = _service(db, "ENDO-LAL")
    no_method = _service(db, "ENDO-NOMETHOD")
    _method(client, db, "Endotoxin", svc_a)
    _method(client, db, "Endotoxin legacy", svc_b)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    _cartridge(db, "Endosafe retired", 0.05, active=False)
    _cartridge(db, "Pipette tip", None, kind="pipette_tip")
    mixed = _ws(db, "Two methods")
    _vial_item(db, mixed, 1, svc_a)
    _vial_item(db, mixed, 2, svc_b)
    partial = _ws(db, "One row without a method")
    _vial_item(db, partial, 3, svc_a)
    _vial_item(db, partial, 4, no_method)
    bare = _ws(db, "No method")
    _vial_item(db, bare, 5, no_method)
    empty = _ws(db, "No rows")
    db.commit()

    for ws in (mixed, partial, bare, empty):
        assert client.get(f"/worksheets/{ws.id}").json()["endo_method"] is None, ws.title
        # No method: every active endotoxin cartridge is allowed (spec 4.3).
        assert worksheets_endo.allowed_cartridge_ids(db, ws) == {c05.id}, ws.title


def test_a_retested_vial_resolves_through_its_current_row(client, db):
    # The retracted original's service has a different default method. Read
    # through it, the worksheet would look mixed and resolve to nothing.
    old_svc = _service(db, "ENDO-LAL")
    new_svc = _service(db, "ENDOTOXIN-USP85LAL")
    _method(client, db, "Endotoxin legacy", old_svc)
    current = _method(client, db, "Endotoxin", new_svc)
    ws = _ws(db)
    _item, old_row = _vial_item(db, ws, 1, old_svc, state="retracted")
    old_row.retested = True
    db.add(LimsAnalysis(lims_sub_sample_pk=old_row.lims_sub_sample_pk,
                        analysis_service_id=new_svc.id, keyword=new_svc.keyword,
                        title=new_svc.title, review_state="unassigned",
                        provenance="canonical", retest_of_id=old_row.id))
    db.commit()
    assert client.get(f"/worksheets/{ws.id}").json()["endo_method"]["id"] == current


def test_endo_method_resolution_is_batched_not_per_item(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    _method(client, db, "Endotoxin", svc, [(c05, True)])
    small, big = _ws(db, "Small"), _ws(db, "Big")
    for n in range(1, 4):
        _vial_item(db, small, n, svc)
    for n in range(4, 16):
        _vial_item(db, big, n, svc)
    db.commit()

    counts = []
    for ws_id in (small.id, big.id):
        db.expunge_all()
        ws = db.execute(select(Worksheet).where(Worksheet.id == ws_id)).scalar_one()
        with _count_sql(db) as seen:
            assert worksheets_endo.resolve_endo_method(db, ws)["name"] == "Endotoxin"
        counts.append(len(seen))
    # Items with their vials, live analyses, default methods, the method, its cartridges.
    assert counts[0] == counts[1] <= 5, counts


def test_a_pinned_worksheet_keeps_its_revision_after_a_new_one_is_activated(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    rev1 = _method(client, db, "Endotoxin", svc, [(c05, True)],
                   run_parameters={"endotoxin": {"std_total_dilution": 250}})
    printed, control = _ws(db, "Printed"), _ws(db, "Not printed yet")
    _vial_item(db, printed, 1, svc)
    _vial_item(db, control, 2, svc)
    db.commit()
    assert client.post(f"/worksheets/{printed.id}/printed").status_code == 200

    rev2 = client.post(f"/hplc/methods/{rev1}/new-revision").json()["id"]
    db.execute(method_consumables.delete().where(method_consumables.c.method_id == rev2))
    db.execute(method_consumables.insert().values(
        method_id=rev2, consumable_type_id=c01.id, kind=c01.kind, is_default=True))
    db.get(HplcMethod, rev2).run_parameters = {"endotoxin": {"std_total_dilution": 500}}
    db.commit()
    assert client.post(f"/hplc/methods/{rev2}/activate").status_code == 200

    pinned = client.get(f"/worksheets/{printed.id}").json()
    assert pinned["endo_method_id"] == rev1
    assert (pinned["endo_method"]["id"], pinned["endo_method"]["status"]) == (rev1, "retired")
    assert pinned["endo_method"]["run_parameters"] == {"endotoxin": {"std_total_dilution": 250}}
    assert [c["id"] for c in pinned["endo_method"]["cartridges"]] == [c05.id]
    floating = client.get(f"/worksheets/{control.id}").json()
    assert floating["endo_method_id"] is None
    assert (floating["endo_method"]["id"], floating["endo_method"]["revision"]) == (rev2, 2)
    assert [c["id"] for c in floating["endo_method"]["cartridges"]] == [c01.id]


def test_the_first_print_pins_the_method_once(client, db):
    svc = _service(db)
    mid = _method(client, db, "Endotoxin", svc)
    ws = _ws(db)
    _vial_item(db, ws, 1, svc)
    unresolved = _ws(db, "No method")
    _vial_item(db, unresolved, 2, _service(db, "ENDO-NOMETHOD"))
    done = _ws(db, "Completed", status="completed")
    _vial_item(db, done, 3, svc)
    db.commit()

    for _ in range(2):
        assert client.post(f"/worksheets/{ws.id}/printed").status_code == 200
    db.refresh(ws)
    assert ws.endo_method_id == mid
    pins = db.query(AuditLog).filter(AuditLog.operation == "endo_method_pinned").all()
    assert [(p.entity_id, p.details) for p in pins] == [
        (str(ws.id), {"user_id": 1, "old": None, "new": mid})]
    assert client.get(f"/worksheets/{ws.id}").json()["endo_method_id"] == mid

    # Nothing resolves: nothing is pinned. A completed worksheet is read-only.
    for other in (unresolved, done):
        assert client.post(f"/worksheets/{other.id}/printed").status_code == 200
        db.refresh(other)
        assert other.endo_method_id is None, other.title
    assert db.query(AuditLog).filter(AuditLog.operation == "endo_method_pinned").count() == 1


def test_a_retired_cartridge_in_use_still_serializes_with_its_sensitivity(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    _method(client, db, "Endotoxin", svc, [(c05, True)])
    ws = _ws(db)
    item, _ = _vial_item(db, ws, 1, svc)
    ws.cartridge_type_id = c05.id
    item.cartridge_type_id = c05.id
    db.commit()
    c05.active = False  # retired after the run used it
    db.commit()

    body = client.get(f"/worksheets/{ws.id}").json()
    assert (body["cartridge_type_id"], body["cartridge_sensitivity_eu_ml"]) == (c05.id, 0.05)
    assert body["items"][0]["cartridge_sensitivity_eu_ml"] == 0.05
    assert body["endo_method"]["cartridges"] == [
        {"id": c05.id, "name": "Endosafe 0.05", "sensitivity_eu_ml": 0.05,
         "is_default": True, "active": False}]
    listed = next(r for r in client.get("/worksheets").json() if r["id"] == ws.id)
    assert listed["cartridge_sensitivity_eu_ml"] == 0.05
    assert listed["items"][0]["cartridge_sensitivity_eu_ml"] == 0.05
    # Gone from the picker: no new run or row can choose it.
    assert worksheets_endo.allowed_cartridge_ids(db, ws) == set()


def test_instrument_id_for_serial_matches_active_instruments_only(db):
    live = Instrument(name="Nexgen-MCS 1", origin="mk1", active=True, serial_number="NX-1001")
    gone = Instrument(name="Nexgen-MCS old", origin="mk1", active=False, serial_number="NX-0999")
    db.add_all([live, gone])
    db.commit()
    assert worksheets_endo.instrument_id_for_serial(db, " NX-1001 ") == live.id
    assert worksheets_endo.instrument_id_for_serial(db, "NX-0999") is None
    assert worksheets_endo.instrument_id_for_serial(db, "NX-4040") is None
    assert worksheets_endo.instrument_id_for_serial(db, "") is None
    assert worksheets_endo.instrument_id_for_serial(db, None) is None
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_endo_v2_worksheets.py -q`
Expected: the Step 1 tests still pass. The new tests fail with `KeyError: 'endo_prep'` / `KeyError: 'endo_method'`, or `AttributeError: module 'worksheets_endo' has no attribute 'allowed_cartridge_ids'` (and `resolve_endo_method`, `instrument_id_for_serial`).

- [ ] **Step 7: Implement resolution, pinning and lookups in `worksheets_endo.py`**

Append to `backend/worksheets_endo.py`:

```python
def _endo_method_id(db: Session, worksheet_id: int) -> Optional[int]:
    """The one active default method behind every endo row's vial (spec 4.1),
    or None.

    Three queries whatever the row count: the rows with their vials, the
    vials' live analyses, then those services' active default methods. Never
    per item: a per-item lookup in the shared serializer is the fan-out class
    behind the 2026-09-15 pool outage. The rule is strict. A worksheet with
    no endo rows, an endo row with no vial (a legacy bare parent id), a vial
    with no live analysis, or a service with no active default method all
    resolve to None. So do two rows that disagree."""
    from main import _bench_kind_for_item  # lazy: main imports this module too

    rows = db.execute(
        select(WorksheetItem.analyses_json, LimsSubSample.id.label("vial_pk"),
               LimsSubSample.assignment_role)
        .outerjoin(LimsSubSample, LimsSubSample.sample_id == WorksheetItem.sample_id)
        .where(WorksheetItem.worksheet_id == worksheet_id)
    ).all()
    vial_pks = {r.vial_pk for r in rows
                if _bench_kind_for_item(r.assignment_role, r.analyses_json) == "endo"}
    if not vial_pks or None in vial_pks:
        return None
    services_by_vial: dict[int, set[int]] = {pk: set() for pk in vial_pks}
    for pk, service_id in db.execute(
        select(LimsAnalysis.lims_sub_sample_pk, LimsAnalysis.analysis_service_id).where(
            LimsAnalysis.lims_sub_sample_pk.in_(vial_pks),
            # The vial-row "current" idiom: the newest row of a retest chain.
            LimsAnalysis.retested.is_(False),
            LimsAnalysis.review_state.notin_(_DEAD_STATES),
        )
    ).all():
        services_by_vial[pk].add(service_id)
    if not all(services_by_vial.values()):
        return None
    method_by_service = dict(db.execute(
        select(method_services.c.analysis_service_id, method_services.c.method_id)
        .join(HplcMethod, HplcMethod.id == method_services.c.method_id)
        .where(method_services.c.analysis_service_id.in_(set().union(*services_by_vial.values())),
               method_services.c.is_default.is_(True),
               HplcMethod.status == "active")
    ).all())
    methods = {method_by_service.get(s) for services in services_by_vial.values() for s in services}
    return methods.pop() if len(methods) == 1 and None not in methods else None


def _method_payload(db: Session, method_id: int) -> Optional[dict]:
    """The endo_method wire shape: the revision, its stored run_parameters
    (as is; the browser applies Dennis's defaults to missing keys) and every
    endo cartridge linked to it, retired ones included. Two queries."""
    method = db.execute(select(HplcMethod).where(HplcMethod.id == method_id)).scalar_one_or_none()
    if method is None:
        return None
    links = db.execute(
        select(ConsumableType, method_consumables.c.is_default)
        .join(method_consumables, method_consumables.c.consumable_type_id == ConsumableType.id)
        .where(method_consumables.c.method_id == method.id,
               ConsumableType.kind == ENDO_CARTRIDGE)
        .order_by(ConsumableType.name)
    ).all()
    return {
        "id": method.id,
        "name": method.name,
        "revision": method.revision,
        "status": method.status,
        "run_parameters": method.run_parameters,
        "cartridges": [
            {"id": ct.id, "name": ct.name,
             "sensitivity_eu_ml": (ct.specs or {}).get("sensitivity_eu_ml"),
             "is_default": bool(is_default), "active": ct.active}
            for ct, is_default in links
        ],
    }


def resolve_endo_method(db: Session, worksheet) -> Optional[dict]:
    """The worksheet's endo method (spec 4.1). This is the pinned revision
    when there is one, else the single active default method every endo row
    resolves to, else None. At most five queries. Callers: GET
    /worksheets/{id}, the item PATCH and the reader import, never a list."""
    method_id = worksheet.endo_method_id or _endo_method_id(db, worksheet.id)
    return _method_payload(db, method_id) if method_id else None


def allowed_cartridge_ids(db: Session, worksheet) -> set[int]:
    """Cartridges a run or a row may choose (spec 4.3). A method that lists
    one or more endo cartridges allows only its active ones. When no method
    resolves (the legacy ENDO-LAL test, say), or the method lists none yet
    (lead decision 2026-10-10), every active endo cartridge is allowed."""
    method = resolve_endo_method(db, worksheet)
    if method is not None and method["cartridges"]:
        return {c["id"] for c in method["cartridges"] if c["active"]}
    return set(db.execute(select(ConsumableType.id).where(
        ConsumableType.kind == ENDO_CARTRIDGE, ConsumableType.active.is_(True))).scalars())


def pin_endo_method(db: Session, worksheet, user_id: Optional[int]) -> bool:
    """Store the resolved method revision on the worksheet at its first print
    or first reading (spec 4.1). After that its run parameters and cartridges
    never move. A no-op when already pinned, when nothing resolves, or on a
    completed worksheet (read-only). Callers commit."""
    if worksheet.endo_method_id is not None or worksheet.status == "completed":
        return False
    method_id = _endo_method_id(db, worksheet.id)
    if method_id is None:
        return False
    worksheet.endo_method_id = method_id
    db.add(AuditLog(
        operation="endo_method_pinned",
        entity_type="worksheet",
        entity_id=str(worksheet.id),
        details={"user_id": user_id, "old": None, "new": method_id},
    ))
    return True


def instrument_id_for_serial(db: Session, serial) -> Optional[int]:
    """The active instrument a reader record's serial names (spec 4.5), or
    None. serial_number is unique where set (Task 4)."""
    s = serial.strip() if isinstance(serial, str) else ""
    if not s:
        return None
    return db.execute(select(Instrument.id).where(
        Instrument.serial_number == s, Instrument.active.is_(True))).scalar_one_or_none()


def cartridge_sensitivities(db: Session, ids) -> dict[int, Optional[float]]:
    """Sensitivity (EU/mL) per consumable type id, retired types included,
    because a result keeps the cartridge it was computed with. ONE query for
    a whole page of worksheets."""
    if not ids:
        return {}
    return {
        r.id: (r.specs or {}).get("sensitivity_eu_ml")
        for r in db.execute(select(ConsumableType.id, ConsumableType.specs)
                            .where(ConsumableType.id.in_(ids))).all()
    }
```

- [ ] **Step 8: Implement the serializer keys, the single-GET method and the print pin in `main.py`**

In `_serialize_worksheets` (`backend/main.py`), insert immediately before the existing lines

```python
    result = []
    for ws in worksheets:
        items = items_by_ws.get(ws.id, [])
```

this block:

```python
    # Endo v2 (spec 2026-10-10 section 4.3): each referenced cartridge's
    # sensitivity, retired types included. ONE query for the whole page.
    from worksheets_endo import cartridge_sensitivities
    sensitivity_by_type = cartridge_sensitivities(
        db,
        {ws.cartridge_type_id for ws in worksheets if ws.cartridge_type_id}
        | {it.cartridge_type_id for it in all_items if it.cartridge_type_id},
    )

```

In the worksheet dict of the same function, after `"note_log": notes_by_ws.get(ws.id, []),` add:

```python
            # Endo v2 run fields (spec 3.6). The sensitivity is the run
            # cartridge's own; the method's default is on endo_method.
            "endo_prep": ws.endo_prep,
            "cartridge_type_id": ws.cartridge_type_id,
            "cartridge_sensitivity_eu_ml": sensitivity_by_type.get(ws.cartridge_type_id),
            "endo_method_id": ws.endo_method_id,
```

In the item dict, after `"well_pos": it.well_pos,` (before `**_worksheet_item_parent_facts(...)`) add:

```python
                    # Endo v2 row fields (spec 3.7).
                    "prep_form": it.prep_form,
                    "prep_water_ml": it.prep_water_ml,
                    "prep_total_dilution": it.prep_total_dilution,
                    "prep_steps": it.prep_steps,
                    "cartridge_type_id": it.cartridge_type_id,
                    "cartridge_sensitivity_eu_ml": sensitivity_by_type.get(it.cartridge_type_id),
                    "result_reading": it.result_reading,
                    "result_reader": it.result_reader,
                    "result_entered_at": (it.result_entered_at.isoformat() + "Z") if it.result_entered_at else None,
                    "result_entered_by_user_id": it.result_entered_by_user_id,
```

In `get_worksheet_by_id`, replace the final line `return _serialize_worksheets(db, [ws])[0]` with:

```python
    out = _serialize_worksheets(db, [ws])[0]
    # Endo v2 (spec 4.1): the worksheet's endo method, on this single GET only.
    # The list endpoints never resolve it (a fixed number of queries per call).
    from worksheets_endo import resolve_endo_method
    out["endo_method"] = resolve_endo_method(db, ws)
    return out
```

In `record_worksheet_printed`, after `ws.print_count = (ws.print_count or 0) + 1` add:

```python
    # Endo v2 (spec 4.1): the first print is the bench start, so it pins the
    # worksheet's endo method revision (a no-op once pinned or unresolvable).
    from worksheets_endo import pin_endo_method
    pin_endo_method(db, ws, _current_user.id)
```

- [ ] **Step 9: Update the stale by-id parity test**

In `backend/tests/test_worksheets_list_sync.py`, `test_get_worksheet_by_id_matches_list_shape`, replace

```python
    single = client.get(f"/worksheets/{ws.id}")
    assert single.status_code == 200
    assert single.json() == list_entry
```

with

```python
    single = client.get(f"/worksheets/{ws.id}")
    assert single.status_code == 200
    body = single.json()
    # Endo v2 (spec 4.1): the single GET alone adds the worksheet's endo method;
    # every other key stays the exact list shape.
    assert body.pop("endo_method") is None
    assert body == list_entry
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_endo_v2_worksheets.py -q`
Expected: all pass.
Run: `cd backend && python -m pytest tests/test_worksheet_endo_prep.py tests/test_worksheets_list_sync.py tests/test_worksheet_pcr_wells.py tests/test_worksheet_notes.py -q`
Expected: all pass. These include the anti-N+1 pin `test_list_worksheets_query_count_constant_in_worksheet_count`, which is unchanged: the sensitivity query is skipped when nothing references a cartridge.

- [ ] **Step 11: Write the failing test for the run fields on PUT**

Append to `backend/tests/test_endo_v2_worksheets.py`:

```python
# --- Task 5: run fields on PUT /worksheets/{id} -----------------------------


def test_put_run_fields_validate_audit_and_lock_on_completion(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    off_method = _cartridge(db, "Endosafe 0.005", 0.005)
    tip = _cartridge(db, "Pipette tip", None, kind="pipette_tip")
    _method(client, db, "Endotoxin", svc, [(c05, True), (c01, False), (tip, False)])
    ws = _ws(db)
    _vial_item(db, ws, 1, svc)
    db.commit()
    url = f"/worksheets/{ws.id}"

    r = client.put(url, json={"endo_prep": "stock", "cartridge_type_id": c01.id})
    assert r.status_code == 200, r.text
    db.refresh(ws)
    assert (ws.endo_prep, ws.cartridge_type_id) == ("stock", c01.id)
    # Null clears the run cartridge; the method default applies again.
    assert client.put(url, json={"cartridge_type_id": None}).status_code == 200
    db.refresh(ws)
    assert ws.cartridge_type_id is None
    assert [(a.operation, a.details["old"], a.details["new"]) for a in db.query(AuditLog)
            .filter(AuditLog.entity_type == "worksheet").order_by(AuditLog.id)] == [
        ("endo_prep_set", "2ml", "stock"),
        ("endo_cartridge_set", None, c01.id),
        ("endo_cartridge_set", c01.id, None)]

    # An unknown prep; a cartridge off the method, of another kind, or missing.
    for bad in ({"endo_prep": "1mg"}, {"endo_prep": None}, {"cartridge_type_id": off_method.id},
                {"cartridge_type_id": tip.id}, {"cartridge_type_id": 99999}):
        assert client.put(url, json=bad).status_code == 400, bad
    c05.active = False  # retired
    db.commit()
    assert client.put(url, json={"cartridge_type_id": c05.id}).status_code == 400

    ws.status = "completed"
    db.commit()
    assert client.put(url, json={"endo_prep": "2ml"}).status_code == 409
    # The older fields keep today's behaviour on a completed worksheet.
    assert client.put(url, json={"title": "Endo 10/09/2026 (done)"}).status_code == 200
    db.refresh(ws)
    assert (ws.endo_prep, ws.title) == ("stock", "Endo 10/09/2026 (done)")
```

- [ ] **Step 12: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_endo_v2_worksheets.py -q -k put_run_fields`
Expected: FAIL at `assert (ws.endo_prep, ws.cartridge_type_id) == ("stock", ...)`, because pydantic drops the unknown keys and the PUT still answers 200.

- [ ] **Step 13: Implement the run fields on `PUT /worksheets/{id}`**

In `backend/main.py`, extend `WorksheetUpdate` after `bench_config: Optional[dict] = None`:

```python
    # Endo v2 run fields (spec 3.6 and 10). Sent = set (null clears the run
    # cartridge); omitted = untouched. 409 on a completed worksheet.
    endo_prep: Optional[str] = None
    cartridge_type_id: Optional[int] = None
```

In `update_worksheet`, insert between the 404 (`if not ws: raise HTTPException(404, "Worksheet not found")`) and `if data.title is not None:`:

```python
    # Endo v2 run fields, checked before anything is written. A completed
    # worksheet refuses them; the older fields keep today's behaviour.
    run_fields = [f for f in ("endo_prep", "cartridge_type_id") if f in data.model_fields_set]
    if run_fields:
        from worksheets_endo import CARTRIDGE_REFUSED, ENDO_PREP_VALUES, allowed_cartridge_ids
        if ws.status == "completed":
            raise HTTPException(409, "Worksheet is completed")
        if "endo_prep" in run_fields and data.endo_prep not in ENDO_PREP_VALUES:
            raise HTTPException(400, f"endo_prep must be one of {', '.join(ENDO_PREP_VALUES)}")
        if data.cartridge_type_id is not None and data.cartridge_type_id not in allowed_cartridge_ids(db, ws):
            raise HTTPException(400, CARTRIDGE_REFUSED)

```

Then replace

```python
    if data.bench_config is not None:
        ws.bench_config = data.bench_config

    db.commit()
    return {"status": "updated"}
```

with

```python
    if data.bench_config is not None:
        ws.bench_config = data.bench_config
    for field, operation in (("endo_prep", "endo_prep_set"),
                             ("cartridge_type_id", "endo_cartridge_set")):
        new = getattr(data, field)
        if field in run_fields and getattr(ws, field) != new:
            db.add(AuditLog(
                operation=operation,
                entity_type="worksheet",
                entity_id=str(ws.id),
                details={"user_id": getattr(_current_user, "id", None),
                         "old": getattr(ws, field), "new": new},
            ))
            setattr(ws, field, new)

    db.commit()
    return {"status": "updated"}
```

- [ ] **Step 14: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_endo_v2_worksheets.py tests/test_worksheet_pcr_wells.py -q`
Expected: all pass. The PCR file covers the untouched `bench_config` PUT.

- [ ] **Step 15: Commit**

```bash
git add backend/worksheets_endo.py backend/tests/test_endo_v2_worksheets.py
git commit -m "feat(endo-v2): worksheet run fields, endo method resolution and pinning" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/worksheets_endo.py backend/main.py backend/tests/test_endo_v2_worksheets.py backend/tests/test_worksheets_list_sync.py
```

---

### Task 6: Row fields on the item PATCH (prep, cartridge, reading)

**Files:**
- Modify: `backend/worksheets_endo.py` (add `ENDO_ITEM_FIELDS`, `check_item_endo_fields`, `apply_item_endo_fields`).
- Modify: `backend/main.py`: `WorksheetItemUpdate` (six fields) and `update_worksheet_item` (completed guard, validation before any write, apply, `endo_method` in the response).
- Test: Modify `backend/tests/test_endo_v2_worksheets.py` (append).

**Interfaces:**
- Consumes (Task 5): `parse_reading`, `validate_prep_steps`, `allowed_cartridge_ids`, `pin_endo_method`, `resolve_endo_method`, `ENDO_FORMS`, `CARTRIDGE_REFUSED`. From the test file it consumes `_service`, `_cartridge`, `_method`, `_ws` and `_vial_item`.
- Produces: `PATCH /worksheets/{ws}/items/{item}` accepts `prep_form` (one of `ENDO_FORMS` or null), `prep_water_ml` (> 0 or null), `prep_total_dilution`, `prep_steps` (`validate_prep_steps` or null), `cartridge_type_id` (allowed or null) and `result_reading` (`parse_reading` or null).
  - `prep_total_dilution` must be finite and at least 2 x the row's step 1 ratio, or null. The ratio is `prep_steps[0][1]` when set, else 10, so the floor is 20 by default and never below 2. Below the floor, step 2 cannot be made (lead decision 2026-10-10). The check runs on the row as it stands after the PATCH, whenever the total or the steps are sent. Tube overflow stays a screen warning, not a 400.
  - A reading needs a cartridge, either sent with it or already on the row. Clearing the cartridge under a stored reading returns 400.
  - Storage: a reading is stored as the trimmed text exactly as typed (`" 0.8 "` becomes `"0.8"`, `"< 0.05"` stays `"< 0.05"`).
  - Stamps: setting a reading writes `result_entered_at` and `result_entered_by_user_id` and pins the method; clearing it nulls the stamps.
  - The reader record (lead decision 2026-10-10): a typed reading keeps `result_reader`, because the page flags the mismatch and validity still comes from the record. Clearing the reading (null) also clears `result_reader`; the cleared record stays in the `endo_reading_cleared` audit row as `old_reader`.
  - Guard: 409 on a completed worksheet only when one of these six fields is in the payload.
  - Audit: `endo_reading_set`, `endo_reading_cleared` and `endo_cartridge_set` (row), each with `old` and `new`.
  - Response: today's keys plus `endo_method`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_endo_v2_worksheets.py`:

```python
# --- Task 6: row fields on PATCH /worksheets/{ws}/items/{item} ---------------


def _row_world(db):
    """An open worksheet with one endo vial and two active cartridges. No
    method resolves, so every active endotoxin cartridge is allowed (4.3)."""
    ws = _ws(db)
    item, _ = _vial_item(db, ws, 1, _service(db))
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    db.commit()
    return ws, item, c05, c01


_ROW_FIELDS = ("prep_form", "prep_water_ml", "prep_total_dilution", "prep_steps",
               "cartridge_type_id", "result_reading", "result_entered_at",
               "result_entered_by_user_id")


def _row(item):
    return {f: getattr(item, f) for f in _ROW_FIELDS}


def test_patch_sets_and_clears_the_prep_fields_and_audits_the_cartridge(client, db):
    ws, item, c05, _ = _row_world(db)
    url = f"/worksheets/{ws.id}/items/{item.id}"
    r = client.patch(url, json={"prep_form": "liquid", "prep_water_ml": 1.5,
                                "prep_total_dilution": 500, "prep_steps": [[20, 5], None, [100]],
                                "cartridge_type_id": c05.id})
    assert r.status_code == 200, r.text
    # The response keeps today's keys and adds the worksheet's endo method.
    assert {"status", "item_id", "resolved_method", "endo_method"} <= set(r.json())
    db.refresh(item)
    assert (item.prep_form, item.prep_water_ml, item.prep_total_dilution, item.prep_steps,
            item.cartridge_type_id) == ("liquid", 1.5, 500, [[20, 5], None, [100]], c05.id)
    it = client.get(f"/worksheets/{ws.id}").json()["items"][0]
    assert it["prep_steps"] == [[20, 5], None, [100]]
    assert it["cartridge_sensitivity_eu_ml"] == 0.05

    r = client.patch(url, json={"prep_form": None, "prep_water_ml": None,
                                "prep_total_dilution": None, "prep_steps": None,
                                "cartridge_type_id": None})
    assert r.status_code == 200, r.text
    db.refresh(item)
    assert _row(item) == dict.fromkeys(_ROW_FIELDS)
    assert [(a.operation, a.details["old"], a.details["new"]) for a in db.query(AuditLog)
            .filter(AuditLog.operation == "endo_cartridge_set").order_by(AuditLog.id)] == [
        ("endo_cartridge_set", None, c05.id), ("endo_cartridge_set", c05.id, None)]


@pytest.mark.parametrize("payload", [
    {"prep_form": "gel"},
    {"prep_water_ml": 0},
    {"prep_water_ml": -1},
    {"prep_total_dilution": 1.5},
    {"prep_total_dilution": 15},   # below 2 x the standard 1:10 step 1
    {"prep_steps": [[20, 10], None]},
    {"prep_steps": [[20, 0.5], None, None]},
    {"prep_steps": [None, None, [0]]},
    {"cartridge_type_id": 99999},
])
def test_patch_refuses_bad_row_values_and_writes_nothing(client, db, payload):
    ws, item, _, _ = _row_world(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json=payload)
    assert r.status_code == 400, payload
    db.refresh(item)
    assert _row(item) == dict.fromkeys(_ROW_FIELDS)


def test_patch_refuses_a_total_the_steps_cannot_make(client, db):
    ws, item, _, _ = _row_world(db)
    url = f"/worksheets/{ws.id}/items/{item.id}"
    # Standard step 1 (1:10) x the fixed 1:2 step: 20 is the smallest makeable total.
    r = client.patch(url, json={"prep_total_dilution": 19.5})
    assert r.status_code == 400 and "prep_total_dilution" in r.json()["detail"]
    assert client.patch(url, json={"prep_total_dilution": 20}).status_code == 200
    # The row's own step 1 ratio moves the floor, sent with the total ...
    assert client.patch(url, json={"prep_total_dilution": 8,
                                   "prep_steps": [[20, 4], None, None]}).status_code == 200
    # ... or already stored: a new ratio of 5 cannot make the stored total of 8.
    assert client.patch(url, json={"prep_steps": [[20, 5], None, None]}).status_code == 400
    # A step 1 with only its sample uL keeps the standard 1:10, so 20 again.
    assert client.patch(url, json={"prep_total_dilution": 12,
                                   "prep_steps": [[30], None, None]}).status_code == 400
    db.refresh(item)
    assert (item.prep_total_dilution, item.prep_steps) == (8, [[20, 4], None, None])


def test_patch_refuses_a_cartridge_the_method_does_not_allow(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    off_method = _cartridge(db, "Endosafe 0.005", 0.005)
    _method(client, db, "Endotoxin", svc, [(c05, True)])
    ws = _ws(db)
    item, _ = _vial_item(db, ws, 1, svc)
    db.commit()
    url = f"/worksheets/{ws.id}/items/{item.id}"
    r = client.patch(url, json={"cartridge_type_id": off_method.id})
    assert r.status_code == 400 and r.json()["detail"] == worksheets_endo.CARTRIDGE_REFUSED
    assert client.patch(url, json={"cartridge_type_id": c05.id}).status_code == 200


def test_a_completed_worksheet_refuses_only_the_new_row_fields(client, db):
    ws, item, c05, _ = _row_world(db)
    ws.status = "completed"
    db.commit()
    url = f"/worksheets/{ws.id}/items/{item.id}"
    for payload in ({"prep_form": "powder"}, {"prep_steps": None},
                    {"result_reading": "0.8", "cartridge_type_id": c05.id}):
        assert client.patch(url, json=payload).status_code == 409, payload
    # Existing fields keep today's behaviour (no guard).
    assert client.patch(url, json={"made": True}).status_code == 200
    db.refresh(item)
    assert item.made_at is not None
    assert _row(item) == dict.fromkeys(_ROW_FIELDS)


@pytest.mark.parametrize("typed, stored", [
    ("< 0.05", "< 0.05"), (" 0.8 ", "0.8"), ("<0.05", "<0.05"), ("0", "0"),
])
def test_a_reading_is_stored_as_typed_after_trimming(client, db, typed, stored):
    ws, item, c05, _ = _row_world(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}",
                     json={"result_reading": typed, "cartridge_type_id": c05.id})
    assert r.status_code == 200, r.text
    db.refresh(item)
    assert item.result_reading == stored
    assert item.result_entered_by_user_id == 1 and item.result_entered_at is not None
    it = client.get(f"/worksheets/{ws.id}").json()["items"][0]
    assert it["result_reading"] == stored and it["result_entered_at"].endswith("Z")


@pytest.mark.parametrize("typed", ["0,8", "-1", "<0", "abc", ""])
def test_a_reading_that_does_not_parse_is_refused_with_a_reason(client, db, typed):
    ws, item, c05, _ = _row_world(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}",
                     json={"result_reading": typed, "cartridge_type_id": c05.id})
    assert r.status_code == 400
    assert "reading" in r.json()["detail"]
    db.refresh(item)
    assert _row(item) == dict.fromkeys(_ROW_FIELDS)


def test_a_reading_needs_the_rows_cartridge(client, db):
    ws, item, c05, _ = _row_world(db)
    url = f"/worksheets/{ws.id}/items/{item.id}"
    r = client.patch(url, json={"result_reading": "0.8"})
    assert r.status_code == 400 and "cartridge" in r.json()["detail"]
    assert client.patch(url, json={"result_reading": "0.8",
                                   "cartridge_type_id": None}).status_code == 400
    assert client.patch(url, json={"result_reading": "0.8",
                                   "cartridge_type_id": c05.id}).status_code == 200
    # The row now has its cartridge, so a later reading may come alone. The
    # cartridge cannot be dropped from under a stored reading (spec 3.1).
    assert client.patch(url, json={"result_reading": "<0.05"}).status_code == 200
    assert client.patch(url, json={"cartridge_type_id": None}).status_code == 400
    db.refresh(item)
    assert (item.result_reading, item.cartridge_type_id) == ("<0.05", c05.id)


def test_reading_set_and_clear_are_audited_and_the_first_one_pins_the_method(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    mid = _method(client, db, "Endotoxin", svc, [(c05, True)])
    ws = _ws(db)
    item, _ = _vial_item(db, ws, 1, svc)
    db.commit()
    url = f"/worksheets/{ws.id}/items/{item.id}"

    r = client.patch(url, json={"result_reading": "0.8", "cartridge_type_id": c05.id})
    assert r.status_code == 200, r.text
    assert r.json()["endo_method"]["id"] == mid
    db.refresh(ws)
    assert ws.endo_method_id == mid
    assert client.patch(url, json={"result_reading": None}).status_code == 200
    db.refresh(item)
    assert (item.result_reading, item.result_entered_at,
            item.result_entered_by_user_id) == (None, None, None)
    assert item.cartridge_type_id == c05.id
    assert [(a.operation, a.details["old"], a.details["new"]) for a in db.query(AuditLog).filter(
        AuditLog.operation.in_(("endo_reading_set", "endo_reading_cleared"))
    ).order_by(AuditLog.id)] == [
        ("endo_reading_set", None, "0.8"), ("endo_reading_cleared", "0.8", None)]
    assert db.query(AuditLog).filter(AuditLog.operation == "endo_method_pinned").count() == 1


_IMPORTED = {"test_id": "T-1", "reader": "NX-1001", "slot": 1, "recovery": 98.0,
             "sample_cv": 3.1, "spike_cv": 4.0, "valid": True, "why": []}


def _imported_row(db):
    """A row as the reader import leaves it (Task 7 writes these columns)."""
    ws, item, c05, _ = _row_world(db)
    item.cartridge_type_id = c05.id
    item.result_reading = "<0.05"
    item.result_reader = dict(_IMPORTED)
    db.commit()
    return ws, item


def test_a_typed_reading_over_an_imported_one_keeps_the_reader_record(client, db):
    # The page flags the mismatch; validity still comes from the reader's numbers.
    ws, item = _imported_row(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"result_reading": "0.8"})
    assert r.status_code == 200, r.text
    db.refresh(item)
    assert (item.result_reading, item.result_reader) == ("0.8", _IMPORTED)


def test_clearing_the_reading_clears_the_reader_record_and_audits_it(client, db):
    ws, item = _imported_row(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"result_reading": None})
    assert r.status_code == 200, r.text
    db.refresh(item)
    assert (item.result_reading, item.result_reader) == (None, None)
    cleared = db.query(AuditLog).filter(AuditLog.operation == "endo_reading_cleared").one()
    assert (cleared.details["old"], cleared.details["old_reader"]) == ("<0.05", _IMPORTED)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_endo_v2_worksheets.py -q -k "patch or reading or completed_worksheet"`
Expected: FAIL. Pydantic drops the six unknown keys, so every PATCH answers 200 and stores nothing. Expect `assert 200 == 400` / `assert 200 == 409`, the stored-value asserts failing on `None`, and `endo_method` missing from the response.

- [ ] **Step 3: Implement the row-field rules in `worksheets_endo.py`**

Add `from datetime import datetime` to the imports at the top of `backend/worksheets_endo.py`, then append:

```python
# The endo v2 row fields the item PATCH accepts (spec 3.7). Sent = set; an
# explicit null clears; omitted = untouched (model_fields_set).
ENDO_ITEM_FIELDS = ("prep_form", "prep_water_ml", "prep_total_dilution", "prep_steps",
                    "cartridge_type_id", "result_reading")
# The fixed parts of the 2 mL steps that stay in code (spec 4.4): step 1's
# standard ratio and the fixed 1:2 of step 3.
STEP1_STANDARD_RATIO = 10
STEP3_RATIO = 2


def _step1_ratio(steps) -> float:
    """The row's step 1 ratio: its own (prep_steps[0][1]) when set, else 1:10."""
    first = steps[0] if isinstance(steps, list) and steps else None
    if isinstance(first, list) and len(first) == 2 and first[1] is not None:
        return first[1]
    return STEP1_STANDARD_RATIO


def check_item_endo_fields(db: Session, worksheet, item, values: dict) -> dict:
    """Validate the row fields one PATCH sent. Writes nothing. Returns the
    values to store (a reading trimmed) or raises ValueError with the reason.
    Saving a reading always stores the row's cartridge (spec 3.1), so a
    reading needs one, sent now or already on the row. For the same reason a
    cartridge cannot be cleared from under a stored reading. A total below
    step 1's ratio x 2 cannot be made, because step 2 would need a ratio
    under 1:1. Tube overflow is only a screen warning."""
    out = dict(values)
    form = values.get("prep_form")
    if form is not None and form not in ENDO_FORMS:
        raise ValueError(f"prep_form must be one of {', '.join(ENDO_FORMS)}")
    water = values.get("prep_water_ml")
    if water is not None and not (math.isfinite(water) and water > 0):
        raise ValueError("prep_water_ml must be a number greater than zero")
    total = values.get("prep_total_dilution")
    if total is not None and not math.isfinite(total):
        raise ValueError("prep_total_dilution must be a number")
    if values.get("prep_steps") is not None:
        out["prep_steps"] = validate_prep_steps(values["prep_steps"])
    total_after = out.get("prep_total_dilution", item.prep_total_dilution)
    if total_after is not None and ("prep_total_dilution" in values or "prep_steps" in values):
        floor = STEP3_RATIO * _step1_ratio(out.get("prep_steps", item.prep_steps))
        if total_after < floor:
            raise ValueError(f"prep_total_dilution must be at least {floor:g} (the step 1 "
                             f"ratio x the fixed 1:{STEP3_RATIO} step) or step 2 cannot be made")
    cartridge = values.get("cartridge_type_id")
    if cartridge is not None and cartridge not in allowed_cartridge_ids(db, worksheet):
        raise ValueError(CARTRIDGE_REFUSED)
    if values.get("result_reading") is not None:
        parse_reading(values["result_reading"])
        out["result_reading"] = values["result_reading"].strip()
    reading_after = out.get("result_reading", item.result_reading)
    cartridge_after = out.get("cartridge_type_id", item.cartridge_type_id)
    if reading_after is not None and cartridge_after is None:
        raise ValueError("A reading needs the row's cartridge: send cartridge_type_id with it")
    return out


def apply_item_endo_fields(db: Session, worksheet, item, values: dict,
                           user_id: Optional[int]) -> None:
    """Store values from check_item_endo_fields, with their audit rows. A new
    reading stamps who and when and pins the worksheet's method (spec 4.1).
    The reader record (lead decision 2026-10-10) is handled two ways. A typed
    reading keeps result_reader: the page flags the mismatch, and validity
    still comes from the record. Clearing the reading clears the record too,
    and the audit row keeps the cleared record as old_reader. Callers commit."""
    base = {"user_id": user_id, "worksheet_id": worksheet.id, "sample_id": item.sample_id}

    def audit(operation: str, old, new, **extra) -> None:
        db.add(AuditLog(operation=operation, entity_type="worksheet_item",
                        entity_id=str(item.id),
                        details={**base, "old": old, "new": new, **extra}))

    for field in ("prep_form", "prep_water_ml", "prep_total_dilution", "prep_steps"):
        if field in values:
            setattr(item, field, values[field])
    if "cartridge_type_id" in values and values["cartridge_type_id"] != item.cartridge_type_id:
        audit("endo_cartridge_set", item.cartridge_type_id, values["cartridge_type_id"])
        item.cartridge_type_id = values["cartridge_type_id"]
    if "result_reading" in values and values["result_reading"] != item.result_reading:
        new = values["result_reading"]
        if new is None:
            audit("endo_reading_cleared", item.result_reading, None, old_reader=item.result_reader)
            item.result_reader = None
        else:
            audit("endo_reading_set", item.result_reading, new)
        item.result_reading = new
        item.result_entered_at = datetime.utcnow() if new is not None else None
        item.result_entered_by_user_id = user_id if new is not None else None
    if values.get("result_reading") is not None:
        pin_endo_method(db, worksheet, user_id)
```

- [ ] **Step 4: Implement the PATCH fields in `main.py`**

Extend `WorksheetItemUpdate` after `ran: Optional[bool] = None`:

```python
    # Endo v2 row fields (spec 2026-10-10 sections 3.7 and 10): explicit null
    # clears, omitted is a no-op (model_fields_set); 409 on a completed
    # worksheet for these fields only. Rules in worksheets_endo.py.
    prep_form: Optional[str] = None
    prep_water_ml: Optional[float] = None
    prep_total_dilution: Optional[float] = None
    prep_steps: Optional[list] = None
    cartridge_type_id: Optional[int] = None
    result_reading: Optional[str] = None
```

In `update_worksheet_item`, insert between `raise HTTPException(404, "Worksheet item not found")` and `resolved_method = None`:

```python
    # Endo v2 row fields, validated before anything below writes. A completed
    # worksheet refuses them (409); the older fields keep today's behaviour.
    from worksheets_endo import (ENDO_ITEM_FIELDS, apply_item_endo_fields,
                                 check_item_endo_fields, resolve_endo_method)
    ws = db.execute(select(Worksheet).where(Worksheet.id == worksheet_id)).scalar_one()
    endo_values = {f: getattr(data, f) for f in ENDO_ITEM_FIELDS if f in data.model_fields_set}
    if endo_values:
        if ws.status == "completed":
            raise HTTPException(409, "Worksheet is completed")
        try:
            endo_values = check_item_endo_fields(db, ws, item, endo_values)
        except ValueError as exc:
            raise HTTPException(400, str(exc))

```

Replace the end of the function

```python
    db.commit()
    return {"status": "updated", "item_id": item_id, "resolved_method": resolved_method}
```

with

```python
    if endo_values:
        apply_item_endo_fields(db, ws, item, endo_values, _current_user.id)

    db.commit()
    return {"status": "updated", "item_id": item_id, "resolved_method": resolved_method,
            # Endo v2 (spec 4.1): the worksheet's endo method, as GET /worksheets/{id} has it.
            "endo_method": resolve_endo_method(db, ws)}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_endo_v2_worksheets.py tests/test_worksheet_endo_prep.py tests/test_methods_stamping.py -q`
Expected: all pass. `test_worksheet_endo_prep.py` and `test_methods_stamping.py` pin today's PATCH behaviour: null clears, `> 0`, ticks, the instrument stamp, `instrument_id` set, clear and refuse, and `prep_status`. Both seed a real `Worksheet` row, so the new `scalar_one()` worksheet load holds.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(endo-v2): item prep and reading fields on the item PATCH" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/worksheets_endo.py backend/main.py backend/tests/test_endo_v2_worksheets.py
```

---

### Task 7: Reader import endpoint

**Files:**
- Modify: `backend/main.py`:
  - New models `EndoReaderTest`, `EndoReaderImport` and `EndoReaderImportOut`.
  - New route `POST /worksheets/{worksheet_id}/reader-import` (`import_endo_reader_results`), placed after `record_worksheet_printed`.
  - New helper `_open_vial_analyses`, extracted from `_sole_instrument_for_item` without changing behaviour.
  - `_apply_bench_ticks` gains `instrument_id: Optional[int] = None`.
- Test: Modify `backend/tests/test_endo_v2_worksheets.py` (append, plus two import lines).

**Interfaces:**
- Consumes (Task 5): `parse_reading`, `allowed_cartridge_ids`, `pin_endo_method`, `resolve_endo_method`, `instrument_id_for_serial`, `CARTRIDGE_REFUSED`.
- Consumes (existing): `_serialize_worksheets`, `_apply_bench_ticks`, `_sole_instrument_for_item`.
- Produces: `POST /worksheets/{id}/reader-import`. Body `{"file_name": str, "tests": [{"item_id": int, "reading": str, "record": dict, "cartridge_type_id": int, "replace": bool}]}`. Response `{"applied": int, "items": [every item on the worksheet, in the GET /worksheets/{id} item shape], "endo_method": dict | null}`.
- Status codes:
  - 404 when the worksheet is missing or staging.
  - 409 when it is completed.
  - 400 for any bad row, written as `"Nothing was imported. Row <sample id or item N>: <reason>; ..."`. A bad row is one that is not on this worksheet, listed twice, has no `test_id`, has an unparseable reading, has a refused cartridge, or holds a different reading while `replace` is false.
- Writes:
  - All or nothing, in one commit.
  - A row that already holds the same parsed reading and test id is a no-op and is not counted in `applied`.
  - The stored record is the browser's plus `imported_at` (ISO + "Z") and `imported_by_user_id`.
  - Ran is ticked through `_apply_bench_ticks`, which stamps the instrument named by `record["reader"]` when the serial matches an active instrument. Otherwise it uses the existing `_sole_instrument_for_item` fallback. It never writes a method.
  - Audit: one `endo_reader_imported` row per applied row, with `file_name`, `test_id`, `reader`, `slot`, old and new reading, and old and new cartridge.
- Route ordering: this is a POST on a path with an id and a literal tail, so it cannot shadow or be shadowed by `GET /worksheets/{worksheet_id}`. It needs no particular place.

- [ ] **Step 1: Write the failing test**

At the top of `backend/tests/test_endo_v2_worksheets.py`, add `from types import SimpleNamespace` after `from contextlib import contextmanager`, and change the models import to:

```python
from models import (
    AnalysisService, AuditLog, ConsumableType, HplcMethod, Instrument, LimsAnalysis,
    LimsSample, LimsSubSample, Worksheet, WorksheetItem, instrument_methods,
    method_consumables,
)
```

Append:

```python
# --- Task 7: POST /worksheets/{id}/reader-import ----------------------------


def _record(test_id="T-0001", reader="NX-1001", slot=1):
    """A reader record shaped like src/lib/endo-reader.ts toReaderRecord
    (spec 8.4). Made-up values, never a real export."""
    return {"test_id": test_id, "reader": reader, "slot": slot, "operator": "DL",
            "tested_at": "2026-10-09T14:02:00", "temp_start": 37.0, "temp_end": 37.1,
            "software": "EndoScan-V 6.2", "cartridge_lot": "L1234",
            "cartridge_expiry": "2027-03", "cartridge_range": "0.05-5", "spike_level": 0.5,
            "recovery": 98.0, "rec_min": 50, "rec_max": 200, "sample_cv": 3.1,
            "spike_cv": 4.0, "cv_limit": 25, "reader_pass": True, "valid": True, "why": [],
            "file_name": "EndoScanV-Export-2026-10-09.csv"}


def _line(item, reading, cartridge, *, replace=False, **record):
    return {"item_id": item.id, "reading": reading, "record": _record(**record),
            "cartridge_type_id": cartridge.id, "replace": replace}


def _import(client, ws, *lines):
    return client.post(f"/worksheets/{ws.id}/reader-import",
                       json={"file_name": "EndoScanV-Export-2026-10-09.csv", "tests": list(lines)})


def _reader_world(client, db, *, serials=(None,)):
    """Two endo vials (P-3001-S01 and -S02) on an open worksheet. An active
    method allows the 0.05 (default) and 0.01 cartridges. One instrument is
    linked to it per entry in `serials`."""
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    mid = _method(client, db, "Endotoxin", svc, [(c05, True), (c01, False)])
    ws = _ws(db)
    a, row_a = _vial_item(db, ws, 1, svc)
    b, row_b = _vial_item(db, ws, 2, svc)
    instruments = []
    for n, serial in enumerate(serials, start=1):
        inst = Instrument(name=f"Nexgen-MCS {n}", origin="mk1", active=True, serial_number=serial)
        db.add(inst)
        db.flush()
        db.execute(instrument_methods.insert().values(instrument_id=inst.id, method_id=mid))
        instruments.append(inst.id)
    db.commit()
    return SimpleNamespace(svc=svc, c05=c05, c01=c01, mid=mid, ws=ws, a=a, b=b,
                           row_a=row_a, row_b=row_b, instruments=instruments)


_IMPORT_OPS = ("endo_reader_imported", "endo_method_pinned", "bench_ran_set")


def test_import_stores_each_reading_ticks_ran_pins_and_audits(client, db):
    w = _reader_world(client, db)
    r = _import(client, w.ws, _line(w.a, "<0.05", w.c05, test_id="T-1", slot=1),
                _line(w.b, " 0.8 ", w.c01, test_id="T-2", slot=2))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["applied"] == 2 and body["endo_method"]["id"] == w.mid
    items = {it["id"]: it for it in body["items"]}
    a, b = items[w.a.id], items[w.b.id]
    assert (a["result_reading"], b["result_reading"]) == ("<0.05", "0.8")
    assert (a["cartridge_type_id"], b["cartridge_type_id"]) == (w.c05.id, w.c01.id)
    assert b["cartridge_sensitivity_eu_ml"] == 0.01
    assert a["result_reader"]["test_id"] == "T-1" and a["result_reader"]["recovery"] == 98.0
    assert a["result_reader"]["imported_by_user_id"] == 1
    assert a["result_reader"]["imported_at"].endswith("Z")
    assert a["ran_at"] is not None and a["result_entered_by_user_id"] == 1
    db.refresh(w.ws)
    assert w.ws.endo_method_id == w.mid
    assert [(x.entity_id, x.details["test_id"], x.details["reader"], x.details["slot"],
             x.details["file_name"]) for x in db.query(AuditLog)
            .filter(AuditLog.operation == "endo_reader_imported").order_by(AuditLog.id)] == [
        (str(w.a.id), "T-1", "NX-1001", 1, "EndoScanV-Export-2026-10-09.csv"),
        (str(w.b.id), "T-2", "NX-1001", 2, "EndoScanV-Export-2026-10-09.csv")]


def test_import_on_a_missing_or_completed_worksheet_changes_nothing(client, db):
    w = _reader_world(client, db)
    assert client.post("/worksheets/99999/reader-import",
                       json={"file_name": "x.csv", "tests": []}).status_code == 404
    # Another analyst completes the worksheet while the import dialog is open.
    w.ws.status = "completed"
    db.commit()
    assert _import(client, w.ws, _line(w.a, "0.8", w.c05)).status_code == 409
    db.refresh(w.a)
    db.refresh(w.ws)
    assert (w.a.result_reading, w.a.result_reader, w.a.cartridge_type_id,
            w.a.ran_at) == (None, None, None, None)
    assert w.ws.endo_method_id is None
    assert db.query(AuditLog).filter(AuditLog.operation.in_(_IMPORT_OPS)).count() == 0


def test_import_is_all_or_nothing_and_names_each_failing_row(client, db):
    w = _reader_world(client, db)
    elsewhere = _ws(db, "Another run")
    stray, _ = _vial_item(db, elsewhere, 3, w.svc)
    retired = _cartridge(db, "Endosafe old", 0.05, active=False)
    off_method = _cartridge(db, "Endosafe 0.005", 0.005)
    db.commit()
    bad_rows = [
        (_line(stray, "0.8", w.c05), f"item {stray.id}: not on this worksheet"),
        (_line(w.b, "0,8", w.c05), "P-3001-S02: '0,8' is not a reading"),
        (_line(w.b, "0.8", retired), f"P-3001-S02: {worksheets_endo.CARTRIDGE_REFUSED}"),
        (_line(w.b, "0.8", off_method), f"P-3001-S02: {worksheets_endo.CARTRIDGE_REFUSED}"),
        (_line(w.b, "0.8", w.c05, test_id=""), "P-3001-S02: the reader record has no test_id"),
        (_line(w.a, "0.9", w.c05, test_id="T-2"), "P-3001-S01: listed twice"),
    ]
    for bad, reason in bad_rows:
        r = _import(client, w.ws, _line(w.a, "0.8", w.c05), bad)
        assert r.status_code == 400, bad
        assert r.json()["detail"].startswith("Nothing was imported.")
        assert reason in r.json()["detail"], r.json()["detail"]
        db.refresh(w.a)
        assert w.a.result_reading is None and w.a.ran_at is None  # the good row was not written either
    assert db.query(AuditLog).filter(AuditLog.operation.in_(_IMPORT_OPS)).count() == 0


def test_import_repeats_are_no_ops_and_a_different_reading_needs_replace(client, db):
    w = _reader_world(client, db)
    assert _import(client, w.ws, _line(w.a, "<0.05", w.c05, test_id="T-1")).json()["applied"] == 1
    # The same file again, spacing aside: same reading, same test, nothing to do.
    r = _import(client, w.ws, _line(w.a, "< 0.05", w.c05, test_id="T-1"))
    assert r.status_code == 200 and r.json()["applied"] == 0
    assert db.query(AuditLog).filter(AuditLog.operation == "endo_reader_imported").count() == 1
    # A different reading is refused without replace, naming the row ...
    r = _import(client, w.ws, _line(w.a, "1.2", w.c05, test_id="T-9"))
    assert r.status_code == 400
    assert "P-3001-S01" in r.json()["detail"] and "replace" in r.json()["detail"]
    db.refresh(w.a)
    assert w.a.result_reading == "<0.05"
    # ... and applied with it.
    r = _import(client, w.ws, _line(w.a, "1.2", w.c05, test_id="T-9", replace=True))
    assert r.status_code == 200 and r.json()["applied"] == 1
    db.refresh(w.a)
    assert (w.a.result_reading, w.a.result_reader["test_id"]) == ("1.2", "T-9")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_endo_v2_worksheets.py -q -k import`
Expected: FAIL. The route does not exist yet, so FastAPI answers 404 (`assert 404 == 200`, `assert 404 == 409`, `assert 404 == 400`). Only the 99999 line of the missing/completed test sees the 404 it expects.

- [ ] **Step 3: Implement the endpoint**

In `backend/main.py`, after `record_worksheet_printed` (and before `class WorksheetWellFreeze`), add:

```python
class EndoReaderTest(BaseModel):
    """One reader test the browser matched to a row (endo v2, spec 8.2)."""
    item_id: int
    reading: str
    record: dict  # the reader record, spec 8.4 (src/lib/endo-reader.ts toReaderRecord)
    cartridge_type_id: int
    replace: bool = False


class EndoReaderImport(BaseModel):
    file_name: str
    tests: list[EndoReaderTest]


class EndoReaderImportOut(BaseModel):
    applied: int
    items: list[dict]  # every item on the worksheet, in the GET /worksheets/{id} shape
    endo_method: Optional[dict] = None


@app.post("/worksheets/{worksheet_id}/reader-import", response_model=EndoReaderImportOut)
def import_endo_reader_results(
    worksheet_id: int,
    data: EndoReaderImport,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),
):
    """Apply an EndoScan-V export that the browser parsed and matched to rows
    (endo v2, spec 8.2). All or nothing: every row is checked first and the
    writes share one commit, so a refused row writes nothing at all. A test
    already on its row (same reading, same test id) is skipped. A POST on an
    id path, so it has no ordering concern against GET /worksheets/{worksheet_id}."""
    from worksheets_endo import (CARTRIDGE_REFUSED, allowed_cartridge_ids, parse_reading,
                                 pin_endo_method, resolve_endo_method)

    ws = db.execute(select(Worksheet).where(Worksheet.id == worksheet_id)).scalar_one_or_none()
    if not ws or ws.status == "staging":
        raise HTTPException(404, "Worksheet not found")
    if ws.status == "completed":
        raise HTTPException(409, "Worksheet is completed")
    items = {it.id: it for it in db.execute(
        select(WorksheetItem).where(WorksheetItem.worksheet_id == worksheet_id)).scalars()}
    allowed = allowed_cartridge_ids(db, ws)

    errors: list[str] = []
    plan: list[tuple["WorksheetItem", EndoReaderTest, str]] = []
    seen: set[int] = set()
    for t in data.tests:
        item = items.get(t.item_id)
        label = item.sample_id if item else f"item {t.item_id}"
        test_id = t.record.get("test_id")
        try:
            if item is None:
                raise ValueError("not on this worksheet")
            if t.item_id in seen:
                raise ValueError("listed twice in one import")
            seen.add(t.item_id)
            if not isinstance(test_id, str) or not test_id.strip():
                raise ValueError("the reader record has no test_id")
            parsed = parse_reading(t.reading)
            if t.cartridge_type_id not in allowed:
                raise ValueError(CARTRIDGE_REFUSED)
            # Compared as parsed values, so "< 0.05" and "<0.05" are the same reading.
            held = parse_reading(item.result_reading) if item.result_reading is not None else None
            if held == parsed and (item.result_reader or {}).get("test_id") == test_id:
                continue  # this test is already on the row
            if held is not None and held != parsed and not t.replace:
                raise ValueError(f"already holds the reading {item.result_reading}; "
                                 "tick replace to overwrite it")
        except ValueError as exc:
            errors.append(f"Row {label}: {exc}")
            continue
        plan.append((item, t, t.reading.strip()))
    if errors:
        raise HTTPException(400, "Nothing was imported. " + "; ".join(errors))

    user_id = _current_user.id
    if plan:
        pin_endo_method(db, ws, user_id)
    now = datetime.utcnow()
    for item, t, reading in plan:
        db.add(AuditLog(
            operation="endo_reader_imported",
            entity_type="worksheet_item",
            entity_id=str(item.id),
            details={"user_id": user_id, "worksheet_id": ws.id, "sample_id": item.sample_id,
                     "file_name": data.file_name, "test_id": t.record.get("test_id"),
                     "reader": t.record.get("reader"), "slot": t.record.get("slot"),
                     "old": item.result_reading, "new": reading,
                     "old_cartridge_type_id": item.cartridge_type_id,
                     "new_cartridge_type_id": t.cartridge_type_id},
        ))
        item.result_reading = reading
        # A new dict every time: a plain JSON column does not see in-place edits.
        item.result_reader = {**t.record, "imported_at": now.isoformat() + "Z",
                              "imported_by_user_id": user_id}
        item.result_entered_at = now
        item.result_entered_by_user_id = user_id
        item.cartridge_type_id = t.cartridge_type_id
        _apply_bench_ticks(db, ws.id, item, made=None, ran=True, user_id=user_id)
    db.commit()
    return {"applied": len(plan), "items": _serialize_worksheets(db, [ws])[0]["items"],
            "endo_method": resolve_endo_method(db, ws)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_endo_v2_worksheets.py -q`
Expected: all pass.

- [ ] **Step 5: Write the failing test for the serial stamp**

Append to `backend/tests/test_endo_v2_worksheets.py`:

```python
def test_import_stamps_the_instrument_named_by_the_reader_serial(client, db):
    # Two analyzers: the catalog alone will not choose between them; the serial does.
    w = _reader_world(client, db, serials=("NX-1001", "NX-2002"))
    r = _import(client, w.ws, _line(w.a, "0.8", w.c05, reader="NX-2002"))
    assert r.status_code == 200, r.text
    db.refresh(w.a)
    db.refresh(w.row_a)
    assert w.a.instrument_id == w.instruments[1]
    assert w.row_a.instrument_id == w.instruments[1]
    assert w.row_a.method_id is None  # a method is never written


def test_import_without_a_serial_match_falls_back_to_the_sole_instrument(client, db):
    w = _reader_world(client, db, serials=("NX-1001",))
    r = _import(client, w.ws, _line(w.a, "0.8", w.c05, reader="NX-UNKNOWN"),
                _line(w.b, "0.5", w.c05, reader=None, test_id="T-2"))
    assert r.status_code == 200, r.text
    db.refresh(w.a)
    db.refresh(w.b)
    assert w.a.instrument_id == w.instruments[0] and w.b.instrument_id == w.instruments[0]
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_endo_v2_worksheets.py -q -k serial`
Expected: `test_import_stamps_the_instrument_named_by_the_reader_serial` FAILS (`assert None == <id>`), because the fallback refuses to guess between two instruments. The fallback test already passes and pins today's path.

- [ ] **Step 7: Implement the serial stamp**

In `backend/main.py`, add this function immediately before `_sole_instrument_for_item`:

```python
def _open_vial_analyses(db: Session, item: "WorksheetItem") -> list:
    """The analyses on this item's vial still open for a bench stamp
    (STAMPABLE_STATES); [] for a bare parent id, which names no vial."""
    from lims_analyses.service import STAMPABLE_STATES
    from models import LimsAnalysis

    vial_pk = db.execute(
        select(LimsSubSample.id).where(LimsSubSample.sample_id == item.sample_id)
    ).scalar_one_or_none()
    if vial_pk is None:
        return []
    return db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == vial_pk,
            LimsAnalysis.review_state.in_(STAMPABLE_STATES),
        )
    ).scalars().all()


```

In `_sole_instrument_for_item`, replace the body from `from lims_analyses.service import STAMPABLE_STATES` through `service_ids = {r.analysis_service_id for r in open_rows}`:

```python
    from lims_analyses.service import STAMPABLE_STATES
    from models import LimsAnalysis

    vial_pk = db.execute(
        select(LimsSubSample.id).where(LimsSubSample.sample_id == item.sample_id)
    ).scalar_one_or_none()
    if vial_pk is None:
        return None
    open_rows = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == vial_pk,
            LimsAnalysis.review_state.in_(STAMPABLE_STATES),
        )
    ).scalars().all()
    service_ids = {r.analysis_service_id for r in open_rows}
```

with

```python
    open_rows = _open_vial_analyses(db, item)
    service_ids = {r.analysis_service_id for r in open_rows}
```

The behaviour is unchanged: no vial gives no rows, and then the existing `if not service_ids: return None` applies.

In `_apply_bench_ticks`, change the signature to

```python
def _apply_bench_ticks(db: Session, worksheet_id: int, item: "WorksheetItem", *,
                       made: Optional[bool], ran: Optional[bool], user_id: Optional[int],
                       stamp_instrument: bool = True,
                       instrument_id: Optional[int] = None) -> bool:
```

append this sentence to its docstring, before `Returns whether anything changed.`: `A reader import passes the instrument its serial names (instrument_id), and that wins over the catalog lookup.` Then replace

```python
    if stamp_instrument and "ran" in newly_set and not item.instrument_id:
        resolved = _sole_instrument_for_item(db, item)
```

with

```python
    if stamp_instrument and "ran" in newly_set and not item.instrument_id:
        # A reader import names its instrument by serial (endo v2, spec 4.5);
        # otherwise the catalog decides, and only when it leaves one choice.
        resolved = ((instrument_id, _open_vial_analyses(db, item)) if instrument_id
                    else _sole_instrument_for_item(db, item))
```

The lines below it (`stamp_method_instrument(..., method_id=row.method_id, ...)` and `item.instrument_id = instrument_id`) stay as they are, so no method is ever written.

In `import_endo_reader_results`, add `instrument_id_for_serial` to the `from worksheets_endo import (...)` line, and replace

```python
        _apply_bench_ticks(db, ws.id, item, made=None, ran=True, user_id=user_id)
```

with

```python
        _apply_bench_ticks(db, ws.id, item, made=None, ran=True, user_id=user_id,
                           instrument_id=instrument_id_for_serial(db, t.record.get("reader")))
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_endo_v2_worksheets.py tests/test_worksheet_endo_prep.py tests/test_worksheets_list_sync.py tests/test_methods_stamping.py -q`
Expected: all pass. The `test_mcs_tick_*` cases in `test_worksheet_endo_prep.py` pin the unchanged fallback (sole instrument, no guessing between two, explicit clear wins, only a newly set Ran stamps).

- [ ] **Step 9: Commit**

```bash
git commit -m "feat(endo-v2): reader import endpoint with serial instrument stamp" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- backend/main.py backend/tests/test_endo_v2_worksheets.py
```

---

### Task 8: 2 mL maths port (`src/lib/endo-prep-2ml.ts`)

**Files:**
- Create: `src/lib/endo-prep-2ml.ts`
- Test: `src/lib/__tests__/endo-prep-2ml.test.ts`
- Untouched (imported only): `src/lib/endo-prep.ts` and `src/lib/__tests__/endo-prep.test.ts` (that file passing unchanged is the proof stock worksheets do not move, spec 5)

**Interfaces:**
- Consumes from `src/lib/endo-prep.ts`: `isBacWater(sampleId, sampleType?, identity?)` (the one shared bac water rule, spec 4.2), `fmt(v)`, `DEFAULT_DILUTION` (20). The test also uses `calcEndoPrep`, `fmtUl`, `orderForBench`.
- Produces, exactly as CONTRACT.md fixes them: `EndoForm`, `EndoVerdict`, `EndoRunParams`, `ENDO_RUN_PARAM_DEFAULTS` (250, 2, 50, 200, 25), `EndoStepOverride`, `EndoReaderRecord`, `EndoSample`, `EndoCtx`, `LIMIT_EU_PER_VIAL` (350), `BW_LIMIT_EU_PER_ML` (0.25), `BW_DILUTION` (20), `BW_LAMBDA` (0.01), `TUBE_UL` (1500), `DILUTION_STEPS`, `formOf(s)`, `isBacWaterSample(s)`, `waterOf(s, ctx)`, `EndoStepPlan`, `stepsOf(s, ctx)`, `dilutionPlan(s, ctx)`, `vialDilutionOf(s, ctx)`, `EndoCheck`, `prep2Check(s, ctx)`, `parseReading(text)`, `EndoResult`, `prep2Result(s, ctx)`, `mk1Value(s, ctx)`, `fmtEu(lt, v)`, `orderByTotal(rows, sampleOf, ctx)`.
- Produces, additive (not in the contract; later tasks may use them): `FORMS` (form keys with Dennis's labels, for the Form select), `EndoStepDef`, `stdStep(st, params)`, `stepFactor(st)`, `targetDilutionOf(s, ctx)`, `limitPerMg(s)`, `limitPerVial(s)`, `mvcFor(lambda, s)`, `judgeWater(lt, euPerMl)`, `fmtConc(v)`. `fmtEu` accepts `v: number | null` (a widened parameter, so contract callers compile unchanged).
- Rules the callers own (not in this module): the stock / 2 mL switch (`worksheets.endo_prep`, Task 1); the row's lambda, including bac water's default 0.01 and the run cartridge (spec 4.3, Task 13 `endoSampleFor`); the allowed lambdas and run parameters from the pinned method (Task 13 `endoCtxFor`, `runParamsFrom`); bench order before `orderByTotal` (`orderForBench`).

Dennis's tests ported here (calc.test.js at 5ef2a62, by line; every expected number unchanged unless the row says otherwise):

| Dennis line | `describe` here | Adapted or dropped, and why |
| --- | --- | --- |
| 533 | `calc.test.js:533 2 mL prep: ...` | `prepOf` / `PREP_2ML_FROM` dropped (worksheets.endo_prep, Task 1); `RECON_ML` / `DILUTION_2ML` asserted as `ENDO_RUN_PARAM_DEFAULTS`; cartridge keys become the row's `lambda`; his `steps: []` is `[null, null, null]` |
| 602 | `calc.test.js:602 2 mL prep: reading x total x water ...` | none |
| 641 | `calc.test.js:641 the 2 mL fields, and no stock fields ...` | his `prepareRun` strings rebuilt with `fmt` / `fmtConc` / `fmtEu` from the check and result; asserts no stock key is produced; the stock-path equality is `endo-prep.test.ts` unchanged; `fromStored` dropped, its two maths lines kept |
| 670 | `calc.test.js:670 dilution scheme ...` | his `cumulative` is `running`; his `factor === null` asserted as `running === null` (null in the same cases); his `dilutionPlan(bac) === null` is the bac plan shape (deviation 2) |
| 820 | `calc.test.js:820 LOD ... LOQ ...` | none |
| 835 | `calc.test.js:835 bacteriostatic water: the same 20x prep ...` | method-rule clause dropped (slice 5); his stock `prepareRun` / `resultCheck` clauses become `calcEndoPrep` (the stock 50 + 950, 20x) beside the 2 mL check |
| 861 | `calc.test.js:861 bac water sorts to the bottom ...` | order checked through `orderForBench` then `orderByTotal` (his received dates stand in for the SLA due); the 0.05 / 0.01 cartridge defaults are the caller's (asserted as `BW_LAMBDA` and the lambda passed); rule and stock-run clauses dropped |
| 879 | `calc.test.js:879 bac water on 2 mL runs: 0.25 EU/mL ...` | stock-run `prepareRun` clause dropped |
| 906 | `calc.test.js:906 form: a liquid ...` | `dilutionOf` asserted as `formOf` plus the check's 20x; `fromStored` dropped |
| 934 | `calc.test.js:934 Accu-Mk1 value ...` | stock-run clause dropped (stock worksheets have no Results box) |
| 196 | `calc.test.js:196 the limit is 350 EU per vial ...` | `DILUTION_TO_CARTRIDGE` (stock) and the cartridge key list (now catalog rows) dropped |
| 210 | `calc.test.js:210 MVC is lambda over ...` | his unknown cartridge `"0.1"` is `mvcFor(null, ...)` |
| 352 | `calc.test.js:352 parseResult -> parseReading ...` | no `raw`; unparseable text is `null` (contract); plus RF2 |
| 480 | `calc.test.js:480 the limit per vial is 350, flat ...` | his stock vectors (`<2.5` -> 25, `36` -> 360) swapped for his own 2 mL vectors from line 610 (`<0.05` -> 25, `0.8` -> 400) |
| 517 | `calc.test.js:517 tiny loaded concentrations ...` | his stock `prepareRun` "0.0005" (2000x stock row) dropped |
| (new) | `the reader's invalid verdict (contract rule ...)` | the contract's Invalid rule inside Task 8's own loop (Dennis's line 1016 is ported in Task 9) |
| (new) | `run parameters and the allowed cartridges come from the method ...` | proves ctx.params and an unsorted / partial allowed list are honoured (the ported vectors alone pass with hardcoded 250 / 2 / 0.05-first) |

- [ ] **Step 1: Write the failing test**

`src/lib/__tests__/endo-prep-2ml.test.ts`:

```ts
// Dennis's 2 mL vectors, ported from tools-dennis/tools/endotoxin-log/calc.test.js
// at 5ef2a62 with every expected number unchanged. Each describe names his test
// by line. What changed: a cartridge is its lambda (his "0.05" is 0.05), resolved
// by the caller and passed on the sample (spec 4.3); the standard total and water
// come from ctx.params; method rules, the stock model, his storage shape
// (fromStored) and prepareRun's string table are not this module's. Clauses
// dropped for those reasons carry a comment naming what they covered.
import { describe, it, expect } from 'vitest'
import { calcEndoPrep, fmt, fmtUl, orderForBench } from '@/lib/endo-prep'
import {
  BW_DILUTION,
  BW_LAMBDA,
  BW_LIMIT_EU_PER_ML,
  DILUTION_STEPS,
  ENDO_RUN_PARAM_DEFAULTS,
  FORMS,
  LIMIT_EU_PER_VIAL,
  TUBE_UL,
  dilutionPlan,
  fmtConc,
  fmtEu,
  formOf,
  judgeWater,
  limitPerMg,
  limitPerVial,
  mk1Value,
  mvcFor,
  orderByTotal,
  parseReading,
  prep2Check,
  prep2Result,
  stdStep,
  stepFactor,
  targetDilutionOf,
  vialDilutionOf,
  waterOf,
  type EndoCtx,
  type EndoReaderRecord,
  type EndoSample,
} from '@/lib/endo-prep-2ml'

const ctx: EndoCtx = {
  params: ENDO_RUN_PARAM_DEFAULTS,
  allowedLambdas: [0.05, 0.01, 0.005],
}

function sample(o: Partial<EndoSample> = {}): EndoSample {
  return {
    sampleId: 'P-1',
    identity: 'Examplerelin',
    sampleType: null,
    weightMg: null,
    form: null,
    waterMl: null,
    totalDilution: null,
    steps: null,
    lambda: null,
    reading: null,
    reader: null,
    ...o,
  }
}
// calc.test.js:528-531: pep2, tot and near, as he wrote them
const pep2 = (weightMg: number | null, o: Partial<EndoSample> = {}) =>
  sample({ weightMg, ...o })
const tot = (n: number) => ({ totalDilution: n })
function near(a: number | null, b: number) {
  expect(Math.abs((a ?? Infinity) - b)).toBeLessThan(1e-9)
}
// Bac water as the caller resolves it: the 0.01 unless the row says otherwise
const BW = (o: Partial<EndoSample> = {}) =>
  sample({
    sampleId: 'BW-1',
    identity: 'Bacteriostatic Water',
    lambda: BW_LAMBDA,
    ...o,
  })

describe('calc.test.js:533 2 mL prep: the factor, what is on the cartridge, MVD, MVC, floors', () => {
  it('matches Dennis', () => {
    // RECON_ML and DILUTION_2ML are the method's run parameters now. prepOf and
    // PREP_2ML_FROM (the stock / 2 mL switch) are worksheets.endo_prep (Task 1).
    expect(ENDO_RUN_PARAM_DEFAULTS.reconWaterMl).toBe(2)
    expect(ENDO_RUN_PARAM_DEFAULTS.stdTotalDilution).toBe(250)
    expect(targetDilutionOf(pep2(10), ctx)).toBe(250)
    expect(targetDilutionOf(pep2(10, tot(500)), ctx)).toBe(500)
    expect(targetDilutionOf(BW(), ctx)).toBeNull()
    expect(vialDilutionOf(pep2(10), ctx)).toBe(250) // 10 x 12.5 x 2
    expect(vialDilutionOf(pep2(10, tot(100)), ctx)).toBe(100) // step 2 1:5
    expect(vialDilutionOf(pep2(10, tot(500)), ctx)).toBe(500) // step 2 1:25
    expect(
      vialDilutionOf(pep2(10, { steps: [{ sampleUl: 100 }, null, null] }), ctx)
    ).toBe(250) // more sample, same 1:10: Tris follows
    expect(
      vialDilutionOf(
        pep2(10, { steps: [{ sampleUl: null, ratio: 5 }, null, null] }),
        ctx
      )
    ).toBe(250) // 1:5 in step 1 -> step 2 becomes 1:25, total holds
    expect(
      vialDilutionOf(
        pep2(10, { steps: [{ sampleUl: null, ratio: 0.5 }, null, null] }),
        ctx
      )
    ).toBeNull() // below 1:1 is not a dilution
    expect(
      vialDilutionOf(pep2(10, { steps: [{ sampleUl: 0 }, null, null] }), ctx)
    ).toBeNull() // no sample volume
    expect(vialDilutionOf(pep2(10, { steps: [null, null, null] }), ctx)).toBe(
      250
    ) // his steps: []
    expect(vialDilutionOf(BW(), ctx)).toBeNull()
    expect(waterOf(pep2(10), ctx)).toBe(2) // the standard
    expect(waterOf(pep2(10, { waterMl: 4 }), ctx)).toBe(4)
    expect(waterOf(pep2(10, { waterMl: 0 }), ctx)).toBe(2)
    expect(waterOf(BW(), ctx)).toBeNull()

    const a = prep2Check(pep2(10, { lambda: 0.05 }), ctx)
    expect([a.lambda, a.water, a.dilution]).toEqual([0.05, 2, 250])
    expect(a.loaded).toBe(0.02) // 10 mg / 2 mL / 250
    expect(a.mvd).toBe(3500) // 175 / 0.05
    near(a.mvc, (0.05 * 10) / 350)
    expect(a.valid).toBe(true)
    expect(a.needs).toBe(0.05)
    expect(a.floorShown).toBe(0.05) // the reading is per mL of the step 3 tube
    expect(a.floorVial).toBe(25) // x 250 x 2 mL
    expect(a.failAt).toBe(0.7) // 350 / (2 mL x 250), as displayed

    const b = prep2Check(pep2(1000, { lambda: 0.005 }), ctx)
    expect(b.loaded).toBe(2)
    expect(b.mvd).toBe(35000)
    near(b.mvc, (0.005 * 1000) / 350)
    expect(b.valid).toBe(true)
    expect(b.floorShown).toBe(0.005)
    expect(b.floorVial).toBe(2.5)
    // a big vial is valid even on the 0.05 at 250x
    expect(prep2Check(pep2(1000, { lambda: 0.05 }), ctx).valid).toBe(true)
    // the only way to be invalid is a factor above the MVD
    const over = prep2Check(pep2(10, { ...tot(4000), lambda: 0.05 }), ctx)
    expect(over.valid).toBe(false)
    expect(over.needs).toBe(0.01)
    expect(over.floorVial).toBe(400)
    expect(
      prep2Check(pep2(10, { ...tot(3500), lambda: 0.05 }), ctx).valid
    ).toBe(true) // exactly on it
    expect(
      prep2Check(pep2(10, { ...tot(40000), lambda: 0.005 }), ctx).needs
    ).toBeNull()
    // the row's cartridge is the lambda it is given (inheritance is the caller's)
    expect(prep2Check(pep2(10, { lambda: 0.01 }), ctx).lambda).toBe(0.01)
    const u = prep2Check(pep2(10), ctx) // no cartridge
    expect(u.lambda).toBeNull()
    expect(u.loaded).toBe(0.02)
    expect(u.mvd).toBeNull()
    expect(u.valid).toBeNull()
    expect(u.needs).toBe(0.05)
    expect(u.floorShown).toBeNull()
    // no weight: the floors and MVD are known, the load and validity are not
    const nw = prep2Check(pep2(null, { lambda: 0.05 }), ctx)
    expect([nw.loaded, nw.mvc, nw.valid, nw.needs]).toEqual([
      null,
      null,
      null,
      null,
    ])
    expect([nw.mvd, nw.floorShown, nw.floorVial]).toEqual([3500, 0.05, 25])
    // bac water: its 0.01 and its 20x; valid = its floor (0.2) is under 0.25
    const bw = prep2Check(BW(), ctx)
    expect([bw.lambda, bw.water, bw.dilution]).toEqual([0.01, null, 20])
    expect([bw.loaded, bw.mvd, bw.valid, bw.floorVial]).toEqual([
      null,
      null,
      true,
      null,
    ])
    // dissolved in 4 mL: half the load, half the MVD, twice the floor per vial
    const four = prep2Check(pep2(10, { waterMl: 4, lambda: 0.05 }), ctx)
    expect(four.water).toBe(4)
    expect(four.loaded).toBe(0.01)
    expect(four.mvd).toBe(1750)
    expect(four.floorShown).toBe(0.05)
    expect(four.floorVial).toBe(50)
    expect(four.failAt).toBe(0.35)
    expect(four.valid).toBe(true)
  })
})

describe('calc.test.js:602 2 mL prep: reading x total x water = EU/vial; verdict on the vial', () => {
  it('matches Dennis', () => {
    const on = (o: Partial<EndoSample>) => ({ lambda: 0.05, ...o })
    const r = prep2Result(pep2(10, on({ reading: '<0.05' })), ctx)
    expect(r.lt).toBe(true)
    expect(r.value).toBe(0.05)
    expect(r.euPerMlVial).toBe(12.5)
    expect(r.euPerVial).toBe(25)
    near(r.euPerMg, 2.5) // x 250, x 2 mL, / 10 mg
    expect(r.limitPerVial).toBe(350)
    expect(r.verdict).toBe('pass')
    expect(r.expectedFloor).toBe(0.05)
    expect(r.floorMismatch).toBe(false)
    const fine = prep2Result(
      pep2(1000, { lambda: 0.005, reading: '<0.005' }),
      ctx
    )
    expect(fine.euPerVial).toBe(2.5)
    near(fine.euPerMg, 0.0025)
    expect(fine.verdict).toBe('pass')
    expect(fine.floorMismatch).toBe(false)
    expect(prep2Result(pep2(10, on({ reading: '0.8' })), ctx).verdict).toBe(
      'fail'
    ) // 0.8 x 500 = 400 EU/vial
    expect(prep2Result(pep2(10, on({ reading: '0.7' })), ctx).verdict).toBe(
      'pass'
    ) // 350: the boundary passes
    const inc = prep2Result(
      pep2(10, on({ reading: '<0.05', ...tot(4000) })),
      ctx
    ) // < 400 per vial
    expect(inc.verdict).toBe('inconclusive')
    expect(inc.floorMismatch).toBe(false)
    const mm = prep2Result(pep2(10, on({ reading: '<0.005' })), ctx) // the 0.005's floor
    expect(mm.floorMismatch).toBe(true)
    expect(mm.expectedFloor).toBe(0.05)
    expect(mm.verdict).toBe('pass')
    const num1 = prep2Result(pep2(10, on({ reading: '0.1' })), ctx)
    expect(num1.euPerMlVial).toBe(25)
    expect(num1.euPerVial).toBe(50)
    near(num1.euPerMg, 5)
    expect(
      prep2Result(pep2(10, on({ reading: '0.1', ...tot(500) })), ctx).euPerVial
    ).toBe(100)
    // no mg: EU/vial and the verdict still exist; EU/mg does not
    const nw = prep2Result(pep2(null, on({ reading: '0.1' })), ctx)
    expect(nw.euPerVial).toBe(50)
    expect(nw.euPerMg).toBeNull()
    expect(nw.verdict).toBe('pass')
    // no cartridge: judged, no floor to compare
    const nc = prep2Result(pep2(10, { reading: '<0.05' }), ctx)
    expect(nc.verdict).toBe('pass')
    expect(nc.expectedFloor).toBeNull()
    expect(nc.floorMismatch).toBe(false)
    const bw = prep2Result(BW({ reading: '<2.5' }), ctx)
    expect(bw.value).toBe(2.5)
    expect(bw.euPerVial).toBeNull()
    expect(bw.verdict).toBe('inconclusive') // <2.5 is above 0.25
    const blank = prep2Result(pep2(10, on({})), ctx)
    expect(blank.value).toBeNull()
    expect(blank.verdict).toBeNull()
    expect(blank.limitPerVial).toBe(350)
    expect(
      prep2Result(pep2(10, on({ reading: 'pending' })), ctx).verdict
    ).toBeNull()
    // the same displayed reading on a 4 mL row is twice the EU per vial
    const four = prep2Result(
      pep2(10, on({ waterMl: 4, reading: '<0.05' })),
      ctx
    )
    expect(four.euPerVial).toBe(50)
    near(four.euPerMg, 5)
    expect(four.verdict).toBe('pass')
    expect(
      prep2Result(pep2(10, on({ waterMl: 4, reading: '0.4' })), ctx).verdict
    ).toBe('fail') // 0.4 x 250 x 4 = 400
    // an unmakeable total: no EU/vial and no verdict
    const un = prep2Result(pep2(10, on({ reading: '0.1', ...tot(15) })), ctx)
    expect(un.value).toBe(0.1)
    expect(un.euPerVial).toBeNull()
    expect(un.verdict).toBeNull()
  })
})

describe('calc.test.js:641 the 2 mL fields, and no stock fields from this module', () => {
  it('matches Dennis (prepareRun strings rebuilt from the check and result)', () => {
    // The prep switch is the caller's (worksheets.endo_prep); this module only
    // knows the 2 mL model. His prepareRun row is rebuilt from its parts.
    const s = pep2(10, { lambda: 0.05, reading: '<0.05' })
    const k = prep2Check(s, ctx)
    const rs = prep2Result(s, ctx)
    expect(fmt(k.water)).toBe('2')
    expect(fmt(k.dilution)).toBe('250')
    expect(fmtConc(k.loaded)).toBe('0.02')
    expect(fmt(k.mvd)).toBe('3500')
    expect(fmtConc(k.mvc)).toBe('0.0014')
    expect(k.valid).toBe(true)
    expect(k.needs).toBe(0.05)
    expect(fmt(k.floorVial)).toBe('25') // per vial on a 2 mL run
    expect(s.reading).toBe('<0.05')
    expect(fmtEu(!!rs.lt, rs.euPerMlVial)).toBe('<12.5')
    expect(fmtEu(!!rs.lt, rs.euPerVial)).toBe('<25')
    expect(fmtEu(!!rs.lt, rs.euPerMg)).toBe('<2.5')
    expect(fmt(rs.limitPerVial)).toBe('350')
    expect(rs.verdict).toBe('pass')
    // his stock-only columns are never produced here
    for (const key of [
      'dissolutionMl',
      'sampleUl',
      'lalUl',
      'vialConc',
      'cartridgeDilution',
      'totalDilution',
      'euStock',
    ]) {
      expect(Object.keys(k)).not.toContain(key)
      expect(Object.keys(rs)).not.toContain(key)
    }
    const ov = prep2Check(pep2(10, { ...tot(100), lambda: 0.05 }), ctx)
    expect(fmt(ov.dilution)).toBe('100')
    expect(fmtConc(ov.loaded)).toBe('0.05')
    expect(fmt(ov.floorVial)).toBe('10')
    const four = pep2(10, { waterMl: 4, lambda: 0.05, reading: '<0.05' })
    expect(fmt(prep2Check(four, ctx).water)).toBe('4')
    expect(fmt(prep2Check(four, ctx).floorVial)).toBe('50')
    expect(fmtEu(true, prep2Result(four, ctx).euPerVial)).toBe('<50')
    const bw = BW()
    expect(waterOf(bw, ctx)).toBeNull() // his water ""
    expect(prep2Check(bw, ctx).dilution).toBe(20)
    // bac water still shows its 50 + 950, from the shared stock helper
    expect(fmtUl(calcEndoPrep({ sampleId: 'BW-1' }).sampleUl)).toBe('50')
    expect(prep2Result(bw, ctx).verdict).toBeNull()
    // the stock path byte-for-byte: endo-prep.ts and its tests, untouched.
    // fromStored (df, st): Mk1 stores prep_total_dilution and prep_steps; the
    // maths his storage lines checked:
    expect(
      vialDilutionOf(
        pep2(10, { ...tot(500), steps: [null, { sampleUl: 40 }, null] }),
        ctx
      )
    ).toBe(500)
    expect(
      vialDilutionOf(
        pep2(10, { steps: [{ sampleUl: 100, ratio: 5 }, null, null] }),
        ctx
      )
    ).toBe(250) // step 2 absorbs it
  })
})

describe('calc.test.js:670 dilution scheme: total first; step 1 by ratio, step 2 derived, step 3 fixed at 1:2', () => {
  it('matches Dennis', () => {
    expect(DILUTION_STEPS).toHaveLength(3)
    expect(DILUTION_STEPS[0]).toEqual({
      sampleUl: 20,
      ratio: 10,
      byRatio: true,
      diluent: '0.1 M Tris (BT103)',
    })
    expect(DILUTION_STEPS[1]).toEqual({
      sampleUl: 20,
      derived: true,
      diluent: 'LAL reagent water',
    })
    expect(DILUTION_STEPS[2]).toEqual({
      sampleUl: 125,
      ratio: 2,
      fixed: true,
      diluent: 'beta-glucan blocker (BG600)',
    })
    expect(ENDO_RUN_PARAM_DEFAULTS.stdTotalDilution).toBe(250)
    expect(TUBE_UL).toBe(1500)
    const p0 = ctx.params
    expect(stdStep(DILUTION_STEPS[0], p0)).toEqual({
      sampleUl: 20,
      diluentUl: 180,
      ratio: 10,
    })
    expect(stdStep(DILUTION_STEPS[1], p0)).toEqual({
      sampleUl: 20,
      diluentUl: 230,
      ratio: 12.5,
    })
    expect(stdStep(DILUTION_STEPS[2], p0)).toEqual({
      sampleUl: 125,
      diluentUl: 125,
      ratio: 2,
    })
    expect(stepFactor({ sampleUl: 50, diluentUl: 450 })).toBe(10)
    expect(stepFactor({ sampleUl: 0, diluentUl: 450 })).toBeNull()
    expect(stepFactor({ sampleUl: 50, diluentUl: null })).toBeNull()

    // the standard: 1:10 x 1:12.5 x 1:2 = 1:250, everything fits
    const p = dilutionPlan(pep2(10), ctx)
    expect(p.target).toBe(250)
    expect(
      p.steps.map(s => [
        s.ratio,
        s.diluentUl,
        s.totalUl,
        s.running,
        s.fits,
        s.own,
      ])
    ).toEqual([
      [10, 180, 200, 10, true, false],
      [12.5, 230, 250, 125, true, false],
      [2, 125, 250, 250, true, false],
    ])
    expect(p.total).toBe(250)
    expect(p.fits).toBe(true)
    expect(p.standard).toBe(true)

    // 1:10 then 1:25 for 1:500; 1:10 then 1:20 for 1:400
    const d500 = dilutionPlan(pep2(10, tot(500)), ctx)
    expect(d500.steps[1]?.ratio).toBe(25)
    expect(d500.total).toBe(500)
    expect(d500.standard).toBe(false)
    expect(d500.steps[1]?.diluentUl).toBe(480)
    expect(d500.steps[1]?.fits).toBe(true) // 20 + 480 fits
    // more sample than the tube allows at 1:25: 100 + 2400 does not fit
    const d500b = dilutionPlan(
      pep2(10, { ...tot(500), steps: [null, { sampleUl: 100 }, null] }),
      ctx
    )
    expect(d500b.steps[1]?.diluentUl).toBe(2400)
    expect(d500b.steps[1]?.fits).toBe(false)
    expect(d500b.fits).toBe(false)
    const d500s = dilutionPlan(
      pep2(10, { ...tot(500), steps: [null, { sampleUl: 40 }, null] }),
      ctx
    )
    expect(d500s.steps[1]?.diluentUl).toBe(960)
    expect(d500s.steps[1]?.fits).toBe(true)
    expect(d500s.total).toBe(500)
    const d400 = dilutionPlan(pep2(10, tot(400)), ctx)
    expect(d400.steps[1]?.ratio).toBe(20)
    expect(d400.steps[1]?.diluentUl).toBe(380)
    expect(d400.total).toBe(400)

    // step 1 changed: step 2 follows so the total holds
    const r5 = dilutionPlan(
      pep2(10, { steps: [{ sampleUl: null, ratio: 5 }, null, null] }),
      ctx
    )
    expect([
      r5.steps[0]?.diluentUl,
      r5.steps[1]?.ratio,
      r5.steps[1]?.diluentUl,
      r5.total,
    ]).toEqual([80, 25, 480, 250])
    const r20 = dilutionPlan(
      pep2(10, { steps: [{ ratio: 20, sampleUl: 25 }, null, null] }),
      ctx
    )
    expect([
      r20.steps[0]?.diluentUl,
      r20.steps[1]?.ratio,
      r20.steps[1]?.diluentUl,
      r20.total,
    ]).toEqual([475, 6.25, 105, 250])
    // the standard typed out is not an override
    expect(
      dilutionPlan(
        pep2(10, {
          ...tot(250),
          steps: [
            { sampleUl: 20, ratio: 10 },
            { sampleUl: 20 },
            { sampleUl: 125 },
          ],
        }),
        ctx
      ).standard
    ).toBe(true)
    // step 3 sample volume: BG600 equals it
    const s3 = dilutionPlan(
      pep2(10, { steps: [null, null, { sampleUl: 250 }] }),
      ctx
    )
    expect([
      s3.steps[2]?.sampleUl,
      s3.steps[2]?.diluentUl,
      s3.steps[2]?.ratio,
      s3.total,
    ]).toEqual([250, 250, 2, 250])

    // a total too small for step 1 x step 3: step 2 below 1:1, no total
    const small = dilutionPlan(pep2(10, tot(15)), ctx)
    expect(small.steps[1]?.ratio).toBe(0.75)
    expect(small.steps[1]?.diluentUl).toBeNull()
    expect(small.steps[1]?.running).toBeNull() // his factor null
    expect(small.total).toBeNull()
    // a total of exactly step 1 x step 3: step 2 is 1:1 (no water), allowed
    const t20 = dilutionPlan(pep2(10, tot(20)), ctx)
    expect([t20.steps[1]?.diluentUl, t20.total]).toEqual([0, 20])
    // step 1 below 1:1
    const bad = dilutionPlan(
      pep2(10, { steps: [{ sampleUl: null, ratio: 0.5 }, null, null] }),
      ctx
    )
    expect([
      bad.steps[0]?.diluentUl,
      bad.steps[0]?.totalUl,
      bad.steps[0]?.running,
      bad.total,
    ]).toEqual([null, null, null, null])
    // no sample volume in step 2
    const none = dilutionPlan(
      pep2(10, { steps: [null, { sampleUl: 0 }, null] }),
      ctx
    )
    expect(none.steps[1]?.running).toBeNull()
    expect(none.total).toBeNull()
    // his dilutionPlan(bac water) is null; here: no steps, its one 20x
    expect(dilutionPlan(BW(), ctx)).toEqual({
      steps: [],
      target: BW_DILUTION,
      total: BW_DILUTION,
      fits: true,
      standard: true,
    })
    // a total the steps cannot make: the cartridge check has nothing to judge
    const k15 = prep2Check(pep2(10, { ...tot(15), lambda: 0.05 }), ctx)
    expect([
      k15.water,
      k15.dilution,
      k15.loaded,
      k15.floorShown,
      k15.valid,
      k15.needs,
    ]).toEqual([2, null, null, null, null, null])
    const r15 = prep2Result(
      pep2(10, { ...tot(15), lambda: 0.05, reading: '<1' }),
      ctx
    )
    expect(r15.expectedFloor).toBeNull()
    expect(r15.euPerVial).toBeNull()
  })
})

describe('calc.test.js:820 LOD is the cartridge limit (EU/mL); LOQ carries it to the vial (EU/vial)', () => {
  it('matches Dennis', () => {
    const a = prep2Check(pep2(10, { lambda: 0.05 }), ctx)
    expect(a.lod).toBe(0.05)
    expect(a.loqVial).toBe(25) // 0.05 x 250 x 2 mL
    // the dilution moves the LOQ, never the LOD
    const b = prep2Check(pep2(10, { ...tot(500), lambda: 0.05 }), ctx)
    expect(b.lod).toBe(0.05)
    expect(b.loqVial).toBe(50)
    expect(
      prep2Check(pep2(10, { waterMl: 4, lambda: 0.05 }), ctx).loqVial
    ).toBe(50) // x 4 mL
    expect(prep2Check(pep2(10, { lambda: 0.01 }), ctx).lod).toBe(0.01)
    expect(prep2Check(pep2(10, { lambda: 0.005 }), ctx).loqVial).toBe(2.5)
    // no cartridge, bac water, an unmakeable total: no limits
    expect(prep2Check(pep2(10), ctx).lod).toBeNull()
    expect(prep2Check(BW(), ctx).loqVial).toBeNull()
    expect(
      prep2Check(pep2(10, { ...tot(15), lambda: 0.05 }), ctx).loqVial
    ).toBeNull()
  })
})

describe('calc.test.js:835 bacteriostatic water: the same 20x prep on a 2 mL run as on a stock run', () => {
  it('matches Dennis (method-rule clause is slice 5)', () => {
    for (const s of [
      BW({ sampleId: 'BW-9001', identity: 'Bacteriostatic Water' }),
      BW({ sampleId: 'P-9002', identity: 'Bacteriostatic water 30 mL' }),
      // his weight note "20X Dilution in 1 EU/mL Cartridge" has no Mk1 field
      BW({ sampleId: 'BW-9003', identity: 'Bac Water' }),
    ]) {
      // the prep itself: 50 uL + 950 uL LAL water, 20x, identical either way
      const stock = calcEndoPrep({ sampleId: s.sampleId, identity: s.identity })
      expect([stock.sampleUl, stock.lalUl, stock.dilution]).toEqual([
        50, 950, 20,
      ])
      const k = prep2Check(s, ctx)
      expect(k.dilution).toBe(stock.dilution)
      expect(formOf(s)).toBe('bac')
      expect(waterOf(s, ctx)).toBeNull() // no reconstitution: already a liquid
      expect(prep2Result(s, ctx).verdict).toBeNull() // no result typed
      expect(prep2Result(s, ctx).euPerVial).toBeNull()
      expect(k.loqVial).toBeNull()
      expect(k.lod).toBe(0.01)
      expect(k.floorShown).toBe(0.2)
      // a reading is judged against 0.25 EU/mL; it has no EU/vial
      const r = prep2Result({ ...s, reading: '<0.2' }, ctx)
      expect(r.value).toBe(0.2)
      expect(r.euPerVial).toBeNull()
      expect(r.verdict).toBe('pass')
    }
  })
})

describe('calc.test.js:861 bac water sorts to the bottom and runs on the 0.01 cartridge', () => {
  it('matches Dennis', () => {
    expect(BW_LAMBDA).toBe(0.01)
    // Mk1's due comes from the SLA engine; his received dates stand in for it
    // (same order). orderForBench is the bench order, orderByTotal groups it.
    const rows = [
      {
        due: '2026-10-01',
        priority: 'expedited',
        s: BW({ sampleId: 'BW-1' }),
      },
      { due: '2026-10-05', priority: null, s: pep2(10, { sampleId: 'P-2' }) },
      { due: '2026-10-01', priority: null, s: pep2(10, { sampleId: 'P-1' }) },
      {
        due: '2026-10-03',
        priority: null,
        s: BW({ sampleId: 'BW-2', identity: 'Bac water' }),
      },
    ]
    const bench = orderForBench(rows, r => ({
      due: r.due,
      priority: r.priority,
    }))
    expect(orderByTotal(bench, r => r.s, ctx).map(r => r.s.sampleId)).toEqual([
      'P-1',
      'P-2',
      'BW-1',
      'BW-2',
    ]) // bac water last, then by due
    // his rows[0].cartridge "0.05" / rows[2].cartridge "0.01": the caller
    // resolves the row's lambda (spec 4.3, Task 13 endoSampleFor); the check
    // reports what it is given, and a cartridge typed on the row wins there.
    expect(prep2Check(BW(), ctx).lambda).toBe(0.01)
    expect(prep2Check(BW({ lambda: 0.005 }), ctx).lambda).toBe(0.005)
    // stock-run and method-rule clauses: not this module
  })

  it('orders by total: numbers ascending, unmakeable next, bac water last (spec 5)', () => {
    const rows = [
      pep2(10, { sampleId: 'A', ...tot(500) }),
      pep2(10, { sampleId: 'B' }),
      pep2(10, { sampleId: 'C', ...tot(15) }),
      BW({ sampleId: 'BW-D' }),
      pep2(10, { sampleId: 'E', ...tot(300) }),
      pep2(10, { sampleId: 'F' }),
    ]
    expect(orderByTotal(rows, r => r, ctx).map(r => r.sampleId)).toEqual([
      'B',
      'F',
      'E',
      'A',
      'C',
      'BW-D',
    ])
  })
})

describe('calc.test.js:879 bac water on 2 mL runs: 0.25 EU/mL, a clean run reads <0.2 on the 0.01', () => {
  it('matches Dennis', () => {
    expect(BW_LIMIT_EU_PER_ML).toBe(0.25)
    const k = prep2Check(BW(), ctx)
    expect(k.lambda).toBe(0.01)
    expect(k.floorShown).toBe(0.2)
    expect(k.loqMl).toBe(0.2)
    expect(k.lod).toBe(0.01)
    expect(k.failAt).toBe(0.25)
    expect(k.valid).toBe(true)
    expect(k.needs).toBe(0.01)
    expect(k.loqVial).toBeNull()
    expect(k.water).toBeNull()
    // the 0.05 cannot prove the limit: floor 1 > 0.25
    const k5 = prep2Check(BW({ lambda: 0.05 }), ctx)
    expect(k5.floorShown).toBe(1)
    expect(k5.valid).toBe(false)
    expect(k5.needs).toBe(0.01)
    const clean = prep2Result(BW({ reading: '<0.2' }), ctx)
    expect(clean.verdict).toBe('pass')
    expect(clean.floorMismatch).toBe(false)
    expect(clean.limitPerMl).toBe(0.25)
    expect(clean.limitPerVial).toBeNull()
    expect(clean.euPerVial).toBeNull()
    expect(prep2Result(BW({ reading: '0.25' }), ctx).verdict).toBe('pass') // the boundary
    expect(prep2Result(BW({ reading: '0.26' }), ctx).verdict).toBe('fail')
    expect(prep2Result(BW({ reading: '<1', lambda: 0.05 }), ctx).verdict).toBe(
      'inconclusive'
    )
    // typed at factor 1 by mistake: <0.01 is not this prep's floor
    expect(prep2Result(BW({ reading: '<0.01' }), ctx).floorMismatch).toBe(true)
    expect(judgeWater(false, 0.2)).toBe('pass')
    expect(judgeWater(true, 0.5)).toBe('inconclusive')
    // his prepareRun strings: limitPerMl "0.25", limitPerVial ""
    expect(fmt(clean.limitPerMl)).toBe('0.25')
    expect(fmt(clean.limitPerVial)).toBe('')
    // stock runs keep bac water not assessed: endo-prep.ts, untouched
  })
})

describe('calc.test.js:906 form: a liquid (reconstituted) vial uses the customer water in place of the 2 mL', () => {
  it('matches Dennis', () => {
    expect(FORMS.map(f => f[0])).toEqual(['powder', 'liquid', 'bac'])
    expect(formOf(sample())).toBe('powder')
    expect(formOf(BW())).toBe('bac')
    expect(formOf(sample({ form: 'liquid' }))).toBe('liquid')
    // a form set by hand wins over the ID / identity, either way
    const asBac = sample({ sampleId: 'P-7', form: 'bac' })
    expect(formOf(asBac)).toBe('bac')
    expect(prep2Check(asBac, ctx).dilution).toBe(20)
    const asPowder = BW({ sampleId: 'BW-7', form: 'powder', weightMg: 10 })
    expect(formOf(asPowder)).toBe('powder')
    expect(vialDilutionOf(asPowder, ctx)).toBe(250) // a peptide prep, not 20x
    const liq = (o: Partial<EndoSample> = {}) =>
      pep2(10, { form: 'liquid', lambda: 0.05, ...o })
    // no volume typed: no 2 mL default, nothing scaled or judged
    expect(waterOf(liq(), ctx)).toBeNull()
    const k0 = prep2Check(liq(), ctx)
    expect([k0.water, k0.dilution, k0.loaded]).toEqual([null, 250, null])
    const r0 = prep2Result(liq({ reading: '<0.05' }), ctx)
    expect([r0.value, r0.euPerVial, r0.verdict]).toEqual([0.05, null, null])
    // 3 mL of the customer's water: everything scales by 3
    const k3 = prep2Check(liq({ waterMl: 3 }), ctx)
    expect(k3.water).toBe(3)
    near(k3.loaded, 10 / 3 / 250)
    expect(k3.loqVial).toBe(37.5) // 0.05 x 250 x 3
    const r3 = prep2Result(liq({ waterMl: 3, reading: '0.4' }), ctx)
    expect(r3.euPerVial).toBe(300) // 0.4 x 250 x 3
    expect(r3.verdict).toBe('pass')
    expect(prep2Result(liq({ waterMl: 3, reading: '0.5' }), ctx).verdict).toBe(
      'fail'
    ) // 375
    // the same numbers as a powder dissolved in 3 mL
    expect(
      prep2Result(liq({ waterMl: 3, reading: '0.4', form: 'powder' }), ctx)
        .euPerVial
    ).toBe(300)
    // his prepareRun row: form "liquid", water "3"
    expect(formOf(liq({ waterMl: 3 }))).toBe('liquid')
    expect(fmt(waterOf(liq({ waterMl: 3 }), ctx))).toBe('3')
  })
})

describe('calc.test.js:934 Accu-Mk1 value: EU/vial for peptides, EU/mL for bac water, the < kept', () => {
  it('matches Dennis', () => {
    const pep = (o: Partial<EndoSample> = {}) =>
      pep2(10, { lambda: 0.05, ...o })
    expect(mk1Value(pep({ reading: '<0.05' }), ctx)).toEqual({
      value: '<25',
      unit: 'EU/vial',
      verdict: 'pass',
    })
    expect(mk1Value(pep({ reading: '0.4' }), ctx)).toEqual({
      value: '200',
      unit: 'EU/vial',
      verdict: 'pass',
    }) // 0.4 x 250 x 2
    expect(mk1Value(BW({ reading: '<0.2' }), ctx)).toEqual({
      value: '<0.2',
      unit: 'EU/mL',
      verdict: 'pass',
    })
    expect(mk1Value(BW({ reading: '0.3' }), ctx)).toEqual({
      value: '0.3',
      unit: 'EU/mL',
      verdict: 'fail',
    })
    // nothing to report yet
    expect(mk1Value(pep(), ctx)).toBeNull()
    expect(mk1Value(pep({ reading: 'pending' }), ctx)).toBeNull()
    expect(mk1Value(pep({ form: 'liquid', reading: '0.4' }), ctx)).toBeNull()
    expect(
      mk1Value(pep({ form: 'liquid', waterMl: 3, reading: '0.4' }), ctx)?.value
    ).toBe('300')
    // his prepareRun pair, and stock runs promote nothing (no Results box)
    expect(
      [pep({ reading: '<0.05' }), BW({ reading: '<0.2' })].map(s => {
        const v = mk1Value(s, ctx)
        return [v?.value, v?.unit]
      })
    ).toEqual([
      ['<25', 'EU/vial'],
      ['<0.2', 'EU/mL'],
    ])
  })
})

describe("the reader's invalid verdict (contract rule; Dennis's case, calc.test.js:1016, is in endo-reader.test.ts)", () => {
  it('a failed reader test is invalid whatever the reading, and never reaches Mk1', () => {
    const reader: EndoReaderRecord = {
      test_id: 'T-1',
      reader: null,
      slot: null,
      operator: null,
      tested_at: null,
      temp_start: null,
      temp_end: null,
      software: null,
      cartridge_lot: null,
      cartridge_expiry: null,
      cartridge_range: null,
      spike_level: null,
      recovery: 44,
      rec_min: 50,
      rec_max: 200,
      sample_cv: null,
      spike_cv: null,
      cv_limit: null,
      reader_pass: false,
      valid: false,
      why: ['spike recovery 44 % outside 50-200 %'],
      file_name: 'test.csv',
    }
    const s = pep2(10, { lambda: 0.05, reading: '<0.05', reader })
    const r = prep2Result(s, ctx)
    expect(r.verdict).toBe('invalid')
    expect(r.euPerVial).toBe(25) // the numbers still show
    expect(mk1Value(s, ctx)).toBeNull()
    expect(
      prep2Result({ ...s, reader: { ...reader, valid: true, why: [] } }, ctx)
        .verdict
    ).toBe('pass')
  })
})

describe('calc.test.js:196 the limit is 350 EU per vial; per mg it is 350 over the declared mass', () => {
  it('matches Dennis', () => {
    expect(LIMIT_EU_PER_VIAL).toBe(350)
    const pep = (w: number | null) => sample({ weightMg: w, waterMl: 1 })
    expect(limitPerMg(pep(10))).toBe(35)
    expect(limitPerMg(pep(70))).toBe(5)
    expect(limitPerMg(pep(1000))).toBe(0.35)
    expect(limitPerMg(pep(null))).toBeNull()
    expect(limitPerMg(pep(0))).toBeNull()
    expect(limitPerMg(BW())).toBeNull()
    // DILUTION_TO_CARTRIDGE is the stock model's; the cartridge keys are
    // catalog rows now (consumable_types), not module data
  })
})

describe('calc.test.js:210 MVC is lambda over the row limit per mg', () => {
  it('matches Dennis', () => {
    const pep = (w: number | null) => sample({ weightMg: w, waterMl: 1 })
    near(mvcFor(0.05, pep(10)), (0.05 * 10) / 350)
    near(mvcFor(0.01, pep(10)), (0.01 * 10) / 350)
    near(mvcFor(0.005, pep(10)), (0.005 * 10) / 350)
    expect(mvcFor(0.05, pep(140))).toBe(0.02) // the 0.05's last valid vial at 50x
    expect(mvcFor(0.01, pep(700))).toBe(0.02)
    expect(mvcFor(0.005, pep(1400))).toBe(0.02)
    near(mvcFor(0.05, pep(1000)), (0.05 * 1000) / 350)
    expect(mvcFor(null, pep(10))).toBeNull() // his unknown cartridge "0.1"
    expect(mvcFor(0.05, pep(null))).toBeNull()
    expect(mvcFor(0.05, BW())).toBeNull()
  })
})

describe('calc.test.js:352 parseResult -> parseReading, keeping the <', () => {
  it('matches Dennis (no raw; unparseable text is null)', () => {
    expect(parseReading('<2.5')).toEqual({ lt: true, value: 2.5 })
    expect(parseReading(' < 2.5 ')).toEqual({ lt: true, value: 2.5 })
    expect(parseReading('0.8')).toEqual({ lt: false, value: 0.8 })
    expect(parseReading('.5')).toEqual({ lt: false, value: 0.5 })
    expect(parseReading('')).toBeNull()
    expect(parseReading(null)).toBeNull()
    expect(parseReading('n/a')).toBeNull() // his { lt: false, value: null, raw }
  })

  it('RF2: the readings the backend accepts, and nothing else', () => {
    expect(parseReading('< 0.05')).toEqual({ lt: true, value: 0.05 })
    expect(parseReading(' 0.8 ')).toEqual({ lt: false, value: 0.8 })
    expect(parseReading('0')).toEqual({ lt: false, value: 0 })
    for (const bad of ['0,8', '-1', '<0', 'abc', ''])
      expect(parseReading(bad)).toBeNull()
  })
})

describe('calc.test.js:480 the limit per vial is 350, flat, whatever the declared mass', () => {
  it('matches Dennis', () => {
    expect(limitPerVial(sample({ weightMg: 10 }))).toBe(350)
    expect(limitPerVial(sample({ weightMg: 1000 }))).toBe(350)
    expect(limitPerVial(sample())).toBe(350) // before the weight exists
    expect(limitPerVial(BW())).toBeNull()
    // it rides along with the result, with or without a reading (his stock
    // vectors <2.5 and 36 are the 2 mL <0.05 and 0.8 of calc.test.js:602)
    const s = pep2(10, { lambda: 0.05 })
    expect(prep2Result(s, ctx).limitPerVial).toBe(350)
    const r = prep2Result({ ...s, reading: '<0.05' }, ctx)
    expect(r.limitPerVial).toBe(350)
    expect((r.euPerVial ?? Infinity) < 350 && r.verdict === 'pass').toBe(true) // <25 of 350
    const f = prep2Result({ ...s, reading: '0.8' }, ctx)
    expect((f.euPerVial ?? 0) > 350 && f.verdict === 'fail').toBe(true) // 400 of 350
    expect(fmt(r.limitPerVial)).toBe('350')
  })
})

describe('calc.test.js:517 tiny loaded concentrations keep their significant figures', () => {
  it('matches Dennis', () => {
    expect(fmtConc(0.02)).toBe('0.02')
    expect(fmtConc(0.0005)).toBe('0.0005')
    expect(fmtConc(0.001)).toBe('0.001')
    expect(fmtConc(null)).toBe('')
    // his prepareRun "0.0005" is a stock row at 2000x: not this module
  })
})

describe('run parameters and the allowed cartridges come from the method, not constants', () => {
  const ctx2: EndoCtx = {
    params: {
      ...ENDO_RUN_PARAM_DEFAULTS,
      stdTotalDilution: 500,
      reconWaterMl: 3,
    },
    allowedLambdas: [0.005, 0.01, 0.05], // any order
  }

  it('a method standard of 1:500 in 3 mL moves the target, water, load and EU/vial', () => {
    const s = pep2(30, { lambda: 0.05, reading: '0.1' })
    expect(targetDilutionOf(s, ctx2)).toBe(500)
    expect(waterOf(s, ctx2)).toBe(3)
    expect(dilutionPlan(s, ctx2).steps[1]?.ratio).toBe(25) // 500 / (10 x 2)
    expect(dilutionPlan(s, ctx2).standard).toBe(true)
    expect(dilutionPlan(pep2(30, tot(250)), ctx2).standard).toBe(false)
    expect(prep2Check(s, ctx2).loaded).toBe(0.02) // 30 / 3 / 500
    expect(prep2Result(s, ctx2).euPerVial).toBe(150) // 0.1 x 500 x 3
    expect(stdStep(DILUTION_STEPS[1], ctx2.params).diluentUl).toBe(480)
  })

  it('needs searches the allowed list least sensitive first, whatever its order', () => {
    expect(prep2Check(pep2(10, { lambda: 0.05 }), ctx2).needs).toBe(0.05)
    const no05: EndoCtx = { ...ctx2, allowedLambdas: [0.005, 0.01] }
    expect(prep2Check(pep2(10, { lambda: 0.01 }), no05).needs).toBe(0.01)
    expect(prep2Check(BW(), { ...ctx, allowedLambdas: [] }).needs).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/endo-prep-2ml.test.ts`
Expected: FAIL. The suite cannot load: the import `@/lib/endo-prep-2ml` does not resolve (vite reports "Failed to resolve import" / "Cannot find package"); 0 tests run.

- [ ] **Step 3: Implement**

`src/lib/endo-prep-2ml.ts` (Dennis's arithmetic order and rounding are kept exactly: every `Math.round(x * 1e6) / 1e6` is `r6`, every `1e9` is `r9`, and `mvcFor` divides `lambda / (350 / mg)`, never `lambda * mg / 350`; the `toBe` equalities depend on it):

```ts
/**
 * Endotoxin (LAL) 2 mL prep: the bench steps, the cartridge check, the result
 * scaled to the vial, the verdict and the value for Accu-Mk1.
 *
 * Ported from tools-dennis/tools/endotoxin-log/calc.js at 5ef2a62 (the "2 mL
 * prep" block, Dennis 2026-10-08 to 2026-10-09). The arithmetic, its order and
 * its rounding are his. What differs, all required by
 * docs/superpowers/specs/2026-10-10-endo-worksheet-v2-design.md:
 * - A cartridge is its sensitivity (lambda, EU/mL) from the consumables
 *   catalog. The caller resolves the row's lambda (spec 4.3, including bac
 *   water's 0.01) and passes the method's allowed lambdas for `needs`.
 * - The standard total dilution and the reconstitution water come from the
 *   method's run parameters (ctx.params), never module constants (spec 4.4).
 * - Method rules and their rule lock are not here (slice 5).
 * - A reading whose reader test failed spike recovery or CV is 'invalid'.
 * Pure: no DOM, no fetch, no storage. Stock worksheets keep endo-prep.ts.
 */
import { DEFAULT_DILUTION, fmt, isBacWater } from '@/lib/endo-prep'

export type EndoForm = 'powder' | 'liquid' | 'bac'
export type EndoVerdict = 'pass' | 'fail' | 'inconclusive' | 'invalid' | null

export interface EndoRunParams {
  stdTotalDilution: number
  reconWaterMl: number
  spikeRecoveryMinPct: number
  spikeRecoveryMaxPct: number
  cvLimitPct: number
}

/** Dennis's values; a method's run_parameters.endotoxin overrides any of them. */
export const ENDO_RUN_PARAM_DEFAULTS: EndoRunParams = {
  stdTotalDilution: 250,
  reconWaterMl: 2,
  spikeRecoveryMinPct: 50,
  spikeRecoveryMaxPct: 200,
  cvLimitPct: 25,
}

/** A row's own step values; a null field means "the standard". */
export interface EndoStepOverride {
  sampleUl: number | null
  ratio?: number | null
}

/** The reader's record for one test, stored as worksheet_items.result_reader. */
export interface EndoReaderRecord {
  test_id: string
  reader: string | null
  slot: number | null
  operator: string | null
  tested_at: string | null
  temp_start: number | null
  temp_end: number | null
  software: string | null
  cartridge_lot: string | null
  cartridge_expiry: string | null
  cartridge_range: string | null
  spike_level: number | null
  recovery: number | null
  rec_min: number | null
  rec_max: number | null
  sample_cv: number | null
  spike_cv: number | null
  cv_limit: number | null
  reader_pass: boolean | null
  valid: boolean
  why: string[]
  file_name: string
}

export interface EndoSample {
  sampleId: string
  identity: string
  sampleType: string | null
  weightMg: number | null
  form: EndoForm | null
  waterMl: number | null
  totalDilution: number | null
  steps:
    | [
        EndoStepOverride | null,
        EndoStepOverride | null,
        EndoStepOverride | null,
      ]
    | null
  /** The row's resolved cartridge sensitivity, EU/mL (spec 4.3). */
  lambda: number | null
  reading: string | null
  reader: EndoReaderRecord | null
}

export interface EndoCtx {
  params: EndoRunParams
  allowedLambdas: number[]
}

/**
 * 350 EU per vial, flat (Dennis 2026-10-08): USP <85> K = 5 EU/kg x 70 kg with
 * the whole vial as one dose. The worksheet's working limit, not the COA spec.
 */
export const LIMIT_EU_PER_VIAL = 350
/** Bac water: 0.25 EU/mL of the water itself, the USP limit for WFI. */
export const BW_LIMIT_EU_PER_ML = 0.25
/** Bac water goes into the cartridge 20x, as on stock runs (LAL SOP). */
export const BW_DILUTION = DEFAULT_DILUTION
/** Bac water runs on the 0.01 unless its row says otherwise (caller, 4.3). */
export const BW_LAMBDA = 0.01
/** Every step is made in a 1.5 mL tube. */
export const TUBE_UL = 1500

export const FORMS: [EndoForm, string][] = [
  ['powder', 'Lyophilized'],
  ['liquid', 'Liquid (reconstituted)'],
  ['bac', 'Bacteriostatic water'],
]

/** Step 1 is 1:10 in Tris as standard; step 3 is 1:2 in BG600, fixed. */
const STEP1_RATIO = 10
const STEP3_RATIO = 2

export interface EndoStepDef {
  sampleUl: number
  ratio?: number
  byRatio?: boolean
  derived?: boolean
  fixed?: boolean
  diluent: string
}

/**
 * The bench steps from the vial solution to the cartridge (Dennis
 * 2026-10-08). Step 1 is ratio-driven (Tris first, per the BT103 insert);
 * step 2's ratio is derived from the row's total; step 3 is fixed at 1:2 so
 * BG600 is half of what goes on the cartridge. The sample volumes are
 * suggestions; a row types its own when it needs to.
 */
export const DILUTION_STEPS: readonly [EndoStepDef, EndoStepDef, EndoStepDef] =
  [
    {
      sampleUl: 20,
      ratio: STEP1_RATIO,
      byRatio: true,
      diluent: '0.1 M Tris (BT103)',
    },
    { sampleUl: 20, derived: true, diluent: 'LAL reagent water' },
    {
      sampleUl: 125,
      ratio: STEP3_RATIO,
      fixed: true,
      diluent: 'beta-glucan blocker (BG600)',
    },
  ]

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6
const r9 = (x: number): number => Math.round(x * 1e9) / 1e9

/** A finite number, else null: a half-filled row renders blank, never NaN. */
function fin(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function lambdaOf(s: EndoSample): number | null {
  const l = fin(s.lambda)
  return l !== null && l > 0 ? l : null
}

/** Least sensitive first: `needs` is the first cartridge a prep is valid on. */
function leastSensitiveFirst(ctx: EndoCtx): number[] {
  return ctx.allowedLambdas
    .filter(l => Number.isFinite(l) && l > 0)
    .sort((a, b) => b - a)
}

/* ---------------- form and water ---------------- */

/** Spec 4.2's one shared rule: BW- id, or the sample type or identity says so. */
export function isBacWaterSample(
  s: Pick<EndoSample, 'sampleId' | 'identity' | 'sampleType'>
): boolean {
  return isBacWater(s.sampleId, s.sampleType, s.identity)
}

/** A form set on the row wins; without one, bac water reads as bac. */
export function formOf(s: EndoSample): EndoForm {
  if (s.form === 'powder' || s.form === 'liquid' || s.form === 'bac')
    return s.form
  return isBacWaterSample(s) ? 'bac' : 'powder'
}

/**
 * The water in the vial: the row's own volume when > 0, else the method's
 * reconstitution water (2 mL). A liquid vial uses the customer's water as
 * typed and has none until it is typed. null for bac water.
 */
export function waterOf(s: EndoSample, ctx: EndoCtx): number | null {
  const form = formOf(s)
  if (form === 'bac') return null
  const own = fin(s.waterMl)
  if (own !== null && own > 0) return own
  return form === 'liquid' ? null : ctx.params.reconWaterMl
}

/* ---------------- limits ---------------- */

/** 350 / declared mg; null for bac water or without a (positive) weight. */
export function limitPerMg(s: EndoSample): number | null {
  if (formOf(s) === 'bac') return null
  const w = fin(s.weightMg)
  return w === null || w <= 0 ? null : LIMIT_EU_PER_VIAL / w
}

/** 350, flat, whatever the mass; null for bac water. */
export function limitPerVial(s: EndoSample): number | null {
  return formOf(s) === 'bac' ? null : LIMIT_EU_PER_VIAL
}

/**
 * Minimum valid concentration on the cartridge, lambda / (350 / mg), rounded
 * to 9 dp so 0.05 x 140 / 350 is exactly 0.02.
 */
export function mvcFor(lambda: number | null, s: EndoSample): number | null {
  if (lambda === null || !(lambda > 0)) return null
  const lpm = limitPerMg(s)
  return lpm === null ? null : r9(lambda / lpm)
}

/* ---------------- the bench steps ---------------- */

function totalOf(s: EndoSample, ctx: EndoCtx): number {
  const own = fin(s.totalDilution)
  return own !== null && own > 0 ? own : ctx.params.stdTotalDilution
}

/** The row's desired total: its own when > 0, else the method's. Bac: null. */
export function targetDilutionOf(s: EndoSample, ctx: EndoCtx): number | null {
  return formOf(s) === 'bac' ? null : totalOf(s, ctx)
}

/** (sample + diluent) / sample; null without a sample volume or diluent. */
export function stepFactor(st: {
  sampleUl: number | null
  diluentUl: number | null
}): number | null {
  const { sampleUl, diluentUl } = st
  return sampleUl !== null &&
    sampleUl > 0 &&
    diluentUl !== null &&
    Number.isFinite(diluentUl) &&
    diluentUl >= 0
    ? (sampleUl + diluentUl) / sampleUl
    : null
}

/** A standard step as volumes at the method's total: 20 + 180, 20 + 230, 125 + 125. */
export function stdStep(
  st: EndoStepDef,
  params: EndoRunParams
): { sampleUl: number; diluentUl: number; ratio: number } {
  const r = st.derived
    ? params.stdTotalDilution / (STEP1_RATIO * STEP3_RATIO)
    : (st.ratio ?? 1)
  return { sampleUl: st.sampleUl, diluentUl: st.sampleUl * (r - 1), ratio: r }
}

export interface EndoStepPlan {
  index: 0 | 1 | 2
  sampleUl: number | null
  ratio: number | null
  diluentUl: number | null
  totalUl: number | null
  running: number | null
  own: boolean
  fits: boolean
  diluent: string
}

/**
 * The row's three steps with its own values applied and step 2's ratio derived
 * from the total. A ratio below 1:1 gives no diluent (no such step); `running`
 * is the dilution so far, null for a step that cannot be made. [] for bac
 * water, whose prep is one straight 20x (calcEndoPrep in endo-prep.ts).
 */
export function stepsOf(s: EndoSample, ctx: EndoCtx): EndoStepPlan[] {
  if (formOf(s) === 'bac') return []
  const own = s.steps ?? [null, null, null]
  const target = totalOf(s, ctx)
  const typedR1 = fin(own[0]?.ratio)
  const r1 = typedR1 ?? STEP1_RATIO
  const out: EndoStepPlan[] = []
  let running = 1
  DILUTION_STEPS.forEach((def, i) => {
    const sampleUl = fin(own[i]?.sampleUl) ?? def.sampleUl
    const ratio = def.byRatio
      ? r1
      : def.derived
        ? r6(target / (r1 * STEP3_RATIO))
        : STEP3_RATIO
    const diluentUl = ratio >= 1 ? r6(sampleUl * (ratio - 1)) : null
    const totalUl =
      diluentUl !== null && Number.isFinite(diluentUl)
        ? sampleUl + diluentUl
        : null
    const factor = stepFactor({ sampleUl, diluentUl })
    if (factor !== null) running = r6(running * factor)
    out.push({
      index: i as 0 | 1 | 2,
      sampleUl,
      ratio,
      diluentUl,
      totalUl,
      running: factor === null ? null : running,
      own:
        sampleUl !== def.sampleUl ||
        (!!def.byRatio && typedR1 !== null && typedR1 !== STEP1_RATIO),
      fits: totalUl !== null && totalUl <= TUBE_UL,
      diluent: def.diluent,
    })
  })
  return out
}

/**
 * The factor from the vial solution to the cartridge: the product of the
 * steps, equal to the desired total whenever every step can be made. null for
 * bac water, or when a step has no sample volume or a ratio below 1:1.
 */
export function vialDilutionOf(s: EndoSample, ctx: EndoCtx): number | null {
  if (formOf(s) === 'bac') return null
  let f = 1
  for (const st of stepsOf(s, ctx)) {
    const k = stepFactor(st)
    if (k === null) return null
    f *= k
  }
  return r6(f)
}

/**
 * target: the desired total; total: what the steps make (null when they
 * cannot); fits: every step fits its tube; standard: the method's total and
 * no step set by hand. Bac water: no steps, its 20x as target and total.
 */
export function dilutionPlan(
  s: EndoSample,
  ctx: EndoCtx
): {
  steps: EndoStepPlan[]
  target: number
  total: number | null
  fits: boolean
  standard: boolean
} {
  if (formOf(s) === 'bac')
    return {
      steps: [],
      target: BW_DILUTION,
      total: BW_DILUTION,
      fits: true,
      standard: true,
    }
  const steps = stepsOf(s, ctx)
  const target = totalOf(s, ctx)
  return {
    steps,
    target,
    total: vialDilutionOf(s, ctx),
    fits: steps.every(st => st.fits),
    standard:
      target === ctx.params.stdTotalDilution && steps.every(st => !st.own),
  }
}

/* ---------------- the cartridge check ---------------- */

export interface EndoCheck {
  lambda: number | null
  water: number | null
  dilution: number | null
  loaded: number | null
  mvd: number | null
  mvc: number | null
  valid: boolean | null
  needs: number | null
  floorShown: number | null
  floorVial: number | null
  failAt: number | null
  lod: number | null
  loqVial: number | null
  loqMl: number | null
}

/**
 * loaded mg / water / N on the cartridge; mvd (350 / water) / lambda; mvc;
 * valid loaded >= mvc; needs the least sensitive allowed cartridge it is valid
 * on; floorShown lambda (the MCS factor is 1, so the reading is per mL of the
 * step 3 tube); floorVial and loqVial lambda x N x water; failAt the displayed
 * reading that equals 350 per vial; lod lambda. Bac water: its 20x, floor and
 * loqMl lambda x 20 (EU/mL of the water), failAt 0.25, valid when that floor
 * is under 0.25.
 */
export function prep2Check(s: EndoSample, ctx: EndoCtx): EndoCheck {
  const lambda = lambdaOf(s)
  const bac = formOf(s) === 'bac'
  const none: EndoCheck = {
    lambda,
    water: null,
    dilution: bac ? BW_DILUTION : null,
    loaded: null,
    mvd: null,
    mvc: null,
    valid: null,
    needs: null,
    floorShown: null,
    floorVial: null,
    failAt: null,
    lod: null,
    loqVial: null,
    loqMl: null,
  }
  if (bac) {
    const floorOn = (l: number): number => r6(l * BW_DILUTION)
    const needs =
      leastSensitiveFirst(ctx).find(l => floorOn(l) <= BW_LIMIT_EU_PER_ML) ??
      null
    if (lambda === null) return { ...none, needs, failAt: BW_LIMIT_EU_PER_ML }
    return {
      ...none,
      needs,
      failAt: BW_LIMIT_EU_PER_ML,
      valid: floorOn(lambda) <= BW_LIMIT_EU_PER_ML,
      floorShown: floorOn(lambda),
      lod: lambda,
      loqMl: floorOn(lambda),
    }
  }
  const n = vialDilutionOf(s, ctx)
  const ml = waterOf(s, ctx)
  if (n === null) return { ...none, water: ml } // the steps cannot be made as typed
  if (ml === null) return { ...none, dilution: n } // a liquid with no volume yet
  const w = fin(s.weightMg)
  const loaded = w === null ? null : r9(w / ml / n)
  const judgeable = loaded !== null && limitPerMg(s) !== null
  const validOn = (l: number): boolean => {
    const m = mvcFor(l, s)
    return m !== null && loaded !== null && loaded >= m
  }
  const needs = judgeable
    ? (leastSensitiveFirst(ctx).find(validOn) ?? null)
    : null
  const out: EndoCheck = {
    ...none,
    water: ml,
    dilution: n,
    loaded,
    needs,
    failAt: r6(LIMIT_EU_PER_VIAL / (ml * n)),
  }
  if (lambda === null) return out
  return {
    ...out,
    mvd: r6(LIMIT_EU_PER_VIAL / ml / lambda),
    mvc: mvcFor(lambda, s),
    valid: judgeable ? validOn(lambda) : null,
    floorShown: lambda,
    floorVial: r6(lambda * n * ml),
    lod: lambda,
    loqVial: r6(lambda * n * ml),
  }
}

/* ---------------- results ---------------- */

/**
 * The reading as the instrument shows it: "0.8", "0", "<0.05" ("< 0.05" and
 * padding are fine). null for blank or anything else, including "<0", which
 * says nothing (spec 3.7). The "<" is carried through every derived value.
 */
export function parseReading(
  text: string | null
): { lt: boolean; value: number } | null {
  const m = /^(<)?(\d*\.?\d+)$/.exec((text ?? '').replace(/\s+/g, ''))
  if (!m) return null
  const lt = m[1] === '<'
  const value = Number(m[2])
  return lt && value <= 0 ? null : { lt, value }
}

function judgeResult(lt: boolean, euPerVial: number): EndoVerdict {
  if (euPerVial <= LIMIT_EU_PER_VIAL) return 'pass'
  return lt ? 'inconclusive' : 'fail'
}

/** Bac water: the reading itself against 0.25 EU/mL. */
export function judgeWater(lt: boolean, euPerMl: number): EndoVerdict {
  if (euPerMl <= BW_LIMIT_EU_PER_ML) return 'pass'
  return lt ? 'inconclusive' : 'fail'
}

export interface EndoResult {
  lt: boolean | null
  value: number | null
  euPerMlVial: number | null
  euPerVial: number | null
  euPerMg: number | null
  limitPerVial: number | null
  limitPerMl: number | null
  verdict: EndoVerdict
  expectedFloor: number | null
  floorMismatch: boolean
}

function prep2ResultRaw(s: EndoSample, ctx: EndoCtx): EndoResult {
  const p = parseReading(s.reading)
  const bac = formOf(s) === 'bac'
  const none: EndoResult = {
    lt: false,
    value: null,
    euPerMlVial: null,
    euPerVial: null,
    euPerMg: null,
    limitPerVial: limitPerVial(s),
    limitPerMl: bac ? BW_LIMIT_EU_PER_ML : null,
    verdict: null,
    expectedFloor: null,
    floorMismatch: false,
  }
  if (!p) return none
  const k = prep2Check(s, ctx)
  const out: EndoResult = {
    ...none,
    lt: p.lt,
    value: p.value,
    expectedFloor: k.floorShown,
  }
  if (p.lt && k.floorShown !== null && Math.abs(p.value - k.floorShown) > 1e-9)
    out.floorMismatch = true
  if (bac) {
    // the reading is EU/mL of the bac water (the instrument applies the 20x)
    out.verdict = judgeWater(p.lt, p.value)
    return out
  }
  if (k.dilution === null || k.water === null) return out // nothing to scale by
  const euPerMlVial = r9(p.value * k.dilution)
  const euPerVial = r9(euPerMlVial * k.water)
  const w = fin(s.weightMg)
  return {
    ...out,
    euPerMlVial,
    euPerVial,
    euPerMg: w ? euPerVial / w : null,
    verdict: judgeResult(p.lt, euPerVial),
  }
}

/**
 * The reading scaled to the vial: x the row's total = EU/mL of the vial, x the
 * water = EU per vial, / mg = EU/mg; the verdict on EU per vial. A reading
 * whose reader test failed spike recovery or CV is 'invalid' whatever its
 * number (USP <85>); the numbers still show.
 */
export function prep2Result(s: EndoSample, ctx: EndoCtx): EndoResult {
  const out = prep2ResultRaw(s, ctx)
  if (s.reader && !s.reader.valid && out.value !== null) out.verdict = 'invalid'
  return out
}

/** "<2.5" style: the "<" kept, 3 decimals. */
export function fmtEu(lt: boolean, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return ''
  return (lt ? '<' : '') + fmt(v)
}

/** Concentrations on the cartridge: two significant figures below 0.01. */
export function fmtConc(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return ''
  return v >= 0.01 ? fmt(v) : String(Number(v.toPrecision(2)))
}

/**
 * The value for Accu-Mk1 (Dennis 2026-10-09): EU per vial for peptides, the
 * reading itself in EU/mL for bac water, the "<" kept. null until there is a
 * number, and for an invalid test (rerun, never reported).
 */
export function mk1Value(
  s: EndoSample,
  ctx: EndoCtx
): { value: string; unit: 'EU/vial' | 'EU/mL'; verdict: EndoVerdict } | null {
  const rs = prep2Result(s, ctx)
  if (rs.verdict === 'invalid') return null
  const lt = rs.lt === true
  if (formOf(s) === 'bac')
    return rs.value === null
      ? null
      : { value: fmtEu(lt, rs.value), unit: 'EU/mL', verdict: rs.verdict }
  return rs.euPerVial === null
    ? null
    : { value: fmtEu(lt, rs.euPerVial), unit: 'EU/vial', verdict: rs.verdict }
}

/* ---------------- order ---------------- */

/**
 * Box 2 and the 2 mL bench sheet order (Dennis 2026-10-09): grouped by total,
 * ascending; ties keep the order given (bench order); a total the steps
 * cannot make after the numbers; bac water last.
 */
export function orderByTotal<T>(
  rows: T[],
  sampleOf: (r: T) => EndoSample,
  ctx: EndoCtx
): T[] {
  return rows
    .map((r, i) => {
      const s = sampleOf(r)
      const total = formOf(s) === 'bac' ? null : vialDilutionOf(s, ctx)
      const group = formOf(s) === 'bac' ? 2 : total === null ? 1 : 0
      return { r, i, group, total: total ?? 0 }
    })
    .sort((a, b) => a.group - b.group || a.total - b.total || a.i - b.i)
    .map(x => x.r)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/__tests__/endo-prep-2ml.test.ts src/lib/__tests__/endo-prep.test.ts
npx tsc --noEmit
npx eslint --max-warnings 0 src/lib/endo-prep-2ml.ts src/lib/__tests__/endo-prep-2ml.test.ts
npx prettier --check src/lib/endo-prep-2ml.ts src/lib/__tests__/endo-prep-2ml.test.ts
```
Expected: `endo-prep-2ml.test.ts` 20 passed, `endo-prep.test.ts` unchanged and passing; tsc, eslint and prettier clean. (Verified while drafting with the repo's tsconfig flags, eslint config, prettier config, `vitest.config.ts` and `src/test/setup.ts`: 20 / 20; mutation checks on the least-sensitive-first sort, the method's water, the group order and the Invalid rule each fail a test.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/endo-prep-2ml.ts src/lib/__tests__/endo-prep-2ml.test.ts
git commit -m "feat(endo-v2): port the 2 mL endotoxin maths (endo-prep-2ml)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/endo-prep-2ml.ts src/lib/__tests__/endo-prep-2ml.test.ts
```

### Task 9: Reader parsing port (`src/lib/endo-reader.ts`)

**Files:**
- Create: `src/lib/endo-reader.ts`
- Test: `src/lib/__tests__/endo-reader.test.ts`

**Interfaces:**
- Consumes from `src/lib/endo-prep-2ml.ts` (Task 8): the types `EndoReaderRecord`, `EndoRunParams`; the test also uses `ENDO_RUN_PARAM_DEFAULTS`, `BW_LAMBDA`, `prep2Result`, `mk1Value`, `EndoCtx`, `EndoSample`.
- Produces, exactly as CONTRACT.md fixes them: `ReaderTest`, `parseEndoScan(text)` (throws `Error("This is not a reader export: no test rows (channel 1-4, 79 columns) were found.")` on anything else), `readerValidity(t, params)`, `baseSampleId(id)`, `matchReaderTests(tests, rows)`, `readerCartridgeLambda(range)`, `splitIdentity(raw)`, `toReaderRecord(t, params, fileName)`.
- Produces, additive: `matchReaderTests(...)` also returns `superseded: ReaderTest[]` (the earlier tests of a row tested twice), so the Task 16 preview can list every test.
- `readerValidity` judges against the method's `EndoRunParams` (spec 4.4), never the limits printed in the file; `toReaderRecord` keeps the file's `rec_min`, `rec_max`, `cv_limit` beside the method-based `valid` and `why`, and the `why` text names the method's limits. `imported_at` and `imported_by_user_id` (spec 8.4) are added by the server (Task 7).

Dennis's tests ported here:

| Dennis line | `describe` / `it` here | Adapted or dropped, and why |
| --- | --- | --- |
| 992 | `calc.test.js:992 reader export ...` / `matches Dennis` | his `valid` / `why` asserted through `readerValidity(t, ENDO_RUN_PARAM_DEFAULTS)` (the defaults are his limits); `slot` asserted as 1 (deviation 8) |
| 1016 | `calc.test.js:1016 a failed spike or CV makes the verdict invalid ...` | records are full `EndoReaderRecord`s; `invalidWhy` and `readerDiffers` dropped (deviations 6, 7); `fromStored` dropped; plus the record parsed from his export drives the verdict end to end |
| 1035 | `calc.test.js:1035 matched to rows by Sample ID ...` | his `[index, how]` pairs become the `matched` / `ambiguous` / `unmatched` lists with item ids; his `superseded` flags become the `superseded` list; `readerCartridge("10 - 0.1")` is 0.1, not null (deviation 10) |
| 952 | `calc.test.js:952 inbox identity ...` | ships only if Task 18's identity trace finds Mk1 adds the " - <assay>" suffix; kept in the file because it is cheap; his `parseIntake` / `pickRule` half dropped (not Mk1) |
| (new) | 992 / `judges against the method's limits ...` | spec 4.4: method limits, not the file's; record keeps both |
| (new) | 992 / `RF1: BOM, CRLF, trailing blank lines and padded cells ...`, `RF1: anything that is not this export ...` | RF1 |
| (new) | 1035 / `never pairs two different vials ...`, `reads the lower bound ...` | deviations 9, 10 |

All test data is Dennis's made-up export (`esRow` / `esTest`, calc.test.js:971-990, same IDs and values), never a real reader file.

- [ ] **Step 1: Write the failing test**

`src/lib/__tests__/endo-reader.test.ts`:

```ts
// Dennis's reader vectors, ported from tools-dennis/tools/endotoxin-log/calc.test.js
// at 5ef2a62. The export below is HIS made-up one (calc.test.js:971-990, same
// IDs and values); real reader files never go in a test. Validity is checked
// against the method's run parameters (spec 4.4); his storage lines (fromStored)
// and his intake file are not Mk1's.
import { describe, it, expect } from 'vitest'
import {
  BW_LAMBDA,
  ENDO_RUN_PARAM_DEFAULTS,
  mk1Value,
  prep2Result,
  type EndoCtx,
  type EndoReaderRecord,
  type EndoSample,
} from '@/lib/endo-prep-2ml'
import {
  baseSampleId,
  matchReaderTests,
  parseEndoScan,
  readerCartridgeLambda,
  readerValidity,
  splitIdentity,
  toReaderRecord,
  type ReaderTest,
} from '@/lib/endo-reader'

// A reader export in the same shape as EndoScan-V's, with made-up IDs and values.
interface EsRow {
  ch: number
  oq?: string
  onset: number
  kind: 'SPL1' | 'SPK1'
  sid: string
  identity: string
  rec?: number
  cv: string
  spikeEu?: string
  tid: string
}
function esRow(o: EsRow): string {
  const r = new Array<string>(79).fill('')
  const set = (i: number, v: string | number | undefined) => {
    r[i] = v === undefined ? '' : String(v)
  }
  set(0, o.ch)
  set(1, 0)
  set(2, o.oq)
  set(3, o.onset)
  set(10, o.kind)
  set(11, o.identity)
  set(12, 'Peptide')
  set(13, o.sid)
  set(14, 'mL')
  set(16, o.kind === 'SPK1' ? 0.8 : 1)
  set(18, o.rec)
  set(22, o.cv)
  set(24, 25)
  if (o.kind === 'SPK1') {
    const rec = o.rec ?? 0
    set(6, 50)
    set(7, 200)
    set(27, o.spikeEu)
    set(29, rec >= 50 && rec <= 200 ? 1 : 0)
  } else {
    set(26, '<')
    set(27, '0.05')
    set(28, 1)
  }
  set(31, '5-0.05')
  set(39, '6.2.2.PTS150 V11.1.2')
  set(44, '1111111111')
  set(66, 'Test Analyst')
  set(67, '2026-10-09T15:03:15-07:00')
  set(70, 'MCS 0000001')
  set(71, '37.0')
  set(72, '36.9')
  set(73, o.tid)
  set(75, '9999 - MCS 0000001/1')
  return r.join(',')
}
function esTest(
  tid: string,
  sid: string,
  identity: string,
  rec: number,
  spikeCv: string
): string {
  const spikeEu = (rec * 0.008).toFixed(3)
  return [
    esRow({
      ch: 1,
      oq: '>',
      onset: 759,
      kind: 'SPL1',
      sid,
      identity,
      cv: '0.0',
      tid,
    }),
    esRow({
      ch: 2,
      onset: 300,
      kind: 'SPK1',
      sid,
      identity,
      rec,
      cv: spikeCv,
      spikeEu,
      tid,
    }),
    esRow({
      ch: 3,
      oq: '>',
      onset: 759,
      kind: 'SPL1',
      sid,
      identity,
      cv: '0.0',
      tid,
    }),
    esRow({
      ch: 4,
      onset: 310,
      kind: 'SPK1',
      sid,
      identity,
      rec,
      cv: spikeCv,
      spikeEu,
      tid,
    }),
    '',
    '_Cartridge,5 - 0.05,1111111111,2028-06-01T00:00:00-07:00,222222222222',
    '',
  ].join('\r\n')
}
const EXPORT =
  esTest('CRL-T-001', 'P-9001', 'Examplerelin', 87, '3.7') +
  '\r\n' +
  esTest('CRL-T-002', 'P-9002', 'Testpeptide', 44, '1.7') +
  '\r\n' +
  esTest('CRL-T-003', 'PB-9003', 'Blend A + Blend B', 75, '26.0')

const params = ENDO_RUN_PARAM_DEFAULTS
const three = (tests: ReaderTest[]) =>
  tests as [ReaderTest, ReaderTest, ReaderTest]

describe('calc.test.js:992 reader export: one record per test, spike recovery and CV checked', () => {
  it('matches Dennis', () => {
    const { tests, cartridges } = parseEndoScan(EXPORT)
    expect(tests).toHaveLength(3)
    expect(cartridges).toEqual([
      {
        range: '5 - 0.05',
        lot: '1111111111',
        expiry: '2028-06-01',
        code: '222222222222',
      },
    ]) // once, though it repeats
    const [a, b, c] = three(tests)
    expect([a.sampleId, a.identity, a.testId]).toEqual([
      'P-9001',
      'Examplerelin',
      'CRL-T-001',
    ])
    expect([a.result, a.lt, a.value]).toEqual(['<0.05', true, 0.05])
    expect([a.recovery, a.spikeCv, a.sampleCv, a.cvLimit]).toEqual([
      87, 3.7, 0, 25,
    ])
    expect(readerValidity(a, params)).toEqual({ valid: true, why: [] })
    expect(a.readerPass).toBe(true)
    expect([a.cartLot, a.cartExpiry]).toEqual(['1111111111', '2028-06-01'])
    expect([a.reader, a.operator]).toEqual(['MCS 0000001', 'Test Analyst'])
    expect([a.tempStart, a.tempEnd]).toEqual([37, 36.9])
    expect(a.slot).toBe(1) // his slot cell "9999 - MCS 0000001/1"
    // 44 % recovery: invalid, and the reader's own flag agrees
    expect(readerValidity(b, params)).toEqual({
      valid: false,
      why: ['spike recovery 44 % outside 50-200 %'],
    })
    expect(b.readerPass).toBe(false)
    // a spike CV over 25 %: invalid on the numbers though the recovery is fine
    expect(readerValidity(c, params)).toEqual({
      valid: false,
      why: ['spike CV 26 % over 25 %'],
    })
    // not a reader export
    expect(() => parseEndoScan('Received,Sample ID\n2026-10-09,P-1\n')).toThrow(
      /not a reader export/
    )
  })

  it("judges against the method's limits, and the record keeps the file's beside them", () => {
    const [a, b, c] = three(parseEndoScan(EXPORT).tests)
    expect(readerValidity(a, { ...params, spikeRecoveryMinPct: 90 })).toEqual({
      valid: false,
      why: ['spike recovery 87 % outside 90-200 %'],
    })
    expect(readerValidity(c, { ...params, cvLimitPct: 30 })).toEqual({
      valid: true,
      why: [],
    })
    const rec = toReaderRecord(
      a,
      { ...params, spikeRecoveryMinPct: 90 },
      'EndoScanV-Export-test.csv'
    )
    expect([rec.rec_min, rec.rec_max, rec.cv_limit]).toEqual([50, 200, 25])
    expect([rec.valid, rec.why]).toEqual([
      false,
      ['spike recovery 87 % outside 90-200 %'],
    ])
    expect(toReaderRecord(b, params, 'EndoScanV-Export-test.csv')).toEqual({
      test_id: 'CRL-T-002',
      reader: 'MCS 0000001',
      slot: 1,
      operator: 'Test Analyst',
      tested_at: '2026-10-09T15:03:15-07:00',
      temp_start: 37,
      temp_end: 36.9,
      software: '6.2.2.PTS150 V11.1.2',
      cartridge_lot: '1111111111',
      cartridge_expiry: '2028-06-01',
      cartridge_range: '5-0.05',
      spike_level: 0.8,
      recovery: 44,
      rec_min: 50,
      rec_max: 200,
      sample_cv: 0,
      spike_cv: 1.7,
      cv_limit: 25,
      reader_pass: false,
      valid: false,
      why: ['spike recovery 44 % outside 50-200 %'],
      file_name: 'EndoScanV-Export-test.csv',
    } satisfies EndoReaderRecord)
  })

  it('RF1: BOM, CRLF, trailing blank lines and padded cells parse the same', () => {
    const lf = EXPORT.replace(/\r\n/g, '\n')
    const messy =
      '\uFEFF' +
      lf
        .split('\n')
        .map(line =>
          line
            .split(',')
            .map(c => `  ${c} `)
            .join(',')
        )
        .join('\r\n') +
      '\r\n\r\n   \r\n'
    const clean = parseEndoScan(lf)
    expect(clean.tests).toHaveLength(3)
    expect(parseEndoScan(messy)).toEqual(clean)
    expect(parseEndoScan(EXPORT)).toEqual(clean)
  })

  it('RF1: anything that is not this export throws a readable error', () => {
    for (const bad of [
      '',
      'Order,Sample ID,Peptide\n9001,P-0101,Examplerelin\n',
      '1,2,3\n4,5,6\n',
    ])
      expect(() => parseEndoScan(bad)).toThrow(
        'This is not a reader export: no test rows (channel 1-4, 79 columns) were found.'
      )
  })
})

const ctx: EndoCtx = { params, allowedLambdas: [0.05, 0.01, 0.005] }
function record(valid: boolean, why: string[]): EndoReaderRecord {
  return {
    test_id: 'CRL-T-001',
    reader: null,
    slot: null,
    operator: null,
    tested_at: null,
    temp_start: null,
    temp_end: null,
    software: null,
    cartridge_lot: null,
    cartridge_expiry: null,
    cartridge_range: null,
    spike_level: null,
    recovery: null,
    rec_min: null,
    rec_max: null,
    sample_cv: null,
    spike_cv: null,
    cv_limit: null,
    reader_pass: null,
    valid,
    why,
    file_name: 'test.csv',
  }
}

describe('calc.test.js:1016 a failed spike or CV makes the verdict invalid, and nothing goes to Mk1', () => {
  it('matches Dennis', () => {
    const pep = (o: Partial<EndoSample> = {}): EndoSample => ({
      sampleId: 'P-1',
      identity: 'Examplerelin',
      sampleType: null,
      weightMg: 10,
      form: null,
      waterMl: null,
      totalDilution: null,
      steps: null,
      lambda: 0.05,
      reading: '<0.05',
      reader: null,
      ...o,
    })
    const ok = record(true, [])
    const bad = record(false, ['spike recovery 44 % outside 50-200 %'])
    expect(prep2Result(pep({ reader: ok }), ctx).verdict).toBe('pass')
    const r = prep2Result(pep({ reader: bad }), ctx)
    expect(r.verdict).toBe('invalid') // his invalidWhy is the record's why, shown by the UI
    expect(r.euPerVial).toBe(25) // the numbers still show; they are not a result
    expect(mk1Value(pep({ reader: bad }), ctx)).toBeNull()
    expect(mk1Value(pep({ reader: ok }), ctx)?.value).toBe('<25')
    // bac water is gated the same way
    expect(
      prep2Result(
        pep({
          sampleId: 'BW-1',
          identity: 'Bac water',
          weightMg: null,
          lambda: BW_LAMBDA,
          reading: '<0.2',
          reader: bad,
        }),
        ctx
      ).verdict
    ).toBe('invalid')
    // and the record parsed from his export drives it end to end
    const [, b] = three(parseEndoScan(EXPORT).tests)
    const parsed = toReaderRecord(b, params, 'EndoScanV-Export-test.csv')
    expect(prep2Result(pep({ reader: parsed }), ctx).verdict).toBe('invalid')
    // readerDiffers: the record carries no reading (contract), not ported
  })
})

function rt(
  sampleId: string,
  testedAt = '2026-10-09T15:00:00-07:00'
): ReaderTest {
  return {
    testId: `T-${sampleId}-${testedAt}`,
    sampleId,
    identity: '',
    sampleType: '',
    result: '<0.05',
    lt: true,
    value: 0.05,
    sampleCv: null,
    spikeCv: null,
    cvLimit: null,
    recovery: null,
    recMin: null,
    recMax: null,
    spikeLevel: null,
    readerPass: null,
    operator: null,
    testedAt,
    reader: null,
    slot: null,
    tempStart: null,
    tempEnd: null,
    cartLot: null,
    cartExpiry: null,
    cartRange: null,
    software: null,
  }
}

describe('calc.test.js:1035 matched to rows by Sample ID, the parent only when unambiguous', () => {
  it('matches Dennis', () => {
    expect(readerCartridgeLambda('5 - 0.05')).toBe(0.05)
    expect(readerCartridgeLambda('1-0.01')).toBe(0.01)
    expect(readerCartridgeLambda('0.5 - 0.005')).toBe(0.005)
    // his null for "10 - 0.1" was "not one of my three cartridges"; that check
    // is the catalog's now (spec 8.3), so the sensitivity comes back
    expect(readerCartridgeLambda('10 - 0.1')).toBe(0.1)
    expect(baseSampleId('p-5309-s02')).toBe('P-5309')
    expect(baseSampleId('PB-0544')).toBe('PB-0544')
    const rows = [
      { itemId: 1, sampleId: 'P-5299-S02' },
      { itemId: 2, sampleId: 'P-5311' },
      { itemId: 3, sampleId: 'P-7000-S01' },
      { itemId: 4, sampleId: 'P-7000-S02' },
      { itemId: 5, sampleId: '' },
    ]
    const m = matchReaderTests(
      [
        rt('P-5299'),
        rt('P-5311'),
        rt('P-7000'),
        rt('P-9999'),
        rt(''),
        rt('P-7000-S02'),
      ],
      rows
    )
    expect(m.matched.map(x => [x.test.sampleId, x.itemId, x.via])).toEqual([
      ['P-5299', 1, 'parent'],
      ['P-5311', 2, 'exact'],
      ['P-7000-S02', 4, 'exact'],
    ])
    expect(m.ambiguous.map(t => t.sampleId)).toEqual(['P-7000'])
    expect(m.unmatched.map(t => t.sampleId)).toEqual(['P-9999', ''])
    // tested twice: the later test wins, the earlier is superseded
    const early = rt('P-5311', '2026-10-09T13:48:00-07:00')
    const late = rt('P-5311', '2026-10-09T15:03:00-07:00')
    const twice = matchReaderTests([early, late], rows)
    expect(twice.matched.map(x => x.test)).toEqual([late])
    expect(twice.superseded).toEqual([early])
    expect(matchReaderTests([late, early], rows).matched[0]?.test).toBe(late)
  })

  it('never pairs two different vials, never sends one row two tests', () => {
    // the reader's S02 is not the sheet's S01
    const m = matchReaderTests(
      [rt('P-7000-S02')],
      [{ itemId: 3, sampleId: 'P-7000-S01' }]
    )
    expect(m.matched).toEqual([])
    expect(m.unmatched.map(t => t.sampleId)).toEqual(['P-7000-S02'])
    // a vial ID on the reader still finds a bare parent row
    expect(
      matchReaderTests([rt('P-5299-S02')], [{ itemId: 9, sampleId: 'P-5299' }])
        .matched[0]
    ).toMatchObject({ itemId: 9, via: 'parent' })
    // the same time twice: the later one in the file, once
    const first = { ...rt('P-5311'), testId: 'A' }
    const second = { ...rt('P-5311'), testId: 'B' }
    const tie = matchReaderTests(
      [first, second],
      [{ itemId: 2, sampleId: 'P-5311' }]
    )
    expect(tie.matched.map(x => x.test.testId)).toEqual(['B'])
    expect(tie.superseded.map(t => t.testId)).toEqual(['A'])
  })

  it('reads the lower bound in either order, and nothing from nothing', () => {
    expect(readerCartridgeLambda('0.05 - 5')).toBe(0.05)
    expect(readerCartridgeLambda('')).toBeNull()
    expect(readerCartridgeLambda(null)).toBeNull()
    expect(readerCartridgeLambda('n/a')).toBeNull()
  })
})

// Ships only if Task 18's identity trace finds Mk1 adds the " - <assay>" suffix
// to identities (spec 7, 11); kept here because it is cheap.
describe('calc.test.js:952 inbox identity: the test label comes off the product, nothing else does', () => {
  it('matches Dennis (his parseIntake and pickRule halves are not Mk1)', () => {
    expect(splitIdentity('Retatrutide - Identity (HPLC)')).toEqual({
      product: 'Retatrutide',
      label: 'Identity (HPLC)',
    })
    expect(splitIdentity('MOTS-c - Identity (HPLC)')).toEqual({
      product: 'MOTS-c',
      label: 'Identity (HPLC)',
    })
    expect(splitIdentity('Tirzepatide - Endotoxin (LAL)').product).toBe(
      'Tirzepatide'
    )
    for (const keep of [
      'CJC-1295 no DAC',
      'BPC-157, TB500 (Thymosin Beta 4)',
      'GHK-Cu',
      'Bacteriostatic Water',
      'NAD+',
      '',
    ])
      expect(splitIdentity(keep)).toEqual({ product: keep, label: null })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/endo-reader.test.ts`
Expected: FAIL. The suite cannot load: the import `@/lib/endo-reader` does not resolve; 0 tests run.

- [ ] **Step 3: Implement**

`src/lib/endo-reader.ts`. Two characters must stay escapes in the source, not raw characters: the byte-order mark in `parseEndoScan` (`/^\uFEFF/`) and the en dash in `splitIdentity` (`[-\u2013]`); the same BOM escape appears in the RF1 test. Some editors and tools decode `\uXXXX` when writing a file; after writing, `grep -n 'uFEFF\|u2013' src/lib/endo-reader.ts src/lib/__tests__/endo-reader.test.ts` must show three lines, and eslint's `no-irregular-whitespace` fails on a raw BOM.

```ts
/**
 * The endotoxin reader's export (EndoScan-V), parsed in the browser.
 *
 * Ported from tools-dennis/tools/endotoxin-log/calc.js at 5ef2a62
 * (parseEndoScan, baseSampleId, matchReaderTests, readerCartridge,
 * splitIdentity). Validity is judged against the worksheet method's run
 * parameters (spec 4.4), not the limits printed in the file; the record keeps
 * the file's limits beside that verdict. The cartridge is a sensitivity
 * matched against the consumables catalog by the caller (spec 8.3).
 * The file is untrusted input: anything that is not this export throws a
 * readable Error.
 */
import type { EndoReaderRecord, EndoRunParams } from '@/lib/endo-prep-2ml'

export interface ReaderTest {
  testId: string
  sampleId: string
  identity: string
  sampleType: string
  result: string
  lt: boolean
  value: number | null
  sampleCv: number | null
  spikeCv: number | null
  cvLimit: number | null
  recovery: number | null
  recMin: number | null
  recMax: number | null
  spikeLevel: number | null
  readerPass: boolean | null
  operator: string | null
  testedAt: string | null
  reader: string | null
  slot: number | null
  tempStart: number | null
  tempEnd: number | null
  cartLot: string | null
  cartExpiry: string | null
  cartRange: string | null
  software: string | null
}

/**
 * The columns (0-based) the sheet reads, decoded by Dennis from his export of
 * 2026-10-09 (PTS150 V11.1.x): four rows per test, channels 1 and 3 the sample
 * (SPL1), 2 and 4 the spike (SPK1), then a "_Cartridge" line.
 */
const ES = {
  channel: 0,
  recMin: 6, // spike recovery acceptance, % (on the spike rows)
  recMax: 7,
  kind: 10, // "SPL1" sample, "SPK1" spike
  identity: 11,
  sampleType: 12,
  sampleId: 13,
  spikeLevel: 16, // EU/mL spiked, on the spike rows
  recovery: 18, // spike recovery, %, on the spike rows
  cv: 22, // CV of the two channels' onset times, %
  cvLimit: 24,
  resultQual: 26, // "<"
  result: 27, // EU/mL; the spike's reading on spike rows
  samplePass: 28, // the reader's own pass flags, 1 / 0
  spikePass: 29,
  cartRange: 31,
  software: 39,
  cartLot: 44,
  operator: 66,
  testedAt: 67,
  reader: 70, // the reader's serial
  tempStart: 71,
  tempEnd: 72,
  testId: 73,
  slot: 75,
} as const

/** Comma CSV: quotes and doubled quotes, CR tolerated, cells trimmed, blank rows dropped. */
function splitCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    if (inQuote) {
      if (ch !== '"') cur += ch
      else if (text.charAt(i + 1) === '"') {
        cur += '"'
        i++
      } else inQuote = false
    } else if (ch === '"') inQuote = true
    else if (ch === ',') {
      row.push(cur)
      cur = ''
    } else if (ch === '\n') {
      row.push(cur)
      rows.push(row)
      row = []
      cur = ''
    } else if (ch !== '\r') cur += ch
  }
  row.push(cur)
  rows.push(row)
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''))
}

const cell = (r: string[], i: number): string => r[i] ?? ''
const text = (r: string[], i: number): string | null => cell(r, i) || null

function num(v: string): number | null {
  return v !== '' && Number.isFinite(Number(v)) ? Number(v) : null
}

/**
 * The slot is the number after the last "/" of its cell ("9999 - MCS
 * 0000001/1" is slot 1), or a bare number; else null.
 */
function slotOf(v: string): number | null {
  const m = /\/\s*(\d+)$/.exec(v) ?? /^(\d+)$/.exec(v)
  return m ? Number(m[1]) : null
}

export function parseEndoScan(input: string): {
  tests: ReaderTest[]
  cartridges: { range: string; lot: string; expiry: string; code: string }[]
} {
  const rows = splitCsv(input.replace(/^\uFEFF/, ''))
  // the "_Cartridge" line repeats after every test: one entry per lot
  const cartridges: {
    range: string
    lot: string
    expiry: string
    code: string
  }[] = []
  for (const r of rows) {
    if (cell(r, 0) !== '_Cartridge') continue
    const lot = cell(r, 2)
    if (!cartridges.some(c => c.lot === lot))
      cartridges.push({
        range: cell(r, 1),
        lot,
        expiry: cell(r, 3).slice(0, 10),
        code: cell(r, 4),
      })
  }
  const data = rows.filter(
    r => /^[1-4]$/.test(cell(r, ES.channel)) && r.length > ES.slot
  )
  if (!data.length)
    throw new Error(
      'This is not a reader export: no test rows (channel 1-4, 79 columns) were found.'
    )
  const byTest = new Map<string, string[][]>()
  for (const r of data) {
    const id = cell(r, ES.testId)
    const list = byTest.get(id)
    if (list) list.push(r)
    else byTest.set(id, [r])
  }
  const tests: ReaderTest[] = []
  for (const [testId, rs] of byTest) {
    const spl = rs.find(r => cell(r, ES.kind) === 'SPL1')
    const spk = rs.find(r => cell(r, ES.kind) === 'SPK1')
    if (!spl || !spk) continue
    const lt = cell(spl, ES.resultQual) === '<'
    const value = num(cell(spl, ES.result))
    const lot = cell(spl, ES.cartLot)
    const cart = cartridges.find(c => c.lot === lot)
    tests.push({
      testId,
      sampleId: cell(spl, ES.sampleId),
      identity: cell(spl, ES.identity),
      sampleType: cell(spl, ES.sampleType),
      result: value === null ? '' : (lt ? '<' : '') + cell(spl, ES.result),
      lt,
      value,
      sampleCv: num(cell(spl, ES.cv)),
      spikeCv: num(cell(spk, ES.cv)),
      cvLimit: num(cell(spl, ES.cvLimit)),
      recovery: num(cell(spk, ES.recovery)),
      recMin: num(cell(spk, ES.recMin)),
      recMax: num(cell(spk, ES.recMax)),
      spikeLevel: num(cell(spk, ES.spikeLevel)),
      readerPass:
        cell(spl, ES.samplePass) === '1' && cell(spk, ES.spikePass) === '1',
      operator: text(spl, ES.operator),
      testedAt: text(spl, ES.testedAt),
      reader: text(spl, ES.reader),
      slot: slotOf(cell(spl, ES.slot)),
      tempStart: num(cell(spl, ES.tempStart)),
      tempEnd: num(cell(spl, ES.tempEnd)),
      cartLot: lot || null,
      cartExpiry: cart?.expiry || null,
      cartRange: text(spl, ES.cartRange),
      software: text(spl, ES.software),
    })
  }
  return { tests, cartridges }
}

/**
 * Valid when the spike recovery is inside the METHOD's range and both CVs are
 * within the METHOD's limit (spec 4.4). The reader's own flags stay in
 * readerPass, so a disagreement shows.
 */
export function readerValidity(
  t: ReaderTest,
  params: EndoRunParams
): { valid: boolean; why: string[] } {
  const min = params.spikeRecoveryMinPct
  const max = params.spikeRecoveryMaxPct
  const cv = params.cvLimitPct
  const why: string[] = []
  if (t.recovery === null) why.push('no spike recovery')
  else if (t.recovery < min || t.recovery > max)
    why.push(`spike recovery ${t.recovery} % outside ${min}-${max} %`)
  if (t.sampleCv !== null && t.sampleCv > cv)
    why.push(`sample CV ${t.sampleCv} % over ${cv} %`)
  if (t.spikeCv !== null && t.spikeCv > cv)
    why.push(`spike CV ${t.spikeCv} % over ${cv} %`)
  return { valid: why.length === 0, why }
}

/** The record stored on the item (spec 8.4); the server adds imported_at and _by. */
export function toReaderRecord(
  t: ReaderTest,
  params: EndoRunParams,
  fileName: string
): EndoReaderRecord {
  const { valid, why } = readerValidity(t, params)
  return {
    test_id: t.testId,
    reader: t.reader,
    slot: t.slot,
    operator: t.operator,
    tested_at: t.testedAt,
    temp_start: t.tempStart,
    temp_end: t.tempEnd,
    software: t.software,
    cartridge_lot: t.cartLot,
    cartridge_expiry: t.cartExpiry,
    cartridge_range: t.cartRange,
    spike_level: t.spikeLevel,
    recovery: t.recovery,
    rec_min: t.recMin, // the file's limits, kept beside the method's verdict
    rec_max: t.recMax,
    sample_cv: t.sampleCv,
    spike_cv: t.spikeCv,
    cv_limit: t.cvLimit,
    reader_pass: t.readerPass,
    valid,
    why,
    file_name: fileName,
  }
}

/** The cartridge range ("5 - 0.05") as its sensitivity, the lower bound; else null. */
export function readerCartridgeLambda(range: string | null): number | null {
  const nums = (range ?? '').match(/\d+(?:\.\d+)?|\.\d+/g)
  if (!nums) return null
  const low = Math.min(...nums.map(Number))
  return low > 0 ? low : null
}

/** A sample ID without its vial suffix: "P-5309-S02" -> "P-5309". */
export function baseSampleId(id: string): string {
  return id
    .trim()
    .toUpperCase()
    .replace(/-[A-Z]\d{1,3}$/, '')
}

type Found =
  | { test: ReaderTest; via: 'exact' | 'parent'; itemId: number }
  | { test: ReaderTest; via: 'none' | 'ambiguous'; itemId: null }

function findRow(
  test: ReaderTest,
  rows: { itemId: number; sampleId: string }[]
): Found {
  const id = test.sampleId.trim().toUpperCase()
  if (!id) return { test, via: 'none', itemId: null }
  const sids = rows.map(r => ({ ...r, sid: r.sampleId.trim().toUpperCase() }))
  const exact = sids.filter(r => r.sid === id)
  if (exact.length > 1) return { test, via: 'ambiguous', itemId: null }
  if (exact[0]) return { test, via: 'exact', itemId: exact[0].itemId }
  const base = baseSampleId(id)
  // the parent ID, when one side is the bare parent: two different vials of
  // one parent are never paired
  const loose = sids.filter(
    r =>
      r.sid && baseSampleId(r.sid) === base && (r.sid === base || id === base)
  )
  if (loose.length > 1) return { test, via: 'ambiguous', itemId: null }
  if (loose[0]) return { test, via: 'parent', itemId: loose[0].itemId }
  return { test, via: 'none', itemId: null }
}

/**
 * Pairs each reader test with a worksheet row by Sample ID (Dennis
 * 2026-10-09): an exact ID first; otherwise the parent ID when exactly one
 * row fits; never a guess between two vials. A row tested twice takes its
 * latest test (a tie, or a time that does not parse, goes to the later one
 * in the file); the earlier tests are listed in `superseded`.
 */
export function matchReaderTests(
  tests: ReaderTest[],
  rows: { itemId: number; sampleId: string }[]
): {
  matched: { test: ReaderTest; itemId: number; via: 'exact' | 'parent' }[]
  unmatched: ReaderTest[]
  ambiguous: ReaderTest[]
  superseded: ReaderTest[]
} {
  const found = tests.map(t => findRow(t, rows))
  const at = (t: ReaderTest): number => Date.parse(t.testedAt ?? '')
  const latest = new Map<number, ReaderTest>()
  for (const f of found) {
    if (f.itemId === null) continue
    const prev = latest.get(f.itemId)
    if (!prev || !(at(prev) > at(f.test))) latest.set(f.itemId, f.test)
  }
  const matched: {
    test: ReaderTest
    itemId: number
    via: 'exact' | 'parent'
  }[] = []
  const unmatched: ReaderTest[] = []
  const ambiguous: ReaderTest[] = []
  const superseded: ReaderTest[] = []
  for (const f of found) {
    if (f.itemId === null) {
      if (f.via === 'none') unmatched.push(f.test)
      else ambiguous.push(f.test)
    } else if (latest.get(f.itemId) === f.test)
      matched.push({ test: f.test, itemId: f.itemId, via: f.via })
    else superseded.push(f.test)
  }
  return { matched, unmatched, ambiguous, superseded }
}

/**
 * Mk1's inbox export writes a vial's identity as "<product> - <the vial's
 * test>" ("Retatrutide - Identity (HPLC)"). Cuts a trailing spaced dash plus
 * a bracketed assay off; "CJC-1295 no DAC" and "BPC-157, TB500 (Thymosin
 * Beta 4)" stay whole.
 */
export function splitIdentity(raw: string): {
  product: string
  label: string | null
} {
  const s = raw.trim()
  const m =
    /^(.*\S)\s+[-\u2013]\s+([A-Za-z][A-Za-z /&+]*\((?:HPLC|UPLC|LC-?MS|MS|LAL|PCR|qPCR|KF|GC|ICP-?MS|Endo[^)]*|[A-Z][A-Za-z0-9-]{1,7})\))\s*$/.exec(
      s
    )
  return m?.[1] && m[2]
    ? { product: m[1], label: m[2] }
    : { product: s, label: null }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/__tests__/endo-reader.test.ts src/lib/__tests__/endo-prep-2ml.test.ts
npx tsc --noEmit
npx eslint --max-warnings 0 src/lib/endo-reader.ts src/lib/__tests__/endo-reader.test.ts
npx prettier --check src/lib/endo-reader.ts src/lib/__tests__/endo-reader.test.ts
```
Expected: `endo-reader.test.ts` 9 passed, `endo-prep-2ml.test.ts` 20 passed; tsc, eslint and prettier clean. (Verified while drafting with the repo's configs and test setup: 29 / 29; mutation checks on the parent guard, the latest-test rule, the lower bound and the method-limit rule each fail a test.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/endo-reader.ts src/lib/__tests__/endo-reader.test.ts
git commit -m "feat(endo-v2): port the EndoScan-V reader parsing and matching (endo-reader)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/endo-reader.ts src/lib/__tests__/endo-reader.test.ts
```

### Task 10: Frontend API client, types and the optimistic merge for the 2 mL fields

**Files:**
- Modify: `src/lib/api.ts`: `Instrument` / `InstrumentInput` (serial), method types and `putMethodServices` neighbourhood (run parameters, method consumables), a new consumables block after `updateInstrument`, worksheet types before and inside `WorksheetListItem`, `updateWorksheet` (`WorksheetUpdate`), `WorksheetItemPatch`, `updateWorksheetItem`, new `importReaderResults`, and `updateMethod`'s error text (the server's reason). `getWorksheet` already exists and is reused unchanged.
- Modify: `src/hooks/use-worksheet-drawer.ts`: `updateMutation` takes `WorksheetUpdate`; the inline merge in `updateItemMutation.onMutate` moves to an exported `mergeItemPatch` that also patches the worksheet page's cache entry (`worksheetPageKey`), and `onError` rolls back both.
- Test: `src/test/endo-v2-api.test.ts` (new), `src/hooks/__tests__/use-worksheet-drawer-page-cache.test.tsx` (new).

**Interfaces:**
- Consumes: the payloads of Tasks 2 to 7 (contract "Endpoints" and "Serializer keys"; Task 7 answers `{applied, items, endo_method}`); `EndoForm` and `EndoReaderRecord` from `src/lib/endo-prep-2ml.ts` (Task 8).
- Produces (api.ts): `ConsumableType`, `ConsumableTypeInput`, `ConsumableKind`, `ConsumableKindSpec`, `listConsumables`, `createConsumable`, `updateConsumable`, `listConsumableKinds`, `MethodConsumableLink`, `getMethodConsumables`, `putMethodConsumables`, `EndoRunParamsWire`, `MethodRunParameters`, `HplcMethod.run_parameters`, `HplcMethodInput.run_parameters`, `Instrument.serial_number`, `InstrumentInput.serial_number`, `EndoPrepModel`, `EndoMethodCartridge`, `EndoMethodInfo`, `EndoPrepStepsWire`, the worksheet keys (`endo_prep`, `cartridge_type_id`, `cartridge_sensitivity_eu_ml`, `endo_method_id`, `endo_method`) and item keys (`prep_form`, `prep_water_ml`, `prep_total_dilution`, `prep_steps`, `cartridge_type_id`, `cartridge_sensitivity_eu_ml`, `result_reading`, `result_reader`, `result_entered_at`, `result_entered_by_user_id`), `WorksheetUpdate`, the six new `WorksheetItemPatch` fields, `ReaderImportTest`, `importReaderResults`.
- Produces (hook): `mergeItemPatch(item, patch)`, `worksheetPageKey(worksheetId)` (`['worksheets-list', 'page', id]`, the page's cache entry for Task 13).
- Every field added to an existing type is optional (`?:`): `PcrSampleList.test.tsx`, `src/test/instruments-page-local.test.tsx` and `src/test/method-lifecycle-ui.test.tsx` build typed literals of these types and must keep compiling.

- [ ] **Step 1: Write the failing API client test**

Create `src/test/endo-v2-api.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  importReaderResults,
  listConsumables,
  putMethodConsumables,
  updateConsumable,
  updateMethod,
  updateWorksheet,
  updateWorksheetItem,
} from '@/lib/api'

vi.mock('@/store/auth-store', () => ({ getAuthToken: () => 'tok' }))

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
  vi.stubGlobal('fetch', fn)
  return fn
}
afterEach(() => vi.unstubAllGlobals())

function lastCall(fn: { mock: { calls: unknown[][] } }) {
  const call = fn.mock.calls.at(-1)
  if (!call) throw new Error('expected a fetch call')
  const [url, init] = call as [string, RequestInit]
  return {
    url: String(url),
    init,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  }
}

describe('endo v2 api client', () => {
  it('listConsumables sends the kind and active filters', async () => {
    const fn = stubFetch(200, [])
    await listConsumables({ kind: 'endo_cartridge', active: true })
    expect(lastCall(fn).url).toMatch(
      /\/consumables\?kind=endo_cartridge&active=true$/
    )
  })

  it('updateConsumable PATCHes only the fields it is given', async () => {
    const fn = stubFetch(200, {})
    await updateConsumable(4, { name: 'Endosafe 0.05', active: false })
    const { url, init, body } = lastCall(fn)
    expect(url).toMatch(/\/consumables\/4$/)
    expect(init.method).toBe('PATCH')
    expect(body).toEqual({ name: 'Endosafe 0.05', active: false })
  })

  it('putMethodConsumables replaces the whole set', async () => {
    const fn = stubFetch(200, [])
    await putMethodConsumables(7, [{ consumable_type_id: 1, is_default: true }])
    const { url, init, body } = lastCall(fn)
    expect(url).toMatch(/\/hplc\/methods\/7\/consumables$/)
    expect(init.method).toBe('PUT')
    expect(body).toEqual([{ consumable_type_id: 1, is_default: true }])
  })

  it('updateWorksheet carries the run fields', async () => {
    const fn = stubFetch(200, {})
    await updateWorksheet(5, { endo_prep: 'stock', cartridge_type_id: null })
    expect(lastCall(fn).body).toEqual({
      endo_prep: 'stock',
      cartridge_type_id: null,
    })
  })

  it.each([
    [
      'updateWorksheetItem',
      () => updateWorksheetItem(5, 9, { result_reading: '0.8' }),
    ],
    [
      'importReaderResults',
      () => importReaderResults(5, { file_name: 'x.csv', tests: [] }),
    ],
    [
      'updateWorksheet',
      () => updateWorksheet(5, { endo_prep: '2ml' }),
    ],
    [
      'updateMethod',
      () => updateMethod(7, { run_parameters: { endotoxin: { cv_limit_pct: 30 } } }),
    ],
  ])('%s surfaces the server reason', async (_name, call) => {
    stubFetch(409, { detail: 'Worksheet 5 is completed' })
    await expect(call()).rejects.toThrow('Worksheet 5 is completed')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/test/endo-v2-api.test.ts`
Expected: FAIL. `listConsumables`, `updateConsumable`, `putMethodConsumables` and `importReaderResults` are `undefined` (`TypeError: ... is not a function`), and the `updateWorksheet` / `updateWorksheetItem` / `updateMethod` reason cases fail with `Update worksheet failed: 409` / `Update item failed: 409` / `Update method failed: 409` instead of the server's text.

- [ ] **Step 3: Add the types and functions to `src/lib/api.ts`**

3a. Below `import type { EffectivePriority } from '@/lib/api-priorities'` add:

```ts
import type { EndoForm, EndoReaderRecord } from '@/lib/endo-prep-2ml'
```

3b. In `interface Instrument`, after `department_id: number | null`, and in `interface InstrumentInput`, after `department_id?: number | null`, add:

```ts
  /** The reader's serial; the reader import stamps the instrument by it. */
  serial_number?: string | null
```

3c. Directly after `export interface MethodServiceLink { ... }` add:

```ts
/** Endotoxin run parameters on a method (spec 2026-10-10 3.4). Every key is
 *  optional; a missing one falls back to Dennis's value. */
export interface EndoRunParamsWire {
  std_total_dilution: number
  recon_water_ml: number
  spike_recovery_min_pct: number
  spike_recovery_max_pct: number
  cv_limit_pct: number
}

export interface MethodRunParameters {
  endotoxin?: Partial<EndoRunParamsWire>
}

/** One consumable type a method allows; names come from listConsumables. */
export interface MethodConsumableLink {
  consumable_type_id: number
  kind: string
  is_default: boolean
}
```

3d. In `interface HplcMethod`, after `services: MethodServiceLink[]`, and in `interface HplcMethodInput`, after `procedure_summary?: string | null`, add:

```ts
  /** Revision-locked like the other content fields. */
  run_parameters?: MethodRunParameters | null
```

3e. Directly after the closing `}` of `export async function updateInstrument(...)` (before `// ─── Analysis Services ───`) add:

```ts
// ─── Consumables catalog (endo worksheet v2, spec 2026-10-10 3.1, 3.2) ───

export interface ConsumableType {
  id: number
  kind: string
  name: string
  manufacturer: string | null
  part_number: string | null
  instrument_id: number | null
  /** The kind's numbers, e.g. { sensitivity_eu_ml: 0.05 }. */
  specs: Record<string, number>
  /** false = retired; types are never deleted. */
  active: boolean
  /** A worksheet or item references it: kind and specs are locked. */
  in_use: boolean
}

export interface ConsumableTypeInput {
  kind: string
  name: string
  manufacturer?: string | null
  part_number?: string | null
  instrument_id?: number | null
  specs: Record<string, number>
}

export interface ConsumableKindSpec {
  key: string
  label: string
  unit: string | null
  type: string
  required: boolean
}

/** One entry of the server's kind registry: what a type of this kind holds. */
export interface ConsumableKind {
  key: string
  label: string
  specs: ConsumableKindSpec[]
}

export async function listConsumables(
  filters: { kind?: string; active?: boolean } = {}
): Promise<ConsumableType[]> {
  const params = new URLSearchParams()
  if (filters.kind) params.set('kind', filters.kind)
  if (filters.active !== undefined) params.set('active', String(filters.active))
  const qs = params.toString()
  const response = await fetch(
    `${API_BASE_URL()}/consumables${qs ? `?${qs}` : ''}`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok)
    throw new Error(
      await extractErrorMessage(response, `List consumables failed: ${response.status}`)
    )
  return response.json()
}

export async function listConsumableKinds(): Promise<ConsumableKind[]> {
  const response = await fetch(`${API_BASE_URL()}/consumables/kinds`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok)
    throw new Error(
      await extractErrorMessage(response, `List consumable kinds failed: ${response.status}`)
    )
  return response.json()
}

export async function createConsumable(
  data: ConsumableTypeInput
): Promise<ConsumableType> {
  const response = await fetch(`${API_BASE_URL()}/consumables`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok)
    throw new Error(
      await extractErrorMessage(response, `Create consumable failed: ${response.status}`)
    )
  return response.json()
}

/** Send only what changed: the server refuses kind or specs on a used type (409). */
export async function updateConsumable(
  id: number,
  data: Partial<ConsumableTypeInput & { active: boolean }>
): Promise<ConsumableType> {
  const response = await fetch(`${API_BASE_URL()}/consumables/${id}`, {
    method: 'PATCH',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok)
    throw new Error(
      await extractErrorMessage(response, `Update consumable failed: ${response.status}`)
    )
  return response.json()
}
```

3f. Directly after the closing `}` of `export async function putMethodServices(...)` add:

```ts
export async function getMethodConsumables(
  methodId: number
): Promise<MethodConsumableLink[]> {
  const response = await fetch(
    `${API_BASE_URL()}/hplc/methods/${methodId}/consumables`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok)
    throw new Error(
      await extractErrorMessage(response, `Get method consumables failed: ${response.status}`)
    )
  return response.json()
}

/** Replace-set, draft methods only (409 otherwise). */
export async function putMethodConsumables(
  methodId: number,
  links: { consumable_type_id: number; is_default: boolean }[]
): Promise<MethodConsumableLink[]> {
  const response = await fetch(
    `${API_BASE_URL()}/hplc/methods/${methodId}/consumables`,
    {
      method: 'PUT',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify(links),
    }
  )
  if (!response.ok)
    throw new Error(
      await extractErrorMessage(response, `Update method consumables failed: ${response.status}`)
    )
  return response.json()
}
```

3g. Directly above `export interface WorksheetListItem {` add:

```ts
/** How an endo worksheet's vials are prepped (spec 2026-10-10 3.6). */
export type EndoPrepModel = '2ml' | 'stock'

export interface EndoMethodCartridge {
  id: number
  name: string
  sensitivity_eu_ml: number
  is_default: boolean
  active: boolean
}

/** The worksheet's endo method revision: pinned at first print or first
 *  reading, else the current active one (spec 4.1). */
export interface EndoMethodInfo {
  id: number
  name: string
  revision: number
  status: 'draft' | 'active' | 'retired'
  run_parameters: MethodRunParameters | null
  cartridges: EndoMethodCartridge[]
}

/** Stored steps: [[sample_ul, ratio] or null, [sample_ul] or null,
 *  [sample_ul] or null]; a null entry is the standard step. */
export type EndoPrepStepsWire = ((number | null)[] | null)[]
```

Inside `WorksheetListItem`, after `note_log?: WorksheetNote[]`, add:

```ts
  /** Endo worksheet v2 (spec 2026-10-10 3.6): the prep model, the run's own
   *  cartridge and its sensitivity (null = the method default), and the
   *  pinned method revision. `endo_method` is on GET /worksheets/{id}, the
   *  item PATCH and the reader import only, never on the list. */
  endo_prep?: EndoPrepModel | null
  cartridge_type_id?: number | null
  cartridge_sensitivity_eu_ml?: number | null
  endo_method_id?: number | null
  endo_method?: EndoMethodInfo | null
```

Inside the `items: { ... }[]` element type, after `sample_identity?: string | null`, add:

```ts
    /** 2 mL prep inputs (spec 3.7); null = the standard or worked out. */
    prep_form?: EndoForm | null
    prep_water_ml?: number | null
    prep_total_dilution?: number | null
    prep_steps?: EndoPrepStepsWire | null
    /** The row's own cartridge (null = inherited) and its sensitivity. */
    cartridge_type_id?: number | null
    cartridge_sensitivity_eu_ml?: number | null
    /** The reading as the instrument shows it ("<0.05", "0.8"), the
     *  reader's record when imported, and who entered it when. */
    result_reading?: string | null
    result_reader?: EndoReaderRecord | null
    result_entered_at?: string | null
    result_entered_by_user_id?: number | null
```

3h. Replace `export async function updateWorksheet(...)` (the whole function, from its signature down to its closing `}`) with:

```ts
/** PUT body for a worksheet. Omitted = untouched. The endo run fields (spec
 *  2026-10-10 3.6): `endo_prep` switches the prep model, `cartridge_type_id`
 *  picks the run cartridge (null = the method default). */
export interface WorksheetUpdate {
  title?: string
  assigned_analyst?: number
  notes?: string
  bench_config?: Record<string, unknown>
  endo_prep?: EndoPrepModel
  cartridge_type_id?: number | null
}

export async function updateWorksheet(
  worksheetId: number,
  data: WorksheetUpdate
): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/worksheets/${worksheetId}`, {
    method: 'PUT',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok)
    throw new Error(
      await extractErrorMessage(response, `Update worksheet failed: ${response.status}`)
    )
}
```

3i. Inside `export interface WorksheetItemPatch`, after `ran?: boolean`, add:

```ts
  /** 2 mL prep and the reading (spec 3.7, 6.1.1); null clears. Setting
   *  `result_reading` on a row with no cartridge of its own must send the
   *  row's resolved `cartridge_type_id` in the same PATCH. */
  prep_form?: EndoForm | null
  prep_water_ml?: number | null
  prep_total_dilution?: number | null
  prep_steps?: EndoPrepStepsWire | null
  cartridge_type_id?: number | null
  result_reading?: string | null
```

3j. In `export async function updateWorksheetItem(...)` replace the line

```ts
  if (!response.ok) throw new Error(`Update item failed: ${response.status}`)
```

with

```ts
  if (!response.ok)
    throw new Error(
      await extractErrorMessage(response, `Update item failed: ${response.status}`)
    )
```

and directly after the closing `}` of `updateWorksheetItem` add:

```ts
/** One reader test applied to a row (spec 8.2). */
export interface ReaderImportTest {
  item_id: number
  reading: string
  record: EndoReaderRecord
  cartridge_type_id: number
  /** Overwrite a different reading already on the row. */
  replace: boolean
}

/** All or nothing: 400 names every refused row, 409 on a completed worksheet. */
export async function importReaderResults(
  worksheetId: number,
  body: { file_name: string; tests: ReaderImportTest[] }
): Promise<{
  applied: number
  items: WorksheetListItem['items']
  endo_method: EndoMethodInfo | null
}> {
  const response = await fetch(
    `${API_BASE_URL()}/worksheets/${worksheetId}/reader-import`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify(body),
    }
  )
  if (!response.ok)
    throw new Error(
      await extractErrorMessage(response, `Reader import failed: ${response.status}`)
    )
  return response.json()
}
```

3k. In `export async function updateMethod(...)` replace the line

```ts
  if (!response.ok) throw new Error(`Update method failed: ${response.status}`)
```

with

```ts
  if (!response.ok)
    throw new Error(
      await extractErrorMessage(response, `Update method failed: ${response.status}`)
    )
```

so a refused `run_parameters` (400, e.g. min not below max) or a non-draft method (409) shows the server's reason in the Run parameters section (Task 12).

`extractErrorMessage` is a hoisted `export async function` declared earlier in the file; the fallback texts are today's, so a response without a `detail` reads exactly as before.

- [ ] **Step 4: Run the API test and watch it pass**

Run: `npx vitest run src/test/endo-v2-api.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing hook test**

Create `src/hooks/__tests__/use-worksheet-drawer-page-cache.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import {
  listWorksheets,
  updateWorksheetItem,
  type WorksheetListItem,
} from '@/lib/api'
import {
  mergeItemPatch,
  useWorksheetDrawer,
  worksheetPageKey,
} from '@/hooks/use-worksheet-drawer'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/api', () => ({
  listWorksheets: vi.fn(),
  getWorksheet: vi.fn(async () => null),
  updateWorksheet: vi.fn(),
  removeWorksheetItem: vi.fn(),
  completeWorksheet: vi.fn(),
  reassignWorksheetItem: vi.fn(),
  addGroupToWorksheet: vi.fn(),
  reorderWorksheetItems: vi.fn(),
  updateWorksheetItem: vi.fn(),
  bulkWorksheetBenchTicks: vi.fn(),
  applyWorksheetMethodInstrument: vi.fn(),
}))

// The endo worksheet page reads GET /worksheets/{id} from its own cache entry
// (the only read that carries endo_method). A cell typed there must show at
// once and, if the server refuses it, go back, exactly as in the flyout list.

type Item = WorksheetListItem['items'][number]

function worksheet(items: Partial<Item>[]): WorksheetListItem {
  return {
    id: 24,
    title: 'Endo 10/10/2026',
    status: 'open',
    items: items.map(it => ({ prep_status: 'ready', ...it })),
  } as unknown as WorksheetListItem
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('mergeItemPatch', () => {
  it('applies the 2 mL fields and leaves the rest alone', () => {
    const [before] = worksheet([{ id: 1 }]).items
    if (!before) throw new Error('fixture')
    const after = mergeItemPatch(before, {
      prep_form: 'liquid',
      prep_water_ml: 1.5,
      prep_total_dilution: 500,
      prep_steps: [[25, 8], null, null],
      cartridge_type_id: 3,
      result_reading: '<0.05',
    })
    expect(after).toMatchObject({
      id: 1,
      prep_status: 'ready',
      prep_form: 'liquid',
      prep_water_ml: 1.5,
      prep_total_dilution: 500,
      prep_steps: [[25, 8], null, null],
      cartridge_type_id: 3,
      result_reading: '<0.05',
    })
  })

  it('an explicit null clears a field', () => {
    const [before] = worksheet([{ id: 1, result_reading: '0.8' }]).items
    if (!before) throw new Error('fixture')
    expect(mergeItemPatch(before, { result_reading: null }).result_reading).toBeNull()
  })
})

describe('the worksheet page cache', () => {
  beforeEach(() => {
    vi.mocked(listWorksheets).mockReset().mockResolvedValue([worksheet([{ id: 1 }])])
    vi.mocked(updateWorksheetItem).mockReset()
  })

  it('shows an edit at once and rolls it back on failure, in the list and on the page', async () => {
    const pending = deferred<{ status: string; item_id: number }>()
    vi.mocked(updateWorksheetItem).mockReturnValueOnce(pending.promise)
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    qc.setQueryData(worksheetPageKey(24), worksheet([{ id: 1 }]))
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children)
    const hook = renderHook(() => useWorksheetDrawer(), { wrapper })
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false))
    const water = () => ({
      list:
        qc.getQueryData<WorksheetListItem[]>(['worksheets-list', 'open'])?.[0]
          ?.items[0]?.prep_water_ml ?? null,
      page:
        qc.getQueryData<WorksheetListItem>(worksheetPageKey(24))?.items[0]
          ?.prep_water_ml ?? null,
    })

    act(() => {
      hook.result.current.updateItemMutation.mutate({
        worksheetId: 24,
        itemId: 1,
        data: { prep_water_ml: 1.5 },
      })
    })
    await waitFor(() => expect(water()).toEqual({ list: 1.5, page: 1.5 }))

    await act(async () => {
      pending.reject(new Error('Update item failed: 409'))
      await pending.promise.catch(() => undefined)
    })
    await waitFor(() => expect(water()).toEqual({ list: null, page: null }))
    qc.clear()
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run src/hooks/__tests__/use-worksheet-drawer-page-cache.test.tsx`
Expected: FAIL. `mergeItemPatch` and `worksheetPageKey` are not exported (`TypeError: ... is not a function`); once they exist and before the onMutate change, the page cache test fails on `{ list: 1.5, page: null }`.

- [ ] **Step 7: Change `src/hooks/use-worksheet-drawer.ts`**

7a. In the `import type { ... } from '@/lib/api'` block add `WorksheetUpdate,` after `WorksheetWellFreeze,`.

7b. Directly after the closing `}` of `function withTickStatus(...)` add:

```ts
/** The worksheet page's cache entry (spec 2026-10-10 6.1). Under the
 *  'worksheets-list' prefix on purpose, like BenchRunLog's: every worksheet
 *  mutation already invalidates that prefix, so the page refreshes with the
 *  flyout. It holds GET /worksheets/{id}, the only read that carries the
 *  worksheet's endo method. */
export function worksheetPageKey(worksheetId: number) {
  return ['worksheets-list', 'page', worksheetId] as const
}

/** A PATCH's fields on a cached item, as the server will store them. */
export function mergeItemPatch(
  item: WorksheetItemRow,
  data: WorksheetItemPatch
): WorksheetItemRow {
  return withTickStatus(data, {
    ...item,
    ...(data.prep_status !== undefined
      ? { prep_status: data.prep_status }
      : {}),
    ...(data.instrument_uid !== undefined
      ? { instrument_uid: data.instrument_uid || null }
      : {}),
    ...(data.instrument_id !== undefined
      ? { instrument_id: data.instrument_id }
      : {}),
    ...(data.prep_weight_mg !== undefined
      ? { prep_weight_mg: data.prep_weight_mg }
      : {}),
    ...(data.prep_volume_ml !== undefined
      ? { prep_volume_ml: data.prep_volume_ml }
      : {}),
    ...(data.prep_target_mg_ml !== undefined
      ? { prep_target_mg_ml: data.prep_target_mg_ml }
      : {}),
    ...(data.made !== undefined
      ? {
          made_at: data.made
            ? (item.made_at ?? new Date().toISOString())
            : null,
        }
      : {}),
    ...(data.ran !== undefined
      ? {
          ran_at: data.ran ? (item.ran_at ?? new Date().toISOString()) : null,
        }
      : {}),
    ...(data.prep_dilution_factor !== undefined
      ? { prep_dilution_factor: data.prep_dilution_factor }
      : {}),
    // Endo worksheet v2 (spec 2026-10-10 3.7): the 2 mL prep inputs, the
    // row's own cartridge and the reading.
    ...(data.prep_form !== undefined ? { prep_form: data.prep_form } : {}),
    ...(data.prep_water_ml !== undefined
      ? { prep_water_ml: data.prep_water_ml }
      : {}),
    ...(data.prep_total_dilution !== undefined
      ? { prep_total_dilution: data.prep_total_dilution }
      : {}),
    ...(data.prep_steps !== undefined ? { prep_steps: data.prep_steps } : {}),
    ...(data.cartridge_type_id !== undefined
      ? { cartridge_type_id: data.cartridge_type_id }
      : {}),
    ...(data.result_reading !== undefined
      ? { result_reading: data.result_reading }
      : {}),
  })
}
```

The first nine spreads are the existing inline merge, unchanged, moved here.

7c. In `updateMutation`, replace the inline `data` type

```ts
      data: {
        title?: string
        assigned_analyst?: number
        notes?: string
        bench_config?: Record<string, unknown>
      }
    }) => updateWorksheet(worksheetId, data),
```

with

```ts
      data: WorksheetUpdate
    }) => updateWorksheet(worksheetId, data),
```

7d. In `updateItemMutation`, keep the comment block above `onMutate` as it is and replace everything from the line `onMutate: async ({ worksheetId, itemId, data }) => {` down to and including the `},` that closes `onError` with:

```ts
    onMutate: async ({ worksheetId, itemId, data }) => {
      const pageKey = worksheetPageKey(worksheetId)
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['worksheets-list', 'open'] }),
        queryClient.cancelQueries({ queryKey: pageKey }),
      ])
      const previous = queryClient.getQueryData<WorksheetListItem[]>([
        'worksheets-list',
        'open',
      ])
      const page = queryClient.getQueryData<WorksheetListItem>(pageKey)
      const patched = (ws: WorksheetListItem): WorksheetListItem => ({
        ...ws,
        items: ws.items.map(it =>
          it.id !== itemId ? it : mergeItemPatch(it, data)
        ),
      })
      if (previous) {
        queryClient.setQueryData<WorksheetListItem[]>(
          ['worksheets-list', 'open'],
          previous.map(ws => (ws.id !== worksheetId ? ws : patched(ws)))
        )
      }
      // The worksheet page (endo) reads its own entry: patch it the same way.
      if (page) queryClient.setQueryData<WorksheetListItem>(pageKey, patched(page))
      const previousItem = (
        previous?.find(ws => ws.id === worksheetId) ?? page
      )?.items.find(it => it.id === itemId)
      return { previousItem }
    },
    onError: (err, { worksheetId, itemId }, context) => {
      const before = context?.previousItem
      if (before) {
        const restored = (ws: WorksheetListItem): WorksheetListItem => ({
          ...ws,
          items: ws.items.map(it => (it.id === itemId ? before : it)),
        })
        queryClient.setQueryData<WorksheetListItem[]>(
          ['worksheets-list', 'open'],
          list =>
            list?.map(ws => (ws.id !== worksheetId ? ws : restored(ws)))
        )
        queryClient.setQueryData<WorksheetListItem>(
          worksheetPageKey(worksheetId),
          ws => (ws ? restored(ws) : ws)
        )
      }
      toast.error(err instanceof Error ? err.message : 'Update item failed')
    },
```

`onSettled` stays as it is: its `['worksheets-list']` invalidation already covers the page entry.

- [ ] **Step 8: Run the new and existing hook tests, typecheck, lint and format**

Run:
```bash
npx vitest run src/hooks/__tests__/ src/test/endo-v2-api.test.ts
npx prettier --write src/lib/api.ts src/hooks/use-worksheet-drawer.ts src/test/endo-v2-api.test.ts src/hooks/__tests__/use-worksheet-drawer-page-cache.test.tsx
npm run typecheck
npx eslint src/lib/api.ts src/hooks/use-worksheet-drawer.ts src/test/endo-v2-api.test.ts src/hooks/__tests__/use-worksheet-drawer-page-cache.test.tsx --max-warnings 0
```
Expected: every file in `src/hooks/__tests__/` passes (the ticks and dedup suites prove the merge moved without changing), typecheck and eslint clean.

- [ ] **Step 9: Commit**

```bash
git add src/test/endo-v2-api.test.ts src/hooks/__tests__/use-worksheet-drawer-page-cache.test.tsx
git commit -m "feat(endo-v2): API client, types and optimistic merge for the 2 mL fields" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/api.ts src/hooks/use-worksheet-drawer.ts src/test/endo-v2-api.test.ts src/hooks/__tests__/use-worksheet-drawer-page-cache.test.tsx
```

---

### Task 11: Consumables admin page and its LIMS sidebar entry

**Files:**
- Create: `src/components/hplc/ConsumablesPage.tsx` (`ConsumablesPage`, private `ConsumablePanel`), built like `InstrumentsPage` (table, search, right-hand slide-out panel).
- Modify: `src/store/ui-store.ts` (`LIMSSubSection` gains `'consumables'`), `src/components/layout/AppSidebar.tsx` (LIMS `subItems`), `src/components/layout/MainWindowContent.tsx` (`'lims'` case).
- Test: `src/test/consumables-page.test.tsx` (new).

**Interfaces:**
- Consumes (Task 10): `listConsumables`, `listConsumableKinds`, `createConsumable`, `updateConsumable`, `ConsumableType`, `ConsumableKind`; existing `getInstruments`, `Instrument`.
- Produces: `ConsumablesPage`; LIMS subsection `'consumables'` (sidebar entry "Consumables", any logged-in user, as spec section 10 allows).

- [ ] **Step 1: Write the failing page test**

Create `src/test/consumables-page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ConsumableKind, ConsumableType, Instrument } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    listConsumables: vi.fn(),
    listConsumableKinds: vi.fn(),
    createConsumable: vi.fn(),
    updateConsumable: vi.fn(),
    getInstruments: vi.fn(),
  }
})

import {
  createConsumable,
  getInstruments,
  listConsumableKinds,
  listConsumables,
  updateConsumable,
} from '@/lib/api'
import { ConsumablesPage } from '@/components/hplc/ConsumablesPage'

const KIND: ConsumableKind = {
  key: 'endo_cartridge',
  label: 'Endotoxin cartridge',
  specs: [
    {
      key: 'sensitivity_eu_ml',
      label: 'Sensitivity',
      unit: 'EU/mL',
      type: 'positive_float',
      required: true,
    },
  ],
}
const USED: ConsumableType = {
  id: 1,
  kind: 'endo_cartridge',
  name: 'Endosafe 0.05',
  manufacturer: 'Example Co',
  part_number: 'PN-005',
  instrument_id: 3,
  specs: { sensitivity_eu_ml: 0.05 },
  active: true,
  in_use: true,
}
const FREE: ConsumableType = {
  ...USED,
  id: 2,
  name: 'Endosafe 0.01',
  part_number: 'PN-001',
  specs: { sensitivity_eu_ml: 0.01 },
  in_use: false,
}
const READER = { id: 3, name: 'Nexgen-MCS', active: true } as Instrument

describe('ConsumablesPage', () => {
  beforeEach(() => {
    vi.mocked(listConsumables).mockReset().mockResolvedValue([USED, FREE])
    vi.mocked(listConsumableKinds).mockReset().mockResolvedValue([KIND])
    vi.mocked(getInstruments).mockReset().mockResolvedValue([READER])
    vi.mocked(createConsumable).mockReset().mockResolvedValue(FREE)
    vi.mocked(updateConsumable).mockReset().mockResolvedValue(USED)
  })

  it("lists each type with its kind, instrument, the kind's numbers and whether it is used", async () => {
    render(<ConsumablesPage />)
    const row = (await screen.findByText('Endosafe 0.05')).closest('tr')
    if (!row) throw new Error('expected a table row')
    for (const text of ['Endotoxin cartridge', 'Example Co', 'PN-005', 'Nexgen-MCS', '0.05', 'Yes', 'Active'])
      expect(within(row).getByText(text)).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /sensitivity/i })).toBeInTheDocument()
  })

  it('shows a used type\'s numbers read-only and never sends kind or specs for it', async () => {
    const user = userEvent.setup()
    render(<ConsumablesPage />)
    await user.click(await screen.findByText('Endosafe 0.05'))
    expect(
      screen.getByText('In use; retire and add a new one to change')
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Sensitivity (EU/mL)')).toBeNull()
    expect(screen.getByLabelText('Kind')).toBeDisabled()

    await user.type(screen.getByLabelText('Part number'), 'B')
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(updateConsumable).toHaveBeenCalledTimes(1))
    const [id, body] = vi.mocked(updateConsumable).mock.calls[0] ?? []
    expect(id).toBe(1)
    expect(body).toEqual({
      name: 'Endosafe 0.05',
      manufacturer: 'Example Co',
      part_number: 'PN-005B',
      instrument_id: 3,
      active: true,
    })
  })

  it('creates a type with its kind and numbers', async () => {
    const user = userEvent.setup()
    render(<ConsumablesPage />)
    // Add stays disabled until the kind registry has loaded with the rows.
    await screen.findByText('Endosafe 0.05')
    await user.click(screen.getByRole('button', { name: /add consumable/i }))
    await user.type(screen.getByLabelText('Name'), 'Endosafe 0.005')
    await user.type(screen.getByLabelText('Sensitivity (EU/mL)'), '0.005')
    await user.click(screen.getByRole('button', { name: /^create$/i }))
    await waitFor(() =>
      expect(createConsumable).toHaveBeenCalledWith({
        kind: 'endo_cartridge',
        name: 'Endosafe 0.005',
        manufacturer: null,
        part_number: null,
        instrument_id: null,
        specs: { sensitivity_eu_ml: 0.005 },
      })
    )
  })

  it('refuses a number at or below zero before sending anything', async () => {
    const user = userEvent.setup()
    render(<ConsumablesPage />)
    await screen.findByText('Endosafe 0.05')
    await user.click(screen.getByRole('button', { name: /add consumable/i }))
    await user.type(screen.getByLabelText('Name'), 'Bad')
    await user.type(screen.getByLabelText('Sensitivity (EU/mL)'), '0')
    await user.click(screen.getByRole('button', { name: /^create$/i }))
    expect(
      await screen.findByText('Sensitivity must be a number above zero')
    ).toBeInTheDocument()
    expect(createConsumable).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/test/consumables-page.test.tsx`
Expected: FAIL with `Failed to resolve import "@/components/hplc/ConsumablesPage"`.

- [ ] **Step 3: Create `src/components/hplc/ConsumablesPage.tsx`**

```tsx
import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  Search,
  Package,
  ChevronRight,
  X,
  Plus,
  Save,
  Lock,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  createConsumable,
  getInstruments,
  listConsumableKinds,
  listConsumables,
  updateConsumable,
  type ConsumableKind,
  type ConsumableType,
  type Instrument,
} from '@/lib/api'

// The native select the Instruments page uses for Department.
const SELECT =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60'

/**
 * The consumables catalog (spec 2026-10-10 3.1, 3.2, 6.4): the cartridges the
 * lab runs and, later, other kinds, built like the Instruments page. Which
 * numbers a type holds comes from the server's kind registry. A type's kind
 * and numbers lock once a worksheet has used it; a wrong number is fixed by
 * retiring the type and adding a new one. Nothing is ever deleted.
 */
export function ConsumablesPage() {
  const [consumables, setConsumables] = useState<ConsumableType[]>([])
  const [kinds, setKinds] = useState<ConsumableKind[]>([])
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | 'new' | null>(null)
  const [searchInput, setSearchInput] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [rows, kindRows, instrumentRows] = await Promise.all([
        listConsumables(),
        listConsumableKinds(),
        getInstruments(),
      ])
      setConsumables(rows)
      setKinds(kindRows)
      setInstruments(instrumentRows)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load consumables')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const editing =
    typeof selected === 'number'
      ? (consumables.find(c => c.id === selected) ?? null)
      : null
  const panelOpen = selected === 'new' || editing !== null
  const kindLabel = (key: string) => kinds.find(k => k.key === key)?.label ?? key
  // One column per number a kind defines (today: the cartridge's sensitivity).
  const specColumns = kinds.flatMap(k => k.specs.map(s => ({ kind: k.key, ...s })))
  const colCount = 8 + specColumns.length

  const filtered = consumables.filter(c => {
    if (!searchInput) return true
    const q = searchInput.toLowerCase()
    return [c.name, c.manufacturer, c.part_number, kindLabel(c.kind)].some(
      v => v?.toLowerCase().includes(q) ?? false
    )
  })

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Package className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Consumables</h1>
            <p className="text-sm text-muted-foreground">
              Cartridges and other supplies methods allow. Retire a type to
              stop offering it; nothing is deleted.
            </p>
          </div>
        </div>
        <Button onClick={() => setSelected('new')} disabled={kinds.length === 0}>
          <Plus className="mr-1 h-4 w-4" />
          Add consumable
        </Button>
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="flex items-center gap-2 py-3">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <span className="text-sm text-destructive">{error}</span>
          </CardContent>
        </Card>
      )}

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search consumables..."
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          className="pl-9"
        />
      </div>

      <Card className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Manufacturer</TableHead>
              <TableHead>Part number</TableHead>
              <TableHead>Instrument</TableHead>
              {specColumns.map(col => (
                <TableHead key={`${col.kind}.${col.key}`} className="text-right">
                  {col.label}
                  {col.unit && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {col.unit}
                    </span>
                  )}
                </TableHead>
              ))}
              <TableHead>In use</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-12.5"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={colCount} className="py-8 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={colCount}
                  className="py-8 text-center text-muted-foreground"
                >
                  {consumables.length === 0
                    ? 'No consumables yet. Click "Add consumable" to register one.'
                    : 'No consumables match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(c => (
                <TableRow
                  key={c.id}
                  className={`cursor-pointer transition-colors hover:bg-muted/50 ${
                    selected === c.id ? 'bg-muted/50' : ''
                  }`}
                  onClick={() => setSelected(c.id)}
                >
                  <TableCell>{kindLabel(c.kind)}</TableCell>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.manufacturer ?? '-'}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {c.part_number ?? '-'}
                  </TableCell>
                  <TableCell>
                    {instruments.find(i => i.id === c.instrument_id)?.name ?? '-'}
                  </TableCell>
                  {specColumns.map(col => (
                    <TableCell
                      key={`${col.kind}.${col.key}`}
                      className="text-right font-mono"
                    >
                      {c.kind === col.kind ? String(c.specs[col.key] ?? '-') : '-'}
                    </TableCell>
                  ))}
                  <TableCell>
                    <Badge
                      variant={c.in_use ? 'secondary' : 'outline'}
                      className="text-xs"
                    >
                      {c.in_use ? 'Yes' : 'No'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={c.active ? 'default' : 'outline'}
                      className="text-xs"
                    >
                      {c.active ? 'Active' : 'Retired'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {panelOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]"
            style={{ animation: 'fadeIn 0.2s ease-out' }}
            onClick={() => setSelected(null)}
          />
          <div
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l bg-background shadow-xl"
            style={{ animation: 'slideInRight 0.25s ease-out' }}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-6 py-4">
              <div className="flex items-center gap-2">
                <Package className="h-5 w-5 text-primary" />
                <span className="text-lg font-semibold">
                  {editing ? editing.name : 'New consumable'}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close"
                onClick={() => setSelected(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <ConsumablePanel
                key={String(selected)}
                consumable={editing}
                kinds={kinds}
                instruments={instruments}
                onSaved={() => {
                  setSelected(null)
                  load()
                }}
              />
            </div>
          </div>
        </>
      )}

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>
    </div>
  )
}

// ─── Create / edit panel ───

function ConsumablePanel({
  consumable,
  kinds,
  instruments,
  onSaved,
}: {
  consumable: ConsumableType | null
  kinds: ConsumableKind[]
  instruments: Instrument[]
  onSaved: () => void
}) {
  const locked = consumable?.in_use ?? false
  const [kind, setKind] = useState(consumable?.kind ?? kinds[0]?.key ?? '')
  const [name, setName] = useState(consumable?.name ?? '')
  const [manufacturer, setManufacturer] = useState(consumable?.manufacturer ?? '')
  const [partNumber, setPartNumber] = useState(consumable?.part_number ?? '')
  const [instrumentId, setInstrumentId] = useState<number | null>(
    consumable?.instrument_id ?? null
  )
  const [specs, setSpecs] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(consumable?.specs ?? {}).map(([k, v]) => [k, String(v)])
    )
  )
  const [active, setActive] = useState(consumable?.active ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kindDef = kinds.find(k => k.key === kind)

  async function handleSave() {
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    const numbers: Record<string, number> = {}
    if (!locked) {
      for (const s of kindDef?.specs ?? []) {
        const text = (specs[s.key] ?? '').trim()
        if (!text) {
          if (s.required) {
            setError(`${s.label} is required`)
            return
          }
          continue
        }
        const n = Number(text)
        if (!Number.isFinite(n) || n <= 0) {
          setError(`${s.label} must be a number above zero`)
          return
        }
        numbers[s.key] = n
      }
    }
    const fields = {
      name: name.trim(),
      manufacturer: manufacturer.trim() || null,
      part_number: partNumber.trim() || null,
      instrument_id: instrumentId,
    }
    setSaving(true)
    setError(null)
    try {
      if (!consumable) {
        await createConsumable({ kind, specs: numbers, ...fields })
      } else if (locked) {
        // A used type's kind and numbers are locked server-side (409): never send them.
        await updateConsumable(consumable.id, { ...fields, active })
      } else {
        await updateConsumable(consumable.id, {
          ...fields,
          kind,
          specs: numbers,
          active,
        })
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="cons-kind">Kind</Label>
        <select
          id="cons-kind"
          className={SELECT}
          value={kind}
          disabled={locked}
          onChange={e => setKind(e.target.value)}
        >
          {kinds.map(k => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="cons-name">Name</Label>
        <Input
          id="cons-name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Endosafe cartridge 0.05"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="cons-manufacturer">Manufacturer</Label>
          <Input
            id="cons-manufacturer"
            value={manufacturer}
            onChange={e => setManufacturer(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cons-part">Part number</Label>
          <Input
            id="cons-part"
            value={partNumber}
            onChange={e => setPartNumber(e.target.value)}
            className="font-mono"
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="cons-instrument">Instrument</Label>
        <select
          id="cons-instrument"
          className={SELECT}
          value={instrumentId ?? ''}
          onChange={e =>
            setInstrumentId(e.target.value ? Number(e.target.value) : null)
          }
        >
          <option value="">None</option>
          {instruments.map(i => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </div>
      {(kindDef?.specs ?? []).map(s => {
        const label = `${s.label}${s.unit ? ` (${s.unit})` : ''}`
        return locked ? (
          <dl key={s.key} className="text-sm">
            <dt className="flex items-center gap-1 font-medium text-muted-foreground">
              <Lock className="h-3 w-3" />
              {label}
            </dt>
            <dd className="mt-0.5 font-mono">
              {String(consumable?.specs[s.key] ?? '-')}
            </dd>
          </dl>
        ) : (
          <div key={s.key} className="space-y-2">
            <Label htmlFor={`cons-spec-${s.key}`}>{label}</Label>
            <Input
              id={`cons-spec-${s.key}`}
              inputMode="decimal"
              className="font-mono"
              value={specs[s.key] ?? ''}
              onChange={e => setSpecs({ ...specs, [s.key]: e.target.value })}
            />
          </div>
        )
      })}
      {locked && (
        <p className="text-xs text-muted-foreground">
          In use; retire and add a new one to change
        </p>
      )}
      {consumable && (
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch
            checked={!active}
            onCheckedChange={retired => setActive(!retired)}
            aria-label="Retired"
          />
          Retired
        </label>
      )}
      <Button onClick={handleSave} disabled={saving || !kind}>
        {saving ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Save className="mr-1 h-3.5 w-3.5" />
        )}
        {consumable ? 'Save' : 'Create'}
      </Button>
    </div>
  )
}

export default ConsumablesPage
```

- [ ] **Step 4: Register the page**

4a. `src/store/ui-store.ts`, in `export type LIMSSubSection`, replace

```ts
  | 'instruments'
  | 'methods'
```

with

```ts
  | 'instruments'
  | 'methods'
  | 'consumables'
```

4b. `src/components/layout/AppSidebar.tsx`, in the `lims` entry's `subItems`, after `{ id: 'methods', label: 'Methods' },` add:

```ts
      { id: 'consumables', label: 'Consumables' },
```

4c. `src/components/layout/MainWindowContent.tsx`: after `import { MethodsPage } from '@/components/hplc/MethodsPage'` add

```ts
import { ConsumablesPage } from '@/components/hplc/ConsumablesPage'
```

and in `case 'lims':`, after `if (activeSubSection === 'methods') return <MethodsPage />` add

```tsx
        if (activeSubSection === 'consumables') return <ConsumablesPage />
```

- [ ] **Step 5: Run the test, typecheck, lint and format**

Run:
```bash
npx vitest run src/test/consumables-page.test.tsx src/components/layout/__tests__/AppSidebar.test.tsx
npx prettier --write src/components/hplc/ConsumablesPage.tsx src/store/ui-store.ts src/components/layout/AppSidebar.tsx src/components/layout/MainWindowContent.tsx src/test/consumables-page.test.tsx
npm run typecheck
npx eslint src/components/hplc/ConsumablesPage.tsx src/store/ui-store.ts src/components/layout/AppSidebar.tsx src/components/layout/MainWindowContent.tsx src/test/consumables-page.test.tsx --max-warnings 0
```
Expected: PASS (4 page tests plus the existing sidebar suite), typecheck and eslint clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/hplc/ConsumablesPage.tsx src/test/consumables-page.test.tsx
git commit -m "feat(endo-v2): consumables admin page in the LIMS sidebar" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/hplc/ConsumablesPage.tsx src/store/ui-store.ts src/components/layout/AppSidebar.tsx src/components/layout/MainWindowContent.tsx src/test/consumables-page.test.tsx
```

---

### Task 12: Method panel sections (Consumables, Run parameters) and the instrument serial number

**Files:**
- Create: `src/components/hplc/MethodConsumablesSection.tsx` (`MethodConsumablesSection`), `src/components/hplc/MethodRunParamsSection.tsx` (`MethodRunParamsSection`).
- Modify: `src/components/hplc/MethodPanel.tsx` (`MethodPanel`: an `isEndoMethod` flag and both sections mounted after Covered Services).
- Modify: `src/components/hplc/InstrumentsPage.tsx` (`InstrumentsPage` table column and search, `InstrumentPanel` field, detail row and save body, `AddInstrumentForm` field and create body).
- Test: `src/test/method-endo-sections.test.tsx` (new), `src/test/instruments-serial.test.tsx` (new).

**Interfaces:**
- Consumes (Task 10): `getMethodConsumables`, `putMethodConsumables`, `listConsumables`, `listConsumableKinds`, `MethodConsumableLink`, `ConsumableType`, `ConsumableKind`, `EndoRunParamsWire`, `HplcMethod.run_parameters`, `HplcMethodInput.run_parameters` (through the existing `updateMethod`), `Instrument.serial_number`, `InstrumentInput.serial_number`. From Task 8: `ENDO_RUN_PARAM_DEFAULTS`, `EndoRunParams`.
- Produces: `MethodConsumablesSection({ method, onUpdated })`, `MethodRunParamsSection({ method, onUpdated })`. Both use `useState` / `useEffect` with `.catch(console.error)` like `MethodPanel` itself, never react-query: `src/test/method-lifecycle-ui.test.tsx` renders `MethodPanel` without a QueryClientProvider.
- Lock rule (spec 6.5): editable only while `method.status === 'draft'`; otherwise read-only with "Changes need a new revision". The server enforces the same (409).
- Both sections show only on an endotoxin method: one linked to a service whose keyword contains `ENDO` (the spec 6.7 rule), or one that already carries `run_parameters.endotoxin`. HPLC and ICP-MS methods look exactly as today.

- [ ] **Step 1: Write the failing method section tests**

Create `src/test/method-endo-sections.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  ConsumableKind,
  ConsumableType,
  HplcMethod,
  MethodConsumableLink,
} from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getMethodConsumables: vi.fn(),
    putMethodConsumables: vi.fn(),
    listConsumables: vi.fn(),
    listConsumableKinds: vi.fn(),
    updateMethod: vi.fn(),
    // MethodPanel's own loads, for the mount test
    getMethods: vi.fn(),
    getInstruments: vi.fn(),
    getDepartments: vi.fn(),
    getAnalysisServices: vi.fn(),
    getMethodServices: vi.fn(),
    putMethodServices: vi.fn(),
    getPeptides: vi.fn(),
    getMethodAttachments: vi.fn(),
  }
})

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import {
  getAnalysisServices,
  getDepartments,
  getInstruments,
  getMethodAttachments,
  getMethodConsumables,
  getMethodServices,
  getMethods,
  getPeptides,
  listConsumableKinds,
  listConsumables,
  putMethodConsumables,
  updateMethod,
} from '@/lib/api'
import { MethodConsumablesSection } from '@/components/hplc/MethodConsumablesSection'
import { MethodRunParamsSection } from '@/components/hplc/MethodRunParamsSection'
import { MethodPanel } from '@/components/hplc/MethodPanel'

const method = (over: Partial<HplcMethod> = {}): HplcMethod =>
  ({
    id: 7,
    name: 'Endotoxin',
    status: 'draft',
    revision: 2,
    supersedes_id: null,
    senaite_id: null,
    instrument_ids: [],
    instruments: [],
    services: [],
    common_peptides: [],
    run_parameters: null,
    ...over,
  }) as HplcMethod

const KIND: ConsumableKind = {
  key: 'endo_cartridge',
  label: 'Endotoxin cartridge',
  specs: [
    {
      key: 'sensitivity_eu_ml',
      label: 'Sensitivity',
      unit: 'EU/mL',
      type: 'positive_float',
      required: true,
    },
  ],
}
const cart = (id: number, name: string, sens: number, active = true): ConsumableType => ({
  id,
  kind: 'endo_cartridge',
  name,
  manufacturer: null,
  part_number: null,
  instrument_id: null,
  specs: { sensitivity_eu_ml: sens },
  active,
  in_use: false,
})
const LINKED: MethodConsumableLink[] = [
  { consumable_type_id: 1, kind: 'endo_cartridge', is_default: true },
]

describe('MethodConsumablesSection', () => {
  beforeEach(() => {
    vi.mocked(getMethodConsumables).mockReset().mockResolvedValue(LINKED)
    vi.mocked(listConsumables)
      .mockReset()
      .mockResolvedValue([
        cart(1, 'Endosafe 0.05', 0.05),
        cart(2, 'Endosafe 0.01', 0.01),
        cart(3, 'Endosafe old', 0.02, false),
      ])
    vi.mocked(listConsumableKinds).mockReset().mockResolvedValue([KIND])
    vi.mocked(putMethodConsumables)
      .mockReset()
      .mockImplementation(async (_id, links) =>
        links.map(l => ({ ...l, kind: 'endo_cartridge' }))
      )
  })

  it('on a draft, adds an active type and moves the default within its kind', async () => {
    const user = userEvent.setup()
    render(<MethodConsumablesSection method={method()} onUpdated={vi.fn()} />)
    expect(await screen.findByText('Endosafe 0.05')).toBeInTheDocument()

    const add = screen.getByLabelText('Add Endotoxin cartridge')
    expect(
      Array.from(add.querySelectorAll('option')).map(o => o.value)
    ).toEqual(['', '2']) // the retired type is never offered
    await user.selectOptions(add, '2')
    await waitFor(() =>
      expect(putMethodConsumables).toHaveBeenLastCalledWith(7, [
        { consumable_type_id: 1, is_default: true },
        { consumable_type_id: 2, is_default: false },
      ])
    )

    await user.click(await screen.findByLabelText('Default: Endosafe 0.01'))
    await waitFor(() =>
      expect(putMethodConsumables).toHaveBeenLastCalledWith(7, [
        { consumable_type_id: 1, is_default: false },
        { consumable_type_id: 2, is_default: true },
      ])
    )
  })

  it('on an issued method, lists the types read-only', async () => {
    render(
      <MethodConsumablesSection method={method({ status: 'active' })} onUpdated={vi.fn()} />
    )
    expect(await screen.findByText('Endosafe 0.05')).toBeInTheDocument()
    expect(screen.getByText('Changes need a new revision')).toBeInTheDocument()
    expect(screen.getByText('Default')).toBeInTheDocument()
    expect(screen.queryByLabelText('Add Endotoxin cartridge')).toBeNull()
    expect(screen.queryByLabelText('Remove Endosafe 0.05')).toBeNull()
  })
})

describe('MethodRunParamsSection', () => {
  beforeEach(() => {
    vi.mocked(updateMethod).mockReset().mockResolvedValue(method())
  })

  it("shows Dennis's values as placeholders and saves only what is typed", async () => {
    const user = userEvent.setup()
    render(<MethodRunParamsSection method={method()} onUpdated={vi.fn()} />)
    const placeholders: [string, string][] = [
      ['Standard total dilution (1:N)', '250'],
      ['Reconstitution water (mL)', '2'],
      ['Spike recovery min (%)', '50'],
      ['Spike recovery max (%)', '200'],
      ['CV limit (%)', '25'],
    ]
    for (const [label, value] of placeholders)
      expect(screen.getByLabelText(label)).toHaveAttribute('placeholder', value)

    await user.type(screen.getByLabelText('Standard total dilution (1:N)'), '300')
    await user.click(screen.getByRole('button', { name: /save run parameters/i }))
    await waitFor(() =>
      expect(updateMethod).toHaveBeenCalledWith(7, {
        run_parameters: { endotoxin: { std_total_dilution: 300 } },
      })
    )
  })

  it('clearing every value sends null', async () => {
    const user = userEvent.setup()
    render(
      <MethodRunParamsSection
        method={method({ run_parameters: { endotoxin: { cv_limit_pct: 30 } } })}
        onUpdated={vi.fn()}
      />
    )
    await user.clear(screen.getByLabelText('CV limit (%)'))
    await user.click(screen.getByRole('button', { name: /save run parameters/i }))
    await waitFor(() =>
      expect(updateMethod).toHaveBeenCalledWith(7, { run_parameters: null })
    )
  })

  it('is read-only on an issued method', () => {
    render(
      <MethodRunParamsSection method={method({ status: 'active' })} onUpdated={vi.fn()} />
    )
    expect(screen.getByLabelText('CV limit (%)')).toBeDisabled()
    expect(screen.getByText('Changes need a new revision')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save run parameters/i })).toBeNull()
  })
})

describe('MethodPanel', () => {
  beforeEach(() => {
    vi.mocked(getMethods).mockReset().mockResolvedValue([])
    vi.mocked(getInstruments).mockReset().mockResolvedValue([])
    vi.mocked(getDepartments).mockReset().mockResolvedValue([])
    vi.mocked(getAnalysisServices).mockReset().mockResolvedValue([])
    vi.mocked(getPeptides).mockReset().mockResolvedValue([])
    vi.mocked(getMethodAttachments).mockReset().mockResolvedValue([])
    vi.mocked(getMethodConsumables).mockReset().mockResolvedValue([])
    vi.mocked(listConsumables).mockReset().mockResolvedValue([])
    vi.mocked(listConsumableKinds).mockReset().mockResolvedValue([KIND])
  })

  it('shows both sections on a method that covers an endotoxin service', async () => {
    vi.mocked(getMethodServices).mockReset().mockResolvedValue([
      { analysis_service_id: 5, keyword: 'ENDO-LAL', title: 'Endotoxin', is_default: true },
    ])
    render(<MethodPanel method={method()} onUpdated={vi.fn()} />)
    expect(await screen.findByText('Run parameters (endotoxin)')).toBeInTheDocument()
    expect(screen.getByText(/^Consumables \(/)).toBeInTheDocument()
  })

  it('leaves other methods as they are', async () => {
    vi.mocked(getMethodServices).mockReset().mockResolvedValue([
      { analysis_service_id: 6, keyword: 'PUR-HPLC', title: 'Purity', is_default: true },
    ])
    render(<MethodPanel method={method({ name: 'HPLC purity' })} onUpdated={vi.fn()} />)
    expect(await screen.findByText('PUR-HPLC')).toBeInTheDocument()
    expect(screen.queryByText('Run parameters (endotoxin)')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/test/method-endo-sections.test.tsx`
Expected: FAIL with `Failed to resolve import "@/components/hplc/MethodConsumablesSection"`.

- [ ] **Step 3: Create `src/components/hplc/MethodConsumablesSection.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Loader2, Lock, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import {
  getMethodConsumables,
  listConsumableKinds,
  listConsumables,
  putMethodConsumables,
  type ConsumableKind,
  type ConsumableType,
  type HplcMethod,
  type MethodConsumableLink,
} from '@/lib/api'

type LinkWire = { consumable_type_id: number; is_default: boolean }

const wire = (l: MethodConsumableLink): LinkWire => ({
  consumable_type_id: l.consumable_type_id,
  is_default: l.is_default,
})

/** "0.05 EU/mL": a type's numbers as its kind labels them. */
function specText(kind: ConsumableKind, c: ConsumableType | undefined): string {
  if (!c) return ''
  return kind.specs
    .map(s => {
      const v = c.specs[s.key]
      return v == null ? '' : `${v}${s.unit ? ` ${s.unit}` : ''}`
    })
    .filter(Boolean)
    .join(', ')
}

/**
 * The consumable types a method allows, per kind, with one default each
 * (spec 2026-10-10 3.3, 6.5). Editable on a draft only: an issued method's
 * list changes through a new revision, which copies it with its defaults.
 * Same replace-set idiom as Covered Services; names come from the catalog.
 */
export function MethodConsumablesSection({
  method,
  onUpdated,
}: {
  method: HplcMethod
  onUpdated: () => void
}) {
  const locked = method.status !== 'draft'
  const [links, setLinks] = useState<MethodConsumableLink[]>([])
  const [catalog, setCatalog] = useState<ConsumableType[]>([])
  const [kinds, setKinds] = useState<ConsumableKind[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getMethodConsumables(method.id).then(setLinks).catch(console.error)
    listConsumables().then(setCatalog).catch(console.error)
    listConsumableKinds().then(setKinds).catch(console.error)
  }, [method.id])

  async function save(next: LinkWire[]) {
    setBusy(true)
    try {
      setLinks(await putMethodConsumables(method.id, next))
      onUpdated()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to update consumables'
      )
    } finally {
      setBusy(false)
    }
  }

  const byId = new Map(catalog.map(c => [c.id, c]))

  return (
    <div className="border-t pt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-muted-foreground">
          Consumables ({links.length})
        </h4>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {locked && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" />
            Changes need a new revision
          </span>
        )}
      </div>
      {locked && links.length === 0 ? (
        <p className="text-sm text-muted-foreground">No consumables linked.</p>
      ) : (
        <div className="space-y-3">
          {kinds.map(kind => {
            const mine = links.filter(l => l.kind === kind.key)
            const addable = catalog.filter(
              c =>
                c.kind === kind.key &&
                c.active &&
                !links.some(l => l.consumable_type_id === c.id)
            )
            if (mine.length === 0 && (locked || addable.length === 0)) return null
            return (
              <div key={kind.key} className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  {kind.label}
                </div>
                {mine.map(link => {
                  const c = byId.get(link.consumable_type_id)
                  const name = c?.name ?? `#${link.consumable_type_id}`
                  return (
                    <div
                      key={link.consumable_type_id}
                      className="flex items-center gap-2 rounded-md border bg-muted/50 px-2.5 py-1.5 text-sm"
                    >
                      <span className="font-medium">{name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {specText(kind, c)}
                      </span>
                      {c && !c.active && (
                        <Badge variant="outline" className="text-xs">
                          Retired
                        </Badge>
                      )}
                      {locked ? (
                        link.is_default && (
                          <Badge variant="secondary" className="ml-auto text-xs">
                            Default
                          </Badge>
                        )
                      ) : (
                        <div className="ml-auto flex items-center gap-2">
                          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                            <input
                              type="radio"
                              name={`default-${kind.key}`}
                              aria-label={`Default: ${name}`}
                              checked={link.is_default}
                              disabled={busy}
                              onChange={() =>
                                save(
                                  links.map(l => ({
                                    consumable_type_id: l.consumable_type_id,
                                    is_default:
                                      l.kind === kind.key
                                        ? l.consumable_type_id ===
                                          link.consumable_type_id
                                        : l.is_default,
                                  }))
                                )
                              }
                            />
                            Default
                          </label>
                          <button
                            type="button"
                            aria-label={`Remove ${name}`}
                            title={`Remove ${name}`}
                            disabled={busy}
                            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                            onClick={() =>
                              save(
                                links
                                  .filter(
                                    l =>
                                      l.consumable_type_id !==
                                      link.consumable_type_id
                                  )
                                  .map(wire)
                              )
                            }
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
                {!locked && addable.length > 0 && (
                  <select
                    aria-label={`Add ${kind.label}`}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    defaultValue=""
                    disabled={busy}
                    onChange={e => {
                      const id = Number(e.target.value)
                      e.target.value = ''
                      // The first type of a kind becomes its default.
                      if (id)
                        save([
                          ...links.map(wire),
                          { consumable_type_id: id, is_default: mine.length === 0 },
                        ])
                    }}
                  >
                    <option value="" disabled>
                      Add {kind.label.toLowerCase()}...
                    </option>
                    {addable.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {specText(kind, c) ? ` (${specText(kind, c)})` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default MethodConsumablesSection
```

- [ ] **Step 4: Create `src/components/hplc/MethodRunParamsSection.tsx`**

```tsx
import { useState } from 'react'
import { Loader2, Lock, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { updateMethod, type EndoRunParamsWire, type HplcMethod } from '@/lib/api'
import { ENDO_RUN_PARAM_DEFAULTS, type EndoRunParams } from '@/lib/endo-prep-2ml'

const FIELDS: {
  key: keyof EndoRunParamsWire
  label: string
  unit: string
  standard: keyof EndoRunParams
}[] = [
  { key: 'std_total_dilution', label: 'Standard total dilution', unit: '1:N', standard: 'stdTotalDilution' },
  { key: 'recon_water_ml', label: 'Reconstitution water', unit: 'mL', standard: 'reconWaterMl' },
  { key: 'spike_recovery_min_pct', label: 'Spike recovery min', unit: '%', standard: 'spikeRecoveryMinPct' },
  { key: 'spike_recovery_max_pct', label: 'Spike recovery max', unit: '%', standard: 'spikeRecoveryMaxPct' },
  { key: 'cv_limit_pct', label: 'CV limit', unit: '%', standard: 'cvLimitPct' },
]

/**
 * The endotoxin run parameters a method fixes (spec 2026-10-10 3.4, 6.5):
 * the standard total dilution, the reconstitution water, the spike recovery
 * range and the CV limit. A blank field uses Dennis's value, shown as its
 * placeholder. Draft only: worksheets pin a method revision, so an issued
 * method's numbers never move under a run. The server validates the rest
 * (min below max, total at least 20) and its reason is shown as it comes.
 */
export function MethodRunParamsSection({
  method,
  onUpdated,
}: {
  method: HplcMethod
  onUpdated: () => void
}) {
  const locked = method.status !== 'draft'
  const saved: Partial<EndoRunParamsWire> = method.run_parameters?.endotoxin ?? {}
  const savedText = (key: keyof EndoRunParamsWire) => {
    const v = saved[key]
    return v == null ? '' : String(v)
  }
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map(f => [f.key, savedText(f.key)]))
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = FIELDS.some(f => (draft[f.key] ?? '').trim() !== savedText(f.key))

  async function handleSave() {
    const endotoxin: Partial<EndoRunParamsWire> = {}
    for (const f of FIELDS) {
      const text = (draft[f.key] ?? '').trim()
      if (!text) continue
      const n = Number(text)
      if (!Number.isFinite(n) || n <= 0) {
        setError(`${f.label} must be a number above zero`)
        return
      }
      endotoxin[f.key] = n
    }
    setSaving(true)
    setError(null)
    try {
      await updateMethod(method.id, {
        run_parameters: Object.keys(endotoxin).length ? { endotoxin } : null,
      })
      onUpdated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save run parameters')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-t pt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-muted-foreground">
          Run parameters (endotoxin)
        </h4>
        {locked ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" />
            Changes need a new revision
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={handleSave}
            disabled={saving || !dirty}
          >
            {saving ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1 h-3.5 w-3.5" />
            )}
            Save run parameters
          </Button>
        )}
      </div>
      {error && (
        <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {FIELDS.map(f => (
          <div key={f.key} className="space-y-1 text-sm">
            <div className="font-medium text-muted-foreground">
              {f.label} <span className="font-normal">({f.unit})</span>
            </div>
            <Input
              inputMode="decimal"
              aria-label={`${f.label} (${f.unit})`}
              placeholder={String(ENDO_RUN_PARAM_DEFAULTS[f.standard])}
              value={draft[f.key] ?? ''}
              disabled={locked}
              className="h-8 font-mono"
              onChange={e => setDraft({ ...draft, [f.key]: e.target.value })}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

export default MethodRunParamsSection
```

- [ ] **Step 5: Mount both in `src/components/hplc/MethodPanel.tsx`**

5a. After the existing `import { useUIStore } from '@/store/ui-store'` add:

```ts
import { MethodConsumablesSection } from './MethodConsumablesSection'
import { MethodRunParamsSection } from './MethodRunParamsSection'
```

5b. Directly after `const locked = method.status !== 'draft'` add:

```ts
  // Endotoxin methods carry the consumables and run-parameter sections (spec
  // 2026-10-10 6.5): a method covering an ENDO service (the spec 6.7 rule),
  // or one that already holds endotoxin run parameters.
  const isEndoMethod =
    services.some(s => /ENDO/i.test(s.keyword ?? '')) ||
    method.run_parameters?.endotoxin != null
```

5c. Directly before the line `      {/* Revision history section */}` add:

```tsx
      {isEndoMethod && (
        <>
          <MethodConsumablesSection method={method} onUpdated={onUpdated} />
          <MethodRunParamsSection method={method} onUpdated={onUpdated} />
        </>
      )}
```

- [ ] **Step 6: Run the method tests (new and existing)**

Run: `npx vitest run src/test/method-endo-sections.test.tsx src/test/method-lifecycle-ui.test.tsx src/test/methods-catalog-fields.test.tsx src/test/methods-guide-ui.test.tsx`
Expected: PASS. The existing suites mock `getMethodServices` to `[]`, so neither section mounts there and nothing new is fetched.

- [ ] **Step 7: Write the failing instrument serial test**

Create `src/test/instruments-serial.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Instrument } from '@/lib/api'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getInstruments: vi.fn(),
    getMethods: vi.fn(),
    createInstrument: vi.fn(),
    updateInstrument: vi.fn(),
    getDepartments: vi.fn(),
  }
})

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import {
  createInstrument,
  getDepartments,
  getInstruments,
  getMethods,
  updateInstrument,
} from '@/lib/api'
import { InstrumentsPage } from '@/components/hplc/InstrumentsPage'

// The reader import stamps the instrument by the serial in the reader's
// export (spec 2026-10-10 3.5, 4.5), so the serial is set here.

const READER: Instrument = {
  id: 1,
  name: 'Nexgen-MCS',
  senaite_id: null,
  senaite_uid: null,
  instrument_type: 'Endotoxin reader',
  brand: null,
  model: null,
  active: true,
  department_id: null,
  origin: 'mk1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  serial_number: 'NX-1001',
}

describe('InstrumentsPage serial number', () => {
  beforeEach(() => {
    vi.mocked(getInstruments).mockReset().mockResolvedValue([READER])
    vi.mocked(getMethods).mockReset().mockResolvedValue([])
    vi.mocked(getDepartments).mockReset().mockResolvedValue([])
    vi.mocked(createInstrument).mockReset().mockResolvedValue(READER)
    vi.mocked(updateInstrument).mockReset().mockResolvedValue(READER)
  })

  it('shows the serial in the table and saves an edit', async () => {
    const user = userEvent.setup()
    render(<InstrumentsPage />)
    expect(await screen.findByText('NX-1001')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Serial' })).toBeInTheDocument()

    await user.click(screen.getByText('Nexgen-MCS'))
    await user.click(screen.getByRole('button', { name: /^edit$/i }))
    const serial = screen.getByLabelText('Serial number')
    await user.clear(serial)
    await user.type(serial, 'NX-2002')
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(updateInstrument).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ serial_number: 'NX-2002' })
      )
    )
  })

  it('creates an instrument with its serial', async () => {
    const user = userEvent.setup()
    render(<InstrumentsPage />)
    await user.click(await screen.findByRole('button', { name: /add instrument/i }))
    await user.type(screen.getByLabelText(/name/i), 'Second reader')
    await user.type(screen.getByLabelText('Serial number'), 'NX-3003')
    await user.click(screen.getByRole('button', { name: /^create$/i }))
    await waitFor(() =>
      expect(createInstrument).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Second reader', serial_number: 'NX-3003' })
      )
    )
  })
})
```

- [ ] **Step 8: Run it and watch it fail**

Run: `npx vitest run src/test/instruments-serial.test.tsx`
Expected: FAIL: `Unable to find an element with the text: NX-1001` (no Serial column yet).

- [ ] **Step 9: Add the serial to `src/components/hplc/InstrumentsPage.tsx`**

9a. In `InstrumentsPage`'s search filter, add a line after `(i.model?.toLowerCase().includes(q) ?? false) ||`:

```ts
      (i.serial_number?.toLowerCase().includes(q) ?? false) ||
```

9b. In the table header, after `<TableHead>Model</TableHead>` add `<TableHead>Serial</TableHead>`. Change both `<TableCell colSpan={7}` to `<TableCell colSpan={8}`.

9c. In the row, directly before the cell that opens with `<TableCell>` followed by `<Badge variant="secondary">{methodCountFor(inst.id)}</Badge>`, add:

```tsx
                  <TableCell className="font-mono text-xs">
                    {inst.serial_number ?? '-'}
                  </TableCell>
```

9d. In `InstrumentPanel`:
- after `const [model, setModel] = useState(instrument.model ?? '')` add `const [serialNumber, setSerialNumber] = useState(instrument.serial_number ?? '')`;
- in `resetForm`, after `setModel(instrument.model ?? '')` add `setSerialNumber(instrument.serial_number ?? '')`;
- in `handleSave`'s `updateInstrument` body, after `model: model.trim() || null,` add `serial_number: serialNumber.trim() || null,`;
- in the edit form, directly after the `grid grid-cols-2 gap-4` block that holds Brand and Model (before the `<label className="flex items-center gap-2 text-sm cursor-pointer">` with the Active checkbox) add:

```tsx
          <div className="space-y-2">
            <Label htmlFor="inst-edit-serial">Serial number</Label>
            <Input
              id="inst-edit-serial"
              value={serialNumber}
              onChange={e => setSerialNumber(e.target.value)}
              placeholder="As the instrument and its exports show it"
              className="font-mono"
            />
          </div>
```

- in the read-only grid, after `<DetailRow label="Model" value={instrument.model} />` add `<DetailRow label="Serial number" value={instrument.serial_number ?? null} />`.

9e. In `AddInstrumentForm`:
- after `const [model, setModel] = useState('')` add `const [serialNumber, setSerialNumber] = useState('')`;
- in the `createInstrument` body, after `model: model.trim() || null,` add `serial_number: serialNumber.trim() || null,`;
- in the `grid gap-4 sm:grid-cols-3` block, after the Model field's `div` add:

```tsx
            <div className="space-y-2">
              <Label htmlFor="new-instrument-serial">Serial number</Label>
              <Input
                id="new-instrument-serial"
                value={serialNumber}
                onChange={e => setSerialNumber(e.target.value)}
                className="font-mono"
              />
            </div>
```

A duplicate serial comes back as 409 with the server's `detail`, which `createInstrument` / `updateInstrument` already throw and the panel already shows.

- [ ] **Step 10: Run every touched suite, typecheck, lint and format**

Run:
```bash
npx vitest run src/test/instruments-serial.test.tsx src/test/instruments-page-local.test.tsx src/test/method-endo-sections.test.tsx src/test/method-lifecycle-ui.test.tsx src/test/methods-catalog-fields.test.tsx src/test/methods-guide-ui.test.tsx
npx prettier --write src/components/hplc/MethodConsumablesSection.tsx src/components/hplc/MethodRunParamsSection.tsx src/components/hplc/MethodPanel.tsx src/components/hplc/InstrumentsPage.tsx src/test/method-endo-sections.test.tsx src/test/instruments-serial.test.tsx
npm run typecheck
npx eslint src/components/hplc/MethodConsumablesSection.tsx src/components/hplc/MethodRunParamsSection.tsx src/components/hplc/MethodPanel.tsx src/components/hplc/InstrumentsPage.tsx src/test/method-endo-sections.test.tsx src/test/instruments-serial.test.tsx --max-warnings 0
```
Expected: PASS everywhere; `instruments-page-local` still passes because its payload asserts use `expect.objectContaining` and `/name/i` does not match "Serial number".

- [ ] **Step 11: Commit**

```bash
git add src/components/hplc/MethodConsumablesSection.tsx src/components/hplc/MethodRunParamsSection.tsx src/test/method-endo-sections.test.tsx src/test/instruments-serial.test.tsx
git commit -m "feat(endo-v2): method consumables and run parameters sections, instrument serial" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/hplc/MethodConsumablesSection.tsx src/components/hplc/MethodRunParamsSection.tsx src/components/hplc/MethodPanel.tsx src/components/hplc/InstrumentsPage.tsx src/test/method-endo-sections.test.tsx src/test/instruments-serial.test.tsx
```

---

### Task 13: The endo worksheet page: route, glue, run header and Box 1 on 2 mL

**Files:**
- Modify: `src/store/ui-store.ts` (`HPLCAnalysisSubSection` gains `'worksheet'`; state `worksheetPageId`; action `navigateToWorksheet`; `navigateTo` clears the id).
- Modify: `src/lib/hash-navigation.ts` (`applyNavToStore`, `buildHash` and its parameter type, the `useHashNavigation` comparator).
- Create: `src/lib/endo-worksheet-2ml.ts` (the glue).
- Modify: `src/components/hplc/EndoWorksheetTable.tsx` (`EndoWorksheetTable` props `prepModel`, `twoMl`, `heading`, `metaExtra`; header, row and footer branches; new private `TwoMlPrepCells`; `Meta` exported; new exported type `EndoTwoMl`).
- Create: `src/components/hplc/endo/EndoBox.tsx` (`EndoBoxHead`, `EndoBox`, `EndoBoxProps`), `src/components/hplc/endo/EndoRunHeader.tsx` (`EndoRunHeader`), `src/components/hplc/endo/EndoWorksheetPage.tsx` (`EndoWorksheetPage`).
- Create: `src/lib/worksheet-notes.ts` (`parseWorksheetNotes`, `withNotesText`, lifted out of `WorksheetDrawer`).
- Modify: `src/components/hplc/WorksheetDrawer.tsx` (`WorksheetApplyBar` exported; new exported `CompleteWorksheetButton` replaces the inline complete dialog; the notes `useMemo` and `handleUpdateWorksheet` use the helpers). Output unchanged.
- Modify: `src/components/hplc/EndoWorksheetView.tsx` (`EndoWorksheetView` passes the four new table props through and renders `children` after Box 1). The flyout passes none of them and renders as today.
- Modify: `src/components/layout/MainWindowContent.tsx` (`'hplc-analysis'` case).
- Test: `src/lib/__tests__/hash-navigation-worksheet.test.ts`, `src/lib/__tests__/endo-worksheet-2ml.test.ts`, `src/components/hplc/__tests__/EndoWorksheetTable-2ml.test.tsx`, `src/components/hplc/__tests__/EndoRunHeader.test.tsx`, `src/lib/__tests__/worksheet-notes.test.ts` (all new).

**Interfaces:**
- Consumes: Task 8 (`ENDO_RUN_PARAM_DEFAULTS`, `BW_LAMBDA`, `BW_LIMIT_EU_PER_ML`, `BW_DILUTION`, `formOf`, `waterOf`, `prep2Check`, `EndoCheck`, `EndoCtx`, `EndoForm`, `EndoRunParams`, `EndoSample`, `EndoStepOverride`); Task 10 (`getWorksheet`, `listConsumables`, `ConsumableType`, `EndoMethodInfo`, `EndoRunParamsWire`, `WorksheetUpdate`, the new worksheet and item keys, `worksheetPageKey`, the hook's mutations); existing `endoIdentityFor`, `endoItemsInBenchOrder`, `worksheetKind`, `BenchRunLog`, `EndoWorksheetView`, `AddSamplesModal`, `useSlaForSubjects`, `worksheetItemSlaSubjects`, `useLabCalendar`.
- Produces (contract): `worksheetPageId`, `navigateToWorksheet(id)`, subsection `'worksheet'`, hash `#hplc-analysis/worksheet?id=N`; `endoCtxFor(ws, catalog?)`, `endoSampleFor(item, ws, catalog?)`, `runParamsFrom(method)`; `EndoWorksheetPage`, `EndoRunHeader`.
- Produces (additions, see Contract deviations): `WorksheetRow` (alias of `WorksheetListItem`), `EndoCartridgeOption`, `EndoCartridgeRef`, `EndoRow`, `allowedCartridges`, `runCartridgeFor`, `endoRowsFor`, `fmtConc`, `cartridgeNote`, `cartridgeTitle` in the glue; `EndoTwoMl` and `Meta` from `EndoWorksheetTable.tsx`; `EndoBox`, `EndoBoxHead`, `EndoBoxProps` from `endo/EndoBox.tsx`; `CompleteWorksheetButton`, `WorksheetApplyBar` from `WorksheetDrawer.tsx`; `parseWorksheetNotes`, `withNotesText`.
- Box 2 and Box 3 (Tasks 14 and 15) are not imported here: those files do not exist yet, and an import would break this task's own tests and typecheck. Each of those tasks mounts its box in `EndoWorksheetPage.tsx` as described in the page's mount comment and in Contract deviations.

#### Cycle 13.1: the route

- [ ] **Step 1: Write the failing store and hash test**

Create `src/lib/__tests__/hash-navigation-worksheet.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useUIStore } from '@/store/ui-store'
import { applyNavToStore, buildHash, parseNavHash } from '@/lib/hash-navigation'

function applyHash(hash: string) {
  const nav = parseNavHash(hash)
  if (!nav) throw new Error(`unparseable hash ${hash}`)
  applyNavToStore(nav)
}

const currentHash = () => buildHash(useUIStore.getState())

describe('the endo worksheet page in the hash', () => {
  beforeEach(() => {
    useUIStore.setState({
      activeSection: 'dashboard',
      activeSubSection: 'orders',
      worksheetPageId: null,
      worksheetDrawerOpen: false,
    })
  })

  it('parses ?id= into the store and builds it back', () => {
    applyHash('#hplc-analysis/worksheet?id=42')
    const s = useUIStore.getState()
    expect([s.activeSection, s.activeSubSection, s.worksheetPageId]).toEqual([
      'hplc-analysis',
      'worksheet',
      42,
    ])
    expect(currentHash()).toBe('#hplc-analysis/worksheet?id=42')
  })

  it('navigateToWorksheet closes the flyout and moves the hash', () => {
    useUIStore.setState({ worksheetDrawerOpen: true })
    useUIStore.getState().navigateToWorksheet(7)
    expect(useUIStore.getState().worksheetDrawerOpen).toBe(false)
    expect(currentHash()).toBe('#hplc-analysis/worksheet?id=7')
  })

  it('generic navigateTo clears the page id', () => {
    useUIStore.getState().navigateToWorksheet(7)
    useUIStore.getState().navigateTo('hplc-analysis', 'worksheets')
    expect(useUIStore.getState().worksheetPageId).toBeNull()
    expect(currentHash()).toBe('#hplc-analysis/worksheets')
  })

  it('a non-numeric id is a plain navigate, never NaN', () => {
    applyHash('#hplc-analysis/worksheet?id=abc')
    expect(useUIStore.getState().worksheetPageId).toBeNull()
    expect(currentHash()).toBe('#hplc-analysis/worksheet')
  })

  it('leaves the flyout deep link as it is', () => {
    applyHash('#hplc-analysis/worksheet-detail?id=9')
    expect(useUIStore.getState().worksheetDrawerOpen).toBe(true)
    expect(useUIStore.getState().worksheetPageId).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/__tests__/hash-navigation-worksheet.test.ts`
Expected: FAIL: `navigateToWorksheet is not a function`, and the first test sees `worksheetPageId` undefined and the hash `#hplc-analysis/worksheet`.

- [ ] **Step 3: Add the store state and action (`src/store/ui-store.ts`)**

3a. In `HPLCAnalysisSubSection`, replace

```ts
  | 'worksheet-detail'
export type WorksheetSubSection
```

with

```ts
  | 'worksheet-detail'
  | 'worksheet'
export type WorksheetSubSection
```

3b. In `interface UIState`, after `pendingBoardNode: string | null` add:

```ts
  // Endo worksheet page (#hplc-analysis/worksheet?id=N, spec 2026-10-10
  // 6.1). Sticky like documentViewerTargetId; generic navigateTo clears it.
  worksheetPageId: number | null
```

and after `navigateToDocumentSpace: (slug: string | null) => void` add:

```ts
  /** The endo worksheet page; closes the worksheet flyout. */
  navigateToWorksheet: (id: number) => void
```

3c. In the initial state, replace

```ts
      boardTargetSlug: null,
      pendingBoardNode: null,
      customerListPage: 0,
```

with

```ts
      boardTargetSlug: null,
      pendingBoardNode: null,
      worksheetPageId: null,
      customerListPage: 0,
```

3d. In `navigateTo`, replace

```ts
            boardTargetSlug: null,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateTo'
```

with

```ts
            boardTargetSlug: null,
            worksheetPageId: null,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateTo'
```

3e. Directly after the `navigateToDocument` action (after its closing `'navigateToDocument'\n        ),`) add:

```ts

      navigateToWorksheet: id =>
        set(
          state => ({
            activeSection: 'hplc-analysis',
            activeSubSection: 'worksheet',
            worksheetPageId: id,
            worksheetDrawerOpen: false,
            navigationKey: state.navigationKey + 1,
          }),
          undefined,
          'navigateToWorksheet'
        ),
```

- [ ] **Step 4: Add the hash branch (`src/lib/hash-navigation.ts`)**

4a. In the file's header comment list, after the `reports/documents` line add ` *  - hplc-analysis/worksheet       → worksheetPageId`.

4b. In `applyNavToStore`, replace

```ts
  } else if (subSection === 'worksheet-detail' && targetId) {
    store.openWorksheetDrawer(Number(targetId))
```

with

```ts
  } else if (
    subSection === 'worksheet' &&
    targetId &&
    !Number.isNaN(Number(targetId))
  ) {
    // The endo worksheet page; a non-numeric id falls through to a plain navigate.
    store.navigateToWorksheet(Number(targetId))
  } else if (subSection === 'worksheet-detail' && targetId) {
    store.openWorksheetDrawer(Number(targetId))
```

4c. In `buildHash`'s parameter type, after `boardTargetSlug: string | null` add `worksheetPageId: number | null`. At the end of the `if / else if` chain, replace the `boards/board` branch's last two lines

```ts
    hash += `?id=${encodeURIComponent(state.boardTargetSlug)}`
  }
```

with

```ts
    hash += `?id=${encodeURIComponent(state.boardTargetSlug)}`
  } else if (
    state.activeSubSection === 'worksheet' &&
    state.worksheetPageId != null
  ) {
    hash += `?id=${encodeURIComponent(String(state.worksheetPageId))}`
  }
```

4d. In `useHashNavigation`'s subscribe comparator, after `state.boardTargetSlug !== prev.boardTargetSlug` add ` ||\n        state.worksheetPageId !== prev.worksheetPageId`.

- [ ] **Step 5: Run the hash suites, format and typecheck**

Run:
```bash
npx vitest run src/lib/__tests__/hash-navigation-worksheet.test.ts src/lib/__tests__/hash-navigation.test.ts src/lib/__tests__/hash-navigation-flag.test.ts
npx prettier --write src/store/ui-store.ts src/lib/hash-navigation.ts src/lib/__tests__/hash-navigation-worksheet.test.ts
npm run typecheck
```
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/__tests__/hash-navigation-worksheet.test.ts
git commit -m "feat(endo-v2): worksheet page route and hash" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/store/ui-store.ts src/lib/hash-navigation.ts src/lib/__tests__/hash-navigation-worksheet.test.ts
```

#### Cycle 13.2: the glue

- [ ] **Step 7: Write the failing glue test**

Create `src/lib/__tests__/endo-worksheet-2ml.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type {
  ConsumableType,
  EndoMethodInfo,
  WorksheetListItem,
} from '@/lib/api'
import {
  ENDO_RUN_PARAM_DEFAULTS,
  formOf,
  type EndoCheck,
} from '@/lib/endo-prep-2ml'
import {
  allowedCartridges,
  cartridgeNote,
  endoCtxFor,
  endoRowsFor,
  endoSampleFor,
  runParamsFrom,
  type WorksheetItemRow,
} from '@/lib/endo-worksheet-2ml'

const METHOD: EndoMethodInfo = {
  id: 9,
  name: 'Endotoxin',
  revision: 3,
  status: 'active',
  run_parameters: { endotoxin: { std_total_dilution: 300 } },
  cartridges: [
    { id: 1, name: 'Endosafe 0.05', sensitivity_eu_ml: 0.05, is_default: true, active: true },
    { id: 2, name: 'Endosafe 0.01', sensitivity_eu_ml: 0.01, is_default: false, active: true },
    { id: 4, name: 'Endosafe old', sensitivity_eu_ml: 0.02, is_default: false, active: false },
  ],
}

function ws(over: Partial<WorksheetListItem> = {}): WorksheetListItem {
  return {
    id: 1,
    title: 'Endo 10/10/2026',
    status: 'open',
    items: [],
    endo_prep: '2ml',
    endo_method: METHOD,
    cartridge_type_id: null,
    cartridge_sensitivity_eu_ml: null,
    ...over,
  } as WorksheetListItem
}

function item(over: Partial<WorksheetItemRow> = {}): WorksheetItemRow {
  return {
    id: 10,
    sample_id: 'P-0001-S01',
    analyses: [],
    assignment_role: 'endo',
    sample_identity: 'BPC-157',
    declared_weight_mg: 10,
    ...over,
  } as WorksheetItemRow
}

const catalogType = (
  id: number,
  sensitivity: number,
  over: Partial<ConsumableType> = {}
): ConsumableType => ({
  id,
  kind: 'endo_cartridge',
  name: `Endosafe ${sensitivity}`,
  manufacturer: null,
  part_number: null,
  instrument_id: null,
  specs: { sensitivity_eu_ml: sensitivity },
  active: true,
  in_use: false,
  ...over,
})

describe('runParamsFrom', () => {
  it("falls back to Dennis's values with no method", () => {
    expect(runParamsFrom(null)).toEqual(ENDO_RUN_PARAM_DEFAULTS)
  })

  it('takes the keys the method sets and nothing else', () => {
    expect(runParamsFrom(METHOD)).toEqual({
      ...ENDO_RUN_PARAM_DEFAULTS,
      stdTotalDilution: 300,
    })
  })
})

describe('allowed cartridges', () => {
  it("are the method's active ones, least sensitive first", () => {
    expect(allowedCartridges(ws()).map(c => c.id)).toEqual([1, 2])
    expect(endoCtxFor(ws()).allowedLambdas).toEqual([0.05, 0.01])
  })

  it('with no method, are the active endo cartridges in the catalog', () => {
    const catalog = [
      catalogType(2, 0.01),
      catalogType(1, 0.05),
      catalogType(5, 0.1, { active: false }),
      catalogType(6, 0.5, { kind: 'pipette_tip' }),
    ]
    const noMethod = ws({ endo_method: null })
    expect(allowedCartridges(noMethod, catalog).map(c => c.id)).toEqual([1, 2])
    expect(endoCtxFor(noMethod, catalog).params).toEqual(ENDO_RUN_PARAM_DEFAULTS)
  })
})

describe('endoSampleFor', () => {
  it('leaves the form to the maths: bac water by Sample ID, else powder; prep_form wins', () => {
    expect(formOf(endoSampleFor(item({ sample_id: 'BW-0101' }), ws()))).toBe('bac')
    expect(formOf(endoSampleFor(item(), ws()))).toBe('powder')
    expect(
      formOf(endoSampleFor(item({ sample_id: 'BW-0101', prep_form: 'liquid' }), ws()))
    ).toBe('liquid')
  })

  it('a row takes the method default; bac water takes the allowed 0.01', () => {
    expect(endoSampleFor(item(), ws()).lambda).toBe(0.05)
    expect(endoSampleFor(item({ sample_id: 'BW-0101' }), ws()).lambda).toBe(0.01)
  })

  it('bac water with no 0.01 allowed falls back to the run cartridge', () => {
    const only05 = { ...METHOD, cartridges: METHOD.cartridges.filter(c => c.id === 1) }
    expect(
      endoSampleFor(item({ sample_id: 'BW-0101' }), ws({ endo_method: only05 })).lambda
    ).toBe(0.05)
  })

  it("the run's own pick beats the method default", () => {
    expect(
      endoSampleFor(item(), ws({ cartridge_type_id: 2, cartridge_sensitivity_eu_ml: 0.01 }))
        .lambda
    ).toBe(0.01)
  })

  it('a retired cartridge on a row keeps its serialized sensitivity', () => {
    expect(
      endoSampleFor(item({ cartridge_type_id: 4, cartridge_sensitivity_eu_ml: 0.02 }), ws())
        .lambda
    ).toBe(0.02)
  })

  it('no cartridge at all leaves lambda empty, so results do not compute', () => {
    expect(endoSampleFor(item(), ws({ endo_method: null })).lambda).toBeNull()
  })

  it('reads the weight override, the 2 mL inputs, the reading and the stored steps', () => {
    const s = endoSampleFor(
      item({
        prep_weight_mg: 12,
        prep_water_ml: 1.5,
        prep_total_dilution: 500,
        prep_steps: [[25, 8], null, [100]],
        result_reading: '<0.05',
      }),
      ws()
    )
    expect(s).toMatchObject({
      weightMg: 12,
      waterMl: 1.5,
      totalDilution: 500,
      reading: '<0.05',
      steps: [{ sampleUl: 25, ratio: 8 }, null, { sampleUl: 100 }],
    })
  })
})

describe('endoRowsFor', () => {
  it('numbers rows in the order given and carries the cartridge a reading saves with', () => {
    const rows = endoRowsFor(
      [item({ id: 11, sample_id: 'BW-0101' }), item({ id: 10 })],
      ws()
    )
    expect(rows.map(r => [r.n, r.item.id, r.cartridge?.id, r.inherited?.id])).toEqual([
      [1, 11, 2, 2],
      [2, 10, 1, 1],
    ])
  })
})

describe('cartridgeNote', () => {
  const check = (over: Partial<EndoCheck>): EndoCheck => ({
    lambda: null,
    water: null,
    dilution: null,
    loaded: null,
    mvd: null,
    mvc: null,
    valid: null,
    needs: null,
    floorShown: null,
    floorVial: null,
    failAt: null,
    lod: null,
    loqVial: null,
    loqMl: null,
    ...over,
  })

  it('says nothing when the prep reads the limit or has no cartridge', () => {
    expect(cartridgeNote(check({ lambda: 0.05, valid: true }), false)).toBeNull()
    expect(cartridgeNote(check({ valid: false }), false)).toBeNull()
  })

  it("names the loaded concentration, the MVC and the cartridge it needs, as Dennis's sheet does", () => {
    expect(
      cartridgeNote(
        check({ lambda: 0.05, valid: false, loaded: 0.0005, mvc: 0.14, needs: 0.005 }),
        false
      )
    ).toEqual({ text: '0.0005 mg/mL loaded < MVC 0.14 · needs 0.005', tone: 'warn' })
    expect(
      cartridgeNote(check({ lambda: 0.005, valid: false, loaded: 0.0005, mvc: 0.014 }), false)
    ).toEqual({ text: '0.0005 mg/mL loaded < MVC 0.014 · no valid cartridge', tone: 'crit' })
    expect(
      cartridgeNote(check({ lambda: 0.05, valid: false, floorShown: 1 }), true)
    ).toEqual({ text: 'floor 1 > 0.25 limit', tone: 'crit' })
  })
})
```

- [ ] **Step 8: Run it and watch it fail**

Run: `npx vitest run src/lib/__tests__/endo-worksheet-2ml.test.ts`
Expected: FAIL with `Failed to resolve import "@/lib/endo-worksheet-2ml"`.

- [ ] **Step 9: Create `src/lib/endo-worksheet-2ml.ts`**

```ts
/**
 * Glue between a worksheet as GET /worksheets/{id} serves it and the 2 mL
 * maths (src/lib/endo-prep-2ml.ts), resolved as spec 2026-10-10 sections 4.2
 * to 4.4 say: the run parameters, the allowed cartridges and each row's
 * sample with its cartridge. Pure, so the page, its three boxes and the paper
 * resolve the same cartridge and the same numbers.
 */
import type {
  ConsumableType,
  EndoMethodInfo,
  EndoRunParamsWire,
  WorksheetListItem,
} from '@/lib/api'
import { fmt } from '@/lib/endo-prep'
import {
  BW_LAMBDA,
  BW_LIMIT_EU_PER_ML,
  ENDO_RUN_PARAM_DEFAULTS,
  formOf,
  type EndoCheck,
  type EndoCtx,
  type EndoRunParams,
  type EndoSample,
  type EndoStepOverride,
} from '@/lib/endo-prep-2ml'
import { endoIdentityFor, type WorksheetItemRow } from '@/lib/endo-worksheet'

export type { WorksheetItemRow }
/** The contract's name for a worksheet as the API serves it. */
export type WorksheetRow = WorksheetListItem

/** A cartridge the run may use. */
export interface EndoCartridgeOption {
  id: number
  name: string
  sensitivity_eu_ml: number
  is_default: boolean
}

/** A resolved cartridge: its type and its sensitivity (lambda, EU/mL). */
export interface EndoCartridgeRef {
  id: number
  sensitivity: number
}

/** One endo row on the page, in Box 1 order. */
export interface EndoRow {
  item: WorksheetItemRow
  /** The Box 1 row number, 1-based. */
  n: number
  /** The row as the maths reads it; `sample.lambda` is `cartridge`'s. */
  sample: EndoSample
  /** The row's cartridge: its own pick, else `inherited`. Its id goes with
   *  every reading saved on the row (spec 9). */
  cartridge: EndoCartridgeRef | null
  /** What the row gets without a pick of its own: bac water's 0.01, else
   *  the run cartridge. */
  inherited: EndoCartridgeRef | null
}

const sameLambda = (a: number, b: number) => Math.abs(a - b) < 1e-9

/** The method's endotoxin run parameters, each falling back to Dennis's (4.4). */
export function runParamsFrom(method: EndoMethodInfo | null): EndoRunParams {
  const p: Partial<EndoRunParamsWire> = method?.run_parameters?.endotoxin ?? {}
  const d = ENDO_RUN_PARAM_DEFAULTS
  return {
    stdTotalDilution: p.std_total_dilution ?? d.stdTotalDilution,
    reconWaterMl: p.recon_water_ml ?? d.reconWaterMl,
    spikeRecoveryMinPct: p.spike_recovery_min_pct ?? d.spikeRecoveryMinPct,
    spikeRecoveryMaxPct: p.spike_recovery_max_pct ?? d.spikeRecoveryMaxPct,
    cvLimitPct: p.cv_limit_pct ?? d.cvLimitPct,
  }
}

/**
 * The allowed cartridges (4.3), least sensitive first: the method's active
 * ones; with no method, every active endo cartridge in `catalog`. Retired
 * types never appear here; a run or row that used one still resolves it from
 * its serialized sensitivity.
 */
export function allowedCartridges(
  ws: WorksheetRow,
  catalog: ConsumableType[] = []
): EndoCartridgeOption[] {
  const list: EndoCartridgeOption[] = ws.endo_method
    ? ws.endo_method.cartridges
        .filter(c => c.active)
        .map(c => ({
          id: c.id,
          name: c.name,
          sensitivity_eu_ml: c.sensitivity_eu_ml,
          is_default: c.is_default,
        }))
    : catalog
        .filter(c => c.kind === 'endo_cartridge' && c.active)
        .map(c => ({
          id: c.id,
          name: c.name,
          sensitivity_eu_ml: Number(c.specs.sensitivity_eu_ml),
          is_default: false,
        }))
  return list
    .filter(c => Number.isFinite(c.sensitivity_eu_ml) && c.sensitivity_eu_ml > 0)
    .sort((a, b) => b.sensitivity_eu_ml - a.sensitivity_eu_ml)
}

/** The maths' context for this worksheet (contract name). */
export function endoCtxFor(
  ws: WorksheetRow,
  catalog: ConsumableType[] = []
): EndoCtx {
  return {
    params: runParamsFrom(ws.endo_method ?? null),
    allowedLambdas: allowedCartridges(ws, catalog).map(c => c.sensitivity_eu_ml),
  }
}

/** A cartridge id as a reference: the allowed list's sensitivity, else the
 *  serialized one (a retired type, or one outside the list). */
function refFor(
  id: number,
  serialized: number | null | undefined,
  allowed: EndoCartridgeOption[]
): EndoCartridgeRef | null {
  const sensitivity =
    allowed.find(c => c.id === id)?.sensitivity_eu_ml ?? serialized ?? null
  return sensitivity == null ? null : { id, sensitivity }
}

/** The run cartridge (4.3): the worksheet's pick, else the method default, else none. */
export function runCartridgeFor(
  ws: WorksheetRow,
  catalog: ConsumableType[] = []
): EndoCartridgeRef | null {
  const allowed = allowedCartridges(ws, catalog)
  if (ws.cartridge_type_id != null)
    return refFor(ws.cartridge_type_id, ws.cartridge_sensitivity_eu_ml, allowed)
  const fallback = allowed.find(c => c.is_default)
  return fallback ? { id: fallback.id, sensitivity: fallback.sensitivity_eu_ml } : null
}

/** Stored steps ([[ul, ratio] | null, [ul] | null, [ul] | null]) as the maths' overrides. */
function stepsFrom(wire: WorksheetItemRow['prep_steps']): EndoSample['steps'] {
  if (!wire || wire.length !== 3) return null
  const step = (
    s: (number | null)[] | null | undefined,
    withRatio: boolean
  ): EndoStepOverride | null =>
    s
      ? withRatio
        ? { sampleUl: s[0] ?? null, ratio: s[1] ?? null }
        : { sampleUl: s[0] ?? null }
      : null
  return [step(wire[0], true), step(wire[1], false), step(wire[2], false)]
}

function resolveRow(
  item: WorksheetItemRow,
  ws: WorksheetRow,
  catalog: ConsumableType[]
): Pick<EndoRow, 'sample' | 'cartridge' | 'inherited'> {
  const allowed = allowedCartridges(ws, catalog)
  const base: EndoSample = {
    sampleId: item.sample_id,
    identity: endoIdentityFor(item),
    sampleType: item.sample_type ?? null,
    weightMg: item.prep_weight_mg ?? item.declared_weight_mg ?? null,
    form: item.prep_form ?? null,
    waterMl: item.prep_water_ml ?? null,
    totalDilution: item.prep_total_dilution ?? null,
    steps: stepsFrom(item.prep_steps),
    lambda: null,
    reading: item.result_reading ?? null,
    reader: item.result_reader ?? null,
  }
  // Bac water runs on the allowed 0.01 unless its row says otherwise
  // (Dennis, 2026-10-09; spec 4.3).
  const bacType =
    formOf(base) === 'bac'
      ? allowed.find(c => sameLambda(c.sensitivity_eu_ml, BW_LAMBDA))
      : undefined
  const inherited = bacType
    ? { id: bacType.id, sensitivity: bacType.sensitivity_eu_ml }
    : runCartridgeFor(ws, catalog)
  const cartridge =
    item.cartridge_type_id != null
      ? refFor(item.cartridge_type_id, item.cartridge_sensitivity_eu_ml, allowed)
      : inherited
  return {
    sample: { ...base, lambda: cartridge?.sensitivity ?? null },
    cartridge,
    inherited,
  }
}

/** The row as the 2 mL maths reads it (4.2, 4.3). `catalog` is the allowed
 *  list's source when no method resolves. */
export function endoSampleFor(
  item: WorksheetItemRow,
  ws: WorksheetRow,
  catalog: ConsumableType[] = []
): EndoSample {
  return resolveRow(item, ws, catalog).sample
}

/** The page's rows, numbered in the order given (Box 1's bench order). */
export function endoRowsFor(
  ordered: WorksheetItemRow[],
  ws: WorksheetRow,
  catalog: ConsumableType[] = []
): EndoRow[] {
  return ordered.map((item, i) => ({
    item,
    n: i + 1,
    ...resolveRow(item, ws, catalog),
  }))
}

/** Dennis's fmtConc lives with the maths (Task 8); re-exported here so the
 *  page imports every worksheet helper from one place. */
export { fmtConc } from '@/lib/endo-prep-2ml'

/** The line under Box 1's cartridge when the prep cannot read the limit
 *  (Dennis's cartridgeVerdict2): amber when another cartridge would do,
 *  red when none would. */
export function cartridgeNote(
  k: EndoCheck,
  bac: boolean
): { text: string; tone: 'warn' | 'crit' } | null {
  if (k.lambda == null || k.valid !== false) return null
  const why = bac
    ? `floor ${fmt(k.floorShown)} > ${fmt(BW_LIMIT_EU_PER_ML)} limit`
    : `${fmtConc(k.loaded)} mg/mL loaded < MVC ${fmtConc(k.mvc)}`
  if (k.needs != null) return { text: `${why} · needs ${fmt(k.needs)}`, tone: 'warn' }
  return { text: bac ? why : `${why} · no valid cartridge`, tone: 'crit' }
}

/** The cartridge cell's worked line on hover (Dennis's cartridgeTitle2). */
export function cartridgeTitle(k: EndoCheck, bac: boolean): string {
  if (bac) {
    const floor =
      k.floorShown != null
        ? ` · a clean run reads < ${fmt(k.floorShown)} (λ ${fmt(k.lod)} × ${fmt(k.dilution)})`
        : ''
    return `Bac water: ${fmt(k.dilution)}× into the cartridge · limit ${fmt(BW_LIMIT_EU_PER_ML)} EU/mL${floor}`
  }
  if (k.water == null) return ''
  if (k.dilution == null)
    return `${fmt(k.water)} mL in the vial · the dilution steps cannot be made as typed (see Sample dilution)`
  const parts = [
    `${fmt(k.water)} mL in the vial · 1:${fmt(k.dilution)} into the cartridge${
      k.mvd != null ? ` of 1:${fmt(k.mvd)} allowed` : ''
    }`,
  ]
  if (k.loaded != null) parts.push(`loaded ${fmtConc(k.loaded)} mg/mL`)
  if (k.floorShown != null)
    parts.push(
      `a clean run reads < ${fmt(k.floorShown)} on the MCS (< ${fmt(k.floorVial)} EU/vial)`
    )
  if (k.failAt != null) parts.push(`a reading above ${fmt(k.failAt)} fails`)
  return parts.join(' · ')
}
```

- [ ] **Step 10: Run the glue test, format and typecheck**

Run:
```bash
npx vitest run src/lib/__tests__/endo-worksheet-2ml.test.ts
npx prettier --write src/lib/endo-worksheet-2ml.ts src/lib/__tests__/endo-worksheet-2ml.test.ts
npm run typecheck
```
Expected: PASS (14 tests); typecheck clean.

- [ ] **Step 11: Commit**

```bash
git add src/lib/endo-worksheet-2ml.ts src/lib/__tests__/endo-worksheet-2ml.test.ts
git commit -m "feat(endo-v2): glue from the worksheet to the 2 mL maths" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/endo-worksheet-2ml.ts src/lib/__tests__/endo-worksheet-2ml.test.ts
```

#### Cycle 13.3: Box 1 on 2 mL

- [ ] **Step 12: Write the failing Box 1 test**

Create `src/components/hplc/__tests__/EndoWorksheetTable-2ml.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { WorksheetListItem } from '@/lib/api'
import { ENDO_RUN_PARAM_DEFAULTS } from '@/lib/endo-prep-2ml'
import type { EndoRow } from '@/lib/endo-worksheet-2ml'
import {
  EndoWorksheetTable,
  type EndoTwoMl,
} from '@/components/hplc/EndoWorksheetTable'

// The flag cell, the reassign menu and the SLA badge read live data, and the
// lab calendar is a query; none of them is under test here.
vi.mock('@/hooks/use-lab-calendar', () => ({
  useLabCalendar: () => ({ calendar: null, isLoading: false }),
}))
vi.mock('@/hooks/use-flags', async importOriginal => ({
  ...(await importOriginal<typeof import('@/hooks/use-flags')>()),
  useEntityFlags: () => ({ data: [] }),
}))
vi.mock('@/services/flag-types', async importOriginal => ({
  ...(await importOriginal<typeof import('@/services/flag-types')>()),
  useFlagTypesMap: () => ({}),
}))
vi.mock('@/components/flags/RaiseFlagButton', () => ({ RaiseFlagButton: () => null }))
vi.mock('@/components/hplc/ReassignButton', () => ({ ReassignButton: () => null }))
vi.mock('@/components/hplc/SlaAgeIndicator', () => ({ SlaAgeIndicator: () => null }))

type Item = WorksheetListItem['items'][number]

const ITEM = {
  id: 10,
  sample_id: 'P-0001-S01',
  sample_uid: 'mk1://endo-10',
  assignment_role: 'endo',
  analyses: [],
  priority: 'normal',
  prep_status: 'ready',
  date_received: null,
  declared_weight_mg: 10,
  sample_identity: 'BPC-157',
  client_order_number: 'WP-9001',
  lims_sub_sample_pk: 10,
} as unknown as Item

const ROW: EndoRow = {
  item: ITEM,
  n: 1,
  sample: {
    sampleId: 'P-0001-S01',
    identity: 'BPC-157',
    sampleType: null,
    weightMg: 10,
    form: null,
    waterMl: null,
    totalDilution: null,
    steps: null,
    lambda: 0.05,
    reading: null,
    reader: null,
  },
  cartridge: { id: 1, sensitivity: 0.05 },
  inherited: { id: 1, sensitivity: 0.05 },
}

const TWO_ML: EndoTwoMl = {
  rows: [ROW],
  ctx: { params: ENDO_RUN_PARAM_DEFAULTS, allowedLambdas: [0.05, 0.01] },
  cartridges: [
    { id: 1, name: 'Endosafe 0.05', sensitivity_eu_ml: 0.05, is_default: true },
    { id: 2, name: 'Endosafe 0.01', sensitivity_eu_ml: 0.01, is_default: false },
  ],
}

function renderTable(props: Partial<ComponentProps<typeof EndoWorksheetTable>> = {}) {
  return render(
    <EndoWorksheetTable
      items={[]}
      isCompleted={false}
      analyst={null}
      createdAt={null}
      users={[]}
      slaByKey={new Map()}
      slaLoading={false}
      slaError={false}
      otherWorksheets={[]}
      onRemove={vi.fn()}
      onReassign={vi.fn()}
      onUpdateItem={vi.fn()}
      onTickAll={vi.fn()}
      {...props}
    />
  )
}

const headers = () =>
  screen.getAllByRole('columnheader').map(th => th.textContent)

// Today's columns, verbatim: the flyout and every stock worksheet keep them.
const STOCK = [
  '', 'Received', 'DueSLA', 'Priority', 'Order #', 'Sample ID', 'Sample identity',
  'Targetmg/mL', 'Declared wtmg', 'Volume to addmL', 'Sample neededµL',
  'LAL neededµL', 'Vial conc.mg/mL', 'Status', 'Made', 'MCS', 'Flag', '',
]
// Spec 2026-10-10 6.1, Box 1 on a 2 mL run.
const TWO = [
  '', 'Received', 'DueSLA', 'Priority', 'Order #', 'Sample ID', 'Sample identity',
  'Declared wtmg', 'Form', 'WatermL', 'Vial conc.mg/mL', 'Cartridgeλ EU/mL',
  'Status', 'Made', 'MCS', 'Flag', '',
]

describe('Box 1 columns', () => {
  it("stock keeps today's columns, with or without 2 mL data passed", () => {
    const first = renderTable()
    expect(headers()).toEqual(STOCK)
    expect(screen.getByText(/Sample volume/)).toBeInTheDocument()
    first.unmount()
    renderTable({ twoMl: TWO_ML })
    expect(headers()).toEqual(STOCK)
  })

  it('2 mL swaps Target, Volume to add, Sample needed and LAL needed for Form, Water and Cartridge', () => {
    renderTable({ prepModel: '2ml', twoMl: TWO_ML })
    expect(headers()).toEqual(TWO)
    expect(screen.queryByText(/Sample volume/)).toBeNull()
  })
})

describe('Box 1 on a 2 mL row', () => {
  it('shows the form, the water, the vial concentration and the cartridge with MVD and MVC', () => {
    renderTable({ items: [ITEM], prepModel: '2ml', twoMl: TWO_ML })
    expect(
      (screen.getByLabelText('Form the vial arrived in') as HTMLSelectElement).value
    ).toBe('powder')
    expect((screen.getByLabelText('Water (mL)') as HTMLInputElement).value).toBe('2')
    expect(screen.getByText('5')).toBeInTheDocument() // 10 mg in 2 mL
    // Dennis's figures for 10 mg in 2 mL on the 0.05: MVD (350 / 2) / 0.05, MVC 0.05 x 10 / 350.
    expect(screen.getByText('MVD 3500× · MVC 0.0014')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'run (0.05)' })).toBeInTheDocument()
  })

  it('saves the form and the row cartridge through the item PATCH', () => {
    const onUpdateItem = vi.fn()
    renderTable({ items: [ITEM], prepModel: '2ml', twoMl: TWO_ML, onUpdateItem })
    fireEvent.change(screen.getByLabelText('Form the vial arrived in'), {
      target: { value: 'liquid' },
    })
    expect(onUpdateItem).toHaveBeenCalledWith(10, { prep_form: 'liquid' })
    fireEvent.change(screen.getByLabelText('Cartridge for this sample'), {
      target: { value: '2' },
    })
    expect(onUpdateItem).toHaveBeenCalledWith(10, { cartridge_type_id: 2 })
  })
})
```

The `µL` in `STOCK` is U+00B5 (MICRO SIGN), the character the table's source uses.

- [ ] **Step 13: Run it and watch it fail**

Run: `npx vitest run src/components/hplc/__tests__/EndoWorksheetTable-2ml.test.tsx`
Expected: FAIL. The first test passes (stock is today's output); the 2 mL tests fail because `prepModel` is ignored (`expected [ ..., 'Targetmg/mL', ... ] to deeply equal [ ..., 'Form', ... ]`, `Unable to find a label with the text of: Form the vial arrived in`). TypeScript errors on `EndoTwoMl` are not reported by vitest.

- [ ] **Step 14: Add the 2 mL branch to `src/components/hplc/EndoWorksheetTable.tsx`**

14a. After `import { ReassignButton } from '@/components/hplc/ReassignButton'` add:

```ts
import {
  BW_DILUTION,
  formOf,
  prep2Check,
  waterOf,
  type EndoCheck,
  type EndoCtx,
  type EndoForm,
} from '@/lib/endo-prep-2ml'
import {
  cartridgeNote,
  cartridgeTitle,
  fmtConc,
  type EndoCartridgeOption,
  type EndoRow,
} from '@/lib/endo-worksheet-2ml'
```

14b. Replace

```ts
  onTickAll: (data: { made?: boolean; ran?: boolean }) => void
}

const TH =
```

with

```ts
  onTickAll: (data: { made?: boolean; ran?: boolean }) => void
  /** 'stock' (the default) renders today's columns. '2ml' swaps Target,
   *  Volume to add, Sample needed and LAL needed for Form, Water and the
   *  Cartridge (spec 2026-10-10 6.1); it needs `twoMl`. */
  prepModel?: 'stock' | '2ml'
  twoMl?: EndoTwoMl
  /** The box title over the meta strip (the worksheet page). */
  heading?: ReactNode
  /** More cells at the end of the meta strip (the page's run settings). */
  metaExtra?: ReactNode
}

/** Box 1 on a 2 mL run: each row's resolved sample and cartridge, the run
 *  parameters and the allowed cartridges, all from the glue. */
export interface EndoTwoMl {
  rows: EndoRow[]
  ctx: EndoCtx
  cartridges: EndoCartridgeOption[]
}

const TH =
```

14c. In the function's parameter list, replace

```ts
  onUpdateItem,
  onTickAll,
}: EndoWorksheetTableProps) {
```

with

```ts
  onUpdateItem,
  onTickAll,
  prepModel = 'stock',
  twoMl,
  heading,
  metaExtra,
}: EndoWorksheetTableProps) {
```

14d. Directly after `const ordered = endoItemsInBenchOrder(items, dueAtByItemId, calendar)` add:

```ts
  // 2 mL runs (spec 2026-10-10 6.1): the page hands over each row's sample.
  const two = prepModel === '2ml' && twoMl ? twoMl : null
  const twoRows = new Map<number, EndoRow>(two?.rows.map(r => [r.item.id, r]))
```

14e. Directly after the card's opening `<div className="overflow-hidden rounded-[5px] border bg-card shadow-sm">` add a line `{heading}`. Inside the meta grid, after the closing `</Meta>` of the `Orders` cell, add a line `{metaExtra}`.

14f. In `<thead>`, replace everything between `<th className={TH}>Sample identity</th>` and `<th className={TH}>Status</th>` (the six cells Target to Vial conc.) with:

```tsx
              {two ? (
                <>
                  <th className={`${TH} text-right`}>
                    Declared wt<span className={UNIT}>mg</span>
                  </th>
                  <th className={TH}>Form</th>
                  <th className={`${TH} text-right`}>
                    Water<span className={UNIT}>mL</span>
                  </th>
                  <th className={`${TH} ${TH_CALC}`}>
                    Vial conc.<span className={UNIT}>mg/mL</span>
                  </th>
                  <th className={`${TH} ${TH_CALC} !text-left`}>
                    Cartridge<span className={UNIT}>λ EU/mL</span>
                  </th>
                </>
              ) : (
                <>
                  <th className={`${TH} text-right`}>
                    Target<span className={UNIT}>mg/mL</span>
                  </th>
                  <th className={`${TH} text-right`}>
                    Declared wt<span className={UNIT}>mg</span>
                  </th>
                  <th className={`${TH} text-right`}>
                    Volume to add<span className={UNIT}>mL</span>
                  </th>
                  <th className={`${TH} ${TH_CALC}`}>
                    Sample needed<span className={UNIT}>µL</span>
                  </th>
                  <th className={`${TH} ${TH_CALC}`}>
                    LAL needed<span className={UNIT}>µL</span>
                  </th>
                  <th className={`${TH} ${TH_CALC}`}>
                    Vial conc.<span className={UNIT}>mg/mL</span>
                  </th>
                </>
              )}
```

14g. In the row map, after `const { item, prep, received, due, skipped } = row` add:

```ts
              const r2 = twoRows.get(item.id)
              const k2 = two && r2 ? prep2Check(r2.sample, two.ctx) : null
              const note2 =
                k2 && r2 ? cartridgeNote(k2, formOf(r2.sample) === 'bac') : null
```

replace

```ts
              const edge =
                prep.warning === 'over_cartridge'
                  ? 'before:bg-red-500'
                  : prep.warning === 'no_diluent'
                    ? 'before:bg-amber-500'
                    : 'before:bg-transparent'
```

with

```ts
              // The row's edge: on 2 mL the cartridge verdict, on stock the prep warning.
              const tone = k2
                ? (note2?.tone ?? null)
                : prep.warning === 'over_cartridge'
                  ? 'crit'
                  : prep.warning === 'no_diluent'
                    ? 'warn'
                    : null
              const edge =
                tone === 'crit'
                  ? 'before:bg-red-500'
                  : tone === 'warn'
                    ? 'before:bg-amber-500'
                    : 'before:bg-transparent'
```

and in the row-number cell replace

```tsx
                    title={
                      prep.warning === 'over_cartridge'
                        ? 'The sample will not fit the 1000 µL cartridge'
                        : prep.warning === 'no_diluent'
                          ? 'No room left for LAL diluent'
                          : undefined
                    }
```

with

```tsx
                    title={
                      k2
                        ? note2?.text
                        : prep.warning === 'over_cartridge'
                          ? 'The sample will not fit the 1000 µL cartridge'
                          : prep.warning === 'no_diluent'
                            ? 'No room left for LAL diluent'
                            : undefined
                    }
```

14h. In `<tbody>`, the stock prep cells run from the first `{prep.isWater ? (` (directly after the Sample identity cell's `</td>`) down to the `</td>` that closes the Vial conc. cell (the one ending in `fmt(prep.vialConc)` / `)}`), directly before the `<td className={TD}>` that holds the status chip. Wrap that block, unchanged, as the `else` branch:

```tsx
                  {two && r2 && k2 ? (
                    <TwoMlPrepCells
                      row={r2}
                      check={k2}
                      note={note2}
                      ctx={two.ctx}
                      cartridges={two.cartridges}
                      isCompleted={isCompleted}
                      onUpdateItem={onUpdateItem}
                    />
                  ) : (
                    <>
                      {/* the existing stock block moves here verbatim, from
                          `{prep.isWater ? (` through the Vial conc. `</td>`;
                          delete this comment once it is in */}
                    </>
                  )}
```

14i. In the footer, replace

```tsx
        <Total label="Sample volume" value={fmtUl(sumSample)} unit="µL" />
        <Total label="LAL volume" value={fmtUl(sumLal)} unit="µL" />
```

with

```tsx
        {!two && (
          <>
            <Total label="Sample volume" value={fmtUl(sumSample)} unit="µL" />
            <Total label="LAL volume" value={fmtUl(sumLal)} unit="µL" />
          </>
        )}
```

(On 2 mL runs Dennis drops these totals with the Sample / LAL columns.)

14j. Change `function Meta({` to `export function Meta({` (the page's run header renders its cells with it).

14k. Directly before `export default EndoWorksheetTable` add:

```tsx
const FORMS: [EndoForm, string][] = [
  ['powder', 'Lyophilized'],
  ['liquid', 'Liquid (reconstituted)'],
  ['bac', 'Bacteriostatic water'],
]

// Dennis's select.form / select.cart: 12.5px, padding 3px 6px, radius 6px.
const CELL_SELECT =
  'rounded-md border bg-card px-1.5 py-[3px] text-[12.5px] text-foreground focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 disabled:cursor-default disabled:opacity-70'

/**
 * Box 1's 2 mL cells (spec 2026-10-10 6.1, Dennis's 2 mL sheet): the
 * declared weight, how the vial arrived, the water in it, the vial
 * concentration, and the cartridge with its MVD and MVC under it and, when
 * the prep cannot read the limit, why. Bacteriostatic water has no weight or
 * water of its own: it is its own 20x prep.
 */
function TwoMlPrepCells({
  row,
  check,
  note,
  ctx,
  cartridges,
  isCompleted,
  onUpdateItem,
}: {
  row: EndoRow
  check: EndoCheck
  note: { text: string; tone: 'warn' | 'crit' } | null
  ctx: EndoCtx
  cartridges: EndoCartridgeOption[]
  isCompleted: boolean
  onUpdateItem: (itemId: number, data: WorksheetItemPatch) => void
}) {
  const { item, sample } = row
  const form = formOf(sample)
  const bac = form === 'bac'
  const water = waterOf(sample, ctx)
  const own = item.cartridge_type_id ?? null
  const unlisted = own != null && !cartridges.some(c => c.id === own)
  return (
    <>
      <td className={`${TD} w-[92px] px-1 text-right`}>
        {!bac && (
          <PrepField
            bare
            label="Declared weight"
            unit="mg"
            value={sample.weightMg}
            overridden={item.prep_weight_mg != null}
            computed={item.declared_weight_mg ?? null}
            disabled={isCompleted}
            onCommit={v => onUpdateItem(item.id, { prep_weight_mg: v })}
          />
        )}
      </td>
      <td className={TD}>
        <select
          aria-label="Form the vial arrived in"
          title="How the vial arrived. Lyophilized: the standard water is added here. Liquid: the customer already added water; type theirs under Water. Bacteriostatic water: its own 20x prep."
          value={form}
          disabled={isCompleted}
          onChange={e =>
            onUpdateItem(item.id, { prep_form: e.target.value as EndoForm })
          }
          className={`${CELL_SELECT} ${form === 'liquid' ? 'border-teal-500/45 font-semibold text-teal-700 dark:text-teal-300' : ''}`}
        >
          {FORMS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </td>
      <td
        className={`${TD} w-[92px] px-1 text-right ${form === 'liquid' && water == null ? 'bg-amber-500/10' : ''}`}
        title={
          form === 'liquid'
            ? 'Arrived reconstituted: type the water the customer used, in mL. Nothing is added here.'
            : undefined
        }
      >
        {!bac && (
          <PrepField
            bare
            label="Water"
            unit="mL"
            value={water}
            overridden={item.prep_water_ml != null}
            computed={form === 'liquid' ? null : ctx.params.reconWaterMl}
            disabled={isCompleted}
            onCommit={v => onUpdateItem(item.id, { prep_water_ml: v })}
          />
        )}
      </td>
      <td className={TD_CALC}>
        {bac ? (
          <span className="inline-block rounded-[3px] bg-amber-500/15 px-1.5 py-px font-mono text-[10px] font-medium text-amber-700 dark:text-amber-300">
            {`${BW_DILUTION}× dilution`}
          </span>
        ) : (
          fmt(sample.weightMg != null && water ? sample.weightMg / water : null)
        )}
      </td>
      <td
        className={`${TD} whitespace-nowrap`}
        title={cartridgeTitle(check, bac) || undefined}
      >
        <select
          aria-label="Cartridge for this sample"
          value={own ?? ''}
          disabled={isCompleted}
          onChange={e =>
            onUpdateItem(item.id, {
              cartridge_type_id: e.target.value ? Number(e.target.value) : null,
            })
          }
          className={`${CELL_SELECT} font-mono ${own == null ? 'text-muted-foreground' : ''}`}
        >
          <option value="">
            {`${bac ? 'bac water' : 'run'} (${row.inherited ? fmt(row.inherited.sensitivity) : '-'})`}
          </option>
          {unlisted && (
            <option value={own ?? ''}>
              {`${fmt(item.cartridge_sensitivity_eu_ml)} (not in the list)`}
            </option>
          )}
          {cartridges.map(c => (
            <option key={c.id} value={c.id} title={c.name}>
              {fmt(c.sensitivity_eu_ml)}
            </option>
          ))}
        </select>
        {check.mvd != null && (
          <span className={SUBTIME}>
            {`MVD ${fmt(check.mvd)}× · MVC ${fmtConc(check.mvc)}`}
          </span>
        )}
        {note && (
          <span
            className={`mt-[3px] block max-w-[13em] whitespace-normal text-[11px] font-semibold leading-[1.3] ${note.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}
          >
            {note.text}
          </span>
        )}
      </td>
    </>
  )
}
```

`fmt` is already imported from `@/lib/endo-prep`, `PrepField`, `TD`, `TD_CALC`, `SUBTIME` and the `WorksheetItemPatch` type are already in the file.

- [ ] **Step 15: Run the Box 1 test and the suites that render the table's neighbours**

Run:
```bash
npx vitest run src/components/hplc/__tests__/EndoWorksheetTable-2ml.test.tsx src/components/hplc/__tests__/PcrSampleList.test.tsx src/components/hplc/__tests__/PrepField.test.tsx
npx prettier --write src/components/hplc/EndoWorksheetTable.tsx src/components/hplc/__tests__/EndoWorksheetTable-2ml.test.tsx
npm run typecheck
npx eslint src/components/hplc/EndoWorksheetTable.tsx src/components/hplc/__tests__/EndoWorksheetTable-2ml.test.tsx --max-warnings 0
```
Expected: PASS; typecheck and eslint clean.

- [ ] **Step 16: Commit**

```bash
git add src/components/hplc/__tests__/EndoWorksheetTable-2ml.test.tsx
git commit -m "feat(endo-v2): Box 1 columns for 2 mL runs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/hplc/EndoWorksheetTable.tsx src/components/hplc/__tests__/EndoWorksheetTable-2ml.test.tsx
```

#### Cycle 13.4: box chrome and the run header

- [ ] **Step 17: Write the failing run header test**

Create `src/components/hplc/__tests__/EndoRunHeader.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { EndoMethodInfo, WorksheetListItem } from '@/lib/api'
import { allowedCartridges } from '@/lib/endo-worksheet-2ml'
import { EndoRunHeader } from '@/components/hplc/endo/EndoRunHeader'

const METHOD: EndoMethodInfo = {
  id: 9,
  name: 'Endotoxin',
  revision: 3,
  status: 'active',
  run_parameters: null,
  cartridges: [
    { id: 1, name: 'Endosafe 0.05', sensitivity_eu_ml: 0.05, is_default: true, active: true },
    { id: 2, name: 'Endosafe 0.01', sensitivity_eu_ml: 0.01, is_default: false, active: true },
  ],
}

function renderHeader(over: Partial<WorksheetListItem> = {}, isCompleted = false) {
  const worksheet = {
    id: 5,
    title: 'Endo 10/10/2026',
    status: isCompleted ? 'completed' : 'open',
    items: [],
    endo_prep: '2ml',
    cartridge_type_id: null,
    cartridge_sensitivity_eu_ml: null,
    endo_method_id: null,
    endo_method: METHOD,
    ...over,
  } as WorksheetListItem
  const onUpdate = vi.fn()
  render(
    <div>
      <EndoRunHeader
        worksheet={worksheet}
        cartridges={allowedCartridges(worksheet)}
        isCompleted={isCompleted}
        onUpdate={onUpdate}
      />
    </div>
  )
  return onUpdate
}

const picker = () => screen.getByLabelText('Run cartridge') as HTMLSelectElement

describe('EndoRunHeader', () => {
  it('switches the prep with one worksheet PUT', () => {
    const onUpdate = renderHeader()
    fireEvent.change(screen.getByLabelText('Prep'), { target: { value: 'stock' } })
    expect(onUpdate).toHaveBeenCalledWith({ endo_prep: 'stock' })
  })

  it('offers the allowed cartridges under the method default and never saves on its own', () => {
    const onUpdate = renderHeader()
    expect(Array.from(picker().options).map(o => o.text)).toEqual([
      'Method default (0.05)',
      '0.05 EU/mL',
      '0.01 EU/mL',
    ])
    expect(picker().value).toBe('')
    expect(onUpdate).not.toHaveBeenCalled()
    fireEvent.change(picker(), { target: { value: '2' } })
    expect(onUpdate).toHaveBeenCalledWith({ cartridge_type_id: 2 })
  })

  it('going back to the method default clears the run pick', () => {
    const onUpdate = renderHeader({ cartridge_type_id: 2, cartridge_sensitivity_eu_ml: 0.01 })
    fireEvent.change(picker(), { target: { value: '' } })
    expect(onUpdate).toHaveBeenCalledWith({ cartridge_type_id: null })
  })

  it('keeps a retired run cartridge visible', () => {
    renderHeader({ cartridge_type_id: 4, cartridge_sensitivity_eu_ml: 0.02 })
    expect(picker().value).toBe('4')
    expect(screen.getByRole('option', { name: '0.02 EU/mL (not in the list)' })).toBeInTheDocument()
  })

  it('names the method revision the numbers come from', () => {
    renderHeader()
    expect(screen.getByText('Endotoxin rev 3')).toBeInTheDocument()
  })

  it('a stock run shows only the prep', () => {
    renderHeader({ endo_prep: 'stock' })
    expect((screen.getByLabelText('Prep') as HTMLSelectElement).value).toBe('stock')
    expect(screen.queryByLabelText('Run cartridge')).toBeNull()
  })

  it('a completed run cannot be changed', () => {
    renderHeader({}, true)
    expect(screen.getByLabelText('Prep')).toBeDisabled()
    expect(picker()).toBeDisabled()
  })
})
```

- [ ] **Step 18: Run it and watch it fail**

Run: `npx vitest run src/components/hplc/__tests__/EndoRunHeader.test.tsx`
Expected: FAIL with `Failed to resolve import "@/components/hplc/endo/EndoRunHeader"`.

- [ ] **Step 19: Create `src/components/hplc/endo/EndoBox.tsx`**

```tsx
import type { ReactNode } from 'react'
import type { WorksheetItemPatch, WorksheetListItem } from '@/lib/api'
import type { EndoCtx } from '@/lib/endo-prep-2ml'
import type { EndoCartridgeOption, EndoRow } from '@/lib/endo-worksheet-2ml'

/*
 * Dennis's numbered boxes, from his screen stylesheet (endotoxin.html at
 * 5ef2a62), mapped to Mk1 tokens so dark mode follows the app theme:
 *   .sheet         border:1px solid var(--line); border-radius:5px;
 *                  box-shadow:var(--shadow); overflow:hidden;
 *                  margin:0 24px 24px  (24px sides: the page column's px-6;
 *                  24px between boxes: EndoWorksheetView's children wrapper)
 *   .results-head  padding:12px 16px 10px; border-bottom:1px solid var(--line)
 *   .legend-title  padding:0 24px 8px; margin:0 0 3px; font-size:9.5px;
 *                  font-weight:600; letter-spacing:.13em; uppercase; muted
 *   .results-sub   font-size:12px; muted
 * Spec 6.8's "10pt / 14pt / 4px 14px 14px / 12px" are his print sheet and
 * his intake panel, not these boxes; the side-by-side check (Task 20) rules.
 */

/** A box's numbered title and caption ("1 · Sample intake"). */
export function EndoBoxHead({
  n,
  title,
  sub,
  children,
}: {
  n: number
  title: string
  sub?: ReactNode
  /** Extra header content, e.g. Box 3's reader drop zone (Task 16). */
  children?: ReactNode
}) {
  return (
    <div className="border-b px-4 pb-2.5 pt-3">
      <p className="mb-[3px] px-6 pb-2 text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
        {n} · {title}
      </p>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      {children}
    </div>
  )
}

/** A numbered box (Boxes 2 and 3). Box 1 is EndoWorksheetTable with `heading`. */
export function EndoBox({
  n,
  title,
  sub,
  actions,
  children,
}: {
  n: number
  title: string
  sub?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-[5px] border bg-card shadow-sm"
    >
      <EndoBoxHead n={n} title={title} sub={sub}>
        {actions}
      </EndoBoxHead>
      {children}
    </section>
  )
}

/** What the page hands Box 2 (EndoSampleDilutionBox, Task 14) and Box 3
 *  (EndoResultsBox, Task 15). */
export interface EndoBoxProps {
  worksheet: WorksheetListItem
  /** The endo rows in Box 1 order: `row.n` is the Box 1 row number,
   *  `row.cartridge` the row's resolved cartridge, whose id goes with every
   *  reading saved on a row without its own. */
  rows: EndoRow[]
  ctx: EndoCtx
  /** The allowed cartridges, least sensitive first. */
  cartridges: EndoCartridgeOption[]
  isCompleted: boolean
  onUpdateItem: (itemId: number, data: WorksheetItemPatch) => void
}
```

- [ ] **Step 20: Create `src/components/hplc/endo/EndoRunHeader.tsx`**

```tsx
import type { WorksheetListItem, WorksheetUpdate } from '@/lib/api'
import { fmt } from '@/lib/endo-prep'
import type { EndoCartridgeOption } from '@/lib/endo-worksheet-2ml'
import { Meta } from '@/components/hplc/EndoWorksheetTable'

// Dennis's .meta select: borderless, 13px mono, an accent underline on focus.
const META_SELECT =
  'h-6 w-full min-w-0 cursor-pointer border-0 bg-transparent p-0 font-mono text-[13px] font-medium text-foreground focus:outline-none focus-visible:shadow-[0_1px_0_var(--color-teal-500)] disabled:cursor-default disabled:opacity-70'

/**
 * The run's settings, as cells of Box 1's meta strip where Dennis keeps Prep
 * and Cartridge (spec 2026-10-10 6.1): the prep model, the run cartridge from
 * the allowed list (blank = the method default, which is never written on its
 * own) and the method revision the numbers come from. Each change is one
 * worksheet PUT. The title, analyst, dates, orders and Preview / Print / CSV
 * stay where they are on every endo worksheet: EndoWorksheetView's top bar
 * and the meta strip's first cells.
 */
export function EndoRunHeader({
  worksheet,
  cartridges,
  isCompleted,
  onUpdate,
}: {
  worksheet: WorksheetListItem
  /** The allowed cartridges (allowedCartridges). */
  cartridges: EndoCartridgeOption[]
  isCompleted: boolean
  onUpdate: (data: WorksheetUpdate) => void
}) {
  const twoMl = worksheet.endo_prep === '2ml'
  const method = worksheet.endo_method ?? null
  const current = worksheet.cartridge_type_id ?? null
  const fallback = cartridges.find(c => c.is_default) ?? null
  // A retired or no-longer-allowed run cartridge stays visible, never offered.
  const unlisted = current != null && !cartridges.some(c => c.id === current)
  return (
    <>
      <Meta label="Prep">
        <select
          aria-label="Prep"
          className={META_SELECT}
          value={twoMl ? '2ml' : 'stock'}
          disabled={isCompleted}
          title="2 mL in the vial, then three dilution steps into the cartridge. 1 mg/mL stock is the old prep: switch back only for a run made that way."
          onChange={e =>
            onUpdate({ endo_prep: e.target.value === '2ml' ? '2ml' : 'stock' })
          }
        >
          <option value="2ml">2 mL</option>
          <option value="stock">1 mg/mL stock</option>
        </select>
      </Meta>
      {twoMl && (
        <>
          <Meta
            label="Cartridge"
            title="The run's cartridge; a row can take its own in the table"
          >
            <select
              aria-label="Run cartridge"
              className={META_SELECT}
              value={current ?? ''}
              disabled={isCompleted}
              onChange={e =>
                onUpdate({
                  cartridge_type_id: e.target.value ? Number(e.target.value) : null,
                })
              }
            >
              <option value="">
                {fallback
                  ? `Method default (${fmt(fallback.sensitivity_eu_ml)})`
                  : 'None picked'}
              </option>
              {unlisted && (
                <option value={current ?? ''}>
                  {`${fmt(worksheet.cartridge_sensitivity_eu_ml)} EU/mL (not in the list)`}
                </option>
              )}
              {cartridges.map(c => (
                <option key={c.id} value={c.id} title={c.name}>
                  {`${fmt(c.sensitivity_eu_ml)} EU/mL`}
                </option>
              ))}
            </select>
          </Meta>
          <Meta
            label="Method"
            title={
              method
                ? worksheet.endo_method_id
                  ? 'Pinned at the first print or reading: later revisions do not change this run'
                  : 'The active method; it is pinned at the first print or reading'
                : "No single method resolves: Dennis's standard values apply"
            }
          >
            <span className="block truncate text-sm font-medium">
              {method ? `${method.name} rev ${method.revision}` : 'Standard values'}
            </span>
          </Meta>
        </>
      )}
    </>
  )
}

export default EndoRunHeader
```

- [ ] **Step 21: Run the run header test, format and typecheck**

Run:
```bash
npx vitest run src/components/hplc/__tests__/EndoRunHeader.test.tsx
npx prettier --write src/components/hplc/endo/EndoBox.tsx src/components/hplc/endo/EndoRunHeader.tsx src/components/hplc/__tests__/EndoRunHeader.test.tsx
npm run typecheck
```
Expected: PASS (7 tests); typecheck clean.

- [ ] **Step 22: Commit**

```bash
git add src/components/hplc/endo/EndoBox.tsx src/components/hplc/endo/EndoRunHeader.tsx src/components/hplc/__tests__/EndoRunHeader.test.tsx
git commit -m "feat(endo-v2): numbered box chrome and the run header (prep, cartridge, method)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/hplc/endo/EndoBox.tsx src/components/hplc/endo/EndoRunHeader.tsx src/components/hplc/__tests__/EndoRunHeader.test.tsx
```

#### Cycle 13.5: the page

The page is the endo worksheet's editor from now on (Task 17 makes the flyout read-only), so it carries everything the flyout's endo view does today: rename, analyst, Preview / Print / CSV, Complete, Add samples, the method and instrument apply bar, ticks, remove and reassign, notes. It reuses `EndoWorksheetView` for all of that; the pieces `WorksheetDrawer` keeps inline (the notes JSON, the complete dialog, the apply bar) are lifted out so both use one copy.

- [ ] **Step 23: Write the failing notes helper test**

Create `src/lib/__tests__/worksheet-notes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseWorksheetNotes, withNotesText } from '@/lib/worksheet-notes'

describe('worksheet notes', () => {
  it('reads plain text as the analyst text', () => {
    expect(parseWorksheetNotes('plain')).toEqual({
      userNotes: 'plain',
      prepStartedItems: new Set(),
    })
  })

  it('reads the text and the prep-started markers out of the JSON', () => {
    const raw = JSON.stringify({ text: 'hi', 'prep_started:abc': true })
    expect(parseWorksheetNotes(raw)).toEqual({
      userNotes: 'hi',
      prepStartedItems: new Set(['abc']),
    })
  })

  it('replaces the text and keeps every marker', () => {
    const raw = JSON.stringify({ 'prep_started:abc': true, text: 'old' })
    expect(JSON.parse(withNotesText(raw, 'new'))).toEqual({
      'prep_started:abc': true,
      text: 'new',
    })
    expect(JSON.parse(withNotesText('old plain text', 'new'))).toEqual({ text: 'new' })
  })
})
```

- [ ] **Step 24: Run it and watch it fail**

Run: `npx vitest run src/lib/__tests__/worksheet-notes.test.ts`
Expected: FAIL with `Failed to resolve import "@/lib/worksheet-notes"`.

- [ ] **Step 25: Create `src/lib/worksheet-notes.ts`**

```ts
/**
 * A worksheet's `notes` column holds JSON: the analyst's text under `text`
 * and `prep_started:<key>` markers. Plain text from before that is read as
 * the analyst's text. Lifted out of WorksheetDrawer unchanged so the flyout
 * and the endo worksheet page edit notes the same way.
 */
export function parseWorksheetNotes(raw: string): {
  userNotes: string
  prepStartedItems: Set<string>
} {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Plain text notes (not JSON): treat as user text
    return { userNotes: raw, prepStartedItems: new Set<string>() }
  }
  const set = new Set<string>()
  for (const key of Object.keys(parsed)) {
    if (key.startsWith('prep_started:')) {
      set.add(key.replace('prep_started:', ''))
    }
  }
  const text = typeof parsed.text === 'string' ? parsed.text : ''
  return { userNotes: text, prepStartedItems: set }
}

/** The notes JSON with the analyst's text replaced and every marker kept. */
export function withNotesText(raw: string, text: string): string {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = {}
  }
  parsed.text = text
  return JSON.stringify(parsed)
}
```

- [ ] **Step 26: Share the drawer's pieces (`src/components/hplc/WorksheetDrawer.tsx`)**

26a. After `import { prepStartedKey } from '@/lib/worksheet-scope-key'` add:

```ts
import { parseWorksheetNotes, withNotesText } from '@/lib/worksheet-notes'
```

26b. Replace the whole `useMemo` that starts at the comment `// Parse notes JSON: separate user text from prep_started metadata` and ends at `}, [activeWorksheet?.notes])` with:

```ts
  // Parse notes JSON: separate user text from prep_started metadata
  const { userNotes, prepStartedItems } = useMemo(
    () => parseWorksheetNotes(activeWorksheet?.notes ?? ''),
    [activeWorksheet?.notes]
  )
```

26c. In `handleUpdateWorksheet`, replace

```ts
    if (data.notes !== undefined) {
      const raw = activeWorksheet.notes ?? ''
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = {}
      }
      parsed.text = data.notes
      data = { ...data, notes: JSON.stringify(parsed) }
    }
```

with

```ts
    if (data.notes !== undefined) {
      data = {
        ...data,
        notes: withNotesText(activeWorksheet.notes ?? '', data.notes),
      }
    }
```

26d. Replace the whole `const completeAction = activeWorksheet && ( <AlertDialog> ... </AlertDialog> )` block with:

```tsx
  const completeAction = activeWorksheet && (
    <CompleteWorksheetButton
      onConfirm={() => completeMutation.mutate(activeWorksheet.id)}
    />
  )
```

26e. Change `function WorksheetApplyBar({` to `export function WorksheetApplyBar({`, and directly above the comment `/** Method + instrument "run context" picker for the worksheet drawer's` add:

```tsx
/** "Complete Worksheet" with its confirmation; the flyout and the endo
 *  worksheet page share it. */
export function CompleteWorksheetButton({ onConfirm }: { onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">
          Complete Worksheet
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Complete this worksheet?</AlertDialogTitle>
          <AlertDialogDescription>
            This worksheet will be marked as completed and removed from the active
            queue. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep Worksheet</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Complete Worksheet
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

```

The dialog's markup and text are the ones the inline block had.

- [ ] **Step 27: Let `EndoWorksheetView` carry the page's extras (`src/components/hplc/EndoWorksheetView.tsx`)**

27a. Replace `import { EndoCalculations, EndoWorksheetTable } from './EndoWorksheetTable'` with:

```ts
import {
  EndoCalculations,
  EndoWorksheetTable,
  type EndoTwoMl,
} from './EndoWorksheetTable'
```

27b. In the destructured parameters, replace

```ts
  onUpdateItem,
  onTickAll,
}: {
```

with

```ts
  onUpdateItem,
  onTickAll,
  prepModel,
  twoMl,
  heading,
  runHeader,
  children,
}: {
```

27c. In the props type, replace

```ts
  onUpdateItem: (itemId: number, data: WorksheetItemPatch) => void
  onTickAll: (data: { made?: boolean; ran?: boolean }) => void
}) {
```

with

```ts
  onUpdateItem: (itemId: number, data: WorksheetItemPatch) => void
  onTickAll: (data: { made?: boolean; ran?: boolean }) => void
  /** The worksheet page (spec 2026-10-10 6.1): the prep model and its 2 mL
   *  data, Box 1's title, the run settings for the meta strip, and Boxes 2
   *  and 3 as children. The flyout passes none and renders as before. */
  prepModel?: 'stock' | '2ml'
  twoMl?: EndoTwoMl
  heading?: ReactNode
  runHeader?: ReactNode
  children?: ReactNode
}) {
```

27d. Replace

```tsx
        onUpdateItem={onUpdateItem}
        onTickAll={onTickAll}
      />

      <EndoCalculations />
```

with

```tsx
        onUpdateItem={onUpdateItem}
        onTickAll={onTickAll}
        prepModel={prepModel}
        twoMl={twoMl}
        heading={heading}
        metaExtra={runHeader}
      />

      {/* Boxes 2 and 3; with the column's 16px gap, 24px between boxes as on Dennis's sheet */}
      {children && <div className="space-y-6 pt-2">{children}</div>}

      <EndoCalculations />
```

- [ ] **Step 28: Create `src/components/hplc/endo/EndoWorksheetPage.tsx`**

```tsx
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  getInstruments,
  getMethods,
  getWorksheet,
  getWorksheetUsers,
  listConsumables,
  type WorksheetItemPatch,
  type WorksheetListItem,
  type WorksheetUpdate,
} from '@/lib/api'
import { useUIStore } from '@/store/ui-store'
import {
  useWorksheetDrawer,
  worksheetPageKey,
} from '@/hooks/use-worksheet-drawer'
import { useLabCalendar } from '@/hooks/use-lab-calendar'
import { useSlaForSubjects } from '@/services/sla-subjects'
import { worksheetItemSlaSubjects } from '@/lib/worksheet-sla-subjects'
import { endoItemsInBenchOrder } from '@/lib/endo-worksheet'
import {
  allowedCartridges,
  endoCtxFor,
  endoRowsFor,
} from '@/lib/endo-worksheet-2ml'
import { parseWorksheetNotes, withNotesText } from '@/lib/worksheet-notes'
import { worksheetKind } from '@/lib/worksheet-kind'
import AddSamplesModal from '@/components/hplc/AddSamplesModal'
import { BenchRunLog } from '@/components/hplc/BenchRunLog'
import { EndoWorksheetView } from '@/components/hplc/EndoWorksheetView'
import {
  CompleteWorksheetButton,
  WorksheetApplyBar,
} from '@/components/hplc/WorksheetDrawer'
import { EndoBoxHead } from './EndoBox'
import { EndoRunHeader } from './EndoRunHeader'

const FIVE_MINUTES = 5 * 60 * 1000

/**
 * The endotoxin worksheet as a page (#hplc-analysis/worksheet?id=N, spec
 * 2026-10-10 6.1): Dennis's run log as a left rail, then the run and its
 * numbered boxes. Reads GET /worksheets/{id}, the only read that carries the
 * worksheet's endo method. Only all-endo worksheets get the page in this
 * release; any other id offers the flyout.
 */
export function EndoWorksheetPage() {
  const worksheetId = useUIStore(state => state.worksheetPageId)
  const {
    data: worksheet,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: worksheetPageKey(worksheetId ?? 0),
    queryFn: () => getWorksheet(worksheetId ?? 0),
    enabled: worksheetId != null,
  })

  if (worksheetId == null) return <PageNotice>No worksheet picked.</PageNotice>
  if (isLoading)
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  if (isError || !worksheet)
    return (
      <PageNotice>
        Could not load worksheet {worksheetId}.
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Retry
        </Button>
      </PageNotice>
    )
  if (worksheetKind(worksheet.items) !== 'endo')
    return (
      <PageNotice>
        WS-{worksheet.id} is not an endotoxin worksheet; only those have a page
        for now.
        <Button
          variant="outline"
          size="sm"
          onClick={() => useUIStore.getState().openWorksheetDrawer(worksheet.id)}
        >
          Open in flyout
        </Button>
      </PageNotice>
    )
  return <EndoWorksheetPageBody worksheet={worksheet} />
}

function PageNotice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
      {children}
    </p>
  )
}

function EndoWorksheetPageBody({ worksheet }: { worksheet: WorksheetListItem }) {
  const id = worksheet.id
  const isCompleted = worksheet.status === 'completed'
  const drawer = useWorksheetDrawer()
  const [addSamplesOpen, setAddSamplesOpen] = useState(false)
  const { data: users = [] } = useQuery({
    queryKey: ['worksheet-users'],
    queryFn: getWorksheetUsers,
    staleTime: FIVE_MINUTES,
  })
  const { data: instruments = [] } = useQuery({
    queryKey: ['instruments'],
    queryFn: getInstruments,
    staleTime: FIVE_MINUTES,
  })
  const { data: methods = [] } = useQuery({
    queryKey: ['hplc-methods'],
    queryFn: getMethods,
    staleTime: FIVE_MINUTES,
  })
  // The allowed list when no method resolves (spec 4.3): every active endo cartridge.
  const { data: catalog = [] } = useQuery({
    queryKey: ['consumables', 'endo_cartridge'],
    queryFn: () => listConsumables({ kind: 'endo_cartridge' }),
    staleTime: FIVE_MINUTES,
  })
  const { calendar } = useLabCalendar()
  const { byKey } = useSlaForSubjects(
    worksheetItemSlaSubjects(
      worksheet.items,
      isCompleted ? (worksheet.completed_at ?? null) : null
    )
  )

  // Box 1's order (due date, then priority), worked out as the table does, so
  // Boxes 2 and 3 number their rows as Box 1 does.
  const ordered = endoItemsInBenchOrder(
    worksheet.items,
    new Map(
      worksheet.items.map(it => [
        it.id,
        byKey.get(String(it.id))?.status.due_at ?? null,
      ])
    ),
    calendar
  )
  const cartridges = allowedCartridges(worksheet, catalog)
  const ctx = endoCtxFor(worksheet, catalog)
  const rows = endoRowsFor(ordered, worksheet, catalog)
  const { userNotes } = parseWorksheetNotes(worksheet.notes ?? '')

  function update(data: WorksheetUpdate) {
    drawer.updateMutation.mutate({
      worksheetId: id,
      data:
        data.notes === undefined
          ? data
          : { ...data, notes: withNotesText(worksheet.notes ?? '', data.notes) },
    })
  }

  function updateItem(itemId: number, data: WorksheetItemPatch) {
    drawer.updateItemMutation.mutate({ worksheetId: id, itemId, data })
  }

  function applyToAll(methodId: number, instrumentId: number) {
    drawer.applyMethodInstrumentMutation.mutate(
      {
        worksheetId: id,
        data: { method_id: methodId, instrument_id: instrumentId },
      },
      {
        onSuccess: res => {
          const skipped = [
            res.skipped_state.length ? `${res.skipped_state.length} locked` : '',
            res.skipped_uncovered.length
              ? `${res.skipped_uncovered.length} not covered by this method`
              : '',
          ].filter(Boolean)
          toast.success(
            `Stamped ${res.stamped} analyses on ${res.items_updated} items${
              skipped.length ? `; ${skipped.join(', ')}` : ''
            }`
          )
        },
      }
    )
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-muted/30">
      <BenchRunLog
        kind="endo"
        label="Endotoxin"
        tickLabels={['Made', 'MCS']}
        activeId={id}
        users={users}
        onSelect={next => useUIStore.getState().navigateToWorksheet(next)}
      />
      {/* Boxes 2 and 3 mount as children of EndoWorksheetView on 2 mL runs
          (Tasks 14 and 15), each with EndoBoxProps:
          { worksheet, rows, ctx, cartridges, isCompleted, onUpdateItem: updateItem } */}
      <EndoWorksheetView
        worksheet={worksheet}
        users={users}
        userNotes={userNotes}
        isCompleted={isCompleted}
        otherWorksheets={drawer.openWorksheets.filter(ws => ws.id !== id)}
        applyBar={
          !isCompleted && (
            <WorksheetApplyBar
              key={id}
              activeMethods={methods.filter(m => m.active)}
              instruments={instruments}
              isPending={drawer.applyMethodInstrumentMutation.isPending}
              onApply={applyToAll}
            />
          )
        }
        completeAction={
          <CompleteWorksheetButton
            onConfirm={() => drawer.completeMutation.mutate(id)}
          />
        }
        onAddSamples={() => setAddSamplesOpen(true)}
        onUpdate={update}
        onRemove={itemId =>
          drawer.removeMutation.mutate({ worksheetId: id, itemId })
        }
        onReassign={(itemId, targetWorksheetId) =>
          drawer.reassignMutation.mutate({
            worksheetId: id,
            itemId,
            targetWorksheetId,
          })
        }
        onUpdateItem={updateItem}
        onTickAll={data =>
          drawer.bulkTicksMutation.mutate({ worksheetId: id, data })
        }
        prepModel={worksheet.endo_prep === '2ml' ? '2ml' : 'stock'}
        twoMl={{ rows, ctx, cartridges }}
        heading={
          <EndoBoxHead
            n={1}
            title="Sample intake: reconstitute each vial"
            sub="What came in, when it is due, and the water that goes into each vial. Tick Made and MCS as you go."
          />
        }
        runHeader={
          <EndoRunHeader
            worksheet={worksheet}
            cartridges={cartridges}
            isCompleted={isCompleted}
            onUpdate={update}
          />
        }
      />
      <AddSamplesModal
        open={addSamplesOpen}
        onOpenChange={setAddSamplesOpen}
        worksheetId={id}
        existingItems={worksheet.items}
        onAdd={data => drawer.addItemMutation.mutate({ worksheetId: id, data })}
      />
    </div>
  )
}

export default EndoWorksheetPage
```

Every mutation the page uses comes from `useWorksheetDrawer` and invalidates `['worksheets-list']`, which covers the page's `worksheetPageKey` entry; item edits also land at once through `mergeItemPatch` (Task 10). The Prep and Run cartridge changes are worksheet PUTs through `updateMutation`, so the page refetches GET /worksheets/{id} and every box recomputes with the new cartridge or prep.

- [ ] **Step 29: Mount the page (`src/components/layout/MainWindowContent.tsx`)**

After `import WorksheetsListPage from '@/components/hplc/WorksheetsListPage'` add:

```ts
import { EndoWorksheetPage } from '@/components/hplc/endo/EndoWorksheetPage'
```

and in `case 'hplc-analysis':`, after `if (activeSubSection === 'worksheets') return <WorksheetsListPage />` add:

```tsx
        if (activeSubSection === 'worksheet') return <EndoWorksheetPage />
```

- [ ] **Step 30: Run every suite this task touches, typecheck, lint and format**

Run:
```bash
npx vitest run src/lib/__tests__/worksheet-notes.test.ts src/lib/__tests__/hash-navigation-worksheet.test.ts src/lib/__tests__/hash-navigation.test.ts src/lib/__tests__/hash-navigation-flag.test.ts src/lib/__tests__/endo-worksheet-2ml.test.ts src/lib/__tests__/endo-prep.test.ts src/lib/__tests__/endo-bench-sheet.test.ts src/components/hplc/__tests__/ src/hooks/__tests__/
npx prettier --write src/lib/worksheet-notes.ts src/lib/__tests__/worksheet-notes.test.ts src/components/hplc/WorksheetDrawer.tsx src/components/hplc/EndoWorksheetView.tsx src/components/hplc/endo/EndoWorksheetPage.tsx src/components/layout/MainWindowContent.tsx
npm run typecheck
npm run lint
npm run ast:lint
npm run test:run
```
Expected: every listed suite passes (the stock endo suites unchanged), typecheck, eslint and ast-grep clean, and the whole frontend suite (`test:run`, the `check:all` test gate) passes, which covers the suites under `src/test/` that render the drawer, the store and the inbox (`worksheet-apply-method.test.tsx`, `worksheets-inbox-lanes.test.tsx` and others) and proves the drawer's output did not move. Compare any failure against the master baseline before calling it new.

- [ ] **Step 31: Commit**

```bash
git add src/lib/worksheet-notes.ts src/lib/__tests__/worksheet-notes.test.ts src/components/hplc/endo/EndoWorksheetPage.tsx
git commit -m "feat(endo-v2): endo worksheet page with run log, run header and Box 1" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/worksheet-notes.ts src/lib/__tests__/worksheet-notes.test.ts src/components/hplc/WorksheetDrawer.tsx src/components/hplc/EndoWorksheetView.tsx src/components/hplc/endo/EndoWorksheetPage.tsx src/components/layout/MainWindowContent.tsx
```

---

## Reference for Tasks 14 to 19: names produced by Tasks 8 to 13

Built on the finished drafts of Tasks 8 and 9 (part G3) and Tasks 10 to 13 (part G4). Names used below, as those parts define them:

- `src/components/hplc/endo/EndoBox.tsx` (Task 13): `EndoBox({ n, title, sub, actions, children })`, the numbered box chrome; `EndoBoxProps = { worksheet, rows: EndoRow[], ctx: EndoCtx, cartridges: EndoCartridgeOption[], isCompleted, onUpdateItem }`.
- `src/lib/endo-worksheet-2ml.ts` (Task 13): `EndoRow = { item, n, sample, cartridge: EndoCartridgeRef | null, inherited }` (`n` is the Box 1 row number, `cartridge.id` the row's resolved cartridge), `EndoCartridgeOption = { id, name, sensitivity_eu_ml, is_default }`, `EndoCartridgeRef = { id, sensitivity }`, `endoRowsFor(ordered, ws, catalog?)`, `allowedCartridges(ws, catalog?)`, `runCartridgeFor(ws, catalog?)`, `endoCtxFor(ws, catalog?)`, `endoSampleFor(item, ws, catalog?)`, `runParamsFrom(method)`, `WorksheetRow` (alias of `WorksheetListItem`).
- `src/hooks/use-worksheet-drawer.ts` (Task 10): `worksheetPageKey(id)` = `['worksheets-list', 'page', id]`, the page's GET-by-id cache entry; `mergeItemPatch` keeps it and the flyout list current on every item PATCH, and every worksheet mutation invalidates the `['worksheets-list']` prefix.
- `src/lib/api.ts` (Task 10): `listConsumables({ kind, active })`, `importReaderResults(id, body)` returning `{ applied, items, endo_method }`, `ReaderImportTest`, `EndoMethodInfo`, `EndoPrepStepsWire` (`((number | null)[] | null)[]`), `WorksheetItemPatch.prep_steps / prep_total_dilution / result_reading / cartridge_type_id / prep_form / prep_water_ml`, worksheet `endo_prep`, `cartridge_type_id`, `cartridge_sensitivity_eu_ml`, `endo_method` (absent on the list payload, present on GET by id).
- `src/lib/endo-prep-2ml.ts` (Task 8): for bac water `stepsOf` returns `[]` and `dilutionPlan` returns `{ steps: [], target: 20, total: 20, fits: true, standard: true }`; `fmtConc`, `fmtEu(lt, v | null)`, `FORMS`, `parseReading` (the only judge of a reading; the server's `parse_reading` accepts the same set). `EndoReaderRecord` carries `result` (the reading as the reader exported it).
- `src/lib/endo-reader.ts` (Task 9): `matchReaderTests` returns `{ matched, unmatched, ambiguous, superseded }` and keeps only the latest test per row.

Shared conventions:
- The 2 mL maths outside the page reads the GET-by-id worksheet under `worksheetPageKey(id)` (the list payload has no `endo_method`) and, when `endo_method` is `null`, the catalog under `['consumables', 'endo_cartridge']` (`listConsumables({ kind: 'endo_cartridge' })`), exactly as the page does.
- Helpers that are not components live in `src/lib/*.ts` (lint runs with `--max-warnings 0`; `react-refresh/only-export-components` warns on non-component exports from `.tsx`, constants excepted); hooks stay out of `src/lib`.
- No non-null assertions (`@typescript-eslint/strict`); `noUncheckedIndexedAccess` is on, so every index read is guarded.
- Commits: `git add` new files first, then a pathspec commit. The files touched are LF in this worktree (`git ls-files --eol`: `i/lf w/lf`); check `git diff --stat -- <paths>` shows small diffs before committing.


### Task 14: Box 2, Sample dilution

**Files:**
- Create: `src/components/hplc/endo/EndoSampleDilutionBox.tsx`
- Create: `src/components/hplc/endo/EndoWorkedTip.tsx`
- Create: `src/components/hplc/endo/__tests__/endo-fixtures.ts`
- Create: `src/components/hplc/endo/__tests__/EndoSampleDilutionBox.test.tsx`
- Modify: `src/lib/endo-worksheet-2ml.ts` (append `BW_SAMPLE_UL`, `BW_LAL_UL`, `standardSteps`, `totalGroupKey`)
- Modify: `src/components/hplc/EndoWorksheetTable.tsx` (export the existing class-string constants)
- Modify: `src/components/hplc/endo/EndoWorksheetPage.tsx` (the shared `boxProps` and the Box 2 mount)

**Interfaces:**
- Consumes: `EndoBox`, `EndoBoxProps` (Task 13); `EndoRow`, `endoRowsFor`, `endoCtxFor`, `allowedCartridges` (Task 13 glue; the last three in the test fixtures); `dilutionPlan`, `prep2Check`, `orderByTotal`, `formOf`, `fmtConc`, `TUBE_UL`, `BW_DILUTION`, `BW_LIMIT_EU_PER_ML`, `EndoSample`, `EndoStepPlan`, `EndoCheck`, `EndoCtx` (Task 8); `WorksheetItemPatch.prep_total_dilution`, `.prep_steps`, item `prep_total_dilution`, `prep_steps` (Task 10); `PrepField` (`EndoPrepLine.tsx`); `fmt`, `fmtUl`, `CARTRIDGE_UL` (`src/lib/endo-prep.ts`).
- Produces:
  - `EndoSampleDilutionBox(props: EndoBoxProps)`: Box 2 (spec 6.1), grouped by total via `orderByTotal(rows, r => r.sample, ctx)` with a rule where the total changes; the row number is `row.n` (Box 1's); bac water is one 20x step (`dilutionPlan(...).total`, 50 + 950 uL) across the three step cells.
  - `WorkedTip` (`EndoWorkedTip.tsx`): a computed figure with its worked line in the shadcn Tooltip card (the user's default for non-trivial hovers, not `title=`).
  - In `endo-worksheet-2ml.ts`: `BW_SAMPLE_UL` (50), `BW_LAL_UL` (950), `standardSteps(ctx): EndoStepPlan[]`, `totalGroupKey(s, ctx): string` (Task 18 reuses all four).
  - `export` on `TH`, `TH_CALC`, `UNIT`, `TD`, `MONO`, `TD_CALC`, `STATUS_CHIP` in `EndoWorksheetTable.tsx` (constants; no behaviour change).
  - Test fixtures `endoItem`, `endoWorksheet`, `endoBoxProps` (Tasks 15 to 18 reuse them).
  - Wire shape sent for a step edit: `prep_steps` is `[[sample_ul, ratio] | null, [sample_ul] | null, [sample_ul] | null]`, `null` entries standard, all three standard sends `prep_steps: null`. A ratio typed alone carries the step's current sample volume (`[20, 15]`), because spec 3.7 validates `sample_ul > 0` on every entry. A total equal to the method's standard sends `null`.

Layout values from Dennis's `endotoxin.html` (`.dilution-table`, `.stepcell`), used below (the box chrome is Task 13's `EndoBox`, his `.sheet` / `.results-head` / `.legend-title` / `.results-sub`):
- Table `width:100%; min-width:1080px; table-layout:fixed`; `#` 36px, Sample ID 96px, Total 112px, Loaded 124px, the three steps share the rest; cells `vertical-align:top`, 7px top and bottom.
- Step cell: left rule, `padding-left:10px; padding-right:8px`; the ratio slot on the left, the sample and diluent slots kept together on the right (`gap:14px`); a 10px caption over each value (value line `min-height:26px`); a muted 11px mono line under it (`1:N dilution`, or the overflow warning in red).
- Step colours: his `--s1 #2F6DB5`, `--s2 #2D7D4F`, `--s3 #A2620F`, vial `--sv #7A4FB5` (dark `#7FB2EE`, `#7CCB9A`, `#E5B163`, `#B99BEB`), mapped to Tailwind blue-700/300, green-700/300, amber-700/300, violet-600/300 with light fills; the step heading carries a 3px top bar in its colour.
- Inputs: `stepin` 3.6em, the step 1 ratio 3.2em, the total 4.4em.
- Group rule: a 2px top border (`color-mix(ink 28%)`) on the first row of each new total.

- [ ] **Step 1: Write the shared test fixtures**

Create `src/components/hplc/endo/__tests__/endo-fixtures.ts`:

```ts
import { vi } from 'vitest'
import type { WorksheetListItem } from '@/lib/api'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import {
  allowedCartridges,
  endoCtxFor,
  endoRowsFor,
} from '@/lib/endo-worksheet-2ml'
import type { EndoBoxProps } from '@/components/hplc/endo/EndoBox'

let nextId = 100

/**
 * A 2 mL endotoxin vial row carrying every key the endo boxes read
 * (Task 10 serializer keys included). Override what a test needs.
 */
export function endoItem(over: Partial<WorksheetItemRow> = {}): WorksheetItemRow {
  nextId += 1
  return {
    id: nextId,
    sample_id: `P-${nextId}-S02`,
    sample_uid: `mk1://${nextId}`,
    service_group_id: null,
    department_id: 3,
    department_name: 'Microbiology',
    group_name: 'Microbiology',
    group_color: '#888888',
    priority: 'normal',
    added_at: null,
    date_received: '2026-10-09T16:00:00Z',
    instrument_uid: null,
    instrument_id: null,
    assigned_analyst_id: null,
    assigned_analyst_email: null,
    notes: null,
    peptide_id: null,
    method_name: null,
    stamped_method_name: null,
    stamped_instrument_name: null,
    lims_sub_sample_pk: nextId,
    assignment_kind: 'core',
    assignment_role: 'endo',
    box_id: null,
    box_label: null,
    analyses: [
      {
        title: 'Endotoxin (LAL)',
        keyword: 'ENDO-LAL',
        analysis_service_id: 61,
        peptide_name: null,
        method: null,
      },
    ],
    prep_status: 'ready',
    declared_weight_mg: 10,
    sample_type: 'Peptide',
    client_order_number: 'WP-8860',
    sample_identity: 'Retatrutide',
    made_at: null,
    ran_at: null,
    prep_form: null,
    prep_water_ml: null,
    prep_total_dilution: null,
    prep_steps: null,
    cartridge_type_id: null,
    cartridge_sensitivity_eu_ml: null,
    result_reading: null,
    result_reader: null,
    result_entered_at: null,
    result_entered_by_user_id: null,
    ...over,
  }
}

/**
 * A 2 mL worksheet as GET /worksheets/{id} returns it: run cartridge 3
 * (0.05 EU/mL, the method default), method 12 allowing 0.05 and 0.01.
 */
export function endoWorksheet(
  items: WorksheetItemRow[],
  over: Partial<WorksheetListItem> = {}
): WorksheetListItem {
  return {
    id: 77,
    title: 'Endo 10/09/2026 #1',
    status: 'open',
    notes: null,
    assigned_analyst: 5,
    assigned_analyst_email: 'analyst@example.com',
    item_count: items.length,
    created_at: '2026-10-09T15:00:00Z',
    completed_at: null,
    endo_prep: '2ml',
    cartridge_type_id: 3,
    cartridge_sensitivity_eu_ml: 0.05,
    endo_method_id: null,
    endo_method: {
      id: 12,
      name: 'Endotoxin (LAL)',
      revision: 2,
      status: 'active',
      run_parameters: null,
      cartridges: [
        { id: 3, name: 'Endosafe 0.05', sensitivity_eu_ml: 0.05, is_default: true, active: true },
        { id: 4, name: 'Endosafe 0.01', sensitivity_eu_ml: 0.01, is_default: false, active: true },
      ],
    },
    items,
    ...over,
  }
}

/** The props the page hands Boxes 2 and 3, for these items in this order. */
export function endoBoxProps(
  items: WorksheetItemRow[],
  over: Partial<WorksheetListItem> = {},
  isCompleted = false
): { props: EndoBoxProps; onUpdateItem: ReturnType<typeof vi.fn> } {
  const worksheet = endoWorksheet(items, over)
  const onUpdateItem = vi.fn()
  return {
    props: {
      worksheet,
      rows: endoRowsFor(items, worksheet),
      ctx: endoCtxFor(worksheet),
      cartridges: allowedCartridges(worksheet),
      isCompleted,
      onUpdateItem,
    },
    onUpdateItem,
  }
}
```

- [ ] **Step 2: Write the failing Box 2 test**

Create `src/components/hplc/endo/__tests__/EndoSampleDilutionBox.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { EndoSampleDilutionBox } from '@/components/hplc/endo/EndoSampleDilutionBox'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import { endoBoxProps, endoItem } from './endo-fixtures'

function setup(items: WorksheetItemRow[], isCompleted = false) {
  const { props, onUpdateItem } = endoBoxProps(items, {}, isCompleted)
  render(<EndoSampleDilutionBox {...props} />)
  return { onUpdateItem }
}

function rowOf(sampleId: string): HTMLElement {
  const row = screen.getByText(sampleId).closest('tr')
  if (!row) throw new Error(`no row for ${sampleId}`)
  return row
}

function bodyRows(): HTMLElement[] {
  const body = screen.getAllByRole('rowgroup')[1]
  if (!body) throw new Error('no table body')
  return within(body).getAllByRole('row')
}

const cellText = (row: HTMLElement, i: number) =>
  within(row).getAllByRole('cell')[i]?.textContent

describe('EndoSampleDilutionBox', () => {
  it('groups rows by total, a rule per group, each numbered as in Box 1', () => {
    setup([
      endoItem({ sample_id: 'P-0001-S02' }),
      endoItem({ sample_id: 'P-0002-S02', prep_total_dilution: 300 }),
      endoItem({ sample_id: 'P-0003-S02' }),
      endoItem({
        sample_id: 'BW-0114-S02',
        sample_identity: 'Bacteriostatic Water',
        sample_type: 'Bacteriostatic Water',
        declared_weight_mg: null,
      }),
    ])
    const rows = bodyRows()
    expect(rows.map(r => cellText(r, 1))).toEqual([
      'P-0001-S02',
      'P-0003-S02',
      'P-0002-S02',
      'BW-0114-S02',
    ])
    expect(rows.map(r => cellText(r, 0))).toEqual(['1', '3', '2', '4'])
    expect(rows.map(r => r.hasAttribute('data-group-start'))).toEqual([
      false,
      false,
      true,
      true,
    ])
    // bac water: one 20x step, 50 uL made to 1000 uL
    const bw = rowOf('BW-0114-S02')
    expect(within(bw).getByText('Bacteriostatic water · one step')).toBeInTheDocument()
    expect(within(bw).getByText('+ 950')).toBeInTheDocument()
    // 10 mg in 2 mL at 1:250 loads 0.02 mg/mL on the MCS (fmtConc)
    expect(within(rowOf('P-0001-S02')).getByText('0.02')).toBeInTheDocument()
  })

  it('marks a value set by hand and keeps the standard as the placeholder', () => {
    setup([endoItem({ sample_id: 'P-0001-S02', prep_steps: [[30, 10], null, null] })])
    const row = rowOf('P-0001-S02')
    const s1 = within(row).getByLabelText('Step 1 sample (µL)') as HTMLInputElement
    expect(s1.value).toBe('30')
    expect(s1.title).toMatch(/^Set by hand\. Computed: 20 µL/)
    const s2 = within(row).getByLabelText('Step 2 sample (µL)') as HTMLInputElement
    expect(s2.value).toBe('')
    expect(s2.placeholder).toBe('20')
    // 30 uL at 1:10 takes 270 uL of Tris
    expect(within(row).getByText('+ 270')).toBeInTheDocument()
  })

  it('warns when a step overflows the 1.5 mL tube', () => {
    setup([endoItem({ sample_id: 'P-0001-S02', prep_steps: [null, null, [800]] })])
    expect(
      screen.getByText('over the 1.5 mL tube: 1600 µL, take less sample')
    ).toBeInTheDocument()
  })

  it('sends prep_steps as arrays: a ratio typed alone carries the sample volume', () => {
    const item = endoItem({ sample_id: 'P-0001-S02' })
    const { onUpdateItem } = setup([item])
    const ratio = within(rowOf('P-0001-S02')).getByLabelText('Step 1 ratio (1 in N)')
    fireEvent.change(ratio, { target: { value: '15' } })
    fireEvent.blur(ratio)
    expect(onUpdateItem).toHaveBeenCalledWith(item.id, {
      prep_steps: [[20, 15], null, null],
    })
  })

  it('sends null when a step goes back to the standard, and the total on its own field', () => {
    const item = endoItem({ sample_id: 'P-0001-S02', prep_steps: [[20, 15], null, null] })
    const { onUpdateItem } = setup([item])
    const row = rowOf('P-0001-S02')
    const ratio = within(row).getByLabelText('Step 1 ratio (1 in N)')
    fireEvent.change(ratio, { target: { value: '' } })
    fireEvent.blur(ratio)
    expect(onUpdateItem).toHaveBeenCalledWith(item.id, { prep_steps: null })
    const total = within(row).getByLabelText('Total dilution (1 in N)')
    fireEvent.change(total, { target: { value: '300' } })
    fireEvent.blur(total)
    expect(onUpdateItem).toHaveBeenCalledWith(item.id, { prep_total_dilution: 300 })
  })

  it('renders no inputs on a completed worksheet', () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })], true)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run the test to see it fail**

Run: `npx vitest run src/components/hplc/endo/__tests__/EndoSampleDilutionBox.test.tsx`
Expected: FAIL, `Failed to resolve import "@/components/hplc/endo/EndoSampleDilutionBox"`.

- [ ] **Step 4: Add the Box 2 / paper helpers to the glue**

Append to `src/lib/endo-worksheet-2ml.ts`, merging the imports into the file's existing import lines (`fmt` is already imported there from `@/lib/endo-prep`, and `formOf`, `EndoCtx`, `EndoSample` from `@/lib/endo-prep-2ml`):

```ts
import { CARTRIDGE_UL } from '@/lib/endo-prep'
import {
  BW_DILUTION,
  dilutionPlan,
  type EndoStepPlan,
} from '@/lib/endo-prep-2ml'

/** Bac water's single step: 50 uL made to 1000 uL with LAL water (its 20x). */
export const BW_SAMPLE_UL = CARTRIDGE_UL / BW_DILUTION
export const BW_LAL_UL = CARTRIDGE_UL - BW_SAMPLE_UL

const STANDARD_SAMPLE: EndoSample = {
  sampleId: '',
  identity: '',
  sampleType: null,
  weightMg: null,
  form: 'powder',
  waterMl: null,
  totalDilution: null,
  steps: null,
  lambda: null,
  reading: null,
  reader: null,
}

/**
 * The method's standard steps (20 + 180, 20 + 230, 125 + 125 at 1:250 with
 * Dennis's values). A row's steps are compared with these to show a value
 * set by hand on screen and to box a non-standard step on paper.
 */
export function standardSteps(ctx: EndoCtx): EndoStepPlan[] {
  return dilutionPlan(STANDARD_SAMPLE, ctx).steps
}

/**
 * The total a row is grouped under, in the order orderByTotal sorts them:
 * the number, 'x' for a total the steps cannot make, 'bac' for bac water.
 * Box 2 and the 2 mL bench sheet draw a rule where this changes.
 */
export function totalGroupKey(s: EndoSample, ctx: EndoCtx): string {
  if (formOf(s) === 'bac') return 'bac'
  const total = dilutionPlan(s, ctx).total
  return total === null ? 'x' : String(total)
}
```

- [ ] **Step 5: Export the existing class strings from Box 1's stock table**

In `src/components/hplc/EndoWorksheetTable.tsx` add `export` in front of these existing declarations, nothing else:

```ts
export const TH =
export const TH_CALC = 'bg-teal-500/10 text-teal-800 dark:text-teal-200 text-right'
export const UNIT =
export const TD = 'border-b border-border/60 px-2 py-[5px] align-middle text-[13px]'
export const MONO = 'font-mono text-[12.5px] tabular-nums'
export const TD_CALC = `${TD} ${MONO} bg-teal-500/[0.06] text-right text-foreground/80 whitespace-nowrap group-hover/item:bg-teal-500/10`
export const STATUS_CHIP: Record<string, [string, string]> = {
```

(`react-refresh/only-export-components` is configured with `allowConstantExport: true`, so constant exports from a component file pass lint. Task 13 already exports `Meta` and `EndoTwoMl` from this file; these sit beside them.)

- [ ] **Step 6: Create the worked-line tooltip**

Create `src/components/hplc/endo/EndoWorkedTip.tsx`:

```tsx
import type { ReactNode } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * A computed figure with its worked line on hover, in the app's default
 * hover card (the shadcn Tooltip, not a native title). Focusable, so the
 * line is reachable from the keyboard too. No tip, no tooltip.
 */
export function WorkedTip({
  tip,
  className,
  children,
}: {
  tip: string | null | undefined
  className?: string
  children: ReactNode
}) {
  if (!tip) return <span className={className}>{children}</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={`cursor-help focus-visible:outline-2 focus-visible:outline-teal-500 ${className ?? ''}`}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm p-0">
        <div className="whitespace-pre-line p-3 font-mono text-xs leading-relaxed">
          {tip}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

export default WorkedTip
```

- [ ] **Step 7: Create Box 2**

Create `src/components/hplc/endo/EndoSampleDilutionBox.tsx`:

```tsx
import type { ReactNode } from 'react'
import type { WorksheetItemPatch } from '@/lib/api'
import { fmt, fmtUl } from '@/lib/endo-prep'
import {
  BW_LIMIT_EU_PER_ML,
  TUBE_UL,
  dilutionPlan,
  fmtConc,
  formOf,
  orderByTotal,
  prep2Check,
  type EndoCheck,
  type EndoSample,
  type EndoStepPlan,
} from '@/lib/endo-prep-2ml'
import {
  BW_LAL_UL,
  BW_SAMPLE_UL,
  standardSteps,
  totalGroupKey,
  type EndoRow,
} from '@/lib/endo-worksheet-2ml'
import { PrepField } from '@/components/hplc/EndoPrepLine'
import { MONO, TH, TH_CALC, UNIT } from '@/components/hplc/EndoWorksheetTable'
import { EndoBox, type EndoBoxProps } from './EndoBox'
import { WorkedTip } from './EndoWorkedTip'

// Dennis's .dilution-table cells: top-aligned, 7px top and bottom.
const CELL = 'border-b border-border/60 px-2 py-[7px] align-top text-[13px]'
// The first row of the next total (his tr.newtotal: 2px, ink at 28%).
const GROUP_RULE = 'border-t-2 border-t-foreground/30'

// Dennis's step colours (--s1 #2F6DB5 Tris, --s2 #2D7D4F LAL water, --s3
// #A2620F BG600; dark #7FB2EE, #7CCB9A, #E5B163) on the theme palette.
const STEPS = [
  {
    name: 'Tris',
    short: 'Tris',
    ratioCap: 'ratio',
    th: '!text-blue-700 dark:!text-blue-300',
    text: 'text-blue-700 dark:text-blue-300',
    cell: 'bg-blue-500/[0.07] dark:bg-blue-400/[0.09]',
  },
  {
    name: 'LAL water',
    short: 'water',
    ratioCap: 'ratio · from total',
    th: '!text-green-700 dark:!text-green-300',
    text: 'text-green-700 dark:text-green-300',
    cell: 'bg-green-500/[0.07] dark:bg-green-400/[0.08]',
  },
  {
    name: 'BG600',
    short: 'BG600',
    ratioCap: 'ratio · fixed',
    th: '!text-amber-700 dark:!text-amber-300',
    text: 'text-amber-700 dark:text-amber-300',
    cell: 'bg-amber-500/[0.08] dark:bg-amber-400/[0.09]',
  },
] as const
// The vial solution, the source of step 1 (his --sv #7A4FB5, dark #B99BEB).
const VIAL_TONE = 'text-violet-600 dark:text-violet-300'

type PrepSteps = WorksheetItemPatch['prep_steps']

/**
 * The row's prep_steps after one cell is typed. On the wire each step is
 * [sample_ul, ratio] (step 1) or [sample_ul] (steps 2 and 3); null is the
 * standard. The server wants a sample volume in every entry, so a ratio
 * typed alone carries the step's current sample volume with it. An entry
 * back at the standard becomes null; all three standard sends null.
 */
function nextPrepSteps(
  current: PrepSteps,
  i: number,
  field: 'sample' | 'ratio',
  v: number | null,
  plan: EndoStepPlan[],
  std: EndoStepPlan[]
): PrepSteps {
  const p = plan[i]
  const d = std[i]
  if (!p || !d) return current ?? null
  const next = [0, 1, 2].map(j => current?.[j] ?? null)
  const dSample = d.sampleUl ?? 0
  const dRatio = d.ratio ?? 1
  const sample = field === 'sample' ? (v ?? dSample) : (p.sampleUl ?? dSample)
  const ratio = field === 'ratio' ? (v ?? dRatio) : (p.ratio ?? dRatio)
  const standard = sample === dSample && (i !== 0 || ratio === dRatio)
  next[i] = standard ? null : i === 0 ? [sample, ratio] : [sample]
  return next.every(e => e === null) ? null : next
}

function loadedTip(s: EndoSample, k: EndoCheck): string | null {
  if (k.loaded === null) return null
  return (
    `${fmt(s.weightMg)} mg ÷ ${fmt(k.water)} mL ÷ ${fmt(k.dilution)} = ${fmtConc(k.loaded)} mg/mL on the MCS` +
    (k.mvc !== null ? `\nneeds ≥ ${fmtConc(k.mvc)} (the MVC for this vial)` : '')
  )
}

/** A caption over each value, so it is plain which number is which. */
function Slot({
  cap,
  tone,
  end,
  children,
}: {
  cap: string
  tone?: string
  end?: boolean
  children: ReactNode
}) {
  return (
    <span className={`inline-flex flex-col gap-0.5 ${end ? 'items-end' : 'items-start'}`}>
      <span
        className={`whitespace-nowrap font-sans text-[10px] leading-[1.1] tracking-[0.02em] ${tone ? `font-semibold ${tone}` : 'text-muted-foreground'}`}
      >
        {cap}
      </span>
      <span className="inline-flex min-h-[26px] items-center">{children}</span>
    </span>
  )
}

function StepCell({
  st,
  d,
  si,
  cell,
  isCompleted,
  onCommit,
}: {
  st: EndoStepPlan
  d: EndoStepPlan
  si: number
  cell: string
  isCompleted: boolean
  onCommit: (field: 'sample' | 'ratio', v: number | null) => void
}) {
  const tone = STEPS[si] ?? STEPS[0]
  const prev = STEPS[si - 1]
  const sampleOwn = st.sampleUl !== d.sampleUl
  const ratioOwn = si === 0 && st.ratio !== d.ratio
  const made = st.diluentUl !== null && st.totalUl !== null
  const from = si ? `step ${si}` : 'the vial solution'
  const fac = !made
    ? st.sampleUl
      ? 'ratio must be at least 1:1'
      : 'no sample volume'
    : st.fits
      ? `1:${fmt(st.running)} dilution`
      : `over the ${fmt(TUBE_UL / 1000)} mL tube: ${fmtUl(st.totalUl)} µL, take less sample`
  const tip = [
    `Step ${si + 1}: ${fmtUl(st.sampleUl)} µL of ${from} + ${made ? fmtUl(st.diluentUl) : '?'} µL ${st.diluent} = ${made ? fmtUl(st.totalUl) : '?'} µL`,
    made ? `1:${fmt(st.ratio)}, 1:${fmt(st.running)} so far` : null,
    st.own
      ? `Set by hand; the standard is ${si === 0 ? `1:${fmt(d.ratio)}, ` : ''}${fmtUl(d.sampleUl)} µL`
      : null,
    st.fits ? null : `Does not fit a ${fmt(TUBE_UL / 1000)} mL tube`,
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <td className={`${cell} border-l pl-2.5 pr-2 ${tone.cell}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-2.5 gap-y-1">
        <Slot cap={tone.ratioCap}>
          <span className="inline-flex items-center gap-px font-mono text-foreground/80">
            1:
            {si === 0 ? (
              <span className="block w-[3.2em]">
                <PrepField
                  bare
                  label="Step 1 ratio"
                  unit="1 in N"
                  value={ratioOwn ? st.ratio : null}
                  overridden={ratioOwn}
                  computed={d.ratio}
                  disabled={isCompleted}
                  onCommit={v => onCommit('ratio', v)}
                />
              </span>
            ) : st.ratio === null || st.ratio < 1 ? (
              '?'
            ) : (
              fmt(st.ratio)
            )}
          </span>
        </Slot>
        <span className="ml-auto inline-flex items-start gap-3.5">
          <Slot cap={si ? `from step ${si}` : 'sample'} tone={prev ? prev.text : VIAL_TONE}>
            <span className="block w-[3.6em]">
              <PrepField
                bare
                label={`Step ${si + 1} sample`}
                unit="µL"
                value={sampleOwn ? st.sampleUl : null}
                overridden={sampleOwn}
                computed={d.sampleUl}
                disabled={isCompleted}
                onCommit={v => onCommit('sample', v)}
              />
            </span>
          </Slot>
          <Slot cap={`${tone.short} to add`} tone={tone.text} end>
            <WorkedTip
              tip={tip}
              className={`whitespace-nowrap font-mono font-semibold ${made && st.fits ? tone.text : 'text-red-600 dark:text-red-400'}`}
            >
              {made ? `+ ${fmtUl(st.diluentUl)}` : '?'}
            </WorkedTip>
          </Slot>
        </span>
      </div>
      <div
        className={`mt-[3px] whitespace-normal font-mono text-[11px] ${!st.fits ? 'font-semibold text-red-600 dark:text-red-400' : st.own ? 'text-teal-700 dark:text-teal-300' : 'text-muted-foreground'}`}
      >
        {fac}
      </div>
    </td>
  )
}

/**
 * Box 2, Sample dilution (2 mL worksheets; the page mounts it only then), as
 * Dennis's section of the same name: the total wanted, then the three bench
 * steps from the vial to the cartridge (Tris at a chosen ratio, LAL water
 * derived to land on the total, BG600 fixed at 1:2), each with what is
 * taken, what is added, the running dilution and a warning when the 1.5 mL
 * tube overflows; then what lands on the MCS. Grouped by total (1:250s
 * first) with a rule where the total changes; the row number is Box 1's.
 * Everything derived comes from src/lib/endo-prep-2ml.ts, the same code the
 * 2 mL bench sheet uses.
 */
export function EndoSampleDilutionBox({
  rows,
  ctx,
  isCompleted,
  onUpdateItem,
}: EndoBoxProps) {
  if (!rows.length) return null
  const std = standardSteps(ctx)
  const ordered = orderByTotal(rows, r => r.sample, ctx)
  const keys = ordered.map(r => totalGroupKey(r.sample, ctx))
  const stdTotal = ctx.params.stdTotalDilution

  function commitStep(
    row: EndoRow,
    i: number,
    field: 'sample' | 'ratio',
    v: number | null
  ) {
    const current = row.item.prep_steps ?? null
    const next = nextPrepSteps(
      current,
      i,
      field,
      v,
      dilutionPlan(row.sample, ctx).steps,
      std
    )
    if (JSON.stringify(next) === JSON.stringify(current)) return
    onUpdateItem(row.item.id, { prep_steps: next })
  }

  function commitTotal(row: EndoRow, v: number | null) {
    const next = v === stdTotal ? null : v
    if (next === (row.item.prep_total_dilution ?? null)) return
    onUpdateItem(row.item.id, { prep_total_dilution: next })
  }

  return (
    <EndoBox
      n={2}
      title="Sample dilution: from the vial to the cartridge"
      sub={
        <>
          Type the total you want (1:{fmt(stdTotal)} standard). Step 1 is Tris
          at the ratio you choose, step 3 is always 1:2 in BG600, and the sheet
          works out step 2 in LAL water to land on your total. Type the µL you
          take at each step; the amount to add is worked out. Every step is
          made in a {fmt(TUBE_UL / 1000)} mL tube. The MCS factor stays at 1.
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] table-fixed border-collapse">
          <colgroup>
            <col className="w-[36px]" />
            <col className="w-[96px]" />
            <col className="w-[112px]" />
            <col />
            <col />
            <col />
            <col className="w-[124px]" />
          </colgroup>
          <thead>
            <tr>
              <th className={TH} />
              <th className={TH}>Sample ID</th>
              <th className={TH}>
                Total<span className={UNIT}>1 : N into the cartridge</span>
              </th>
              {std.map((st, si) => {
                const tone = STEPS[si] ?? STEPS[0]
                return (
                  <th
                    key={si}
                    className={`${TH} !text-center shadow-[inset_0_3px_0_currentColor] ${tone.th}`}
                  >
                    Step {si + 1} · {tone.name}
                    <span className={`${UNIT} !whitespace-normal`}>
                      {st.diluent} · volumes in µL
                    </span>
                  </th>
                )
              })}
              <th className={`${TH} ${TH_CALC} border-l pl-3 pr-[22px]`}>
                Loaded
                <span className={`${UNIT} !whitespace-normal`}>mg/mL on the MCS</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((row, i) => {
              const s = row.sample
              const newGroup = i > 0 && keys[i] !== keys[i - 1]
              const cell = newGroup ? `${CELL} ${GROUP_RULE}` : CELL
              const plan = dilutionPlan(s, ctx)
              const lead = (
                <>
                  <td className={`${cell} px-1 text-center font-mono text-[11px] text-muted-foreground`}>
                    <WorkedTip tip={`Row ${row.n} on the Prep table; this section is grouped by total`}>
                      {row.n}
                    </WorkedTip>
                  </td>
                  <td
                    className={`${cell} pl-2 ${s.sampleId ? MONO : 'text-xs italic text-muted-foreground'}`}
                  >
                    {s.sampleId || 'no ID yet'}
                  </td>
                </>
              )

              if (formOf(s) === 'bac') {
                // Bac water is already a liquid: one straight 20x (the plan's
                // total), laid out like a step cell across the three steps.
                return (
                  <tr key={row.item.id} data-group-start={newGroup || undefined}>
                    {lead}
                    <td className={`${cell} pl-2.5 font-mono text-foreground/80`}>
                      1:{fmt(plan.total)}
                    </td>
                    <td colSpan={3} className={`${cell} border-l pl-2.5 pr-2`}>
                      <div className="flex flex-wrap items-start justify-between gap-x-2.5 gap-y-1">
                        <span className="text-xs font-semibold text-foreground/80">
                          Bacteriostatic water · one step
                        </span>
                        <span className="ml-auto inline-flex items-start gap-3.5">
                          <Slot cap="sample">
                            <span className="font-mono text-foreground/80">
                              {fmtUl(BW_SAMPLE_UL)}
                            </span>
                          </Slot>
                          <Slot cap="LAL water to add" end>
                            <span className="whitespace-nowrap font-mono font-semibold">
                              + {fmtUl(BW_LAL_UL)}
                            </span>
                          </Slot>
                        </span>
                      </div>
                      <div className="mt-[3px] font-mono text-[11px] text-muted-foreground">
                        1:{fmt(plan.total)} dilution · one tube · limit{' '}
                        {fmt(BW_LIMIT_EU_PER_ML)} EU/mL
                      </div>
                    </td>
                    <td className={`${cell} border-l pl-3 pr-[22px]`} />
                  </tr>
                )
              }

              const k = prep2Check(s, ctx)
              const ownTotal = plan.target !== stdTotal
              const totalTip =
                plan.total === null
                  ? 'This total cannot be made with the steps as typed'
                  : `${plan.steps.map(st => `1:${fmt(st.ratio)}`).join(' × ')} = 1:${fmt(plan.total)}` +
                    `\nMCS factor 1: type the reading as it prints and the sheet multiplies by ${fmt(plan.target)}` +
                    (ownTotal ? `\nThe standard is 1:${fmt(stdTotal)}; clear the cell to use it` : '')
              return (
                <tr key={row.item.id} data-group-start={newGroup || undefined}>
                  {lead}
                  <td
                    className={`${cell} pl-2.5 ${plan.total === null ? 'text-red-600 dark:text-red-400' : ''}`}
                  >
                    <WorkedTip
                      tip={totalTip}
                      className="flex items-center gap-0.5 font-mono text-foreground/80"
                    >
                      1:
                      <span className="block w-[4.4em]">
                        <PrepField
                          bare
                          label="Total dilution"
                          unit="1 in N"
                          value={row.item.prep_total_dilution ?? null}
                          overridden={row.item.prep_total_dilution != null}
                          computed={stdTotal}
                          disabled={isCompleted}
                          onCommit={v => commitTotal(row, v)}
                        />
                      </span>
                    </WorkedTip>
                    {plan.total === null && (
                      <div className="mt-[3px] text-[11px] font-semibold">
                        cannot be made as typed
                      </div>
                    )}
                  </td>
                  {plan.steps.map((st, si) => (
                    <StepCell
                      key={si}
                      st={st}
                      d={std[si] ?? st}
                      si={si}
                      cell={cell}
                      isCompleted={isCompleted}
                      onCommit={(field, v) => commitStep(row, si, field, v)}
                    />
                  ))}
                  <td
                    className={`${cell} border-l bg-teal-500/[0.06] pl-3 pr-[22px] text-right ${MONO} text-foreground/80`}
                  >
                    <WorkedTip tip={loadedTip(s, k)}>{fmtConc(k.loaded)}</WorkedTip>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </EndoBox>
  )
}

export default EndoSampleDilutionBox
```

- [ ] **Step 8: Mount Box 2 on the worksheet page**

In `src/components/hplc/endo/EndoWorksheetPage.tsx`, inside `EndoWorksheetPageBody` (Task 13, deviation 6):

1. Imports: add

```tsx
import type { EndoBoxProps } from './EndoBox'
import { EndoSampleDilutionBox } from './EndoSampleDilutionBox'
```

2. Directly after `const rows = endoRowsFor(ordered, worksheet, catalog)`, add:

```tsx
  const boxProps: EndoBoxProps = {
    worksheet,
    rows,
    ctx,
    cartridges,
    isCompleted,
    onUpdateItem: updateItem,
  }
```

(`updateItem` is a function declaration further down the body, so it is hoisted.)

3. Give `<EndoWorksheetView ... />` children: replace its closing `/>` with `>` and, before a new `</EndoWorksheetView>`, add

```tsx
        {worksheet.endo_prep === '2ml' && (
          <>
            <EndoSampleDilutionBox {...boxProps} />
          </>
        )}
```

`EndoWorksheetView` renders its children after Box 1 (Task 13). Item edits go through `updateItem` (the drawer's `updateItemMutation`, whose `mergeItemPatch` patches the page cache at once), so Box 2 needs no extra invalidation.

- [ ] **Step 9: Run the test to see it pass, then the neighbours and the typecheck**

Run: `npx vitest run src/components/hplc/endo/__tests__/EndoSampleDilutionBox.test.tsx`
Expected: PASS, 6 tests.

Run: `npx vitest run src/components/hplc src/lib/__tests__/endo-worksheet-2ml.test.ts src/lib/__tests__/endo-prep-2ml.test.ts`
Expected: PASS (the `EndoWorksheetTable` exports change nothing; Task 13's glue tests still pass with the appended helpers).

Run: `npm run typecheck && npx eslint src/components/hplc/endo src/components/hplc/EndoWorksheetTable.tsx src/lib/endo-worksheet-2ml.ts --max-warnings 0`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git -C C:/tmp/Accu-Mk1-endo-v2 add src/components/hplc/endo/EndoSampleDilutionBox.tsx src/components/hplc/endo/EndoWorkedTip.tsx src/components/hplc/endo/__tests__/endo-fixtures.ts src/components/hplc/endo/__tests__/EndoSampleDilutionBox.test.tsx
git -C C:/tmp/Accu-Mk1-endo-v2 diff --stat -- src/lib/endo-worksheet-2ml.ts src/components/hplc/EndoWorksheetTable.tsx src/components/hplc/endo/EndoWorksheetPage.tsx
git -C C:/tmp/Accu-Mk1-endo-v2 commit -m "feat(endo-v2): Box 2 sample dilution, grouped by total" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/hplc/endo/EndoSampleDilutionBox.tsx src/components/hplc/endo/EndoWorkedTip.tsx src/components/hplc/endo/__tests__/endo-fixtures.ts src/components/hplc/endo/__tests__/EndoSampleDilutionBox.test.tsx src/lib/endo-worksheet-2ml.ts src/components/hplc/EndoWorksheetTable.tsx src/components/hplc/endo/EndoWorksheetPage.tsx
```


---

### Task 15: Box 3, Results, the Reading input and the Accu-Mk1 value

**Files:**
- Create: `src/components/hplc/endo/EndoReadingInput.tsx`
- Create: `src/components/hplc/endo/EndoResultsBox.tsx`
- Create: `src/components/hplc/endo/__tests__/EndoReadingInput.test.tsx`
- Create: `src/components/hplc/endo/__tests__/EndoResultsBox.test.tsx`
- Modify: `src/components/hplc/endo/EndoWorksheetPage.tsx` (mount Box 3 under Box 2)

**Interfaces:**
- Consumes: `EndoBox`, `EndoBoxProps`, `EndoRow` (Task 13: `row.n` is the Box 1 number, `row.sample` the maths input, `row.cartridge.id` the row's resolved cartridge); `WorkedTip`, the `endoBoxProps` fixtures and the `TH`, `TH_CALC`, `UNIT`, `TD`, `MONO`, `TD_CALC` exports (Task 14); `prep2Check`, `prep2Result`, `mk1Value`, `parseReading`, `fmtEu`, `fmtConc`, `formOf`, `LIMIT_EU_PER_VIAL`, `BW_LIMIT_EU_PER_ML`, `EndoCheck`, `EndoResult`, `EndoSample`, `EndoCtx`, `EndoReaderRecord` (Task 8 as finished in part G3, with `EndoReaderRecord.result: string`, the reading exactly as the reader exported it, filled by `toReaderRecord`); `WorksheetItemPatch.result_reading`, `WorksheetItemPatch.cartridge_type_id`, item keys `cartridge_type_id`, `result_reading`, `result_reader` (Task 10); `listServiceSpecs`, `AnalysisServiceSpecRecord` (`api.ts`); `useAnalysisServices` (`src/services/analysis-services.ts`); `resolveServiceForAnalysis` (`src/components/senaite/AnalysisServiceLink.tsx`); `ruleLabel` (`ServiceSpecsSection.tsx`).
- Produces:
  - `EndoReadingInput({ value, placeholder, disabled, label, onCommit })`: valid means `parseReading` accepts it and nothing else (the server's `parse_reading` accepts exactly the same set: digits `[0-9]`, an optional `<` with optional spaces, trimmed; `<0` is refused by both). `<0.05`, `< 0.05` (saved as `<0.05`), `0.8`, `0` save; anything else stays in the cell with `aria-invalid` until fixed or Escape; emptying a saved reading commits `null`.
  - A typed reading that differs from the imported one (`parseReading(s.reading)` against `parseReading(s.reader.result)`) shows "the reader exported <0.05" under the cell. The verdict stays Invalid while `s.reader.valid` is false, whatever is typed (`prep2Result`).
  - Constants `VERDICT_LABEL` and `VERDICT_TONE` (Task 17 reuses them).
  - `EndoResultsBox(props: EndoBoxProps)`, drawing its chrome with `EndoBox` (`n` 3); Task 16 fills its `actions` with the reader drop zone.
  - Save payload: `{ result_reading }`, plus `cartridge_type_id: row.cartridge.id` (the row's resolved cartridge, Task 13's `EndoRow`) when the item has none of its own (spec 9). When no cartridge resolves, the save is refused on the client with a message rather than sent for a 400. Saves go through `onUpdateItem` (the drawer's `updateItemMutation`, whose `mergeItemPatch` updates the page cache), so no extra invalidation.

Layout values from Dennis's `renderResultRow2` and the `#results` header in `endotoxin.html`: table `min-width:1180px`; columns in his order on a 2 mL run: #, Sample ID, Declared wt, Cartridge, Loaded, MVD, MVC, Reading (his "Result as read"), Reader, EU/mg, LOD, LOQ, EU/vial, Limit, Verdict, Accu-Mk1 (spec 6.8 governs order; 6.1 lists EU/mg after LOQ). Calculated columns carry the derived tint (Box 1's `TH_CALC` / `TD_CALC`). Verdict colours his `--ok`, `--crit`, `--warn`. The Accu-Mk1 cell is his `td.mk1`: blue fill (`--mk1-soft #dfe9ff`, dark `#22304f`) with a 3px left edge (`--mk1-edge #3b6fd6`, dark `#8fb0ff`), mono 600, the unit small after the number, a click copies the number; an empty cell keeps a faint edge. The Reader cell reads `spike recovery % · the larger CV`, red when Invalid, the whole record on hover.

- [ ] **Step 1: Write the failing Reading input test**

Create `src/components/hplc/endo/__tests__/EndoReadingInput.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { EndoReadingInput } from '@/components/hplc/endo/EndoReadingInput'

// The reading drives the verdict and the value that goes to Accu-Mk1. A text
// the cell refuses must stay visible and marked, never snap back silently.

function renderInput(value: string | null = null, disabled = false) {
  const onCommit = vi.fn()
  render(
    <EndoReadingInput
      value={value}
      placeholder="<0.05"
      disabled={disabled}
      label="Reading for P-0001-S02"
      onCommit={onCommit}
    />
  )
  return { onCommit }
}

const input = () => screen.getByLabelText('Reading for P-0001-S02') as HTMLInputElement

describe('EndoReadingInput', () => {
  it.each([
    ['<0.05', '<0.05'],
    ['< 0.05', '<0.05'],
    ['0.8', '0.8'],
    ['0', '0'],
  ])('saves %s as %s', (typed, saved) => {
    const { onCommit } = renderInput()
    fireEvent.change(input(), { target: { value: typed } })
    fireEvent.blur(input())
    expect(onCommit).toHaveBeenCalledWith(saved)
    expect(input()).not.toHaveAttribute('aria-invalid')
  })

  it.each(['abc', '0,8', '-1', '<0', '<'])(
    'keeps %s in the cell, marked, and saves nothing',
    typed => {
      const { onCommit } = renderInput()
      fireEvent.change(input(), { target: { value: typed } })
      fireEvent.blur(input())
      expect(onCommit).not.toHaveBeenCalled()
      expect(input().value).toBe(typed)
      expect(input()).toHaveAttribute('aria-invalid', 'true')
    }
  )

  it('clears a saved reading when emptied, and Escape restores a refused one', () => {
    const { onCommit } = renderInput('0.8')
    fireEvent.change(input(), { target: { value: 'x' } })
    fireEvent.blur(input())
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(input().value).toBe('0.8')
    fireEvent.change(input(), { target: { value: '' } })
    fireEvent.blur(input())
    expect(onCommit).toHaveBeenCalledWith(null)
  })

  it('is plain text when disabled', () => {
    renderInput('<0.05', true)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('<0.05')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Write the failing Box 3 test**

Create `src/components/hplc/endo/__tests__/EndoResultsBox.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EndoResultsBox } from '@/components/hplc/endo/EndoResultsBox'
import type { EndoReaderRecord } from '@/lib/endo-prep-2ml'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import { endoBoxProps, endoItem } from './endo-fixtures'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getAnalysisServices: vi.fn().mockResolvedValue([
      { id: 61, title: 'Endotoxin (LAL)', keyword: 'ENDO-LAL', origin: 'mk1', active: true },
    ]),
    listServiceSpecs: vi.fn().mockResolvedValue([
      {
        id: 9,
        analysis_service_id: 61,
        matrix: 'Peptide',
        peptide_id: null,
        peptide_code: null,
        rule_kind: 'range',
        min_value: null,
        max_value: '5',
        equals_value: null,
        unit: 'EU/mL',
        display_override: null,
        loq: null,
        active: true,
        updated_at: null,
      },
    ]),
  }
})

const invalidReader: EndoReaderRecord = {
  test_id: 'T-9',
  result: '<0.05',
  reader: 'MCS-1234',
  slot: 2,
  operator: 'QA',
  tested_at: '2026-10-09 14:02',
  temp_start: 37,
  temp_end: 37.1,
  software: '1.0',
  cartridge_lot: 'L1',
  cartridge_expiry: '2027-01-31',
  cartridge_range: '5 - 0.05',
  spike_level: 0.8,
  recovery: 44,
  rec_min: 50,
  rec_max: 200,
  sample_cv: 3.1,
  spike_cv: 3.7,
  cv_limit: 25,
  reader_pass: false,
  valid: false,
  why: ['spike recovery 44 % outside 50-200 %'],
  file_name: 'EndoScanV-Export-2026-10-09.csv',
}

function setup(items: WorksheetItemRow[], isCompleted = false) {
  const { props, onUpdateItem } = endoBoxProps(items, {}, isCompleted)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  render(<EndoResultsBox {...props} />, { wrapper: wrap })
  return { onUpdateItem }
}

function rowOf(sampleId: string): HTMLElement {
  const row = screen.getByText(sampleId).closest('tr')
  if (!row) throw new Error(`no row for ${sampleId}`)
  return row
}

describe('EndoResultsBox', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders Pass, Fail, Inconclusive and Invalid, and the Accu-Mk1 value only when there is one', () => {
    setup([
      endoItem({ sample_id: 'P-0001-S02', result_reading: '<0.05' }),
      endoItem({ sample_id: 'P-0002-S02', result_reading: '0.8' }),
      endoItem({ sample_id: 'P-0003-S02', result_reading: '<1' }),
      endoItem({ sample_id: 'P-0004-S02', result_reading: '<0.05', result_reader: invalidReader }),
    ])
    // <0.05 x 250 x 2 mL = <25 EU/vial; 0.8 -> 400 > 350; <1 -> <500, a floor above the limit
    expect(within(rowOf('P-0001-S02')).getByText('Pass')).toBeInTheDocument()
    expect(within(rowOf('P-0002-S02')).getByText('Fail')).toBeInTheDocument()
    expect(within(rowOf('P-0003-S02')).getByText('Inconclusive')).toBeInTheDocument()
    expect(within(rowOf('P-0004-S02')).getByText('Invalid')).toBeInTheDocument()
    expect(
      within(rowOf('P-0001-S02')).getByRole('button', { name: 'Copy <25 for Accu-Mk1' })
    ).toBeInTheDocument()
    expect(within(rowOf('P-0004-S02')).queryByRole('button')).not.toBeInTheDocument()
    // the Reader cell: spike recovery and the larger CV
    expect(within(rowOf('P-0004-S02')).getByText('44 % · 3.7')).toBeInTheDocument()
  })

  it('says under the title what Mk1 reports today, read from the peptide spec tier', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    expect(
      await screen.findByText(
        "Accu-Mk1 values are per vial; Mk1's endotoxin test reports EU/mL against ≤ 5 EU/mL until the spec switch."
      )
    ).toBeInTheDocument()
  })

  it('flags a typed reading that differs from the reader, and keeps an invalid test Invalid', () => {
    setup([
      endoItem({
        sample_id: 'P-0001-S02',
        result_reading: '0.3',
        result_reader: invalidReader,
      }),
    ])
    const row = rowOf('P-0001-S02')
    expect(within(row).getByText('the reader exported <0.05')).toBeInTheDocument()
    expect(within(row).getByText('Invalid')).toBeInTheDocument()
  })

  it('saves the reading with the row cartridge when the item has none', () => {
    const bare = endoItem({ sample_id: 'P-0001-S02' })
    const own = endoItem({ sample_id: 'P-0002-S02', cartridge_type_id: 4, cartridge_sensitivity_eu_ml: 0.01 })
    const { onUpdateItem } = setup([bare, own])
    const first = screen.getByLabelText('Reading for P-0001-S02')
    fireEvent.change(first, { target: { value: '0.8' } })
    fireEvent.blur(first)
    expect(onUpdateItem).toHaveBeenCalledWith(bare.id, {
      result_reading: '0.8',
      cartridge_type_id: 3,
    })
    const second = screen.getByLabelText('Reading for P-0002-S02')
    fireEvent.change(second, { target: { value: '<0.01' } })
    fireEvent.blur(second)
    expect(onUpdateItem).toHaveBeenCalledWith(own.id, { result_reading: '<0.01' })
  })

  it('copies the Accu-Mk1 number on click', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    setup([endoItem({ sample_id: 'P-0001-S02', result_reading: '<0.05' })])
    fireEvent.click(screen.getByRole('button', { name: 'Copy <25 for Accu-Mk1' }))
    expect(writeText).toHaveBeenCalledWith('<25')
  })

  it('shows the worked line of a computed cell on hover', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02', result_reading: '<0.05' })])
    // EU/vial is the first "<25" in the row; the Accu-Mk1 button is the second
    const [euPerVial] = within(rowOf('P-0001-S02')).getAllByText('<25')
    if (!euPerVial) throw new Error('no EU/vial cell')
    await userEvent.setup().hover(euPerVial)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '<0.05 EU/mL on the MCS × 1:250 = <12.5 EU/mL of the vial solution × 2 mL = <25 EU'
    )
  })

  it('is read-only on a completed worksheet', () => {
    setup([endoItem({ sample_id: 'P-0001-S02', result_reading: '<0.05' })], true)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText('<0.05')).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run both tests to see them fail**

Run: `npx vitest run src/components/hplc/endo/__tests__/EndoReadingInput.test.tsx src/components/hplc/endo/__tests__/EndoResultsBox.test.tsx`
Expected: FAIL, `Failed to resolve import "@/components/hplc/endo/EndoReadingInput"` and `".../EndoResultsBox"`.

- [ ] **Step 4: Create the Reading input**

Create `src/components/hplc/endo/EndoReadingInput.tsx`:

```tsx
import { useState } from 'react'
import { parseReading } from '@/lib/endo-prep-2ml'

/**
 * The reading as it will be saved, or null when the text is not one.
 * parseReading is the only judge (the server's parse_reading accepts the
 * same set, "<0" refused by both); whitespace goes, so "< 0.05" saves as
 * "<0.05".
 */
function normalizeReading(text: string): string | null {
  const t = text.replace(/\s+/g, '')
  return parseReading(t) ? t : null
}

/**
 * The instrument reading, typed as the MCS shows it with the factor at 1:
 * "<0.05", "0.8", "0". Commits on blur or Enter; Escape throws the draft
 * away. A text that is not a reading stays in the cell, marked, until it is
 * fixed: it drives a verdict and the value that goes to Accu-Mk1, so it must
 * never snap back silently (the PrepField rule). Emptying a saved reading
 * clears it.
 */
export function EndoReadingInput({
  value,
  placeholder,
  disabled,
  label,
  onCommit,
}: {
  value: string | null
  placeholder: string
  disabled: boolean
  label: string
  onCommit: (reading: string | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [rejected, setRejected] = useState(false)

  if (disabled) {
    return <span className="font-mono tabular-nums">{value || '-'}</span>
  }

  function commit() {
    if (draft === null) return
    if (draft.trim() === '') {
      setDraft(null)
      setRejected(false)
      if (value) onCommit(null)
      return
    }
    const reading = normalizeReading(draft)
    if (reading === null) {
      setRejected(true)
      return
    }
    setDraft(null)
    setRejected(false)
    if (reading !== value) onCommit(reading)
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      aria-invalid={rejected || undefined}
      title={
        rejected
          ? `Not a reading: "${draft ?? ''}" was not saved. Type it as the instrument shows it (<0.05, 0.8 or 0), or press Escape.`
          : undefined
      }
      className={`h-7 w-full rounded-[3px] border bg-transparent px-1.5 text-right font-mono text-[12.5px] tabular-nums placeholder:text-muted-foreground/50 focus:bg-background focus:outline-none focus:ring-2 ${rejected ? 'border-red-500 bg-red-500/10 text-red-600 focus:ring-red-500/25' : 'border-transparent text-foreground hover:border-border focus:border-teal-500 focus:ring-teal-500/20'}`}
      value={draft ?? value ?? ''}
      placeholder={placeholder}
      onChange={e => {
        setDraft(e.target.value)
        setRejected(false)
      }}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(null)
          setRejected(false)
        }
      }}
    />
  )
}

export default EndoReadingInput
```

- [ ] **Step 5: Create Box 3**

Create `src/components/hplc/endo/EndoResultsBox.tsx`:

```tsx
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { listServiceSpecs, type AnalysisServiceSpecRecord } from '@/lib/api'
import { fmt } from '@/lib/endo-prep'
import {
  BW_LIMIT_EU_PER_ML,
  LIMIT_EU_PER_VIAL,
  fmtConc,
  fmtEu,
  formOf,
  mk1Value,
  parseReading,
  prep2Check,
  prep2Result,
  type EndoCheck,
  type EndoCtx,
  type EndoResult,
  type EndoSample,
} from '@/lib/endo-prep-2ml'
import type { EndoRow } from '@/lib/endo-worksheet-2ml'
import { useAnalysisServices } from '@/services/analysis-services'
import { resolveServiceForAnalysis } from '@/components/senaite/AnalysisServiceLink'
import { ruleLabel } from '@/components/hplc/ServiceSpecsSection'
import {
  MONO,
  TD,
  TD_CALC,
  TH,
  TH_CALC,
  UNIT,
} from '@/components/hplc/EndoWorksheetTable'
import { EndoReadingInput } from './EndoReadingInput'
import { EndoBox, type EndoBoxProps } from './EndoBox'
import { WorkedTip } from './EndoWorkedTip'

type Verdict = 'pass' | 'fail' | 'inconclusive' | 'invalid'

export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: 'Pass',
  fail: 'Fail',
  inconclusive: 'Inconclusive',
  invalid: 'Invalid',
}

// Dennis's --ok, --crit, --warn, --crit.
export const VERDICT_TONE: Record<Verdict, string> = {
  pass: 'text-emerald-600 dark:text-emerald-400',
  fail: 'text-red-600 dark:text-red-400',
  inconclusive: 'text-amber-600 dark:text-amber-400',
  invalid: 'text-red-600 dark:text-red-400',
}

/** "<2.5" for a derived value, nothing when there is none. */
const eu = (lt: boolean | null, v: number | null) => fmtEu(lt === true, v)

/** The peptide spec tier: the Peptide matrix row, else the All row. */
function peptideTier(
  specs: AnalysisServiceSpecRecord[] | undefined
): AnalysisServiceSpecRecord | null {
  const live = (specs ?? []).filter(s => s.active && s.peptide_id == null)
  return (
    live.find(s => s.matrix === 'Peptide') ??
    live.find(s => s.matrix == null) ??
    null
  )
}

/** Every computed cell's worked line, as Dennis's tip* helpers. */
function workedLines(s: EndoSample, k: EndoCheck, rs: EndoResult, bw: boolean) {
  const lam = fmt(k.lambda)
  const lt = rs.lt
  const rd = s.reader
  const why = (rd?.why ?? []).join('; ') || "failed the reader's checks"
  let verdict: string | null = null
  if (rs.verdict === 'invalid') {
    verdict = `Invalid test: ${why}. The reading proves nothing about the sample (USP <85>); rerun it, usually at a higher dilution`
  } else if (rs.verdict && bw) {
    verdict =
      rs.verdict === 'pass'
        ? `${eu(lt, rs.value)} EU/mL ≤ ${fmt(BW_LIMIT_EU_PER_ML)} EU/mL → Pass`
        : rs.verdict === 'fail'
          ? `${eu(lt, rs.value)} EU/mL > ${fmt(BW_LIMIT_EU_PER_ML)} EU/mL → Fail`
          : `A < reading whose floor is above ${fmt(BW_LIMIT_EU_PER_ML)} EU/mL proves nothing either way; a finer cartridge would`
  } else if (rs.verdict) {
    const v = `${eu(lt, rs.euPerVial)} EU/vial (${eu(lt, rs.euPerMg)} EU/mg)`
    verdict =
      rs.verdict === 'pass'
        ? `${v} ≤ ${LIMIT_EU_PER_VIAL} EU/vial limit → Pass`
        : rs.verdict === 'fail'
          ? `${v} > ${LIMIT_EU_PER_VIAL} EU/vial limit → Fail`
          : `${v}: a < result whose floor is above the ${LIMIT_EU_PER_VIAL} EU/vial limit proves nothing either way; a finer cartridge or more on the cartridge would`
  }
  return {
    cartridge:
      k.lambda === null
        ? null
        : `λ ${lam} EU/mL` +
          (k.valid === false
            ? `\nloaded ${fmtConc(k.loaded)} mg/mL is under the MVC ${fmtConc(k.mvc)}${k.needs !== null ? `; the ${fmt(k.needs)} cartridge holds it` : ''}`
            : '') +
          (k.failAt !== null ? `\na reading above ${fmt(k.failAt)} fails` : ''),
    loaded:
      k.loaded === null
        ? null
        : `${fmt(s.weightMg)} mg ÷ ${fmt(k.water)} mL ÷ ${fmt(k.dilution)} = ${fmtConc(k.loaded)} mg/mL on the MCS` +
          (k.mvc !== null ? `\nneeds ≥ ${fmtConc(k.mvc)} (the MVC for this vial)` : ''),
    mvd:
      k.mvd === null || !k.water
        ? null
        : `(${LIMIT_EU_PER_VIAL} EU/vial ÷ ${fmt(k.water)} mL = ${fmt(LIMIT_EU_PER_VIAL / k.water)} EU/mL) ÷ λ ${lam} EU/mL = ${fmt(k.mvd)}×\nyou use ${fmt(k.dilution)}×`,
    mvc:
      k.mvc === null || !s.weightMg
        ? null
        : `λ ${lam} EU/mL ÷ (${LIMIT_EU_PER_VIAL} EU/vial ÷ ${fmt(s.weightMg)} mg = ${fmt(LIMIT_EU_PER_VIAL / s.weightMg)} EU/mg) = ${fmtConc(k.mvc)} mg/mL` +
          (k.loaded !== null ? `\nloaded ${fmtConc(k.loaded)}` : ''),
    reader: !rd
      ? null
      : [
          rd.valid
            ? `Valid: spike recovery ${rd.rec_min ?? '-'}-${rd.rec_max ?? '-'} %, CV under ${rd.cv_limit ?? '-'} %`
            : `INVALID: ${why}`,
          `Spike recovery ${rd.recovery ?? '-'} % · sample CV ${rd.sample_cv ?? '-'} % · spike CV ${rd.spike_cv ?? '-'} %`,
          `Test ${rd.test_id} · ${rd.reader ?? '-'} (${rd.slot ?? '-'})`,
          `Cartridge lot ${rd.cartridge_lot ?? '-'}${rd.cartridge_expiry ? `, exp. ${rd.cartridge_expiry}` : ''} · ${rd.cartridge_range ?? '-'} EU/mL`,
          `${rd.operator ?? '-'} · ${rd.tested_at ?? '-'} · ${rd.temp_start ?? '-'}/${rd.temp_end ?? '-'} °C`,
          `From ${rd.file_name}`,
        ].join('\n'),
    euPerMg:
      bw || rs.euPerMg === null
        ? null
        : `${eu(lt, rs.euPerVial)} EU/vial ÷ ${fmt(s.weightMg)} mg = ${eu(lt, rs.euPerMg)} EU/mg`,
    lod:
      k.lod === null
        ? null
        : `LOD: ${fmt(k.lod)} EU/mL, the lowest value the ${lam} cartridge reads; the dilution does not change it`,
    loq: bw
      ? k.loqMl === null
        ? null
        : `LOQ: ${fmt(k.lod)} EU/mL × ${fmt(k.dilution)} = ${fmt(k.loqMl)} EU per mL of the bac water, the lowest this prep can report`
      : k.loqVial === null
        ? null
        : `LOQ: ${fmt(k.lod)} EU/mL × 1:${fmt(k.dilution)} × ${fmt(k.water)} mL = ${fmt(k.loqVial)} EU per vial, the lowest this prep can report`,
    euPerVial:
      bw || rs.euPerVial === null
        ? null
        : `${eu(lt, rs.value)} EU/mL on the MCS × 1:${fmt(k.dilution)} = ${eu(lt, rs.euPerMlVial)} EU/mL of the vial solution × ${fmt(k.water)} mL = ${eu(lt, rs.euPerVial)} EU`,
    limit: bw
      ? `${fmt(BW_LIMIT_EU_PER_ML)} EU per mL of the bac water (the USP limit for water for injection); above it the verdict is Fail\nThe worksheet's working limit, not yet the COA spec`
      : `${LIMIT_EU_PER_VIAL} EU per vial, flat: the whole vial as one dose\nThe worksheet's working limit, not yet the COA spec`,
    verdict,
    mk1Empty:
      rs.verdict === 'invalid'
        ? `Invalid test (${why}): nothing goes to Accu-Mk1 until it is rerun`
        : bw
          ? 'Bac water: its reading goes into Accu-Mk1 as EU/mL once it is typed'
          : formOf(s) === 'liquid' && k.water === null
            ? "Type the customer's reconstitution water first; EU/vial needs it"
            : 'Peptides go into Accu-Mk1 as EU/vial once a reading is typed',
  }
}

async function copyValue(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(`Copied ${value}`)
  } catch {
    toast.error('Could not copy; select the number and press Ctrl+C')
  }
}

function Calc({
  tip,
  className,
  children,
}: {
  tip: string | null
  className?: string
  children: ReactNode
}) {
  return (
    <td className={`${TD_CALC} ${className ?? ''}`}>
      <WorkedTip tip={tip}>{children}</WorkedTip>
    </td>
  )
}

function CellUnit({ children }: { children: ReactNode }) {
  return (
    <span className="ml-0.5 font-sans text-[10px] font-normal text-muted-foreground">
      {children}
    </span>
  )
}

function ResultRow({
  row,
  ctx,
  isCompleted,
  onReading,
}: {
  row: EndoRow
  ctx: EndoCtx
  isCompleted: boolean
  onReading: (reading: string | null) => void
}) {
  const s = row.sample
  const k = prep2Check(s, ctx)
  const rs = prep2Result(s, ctx)
  const mk = mk1Value(s, ctx)
  const bw = formOf(s) === 'bac'
  const rd = s.reader
  const tips = workedLines(s, k, rs, bw)
  const verdict = rs.verdict
  // A reading typed over an imported one keeps the reader's record; say so
  // when the two disagree (the record's validity still governs the verdict).
  const typed = parseReading(s.reading)
  const exported = rd ? parseReading(rd.result) : null
  const readerDiffers =
    rd !== null &&
    typed !== null &&
    (exported === null || exported.lt !== typed.lt || exported.value !== typed.value)
  return (
    <tr className="group/item hover:bg-teal-500/[0.04]">
      <td className={`${TD} pl-3 pr-1.5 text-right font-mono text-[11px] text-muted-foreground`}>
        {row.n}
      </td>
      <td className={`${TD} ${s.sampleId ? MONO : 'text-xs italic text-muted-foreground'}`}>
        {s.sampleId || 'no ID yet'}
      </td>
      <td className={`${TD} ${MONO} text-right text-foreground/80`}>
        {bw ? '' : fmt(s.weightMg)}
      </td>
      <td className={`${TD_CALC} !text-left`}>
        {k.lambda === null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <WorkedTip tip={tips.cartridge}>
            {fmt(k.lambda)}
            {k.valid === false && (
              <span
                className={`block whitespace-normal font-sans text-[11px] font-semibold leading-tight ${k.needs !== null ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}
              >
                {k.needs !== null ? `needs the ${fmt(k.needs)}` : 'no cartridge holds this'}
              </span>
            )}
          </WorkedTip>
        )}
      </td>
      <Calc tip={tips.loaded}>{fmtConc(k.loaded)}</Calc>
      <Calc tip={tips.mvd}>{k.mvd === null ? '' : `${fmt(k.mvd)}×`}</Calc>
      <Calc tip={tips.mvc}>{fmtConc(k.mvc)}</Calc>
      <td className={`${TD} w-[92px] px-1 text-right`}>
        <EndoReadingInput
          value={s.reading}
          placeholder={`<${fmt(k.floorShown ?? 0.05)}`}
          disabled={isCompleted}
          label={`Reading for ${row.item.sample_id}`}
          onCommit={onReading}
        />
        {rs.floorMismatch && (
          <div className="mt-[3px] max-w-[11em] text-[11px] leading-tight text-amber-600 dark:text-amber-400">
            not this cartridge&apos;s floor (expected &lt;{fmt(rs.expectedFloor)})
          </div>
        )}
        {readerDiffers && rd && (
          <div className="mt-[3px] max-w-[11em] text-[11px] leading-tight text-amber-600 dark:text-amber-400">
            the reader exported {rd.result}
          </div>
        )}
      </td>
      <Calc
        tip={tips.reader}
        className={rd && !rd.valid ? 'font-semibold !text-red-600 dark:!text-red-400' : ''}
      >
        {rd
          ? `${rd.recovery ?? '-'} % · ${fmt(Math.max(rd.sample_cv ?? 0, rd.spike_cv ?? 0))}`
          : ''}
      </Calc>
      <Calc tip={tips.euPerMg}>{bw ? '' : eu(rs.lt, rs.euPerMg)}</Calc>
      <Calc tip={tips.lod}>{fmt(k.lod)}</Calc>
      <Calc tip={tips.loq}>
        {bw ? (
          k.loqMl === null ? (
            ''
          ) : (
            <>
              {fmt(k.loqMl)}
              <CellUnit>/mL</CellUnit>
            </>
          )
        ) : (
          fmt(k.loqVial)
        )}
      </Calc>
      <Calc tip={tips.euPerVial}>{bw ? '' : eu(rs.lt, rs.euPerVial)}</Calc>
      <Calc tip={tips.limit}>
        {bw ? (
          <>
            {fmt(BW_LIMIT_EU_PER_ML)}
            <CellUnit>/mL</CellUnit>
          </>
        ) : (
          fmt(rs.limitPerVial ?? LIMIT_EU_PER_VIAL)
        )}
      </Calc>
      <td
        className={`${TD} whitespace-nowrap font-semibold ${verdict ? VERDICT_TONE[verdict] : ''}`}
      >
        {verdict && <WorkedTip tip={tips.verdict}>{VERDICT_LABEL[verdict]}</WorkedTip>}
      </td>
      {mk ? (
        <td
          className={`${TD} whitespace-nowrap border-l-[3px] border-l-blue-600 bg-blue-500/10 font-mono font-semibold dark:border-l-blue-300 dark:bg-blue-400/15`}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Copy ${mk.value} for Accu-Mk1`}
                className="cursor-copy focus-visible:outline-2 focus-visible:outline-blue-600"
                onClick={() => void copyValue(mk.value)}
              >
                {mk.value}
                <CellUnit>{mk.unit}</CellUnit>
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm p-0">
              <div className="p-3 font-mono text-xs">
                Into Accu-Mk1: {mk.value} {mk.unit}
                {bw ? ', bac water reports the reading itself' : ', peptides report EU per vial'}
                . Click to copy the number.
              </div>
            </TooltipContent>
          </Tooltip>
        </td>
      ) : (
        <td className={`${TD} border-l-[3px] border-l-blue-600/35 dark:border-l-blue-300/35`}>
          <WorkedTip tip={tips.mk1Empty} className="block min-h-5">
            {null}
          </WorkedTip>
        </td>
      )}
    </tr>
  )
}
```

Then the box itself, at the end of the same file:

```tsx
/**
 * Box 3, Results (2 mL worksheets only; stock worksheets have no Results
 * box), as Dennis's 2 mL Results section: the reading typed as the MCS shows
 * it, the reader's checks, and from them LOD, LOQ, EU/mg, EU per vial, the
 * verdict against the worksheet's working limits, and the value to enter in
 * Accu-Mk1 (blue, click to copy). Rows in bench order, numbered as Box 1.
 * Every computed cell shows its worked line on hover.
 */
export function EndoResultsBox({
  rows,
  ctx,
  isCompleted,
  onUpdateItem,
}: EndoBoxProps) {
  const services = useAnalysisServices().data
  const endoAnalysis = rows
    .flatMap(r => r.item.analyses)
    .find(a => /ENDO/i.test(a.keyword ?? ''))
  const service = endoAnalysis
    ? resolveServiceForAnalysis(
        {
          analysis_service_id: endoAnalysis.analysis_service_id ?? null,
          keyword: endoAnalysis.keyword,
        },
        services
      )
    : null
  const { data: specs } = useQuery({
    queryKey: ['analysis-services', service?.id, 'specs'],
    queryFn: () => listServiceSpecs(service?.id ?? 0),
    enabled: service != null,
    staleTime: 60_000,
  })

  if (!rows.length) return null
  const tier = peptideTier(specs)
  // Unit and limit come from the service's spec rows, never hardcoded: the
  // 09-01 snapshot (<= 5 EU/mL) is unverified against prod.
  const note = tier
    ? `Accu-Mk1 values are per vial; Mk1's endotoxin test reports ${tier.unit ?? 'its own unit'} against ${ruleLabel(tier)} until the spec switch.`
    : specs
      ? 'Accu-Mk1 values are per vial; the endotoxin test has no peptide spec set yet, so check its unit in Accu-Mk1 before entering a value.'
      : 'Accu-Mk1 values are per vial.'
  const p = ctx.params

  function saveReading(row: EndoRow, reading: string | null) {
    const { item } = row
    if (reading === null || item.cartridge_type_id != null) {
      onUpdateItem(item.id, { result_reading: reading })
      return
    }
    if (!row.cartridge) {
      toast.error(
        `${item.sample_id}: set the run cartridge (or this row's) before saving a reading`
      )
      return
    }
    onUpdateItem(item.id, {
      result_reading: reading,
      cartridge_type_id: row.cartridge.id,
    })
  }

  return (
    <EndoBox
      n={3}
      title="Results: EU per vial"
      sub={
        <>
          <span className="block font-medium text-foreground/80">{note}</span>
          Type the reading as the instrument shows it with the MCS factor at 1,
          with its &lt; if it has one: EU/mL of the step 3 tube. The sheet
          multiplies by the row&apos;s total (× {fmt(p.stdTotalDilution)}) for
          EU/mL of the vial solution and by the volume (× {fmt(p.reconWaterMl)}{' '}
          mL) for EU/vial; Pass is ≤ {LIMIT_EU_PER_VIAL} EU/vial. Bac water is
          typed as shown with its 20× applied, EU/mL of the bac water, and
          passes at ≤ {fmt(BW_LIMIT_EU_PER_ML)} EU/mL. These working limits are
          not yet the COA spec. The blue Accu-Mk1 column is the value to enter
          there: EU/vial for peptides, EU/mL for bac water; click it to copy.
          This section is not printed.
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] border-collapse">
          <thead>
            <tr>
              <th className={`${TH} w-[34px]`} />
              <th className={TH}>Sample ID</th>
              <th className={`${TH} !text-right`}>
                Declared wt<span className={UNIT}>mg</span>
              </th>
              <th className={`${TH} ${TH_CALC} !text-left`}>
                Cartridge<span className={UNIT}>λ EU/mL</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                Loaded<span className={UNIT}>mg/mL on the MCS</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                MVD<span className={UNIT}>×</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                MVC<span className={UNIT}>mg/mL</span>
              </th>
              <th className={`${TH} !text-right`}>
                Reading<span className={UNIT}>EU/mL on the MCS, factor 1</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                Reader<span className={UNIT}>spike rec. · CV</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>EU/mg</th>
              <th className={`${TH} ${TH_CALC}`}>
                LOD<span className={UNIT}>EU/mL, cartridge</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                LOQ<span className={UNIT}>EU/vial</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                EU/vial<span className={UNIT}>EU</span>
              </th>
              <th className={`${TH} ${TH_CALC}`}>
                Limit<span className={UNIT}>EU/vial</span>
              </th>
              <th className={TH}>Verdict</th>
              <th className={TH}>
                Accu-Mk1
                <span className="ml-1 rounded-full border border-blue-600 bg-blue-500/10 px-1.5 text-[10.5px] font-bold normal-case tracking-normal text-foreground dark:border-blue-300">
                  → Mk1
                </span>
                <span className={UNIT}>EU/vial · bac water EU/mL</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <ResultRow
                key={row.item.id}
                row={row}
                ctx={ctx}
                isCompleted={isCompleted}
                onReading={reading => saveReading(row, reading)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </EndoBox>
  )
}

export default EndoResultsBox
```

Every helper above is module-private except `VERDICT_LABEL`, `VERDICT_TONE` (constants, allowed by `allowConstantExport`) and the components.

- [ ] **Step 6: Mount Box 3 on the worksheet page**

In `src/components/hplc/endo/EndoWorksheetPage.tsx` (Task 14 added `boxProps` and the 2 mL children of `EndoWorksheetView`): add `import { EndoResultsBox } from './EndoResultsBox'` and, inside the same fragment, directly after `<EndoSampleDilutionBox {...boxProps} />`:

```tsx
            <EndoResultsBox {...boxProps} />
```

A 400 or 409 from the server surfaces through `updateItemMutation`'s toast, which since Task 10 carries the server's `detail`.

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run src/components/hplc/endo/__tests__/EndoReadingInput.test.tsx src/components/hplc/endo/__tests__/EndoResultsBox.test.tsx`
Expected: PASS, 11 tests in the input file (the two `it.each` tables expand to 4 and 5) and 7 in the box file.

Run: `npm run typecheck && npx eslint src/components/hplc/endo --max-warnings 0`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git -C C:/tmp/Accu-Mk1-endo-v2 add src/components/hplc/endo/EndoReadingInput.tsx src/components/hplc/endo/EndoResultsBox.tsx src/components/hplc/endo/__tests__/EndoReadingInput.test.tsx src/components/hplc/endo/__tests__/EndoResultsBox.test.tsx
git -C C:/tmp/Accu-Mk1-endo-v2 commit -m "feat(endo-v2): Box 3 results, reading input and Accu-Mk1 value" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/hplc/endo/EndoReadingInput.tsx src/components/hplc/endo/EndoResultsBox.tsx src/components/hplc/endo/__tests__/EndoReadingInput.test.tsx src/components/hplc/endo/__tests__/EndoResultsBox.test.tsx src/components/hplc/endo/EndoWorksheetPage.tsx
```


---

### Task 16: Reader import UI (drop zone, preview dialog, apply)

**Files:**
- Create: `src/components/hplc/endo/EndoReaderImportDialog.tsx`
- Create: `src/components/hplc/endo/__tests__/EndoReaderImportDialog.test.tsx`
- Modify: `src/components/hplc/endo/EndoResultsBox.tsx` (the drop zone in Box 3's `EndoBox` `actions`, the cache refresh from the response)

**Interfaces:**
- Consumes: `parseEndoScan`, `matchReaderTests` (as finished in part G3: returns `{ matched, unmatched, ambiguous, superseded }`, keeps only the latest test per row, pairs by the parent ID only when one side is the bare parent, so a reader `P-5299-S2` against a sheet `P-5299-S02`, or a different vial of the same parent, lands in `unmatched`; no fuzzy matching is added here), `readerValidity`, `readerCartridgeLambda`, `toReaderRecord` (fills `result`), `ReaderTest` (Task 9); `importReaderResults(worksheetId, body)` with `ReaderImportTest` (`record: EndoReaderRecord`) returning `{ applied, items, endo_method }` (Task 10, endpoint Task 7); `worksheetPageKey` (Task 10); `EndoRunParams` (Task 8); `EndoRow`, `EndoCartridgeOption` (Task 13, via `EndoBoxProps`); `endoBoxProps` fixtures, `TH`, `UNIT` (Task 14).
- Produces: `EndoReaderImportDialog({ worksheet, rows, cartridges, params, onApplied })`: the drop zone plus the preview `Dialog`, rendered in Box 3's `EndoBox` `actions`. `onApplied(res)` receives the response; Box 3 patches the page cache (`worksheetPageKey(id)`) with its items and `endo_method` at once, then invalidates the `['worksheets-list']` prefix once (which covers the page entry and the flyout list).
- Request it sends (spec 8.2): `{ file_name, tests: [{ item_id, reading: test.result, record: toReaderRecord(test, params, file_name), cartridge_type_id, replace }] }`. `cartridge_type_id` is the allowed type (`cartridges`, Task 13's list) whose `sensitivity_eu_ml` equals the file's cartridge lower bound (spec 8.3); with no range in the file, the row's resolved cartridge (`row.cartridge.id`). A test with no catalog match shows "cartridge not in the catalog" and is never sent. `replace` is true only for a ticked row that already holds a different reading. `matchReaderTests` keeps the latest test per row; the earlier ones (`superseded`) are listed and skipped, as are `unmatched` and `ambiguous` tests.

Layout values from Dennis's `.readerimp`, `.dropzone`, `renderReaderPreview` and `readerAction`: drop zone `border:1px dashed; padding:14px; font-size:12.5px; centred`, solid accent border and tint while a file is over it, wrapper padding `10px 14px 4px`; preview columns Reader sample, Product, Row on this sheet, Result (EU/mL on the MCS), Spike recovery (valid 50-200 %), CV (sample / spike, %), Check, What Apply does; plus Cartridge (spec 8.1). Skipped rows muted; out-of-range recovery red; "(reader flag differs)" when the reader's own flags disagree with the numbers; a 2 MB file cap.

- [ ] **Step 1: Write the failing test**

Create `src/components/hplc/endo/__tests__/EndoReaderImportDialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { EndoReaderImportDialog } from '@/components/hplc/endo/EndoReaderImportDialog'
import { importReaderResults } from '@/lib/api'
import { parseEndoScan, type ReaderTest } from '@/lib/endo-reader'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import { endoBoxProps, endoItem } from './endo-fixtures'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

// Only the file parser is stubbed: matching, validity, the cartridge range
// and the stored record run for real (Task 9).
vi.mock('@/lib/endo-reader', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/endo-reader')>()),
  parseEndoScan: vi.fn(),
}))

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  importReaderResults: vi.fn(),
}))

const FILE = 'EndoScanV-Export-2026-10-09.csv'

// A made-up test in the reader's shape; never real results.
function readerTest(over: Partial<ReaderTest> = {}): ReaderTest {
  return {
    testId: 'T1',
    sampleId: 'P-0001-S02',
    identity: 'Retatrutide',
    sampleType: 'Peptide',
    result: '<0.05',
    lt: true,
    value: 0.05,
    sampleCv: 3.1,
    spikeCv: 3.7,
    cvLimit: 25,
    recovery: 87,
    recMin: 50,
    recMax: 200,
    spikeLevel: 0.8,
    readerPass: true,
    operator: 'QA',
    testedAt: '2026-10-09 14:02',
    reader: 'MCS-1234',
    slot: 2,
    tempStart: 37,
    tempEnd: 37.1,
    cartLot: 'L1',
    cartExpiry: '2027-01-31',
    cartRange: '5 - 0.05',
    software: '1.0',
    ...over,
  }
}

function setup(items: WorksheetItemRow[]) {
  const { props } = endoBoxProps(items)
  const onApplied = vi.fn()
  render(
    <EndoReaderImportDialog
      worksheet={props.worksheet}
      rows={props.rows}
      cartridges={props.cartridges}
      params={props.ctx.params}
      onApplied={onApplied}
    />
  )
  return { onApplied }
}

function pick(name: string) {
  fireEvent.change(screen.getByLabelText('Reader export file'), {
    target: { files: [new File(['x'], name, { type: 'text/csv' })] },
  })
}

async function drop(tests: ReaderTest[]) {
  vi.mocked(parseEndoScan).mockReturnValueOnce({ tests, cartridges: [] })
  pick(FILE)
  return screen.findByRole('dialog')
}

describe('EndoReaderImportDialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('previews exact and by-vial matches, and lists ambiguous and unmatched tests', async () => {
    setup([
      endoItem({ sample_id: 'P-0001-S02' }),
      endoItem({ sample_id: 'P-0002-S02' }),
      endoItem({ sample_id: 'P-0003-S02' }),
      endoItem({ sample_id: 'P-0003-S03' }),
      endoItem({ sample_id: 'P-0005-S02' }),
    ])
    const dialog = await drop([
      readerTest({ testId: 'T1', sampleId: 'P-0001-S02' }),
      readerTest({ testId: 'T2', sampleId: 'P-0002' }),
      readerTest({ testId: 'T3', sampleId: 'P-0003' }),
      readerTest({ testId: 'T4', sampleId: 'P-9999' }),
      // a differently written vial and a different vial of a parent on the
      // sheet both fail safe: listed and skipped, never paired
      readerTest({ testId: 'T5', sampleId: 'P-0005-S2' }),
      readerTest({ testId: 'T6', sampleId: 'P-0005-S03' }),
    ])
    expect(within(dialog).getByText('P-0001-S02 · row 1')).toBeInTheDocument()
    expect(within(dialog).getByText('P-0002-S02 (by its vial) · row 2')).toBeInTheDocument()
    expect(within(dialog).getByText(/More than one vial on this sheet.*P-0003/)).toBeInTheDocument()
    expect(
      within(dialog).getByText('Not on this sheet, skipped: P-9999, P-0005-S2, P-0005-S03')
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Apply 2 readings' })).toBeEnabled()
  })

  it('lists an earlier test of a sample tested twice and applies only the later one', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    const dialog = await drop([
      readerTest({ testId: 'T1', sampleId: 'P-0001-S02', testedAt: '2026-10-09T10:00:00' }),
      readerTest({ testId: 'T2', sampleId: 'P-0001-S02', testedAt: '2026-10-09T14:00:00' }),
    ])
    expect(
      within(dialog).getByText('Earlier tests of a sample tested twice, skipped (the later one is used): T1')
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Apply 1 reading' })).toBeEnabled()
  })

  it('replaces a different reading only when its box is ticked', async () => {
    const a = endoItem({ sample_id: 'P-0001-S02', result_reading: '0.3' })
    setup([a])
    vi.mocked(importReaderResults).mockResolvedValue({ applied: 1, items: [a], endo_method: null })
    const dialog = await drop([readerTest({ sampleId: 'P-0001-S02', result: '<0.05' })])
    expect(within(dialog).getByText('has 0.3: tick to replace it')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Apply 0 readings' })).toBeDisabled()
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Replace the reading on P-0001-S02' })
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 reading' }))
    await vi.waitFor(() => expect(importReaderResults).toHaveBeenCalledTimes(1))
    expect(vi.mocked(importReaderResults).mock.calls[0]?.[1].tests[0]?.replace).toBe(true)
  })

  it('marks a test on a cartridge the method does not allow and never sends it', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    const dialog = await drop([readerTest({ sampleId: 'P-0001-S02', cartRange: '5 - 0.005' })])
    expect(within(dialog).getByText(/cartridge not in the catalog/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Apply 0 readings' })).toBeDisabled()
  })

  it('applies the matched tests in one request and hands the updated items back', async () => {
    const a = endoItem({ sample_id: 'P-0001-S02' })
    const { onApplied } = setup([a])
    const updated = { ...a, result_reading: '<0.05' }
    const res = { applied: 1, items: [updated], endo_method: null }
    vi.mocked(importReaderResults).mockResolvedValue(res)
    const dialog = await drop([readerTest({ testId: 'T1', sampleId: 'P-0001-S02' })])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 reading' }))
    await vi.waitFor(() => expect(onApplied).toHaveBeenCalledWith(res))
    expect(importReaderResults).toHaveBeenCalledWith(77, {
      file_name: FILE,
      tests: [
        {
          item_id: a.id,
          reading: '<0.05',
          record: expect.objectContaining({
            test_id: 'T1',
            result: '<0.05',
            reader: 'MCS-1234',
            slot: 2,
            valid: true,
            file_name: FILE,
          }),
          cartridge_type_id: 3,
          replace: false,
        },
      ],
    })
  })

  it('shows a readable message for a file that is not a reader export', async () => {
    setup([endoItem({ sample_id: 'P-0001-S02' })])
    vi.mocked(parseEndoScan).mockImplementationOnce(() => {
      throw new Error(
        'This is not a reader export: no test rows (channel 1-4, 79 columns) were found.'
      )
    })
    pick('notes.csv')
    expect(await screen.findByRole('alert')).toHaveTextContent('This is not a reader export')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run src/components/hplc/endo/__tests__/EndoReaderImportDialog.test.tsx`
Expected: FAIL, `Failed to resolve import "@/components/hplc/endo/EndoReaderImportDialog"`.

- [ ] **Step 3: Create the drop zone and preview dialog**

Create `src/components/hplc/endo/EndoReaderImportDialog.tsx`:

```tsx
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { importReaderResults, type WorksheetListItem } from '@/lib/api'
import { fmt } from '@/lib/endo-prep'
import type { EndoRunParams } from '@/lib/endo-prep-2ml'
import {
  matchReaderTests,
  parseEndoScan,
  readerCartridgeLambda,
  readerValidity,
  toReaderRecord,
  type ReaderTest,
} from '@/lib/endo-reader'
import type { EndoCartridgeOption, EndoRow } from '@/lib/endo-worksheet-2ml'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import { TH, UNIT } from '@/components/hplc/EndoWorksheetTable'

/** What the import returns: the applied count, the updated rows and the method. */
export type ReaderImportResult = Awaited<ReturnType<typeof importReaderResults>>

const MAX_FILE_BYTES = 2 * 1024 * 1024
const PCELL = 'border-b border-border/60 px-2 py-1.5 align-top'

type Action = 'fill' | 'replace' | 'same' | 'blocked'

interface PreviewRow {
  test: ReaderTest
  item: WorksheetItemRow
  /** The Box 1 row number. */
  n: number
  via: 'exact' | 'parent'
  valid: boolean
  why: string[]
  /** The file's cartridge sensitivity, or null when the file names none. */
  lambda: number | null
  cartridgeId: number | null
  action: Action
  note: string
}

interface Staged {
  fileName: string
  tests: ReaderTest[]
}

/**
 * What applying each test would do (Dennis's readerAction): each matched
 * test with its checks against the method's limits, the cartridge it maps
 * to, and fill / tick to replace / already imported / skipped.
 * matchReaderTests already keeps only the latest test per row.
 */
function buildPreview(
  tests: ReaderTest[],
  rows: EndoRow[],
  cartridges: EndoCartridgeOption[],
  params: EndoRunParams
) {
  const m = matchReaderTests(
    tests,
    rows.map(r => ({ itemId: r.item.id, sampleId: r.item.sample_id }))
  )
  const byItem = new Map(rows.map(r => [r.item.id, r]))
  const lines: PreviewRow[] = []
  for (const x of m.matched) {
    const row = byItem.get(x.itemId)
    if (!row) continue
    const item = row.item
    const { valid, why } = readerValidity(x.test, params)
    const lambda = readerCartridgeLambda(x.test.cartRange)
    const cartridgeId =
      lambda !== null
        ? (cartridges.find(c => Math.abs(c.sensitivity_eu_ml - lambda) < 1e-9)?.id ?? null)
        : (row.cartridge?.id ?? null)
    const had = item.result_reading ?? null
    let action: Action = 'fill'
    let note = 'fills the reading'
    if (lambda !== null && cartridgeId === null) {
      action = 'blocked'
      note = `cartridge not in the catalog (${fmt(lambda)} EU/mL)`
    } else if (cartridgeId === null) {
      action = 'blocked'
      note = 'no cartridge for this row: set the run cartridge first'
    } else if (had === x.test.result && item.result_reader?.test_id === x.test.testId) {
      action = 'same'
      note = 'already imported'
    } else if (had !== null && had !== x.test.result) {
      action = 'replace'
      note = `has ${had}: tick to replace it`
    }
    lines.push({
      test: x.test,
      item,
      n: row.n,
      via: x.via,
      valid,
      why,
      lambda,
      cartridgeId,
      action,
      note,
    })
  }
  return {
    lines,
    unmatched: m.unmatched,
    ambiguous: m.ambiguous,
    superseded: m.superseded,
  }
}

/**
 * The reader import on Box 3 (spec 8.1): drop the EndoScan-V export, or pick
 * it. The browser parses it and matches each test to a row by Sample ID
 * (exact, else the only vial of that parent on the sheet; never a guess
 * between two vials). The preview lists every test; nothing changes until
 * Apply, which sends one request. A row that already holds a different
 * reading is replaced only when its box is ticked. The raw file is not
 * stored; each row keeps the reader's record.
 */
export function EndoReaderImportDialog({
  worksheet,
  rows,
  cartridges,
  params,
  onApplied,
}: {
  worksheet: WorksheetListItem
  /** The page's rows (Box 1 order and numbers, each with its resolved cartridge). */
  rows: EndoRow[]
  /** The allowed cartridges (spec 4.3). */
  cartridges: EndoCartridgeOption[]
  params: EndoRunParams
  onApplied: (res: ReaderImportResult) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [staged, setStaged] = useState<Staged | null>(null)
  const [replace, setReplace] = useState<ReadonlySet<number>>(new Set())
  const [applying, setApplying] = useState(false)

  async function read(file: File | undefined) {
    if (!file) return
    setError(null)
    if (file.size > MAX_FILE_BYTES) {
      setError('That file is over 2 MB, too big for a reader export.')
      return
    }
    try {
      const parsed = parseEndoScan(await file.text())
      setReplace(new Set())
      setStaged({ fileName: file.name, tests: parsed.tests })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be read.')
    }
  }

  function close() {
    setStaged(null)
    setError(null)
    setReplace(new Set())
  }

  function toggle(itemId: number, on: boolean) {
    setReplace(prev => {
      const next = new Set(prev)
      if (on) next.add(itemId)
      else next.delete(itemId)
      return next
    })
  }

  const preview = staged
    ? buildPreview(staged.tests, rows, cartridges, params)
    : null
  const chosen = (preview?.lines ?? []).filter(
    (r): r is PreviewRow & { cartridgeId: number } =>
      r.cartridgeId !== null &&
      (r.action === 'fill' || (r.action === 'replace' && replace.has(r.item.id)))
  )

  async function apply() {
    if (!staged || !chosen.length) return
    setApplying(true)
    setError(null)
    try {
      const res = await importReaderResults(worksheet.id, {
        file_name: staged.fileName,
        tests: chosen.map(r => ({
          item_id: r.item.id,
          reading: r.test.result,
          record: toReaderRecord(r.test, params, staged.fileName),
          cartridge_type_id: r.cartridgeId,
          replace: r.action === 'replace',
        })),
      })
      onApplied(res)
      toast.success(
        `${res.applied} ${res.applied === 1 ? 'reading' : 'readings'} applied from ${staged.fileName}`
      )
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import failed; nothing was changed.')
    } finally {
      setApplying(false)
    }
  }

  return (
    <>
      <div
        onDragOver={e => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={e => {
          e.preventDefault()
          setOver(false)
          void read(e.dataTransfer.files[0])
        }}
        className={`rounded-[5px] border border-dashed p-3.5 text-center text-[12.5px] ${over ? 'border-solid border-teal-500 bg-teal-500/10 text-teal-800 dark:text-teal-200' : 'bg-muted/40 text-muted-foreground'}`}
      >
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv,text/plain"
          aria-label="Reader export file"
          className="sr-only"
          onChange={e => {
            const file = e.target.files?.[0]
            e.target.value = ''
            void read(file)
          }}
        />
        Reader export (EndoScan-V CSV): drop it here, or{' '}
        <button
          type="button"
          className="text-teal-700 underline underline-offset-2 hover:text-teal-600 focus-visible:outline-2 focus-visible:outline-teal-500 dark:text-teal-300"
          onClick={() => fileInput.current?.click()}
        >
          choose a file
        </button>
        . Each test is matched to its sample by Sample ID, with its spike
        recovery and CV.
        {error && !staged && (
          <p role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>

      <Dialog
        open={staged !== null}
        onOpenChange={open => {
          if (!open) close()
        }}
      >
        {staged && preview && (
          <DialogContent className="flex max-h-[88vh] w-[1100px] max-w-[96vw] flex-col gap-3 sm:max-w-[96vw]">
            <DialogTitle className="text-sm font-semibold">Reader import</DialogTitle>
            <DialogDescription className="font-mono text-[11.5px]">
              {staged.fileName} · {staged.tests.length}{' '}
              {staged.tests.length === 1 ? 'test' : 'tests'} read · nothing
              changes until Apply
            </DialogDescription>
            <div className="min-h-0 overflow-auto">
              <table className="w-full min-w-[900px] border-collapse text-[12.5px]">
                <thead>
                  <tr>
                    <th className={TH}>Reader sample</th>
                    <th className={TH}>Product</th>
                    <th className={TH}>Row on this sheet</th>
                    <th className={`${TH} !text-right`}>
                      Result<span className={UNIT}>EU/mL on the MCS</span>
                    </th>
                    <th className={`${TH} !text-right`}>
                      Spike recovery
                      <span className={UNIT}>
                        valid {params.spikeRecoveryMinPct}-{params.spikeRecoveryMaxPct} %
                      </span>
                    </th>
                    <th className={`${TH} !text-right`}>
                      CV<span className={UNIT}>sample / spike, %, limit {params.cvLimitPct}</span>
                    </th>
                    <th className={TH}>Check</th>
                    <th className={TH}>
                      Cartridge<span className={UNIT}>EU/mL, from the file</span>
                    </th>
                    <th className={TH}>What Apply does</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map(r => {
                    const t = r.test
                    const recOut =
                      t.recovery !== null &&
                      (t.recovery < params.spikeRecoveryMinPct ||
                        t.recovery > params.spikeRecoveryMaxPct)
                    const muted = r.action === 'blocked' || r.action === 'same'
                    return (
                      <tr
                        key={`${t.testId}-${r.item.id}`}
                        className={muted ? 'text-muted-foreground' : ''}
                      >
                        <td className={`${PCELL} font-mono`}>{t.sampleId || '(no ID)'}</td>
                        <td className={PCELL}>{t.identity}</td>
                        <td className={`${PCELL} font-mono`}>
                          {r.item.sample_id}
                          {r.via === 'parent' ? ' (by its vial)' : ''} · row {r.n}
                        </td>
                        <td className={`${PCELL} text-right font-mono`}>{t.result}</td>
                        <td
                          className={`${PCELL} text-right font-mono ${recOut ? 'font-semibold text-red-600 dark:text-red-400' : ''}`}
                        >
                          {t.recovery === null ? '-' : `${t.recovery} %`}
                        </td>
                        <td className={`${PCELL} text-right font-mono`}>
                          {t.sampleCv ?? '-'} / {t.spikeCv ?? '-'}
                        </td>
                        <td
                          className={`${PCELL} font-semibold ${r.valid ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
                        >
                          {r.valid ? 'Valid' : 'Invalid'}
                          {t.readerPass !== null && t.readerPass !== r.valid
                            ? ' (reader flag differs)'
                            : ''}
                          {!r.valid && (
                            <span className="block text-[11px] font-normal">
                              {r.why.join('; ')}
                            </span>
                          )}
                        </td>
                        <td className={`${PCELL} font-mono`}>
                          {r.lambda === null ? 'none in the file' : fmt(r.lambda)}
                        </td>
                        <td className={PCELL}>
                          {r.action === 'replace' ? (
                            <label className="inline-flex cursor-pointer items-center gap-1.5">
                              <Checkbox
                                checked={replace.has(r.item.id)}
                                onCheckedChange={v => toggle(r.item.id, v === true)}
                                aria-label={`Replace the reading on ${r.item.sample_id}`}
                              />
                              {r.note}
                            </label>
                          ) : (
                            r.note
                          )}
                          {!r.valid && !muted && (
                            <span className="block text-[11px] text-red-600 dark:text-red-400">
                              stored as Invalid: no Pass, nothing to Accu-Mk1; rerun it
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {preview.ambiguous.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                More than one vial on this sheet, skipped (type these by hand):{' '}
                {preview.ambiguous.map(t => t.sampleId).join(', ')}
              </p>
            )}
            {preview.superseded.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Earlier tests of a sample tested twice, skipped (the later one is
                used): {preview.superseded.map(t => t.testId).join(', ')}
              </p>
            )}
            {preview.unmatched.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Not on this sheet, skipped:{' '}
                {preview.unmatched.map(t => t.sampleId || '(no ID)').join(', ')}
              </p>
            )}
            {error && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <div className="flex items-center gap-2 border-t pt-3">
              <Button
                size="sm"
                className="bg-teal-600 text-white hover:bg-teal-600/90"
                disabled={!chosen.length || applying}
                onClick={() => void apply()}
              >
                Apply {chosen.length} {chosen.length === 1 ? 'reading' : 'readings'}
              </Button>
              <Button size="sm" variant="outline" onClick={close}>
                Discard
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}

export default EndoReaderImportDialog
```

In the unmatched list and the ambiguous list, `getByText` in the test reads the paragraph's own text nodes joined, so `Not on this sheet, skipped: P-9999` matches as one string.

- [ ] **Step 4: Put the drop zone in Box 3's `actions`**

In `src/components/hplc/endo/EndoResultsBox.tsx`:

1. Imports: change `import { useQuery } from '@tanstack/react-query'` to `import { useQuery, useQueryClient } from '@tanstack/react-query'`; change the `@/lib/api` import to `import { listServiceSpecs, type AnalysisServiceSpecRecord, type WorksheetListItem } from '@/lib/api'`; add `import { worksheetPageKey } from '@/hooks/use-worksheet-drawer'` and `import { EndoReaderImportDialog, type ReaderImportResult } from './EndoReaderImportDialog'`.
2. Destructure two more props: `export function EndoResultsBox({ worksheet, rows, ctx, cartridges, isCompleted, onUpdateItem }: EndoBoxProps)`.
3. Directly after the `const { data: specs } = useQuery({...})` call (before the early return, so the hook order is fixed), add:

```tsx
  const queryClient = useQueryClient()
```

4. Directly after `function saveReading(...) { ... }`, add:

```tsx
  // Refresh from the import response: the page cache gets the updated rows
  // and the (possibly just pinned) method at once, then the worksheets-list
  // prefix refetches once (the page entry and the flyout list).
  function applied(res: ReaderImportResult) {
    const byId = new Map(res.items.map(it => [it.id, it]))
    queryClient.setQueryData<WorksheetListItem>(worksheetPageKey(worksheet.id), ws =>
      ws
        ? {
            ...ws,
            endo_method: res.endo_method,
            items: ws.items.map(it => byId.get(it.id) ?? it),
          }
        : ws
    )
    void queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
  }
```

5. On the `<EndoBox n={3} ...>` element, add the `actions` prop:

```tsx
      actions={
        !isCompleted && (
          <div className="pt-2.5">
            <EndoReaderImportDialog
              worksheet={worksheet}
              rows={rows}
              cartridges={cartridges}
              params={ctx.params}
              onApplied={applied}
            />
          </div>
        )
      }
```

`EndoBox` renders `actions` inside its header, under the caption, where Dennis's `.readerimp` sits (above the table).

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run src/components/hplc/endo/__tests__/EndoReaderImportDialog.test.tsx src/components/hplc/endo/__tests__/EndoResultsBox.test.tsx`
Expected: PASS, 6 and 7 tests. (`EndoResultsBox.test.tsx` renders inside a `QueryClientProvider` already, which `useQueryClient` needs; its drop zone now renders in each open-worksheet case.)

Run: `npm run typecheck && npx eslint src/components/hplc/endo --max-warnings 0`
Expected: no errors (`ReaderImportTest.record` is `EndoReaderRecord` in Task 10, so `toReaderRecord`'s result assigns directly).

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-endo-v2 add src/components/hplc/endo/EndoReaderImportDialog.tsx src/components/hplc/endo/__tests__/EndoReaderImportDialog.test.tsx
git -C C:/tmp/Accu-Mk1-endo-v2 commit -m "feat(endo-v2): reader import drop zone, preview and apply on Box 3" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/hplc/endo/EndoReaderImportDialog.tsx src/components/hplc/endo/__tests__/EndoReaderImportDialog.test.tsx src/components/hplc/endo/EndoResultsBox.tsx
```


---

### Task 17: Read-only endo flyout summary, and the mixed-worksheet line on 2 mL

**Files:**
- Create: `src/components/hplc/endo/EndoFlyoutSummary.tsx`
- Create: `src/components/hplc/endo/__tests__/EndoFlyoutSummary.test.tsx`
- Create: `src/components/hplc/__tests__/EndoPrepLine2ml.test.tsx`
- Modify: `src/components/hplc/WorksheetDrawer.tsx` (endo branch, width)
- Modify: `src/components/hplc/WorksheetDrawerItems.tsx` (thread the worksheet to `EndoPrepLine`)
- Modify: `src/components/hplc/EndoPrepLine.tsx` (the 2 mL line)
- Modify: `src/components/hplc/__tests__/WorksheetDrawer.test.tsx` (a real width / branch test beside the existing `it.todo` list)

**Interfaces:**
- Consumes: `getWorksheet` (`api.ts`), `listConsumables` (Task 10); `worksheetPageKey` (Task 10); `navigateToWorksheet`, `worksheetPageId`, subsection `'worksheet'` (Task 13, `ui-store.ts`); `closeWorksheetDrawer` (`ui-store.ts`); `endoCtxFor(ws, catalog)`, `endoSampleFor(item, ws, catalog)`, `endoRowsFor`, `runCartridgeFor` (Task 13 glue); `prep2Result`, `prep2Check`, `mk1Value`, `dilutionPlan`, `formOf`, `fmtConc`, `FORMS`, `EndoVerdict` (Task 8); `VERDICT_LABEL`, `VERDICT_TONE` (Task 15); `STATUS_CHIP` (Task 14 export); `EndoWorksheetActions` (Task 18 makes its Print use the 2 mL sheet); `endoItemsInBenchOrder`, `endoIdentityFor`, `isEndoWorksheetItem`, `shortLabDate` (`endo-worksheet.ts`); `useSlaForSubjects`, `useLabCalendar`; item keys `prep_form`, `prep_water_ml`, `prep_total_dilution`, `result_reading`, worksheet keys `endo_prep`, `cartridge_sensitivity_eu_ml`, `endo_method` (Task 10).
- Produces:
  - `EndoFlyoutSummary({ worksheet, users })`: title, analyst, due, prep and run cartridge; counts (rows, Made, MCS, and on 2 mL results in, Invalid, ready for Mk1); a compact row list with status chips (and the verdict on 2 mL); Print (the existing `EndoWorksheetActions`: Preview, Print, CSV); **Open worksheet** (`closeWorksheetDrawer()` then `navigateToWorksheet(id)`). It reads the GET-by-id worksheet under the page's key, `worksheetPageKey(id)` (the list payload has no `endo_method`; mutations already refresh that key through the `['worksheets-list']` prefix), and the catalog under `['consumables', 'endo_cartridge']` when no method resolves; the results counts show `…` until the worksheet lands.
  - `WorksheetDrawer`: an all-endo worksheet (stock or 2 mL; spec 6.2) renders `EndoFlyoutSummary` and no longer widens; PCR keeps `w-[97vw] sm:max-w-[1760px]`; mixed and HPLC keep the 1100px drawer. Every caller that opens the flyout keeps working.
  - `EndoPrepLine` gains `worksheet?: WorksheetListItem`; on a 2 mL worksheet it shows Form, Water (mL) and Total (1:N) as inputs (Box 1's prep inputs) plus the row cartridge, Loaded and the tube / cartridge warnings, reading the GET-by-id worksheet and the catalog under the same keys as the page; otherwise the stock line, unchanged. `WorksheetDrawerItems` gains the same optional prop and threads it through `SortableItemRow`.

- [ ] **Step 1: Write the failing summary test**

Create `src/components/hplc/endo/__tests__/EndoFlyoutSummary.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EndoFlyoutSummary } from '@/components/hplc/endo/EndoFlyoutSummary'
import { getWorksheet, type WorksheetListItem } from '@/lib/api'
import type { EndoReaderRecord } from '@/lib/endo-prep-2ml'
import { useUIStore } from '@/store/ui-store'
import { endoItem, endoWorksheet } from './endo-fixtures'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getWorksheet: vi.fn(),
  listConsumables: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/hooks/use-lab-calendar', () => ({
  useLabCalendar: () => ({ calendar: null, isLoading: false }),
}))
vi.mock('@/services/sla-subjects', () => ({
  useSlaForSubjects: () => ({ byKey: new Map(), isLoading: false, isError: false }),
}))
vi.mock('@/components/hplc/EndoWorksheetActions', () => ({
  EndoWorksheetActions: () => <button type="button">Print</button>,
}))

const invalid: EndoReaderRecord = {
  test_id: 'T-9',
  result: '<0.05',
  reader: 'MCS-1234',
  slot: 2,
  operator: 'QA',
  tested_at: '2026-10-09 14:02',
  temp_start: 37,
  temp_end: 37.1,
  software: '1.0',
  cartridge_lot: 'L1',
  cartridge_expiry: '2027-01-31',
  cartridge_range: '5 - 0.05',
  spike_level: 0.8,
  recovery: 44,
  rec_min: 50,
  rec_max: 200,
  sample_cv: 3.1,
  spike_cv: 3.7,
  cv_limit: 25,
  reader_pass: false,
  valid: false,
  why: ['spike recovery 44 % outside 50-200 %'],
  file_name: 'EndoScanV-Export-2026-10-09.csv',
}

const stamp = '2026-10-09T18:00:00Z'

function fullWorksheet(over: Partial<WorksheetListItem> = {}) {
  return endoWorksheet(
    [
      endoItem({ sample_id: 'P-0001-S02', made_at: stamp, ran_at: stamp, result_reading: '<0.05' }),
      endoItem({ sample_id: 'P-0002-S02', made_at: stamp, result_reading: '0.8' }),
      endoItem({ sample_id: 'P-0003-S02', result_reading: '<0.05', result_reader: invalid }),
      endoItem({ sample_id: 'P-0004-S02' }),
    ],
    over
  )
}

function setup(full: WorksheetListItem) {
  vi.mocked(getWorksheet).mockResolvedValue(full)
  // the flyout is handed the list payload, which has no endo_method key
  const listed = { ...full, endo_method: undefined }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  render(<EndoFlyoutSummary worksheet={listed} users={[]} />, { wrapper: wrap })
}

function countOf(label: string): string | null | undefined {
  const counts = screen.getByLabelText('Run counts')
  return within(counts).getByText(label).nextElementSibling?.textContent
}

describe('EndoFlyoutSummary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('counts rows, ticks and, once the run settings load, results, Invalid and ready for Mk1', async () => {
    setup(fullWorksheet())
    expect(countOf('Rows')).toBe('4')
    expect(countOf('Made')).toBe('2/4')
    expect(countOf('MCS')).toBe('1/4')
    expect(countOf('Results in')).toBe('3/4')
    await vi.waitFor(() => expect(countOf('Ready for Mk1')).toBe('2/4'))
    expect(countOf('Invalid')).toBe('1')
    expect(getWorksheet).toHaveBeenCalledWith(77)
    expect(screen.getByText('Fail')).toBeInTheDocument()
  })

  it('opens the worksheet page and closes the flyout', () => {
    setup(fullWorksheet())
    useUIStore.setState({ worksheetDrawerOpen: true })
    fireEvent.click(screen.getByRole('button', { name: 'Open worksheet' }))
    const ui = useUIStore.getState()
    expect(ui.worksheetPageId).toBe(77)
    expect(ui.activeSubSection).toBe('worksheet')
    expect(ui.worksheetDrawerOpen).toBe(false)
  })

  it('shows no results counts on a stock worksheet', () => {
    setup(fullWorksheet({ endo_prep: 'stock' }))
    expect(screen.getByText('1 mg/mL stock')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Run counts')).queryByText('Results in')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Write the failing mixed-line test**

Create `src/components/hplc/__tests__/EndoPrepLine2ml.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EndoPrepLine } from '@/components/hplc/EndoPrepLine'
import { getWorksheet, type WorksheetListItem } from '@/lib/api'
import type { WorksheetItemRow } from '@/lib/endo-worksheet'
import { endoItem, endoWorksheet } from '@/components/hplc/endo/__tests__/endo-fixtures'

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getWorksheet: vi.fn(),
  listConsumables: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/hooks/use-lab-calendar', () => ({
  useLabCalendar: () => ({ calendar: null, isLoading: false }),
}))

function setup(ws: WorksheetListItem, item: WorksheetItemRow) {
  const onUpdate = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  render(
    <EndoPrepLine item={item} worksheet={ws} isCompleted={false} dueAt={null} onUpdate={onUpdate} />,
    { wrapper: wrap }
  )
  return { onUpdate }
}

describe('EndoPrepLine on a mixed worksheet', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the 2 mL water, total and cartridge when the worksheet is on 2 mL', () => {
    const item = endoItem({ sample_id: 'P-0001-S02' })
    const { onUpdate } = setup(endoWorksheet([item]), item)
    expect(screen.getByLabelText('Water (mL)')).toHaveAttribute('placeholder', '2')
    expect(screen.getByLabelText('Total (1:N)')).toHaveAttribute('placeholder', '250')
    expect(screen.getByText('0.05')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Water (mL)'), { target: { value: '3' } })
    fireEvent.blur(screen.getByLabelText('Water (mL)'))
    expect(onUpdate).toHaveBeenCalledWith({ prep_water_ml: 3 })
    expect(getWorksheet).not.toHaveBeenCalled()
  })

  it('keeps the stock line on a stock worksheet', () => {
    const item = endoItem({ sample_id: 'P-0001-S02' })
    setup(endoWorksheet([item], { endo_prep: 'stock' }), item)
    expect(screen.getByLabelText('Weight (mg)')).toBeInTheDocument()
    expect(screen.queryByLabelText('Water (mL)')).not.toBeInTheDocument()
  })

  it('reads the run settings by id when it was handed the list payload', async () => {
    const item = endoItem({ sample_id: 'P-0001-S02' })
    const full = endoWorksheet([item])
    vi.mocked(getWorksheet).mockResolvedValue(full)
    setup({ ...full, endo_method: undefined }, item)
    await vi.waitFor(() => expect(getWorksheet).toHaveBeenCalledWith(77))
  })
})
```

- [ ] **Step 3: Write the failing drawer test**

Replace the contents of `src/components/hplc/__tests__/WorksheetDrawer.test.tsx` with (the `it.todo` list is kept as it was):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorksheetDrawer } from '@/components/hplc/WorksheetDrawer'
import { useWorksheetDrawer } from '@/hooks/use-worksheet-drawer'
import type { WorksheetListItem } from '@/lib/api'
import { useUIStore } from '@/store/ui-store'

// Keep the module's other exports (worksheetPageKey, mergeItemPatch): the
// endo pieces import them.
vi.mock('@/hooks/use-worksheet-drawer', async importOriginal => ({
  ...(await importOriginal<typeof import('@/hooks/use-worksheet-drawer')>()),
  useWorksheetDrawer: vi.fn(),
}))
vi.mock('@/components/hplc/endo/EndoFlyoutSummary', () => ({
  EndoFlyoutSummary: () => <div>endo summary</div>,
}))
vi.mock('@/components/hplc/PcrWorksheetView', () => ({
  PcrWorksheetView: () => <div>pcr view</div>,
}))
vi.mock('@/components/hplc/BenchRunLog', () => ({ BenchRunLog: () => null }))
vi.mock('@/components/hplc/AddSamplesModal', () => ({ default: () => null }))
vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getWorksheetUsers: vi.fn().mockResolvedValue([]),
  getInstruments: vi.fn().mockResolvedValue([]),
  getMethods: vi.fn().mockResolvedValue([]),
}))

describe('WorksheetDrawer', () => {
  it.todo('renders FAB with item count badge (WSHT-01)')
  it.todo('opens Sheet on FAB click')
  it.todo('renders header with title, analyst, status, date, count (WSHT-01)')
  it.todo('shows complete confirmation dialog on Complete Worksheet click (WSHT-07)')
  it.todo('marks worksheet completed on confirm (WSHT-07)')
})

describe('WorksheetDrawer: bench kinds (endo v2)', () => {
  const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }

  function openWith(role: string): HTMLElement {
    const ws = {
      id: 1,
      title: 'WS 1',
      status: 'open',
      notes: null,
      assigned_analyst: null,
      assigned_analyst_email: null,
      item_count: 1,
      created_at: null,
      completed_at: null,
      items: [{ id: 11, sample_id: 'P-0001-S02', assignment_role: role, analyses: [] }],
    } as unknown as WorksheetListItem
    vi.mocked(useWorksheetDrawer).mockReturnValue({
      openWorksheets: [ws],
      activeWorksheet: ws,
      isResolvingActive: false,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      updateMutation: mutation,
      removeMutation: mutation,
      completeMutation: mutation,
      reassignMutation: mutation,
      updateItemMutation: mutation,
      bulkTicksMutation: mutation,
      freezeWellsMutation: mutation,
      unfreezeWellsMutation: mutation,
      addNoteMutation: mutation,
      applyMethodInstrumentMutation: mutation,
      reorderMutation: mutation,
      addItemMutation: mutation,
    } as unknown as ReturnType<typeof useWorksheetDrawer>)
    useUIStore.setState({ worksheetDrawerOpen: true, activeWorksheetId: 1 })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorksheetDrawer />
      </QueryClientProvider>
    )
    return screen.getByRole('dialog')
  }

  beforeEach(() => vi.clearAllMocks())

  it('shows the read-only endo summary at the 1100px width', () => {
    const sheet = openWith('endo')
    expect(screen.getByText('endo summary')).toBeInTheDocument()
    expect(sheet.className).toContain('sm:max-w-[1100px]')
    expect(sheet.className).not.toContain('sm:max-w-[1760px]')
  })

  it('keeps the PCR bench view at its wide width', () => {
    const sheet = openWith('pcr')
    expect(screen.getByText('pcr view')).toBeInTheDocument()
    expect(sheet.className).toContain('sm:max-w-[1760px]')
  })
})
```

- [ ] **Step 4: Run the three tests to see them fail**

Run: `npx vitest run src/components/hplc/endo/__tests__/EndoFlyoutSummary.test.tsx src/components/hplc/__tests__/EndoPrepLine2ml.test.tsx src/components/hplc/__tests__/WorksheetDrawer.test.tsx`
Expected: FAIL. The summary file cannot resolve `@/components/hplc/endo/EndoFlyoutSummary`; the mixed-line test finds no `Water (mL)` field; the drawer's endo case finds no `endo summary` and the 1760px width.

- [ ] **Step 5: Create the flyout summary**

Create `src/components/hplc/endo/EndoFlyoutSummary.tsx`:

```tsx
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  getWorksheet,
  listConsumables,
  type WorksheetListItem,
  type WorksheetUser,
} from '@/lib/api'
import { fmt, labDate } from '@/lib/endo-prep'
import { mk1Value, prep2Result, type EndoVerdict } from '@/lib/endo-prep-2ml'
import {
  endoCtxFor,
  endoRowsFor,
  runCartridgeFor,
} from '@/lib/endo-worksheet-2ml'
import { worksheetPageKey } from '@/hooks/use-worksheet-drawer'
import {
  endoIdentityFor,
  endoItemsInBenchOrder,
  isEndoWorksheetItem,
  shortLabDate,
} from '@/lib/endo-worksheet'
import { worksheetItemSlaSubjects } from '@/lib/worksheet-sla-subjects'
import { displayName } from '@/lib/user-display'
import { useLabCalendar } from '@/hooks/use-lab-calendar'
import { useSlaForSubjects } from '@/services/sla-subjects'
import { useUIStore } from '@/store/ui-store'
import { EndoWorksheetActions } from '@/components/hplc/EndoWorksheetActions'
import { STATUS_CHIP } from '@/components/hplc/EndoWorksheetTable'
import { VERDICT_LABEL, VERDICT_TONE } from './EndoResultsBox'

function Meta({
  label,
  mono,
  children,
}: {
  label: string
  mono?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-r px-3.5 py-2.5 last:border-r-0">
      <dt className="text-[9.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
        {label}
      </dt>
      <dd className={`truncate text-sm font-medium ${mono ? 'font-mono text-[12.5px]' : ''}`}>
        {children}
      </dd>
    </div>
  )
}

function Count({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
      <dt>{label}</dt>
      <dd className="font-mono text-[13px] font-medium tabular-nums text-foreground">
        {children}
      </dd>
    </div>
  )
}

function TickMark({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      role="img"
      aria-label={`${label}: ${on ? 'yes' : 'no'}`}
      className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border ${on ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'border-border text-transparent'}`}
    >
      <Check className="h-3 w-3" strokeWidth={3} />
    </span>
  )
}

/**
 * The endotoxin flyout, read-only (spec 6.2): the run at a glance and a way
 * to its page, where it is worked. Every caller that opens the flyout (flags,
 * the worksheets list, sample details, the main window) still lands here.
 * The list payload carries no endo_method, so the run settings come from GET
 * /worksheets/{id}, read under the page's own key; the results counts wait
 * for it rather than show numbers worked out on the wrong method.
 */
export function EndoFlyoutSummary({
  worksheet,
  users,
}: {
  worksheet: WorksheetListItem
  users: WorksheetUser[]
}) {
  const { data: full } = useQuery({
    queryKey: worksheetPageKey(worksheet.id),
    queryFn: () => getWorksheet(worksheet.id),
    staleTime: 30_000,
  })
  const ws = full ?? worksheet
  // With no method resolved, every active endo cartridge is allowed (4.3).
  const { data: catalog = [] } = useQuery({
    queryKey: ['consumables', 'endo_cartridge'],
    queryFn: () => listConsumables({ kind: 'endo_cartridge' }),
    enabled: ws.endo_method === null,
    staleTime: 5 * 60_000,
  })
  const { calendar } = useLabCalendar()
  const items = ws.items.filter(isEndoWorksheetItem)
  const { byKey } = useSlaForSubjects(
    worksheetItemSlaSubjects(items, ws.status === 'completed' ? ws.completed_at : null)
  )
  const dueAt = new Map(
    items.map(it => [it.id, byKey.get(String(it.id))?.status.due_at ?? null])
  )
  const rows = endoItemsInBenchOrder(items, dueAt, calendar)
  const twoMl = ws.endo_prep === '2ml'
  const ready = full !== undefined

  const judged = new Map<number, { verdict: EndoVerdict; toMk1: boolean }>()
  if (twoMl && ready) {
    const ctx = endoCtxFor(ws, catalog)
    for (const row of endoRowsFor(rows, ws, catalog)) {
      judged.set(row.item.id, {
        verdict: prep2Result(row.sample, ctx).verdict,
        toMk1: mk1Value(row.sample, ctx) !== null,
      })
    }
  }
  const n = rows.length
  const made = rows.filter(it => it.made_at).length
  const ran = rows.filter(it => it.ran_at).length
  const resultsIn = rows.filter(it => it.result_reading).length
  const verdicts = [...judged.values()]
  const invalid = verdicts.filter(v => v.verdict === 'invalid').length
  const toMk1 = verdicts.filter(v => v.toMk1).length
  const runDue =
    rows
      .map(it => (calendar ? labDate(dueAt.get(it.id), calendar) : null))
      .filter((d): d is string => !!d)
      .sort()[0] ?? null
  const analyst = users.find(u => u.id === ws.assigned_analyst)
  const lambda = runCartridgeFor(ws, catalog)?.sensitivity ?? null

  return (
    <div className="min-w-0 flex-1 space-y-4 overflow-y-auto px-6 pb-8 pt-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-[23px] font-semibold leading-tight tracking-tight">
            {ws.title}
          </h2>
          <span className="font-mono text-xs tracking-wide text-muted-foreground">
            WS-{ws.id} · {ws.status} · summary; the run is worked on its page
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <EndoWorksheetActions worksheet={ws} users={users} />
          <Button
            size="sm"
            className="bg-teal-600 text-white hover:bg-teal-600/90"
            onClick={() => {
              const ui = useUIStore.getState()
              ui.closeWorksheetDrawer()
              ui.navigateToWorksheet(ws.id)
            }}
          >
            Open worksheet
          </Button>
        </div>
      </div>

      <dl className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] overflow-hidden rounded-[5px] border bg-card shadow-sm">
        <Meta label="Analyst">
          {analyst ? displayName(analyst) : (ws.assigned_analyst_email ?? '-')}
        </Meta>
        <Meta label="Due" mono>
          {shortLabDate(runDue)}
        </Meta>
        <Meta label="Prep">{twoMl ? '2 mL' : '1 mg/mL stock'}</Meta>
        {twoMl && (
          <Meta label="Run cartridge" mono>
            {lambda === null ? '-' : `${fmt(lambda)} EU/mL`}
          </Meta>
        )}
      </dl>

      <dl
        aria-label="Run counts"
        className="flex flex-wrap gap-x-6 gap-y-2 rounded-[5px] border bg-muted/60 px-3.5 py-2.5"
      >
        <Count label="Rows">{n}</Count>
        <Count label="Made">{`${made}/${n}`}</Count>
        <Count label="MCS">{`${ran}/${n}`}</Count>
        {twoMl && (
          <>
            <Count label="Results in">{`${resultsIn}/${n}`}</Count>
            <Count label="Invalid">{ready ? invalid : '…'}</Count>
            <Count label="Ready for Mk1">{ready ? `${toMk1}/${n}` : '…'}</Count>
          </>
        )}
      </dl>

      <ol className="overflow-hidden rounded-[5px] border bg-card shadow-sm">
        {rows.map((it, i) => {
          const [statusLabel, statusClass] = STATUS_CHIP[it.prep_status] ??
            STATUS_CHIP.ready ?? ['', '']
          const v = judged.get(it.id)?.verdict ?? null
          const identity = endoIdentityFor(it)
          return (
            <li
              key={it.id}
              className="flex items-center gap-3 border-b px-3.5 py-1.5 text-[13px] last:border-b-0"
            >
              <span className="w-6 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                {i + 1}
              </span>
              <span className="w-[120px] shrink-0 font-mono text-[12.5px]">{it.sample_id}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={identity}>
                {identity || '-'}
              </span>
              <span
                className={`inline-block whitespace-nowrap rounded-[3px] border px-1.5 py-0.5 text-[11px] font-medium ${statusClass}`}
              >
                {statusLabel}
              </span>
              <TickMark on={!!it.made_at} label="Made" />
              <TickMark on={!!it.ran_at} label="MCS" />
              {twoMl && (
                <span
                  className={`w-[84px] shrink-0 text-right text-xs font-semibold ${v ? VERDICT_TONE[v] : 'text-muted-foreground'}`}
                >
                  {v ? VERDICT_LABEL[v] : '-'}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export default EndoFlyoutSummary
```

- [ ] **Step 6: Swap the endo branch in the drawer**

In `src/components/hplc/WorksheetDrawer.tsx`:

1. Replace `import { EndoWorksheetView } from './EndoWorksheetView'` with `import { EndoFlyoutSummary } from './endo/EndoFlyoutSummary'`.
2. Replace the comment and width above the `<SheetContent>` so only PCR widens:

```tsx
  const isCompleted = activeWorksheet?.status === 'completed'
  // Worksheets 2.0: an all-PCR worksheet gets its bench view, which needs the
  // room of a page. An all-endo worksheet shows a read-only summary here and
  // is worked on its own page (endo v2, spec 6.2); every other worksheet keeps
  // the 1100px drawer.
  const kind = activeWorksheet ? worksheetKind(activeWorksheet.items) : null
  const isEndo = kind === 'endo'
  const isPcr = kind === 'pcr'
  const isBench = isEndo || isPcr
```

and in `<SheetContent ...>`:

```tsx
          className={`p-0 flex flex-col ${isPcr ? 'w-[97vw] sm:max-w-[1760px]' : 'w-[1100px] sm:max-w-[1100px]'}`}
```

3. Replace the whole `{/* Endotoxin worksheet: Dennis's run log + sheet (Worksheets 2.0) */}` block (the `BenchRunLog` + `EndoWorksheetView` + `AddSamplesModal` branch for `isEndo`) with:

```tsx
          {/* Endotoxin worksheet: a read-only summary; the run is worked on its page (endo v2, spec 6.2) */}
          {!isLoading && !isError && activeWorksheet && isEndo && (
            <div className="flex flex-1 min-h-0 overflow-hidden bg-muted/30">
              <EndoFlyoutSummary worksheet={activeWorksheet} users={users} />
            </div>
          )}
```

4. On the `<WorksheetDrawerItems ... />` call in the generic (`!isBench`) branch, add `worksheet={activeWorksheet}`.

`isBench` keeps its use in the generic branch's `!isBench` guard; `BenchRunLog`, `AddSamplesModal`, `completeAction` and `handleUpdateWorksheet` stay in use by the PCR and generic branches, so nothing becomes unused. `EndoWorksheetView` is no longer imported here; the worksheet page (Task 13) renders it for Box 1 and editing. If Task 13 reshaped the endo branch (it exported `CompleteWorksheetButton` and `WorksheetApplyBar` from this file), replace whatever the `isEndo &&` branch renders now with the block above.

- [ ] **Step 7: Thread the worksheet to the endo line**

In `src/components/hplc/WorksheetDrawerItems.tsx`:

1. In `interface WorksheetDrawerItemsProps`, after `onReorder: (itemIds: number[]) => void`, add:

```tsx
  /** The worksheet the items belong to: the endo line reads its prep (2 mL or stock). */
  worksheet?: WorksheetListItem
```

2. Add `worksheet,` to the destructured props of `WorksheetDrawerItems`, and `worksheet={worksheet}` to the `<SortableItemRow ... />` call.
3. In `interface SortableItemRowProps`, after `onUpdateItem: ...`, add `worksheet?: WorksheetListItem`; add `worksheet,` to `SortableItemRow`'s destructured props.
4. On the `<EndoPrepLine ... />` call at the end of `SortableItemRow`, add `worksheet={worksheet}`.

- [ ] **Step 8: Give `EndoPrepLine` its 2 mL line**

In `src/components/hplc/EndoPrepLine.tsx`:

1. Imports: add

```tsx
import { useQuery } from '@tanstack/react-query'
import {
  FORMS,
  dilutionPlan,
  fmtConc,
  formOf,
  prep2Check,
  type EndoForm,
} from '@/lib/endo-prep-2ml'
import { endoCtxFor, endoSampleFor } from '@/lib/endo-worksheet-2ml'
import { worksheetPageKey } from '@/hooks/use-worksheet-drawer'
```

and replace `import type { WorksheetItemPatch } from '@/lib/api'` with:

```tsx
import {
  getWorksheet,
  listConsumables,
  type ConsumableType,
  type WorksheetItemPatch,
  type WorksheetListItem,
} from '@/lib/api'
```

2. Replace `interface EndoPrepLineProps` and the first lines of `EndoPrepLine`, up to and including the `const skipped = ...` line, with:

```tsx
interface EndoPrepLineProps {
  item: WorksheetItemRow
  isCompleted: boolean
  /** SLA `due_at` for this item, or null. */
  dueAt: string | null
  onUpdate: (data: WorksheetItemPatch) => void
  /** The worksheet the item is on. On a 2 mL worksheet the line shows the
   *  2 mL prep (spec 6.3); without it, or on stock, the stock line. */
  worksheet?: WorksheetListItem
}

export function EndoPrepLine({
  item,
  isCompleted,
  dueAt,
  onUpdate,
  worksheet,
}: EndoPrepLineProps) {
  const { calendar } = useLabCalendar()
  const twoMl = worksheet?.endo_prep === '2ml'
  // The list payload has no endo_method; the 2 mL figures need the run's
  // method and cartridges, which only GET /worksheets/{id} carries.
  const { data: full } = useQuery({
    queryKey: worksheetPageKey(worksheet?.id ?? 0),
    queryFn: () => getWorksheet(worksheet?.id ?? 0),
    enabled: twoMl && worksheet?.endo_method === undefined,
    staleTime: 30_000,
  })
  const runWs = full ?? worksheet
  // With no method resolved, every active endo cartridge is allowed (4.3).
  const { data: catalog = [] } = useQuery({
    queryKey: ['consumables', 'endo_cartridge'],
    queryFn: () => listConsumables({ kind: 'endo_cartridge' }),
    enabled: twoMl && runWs?.endo_method === null,
    staleTime: 5 * 60_000,
  })
  const prep = endoPrepFor(item)
  const received = calendar ? labDate(item.date_received, calendar) : null
  const due = calendar ? labDate(dueAt, calendar) : null
  const skipped = calendar ? holidaysBetween(received, due, calendar) : []

  if (twoMl && runWs) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2 pl-[52px] text-[11px] text-muted-foreground">
        <Stat label="Received" value={shortLabDate(received)} />
        <Stat
          label="Due"
          value={`${shortLabDate(due)}${skipped.length ? '*' : ''}`}
          title={
            skipped.length
              ? `Pushed past ${skipped.map(h => h.name).join(', ')}`
              : undefined
          }
          strong
        />
        <EndoPrep2mlFields
          item={item}
          worksheet={runWs}
          catalog={catalog}
          isCompleted={isCompleted}
          onUpdate={onUpdate}
        />
      </div>
    )
  }
```

The stock `return (...)` that follows is unchanged.

3. Add this component after `EndoPrepFields`:

```tsx
/**
 * The 2 mL prep on a mixed worksheet's endo line: Box 1's prep inputs (Form,
 * Water, Total) and what they give, the row's cartridge and what lands on it,
 * with the tube and cartridge warnings. The figures come from
 * src/lib/endo-prep-2ml.ts, as on the worksheet page and the 2 mL sheet. The
 * row's cartridge is shown, not picked (the picker is on the worksheet page).
 */
export function EndoPrep2mlFields({
  item,
  worksheet,
  catalog,
  isCompleted,
  onUpdate,
}: {
  item: WorksheetItemRow
  worksheet: WorksheetListItem
  catalog: ConsumableType[]
  isCompleted: boolean
  onUpdate: (data: WorksheetItemPatch) => void
}) {
  const ctx = endoCtxFor(worksheet, catalog)
  const s = endoSampleFor(item, worksheet, catalog)
  const form = formOf(s)
  const k = prep2Check(s, ctx)
  const plan = dilutionPlan(s, ctx)
  const stdTotal = ctx.params.stdTotalDilution
  return (
    <>
      <span className="inline-flex items-center gap-1">
        <span className="uppercase tracking-wider text-[9px] font-semibold">Form</span>
        <select
          aria-label="Form"
          disabled={isCompleted}
          value={item.prep_form ?? ''}
          onChange={e =>
            onUpdate({
              prep_form: (e.target.value || null) as EndoForm | null,
            })
          }
          className="h-6 rounded border border-transparent bg-transparent px-1 text-[11px] text-foreground hover:border-border focus:border-teal-500 focus:outline-none disabled:opacity-100"
        >
          <option value="">
            {`Auto (${FORMS.find(f => f[0] === form)?.[1] ?? form})`}
          </option>
          {FORMS.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </span>
      {form !== 'bac' && (
        <PrepField
          label="Water"
          unit="mL"
          value={item.prep_water_ml ?? null}
          overridden={item.prep_water_ml != null}
          computed={form === 'liquid' ? null : ctx.params.reconWaterMl}
          disabled={isCompleted}
          onCommit={v => onUpdate({ prep_water_ml: v })}
        />
      )}
      {form !== 'bac' && (
        <PrepField
          label="Total"
          unit="1:N"
          value={item.prep_total_dilution ?? null}
          overridden={item.prep_total_dilution != null}
          computed={stdTotal}
          disabled={isCompleted}
          onCommit={v => onUpdate({ prep_total_dilution: v === stdTotal ? null : v })}
        />
      )}
      <Stat
        label="Cartridge"
        value={s.lambda === null ? '-' : fmt(s.lambda)}
        unit="EU/mL"
        strong
      />
      {form === 'bac' ? (
        <Stat label="Dilution" value={`1:${fmt(plan.total)}`} />
      ) : (
        <Stat label="Loaded" value={fmtConc(k.loaded) || '-'} unit="mg/mL" />
      )}
      {!plan.fits && (
        <span className="rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400">
          Over the 1.5 mL tube
        </span>
      )}
      {k.valid === false && (
        <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
          {k.needs !== null ? `Needs the ${fmt(k.needs)} cartridge` : 'No cartridge holds this'}
        </span>
      )}
    </>
  )
}
```

(`Stat`, `PrepField` and `fmt` are already in this file / its imports.)

- [ ] **Step 9: Run the tests to see them pass, plus the existing hplc tests**

Run: `npx vitest run src/components/hplc/endo/__tests__/EndoFlyoutSummary.test.tsx src/components/hplc/__tests__/EndoPrepLine2ml.test.tsx src/components/hplc/__tests__/WorksheetDrawer.test.tsx`
Expected: PASS, 3, 3 and 2 tests (plus the 5 todos).

Run: `npx vitest run src/components/hplc src/test/worksheets-inbox-lanes.test.tsx`
Expected: PASS; the PCR tests (`PcrSampleList`, `PcrRunTick`) and `PrepField` are unchanged.

Run: `npm run typecheck && npx eslint src/components/hplc --max-warnings 0`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git -C C:/tmp/Accu-Mk1-endo-v2 add src/components/hplc/endo/EndoFlyoutSummary.tsx src/components/hplc/endo/__tests__/EndoFlyoutSummary.test.tsx src/components/hplc/__tests__/EndoPrepLine2ml.test.tsx
git -C C:/tmp/Accu-Mk1-endo-v2 diff --stat -- src/components/hplc/WorksheetDrawer.tsx src/components/hplc/WorksheetDrawerItems.tsx src/components/hplc/EndoPrepLine.tsx
git -C C:/tmp/Accu-Mk1-endo-v2 commit -m "feat(endo-v2): read-only endo flyout summary; 2 mL line on mixed worksheets" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/hplc/endo/EndoFlyoutSummary.tsx src/components/hplc/endo/__tests__/EndoFlyoutSummary.test.tsx src/components/hplc/__tests__/EndoPrepLine2ml.test.tsx src/components/hplc/__tests__/WorksheetDrawer.test.tsx src/components/hplc/WorksheetDrawer.tsx src/components/hplc/WorksheetDrawerItems.tsx src/components/hplc/EndoPrepLine.tsx
```


---

### Task 18: The 2 mL bench sheet, its summary page and CSV, and the identity-label trace

**Files:**
- Create: `src/lib/endo-bench-sheet-2ml.ts`
- Create: `src/lib/__tests__/endo-bench-sheet-2ml.test.ts`
- Modify: `src/lib/endo-bench-sheet.ts` (export six existing helpers; output unchanged)
- Modify: `src/components/hplc/EndoWorksheetActions.tsx` (pick the 2 mL builder on a 2 mL worksheet)

**Interfaces:**
- Consumes: `endoRowsFor`, `endoCtxFor`, `runCartridgeFor` (Task 13 glue, with the optional catalog); `standardSteps`, `totalGroupKey`, `BW_SAMPLE_UL`, `BW_LAL_UL` (Task 14); `dilutionPlan`, `prep2Check`, `prep2Result`, `mk1Value`, `orderByTotal`, `formOf`, `fmtConc`, `fmtEu`, `TUBE_UL`, `BW_DILUTION`, `EndoSample`, `EndoCtx`, `EndoCheck`, `EndoResult`, `EndoStepPlan`, `ENDO_RUN_PARAM_DEFAULTS` (Task 8); `splitIdentity` (Task 9, whose test file carries Dennis's 952 asserts); `getWorksheet`, `listConsumables`, `ConsumableType`, `worksheetPageKey` (Task 10); `escapeHtml`, `csvField`, `ENDO_SHEET_ROWS_PER_PAGE` and (exported here) `SHEET_CSS`, `PREVIEW_CSS`, `shortDate`, `longDate`, `priorityKey`, `PRIORITY_LABEL` (`endo-bench-sheet.ts`); `endoItemsInBenchOrder`, `endoIdentityFor`, `endoDueFor`, `shortOrder`, `EndoSheetOptions` (`endo-worksheet.ts`); `fmt`, `fmtUl`, `labDate`, `holidaysBetween` (`endo-prep.ts`); the `endoItem` / `endoWorksheet` fixtures (Task 14).
- Produces (`src/lib/endo-bench-sheet-2ml.ts`):
  - `interface EndoSheet2Row { n; due; dueHoliday; priority; received; order; identityAsReceived; sample: EndoSample }` and `interface EndoSheet2Doc { title; runName; analyst; dateMade; orders; printedAt; runLambda: number | null; ctx: EndoCtx; rows: EndoSheet2Row[]; holidayNotes }`; `type TextMeasure = (text: string, font: string) => number`.
  - `buildEndoSheet2Doc(ws, opts: EndoSheetOptions, catalog: ConsumableType[] = []): EndoSheet2Doc` (rows in Box 1 order through `endoRowsFor`, so paper and screen resolve the same cartridge).
  - `buildEndoBenchSheet2Html(doc, { preview?, measure? }): string` (spec 7: Dennis's 2 mL `buildPrintDoc` at `5ef2a62`).
  - `buildEndoCsv2(doc): string` (spec 7: Dennis's 2 mL CSV, formula-defused through the stock `csvField`).
  - `productIdentity(raw): string` (Mk1's assay suffix cut from each analyte of a comma-joined identity; outcome A of Step 1).
- `EndoWorksheetActions`: on `endo_prep === '2ml'` Preview, Print and CSV build the 2 mL sheet from the GET-by-id worksheet (`worksheetPageKey(id)`; fetched when it was handed the list payload, whose `endo_method` key is absent) and the catalog when no method resolves; buttons wait for both. Stock worksheets build exactly what they build today.

What is ported from Dennis's `buildPrintDoc` / summary / CSV for 2 mL runs, and what is not:
- Columns and widths (his 2 mL colgroup, sums to 100%): `#` 3.22%, Due · priority 11.5%, Cart. 5.65%, Order # 5.75%, Sample ID 9.44%, Peptide 9.47%, Recon water 5.4%, the three steps 13.79% each, Made 4.1%, MCS 4.1%. The Due cell holds the date over the Priority pill (`.duepill`, 9.5pt); Peptide prints the declared mg under the name (`.mg`, 600 10pt figure font); the step headings carry their standard ratio and a 3pt bar in the step colour.
- Rows printed in `orderByTotal` order with `tr.newtotal` (a 2pt inset rule, no added height) where the total changes; the printed number is `row.n` (Box 1's).
- Marks: a value set by hand (an own step volume, or a recon water other than the method's) prints bold and underlined (`td.step.own .num`, `td.own`); a step whose volumes are not the standard is boxed in its step colour (`td.step.diff`) with its ratio as the note (Dennis's eb4ee43: the ratio alone); a step over the 1.5 mL tube prints its ratio and "over 1.5 mL" and is boxed in red; a step that cannot be made prints "cannot be made" boxed in red; bac water prints one "50 + 950" cell across the three steps ("bac water · 1:20 · one tube").
- Summary: Samples, Off the standard, 0.1 M Tris, LAL water, BG600 and 1.5 mL tubes tiles (`.tiles.six`); Priority and Due columns as the stock summary; the reading note (L, underlines, boxed steps, the rule line); the seven 2 mL rules with the method's numbers (`standardSteps(ctx)`, `ctx.params`).
- Fitter (his `fitRowPadding` with the 2 mL `rowMinFor`): page content 1026 x 732 px, chrome 162 px (page one, plus 26.94 px per extra meta line from his `metaLineCount`) and 125 px (continuation pages), 10 px safety, row minimum 42 px (58 when a step is off the standard or over the tube), the Due cell 41 px, the Peptide line 15.4 px (10pt / 1.15, plus one line for the declared mg), the Sample ID line 19.2 px; column fractions 0.0944 (Sample ID) and 0.0947 (Peptide) match the colgroup; padding clamped to [4, 22] px, printed with one decimal. Text is measured with a canvas when the runtime has one (`OffscreenCanvas`, present in Chromium and the Tauri WebView2) and otherwise with half an em per character; tests inject a deterministic `measure`.
- Not ported: the method-rule R marks, the "Method rules used" list and the blend notes (method rules are slice 5); his `.hint` box and auto-print `<script>` (Mk1 prints through `printHtmlDocument`, and the preview iframe is `sandbox=""`); every em dash in his strings (replaced by a colon or a hyphen); Made and MCS tick marks (they print empty for the pen, as on Mk1's stock sheet); the due caption "+3 bus. days" (Mk1's due date is the SLA's, captioned "SLA" as on the stock sheet).
- One change for spec 7: in Dennis's CSS an over-tube step that is also off the standard keeps its step-colour box (`td.step.diff.sN` outranks `td.bad`); spec 7 says it prints boxed in red, so a later `td.step.bad.diff.sN` rule restores the red.
- CSV (49 columns): Dennis's 2 mL list without his four tick columns (Made, MCS, Accmk1, Flag are not CSV data in Mk1), plus `step 3 ratio` (spec 7: each step's sample, ratio and diluent); priority as the stock CSV writes it (`priorityKey`); rows in Box 1 order; a final `Run total` line under the four reagent / tube columns, placed by header name.

- [ ] **Step 1: Trace where the identity label comes from (decides the identity strip)**

Run, from `C:/tmp/Accu-Mk1-endo-v2`:

```bash
grep -n "def _worksheet_item_parent_facts" -A 34 backend/main.py
grep -n "def _analyte_slot_fields" -A 6 backend/sub_samples/registry_inbox.py
grep -n "_IDENTITY_SUFFIX\|Identity (HPLC)" backend/main.py
grep -n "export function endoIdentityFor" -A 6 src/lib/endo-worksheet.ts
```

Read the output for one question: can the text the endo sheet prints (`endoIdentityFor(item)`, which is `item.sample_identity`, else the analyses' `peptide_name`) end in `" - <Assay> (<TECH>)"`?

What the trace showed while drafting (2026-10-10, worktree at `63e80476`):
- `_worksheet_item_parent_facts` (backend/main.py) builds `sample_identity` by joining each analyte slot's `name` (or `title`) from `parent.analytes` with `", "`, falling back to `parent.peptide_name`, with no stripping.
- `_analyte_slot_fields` (backend/sub_samples/registry_inbox.py) says the stored names "carry the same '{Peptide} - Identity (HPLC)' service-title shape SENAITE holds"; `_IDENTITY_SUFFIX = " - Identity (HPLC)"` and `_analyte_activity_labels` say the same ("The registry stores service-title form (BPC-157 - Identity (HPLC))"), and the COA path near line 13422 already strips it with a regex.
- So the suffix can occur (outcome A). Not checked against prod data. To see it on real rows, a read-only query on a stack database (never prod): `SELECT sample_id, analytes FROM lims_samples WHERE analytes LIKE '%Identity (HPLC)%' LIMIT 5;`.

Outcome A (the suffix can occur; expected): keep `productIdentity` and its test below; the 2 mL sheet prints the product, the CSV keeps the raw text in `identity as received`. Dennis's 952 asserts on `splitIdentity` already live in Task 9's `src/lib/__tests__/endo-reader.test.ts` (part G3, `describe('calc.test.js:952 inbox identity ...')`), so they ship with outcome A as they are. Say in the PR: "Mk1's analyte names carry ' - Identity (HPLC)'; the 2 mL sheet strips it per analyte with splitIdentity; stock sheet unchanged."

Outcome B (the trace shows no suffix can reach `endoIdentityFor`): delete `productIdentity` and its test, delete the 952 block from Task 9's `endo-reader.test.ts`, and in `buildEndoSheet2Doc` use `sample` unchanged (`identityAsReceived` equals `sample.identity`); leave `splitIdentity` unused here; say in the PR: "Mk1 adds no assay suffix to the endo identity; splitIdentity is unused on the 2 mL sheet."

The stock sheet is untouched either way (its identity text moves nothing).

- [ ] **Step 2: Write the failing test**

Create `src/lib/__tests__/endo-bench-sheet-2ml.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  buildEndoBenchSheet2Html,
  buildEndoCsv2,
  buildEndoSheet2Doc,
  productIdentity,
  type EndoSheet2Doc,
  type EndoSheet2Row,
} from '@/lib/endo-bench-sheet-2ml'
import {
  ENDO_RUN_PARAM_DEFAULTS,
  type EndoCtx,
  type EndoSample,
} from '@/lib/endo-prep-2ml'
import { endoItem, endoWorksheet } from '@/components/hplc/endo/__tests__/endo-fixtures'

const ctx: EndoCtx = { params: ENDO_RUN_PARAM_DEFAULTS, allowedLambdas: [0.05, 0.01] }
// Deterministic text widths: 7 px a character, whatever the font.
const measure = (text: string) => text.length * 7

function sample(over: Partial<EndoSample> = {}): EndoSample {
  return {
    sampleId: 'P-0001-S02',
    identity: 'Retatrutide',
    sampleType: 'Peptide',
    weightMg: 10,
    form: null,
    waterMl: null,
    totalDilution: null,
    steps: null,
    lambda: 0.05,
    reading: null,
    reader: null,
    ...over,
  }
}

function row(
  n: number,
  over: Partial<EndoSample> = {},
  rowOver: Partial<EndoSheet2Row> = {}
): EndoSheet2Row {
  return {
    n,
    due: '2026-10-14',
    dueHoliday: false,
    priority: 'normal',
    received: '2026-10-09',
    order: '8860',
    identityAsReceived: 'Retatrutide - Identity (HPLC)',
    sample: sample({ sampleId: `P-000${n}-S02`, ...over }),
    ...rowOver,
  }
}

function bacRow(n: number): EndoSheet2Row {
  return row(
    n,
    {
      sampleId: 'BW-0114-S02',
      identity: 'Bacteriostatic Water',
      sampleType: 'Bacteriostatic Water',
      weightMg: null,
      lambda: 0.01,
    },
    { identityAsReceived: 'Bacteriostatic Water' }
  )
}

function doc(rows: EndoSheet2Row[]): EndoSheet2Doc {
  return {
    title: 'Endo 10/09/2026 #1',
    runName: 'worksheet 77',
    analyst: 'Test Analyst',
    dateMade: '2026-10-09',
    orders: '8860',
    printedAt: '2026-10-10 09:00',
    runLambda: 0.05,
    ctx,
    rows,
    holidayNotes: [],
  }
}

describe('buildEndoBenchSheet2Html', () => {
  it('groups rows by total with a rule per group, numbered as Box 1', () => {
    const html = buildEndoBenchSheet2Html(
      doc([row(1), row(2, { totalDilution: 300 }), row(3), bacRow(4)]),
      { measure }
    )
    expect([...html.matchAll(/<td class="n">(\d+)<\/td>/g)].map(m => m[1])).toEqual([
      '1',
      '3',
      '2',
      '4',
    ])
    expect(html.match(/<tr class="newtotal">/g)).toHaveLength(2)
    // 1:300 makes step 2 a 1:15 (20 + 280): boxed, with its ratio
    expect(html).toContain('<td class="step odd diff s2">')
    expect(html).toContain('<span class="rat">1:15</span>')
    // bac water: one "50 + 950" cell across the three steps
    expect(html).toContain('<td class="step bwcell" colspan="3">')
    expect(html).toContain(
      '<span class="num">50</span></span><span class="plus">+</span><span class="pc"><span class="cap">LAL water</span><span class="num">950</span>'
    )
    expect(html).toContain('bac water &middot; 1:20 &middot; one tube')
    expect(html).not.toMatch(new RegExp('\u2014|&' + 'mdash;'))
  })

  it('marks hand-set values, boxes off-standard steps and prints the tube overflow in red', () => {
    const html = buildEndoBenchSheet2Html(
      doc([
        row(1, { steps: [{ sampleUl: 30 }, null, null], waterMl: 3 }),
        row(2, { steps: [null, null, { sampleUl: 800 }] }),
      ]),
      { measure }
    )
    expect(html).toContain('<td class="step own diff s1">')
    expect(html).toContain('<span class="rat">1:10</span>')
    expect(html).toContain('<td class="m r vial own">3</td>')
    expect(html).toContain('<td class="step own bad diff s3">')
    expect(html).toContain('<span class="rat">1:2 &middot; over 1.5 mL</span>')
    expect(html).toContain('td.step.bad.diff.s3{outline-color:#8C2822}')
    expect(html).toContain('td.step.own .num{font-weight:700;text-decoration:underline')
    expect(html).toContain('<td class="pep2">Retatrutide<span class="mg">10 mg</span></td>')
    expect(html).toContain(
      '<span class="duepill"><span class="pill default">Default</span></span>'
    )
  })

  it('totals the reagents and tubes on the summary page', () => {
    const html = buildEndoBenchSheet2Html(
      doc([row(1), row(2, { totalDilution: 300 }), row(3), bacRow(4)]),
      { measure }
    )
    expect(html).toContain('<div class="tile"><dt>Samples</dt><dd>4</dd></div>')
    expect(html).toContain('<div class="tile"><dt>Off the standard</dt><dd>1</dd></div>')
    expect(html).toContain(
      '<div class="tile s1"><dt>0.1 M Tris</dt><dd>540<span class="tunit">&micro;L</span></dd></div>'
    )
    expect(html).toContain(
      '<div class="tile s2"><dt>LAL water</dt><dd>1690<span class="tunit">&micro;L</span></dd></div>'
    )
    expect(html).toContain(
      '<div class="tile s3"><dt>BG600</dt><dd>375<span class="tunit">&micro;L</span></dd></div>'
    )
    expect(html).toContain('<div class="tile"><dt>1.5 mL tubes</dt><dd>10</dd></div>')
    expect(html).toContain('A <b>boxed step</b> is not the standard prep')
  })

  it("sizes the row padding with Dennis's fitter, inside its 4 to 22 px bounds", () => {
    expect(buildEndoBenchSheet2Html(doc([row(1)]), { measure })).toContain(
      'td{padding:22.0px 5pt}'
    )
    const ten = Array.from({ length: 10 }, (_, i) => row(i + 1))
    // (732 - 10 - 10 x 42 - 162) / 20 = 7
    expect(buildEndoBenchSheet2Html(doc(ten), { measure })).toContain(
      'td{padding:7.0px 5pt}'
    )
  })

  it('shows the same document as paper when previewed', () => {
    const d = doc([row(1)])
    const printed = buildEndoBenchSheet2Html(d, { measure })
    const preview = buildEndoBenchSheet2Html(d, { measure, preview: true })
    expect(preview).toContain('width:1056px')
    expect(preview.replace(/<style>.*?<\/style>/s, '')).toBe(
      printed.replace(/<style>.*?<\/style>/s, '')
    )
  })
})

describe('buildEndoCsv2', () => {
  it('writes the 2 mL columns, one line per row in Box 1 order, and a run total', () => {
    const csv = buildEndoCsv2(doc([row(1, { reading: '<0.05' })]))
    const lines = csv.trimEnd().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(
      'Received,Due,Priority,Order #,Sample ID,Sample identity,identity as received,Declared wt (mg),form,' +
        'reconstitution water (mL),step 1 sample (uL),step 1 ratio,step 1 Tris (uL),step 2 sample (uL),step 2 ratio,' +
        'step 2 LAL water (uL),step 3 sample (uL),step 3 ratio,step 3 BG600 (uL),total dilution (x),cartridge (EU/mL),' +
        'loaded (mg/mL),MVD (x),MVC (mg/mL),"result as read (EU/mL on MCS, factor 1)",EU/mL of vial solution,' +
        'LOD (EU/mL cartridge),LOQ (EU/vial),EU/vial,EU/mg,limit (EU/vial),bac water limit (EU/mL),verdict,' +
        'Accu-Mk1 value,Accu-Mk1 unit,spike recovery (%),sample CV (%),spike CV (%),reader check,reader test ID,' +
        'reader,cartridge lot,cartridge expiry,operator,tested at,Tris used (uL),LAL water used (uL),BG600 used (uL),tubes'
    )
    expect(lines[1]).toBe(
      [
        '2026-10-09', '2026-10-14', 'default', '8860', 'P-0001-S02', 'Retatrutide',
        'Retatrutide - Identity (HPLC)', '10', 'powder', '2',
        '20', '10', '180', '20', '12.5', '230', '125', '2', '125', '250',
        '0.05', '0.02', '3500', '0.0014', '<0.05', '<12.5', '0.05', '25', '<25', '<2.5',
        '350', '', 'pass', '<25', 'EU/vial',
        ...Array<string>(10).fill(''),
        '180', '230', '125', '3',
      ].join(',')
    )
    expect(lines[2]).toBe(
      ['', '', '', '', 'Run total', ...Array<string>(40).fill(''), '180', '230', '125', '3'].join(',')
    )
  })

  it('neutralises cells a spreadsheet would run as formulas', () => {
    const csv = buildEndoCsv2(
      doc([row(1, {}, { identityAsReceived: '=HYPERLINK("http://x")', order: '+8860' })])
    )
    const line = csv.split('\r\n')[1] ?? ''
    expect(line).toContain('"\'=HYPERLINK(""http://x"")"')
    expect(line).toContain('"\'+8860"')
  })
})

describe('productIdentity on the 2 mL sheet', () => {
  it('strips each analyte of a blend; the doc prints the product and keeps the raw text', () => {
    expect(productIdentity('BPC-157 - Identity (HPLC), TB-500 - Identity (HPLC)')).toBe(
      'BPC-157, TB-500'
    )
    const item = endoItem({ sample_identity: 'Retatrutide - Identity (HPLC)' })
    const d = buildEndoSheet2Doc(endoWorksheet([item]), {
      analystName: 'Test Analyst',
      calendar: null,
      printedAt: 'now',
      dueAtByItemId: new Map(),
    })
    expect(d.rows[0]?.sample.identity).toBe('Retatrutide')
    expect(d.rows[0]?.identityAsReceived).toBe('Retatrutide - Identity (HPLC)')
    expect(d.runLambda).toBe(0.05)
  })
})
```

- [ ] **Step 3: Run the test to see it fail**

Run: `npx vitest run src/lib/__tests__/endo-bench-sheet-2ml.test.ts`
Expected: FAIL, `Failed to resolve import "@/lib/endo-bench-sheet-2ml"`.

- [ ] **Step 4: Export the stock sheet's shared pieces (no output change)**

In `src/lib/endo-bench-sheet.ts` add `export` in front of these existing declarations, nothing else:

```ts
export const PRIORITY_LABEL: Record<string, string> = {
export function priorityKey(p: string): 'expedited' | 'high' | 'default' {
export function shortDate(iso: string): string {
export function longDate(iso: string): string {
export const SHEET_CSS = [
export const PREVIEW_CSS =
```

Run: `npx vitest run src/lib/__tests__/endo-bench-sheet.test.ts`
Expected: PASS, unchanged (the stock sheet builds the same strings; exporting a declaration does not change what it returns).

- [ ] **Step 5: Create the 2 mL sheet**

Create `src/lib/endo-bench-sheet-2ml.ts`:

```ts
/**
 * The 2 mL endotoxin bench sheet, its summary page and its CSV (spec
 * 2026-10-10 section 7), beside the stock sheet in endo-bench-sheet.ts,
 * which is unchanged.
 *
 * Ported from buildPrintDoc and the 2 mL CSV export in
 * tools-dennis/tools/endotoxin-log/endotoxin.html at 5ef2a62: the columns
 * (#, Due with the priority pill under it, Cart., Order #, Sample ID,
 * Peptide with declared mg, Recon water, the three steps, Made, MCS), rows
 * grouped by total with a rule per group and numbered as Box 1, the marks
 * (a value set by hand bold and underlined, a non-standard step boxed in its
 * colour with its ratio, a step over the 1.5 mL tube or unmakeable boxed in
 * red, bac water one "50 + 950" cell), the summary page and his page fitter.
 * Left out: method-rule marks and the rules list (slice 5), his print hint
 * and auto-print script (Mk1 prints through printHtmlDocument) and his em
 * dashes. Made and MCS print empty for the pen, as on the stock sheet.
 *
 * Pure string building; every value goes through escapeHtml.
 */
import type { ConsumableType, WorksheetListItem } from '@/lib/api'
import {
  ENDO_SHEET_ROWS_PER_PAGE,
  PREVIEW_CSS,
  PRIORITY_LABEL,
  SHEET_CSS,
  csvField,
  escapeHtml,
  longDate,
  priorityKey,
  shortDate,
} from '@/lib/endo-bench-sheet'
import { fmt, fmtUl, holidaysBetween, labDate } from '@/lib/endo-prep'
import {
  BW_DILUTION,
  TUBE_UL,
  dilutionPlan,
  fmtConc,
  fmtEu,
  formOf,
  mk1Value,
  orderByTotal,
  prep2Check,
  prep2Result,
  type EndoCheck,
  type EndoCtx,
  type EndoResult,
  type EndoSample,
  type EndoStepPlan,
} from '@/lib/endo-prep-2ml'
import { splitIdentity } from '@/lib/endo-reader'
import {
  BW_LAL_UL,
  BW_SAMPLE_UL,
  endoCtxFor,
  endoRowsFor,
  runCartridgeFor,
  standardSteps,
  totalGroupKey,
} from '@/lib/endo-worksheet-2ml'
import {
  endoDueFor,
  endoIdentityFor,
  endoItemsInBenchOrder,
  shortOrder,
  type EndoSheetOptions,
} from '@/lib/endo-worksheet'

export interface EndoSheet2Row {
  /** The Box 1 row number, printed so a row can be found on screen. */
  n: number
  /** YYYY-MM-DD lab dates, or null. */
  due: string | null
  dueHoliday: boolean
  priority: string
  received: string | null
  order: string
  /** The identity as Mk1 holds it (CSV); the sheet prints `sample.identity`. */
  identityAsReceived: string
  /** The row as the 2 mL maths reads it, the identity cut to the product. */
  sample: EndoSample
}

export interface EndoSheet2Doc {
  title: string
  runName: string
  analyst: string
  dateMade: string
  orders: string
  printedAt: string
  /** The run cartridge's sensitivity (EU/mL), or null when none is set. */
  runLambda: number | null
  ctx: EndoCtx
  /** Rows in Box 1 (bench) order; the sheet regroups them by total. */
  rows: EndoSheet2Row[]
  holidayNotes: { iso: string; name: string }[]
}

/** Text width in px for a CSS font shorthand (the fitter's ruler). */
export type TextMeasure = (text: string, font: string) => number

/**
 * Mk1's analyte names carry the " - Identity (HPLC)" service-title suffix
 * and the worksheet joins a blend's names with ", ", so the suffix is cut
 * from each analyte (splitIdentity on the whole string would cut only the
 * last one). Product names with their own dashes or brackets stay whole.
 */
export function productIdentity(raw: string): string {
  return raw
    .split(', ')
    .map(part => splitIdentity(part).product)
    .join(', ')
}

/**
 * The 2 mL sheet's document for a worksheet as GET /worksheets/{id} serves
 * it: its endo rows in Box 1 order through endoRowsFor (so paper and screen
 * resolve the same cartridge), each with its due date, and the run cartridge.
 * `catalog` is the allowed list's source when no method resolves.
 */
export function buildEndoSheet2Doc(
  ws: WorksheetListItem,
  opts: EndoSheetOptions,
  catalog: ConsumableType[] = []
): EndoSheet2Doc {
  const cal = opts.calendar
  const holidays = new Map<string, string>()
  const orders = new Set<string>()
  const bench = endoItemsInBenchOrder(ws.items, opts.dueAtByItemId, cal)
  const rows: EndoSheet2Row[] = endoRowsFor(bench, ws, catalog).map(r => {
    const item = r.item
    const received = cal ? labDate(item.date_received, cal) : null
    const due = endoDueFor(opts.dueAtByItemId.get(item.id), cal)
    const skipped = cal ? holidaysBetween(received, due, cal) : []
    for (const h of skipped) holidays.set(h.iso, h.name)
    const order = shortOrder(item.client_order_number)
    if (order) orders.add(order)
    const raw = endoIdentityFor(item)
    return {
      n: r.n,
      due,
      dueHoliday: skipped.length > 0,
      priority: item.priority,
      received,
      order,
      identityAsReceived: raw,
      sample: { ...r.sample, identity: productIdentity(raw) },
    }
  })
  return {
    title: ws.title,
    runName: `worksheet ${ws.id}`,
    analyst: opts.analystName,
    dateMade: (cal ? labDate(ws.created_at, cal) : null) ?? '',
    orders: [...orders].join(', '),
    printedAt: opts.printedAt,
    runLambda: runCartridgeFor(ws, catalog)?.sensitivity ?? null,
    ctx: endoCtxFor(ws, catalog),
    rows,
    holidayNotes: [...holidays].map(([iso, name]) => ({ iso, name })),
  }
}

/* ---------------- the sheet ---------------- */

// Dennis's 2 mL additions to the sheet CSS (buildPrintDoc at 5ef2a62), after
// the stock SHEET_CSS. The last rule is Mk1's: spec 7 boxes an over-tube
// step in red even when it is also off the standard.
const SHEET2_CSS = [
  'td.r,th.r{text-align:center}',
  "td.pep2{font:10pt/1.15 'Segoe UI',system-ui,-apple-system,Arial,sans-serif;color:#1F2A2E;white-space:normal;overflow-wrap:anywhere}",
  'td.pep2 .mg{display:block;margin-top:1pt;font:600 10pt/1.15 var(--num);color:#33474C;white-space:nowrap}',
  "td.due{line-height:1.15} td.due .duepill{display:block;margin-top:1pt;font:9.5pt/1.1 'Segoe UI',system-ui,-apple-system,Arial,sans-serif;white-space:nowrap} td.due .duepill .pill{padding:.5pt 4pt}",
  'td.cart{text-align:center;padding-left:2pt;padding-right:2pt} td.cart.set{font-weight:700} td.cart .pill{font-size:9.5pt;padding:1pt 3pt}',
  'td.step{font-family:var(--num);white-space:nowrap;line-height:1.1}',
  'td.step .pair{display:inline-flex;align-items:flex-end;gap:5pt}',
  'td.step .pc{display:inline-flex;flex-direction:column;align-items:center}',
  "td.step .cap{font:7.5pt 'Segoe UI',system-ui,sans-serif;color:#7C9095;line-height:1.1;white-space:nowrap}",
  'td.step .num{font-size:13pt;font-variant-numeric:tabular-nums slashed-zero}',
  'td.step .plus{font-size:13pt;color:#41595F}',
  'td.step.own .num{font-weight:700;text-decoration:underline;text-decoration-thickness:.75pt;text-underline-offset:2pt}',
  'td.step .rat{display:block;font-size:8.5pt;color:#41595F;font-weight:700;margin-top:1pt;white-space:normal;line-height:1.15}',
  'td.step.bad .rat{color:#8C2822}',
  'th .ratio{font-family:var(--num);font-weight:400;letter-spacing:0;text-transform:none;color:#41595F}',
  "sup.lmark{font:700 7pt 'Segoe UI',system-ui,sans-serif;color:#7A4FB5;margin-left:1pt;line-height:0;vertical-align:.6em}",
  'th.stepcol,td.step{border-left:.75pt solid #B8C8C8}',
  'th.stepcol.s1{color:#2F6DB5;border-top:3pt solid #2F6DB5} th.stepcol.s2{color:#2D7D4F;border-top:3pt solid #2D7D4F} th.stepcol.s3{color:#A2620F;border-top:3pt solid #A2620F}',
  'tbody tr td.step.s1{background:#EAF1FB} tbody tr td.step.s2{background:#E7F4EB} tbody tr td.step.s3{background:#FCF1E1}',
  'tbody tr:nth-child(even) td.step.s1{background:#DFE9F7} tbody tr:nth-child(even) td.step.s2{background:#DCEEE2} tbody tr:nth-child(even) td.step.s3{background:#F8E8D0}',
  'td.step .cap.c1{color:#2F6DB5;font-weight:700} td.step .cap.c2{color:#2D7D4F;font-weight:700} td.step .cap.c3{color:#A2620F;font-weight:700}',
  'td.step.bwcell{background:#F2F6F6}',
  'td.step.bwcell .rat{display:inline;margin:0 0 0 10pt;vertical-align:baseline}',
  'td.step .cap.cv{color:#7A4FB5;font-weight:700} td.step .pc.kv .num{color:#7A4FB5;font-weight:600}',
  'th.vial{color:#7A4FB5} td.vial{color:#7A4FB5;font-weight:600}',
  'th.vial,td.vial{padding-left:2pt;padding-right:10pt}',
  'td.step .pc.k1 .num{color:#2F6DB5;font-weight:600} td.step .pc.k2 .num{color:#2D7D4F;font-weight:600} td.step .pc.k3 .num{color:#A2620F;font-weight:600}',
  '.rules dt.s1{color:#2F6DB5} .rules dt.s2{color:#2D7D4F} .rules dt.s3{color:#A2620F}',
  '.tiles .tile.s1{border-top-color:#2F6DB5} .tiles .tile.s2{border-top-color:#2D7D4F} .tiles .tile.s3{border-top-color:#A2620F}',
  'th.aftersteps,td.aftersteps{border-left:.75pt solid #B8C8C8}',
  'td.own{font-weight:700;text-decoration:underline;text-decoration-thickness:.75pt;text-underline-offset:2pt}',
  'td.bad{outline:1.5pt solid #8C2822;outline-offset:-3pt;color:#8C2822}',
  'td.step.diff{outline:1.5pt solid #41595F;outline-offset:-1.5pt}',
  'td.step.diff.s1{outline-color:#2F6DB5} td.step.diff.s2{outline-color:#2D7D4F} td.step.diff.s3{outline-color:#A2620F}',
  'td.step.diff .pc:last-child .num{font-weight:700;font-size:11.5pt}',
  'td.step.diff .rat{color:#1F2A2E}',
  'td.step.bad.diff.s1{outline-color:#8C2822} td.step.bad.diff.s2{outline-color:#8C2822} td.step.bad.diff.s3{outline-color:#8C2822}',
  'tr.newtotal td{box-shadow:inset 0 2pt 0 #41595F}',
  '.tiles.six{gap:10pt;margin:10pt 0 12pt}.tiles.six .tile{padding:8pt 10pt 9pt}.tiles.six dd{font-size:20pt}.tiles.six .tunit{font-size:10pt}',
  '.page.summary.two .cols{margin-bottom:10pt}.page.summary.two .ruleshead{margin-bottom:6pt}',
  '.note.readnote{margin:0 0 10pt;font-size:9.5pt}.note.readnote b{color:#41595F}',
  '.rules.seven{gap:11pt 14pt}.rules.seven div{flex:1 1 84pt}',
  '.rules.seven dd{font-size:10.5pt;line-height:1.35}',
].join('')

// Dennis's 2 mL colgroup (sums to 100%). The fitter's column fractions
// below must match the Sample ID and Peptide widths.
const COLGROUP2 =
  '<colgroup>' +
  '<col style="width:3.22%"><col style="width:11.5%">' +
  '<col style="width:5.65%"><col style="width:5.75%"><col style="width:9.44%"><col style="width:9.47%">' +
  '<col style="width:5.4%">' +
  '<col style="width:13.79%"><col style="width:13.79%"><col style="width:13.79%">' +
  '<col style="width:4.1%"><col style="width:4.1%">' +
  '</colgroup>'

function thead2(std: EndoStepPlan[]): string {
  const ratio = (i: number) => escapeHtml(fmt(std[i]?.ratio))
  return (
    COLGROUP2 +
    '<thead><tr><th></th>' +
    '<th>Due &middot; priority<span class="u">SLA</span></th>' +
    '<th>Cart.<span class="u">EU/mL</span></th><th>Order #</th><th>Sample ID</th>' +
    '<th>Peptide<span class="u">declared mg</span></th>' +
    '<th class="r vial">Recon water<span class="u">mL</span></th>' +
    `<th class="stepcol s1">Step 1 &middot; Tris <span class="ratio">1:${ratio(0)}</span><span class="u">&micro;L</span></th>` +
    `<th class="stepcol s2">Step 2 &middot; Water <span class="ratio">1:${ratio(1)}</span><span class="u">&micro;L</span></th>` +
    `<th class="stepcol s3">Step 3 &middot; BG600 <span class="ratio">1:${ratio(2)}</span><span class="u">&micro;L</span></th>` +
    '<th class="c aftersteps">Made</th><th class="c">MCS</th>' +
    '</tr></thead>'
  )
}

// The caption over each number: what is taken, then what is added. Steps 2
// and 3 take from the step before, captioned in that step's colour.
const STEP_CAPS: [string, string][] = [
  ['sample', 'Tris'],
  ['step 1', 'water'],
  ['step 2', 'BG600'],
]

/** "sample + diluent" with its caption over each number (Dennis's pairPrint). */
function pair(
  a: number | null,
  capA: string,
  b: number | null,
  capB: string,
  colA = '',
  colB = ''
): string {
  const pc = (col: string) => `pc${col ? ` k${col}` : ''}`
  const cap = (col: string) => `cap${col ? ` c${col}` : ''}`
  return (
    `<span class="pair"><span class="${pc(colA)}"><span class="${cap(colA)}">${capA}</span><span class="num">${escapeHtml(fmtUl(a))}</span></span>` +
    '<span class="plus">+</span>' +
    `<span class="${pc(colB)}"><span class="${cap(colB)}">${capB}</span><span class="num">${escapeHtml(fmtUl(b))}</span></span></span>`
  )
}

/** A step whose volumes are not the standard's (Dennis's `diff`). */
function stepDiffers(st: EndoStepPlan, d: EndoStepPlan | undefined): boolean {
  if (!d) return false
  return (
    st.sampleUl !== d.sampleUl ||
    st.diluentUl === null ||
    d.diluentUl === null ||
    Math.abs(st.diluentUl - d.diluentUl) > 1e-9
  )
}

/** The Cart. cell: the cartridge, or a pill when the prep cannot read the limit. */
function cartPrint(k: EndoCheck): string {
  if (k.lambda === null) return ''
  if (k.valid !== false) return escapeHtml(fmt(k.lambda))
  return `<span class="pill ${k.needs !== null ? 'high' : 'expedited'}">${
    k.needs !== null ? `&rarr;&nbsp;${escapeHtml(fmt(k.needs))}` : 'invalid'
  }</span>`
}

/* ---------------- the page fitter (Dennis's fitRowPadding, 2 mL) ---------------- */

const PAGE_CONTENT_W = 1026 // 11in landscape minus the 4mm side margins
const PAGE_CONTENT_H = 732 // 8.5in minus the 11mm top and bottom margins
const SID2_COL = 0.0944 // the Sample ID column, as in COLGROUP2
const PEP2_COL = 0.0947 // the Peptide column, as in COLGROUP2
const SID_FONT = "16.67px Consolas, 'Cascadia Mono', 'DejaVu Sans Mono', monospace"
const SID_LINE_PX = 19.2 // one line of Sample ID at 12.5pt / 1.15
const PEP_FONT = "13.33px 'Segoe UI', system-ui, -apple-system, Arial, sans-serif"
const PEP_LINE_PX = 15.4 // one line of peptide name at 10pt / 1.15
const DUE2_PX = 41 // the Due cell: the date over the priority pill
const CHROME_FIRST = 162 // title, a one-line meta, column heads, page footer
const CHROME_CONT = 125 // continuation heading, column heads, page footer
const FIT_SAFETY = 10
const META_DT_FONT = "700 12px 'Segoe UI', system-ui, -apple-system, Arial, sans-serif"
const META_DT_TRACK = 1.44 // .12em of tracking per letter on the 9pt label
const META_DD_FONT = "600 17.33px 'Segoe UI', system-ui, -apple-system, Arial, sans-serif"
const META_LINE_PX = 24.27 + 2.67
const META_GAP = 32 // 24pt between meta items on a line
const META_LABEL_GAP = 8 // 6pt between a label and its value
const H_PAD_PX = ((5 * 96) / 72) * 2 + 2 // 5pt of side padding each side, plus 2px

let canvas: OffscreenCanvasRenderingContext2D | null | undefined

/**
 * Canvas text width where the runtime has one (Chromium, the Tauri
 * WebView2); else half an em per character.
 * ponytail: the fallback only runs without a canvas (jsdom); tests pass
 * their own `measure`.
 */
function defaultMeasure(text: string, font: string): number {
  if (canvas === undefined) {
    try {
      canvas =
        typeof OffscreenCanvas === 'undefined'
          ? null
          : new OffscreenCanvas(1, 1).getContext('2d')
    } catch {
      canvas = null
    }
  }
  if (canvas) {
    canvas.font = font
    return canvas.measureText(text).width
  }
  const px = Number(/([\d.]+)px/.exec(font)?.[1] ?? 14)
  return text.length * px * 0.5
}

function lineCount(text: string, maxW: number, font: string, measure: TextMeasure): number {
  if (!text) return 1
  let lines = 1
  let cur = ''
  for (const word of text.split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word
    if (measure(next, font) <= maxW || !cur) cur = next
    else {
      lines++
      cur = word
    }
  }
  return lines
}

/** Sample IDs have no spaces but may break at their hyphens. */
function sidLineCount(text: string, maxW: number, measure: TextMeasure): number {
  if (!text) return 1
  const w = measure(text, SID_FONT)
  return w <= maxW ? 1 : Math.min(3, Math.ceil(w / maxW))
}

/** How many lines page one's meta strip wraps to (Dennis's metaLineCount). */
function metaLineCount(items: [string, string][], measure: TextMeasure): number {
  let lines = 1
  let used = 0
  const room = PAGE_CONTENT_W - 4
  for (const [label, value] of items) {
    const lab = label.toUpperCase()
    const labelW = measure(lab, META_DT_FONT) + lab.length * META_DT_TRACK + META_LABEL_GAP
    const w = labelW + measure(value, META_DD_FONT)
    if (used && used + META_GAP + w <= room) {
      used += META_GAP + w
      continue
    }
    if (used) lines++
    if (w <= room) {
      used = w
      continue
    }
    lines += lineCount(value, room - labelW, META_DD_FONT, measure) - 1
    used = room
  }
  return lines
}

/**
 * A row's minimum height: two lines for the step cells (units over the
 * numbers), three when a step is off the standard or over the tube (its note
 * adds a line); the Peptide cell (name plus the declared mg) and the Due cell
 * can be taller still.
 */
function rowMinFor(
  s: EndoSample,
  ctx: EndoCtx,
  std: EndoStepPlan[],
  measure: TextMeasure
): number {
  const w = PAGE_CONTENT_W * PEP2_COL - H_PAD_PX
  const bac = formOf(s) === 'bac'
  const pepLines =
    (s.identity ? lineCount(s.identity, w, PEP_FONT, measure) : 0) +
    (bac || s.weightMg === null ? 0 : 1)
  const stack = Math.max(DUE2_PX, pepLines * PEP_LINE_PX)
  if (bac) return Math.max(42, stack)
  const p = dilutionPlan(s, ctx)
  const odd =
    !p.fits ||
    p.steps.some((st, si) => st.ratio !== std[si]?.ratio || stepDiffers(st, std[si]))
  return Math.max(odd ? 58 : 42, stack)
}

/** Vertical padding (px) that makes the tallest page just fill the sheet. */
function fitRowPadding(
  pages: EndoSheet2Row[][],
  rowMin: (r: EndoSheet2Row) => number,
  metaLines: number,
  measure: TextMeasure
): number {
  const sidW = PAGE_CONTENT_W * SID2_COL - H_PAD_PX
  let best = Infinity
  pages.forEach((chunk, i) => {
    if (!chunk.length) return
    let content = 0
    for (const r of chunk)
      content += Math.max(rowMin(r), sidLineCount(r.sample.sampleId, sidW, measure) * SID_LINE_PX)
    const base = i === 0 ? CHROME_FIRST + (metaLines - 1) * META_LINE_PX : CHROME_CONT
    const budget = PAGE_CONTENT_H - FIT_SAFETY - content
    best = Math.min(best, (budget - base) / (2 * chunk.length))
  })
  if (!Number.isFinite(best)) best = 12
  // Dennis: the floor was 7 px; grouping by total can put ten three-line rows
  // on one page, so 4 px, reached only on such a page.
  return Math.max(4, Math.min(22, best))
}

/* ---------------- the document ---------------- */

export function buildEndoBenchSheet2Html(
  doc: EndoSheet2Doc,
  opts: { preview?: boolean; measure?: TextMeasure } = {}
): string {
  const { ctx } = doc
  const measure = opts.measure ?? defaultMeasure
  const std = standardSteps(ctx)
  const ordered = orderByTotal(doc.rows, r => r.sample, ctx)
  const keys = ordered.map(r => totalGroupKey(r.sample, ctx))
  const title = escapeHtml(doc.title)
  const name = escapeHtml(doc.runName)
  const stamp = escapeHtml(doc.printedAt)
  const analyst = escapeHtml(doc.analyst || '-')
  const cartridge = doc.runLambda === null ? '-' : `${fmt(doc.runLambda)} EU/mL`
  const reconMl = ctx.params.reconWaterMl
  const tally = { tubes: 0, own: 0, odd: 0, typed: 0, liquid: 0, bac: 0, tris: 0, water: 0, bg: 0 }
  const prio = { expedited: 0, high: 0, default: 0 }
  const dueGroups = new Map<string, number>()

  function stepPrint(st: EndoStepPlan, si: number): string {
    const sn = si + 1
    if (st.diluentUl === null || !st.sampleUl)
      return `<td class="step bad s${sn}">cannot be made</td>`
    const d = std[si]
    const odd = d !== undefined && st.ratio !== d.ratio
    const diff = stepDiffers(st, d)
    const cls = `step${st.own ? ' own' : ''}${st.fits ? '' : ' bad'}${odd ? ' odd' : ''}${diff ? ' diff' : ''} s${sn}`
    const ratio = escapeHtml(fmt(st.ratio))
    // the note is the ratio alone (Dennis, eb4ee43); "over 1.5 mL" for a step
    // that does not fit its tube
    const note = !st.fits
      ? `1:${ratio} &middot; over ${fmt(TUBE_UL / 1000)} mL`
      : odd || diff
        ? `1:${ratio}`
        : ''
    if (odd || diff) tally.odd++
    const [capA, capB] = STEP_CAPS[si] ?? ['sample', '']
    return (
      `<td class="${cls}">${pair(st.sampleUl, capA, st.diluentUl, capB, si ? String(si) : 'v', String(sn))}` +
      `${note ? `<span class="rat">${note}</span>` : ''}</td>`
    )
  }

  function rowPrint(r: EndoSheet2Row, i: number): string {
    const s = r.sample
    const k = prep2Check(s, ctx)
    const pk = priorityKey(r.priority)
    prio[pk]++
    if (r.due) dueGroups.set(r.due, (dueGroups.get(r.due) ?? 0) + 1)
    const bac = formOf(s) === 'bac'
    const weight = bac || s.weightMg === null ? '' : `${fmt(s.weightMg)} mg`
    // bold when the row runs on a cartridge other than the run's (bac water's
    // 0.01 is its rule, not an exception)
    const cartOwn =
      !bac && s.lambda !== null && doc.runLambda !== null && s.lambda !== doc.runLambda
    const lead =
      `<tr${i > 0 && keys[i] !== keys[i - 1] ? ' class="newtotal"' : ''}>` +
      `<td class="n">${r.n}</td>` +
      `<td class="m due">${r.due ? escapeHtml(shortDate(r.due)) : ''}${r.dueHoliday ? '<sup>*</sup>' : ''}` +
      `<span class="duepill"><span class="pill ${pk}">${PRIORITY_LABEL[pk]}</span></span></td>` +
      `<td class="cart${cartOwn ? ' set' : ''}">${cartPrint(k)}</td>` +
      `<td class="m">${escapeHtml(r.order)}</td>` +
      `<td class="m sid">${escapeHtml(s.sampleId)}</td>` +
      `<td class="pep2">${escapeHtml(s.identity)}${weight ? `<span class="mg">${escapeHtml(weight)}</span>` : ''}</td>`
    const ticks =
      '<td class="c aftersteps"><span class="bx"></span></td><td class="c"><span class="bx"></span></td></tr>'
    if (bac) {
      tally.bac++
      tally.tubes++
      tally.water += BW_LAL_UL
      return (
        lead +
        '<td class="m r">-</td>' +
        `<td class="step bwcell" colspan="3">${pair(BW_SAMPLE_UL, 'sample', BW_LAL_UL, 'LAL water')}` +
        `<span class="rat">bac water &middot; 1:${fmtUl(BW_DILUTION)} &middot; one tube</span></td>` +
        ticks
      )
    }
    const plan = dilutionPlan(s, ctx)
    tally.tubes += plan.steps.length
    if (plan.total !== null) {
      tally.tris += plan.steps[0]?.diluentUl ?? 0
      tally.water += plan.steps[1]?.diluentUl ?? 0
      tally.bg += plan.steps[2]?.diluentUl ?? 0
    }
    const liquid = formOf(s) === 'liquid'
    const waterOwn = !liquid && s.waterMl !== null && s.waterMl !== reconMl
    if (!plan.standard || s.waterMl !== null) tally.own++
    if (liquid) tally.liquid++
    if (waterOwn || plan.steps.some(st => st.own)) tally.typed++
    return (
      lead +
      `<td class="m r vial${waterOwn ? ' own' : ''}">${k.water === null ? '' : escapeHtml(fmt(k.water))}` +
      `${liquid ? '<sup class="lmark">L</sup>' : ''}</td>` +
      plan.steps.map(stepPrint).join('') +
      ticks
    )
  }

  // Rows render first: the summary below reads what they counted.
  const body = ordered.map(rowPrint)
  const pages: string[][] = []
  const rowPages: EndoSheet2Row[][] = []
  for (let i = 0; i < ordered.length; i += ENDO_SHEET_ROWS_PER_PAGE) {
    pages.push(body.slice(i, i + ENDO_SHEET_ROWS_PER_PAGE))
    rowPages.push(ordered.slice(i, i + ENDO_SHEET_ROWS_PER_PAGE))
  }
  if (!pages.length) pages.push([])
  const totalPages = pages.length + 1 // the table pages, plus the summary

  const metaItems: [string, string][] = [
    ['Analyst', doc.analyst || '-'],
    ['Cartridge', cartridge],
    ['Date made', doc.dateMade ? longDate(doc.dateMade) : '-'],
    ['Samples', String(doc.rows.length)],
    ['Orders', doc.orders || '-'],
  ]
  const pad = fitRowPadding(
    rowPages,
    r => rowMinFor(r.sample, ctx, std, measure),
    metaLineCount(metaItems, measure),
    measure
  ).toFixed(1)
  const meta =
    '<dl class="meta">' +
    metaItems.map(([l, v]) => `<div><dt>${l}</dt><dd>${escapeHtml(v)}</dd></div>`).join('') +
    '</dl>'
  const footRight = (pageIx: number, chunkLen: number) => {
    const first = pageIx * ENDO_SHEET_ROWS_PER_PAGE + 1
    const last = pageIx * ENDO_SHEET_ROWS_PER_PAGE + chunkLen
    return (
      `<span>${chunkLen ? `Samples <b>${first}&ndash;${last}</b> of ${doc.rows.length} &middot; ` : ''}` +
      `<b>Page ${pageIx + 1} of ${totalPages}</b></span>`
    )
  }
  const footLeft = `<span>${title} &middot; ${name}${doc.analyst ? ` &middot; ${analyst}` : ''}</span>`

  let out =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<title>${title} endotoxin prep</title><style>${SHEET_CSS}${SHEET2_CSS}` +
    `td{padding:${pad}px 5pt}${opts.preview ? PREVIEW_CSS : ''}</style></head><body>`

  pages.forEach((chunk, pageIx) => {
    const of = `page ${pageIx + 1} of ${totalPages}`
    const header =
      pageIx === 0
        ? `<div class="top"><h1>${title}: endotoxin prep</h1>` +
          `<p class="stamp">${name}  &middot;  printed ${stamp}  &middot;  ${of}</p></div>` +
          meta
        : `<div class="cont">${title}: continued<span>${name}  &middot;  ${of}</span></div>`
    out +=
      `<section class="page">${header}<table>${thead2(std)}<tbody>${chunk.join('')}</tbody></table>` +
      `<div class="pagefoot">${footLeft}${footRight(pageIx, chunk.length)}</div></section>`
  })

  // ---------- the summary sheet: what you draw reagents against ----------
  const tile = (label: string, value: string, unit: string, cls = '') =>
    `<div class="tile${cls ? ` ${cls}` : ''}"><dt>${label}</dt><dd>${escapeHtml(value)}${unit ? `<span class="tunit">${unit}</span>` : ''}</dd></div>`
  const prioRow = (key: string, label: string, count: number) =>
    `<div class="priorow"><span class="pill ${key}">${label}</span><span class="dots"></span><span class="cnt">${count}</span></div>`
  const dueList = [...dueGroups.keys()]
    .sort()
    .map(
      k =>
        `<div class="duerow"><span>${escapeHtml(longDate(k))}</span><span class="dots"></span><span class="cnt">${dueGroups.get(k)}</span></div>`
    )
    .join('')
  const stdVol = (i: number) => {
    const d = std[i]
    return d
      ? `${fmtUl(d.sampleUl)} + ${fmtUl(d.diluentUl)} &micro;L &middot; 1:${fmt(d.ratio)}`
      : ''
  }
  const readnote =
    tally.typed || tally.odd || tally.liquid
      ? '<p class="note readnote">' +
        (tally.liquid
          ? "<b>L</b> after the recon water: the vial arrived reconstituted; that is the customer's water, add nothing. "
          : '') +
        (tally.typed
          ? '<b>Underlined</b> figures were set for that sample, not the standard. '
          : '') +
        (tally.odd
          ? `A <b>boxed step</b> is not the standard prep: read its numbers and the ratio under them rather than assuming ${fmtUl(std[1]?.diluentUl)}. A line across the table starts the next total.`
          : '') +
        '</p>'
      : ''
  const holidayNote = doc.holidayNotes.length
    ? `<p class="note">* Due date pushed past ${escapeHtml(
        doc.holidayNotes
          .slice()
          .sort((a, b) => (a.iso < b.iso ? -1 : 1))
          .map(h => `${h.name} (${shortDate(h.iso)})`)
          .join(', ')
      )}. Weekends and lab holidays are not counted.</p>`
    : ''

  out +=
    '<section class="page summary two">' +
    `<div class="cont">${title}: run summary<span>${name}  &middot;  printed ${stamp}</span></div>` +
    '<dl class="meta">' +
    `<div><dt>Analyst</dt><dd>${analyst}</dd></div>` +
    `<div><dt>Cartridge</dt><dd>${escapeHtml(cartridge)}</dd></div>` +
    `<div><dt>Date made</dt><dd>${escapeHtml(doc.dateMade ? longDate(doc.dateMade) : '-')}</dd></div>` +
    `<div><dt>Orders</dt><dd>${escapeHtml(doc.orders || '-')}</dd></div>` +
    '</dl>' +
    '<dl class="tiles six">' +
    tile('Samples', String(doc.rows.length), '') +
    tile('Off the standard', String(tally.own), '') +
    tile('0.1 M Tris', fmtUl(tally.tris), '&micro;L', 's1') +
    tile('LAL water', fmtUl(tally.water), '&micro;L', 's2') +
    tile('BG600', fmtUl(tally.bg), '&micro;L', 's3') +
    tile('1.5 mL tubes', String(tally.tubes), '') +
    '</dl>' +
    '<div class="cols">' +
    '<section class="col"><h2>Priority</h2>' +
    prioRow('expedited', 'Expedited', prio.expedited) +
    prioRow('high', 'High', prio.high) +
    prioRow('default', 'Default', prio.default) +
    (tally.bac
      ? `<p class="colnote">${tally.bac} ${tally.bac === 1 ? 'sample is' : 'samples are'} bacteriostatic water, prepped as a dilution.</p>`
      : '') +
    '</section>' +
    `<section class="col"><h2>Due</h2>${dueList || '<p class="colnote">No due dates set.</p>'}</section>` +
    '</div>' +
    readnote +
    '<h2 class="ruleshead">How each figure is worked out</h2>' +
    '<dl class="rules seven">' +
    '<div><dt>Due date</dt><dd>received + 3 business days<br><i>weekends and lab holidays skipped</i></dd></div>' +
    `<div><dt>Reconstitution water</dt><dd>${fmt(reconMl)} mL<br><i>underlined where a sample was given its own</i></dd></div>` +
    `<div><dt class="s1">Step 1 &middot; Tris</dt><dd>${stdVol(0)}<br><i>0.1 M Tris (BT103), first, per its insert</i></dd></div>` +
    `<div><dt class="s2">Step 2 &middot; LAL water</dt><dd>${stdVol(1)}<br><i>ratio = total &divide; (step 1 &times; 2)</i></dd></div>` +
    `<div><dt class="s3">Step 3 &middot; BG600</dt><dd>${stdVol(2)}<br><i>always 1:2: BG600 is half the final prep</i></dd></div>` +
    `<div><dt>Total &middot; MCS</dt><dd>1:${fmt(ctx.params.stdTotalDilution)}, factor 1 on the MCS<br><i>the sheet multiplies the reading by the total and the ${fmt(reconMl)} mL</i></dd></div>` +
    `<div><dt>Bacteriostatic water</dt><dd>${fmt(BW_DILUTION)}&times; dilution: ${fmtUl(BW_SAMPLE_UL)} &micro;L<br><i>made to ${fmtUl(BW_SAMPLE_UL + BW_LAL_UL)} &micro;L with LAL water</i></dd></div>` +
    '</dl>' +
    holidayNote +
    `<div class="pagefoot">${footLeft}<span><b>Summary &middot; page ${totalPages} of ${totalPages}</b></span></div>` +
    '</section>'

  return out + '</body></html>'
}

/* ---------------- CSV ---------------- */

interface Csv2Line {
  r: EndoSheet2Row
  k: EndoCheck
  rs: EndoResult
  mk: { value: string; unit: string } | null
  steps: EndoStepPlan[] | null
  total: number | null
  tris: number | null
  water: number | null
  bg: number | null
  tubes: number
}

function csv2Line(r: EndoSheet2Row, ctx: EndoCtx): Csv2Line {
  const s = r.sample
  const bac = formOf(s) === 'bac'
  const plan = bac ? null : dilutionPlan(s, ctx)
  const k = prep2Check(s, ctx)
  return {
    r,
    k,
    rs: prep2Result(s, ctx),
    mk: mk1Value(s, ctx),
    steps: plan ? plan.steps : null,
    total: plan ? plan.total : k.dilution,
    tris: plan ? (plan.steps[0]?.diluentUl ?? null) : null,
    // bac water: its LAL water
    water: plan ? (plan.steps[1]?.diluentUl ?? null) : BW_LAL_UL,
    bg: plan ? (plan.steps[2]?.diluentUl ?? null) : null,
    tubes: plan ? plan.steps.length : 1,
  }
}

const eu = (lt: boolean | null, v: number | null) => fmtEu(lt === true, v)
const plain = (v: number | null | undefined) => (v == null ? '' : String(v))
const step = (x: Csv2Line, i: number) => x.steps?.[i] ?? null

// Dennis's 2 mL CSV columns (5ef2a62) without his four tick columns, plus
// step 3's ratio (spec 7). The Run total line is placed by these names.
const CSV2_COLUMNS: [string, (x: Csv2Line) => string][] = [
  ['Received', x => x.r.received ?? ''],
  ['Due', x => x.r.due ?? ''],
  ['Priority', x => priorityKey(x.r.priority)],
  ['Order #', x => x.r.order],
  ['Sample ID', x => x.r.sample.sampleId],
  ['Sample identity', x => x.r.sample.identity],
  ['identity as received', x => x.r.identityAsReceived],
  ['Declared wt (mg)', x => fmt(x.r.sample.weightMg)],
  ['form', x => formOf(x.r.sample)],
  ['reconstitution water (mL)', x => fmt(x.k.water)],
  ['step 1 sample (uL)', x => fmtUl(step(x, 0)?.sampleUl)],
  ['step 1 ratio', x => fmt(step(x, 0)?.ratio)],
  ['step 1 Tris (uL)', x => fmtUl(x.tris)],
  ['step 2 sample (uL)', x => fmtUl(step(x, 1)?.sampleUl)],
  ['step 2 ratio', x => fmt(step(x, 1)?.ratio)],
  ['step 2 LAL water (uL)', x => (x.steps ? fmtUl(x.water) : '')],
  ['step 3 sample (uL)', x => fmtUl(step(x, 2)?.sampleUl)],
  ['step 3 ratio', x => fmt(step(x, 2)?.ratio)],
  ['step 3 BG600 (uL)', x => fmtUl(x.bg)],
  ['total dilution (x)', x => fmt(x.total)],
  ['cartridge (EU/mL)', x => fmt(x.k.lambda)],
  ['loaded (mg/mL)', x => fmtConc(x.k.loaded)],
  ['MVD (x)', x => fmt(x.k.mvd)],
  ['MVC (mg/mL)', x => fmtConc(x.k.mvc)],
  ['result as read (EU/mL on MCS, factor 1)', x => x.r.sample.reading ?? ''],
  ['EU/mL of vial solution', x => eu(x.rs.lt, x.rs.euPerMlVial)],
  ['LOD (EU/mL cartridge)', x => fmt(x.k.lod)],
  [
    'LOQ (EU/vial)',
    x =>
      formOf(x.r.sample) === 'bac'
        ? x.k.loqMl === null
          ? ''
          : `${fmt(x.k.loqMl)} EU/mL`
        : fmt(x.k.loqVial),
  ],
  ['EU/vial', x => eu(x.rs.lt, x.rs.euPerVial)],
  ['EU/mg', x => eu(x.rs.lt, x.rs.euPerMg)],
  ['limit (EU/vial)', x => fmt(x.rs.limitPerVial)],
  ['bac water limit (EU/mL)', x => fmt(x.rs.limitPerMl)],
  ['verdict', x => x.rs.verdict ?? ''],
  ['Accu-Mk1 value', x => x.mk?.value ?? ''],
  ['Accu-Mk1 unit', x => x.mk?.unit ?? ''],
  ['spike recovery (%)', x => plain(x.r.sample.reader?.recovery)],
  ['sample CV (%)', x => plain(x.r.sample.reader?.sample_cv)],
  ['spike CV (%)', x => plain(x.r.sample.reader?.spike_cv)],
  [
    'reader check',
    x => {
      const m = x.r.sample.reader
      return m ? (m.valid ? 'valid' : `invalid: ${m.why.join('; ')}`) : ''
    },
  ],
  ['reader test ID', x => x.r.sample.reader?.test_id ?? ''],
  [
    'reader',
    x => {
      const m = x.r.sample.reader
      return m ? [m.reader, m.slot].filter(v => v != null).join(' ') : ''
    },
  ],
  ['cartridge lot', x => x.r.sample.reader?.cartridge_lot ?? ''],
  ['cartridge expiry', x => x.r.sample.reader?.cartridge_expiry ?? ''],
  ['operator', x => x.r.sample.reader?.operator ?? ''],
  ['tested at', x => x.r.sample.reader?.tested_at ?? ''],
  ['Tris used (uL)', x => fmtUl(x.tris)],
  ['LAL water used (uL)', x => fmtUl(x.water)],
  ['BG600 used (uL)', x => fmtUl(x.bg)],
  ['tubes', x => String(x.tubes)],
]

/**
 * One row per sample in Box 1 order, then a Run total line with the
 * reagents and tubes for inventory (Dennis 2026-10-08); CRLF line endings
 * and formula-defused cells, as the stock CSV.
 */
export function buildEndoCsv2(doc: EndoSheet2Doc): string {
  const lines = [CSV2_COLUMNS.map(c => csvField(c[0])).join(',')]
  const sum = { tris: 0, water: 0, bg: 0, tubes: 0 }
  for (const r of doc.rows) {
    const x = csv2Line(r, doc.ctx)
    sum.tris += x.tris ?? 0
    sum.water += x.water ?? 0
    sum.bg += x.bg ?? 0
    sum.tubes += x.tubes
    lines.push(CSV2_COLUMNS.map(c => csvField(c[1](x))).join(','))
  }
  const total = CSV2_COLUMNS.map(() => '')
  const at = (header: string) => CSV2_COLUMNS.findIndex(c => c[0] === header)
  total[at('Sample ID')] = 'Run total'
  total[at('Tris used (uL)')] = fmtUl(sum.tris)
  total[at('LAL water used (uL)')] = fmtUl(sum.water)
  total[at('BG600 used (uL)')] = fmtUl(sum.bg)
  total[at('tubes')] = String(sum.tubes)
  lines.push(total.map(csvField).join(','))
  return lines.join('\r\n') + '\r\n'
}
```

- [ ] **Step 6: Run the test to see it pass**

Run: `npx vitest run src/lib/__tests__/endo-bench-sheet-2ml.test.ts src/lib/__tests__/endo-bench-sheet.test.ts`
Expected: PASS, 8 tests in the 2 mL file, and the stock file's existing tests unchanged and passing (they prove the stock output did not move).

- [ ] **Step 7: Pick the 2 mL builder in the actions**

Replace `src/components/hplc/EndoWorksheetActions.tsx` with (the stock path builds exactly what it builds today; the dialog and buttons are unchanged apart from the waiting text):

```tsx
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Eye, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  getWorksheet,
  listConsumables,
  recordWorksheetPrinted,
  type WorksheetListItem,
  type WorksheetUser,
} from '@/lib/api'
import { buildEndoBenchSheetHtml, buildEndoCsv } from '@/lib/endo-bench-sheet'
import {
  buildEndoBenchSheet2Html,
  buildEndoCsv2,
  buildEndoSheet2Doc,
} from '@/lib/endo-bench-sheet-2ml'
import {
  buildEndoSheetDoc,
  isEndoWorksheetItem,
  type EndoSheetOptions,
} from '@/lib/endo-worksheet'
import { worksheetItemSlaSubjects } from '@/lib/worksheet-sla-subjects'
import { downloadTextFile, printHtmlDocument } from '@/lib/print-document'
import { displayName } from '@/lib/user-display'
import { useLabCalendar } from '@/hooks/use-lab-calendar'
import { worksheetPageKey } from '@/hooks/use-worksheet-drawer'
import { useSlaForSubjects } from '@/services/sla-subjects'

/**
 * Preview, Print and CSV for a worksheet that holds endotoxin items, as on
 * Dennis's tool. All three build the same document (bench order, prep
 * figures, SLA due dates) so screen, paper and export never disagree. The
 * tech prints the sheet and carries it to the bench, so every Print is
 * recorded: the first one is the run's start (worksheets.printed_at), and
 * it pins the worksheet's endo method. A 2 mL worksheet prints the 2 mL
 * sheet (endo-bench-sheet-2ml.ts) from the GET-by-id worksheet, which
 * carries the method; a stock worksheet prints the stock sheet as before.
 * Renders nothing on a worksheet with no endo work.
 */
export function EndoWorksheetActions({
  worksheet,
  users,
}: {
  worksheet: WorksheetListItem
  users: WorksheetUser[]
}) {
  const queryClient = useQueryClient()
  const { calendar } = useLabCalendar()
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const endoItems = worksheet.items.filter(isEndoWorksheetItem)
  const { byKey } = useSlaForSubjects(
    worksheetItemSlaSubjects(
      endoItems,
      worksheet.status === 'completed' ? worksheet.completed_at : null
    )
  )
  const twoMl = worksheet.endo_prep === '2ml'
  // The list payload has no endo_method key; a 2 mL sheet needs the method
  // (run parameters, cartridges), so it reads the page's GET-by-id entry.
  const needsFull = twoMl && worksheet.endo_method === undefined
  const { data: full } = useQuery({
    queryKey: worksheetPageKey(worksheet.id),
    queryFn: () => getWorksheet(worksheet.id),
    enabled: needsFull,
    staleTime: 30_000,
  })
  const sheetWorksheet = needsFull ? full : worksheet
  // With no method resolved, every active endo cartridge is allowed (4.3).
  const needsCatalog = twoMl && sheetWorksheet?.endo_method === null
  const { data: catalog } = useQuery({
    queryKey: ['consumables', 'endo_cartridge'],
    queryFn: () => listConsumables({ kind: 'endo_cartridge' }),
    enabled: needsCatalog,
    staleTime: 5 * 60_000,
  })
  // The browser never says whether the print dialog was confirmed, so the
  // click is what gets recorded. A failed record must not block the printout.
  const recordPrint = useMutation({
    mutationFn: () => recordWorksheetPrinted(worksheet.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['worksheets-list'] })
      queryClient.invalidateQueries({ queryKey: ['worksheet-by-id'] })
    },
  })
  if (!endoItems.length) return null

  const analyst = users.find(u => u.id === worksheet.assigned_analyst)
  const analystName = analyst
    ? displayName(analyst)
    : (worksheet.assigned_analyst_email ?? '')
  const opts = (): EndoSheetOptions => ({
    analystName,
    calendar,
    printedAt: new Date().toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    dueAtByItemId: new Map(
      endoItems.map(it => [it.id, byKey.get(String(it.id))?.status.due_at ?? null])
    ),
  })
  const sheetHtml = (preview: boolean) =>
    twoMl && sheetWorksheet
      ? buildEndoBenchSheet2Html(buildEndoSheet2Doc(sheetWorksheet, opts(), catalog), {
          preview,
        })
      : buildEndoBenchSheetHtml(buildEndoSheetDoc(worksheet, opts()), { preview })
  const sheetCsv = () =>
    twoMl && sheetWorksheet
      ? buildEndoCsv2(buildEndoSheet2Doc(sheetWorksheet, opts(), catalog))
      : buildEndoCsv(buildEndoSheetDoc(worksheet, opts()))
  const fileStem = worksheet.title.replace(/[^A-Za-z0-9._-]+/g, '_')
  const waiting = !calendar
    ? 'Loading the lab calendar…'
    : twoMl && (!sheetWorksheet || (needsCatalog && !catalog))
      ? 'Loading the run settings…'
      : undefined

  function print() {
    printHtmlDocument(sheetHtml(false))
    recordPrint.mutate()
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={waiting !== undefined}
        title={waiting ?? 'See the bench sheet as it will print'}
        onClick={() => setPreviewHtml(sheetHtml(true))}
      >
        <Eye className="h-3.5 w-3.5" />
        Preview
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={waiting !== undefined}
        title={waiting ?? 'Print the bench sheet to take to the bench'}
        onClick={print}
      >
        <Printer className="h-3.5 w-3.5" />
        Print
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={waiting !== undefined}
        title={waiting ?? 'Export the bench rows as CSV'}
        onClick={() => downloadTextFile(`${fileStem}_endotoxin.csv`, sheetCsv())}
      >
        <Download className="h-3.5 w-3.5" />
        CSV
      </Button>

      <Dialog
        open={previewHtml !== null}
        onOpenChange={open => {
          if (!open) setPreviewHtml(null)
        }}
      >
        <DialogContent className="flex h-[92vh] w-[1160px] max-w-[96vw] flex-col gap-0 p-0 sm:max-w-[96vw]">
          <div className="flex items-center gap-3 border-b px-4 py-2.5 pr-12">
            <DialogTitle className="text-sm font-semibold">
              Print preview
            </DialogTitle>
            <DialogDescription className="font-mono text-[11.5px]">
              {worksheet.title} · landscape Letter, 10 samples per page
            </DialogDescription>
            <span className="flex-1" />
            <Button
              size="sm"
              className="bg-teal-600 text-white hover:bg-teal-600/90"
              onClick={() => {
                setPreviewHtml(null)
                print()
              }}
            >
              <Printer className="h-3.5 w-3.5" />
              Print
            </Button>
          </div>
          {previewHtml !== null && (
            <iframe
              title="Bench sheet preview"
              sandbox=""
              srcDoc={previewHtml}
              className="min-h-0 w-full flex-1 border-0 bg-[#E7ECEC]"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

export default EndoWorksheetActions
```

If Task 13 changed `recordPrint`'s `onSuccess` (for example to invalidate the page key), keep its version: `['worksheets-list']` already covers `worksheetPageKey`.

- [ ] **Step 8: Run the neighbours, the typecheck and lint**

Run: `npx vitest run src/lib/__tests__/endo-bench-sheet-2ml.test.ts src/lib/__tests__/endo-bench-sheet.test.ts src/components/hplc src/test/worksheets-inbox-lanes.test.tsx`
Expected: PASS.

Run: `npm run typecheck && npx eslint src/lib/endo-bench-sheet-2ml.ts src/lib/endo-bench-sheet.ts src/components/hplc/EndoWorksheetActions.tsx --max-warnings 0`
Expected: no errors. If `OffscreenCanvasRenderingContext2D` is missing from the `DOM` lib in the installed TypeScript, type `canvas` as `{ font: string; measureText(t: string): { width: number } } | null | undefined` instead.

Manual check (the side-by-side layout check is Task 20's): on a stack worksheet on 2 mL, Preview shows pages of 816 px with no clipped cell, the 1:250 rows before a 1:300, a rule between them, and the summary page last.

- [ ] **Step 9: Commit**

```bash
git -C C:/tmp/Accu-Mk1-endo-v2 add src/lib/endo-bench-sheet-2ml.ts src/lib/__tests__/endo-bench-sheet-2ml.test.ts
git -C C:/tmp/Accu-Mk1-endo-v2 diff --stat -- src/lib/endo-bench-sheet.ts src/components/hplc/EndoWorksheetActions.tsx
git -C C:/tmp/Accu-Mk1-endo-v2 commit -m "feat(endo-v2): 2 mL bench sheet, summary page and CSV" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/endo-bench-sheet-2ml.ts src/lib/__tests__/endo-bench-sheet-2ml.test.ts src/lib/endo-bench-sheet.ts src/components/hplc/EndoWorksheetActions.tsx
```

PR note (outcome A of Step 1): "Mk1's analyte names carry ' - Identity (HPLC)'; the 2 mL sheet strips it per analyte with splitIdentity and keeps the raw text in the CSV's 'identity as received'. The stock sheet is unchanged."


---

### Task 19: "How results are judged" on the Analysis Service page

**Files:**
- Create: `src/components/hplc/ServiceEndoJudgedPanel.tsx`
- Create: `src/components/hplc/__tests__/ServiceEndoJudgedPanel.test.tsx`
- Modify: `src/components/hplc/AnalysisServicesPage.tsx` (mount the panel under the service's Methods section)

**Interfaces:**
- Consumes: `listServiceSpecs`, `getServiceMethods`, `getMethods`, `AnalysisServiceRecord`, `AnalysisServiceSpecRecord`, `ServiceMethodLink`, `HplcMethod` (`api.ts`); `getMethodConsumables`, `MethodConsumableLink` (`consumable_type_id`, `kind`, `is_default`), `listConsumables`, `ConsumableType`, `EndoMethodInfo`, `HplcMethod.run_parameters` (Task 10); `runParamsFrom` (Task 13 glue); `LIMIT_EU_PER_VIAL`, `BW_LIMIT_EU_PER_ML`, `BW_DILUTION` (Task 8); `ruleLabel`, `tierChip` (`ServiceSpecsSection.tsx`); `navigateToMethod`, `navigateTo('lims', 'consumables')` (`ui-store.ts`; the `'consumables'` subsection is Task 11's).
- Produces: `ServiceEndoJudgedPanel({ service })`, read-only, on the service detail of a service whose keyword contains `ENDO` (spec 6.7); for any other service it returns `null` and fires no query (the queries live in an inner component that only mounts for endo services). It lists:
  - each active spec tier (sample type: the tier chip), its unit, its limit (`ruleLabel` without the LOQ suffix) and its fixed LOQ, as configured;
  - the worksheet rules: LOD = the cartridge's sensitivity; LOQ = sensitivity x total dilution x water (worked at the standard prep on the method's default cartridge), bac water sensitivity x 20; validity from the method's spike recovery range and CV limit; the working limits 350 EU per vial and 0.25 EU/mL marked "not yet the COA spec";
  - the resolved method (the service's active default method link) with its revision, linking to the Methods page (`navigateToMethod`), and its cartridges with sensitivities, each linking to the Consumables page.
  - The run parameters come from the method's `run_parameters` through `runParamsFrom`, the same function the worksheet uses, applied to an `EndoMethodInfo` built from the method and its cartridge links joined to the catalog.

- [ ] **Step 1: Write the failing test**

Create `src/components/hplc/__tests__/ServiceEndoJudgedPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ServiceEndoJudgedPanel } from '@/components/hplc/ServiceEndoJudgedPanel'
import {
  listServiceSpecs,
  type AnalysisServiceRecord,
  type AnalysisServiceSpecRecord,
  type ConsumableType,
  type HplcMethod,
} from '@/lib/api'
import { useUIStore } from '@/store/ui-store'

const spec = (over: Partial<AnalysisServiceSpecRecord>): AnalysisServiceSpecRecord => ({
  id: 1,
  analysis_service_id: 61,
  matrix: 'Peptide',
  peptide_id: null,
  peptide_code: null,
  rule_kind: 'range',
  min_value: null,
  max_value: '5',
  equals_value: null,
  unit: 'EU/mL',
  display_override: null,
  loq: null,
  active: true,
  updated_at: null,
  ...over,
})

const cartridge: ConsumableType = {
  id: 3,
  kind: 'endo_cartridge',
  name: 'Endosafe 0.05',
  manufacturer: null,
  part_number: null,
  instrument_id: null,
  specs: { sensitivity_eu_ml: 0.05 },
  active: true,
  in_use: true,
}

vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  listServiceSpecs: vi.fn(),
  getServiceMethods: vi.fn(),
  getMethods: vi.fn(),
  getMethodConsumables: vi.fn(),
  listConsumables: vi.fn(),
}))

async function mockApi() {
  const api = await import('@/lib/api')
  vi.mocked(api.listServiceSpecs).mockResolvedValue([
    spec({ id: 1 }),
    spec({ id: 2, matrix: 'Bacteriostatic Water', max_value: '0.5', loq: '0.25' }),
  ])
  vi.mocked(api.getServiceMethods).mockResolvedValue([
    {
      method_id: 12,
      name: 'Endotoxin (LAL)',
      code: null,
      technique: 'LAL',
      revision: 2,
      status: 'active',
      is_default: true,
    },
  ])
  vi.mocked(api.getMethods).mockResolvedValue([
    {
      id: 12,
      name: 'Endotoxin (LAL)',
      revision: 2,
      status: 'active',
      run_parameters: { endotoxin: { cv_limit_pct: 20 } },
    } as HplcMethod,
  ])
  vi.mocked(api.getMethodConsumables).mockResolvedValue([
    { consumable_type_id: 3, kind: 'endo_cartridge', is_default: true },
  ])
  vi.mocked(api.listConsumables).mockResolvedValue([cartridge])
}

function renderPanel(service: Partial<AnalysisServiceRecord>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return render(
    <ServiceEndoJudgedPanel service={{ id: 61, keyword: 'ENDO-LAL', ...service } as AnalysisServiceRecord} />,
    { wrapper: wrap }
  )
}

describe('ServiceEndoJudgedPanel', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await mockApi()
  })

  it('lists the spec tiers, the worksheet rules and the method with its cartridges', async () => {
    renderPanel({})
    expect(await screen.findByText('≤ 5 EU/mL')).toBeInTheDocument()
    expect(screen.getByText('Peptide')).toBeInTheDocument()
    expect(screen.getByText('Bacteriostatic Water')).toBeInTheDocument()
    expect(screen.getByText('0.25')).toBeInTheDocument()
    // the method's own CV limit, Dennis's recovery range
    expect(
      await screen.findByText(/spike recovery 50 to 200 % and both CVs at most 20 %/)
    ).toBeInTheDocument()
    expect(
      await screen.findByText(/0\.05 × 250 × 2 mL = 25 EU per vial at the standard prep/)
    ).toBeInTheDocument()
    expect(screen.getByText('not yet the COA spec')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Endosafe 0.05' })).toBeInTheDocument()
    expect(screen.getByText('0.05 EU/mL')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Endotoxin (LAL) · Rev 2' }))
    expect(useUIStore.getState().methodsTargetId).toBe(12)
  })

  it('shows nothing, and asks for nothing, on a service that is not endotoxin', () => {
    const { container } = renderPanel({ keyword: 'HPLC-PURITY' })
    expect(container).toBeEmptyDOMElement()
    expect(listServiceSpecs).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run src/components/hplc/__tests__/ServiceEndoJudgedPanel.test.tsx`
Expected: FAIL, `Failed to resolve import "@/components/hplc/ServiceEndoJudgedPanel"`.

- [ ] **Step 3: Create the panel**

Create `src/components/hplc/ServiceEndoJudgedPanel.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import {
  getMethodConsumables,
  getMethods,
  getServiceMethods,
  listConsumables,
  listServiceSpecs,
  type AnalysisServiceRecord,
  type EndoMethodInfo,
} from '@/lib/api'
import { fmt } from '@/lib/endo-prep'
import {
  BW_DILUTION,
  BW_LIMIT_EU_PER_ML,
  LIMIT_EU_PER_VIAL,
} from '@/lib/endo-prep-2ml'
import { runParamsFrom } from '@/lib/endo-worksheet-2ml'
import { useUIStore } from '@/store/ui-store'
import { ruleLabel, tierChip } from './ServiceSpecsSection'

const SUB =
  'mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground'
const LINK =
  'font-medium text-teal-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-teal-500 dark:text-teal-300'

/**
 * "How results are judged" (spec 2026-10-10 6.7), read-only, on an endotoxin
 * service's detail: the spec tiers as configured, the worksheet's rules (LOD,
 * LOQ, validity, the working limits) with the resolved method's numbers, and
 * the method and its cartridges with links to their admin pages. Shows
 * nothing, and fetches nothing, for any other service.
 */
export function ServiceEndoJudgedPanel({
  service,
}: {
  service: AnalysisServiceRecord
}) {
  if (!/ENDO/i.test(service.keyword ?? '')) return null
  return <EndoJudged serviceId={service.id} />
}

function EndoJudged({ serviceId }: { serviceId: number }) {
  const { data: specs } = useQuery({
    queryKey: ['analysis-services', serviceId, 'specs'],
    queryFn: () => listServiceSpecs(serviceId),
    staleTime: 60_000,
  })
  const { data: links } = useQuery({
    queryKey: ['analysis-services', serviceId, 'methods'],
    queryFn: () => getServiceMethods(serviceId),
    staleTime: 60_000,
  })
  // The resolved method (spec 4.1): the service's active default.
  const link = links?.find(l => l.is_default && l.status === 'active') ?? null
  const methodId = link?.method_id ?? null
  const { data: methods } = useQuery({
    queryKey: ['hplc-methods'],
    queryFn: getMethods,
    staleTime: 5 * 60_000,
    enabled: methodId !== null,
  })
  const { data: methodLinks } = useQuery({
    queryKey: ['hplc-methods', methodId, 'consumables'],
    queryFn: () => getMethodConsumables(methodId ?? 0),
    enabled: methodId !== null,
  })
  const { data: catalog } = useQuery({
    queryKey: ['consumables', 'endo_cartridge'],
    queryFn: () => listConsumables({ kind: 'endo_cartridge' }),
    staleTime: 5 * 60_000,
    enabled: methodId !== null,
  })

  const method = methods?.find(m => m.id === methodId) ?? null
  const cartridges = (methodLinks ?? []).flatMap(l => {
    const c = catalog?.find(x => x.id === l.consumable_type_id)
    return c && c.kind === 'endo_cartridge'
      ? [
          {
            id: c.id,
            name: c.name,
            sensitivity_eu_ml: Number(c.specs.sensitivity_eu_ml),
            is_default: l.is_default,
            active: c.active,
          },
        ]
      : []
  })
  // The same EndoMethodInfo shape the worksheet resolves, so the numbers
  // here come from the same runParamsFrom.
  const info: EndoMethodInfo | null = method
    ? {
        id: method.id,
        name: method.name,
        revision: method.revision,
        status: method.status,
        run_parameters: method.run_parameters ?? null,
        cartridges,
      }
    : null
  const p = runParamsFrom(info)
  const dflt = cartridges.find(c => c.is_default && c.active) ?? null
  const tiers = (specs ?? []).filter(s => s.active)
  const ui = useUIStore.getState

  return (
    <div className="border-t pt-4">
      <h4 className="mb-3 text-sm font-semibold text-muted-foreground">
        How results are judged
      </h4>
      <div className="space-y-4 text-sm">
        <section>
          <h5 className={SUB}>Spec tiers (what the COA uses today)</h5>
          {tiers.length === 0 ? (
            <p className="text-muted-foreground">No specs yet.</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 font-medium">Sample type</th>
                  <th className="py-1 font-medium">Unit</th>
                  <th className="py-1 font-medium">Limit</th>
                  <th className="py-1 font-medium">Fixed LOQ</th>
                </tr>
              </thead>
              <tbody>
                {tiers.map(s => (
                  <tr key={s.id} className="border-t">
                    <td className="py-1.5">
                      <Badge variant="outline" className="text-xs">
                        {tierChip(s)}
                      </Badge>
                    </td>
                    <td className="py-1.5 font-mono">{s.unit ?? '-'}</td>
                    <td className="py-1.5 font-mono">{ruleLabel({ ...s, loq: null })}</td>
                    <td className="py-1.5 font-mono">{s.loq ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h5 className={SUB}>On the endotoxin worksheet (2 mL prep)</h5>
          <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-muted-foreground">LOD</dt>
            <dd>
              The cartridge&apos;s sensitivity (λ), EU/mL; the dilution does not
              change it.
            </dd>
            <dt className="text-muted-foreground">LOQ</dt>
            <dd>
              {`λ × total dilution × water, EU per vial${
                dflt
                  ? `: ${fmt(dflt.sensitivity_eu_ml)} × ${fmt(p.stdTotalDilution)} × ${fmt(p.reconWaterMl)} mL = ${fmt(dflt.sensitivity_eu_ml * p.stdTotalDilution * p.reconWaterMl)} EU per vial at the standard prep`
                  : ''
              }. Bac water: λ × ${fmt(BW_DILUTION)}, EU/mL.`}
            </dd>
            <dt className="text-muted-foreground">Valid test</dt>
            <dd>
              {`spike recovery ${p.spikeRecoveryMinPct} to ${p.spikeRecoveryMaxPct} % and both CVs at most ${p.cvLimitPct} %; otherwise the verdict is Invalid and nothing goes to Accu-Mk1.`}
            </dd>
            <dt className="text-muted-foreground">Working limits</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {`${LIMIT_EU_PER_VIAL} EU per vial (peptides), ${fmt(BW_LIMIT_EU_PER_ML)} EU/mL (bac water)`}
              <Badge variant="secondary" className="text-[10px]">
                not yet the COA spec
              </Badge>
            </dd>
          </dl>
        </section>

        <section>
          <h5 className={SUB}>Method</h5>
          {!link ? (
            <p className="text-muted-foreground">
              No active default method covers this service, so worksheets
              allow every active endotoxin cartridge and use the standard run
              parameters.
            </p>
          ) : (
            <div className="space-y-1.5">
              <button
                type="button"
                className={LINK}
                onClick={() => ui().navigateToMethod(link.method_id)}
              >
                {`${link.name} · Rev ${link.revision}`}
              </button>
              {cartridges.length === 0 ? (
                <p className="text-muted-foreground">
                  No cartridges linked to this revision yet; they are set on a
                  draft revision of the method.
                </p>
              ) : (
                <ul className="space-y-1">
                  {cartridges.map(c => (
                    <li key={c.id} className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={LINK}
                        onClick={() => ui().navigateTo('lims', 'consumables')}
                      >
                        {c.name}
                      </button>
                      <span className="font-mono text-xs">
                        {`${fmt(c.sensitivity_eu_ml)} EU/mL`}
                      </span>
                      {c.is_default && (
                        <Badge variant="secondary" className="text-[10px]">
                          Default
                        </Badge>
                      )}
                      {!c.active && (
                        <Badge variant="outline" className="text-[10px]">
                          Retired
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default ServiceEndoJudgedPanel
```

- [ ] **Step 4: Mount it on the service detail**

In `src/components/hplc/AnalysisServicesPage.tsx`:

1. After `import { ServiceSpecsSection } from './ServiceSpecsSection'` add `import { ServiceEndoJudgedPanel } from './ServiceEndoJudgedPanel'`.
2. In `ServicePanel`'s read-only detail block, directly after `<ServiceMethodsSection serviceId={service.id} />`, add:

```tsx
          <ServiceEndoJudgedPanel service={service} />
```

- [ ] **Step 5: Run the test to see it pass, and the page's suites**

Run: `npx vitest run src/components/hplc/__tests__/ServiceEndoJudgedPanel.test.tsx src/components/hplc/__tests__/ServiceSpecsSection.test.tsx src/test/analysis-services-guide-ui.test.tsx src/test/service-methods-section.test.tsx`
Expected: PASS (the panel renders nothing for the non-endo services those suites use).

Run: `npm run typecheck && npx eslint src/components/hplc/ServiceEndoJudgedPanel.tsx src/components/hplc/AnalysisServicesPage.tsx --max-warnings 0`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C C:/tmp/Accu-Mk1-endo-v2 add src/components/hplc/ServiceEndoJudgedPanel.tsx src/components/hplc/__tests__/ServiceEndoJudgedPanel.test.tsx
git -C C:/tmp/Accu-Mk1-endo-v2 commit -m "feat(endo-v2): how results are judged, on the endotoxin service page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/hplc/ServiceEndoJudgedPanel.tsx src/components/hplc/__tests__/ServiceEndoJudgedPanel.test.tsx src/components/hplc/AnalysisServicesPage.tsx
```

---

### Task 20: Gates, layout parity and UAT

**Files:**
- Create: `docs/superpowers/plans/assets/2026-10-10-endo-v2-parity/` (screenshots and the parity list)
- No product code changes unless a gate or the parity check finds a defect; any fix goes back to its owning task's files with a test first.

**Interfaces:**
- Consumes: everything from Tasks 1 to 19.
- Produces: a branch that passes the gates, a parity list accepted by the Handler, and a UAT sign-off.

- [ ] **Step 1: Frontend gate**

Run: `npm run check:all`
Expected: typecheck, lint, ast-lint, format and tests pass, except failures that also fail on `origin/master` (record the master baseline first with the same command in a detached worktree of `origin/master` if anything fails). Never run `prettier --write` on files that were not clean on master (`src/lib/api.ts` and `WorksheetDrawer.tsx` were not clean as of 1.42.x).

- [ ] **Step 2: Bring up an isolated stack**

Use the `accumark-stack-platform` skill to create a stack on the devbox from the current golden, with Accu-Mk1 mounted from this branch (`feat/endo-worksheet-v2`). Record the stack name, the Mk1 URL and the backend container name in the PR description.

- [ ] **Step 3: Backend suite as a failure-set diff (inside the container, one suite at a time)**

```bash
# in the stack backend container
pip install pytest pytest-timeout httpx
cd /app && python -m pytest -q -p no:cacheprovider --timeout=120 2>&1 | tail -40 > /tmp/branch_failures.txt
# baseline: origin/master backend copied in with git archive, run ALONE after the branch run finishes
python -m pytest -q -p no:cacheprovider --timeout=120 2>&1 | tail -40 > /tmp/master_failures.txt   # run from the master copy's directory
```
Expected: the set of failing test ids on the branch is a subset of master's; every new `test_endo_v2_*` test passes. Never run the two suites at the same time (they deadlock on the shared dev Postgres).

- [ ] **Step 4: Postgres-only migration test**

Run inside the container. The test uses a throwaway schema on the URL in `MK1_TEST_POSTGRES_URL` (never the live `MK1_DB_*` database's own tables); build it from the container's `MK1_DB_*` variables as the test's docstring shows, then:
`cd /app && MK1_TEST_POSTGRES_URL=<built url> python -m pytest tests/test_endo_v2_migration.py -q`
If `tests/` is not in the image, `docker cp` the branch's `backend/tests` in first.
Expected: PASS (switch applied once; a second boot changes nothing; a worksheet switched back to stock stays stock; completed stays stock; staging since 2026-10-08 is 2 mL).

- [ ] **Step 5: Catalog and method setup on the stack (the launch steps, rehearsed)**

In production these three steps run in the same after-hours window as the deploy, before the lab opens: until a cartridge exists, every 2 mL worksheet (including the ones the migration switched) has no run cartridge, so Box 1's MVD/MVC and all of Box 3 stay blank. On the stack, first confirm that blank state on a switched worksheet, then:

1. Consumables page: add three `endo_cartridge` types with sensitivities 0.05, 0.01, 0.005 EU/mL (part numbers can be placeholders on the stack only).
2. Instruments page: set a serial number on the endotoxin reader instrument.
3. Methods page: new revision of the Endotoxin method; add the three cartridges with 0.05 as default; leave run parameters empty (Dennis's values apply); activate.
Expected: the Analysis Service page's "How results are judged" panel shows the method revision and the three cartridges.

- [ ] **Step 6: Layout parity with Dennis's tool**

1. On the stack, open an endo worksheet with at least 6 samples (one bac water, one with a non-standard total) on the full page; export its CSV.
2. Locally: `cd C:/tmp/tools-dennis/tools/endotoxin-log && set ENDO_PORT=8779 && node serve-local.js`, create a run dated 2026-10-10, and drop the exported CSV into its intake so both show the same samples.
3. Screenshot both at 1920x1080 and 1440x900: the prep box, the Sample dilution box, the Results box (after typing the same readings in both), and the 2 mL print preview.
4. Write `docs/superpowers/plans/assets/2026-10-10-endo-v2-parity/parity.md`: one line per difference (box, column, width, spacing, caption, colour) with "fixed" or "accepted by Handler".
Expected: no unexplained differences in box order, column order, captions or numbers; widths within the colgroup percentages.

- [ ] **Step 7: Reader import rehearsal**

Import Dennis's made-up export (from `calc.test.js`) after renaming its Sample IDs to the stack worksheet's IDs; check: preview matches, one row with a different typed reading needs its box ticked, an Invalid test shows Invalid with no Accu-Mk1 value, the reader serial stamps the instrument set in Step 5.

- [ ] **Step 8: UAT with the Handler and Dennis**

Hand over the stack URL and a short checklist: Prep switch on an old worksheet does not change its numbers; a new worksheet is 2 mL; the flyout is read-only and Open worksheet works; Box 2 edits; readings typed and imported; print and CSV; Consumables and method lock (an active method's cartridges cannot be edited); the release-note line about Accu-Mk1 values being per vial. Record their results in the PR.

- [ ] **Step 9: Commit the parity evidence**

```bash
git add docs/superpowers/plans/assets/2026-10-10-endo-v2-parity
git commit -m "docs(endo-v2): layout parity evidence and UAT notes" -- docs/superpowers/plans/assets/2026-10-10-endo-v2-parity
```

Merging, the release and the deploy follow the `accumark-deploy` skill after the Handler's sign-off; they are not part of this plan.

---

## Appendix A: drafting deviations and how they were reconciled

### A.0 Lead reconciliation decisions (these override anything below that disagrees)

1. **Allowed cartridges.** A method that lists no endo cartridges allows every active endo cartridge with no default, the same as when no method resolves; a method that lists any restricts to its active ones (Task 5; spec 4.3 updated).
2. **Reader record on a typed reading.** A typed reading over an imported one keeps `result_reader` (the screen flags the difference, validity still comes from the record); clearing the reading clears `result_reader`, and the cleared record is kept in the `endo_reading_cleared` audit row (Task 6; spec section 9 updated).
3. **Total dilution floor.** `prep_total_dilution` below twice the row's step 1 ratio (from `prep_steps[0][1]`, else 10) is a 400; tube overflow stays an on-screen warning (Task 6; spec section 10 updated).
4. **Instrument stamp.** The reader import sets Ran through the existing `_apply_bench_ticks`, which stamps `instrument_id` on the vial's analyses as the MCS tick does today; never `method_id` (Task 7; plan Global Constraints and spec section 1 updated).
5. **Reader record carries `result`.** `EndoReaderRecord.result` is the reading exactly as the reader exported it, so the screen can flag a typed reading that differs (Tasks 9, 15, 16; spec 8.4 updated).
6. **Migration placement.** `database._run_endo_v2_migrations(bind)` runs from `init_db` right after `create_all`, Postgres only, one transaction (Task 1; spec 3.8 updated). The migration test reads `MK1_TEST_POSTGRES_URL` and uses a throwaway schema (Task 20 step 4).
7. **Layout source.** The page copies Dennis's on-screen CSS; paper copies his print CSS (10pt base, 14pt titles); the parity check decides any screen disagreement (Tasks 13 to 15, 18; spec 6.8 updated).
8. **`fmtConc` has one definition**, in `src/lib/endo-prep-2ml.ts` (Task 8, now accepting `undefined`); the Task 13 glue re-exports it.
9. **`endoCtxFor(ws, catalog?)`** as Task 13's code defines it (the note sent to the Tasks 14 to 19 drafter said `(ws, method?, catalog?)`; the code wins and Tasks 14 to 19 follow it).
10. **`MethodConsumableLink`** in the frontend is a subset of the server's `MethodConsumableOut` (`consumable_type_id`, `kind`, `is_default`); the extra keys are ignored. The PUT body sends `consumable_type_id` and `is_default`.
11. **Box 3 column order** follows Dennis's screen (EU/mg before LOD), over the order listed in spec 6.1.
12. **All-endo stock worksheets** also get the read-only flyout and the page (Box 1 only), per spec 6.2; their print and CSV stay byte-identical.
13. **Identity label.** Task 18's code trace found Mk1 can join analyte names stored as "<peptide> - Identity (HPLC)"; the 2 mL sheet strips the suffix per analyte with `splitIdentity`, and Dennis's 952 case in Task 9's test file is active.
14. **`delete_method`** returns 409 when a worksheet pins the method (Task 1); a pinned method revision cannot vanish.
15. **Run parameters on non-draft methods.** The method PUT 409s when `run_parameters` is merely present on an active or retired method; the existing method save never sends it, and the Run parameters section is read-only unless the method is a draft (Task 12).

### A.1 Tasks 1 to 4


1. **Migration placement (spec 3.8).**
   - Spec 3.8 says "In `database.py` `_run_migrations`". But `_run_migrations` runs BEFORE `create_all` in `init_db`, so on first boot an `ADD COLUMN ... REFERENCES consumable_types(id)` there would fail and be swallowed as `migration_skipped`.
   - Implemented instead as `database._run_endo_v2_migrations(bind)`, called from `init_db` right after `create_all` and `_ensure_documents_space_column`, before any seed. This follows the `_ensure_documents_space_column` precedent.
   - Same statements, same order. The new tables come from `create_all`, as the spec says.
   - It runs on Postgres only, in one transaction, so the switch is atomic. A failure raises at boot (the documents precedent), because the ORM maps the columns. The lab time zone is checked: `PUT` on business hours validates it with `ZoneInfo`.
2. **Registry shape (spec 3.2).** The spec writes `{"sensitivity_eu_ml": "positive_float"}`. Each spec entry is instead a dict `{"label", "unit", "type", "required"}`, because `kinds_payload()` must serve label, unit and required.
3. **Extra helpers.**
   - `catalog/consumables.py` gains `used_type_ids(db) -> set[int]`, so `GET /consumables` computes `in_use` in one query instead of one per row.
   - `main.py` gains `_blank_to_none` (Task 2, reused by Task 4) and `_instrument_holding_serial` (Task 4).
4. **FK choices and the `delete_method` guard.**
   - `worksheets.cartridge_type_id`, `worksheet_items.cartridge_type_id` and `worksheets.endo_method_id` are plain FKs (no ON DELETE), so a used type or a pinned method cannot vanish.
   - `delete_method` (which today deletes any method that analyses do not reference) now returns 409 when a worksheet pins the method. This is added in Task 1.
5. **`validate_run_parameters` normalization.**
   - A key sent as null is dropped and means the default.
   - An empty block, or nothing left, stores `None`.
   - Numbers are stored as sent (int stays int).
   - `min < max` and `std_total_dilution >= 20` are checked on the EFFECTIVE values, with defaults filling missing keys. For example, `spike_recovery_min_pct: 250` alone is refused against the default max of 200.
   - On a non-draft method, the locked-fields 409 wins over the 400.
6. **Response shapes Task 10 must type.**
   - `ConsumableTypeResponse` = `{id, kind, name, manufacturer, part_number, instrument_id, specs, active, origin, in_use, created_at, updated_at}`.
   - `ConsumableKindOut` = `{key, label, specs: [{key, label, unit, type, required}]}`.
   - `MethodConsumableOut` (GET and PUT `/hplc/methods/{id}/consumables`) = `{consumable_type_id, kind, name, specs, active, is_default}`, ordered by kind then name.
7. **Method consumables rules.**
   - "Kind-consistent" means the link's `kind` is copied from the type and never sent by the client.
   - A retired type cannot be linked (400). A link to a type retired later is still copied by new-revision; the next PUT on that draft must drop it.
   - The audit uses `log_members` twice, with fields `consumables` and `consumable_defaults`, so a change of default alone is logged.
8. **`MethodCreate` does not take `run_parameters`.** They are set by PUT on the draft, as spec 3.4 says.
9. **Postgres test env var.** The test uses `MK1_TEST_POSTGRES_URL`, with a throwaway schema.
   - There is no URL-based precedent. The only Postgres precedent, `test_per_substance_reconciler.py`, uses `SessionLocal` against the live `MK1_DB_*` database and would rewrite real worksheets.
   - Task 20 should export `MK1_TEST_POSTGRES_URL` in the stack container from the `MK1_DB_*` variables, as the test's docstring shows.
10. **Heads-up for Tasks 5, 6 and 17.**
    - `Worksheet.endo_prep` defaults to `"2ml"` in the ORM. Every SQLite test that builds a `Worksheet(...)`, including the existing `test_worksheet_endo_prep.py` fixtures, now gets a 2 mL worksheet.
    - Any new test asserting stock behaviour must set `endo_prep="stock"` explicitly.
    - After the migration no row is NULL, but the column stays nullable, so serializers should treat NULL as `stock`.
11. **Catalog log entity type for consumables:** `"consumable_type"`.
12. **Heads-up for Task 12 (method panel).** The method PUT lock fires when a locked field is merely PRESENT in the body, even unchanged (existing behaviour for `name` and the rest), and `run_parameters` is now a locked field. So the panel must not send `run_parameters` at all for an active or retired method. The consumables lock (Task 2) fires only on a real change.
13. **Command assumptions.** Test commands use the contract's `cd backend && ...` form and assume each call starts at the repo root; commits use `git -C <repo>` so a persisted `cd backend` cannot break the pathspecs. The lead may want the same rule in every part.

### A.2 Tasks 5 to 7


Lead decisions of 2026-10-10 are folded in (items 4, 6, 7 and 10).

1. **An existing test changes.** `test_get_worksheet_by_id_matches_list_shape` in `test_worksheets_list_sync.py` compared the single GET to the list entry byte for byte. The single GET now adds `endo_method`, as spec 4.1 requires, so the test pops that key and then keeps exact parity (Task 5 Step 9). Accepted.
2. **The reader-import response also carries `endo_method`,** and `items` is every item on the worksheet in the GET shape. Accepted.
3. **`endo_method.run_parameters` is the method's stored column as is** (`{"endotoxin": {...}}` or `null`). `runParamsFrom` (Task 13) applies the defaults. Accepted.
4. **The serial stamp goes through the existing tick path.** `_apply_bench_ticks` gains an `instrument_id` kwarg, and `_open_vial_analyses` is extracted from `_sole_instrument_for_item` with no change in behaviour. The stamp writes `instrument_id` (never `method_id`) as today's MCS tick does. The lead is rewording the plan header to "no new writes to analyses beyond the existing MCS-tick instrument stamp".
5. **Helpers beyond the contract in `worksheets_endo.py`:** `ENDO_CARTRIDGE`, `CARTRIDGE_REFUSED`, `cartridge_sensitivities`, `ENDO_ITEM_FIELDS`, `STEP1_STANDARD_RATIO`, `STEP3_RATIO`, `check_item_endo_fields`, `apply_item_endo_fields`.
6. **Resolution and allowed cartridges.**
   - Method resolution stays strict (spec 4.1). These all make `endo_method` null: any endo row without a vial (a legacy bare parent id), a vial with no live analysis, a service with no active default method, or two rows that disagree.
   - Allowed cartridges (lead decision): a method that lists one or more endo cartridges allows only its active ones. A method that lists none falls back to every active endo cartridge, with no default, the same as when no method resolves.
   - Tests: `test_a_method_that_lists_no_cartridges_allows_every_active_endo_cartridge` (the fallback), plus the strict-list cases in the resolution, PUT and PATCH tests.
7. **`prep_total_dilution` (lead decision):** 400 when the total is not finite, or is below 2 x the row's step 1 ratio. The ratio is `prep_steps[0][1]` when set, else 10, so the floor is never below 2. The check runs on the row as it stands after the PATCH whenever the total or the steps are sent. Tube overflow stays a screen warning. Test: `test_patch_refuses_a_total_the_steps_cannot_make`.
8. **Extra guards:**
   - Clearing a row's cartridge under a stored reading is a 400, to keep the spec 3.1 invariant.
   - `pin_endo_method` is a no-op on completed worksheets. Accepted.
   - The import refuses duplicate `item_id`s and a record without a string `test_id`.
9. **The import compares readings as parsed values,** so `"< 0.05"` equals `"<0.05"` for the no-op and replace rules. Stored readings are the trimmed text as typed.
10. **`result_reader` on the item PATCH (lead decision):**
    - A typed reading keeps the record, so validity still comes from it and the page flags the mismatch.
    - Clearing the reading clears the record. The cleared record is kept in the `endo_reading_cleared` audit row as `old_reader`, because the raw file is not stored anywhere else.
    - Tests: `test_a_typed_reading_over_an_imported_one_keeps_the_reader_record` and `test_clearing_the_reading_clears_the_reader_record_and_audits_it`.
11. **Tests:** one file, `backend/tests/test_endo_v2_worksheets.py`, is shared by Tasks 5 to 7. Tasks 6 and 7 append to it and reuse Task 5's helpers.

### A.3 Tasks 8 and 9


Every contract signature is kept. Where Dennis's behaviour did not fit it, the port adapts internally as follows; items 1, 2, 6 and 9 need a decision or a note in later tasks (Task 6, Tasks 14 and 18, the lead before Tasks 7 and 15, Task 16).

1. **`parseReading`.** Unparseable text returns `null` (Dennis returns `{ lt, value: null, raw }`); `prep2Result` treats it as no reading, so the verdict is the same (none). `"<0"` returns `null` (spec 3.7: `<` needs a positive number; Dennis's regex accepts it). Like Dennis it strips all whitespace first and accepts `.5`; `1.` and `0,8` are refused. **Task 6's `parse_reading` must accept exactly this set** (regex `^(<)?([0-9]*\.?[0-9]+)$` on the text with all whitespace removed, then refuse `<` with a value of 0; `[0-9]`, not `\d`, because Python's `\d` matches Unicode digits and JS's does not), or a cell the screen shows as valid gets a 400.
2. **Bac water plan shape.** The contract's `stepsOf` and `dilutionPlan` cannot return `null`. For bac water: `stepsOf` returns `[]`; `dilutionPlan` returns `{ steps: [], target: 20, total: 20, fits: true, standard: true }` (makeable, not off the standard, never boxed red); `vialDilutionOf` and `targetDilutionOf` stay `null` as Dennis's. **Tasks 14 and 18:** branch on `formOf(s) === 'bac'` and draw its single "50 + 950" step from `calcEndoPrep` (endo-prep.ts), as Dennis's page does.
3. **`EndoStepPlan`.** Dennis's `cumulative` is `running`; his per-step `factor` is not on the plan (call `stepFactor(step)`); his `ruled` flag is gone with method rules.
4. **`EndoCheck.lambda`** replaces his `cartridge` key. The check reports the lambda it is given; the caller resolves it (spec 4.3: row type, else 0.01 for bac water, else the run's). Any positive lambda is accepted: whether it is an allowed cartridge is the catalog's question, not the maths'.
5. **`'invalid'`** is set only when there is a parsed reading (Dennis's guard). Spec 9 (as updated 2026-10-10) clears `result_reader` when the reading is cleared, so in practice this is the contract's `s.reader && !s.reader.valid` rule.
6. **`readerDiffers` cannot be computed.** `EndoReaderRecord` (contract and spec 8.4) carries no reading, yet spec 9 now says a typed reading over an imported one keeps `result_reader` and "the screen flags the difference". To flag it, add `result: string` (the reader's reading as exported, e.g. `<0.05`) to `EndoReaderRecord` and spec 8.4, set `result: t.result` in `toReaderRecord`, and have Task 15 compare `parseReading(item.result_reading)` with `parseReading(record.result)`. Not done here because the contract is fixed; **the lead should decide before Tasks 7 and 15.**
7. **`invalidWhy`** is not on `EndoResult`. The UI (Task 15) shows `s.reader.why.join('; ')`, with Dennis's fallback text "failed the reader's checks" when `why` is empty.
8. **`ReaderTest.slot` is a number**, while Dennis keeps the cell as text (`9999 - MCS 0000001/1` in his made-up export). The port reads the number after the last `/` (or a bare number), else `null`. His fixture is made up, so **confirm against a real export in Task 16 or UAT**; a different shape only makes `slot` null. `ReaderTest` has no `valid` / `why`: `readerValidity(t, params)` computes them against the method. `parseEndoScan` keeps Dennis's behaviour of returning `tests: []` (no throw) when channel rows exist but no sample / spike pair does.
9. **`matchReaderTests`.**
   - It also returns `superseded` (additive).
   - When two tests share the same `testedAt`, or a time does not parse, the later one in the file wins. Dennis marks neither as superseded, and one item would then get two tests in the import request.
   - Times are compared with `Date.parse`. Dennis compares strings, which gives the same result within one export's offset.
   - A vial ID on the reader never pairs with a *different* vial of the same parent: Dennis would pair `P-7000-S02` with a lone `P-7000-S01` row, and spec 8.1 says "never a guess between two vials". Either side being the bare parent still pairs (`P-5299` to `P-5299-S02`, and `P-5299-S02` to a `P-5299` row). None of Dennis's vectors exercise the difference. The guard also leaves a reader `P-5299-S2` against a sheet `P-5299-S02` unmatched where Dennis would pair them; that fails safe (listed and skipped), and the Task 16 preview should expect it.
10. **`readerCartridgeLambda`** returns the range's lower bound, the smallest number in it, in either order. For `"10 - 0.1"` it returns 0.1 where Dennis's `readerCartridge` returns `null` ("not one of my three"): that check moved to the catalog (spec 8.3, "cartridge not in the catalog" in the preview).
11. **`isBacWaterSample`** reuses `isBacWater` from endo-prep.ts, whose sample-type test is `/bacteriostatic|bac\.?\s*water/i`, a superset of spec 4.2's "contains bacteriostatic". One shared rule for both models, as 4.2 asks.
12. **`orderByTotal`** uses explicit groups (numeric totals ascending, then unmakeable, then bac water; ties in input order). Dennis's `Infinity - 1` equals `Infinity`, so in his page unmakeable rows tie with bac water; that only works because his bench order already puts bac water last, and Mk1's `orderForBench` does not.
13. **Bac water factor.** `BW_DILUTION` is endo-prep.ts's `DEFAULT_DILUTION` (20). Dennis's factor read from a weight note ("40X Dilution in 1 EU/mL Cartridge") has no Mk1 field; bac water is 20x on 2 mL runs (spec 4.4).
14. **`EndoResult.lt`** is `false`, not `null`, when there is no reading (Dennis's value; the contract type allows both).

### A.4 Tasks 10 to 13


1. **`WorksheetRow` does not exist in the repo.** The worksheet type is `WorksheetListItem` (`src/lib/api.ts`) and the item type `WorksheetItemRow` (`src/lib/worksheet-sla-subjects.ts`, re-exported by `src/lib/endo-worksheet.ts`). `src/lib/endo-worksheet-2ml.ts` exports `type WorksheetRow = WorksheetListItem` and re-exports `WorksheetItemRow`, so code written to the contract names compiles.
2. **`endoCtxFor` and `endoSampleFor` take an optional third argument `catalog: ConsumableType[] = []`.** With no resolved method the allowed list is every active endo cartridge (spec 4.3), which a pure function of the worksheet cannot know. The page fetches it (`listConsumables({ kind: 'endo_cartridge' })`, query key `['consumables', 'endo_cartridge']`) and passes it. Two-argument calls still work; with no method and no catalog they resolve no allowed list (bac water then takes the run cartridge).
3. **Glue additions** in `src/lib/endo-worksheet-2ml.ts`: `EndoCartridgeOption`, `EndoCartridgeRef`, `EndoRow` (`{ item, n, sample, cartridge, inherited }`), `allowedCartridges(ws, catalog?)`, `runCartridgeFor(ws, catalog?)`, `endoRowsFor(ordered, ws, catalog?)`, `fmtConc`, `cartridgeNote`, `cartridgeTitle`. `EndoRow.cartridge.id` is the id Task 15 must send as `cartridge_type_id` with a reading on a row that has none of its own (spec 9). Tasks 14, 15 and 18 should read rows from `endoRowsFor` rather than calling `endoSampleFor` per item, so every surface resolves the same cartridge.
4. **The page's cache key is `['worksheets-list', 'page', id]` (`worksheetPageKey`), not `['worksheet-by-id', id]`.** Under the `'worksheets-list'` prefix every existing worksheet mutation (update, ticks, remove, reassign, apply, add, print) already refreshes the page with no new invalidations. Checked 2026-10-10: no code reads the prefix's cached data as an array (no `setQueriesData` / `getQueriesData` on it; the only `predicate` invalidations, in `src/services/priorities.ts` and `src/components/flags/use-flag-stream-glue.ts`, read `queryKey` only), so a single-object entry under the prefix is safe. The optimistic item merge moved into the exported `mergeItemPatch` and now patches and rolls back both the open list and the page entry. `updateWorksheetItem` keeps its `{ status, item_id }` return type: the PATCH's `endo_method` is not read; the page refetches GET /worksheets/{id}. `importReaderResults` returns `{ applied, items, endo_method }` as Task 7's part writes it.
5. **`EndoRunHeader` carries the new run settings only (Prep, Run cartridge, Method and revision), rendered as cells of Box 1's meta strip, where Dennis keeps Prep and Cartridge.** Title, rename, analyst, date made, due, orders and Preview / Print / CSV are not duplicated: the page reuses `EndoWorksheetView`'s top bar and `EndoWorksheetTable`'s meta strip, which already show them. The table gained `heading` and `metaExtra` props for this. The run cartridge picker never writes the method default by itself; blank means "Method default (x)".
6. **Boxes 2 and 3 are not mounted by Task 13.** Their files do not exist until Tasks 14 and 15, and importing them would break Task 13's tests and typecheck. Tasks 14 and 15 each add to `src/components/hplc/endo/EndoWorksheetPage.tsx` (inside `EndoWorksheetPageBody`):
   ```tsx
   import type { EndoBoxProps } from './EndoBox'
   import { EndoSampleDilutionBox } from './EndoSampleDilutionBox' // Task 14
   import { EndoResultsBox } from './EndoResultsBox' // Task 15
   // after `const rows = endoRowsFor(...)`:
   const boxProps: EndoBoxProps = { worksheet, rows, ctx, cartridges, isCompleted, onUpdateItem: updateItem }
   // as the children of <EndoWorksheetView ...> (it renders them after Box 1):
   {worksheet.endo_prep === '2ml' && (
     <>
       <EndoSampleDilutionBox {...boxProps} />
       <EndoResultsBox {...boxProps} />
     </>
   )}
   ```
   Both components should accept `EndoBoxProps` and draw their chrome with `EndoBox` (`n`, `title`, `sub`, `actions`) from `src/components/hplc/endo/EndoBox.tsx`, a file this task adds (not in the contract). Box 3's reader drop zone (Task 16) goes in `EndoBox`'s `actions`.
7. **Layout numbers.** Spec 6.8's "base text 10pt, box titles 14pt, box padding 4px 14px 14px, 12px gap" come from Dennis's print stylesheet (`buildBenchSheet`'s inline CSS) and his `.intake-body`, not from the on-screen boxes the side-by-side check compares. The page uses his screen CSS, quoted in `EndoBox.tsx`: `.sheet` radius 5px with a 24px gap, `.results-head` padding 12px 16px 10px, `.legend-title` 9.5px / 600 / .13em uppercase with padding 0 24px 8px, `.results-sub` 12px. `EndoWorksheetTable`'s existing `TH` / `TD` constants already match his screen cells. Task 20 confirms or adjusts.
8. **Box 1 on 2 mL hides Volume to add as well.** Spec 6.1's 2 mL list has Water (mL) in its place (stored in `prep_water_ml`; `prep_volume_ml` keeps its stock meaning, spec 3.7). MVD and MVC sit under the cartridge picker as spec 6.1 says, not in separate columns as on Dennis's screen sheet. The footer drops the Sample / LAL volume totals on 2 mL, as Dennis does.
9. **Shared pieces lifted out so the page edits like the flyout** (the flyout turns read-only in Task 17): `parseWorksheetNotes` / `withNotesText` (`src/lib/worksheet-notes.ts`), `CompleteWorksheetButton` and an exported `WorksheetApplyBar` (`WorksheetDrawer.tsx`), an exported `Meta` (`EndoWorksheetTable.tsx`). The drawer's output is unchanged.
10. **`MethodConsumableLink` is typed minimally** (`consumable_type_id`, `kind`, `is_default`); `MethodConsumablesSection` joins names and numbers from `listConsumables`, so Task 3's exact GET shape does not matter beyond those three keys.
11. **The two method sections mount only on endotoxin methods** (a service link whose keyword contains `ENDO`, or existing `run_parameters.endotoxin`), so HPLC and ICP-MS method panels are unchanged and the existing method suites fetch nothing new.
12. **Fields added to existing types are optional** (`serial_number?`, `run_parameters?`, the worksheet and item keys), so the typed fixtures in existing tests keep compiling.
13. **`updateWorksheet`, `updateWorksheetItem` and `updateMethod` now throw the server's `detail`** through the existing `extractErrorMessage`; the fallback text is today's, so a bodiless failure reads as before. `updateMethod` is not in the contract's Task 10 list; it is changed so spec 10's 400 / 409 reasons for `run_parameters` reach the Run parameters section.


### A.5 Tasks 14 to 19


1. **Box props and chrome come from Task 13, not the contract.** Boxes 2 and 3 take `EndoBoxProps` (`{ worksheet, rows: EndoRow[], ctx, cartridges, isCompleted, onUpdateItem }`) from `src/components/hplc/endo/EndoBox.tsx` and draw their chrome with `EndoBox`; they read `rows` (`row.n`, `row.sample`, `row.cartridge`) instead of calling `endoSampleFor` per item. Task 14 adds the page's `const boxProps: EndoBoxProps = { ... onUpdateItem: updateItem }` and the `worksheet.endo_prep === '2ml'` children of `EndoWorksheetView`; Task 15 adds Box 3 beside Box 2; Task 16's drop zone is Box 3's `actions`.
2. **`endoCtxFor` is called as `endoCtxFor(ws, catalog?)`**, as Task 13's glue (part G4) defines it. The coordinator's note said `endoCtxFor(ws, method?, catalog?)`; the G4 code has no `method` argument, so these tasks follow the code. If Task 13 changes the signature, the calls in Tasks 17 and 18 (`endoCtxFor(ws, catalog)`) move with it.
3. **Cache keys.** Everything that reads the GET-by-id worksheet outside the page (the flyout summary, the mixed `EndoPrepLine`, `EndoWorksheetActions`) uses the page's `worksheetPageKey(id)` (Task 10), so mutations refresh it through the `['worksheets-list']` prefix. The catalog is read under `['consumables', 'endo_cartridge']` with `listConsumables({ kind: 'endo_cartridge' })`, as the page does, only when `endo_method` is `null`. After the reader import, Box 3 writes the response's items and `endo_method` into `worksheetPageKey(id)` and invalidates the `['worksheets-list']` prefix once.
4. **Glue additions in `src/lib/endo-worksheet-2ml.ts` (Task 14):** `BW_SAMPLE_UL`, `BW_LAL_UL`, `standardSteps(ctx)`, `totalGroupKey(s, ctx)`; Box 2 and the 2 mL sheet share them. No other glue is added: the row's resolved cartridge id is Task 13's `EndoRow.cartridge.id`, the allowed list its `allowedCartridges`, the run cartridge its `runCartridgeFor`.
5. **New files outside the contract's list:** `src/components/hplc/endo/EndoWorkedTip.tsx` (the shared worked-line tooltip; the user's standing preference is the shadcn Tooltip card, not `title=`, for non-trivial hovers) and `src/components/hplc/endo/__tests__/endo-fixtures.ts` (test fixtures shared by Tasks 14 to 18).
6. **Exports added to existing files, no output change:** `TH`, `TH_CALC`, `UNIT`, `TD`, `MONO`, `TD_CALC`, `STATUS_CHIP` (`EndoWorksheetTable.tsx`, beside Task 13's `Meta` and `EndoTwoMl`); `PRIORITY_LABEL`, `priorityKey`, `shortDate`, `longDate`, `SHEET_CSS`, `PREVIEW_CSS` (`endo-bench-sheet.ts`). `VERDICT_LABEL`, `VERDICT_TONE` are exported from `EndoResultsBox.tsx` (Task 17 reuses them) and `ReaderImportResult` (a type) from `EndoReaderImportDialog.tsx`.
7. **`fmtConc`** is imported from `src/lib/endo-prep-2ml.ts` (Task 8 exports it); Task 13's glue exports another `fmtConc` with the same behaviour. One of the two should go in Task 20.
8. **Box 3 column order follows Dennis (spec 6.8): EU/mg before LOD**, where spec 6.1's list puts EU/mg after LOQ. Box 3's Cartridge column is read-only (the row's cartridge picker is Box 1's).
9. **The reader-differs note** uses `EndoReaderRecord.result` (added in part G3 at the lead's request), comparing `parseReading` of both; the verdict stays Invalid while `record.valid` is false.
10. **Reader matching** is Task 9's: a reader ID naming a different vial, or a differently written suffix (`P-5299-S2` against `P-5299-S02`), lands in the unmatched list and is skipped. No fuzzy matching is added. Superseded tests come from `matchReaderTests`' `superseded` list.
11. **Spec 6.2 over the contract's "stock worksheets render byte-identically":** all-endo worksheets, stock ones included, get the read-only flyout summary (their editable view is the page, where stock Box 1 is unchanged). Stock printing and CSV are byte-identical.
12. **The mixed-worksheet `EndoPrepLine` on 2 mL** shows the row's cartridge as text (no picker; the picker is on the page) and edits Form, Water and Total.
13. **2 mL paper differs from Dennis's printout where Mk1 already differs or the spec asks:** Made and MCS print empty (as Mk1's stock sheet); the due caption is "SLA"; method-rule R marks, the rules list and blend notes are left out (slice 5); his em dashes are replaced; an over-tube step that is also off the standard is boxed in red (one added CSS rule; his CSS boxed it in the step colour); the CSV drops his four tick columns, adds `step 3 ratio` (spec 7) and writes priority as `priorityKey` (as the stock CSV).
14. **Identity trace outcome A (Task 18, Step 1):** the registry stores analyte names as "<peptide> - Identity (HPLC)" and `_worksheet_item_parent_facts` joins them unstripped, so the 2 mL sheet cuts the suffix per analyte (`productIdentity`, built on `splitIdentity`) and the CSV keeps the raw text. Not verified against prod data.
15. **Consumables navigation** uses `navigateTo('lims', 'consumables')`; Task 11 adds `'consumables'` to `LIMSSubSection`.
