# HPLC Native — Slice 1 (M1 schema + M2 catalog seed + M2b alias set) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the dark, behaviour-neutral Mk1 foundation for native-born HPLC samples: `peptide_id`/`slot` on analysis rows with slot-aware uniqueness, the five native HPLC services + the `hplc-purity-identity` profile + their spec rows seeded at boot, and every hardcoded `hplcpurity_identity` "primary" site accepting the new key as an alias.

**Architecture:** Additive columns via the existing guarded raw-SQL boot migration list; five partial unique indexes on `lims_analyses` widened with `COALESCE(slot, 0)`, each inside one atomic guarded `DO $$` block (no standalone DROP — final-review Finding 1: a standalone DROP followed by a swallow-able CREATE briefly loses uniqueness enforcement, so the DROP and CREATE commit together or not at all, guarded to be a no-op once already widened); a new idempotent boot seeder `catalog/hplc_native_seed.py` modelled on `service_spec_seed.py`, seeding the `hplc-purity-identity` profile **inactive** (final-review Finding 2 — activating it is an explicit flip-runbook step, not a boot-time default) and skipping any service whose keyword already exists under a different origin (Finding 3); alias awareness as a single shared constant `HPLC_PRIMARY_KEYS` consumed by the demand/registry/seeder/FE sites. Nothing in this slice changes runtime behaviour for any existing order: no order carries the new key until the WordPress `profile_key` is set (later slice), and `slot` stays NULL on every existing row (`COALESCE(slot,0)` keeps legacy uniqueness byte-identical).

**Tech Stack:** Python 3.12 / FastAPI / SQLAlchemy 2 (backend), Postgres (prod, live-DB tests via `SessionLocal`), sqlite in-memory for unit tests, pytest; TypeScript + vitest (frontend). Backend tests: `cd backend && pytest`. Frontend: `npm run check:all` (npm only, never pnpm).

**Spec:** `docs/superpowers/specs/2026-09-10-hplc-native-born-design.md` (sections "Key design decisions", "M1", "M2", "M2b"). Read it first.

## Global Constraints

- Additive only. No existing column, index name, route, or test contract is removed. Failing existing tests default to "the test is stale" and need a sign-off before the code is changed.
- Never flip `analysis_services.origin` on an existing row. Every new service is inserted with `origin="mk1"`.
- Keywords: exactly `HPLC-IDENTITY`, `HPLC-PURITY`, `HPLC-QUANTITY`, `HPLC-BLEND-PURITY`, `HPLC-BLEND-TOTAL`. Profile key: exactly `hplc-purity-identity`. Legacy key: `hplcpurity_identity` (unchanged, still seeded from `PRODUCT_REGISTRY`).
- Raw-SQL boot migrations must contain no `:name` bind-parameter tokens (`test_boot_migration_statements_have_no_bindparams` guards this).
- Test gate = failure-set diff vs `master`, never "zero failures" (`architecture_mk1_test_baseline_failures`). Run the touched suites green, then the full suite once and diff against a master run.
- Work in a fresh worktree off `origin/master` (1f5c86af or later), e.g. `C:\tmp\Accu-Mk1-hplc-slice1`, branch `feat/hplc-native-slice1`. Commit by pathspec only (`git commit -- <paths>`); never a bare `git commit`.
- Bare `python` may hang in this environment: run pytest through the backend venv (`backend/.venv/Scripts/python -m pytest` or the worktree's venv).

---

### Task 1: `peptide_id` + `slot` columns on `lims_analyses` (model + boot migration)

**Files:**
- Modify: `backend/models.py` (class `LimsAnalysis`, after `reportable_reason` at ~line 1952)
- Modify: `backend/database.py` (`_run_migrations()` list, append before the closing `]` at ~line 2005)
- Test: `backend/tests/test_hplc_native_schema.py` (create)

**Interfaces:**
- Produces: `LimsAnalysis.peptide_id: Optional[int]` (FK `peptides.id`, ON DELETE SET NULL), `LimsAnalysis.slot: Optional[int]` (1..8 or NULL). Boot statements identifiable by the markers `"lims_analyses ADD COLUMN IF NOT EXISTS peptide_id"`, `"lims_analyses ADD COLUMN IF NOT EXISTS slot"`, `"ck_lims_analyses_slot_range"`, `"ix_lims_analyses_peptide_id"`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_hplc_native_schema.py
"""HPLC-native slice 1: peptide_id/slot on lims_analyses, slot-aware root
indexes, and the boot statements that carry them to existing DBs.

Spec: docs/superpowers/specs/2026-09-10-hplc-native-born-design.md (M1)."""
import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401  (register tables on Base before create_all)
from models import Base, LimsAnalysis


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_lims_analysis_has_peptide_id_and_slot_columns(db_session):
    cols = {c["name"] for c in inspect(db_session.get_bind()).get_columns("lims_analyses")}
    assert {"peptide_id", "slot"} <= cols


def test_peptide_id_and_slot_default_null(db_session):
    from models import AnalysisService
    svc = AnalysisService(title="x", keyword="HPLC-PURITY", origin="mk1")
    db_session.add(svc)
    db_session.flush()
    row = LimsAnalysis(lims_sample_pk=None, lims_sub_sample_pk=None,
                       analysis_service_id=svc.id, keyword="HPLC-PURITY",
                       title="x")
    assert row.peptide_id is None and row.slot is None


def _captured():
    """Same idiom as test_workflow_engine.captured_migration_statements:
    run the REAL _run_migrations() against a fake connection."""
    from unittest.mock import patch
    import database

    captured = []

    class _FakeConn:
        def execute(self, clause):
            captured.append(clause)

        def commit(self):
            pass

        def rollback(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    with patch.object(database.engine, "connect", return_value=_FakeConn()):
        database._run_migrations()
    return [str(c) for c in captured]


def test_boot_migrations_add_peptide_id_and_slot():
    stmts = _captured()
    assert any("lims_analyses ADD COLUMN IF NOT EXISTS peptide_id" in s for s in stmts)
    assert any("lims_analyses ADD COLUMN IF NOT EXISTS slot" in s for s in stmts)
    assert any("ck_lims_analyses_slot_range" in s for s in stmts)
    assert any("ix_lims_analyses_peptide_id" in s for s in stmts)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_hplc_native_schema.py -v`
Expected: the two column tests FAIL (`peptide_id` not in columns / `AttributeError`), the migration test FAILS (no matching statement).

- [ ] **Step 3: Add the model columns**

In `backend/models.py`, inside `class LimsAnalysis`, directly after the `reportable_reason` line:

```python
    # HPLC-native (spec 2026-09-10, shape B): the analyte this row measures
    # and its 1-based position in lims_samples.analytes. NULL on every
    # non-HPLC row and on every legacy (SENAITE-mirror) row. The row's
    # `title` is STAMPED per row ("BPC-157 - Purity (HPLC)") by the native
    # seeder — never derived from the generic service title.
    peptide_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("peptides.id", ondelete="SET NULL"), nullable=True
    )
    slot: Mapped[Optional[int]] = mapped_column(SmallInteger, nullable=True)
```

Make sure `SmallInteger` is imported at the top of `models.py` (add it to the existing `from sqlalchemy import (...)` list if absent).

- [ ] **Step 4: Add the boot migration statements**

In `backend/database.py`, inside `_run_migrations()`, append to the `migrations` list immediately before its closing `]` (after the `ix_lims_analyses_senaite_analysis_uid` entry):

```python
        # --- HPLC-native slice 1 (spec 2026-09-10, M1) ---
        # peptide_id + slot on analysis rows. Additive, nullable, no backfill:
        # NULL on every legacy row by contract. CHECK uses the union-preserve
        # idiom (guarded DO block) so re-boots are no-ops.
        "ALTER TABLE lims_analyses ADD COLUMN IF NOT EXISTS peptide_id INTEGER "
        "REFERENCES peptides(id) ON DELETE SET NULL",
        "ALTER TABLE lims_analyses ADD COLUMN IF NOT EXISTS slot SMALLINT",
        """
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'ck_lims_analyses_slot_range'
              AND conrelid = 'lims_analyses'::regclass
          ) THEN
            ALTER TABLE lims_analyses ADD CONSTRAINT ck_lims_analyses_slot_range
              CHECK (slot IS NULL OR (slot BETWEEN 1 AND 8));
          END IF;
        END $$
        """,
        "CREATE INDEX IF NOT EXISTS ix_lims_analyses_peptide_id "
        "ON lims_analyses (peptide_id)",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_hplc_native_schema.py tests/test_workflow_engine.py::test_boot_migration_statements_have_no_bindparams -v`
Expected: all PASS (the `DO $$` block contains no `:token`, so the bindparam guard stays green).

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/database.py backend/tests/test_hplc_native_schema.py
git commit -m "feat(lims): peptide_id + slot on lims_analyses (HPLC-native M1)" -- backend/models.py backend/database.py backend/tests/test_hplc_native_schema.py
```

---

### Task 2: Slot-aware root unique indexes (five atomic guarded `DO $$` widen blocks)

**Files:**
- Modify: `backend/database.py` (`_run_migrations()` list, append after Task 1's statements)
- Test: `backend/tests/test_hplc_native_schema.py` (extend)

**Interfaces:**
- Produces: the five indexes `uq_lims_analyses_sub_service_root`, `uq_lims_analyses_sub_service_id_root`, `uq_lims_analyses_parent_service_root`, `uq_lims_analyses_parent_service_id_root`, `uq_lims_analyses_parent_service_ordered` now keyed with a trailing `COALESCE(slot, 0)` column. Names unchanged, so `IDENTITY_INDEXES` / `verify_identity_indexes()` in `database.py` need no edit.

Why one atomic `DO $$` block per index, not a standalone DROP+CREATE pair (final-review Finding 1, shipped this way): `CREATE UNIQUE INDEX IF NOT EXISTS` is a no-op when the old-shaped index exists, so widening still needs a drop first — but `_run_migrations` swallows a failing CREATE as `migration_skipped`, and a standalone DROP that already committed would then leave the index (and its uniqueness guarantee) briefly or permanently missing. Each of the five sits in ONE `DO $$ ... END $$` block instead: a Postgres DO block runs in a single transaction, so a failing CREATE rolls the DROP back with it. Each block is also guarded (`IF EXISTS ... AND indexdef NOT LIKE '%COALESCE%'`) so it becomes a no-op once the index is already widened — the guard compares on Postgres's normalized `indexdef` text, not the literal `COALESCE(slot, ...)` source, since Postgres renders it as `COALESCE((slot)::integer, 0)`. Three pre-slice standalone DROP+CREATE pairs for these same two index names (added by earlier, unrelated tasks) were converted to the same guarded idiom for the same reason: once slot data exists, their old unwidened CREATE fails on real duplicate rows.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_hplc_native_schema.py`:

```python
_ROOT_INDEXES = (
    "uq_lims_analyses_sub_service_root",
    "uq_lims_analyses_sub_service_id_root",
    "uq_lims_analyses_parent_service_root",
    "uq_lims_analyses_parent_service_id_root",
    "uq_lims_analyses_parent_service_ordered",
)


def _last_create_for(stmts, name):
    """The LAST CREATE for an index name is what a boot leaves in place."""
    hits = [s for s in stmts if f"CREATE UNIQUE INDEX IF NOT EXISTS {name}" in s]
    assert hits, f"no CREATE for {name}"
    return hits[-1]


def test_root_indexes_become_slot_aware_last_boot_wins():
    stmts = _captured()
    for name in _ROOT_INDEXES:
        last = _last_create_for(stmts, name)
        assert "COALESCE(slot, 0)" in last, name
        # a DROP must precede the final CREATE (IF NOT EXISTS is a no-op on
        # the old-shaped index otherwise)
        drop_positions = [i for i, s in enumerate(stmts) if s.strip() == f"DROP INDEX IF EXISTS {name}"]
        create_position = max(i for i, s in enumerate(stmts)
                              if f"CREATE UNIQUE INDEX IF NOT EXISTS {name}" in s)
        assert drop_positions and max(drop_positions) < create_position, name


def test_slot_aware_indexes_keep_their_predicates():
    """Widening must not loosen the WHERE clauses — copy them verbatim."""
    stmts = _captured()
    sub_root = _last_create_for(stmts, "uq_lims_analyses_sub_service_root")
    assert "retest_of_id IS NULL AND lims_sub_sample_pk IS NOT NULL" in sub_root
    assert "review_state NOT IN ('retracted', 'rejected')" in sub_root
    parent_root = _last_create_for(stmts, "uq_lims_analyses_parent_service_root")
    assert "provenance = 'canonical'" in parent_root
    parent_id_root = _last_create_for(stmts, "uq_lims_analyses_parent_service_id_root")
    assert "provenance = 'canonical'" in parent_id_root
    ordered = _last_create_for(stmts, "uq_lims_analyses_parent_service_ordered")
    assert "provenance = 'ordered'" in ordered
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_hplc_native_schema.py -v -k "slot_aware"`
Expected: FAIL — `COALESCE(slot, 0)` absent from the last CREATE of each name.

- [ ] **Step 3: Add the DROP+CREATE pairs**

Append to the `migrations` list in `_run_migrations()`, after Task 1's statements:

```python
        # Slot-aware root uniqueness (spec 2026-09-10, M1). A blend holds N
        # rows of the SAME generic service (HPLC-PURITY x slots 1..N) on one
        # vial and on one parent, so every "one live root row per (host,
        # service)" index gains COALESCE(slot, 0). Legacy rows (slot NULL)
        # compare as 0 — exactly as unique as before; a widened index is
        # strictly looser so the CREATE cannot fail on existing data.
        # DROP+CREATE because IF NOT EXISTS is a no-op on the old shape
        # (last-boot-wins, precedent: provenance-aware widen above).
        "DROP INDEX IF EXISTS uq_lims_analyses_sub_service_root",
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_sub_service_root
            ON lims_analyses (lims_sub_sample_pk, keyword, COALESCE(slot, 0))
            WHERE retest_of_id IS NULL AND lims_sub_sample_pk IS NOT NULL
              AND review_state NOT IN ('retracted', 'rejected')
        """,
        "DROP INDEX IF EXISTS uq_lims_analyses_sub_service_id_root",
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_sub_service_id_root
            ON lims_analyses (lims_sub_sample_pk, analysis_service_id, COALESCE(slot, 0))
            WHERE retest_of_id IS NULL AND lims_sub_sample_pk IS NOT NULL
              AND review_state NOT IN ('retracted', 'rejected')
        """,
        "DROP INDEX IF EXISTS uq_lims_analyses_parent_service_root",
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_parent_service_root
            ON lims_analyses (lims_sample_pk, keyword, COALESCE(slot, 0))
            WHERE retest_of_id IS NULL AND lims_sample_pk IS NOT NULL
              AND review_state NOT IN ('retracted', 'rejected')
              AND provenance = 'canonical'
        """,
        "DROP INDEX IF EXISTS uq_lims_analyses_parent_service_id_root",
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_parent_service_id_root
            ON lims_analyses (lims_sample_pk, analysis_service_id, COALESCE(slot, 0))
            WHERE retest_of_id IS NULL AND lims_sample_pk IS NOT NULL
              AND review_state NOT IN ('retracted', 'rejected')
              AND provenance = 'canonical'
        """,
        "DROP INDEX IF EXISTS uq_lims_analyses_parent_service_ordered",
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_lims_analyses_parent_service_ordered
            ON lims_analyses (lims_sample_pk, analysis_service_id, COALESCE(slot, 0))
            WHERE provenance = 'ordered' AND lims_sample_pk IS NOT NULL
              AND review_state NOT IN ('retracted', 'rejected')
        """,
```

Before adding them, read the three existing CREATE bodies at `database.py` ~1137, ~1726, ~1799-1809 and copy each WHERE clause verbatim (the test pins the predicates). If the existing `uq_lims_analyses_sub_service_root` at ~724 has a predicate differing from the one above, use the existing one.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_hplc_native_schema.py tests/test_workflow_engine.py::test_boot_migration_statements_have_no_bindparams -v`
Expected: PASS.

- [ ] **Step 5: Live-DB effect test (Postgres, rolled back)**

Append to `backend/tests/test_hplc_native_schema.py`:

```python
def test_slice1_boot_statements_execute_against_live_db():
    """Executes the M1 statements against the live dev Postgres inside a
    savepoint that is rolled back, then proves the EFFECT: two rows of the
    same service on one vial with slots 1 and 2 insert, while two slot-NULL
    rows collide. Same recipe as
    test_workflow_engine.test_sbs_boot_statements_execute_against_live_db."""
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError
    from database import SessionLocal

    markers = ("ADD COLUMN IF NOT EXISTS peptide_id",
               "ADD COLUMN IF NOT EXISTS slot",
               "ck_lims_analyses_slot_range",
               "ix_lims_analyses_peptide_id",
               "COALESCE(slot, 0)",
               "DROP INDEX IF EXISTS uq_lims_analyses_")
    stmts = [s for s in _captured() if any(m in s for m in markers)]
    assert len(stmts) == 4 + 10, [s[:60] for s in stmts]

    s = SessionLocal()
    conn = s.connection()
    outer = conn.begin_nested()
    try:
        for stmt in stmts:
            conn.execute(text(stmt))
        defs = dict(conn.execute(text(
            "SELECT indexname, indexdef FROM pg_indexes "
            "WHERE tablename='lims_analyses' AND indexname LIKE 'uq_lims_analyses_%'"
        )).all())
        for name in _ROOT_INDEXES:
            assert "COALESCE(slot, 0)" in defs[name], name

        svc_id = conn.execute(text(
            "INSERT INTO analysis_services (title, keyword, origin, active) "
            "VALUES ('t', 'ZZ-SLOT-TEST', 'mk1', TRUE) RETURNING id")).scalar()
        parent_pk = conn.execute(text(
            "INSERT INTO lims_samples (sample_id) VALUES ('ZZ-SLOT-1') RETURNING id")).scalar()
        vial_pk = conn.execute(text(
            "INSERT INTO lims_sub_samples (parent_sample_pk, sample_id, vial_sequence) "
            "VALUES (:p, 'ZZ-SLOT-1-S01', 1) RETURNING id"), {"p": parent_pk}).scalar()
        ins = text(
            "INSERT INTO lims_analyses (lims_sub_sample_pk, analysis_service_id, keyword, "
            "title, review_state, provenance, slot) "
            "VALUES (:v, :s, 'ZZ-SLOT-TEST', 't', 'unassigned', 'canonical', :slot)")
        conn.execute(ins, {"v": vial_pk, "s": svc_id, "slot": 1})
        conn.execute(ins, {"v": vial_pk, "s": svc_id, "slot": 2})   # must NOT raise
        sp = conn.begin_nested()
        conn.execute(ins, {"v": vial_pk, "s": svc_id, "slot": None})
        with pytest.raises(IntegrityError):
            conn.execute(ins, {"v": vial_pk, "s": svc_id, "slot": None})
        sp.rollback()
    finally:
        outer.rollback()
        s.close()
```

Read the `lims_sub_samples` NOT NULL columns in `models.py` (`class LimsSubSample`) and add any further required columns to the INSERT if the live DB rejects it.

Run: `cd backend && python -m pytest tests/test_hplc_native_schema.py -v -k live_db`
Expected: PASS against the local dev Postgres (the test skips nothing; if `SessionLocal` cannot connect, fix the env rather than skipping).

- [ ] **Step 6: Commit**

```bash
git add backend/database.py backend/tests/test_hplc_native_schema.py
git commit -m "feat(lims): slot-aware root unique indexes on lims_analyses (HPLC-native M1)" -- backend/database.py backend/tests/test_hplc_native_schema.py
```

---

### Task 3: `create_analysis` accepts `peptide_id` / `slot` / `reportable_reason`; retest copies them; wire shape exposes them

**Files:**
- Modify: `backend/lims_analyses/service.py` (`create_analysis` ~183-245; retest branch ~479-490; `_serialize_senaite_shape_rows` ~3556-3588)
- Modify: `backend/lims_analyses/schemas.py` (`SenaiteShapeAnalysisResponse`)
- Test: `backend/tests/test_hplc_native_schema.py` (extend)

**Interfaces:**
- Produces: `create_analysis(db, *, host_kind, host_pk, analysis_service_id, keyword, title, result_value=None, result_unit=None, method_id=None, instrument_id=None, created_by_user_id=None, commit=True, peptide_id=None, slot=None, reportable_reason=None) -> LimsAnalysis`. `SenaiteShapeAnalysisResponse.peptide_id: Optional[int] = None`, `.slot: Optional[int] = None`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_hplc_native_schema.py`:

```python
def _svc(db, keyword="HPLC-PURITY"):
    from models import AnalysisService
    svc = AnalysisService(title=keyword, keyword=keyword, origin="mk1")
    db.add(svc)
    db.flush()
    return svc


def _vial(db):
    from models import LimsSample, LimsSubSample
    parent = LimsSample(sample_id="P-9001")
    db.add(parent)
    db.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-9001-S01", vial_sequence=1)
    db.add(vial)
    db.flush()
    return vial


def test_create_analysis_stamps_peptide_id_slot_and_reason(db_session):
    from lims_analyses.service import create_analysis
    svc = _svc(db_session)
    vial = _vial(db_session)
    row = create_analysis(
        db_session, host_kind="sub_sample", host_pk=vial.id,
        analysis_service_id=svc.id, keyword=svc.keyword,
        title="BPC-157 - Purity (HPLC)", peptide_id=None, slot=2,
        reportable_reason="analyte_unresolved: Bpc 157", commit=False,
    )
    assert (row.slot, row.peptide_id, row.reportable_reason) == (
        2, None, "analyte_unresolved: Bpc 157")


def test_create_analysis_defaults_unchanged(db_session):
    from lims_analyses.service import create_analysis
    svc = _svc(db_session)
    vial = _vial(db_session)
    row = create_analysis(
        db_session, host_kind="sub_sample", host_pk=vial.id,
        analysis_service_id=svc.id, keyword=svc.keyword, title="t", commit=False,
    )
    assert row.slot is None and row.peptide_id is None and row.reportable_reason is None


def test_senaite_shape_carries_peptide_id_and_slot():
    from lims_analyses.schemas import SenaiteShapeAnalysisResponse
    fields = SenaiteShapeAnalysisResponse.model_fields
    assert "peptide_id" in fields and "slot" in fields
    assert fields["peptide_id"].default is None and fields["slot"].default is None
```

Check `LimsSubSample`'s required columns in `models.py` and extend `_vial()` if the model needs more (e.g. `role`); keep the helper minimal.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_hplc_native_schema.py -v -k "create_analysis or senaite_shape"`
Expected: FAIL — `TypeError: unexpected keyword argument 'peptide_id'`; missing fields.

- [ ] **Step 3: Extend `create_analysis`**

In `backend/lims_analyses/service.py`, change the signature and constructor:

```python
def create_analysis(
    db: Session,
    *,
    host_kind: str,
    host_pk: int,
    analysis_service_id: int,
    keyword: str,
    title: str,
    result_value: Optional[str] = None,
    result_unit: Optional[str] = None,
    method_id: Optional[int] = None,
    instrument_id: Optional[int] = None,
    created_by_user_id: Optional[int] = None,
    commit: bool = True,
    peptide_id: Optional[int] = None,
    slot: Optional[int] = None,
    reportable_reason: Optional[str] = None,
) -> LimsAnalysis:
```

and in the `LimsAnalysis(...)` construction add:

```python
        peptide_id=peptide_id,
        slot=slot,
        reportable_reason=reportable_reason,
```

- [ ] **Step 4: Retest branch copies `peptide_id`/`slot`**

Open the retest branch of `apply_transition` (search for `new_row = LimsAnalysis(` near `service.py:479-490`, where the retest child is constructed from the source row). Add to that constructor:

```python
            peptide_id=row.peptide_id,
            slot=row.slot,
```

so a retest child of a blend slot keeps its identity (otherwise it lands under `COALESCE(slot,0)=0` and could collide with another slot's retest).

Add a test:

```python
def test_retest_child_inherits_peptide_id_and_slot(db_session):
    """Find the retest constructor by behaviour: whatever path mints the
    retest child must carry slot/peptide_id. Uses the existing retest
    helper the repo tests use (see tests/test_retest_current_row.py)."""
    from lims_analyses.service import create_analysis
    import lims_analyses.service as svc_mod
    svc = _svc(db_session)
    vial = _vial(db_session)
    row = create_analysis(db_session, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=svc.id, keyword=svc.keyword,
                          title="t", slot=3, commit=False)
    db_session.commit()
    # mirror the call shape used in tests/test_retest_current_row.py
    child = svc_mod.retest_analysis(db_session, row.id, user_id=None, reason="t")
    assert (child.slot, child.peptide_id) == (3, None)
```

Read `backend/tests/test_retest_current_row.py` to get the exact retest entry point and its required transition preconditions (the source row usually needs to be `submitted`/`verified` first); adapt the setup lines, not the assertion.

- [ ] **Step 5: Expose on the wire**

In `backend/lims_analyses/schemas.py`, add to `SenaiteShapeAnalysisResponse`:

```python
    peptide_id: Optional[int] = None
    slot: Optional[int] = None
```

In `backend/lims_analyses/service.py` `_serialize_senaite_shape_rows` (~3556-3588), where each row dict/response is built, add `peptide_id=r.peptide_id, slot=r.slot`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_hplc_native_schema.py tests/test_retest_current_row.py tests/test_lims_analyses_service.py -v`
Expected: PASS (existing suites unchanged).

- [ ] **Step 7: Commit**

```bash
git add backend/lims_analyses/service.py backend/lims_analyses/schemas.py backend/tests/test_hplc_native_schema.py
git commit -m "feat(lims): create_analysis + wire shape carry peptide_id/slot (HPLC-native M1)" -- backend/lims_analyses/service.py backend/lims_analyses/schemas.py backend/tests/test_hplc_native_schema.py
```

---

### Task 4: Native HPLC catalog seed — services + profile + members

**Files:**
- Create: `backend/catalog/hplc_native_seed.py`
- Modify: `backend/database.py` (`init_db()`, insert a call after `seed_vial_roles`, before `seed_service_specs`)
- Test: `backend/tests/test_hplc_native_catalog_seed.py` (create)

**Interfaces:**
- Produces: `HPLC_NATIVE_PROFILE_KEY = "hplc-purity-identity"`, `HPLC_NATIVE_SERVICES: tuple[tuple[str, str, str | None, str, bool], ...]` = (keyword, title, unit, result_type, variance_capable), `seed_hplc_native_catalog(db) -> dict[str, int]` returning `{"services": n, "profile": 0|1, "members": n, "specs": n}`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_hplc_native_catalog_seed.py
"""Boot seed for the native HPLC family (spec 2026-09-10, M2): five
origin=mk1 services, ONE profile `hplc-purity-identity` with the five as
ordered members, and the parity spec rows. Idempotent; admin edits survive."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import Base


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


KEYWORDS = ("HPLC-IDENTITY", "HPLC-PURITY", "HPLC-QUANTITY",
            "HPLC-BLEND-PURITY", "HPLC-BLEND-TOTAL")


def test_seed_creates_five_mk1_services_in_analytical(db_session):
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from models import AnalysisService, Department
    db_session.add(Department(name="Analytical"))
    db_session.commit()
    report = seed_hplc_native_catalog(db_session)
    assert report["services"] == 5
    rows = {s.keyword: s for s in db_session.query(AnalysisService).all()}
    assert set(rows) == set(KEYWORDS)
    dept = db_session.query(Department).filter_by(name="Analytical").one()
    for kw in KEYWORDS:
        assert rows[kw].origin == "mk1"
        assert rows[kw].department_id == dept.id
    assert (rows["HPLC-PURITY"].unit, rows["HPLC-PURITY"].result_type,
            rows["HPLC-PURITY"].variance_capable) == ("%", "numeric", True)
    assert (rows["HPLC-QUANTITY"].unit, rows["HPLC-QUANTITY"].variance_capable) == ("mg", True)
    assert (rows["HPLC-IDENTITY"].unit, rows["HPLC-IDENTITY"].result_type,
            rows["HPLC-IDENTITY"].variance_capable) == (None, "string", False)


def test_seed_creates_profile_with_ordered_members(db_session):
    from catalog.hplc_native_seed import seed_hplc_native_catalog, HPLC_NATIVE_PROFILE_KEY
    from models import AnalysisProfile
    seed_hplc_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one()
    assert (prof.is_addon, prof.vials_required, prof.fulfillment_role,
            prof.fulfillment_dim, prof.coa_archetype, prof.active) == (
        False, 1, "hplc", "role", None, True)
    assert [s.keyword for s in prof.analysis_services] == list(KEYWORDS)


def test_seed_is_idempotent_and_keeps_admin_edits(db_session):
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from models import AnalysisProfile, AnalysisService
    seed_hplc_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key="hplc-purity-identity").one()
    prof.vials_required = 2          # admin edit
    svc = db_session.query(AnalysisService).filter_by(keyword="HPLC-PURITY").one()
    svc.title = "Purity (edited)"    # admin edit
    db_session.commit()
    report = seed_hplc_native_catalog(db_session)
    assert report == {"services": 0, "profile": 0, "members": 0, "specs": 0}
    assert db_session.query(AnalysisService).count() == 5
    assert prof.vials_required == 2 and svc.title == "Purity (edited)"


def test_seed_skips_when_department_missing(db_session, caplog):
    """No Analytical department (fresh dev DB before backfill): services still
    seed with department_id NULL and a WARNING — backfill_departments'
    HPLC-% LIKE rescue tags them on the same boot."""
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from models import AnalysisService
    with caplog.at_level("WARNING"):
        seed_hplc_native_catalog(db_session)
    assert db_session.query(AnalysisService).count() == 5
    assert any("hplc_native_seed.no_analytical_department" in r.message for r in caplog.records)


def test_keywords_pass_native_keyword_rules(db_session):
    from main import validate_new_keyword
    for kw in KEYWORDS:
        validate_new_keyword(db_session, kw)   # must not raise on an empty catalog


def test_profile_key_not_in_product_registry():
    """Never add hplc-purity-identity to PRODUCT_REGISTRY — the legacy
    profile seed and test_profile_parity pin that set."""
    from sub_samples.product_registry import PRODUCT_REGISTRY
    assert "hplc-purity-identity" not in PRODUCT_REGISTRY


def test_change_log_rows_written(db_session):
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from models import CatalogChangeLog
    seed_hplc_native_catalog(db_session)
    actions = [(r.entity_type, r.action) for r in db_session.query(CatalogChangeLog).all()]
    assert actions.count(("analysis_service", "create")) == 5
    assert actions.count(("analysis_profile", "create")) == 1
```

Check the `entity_type` strings used by `log_create` callers in `main.py` (`POST /analysis-services` ~3657 and `POST /analysis-profiles` ~18841) and use the same literals.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_hplc_native_catalog_seed.py -v`
Expected: FAIL with `ModuleNotFoundError: catalog.hplc_native_seed` (the two registry/keyword tests may already pass).

- [ ] **Step 3: Write the seeder**

```python
# backend/catalog/hplc_native_seed.py
"""Boot seed for the native HPLC family (spec 2026-09-10-hplc-native-born-design, M2).

Shape B: a GENERIC trio (identity / purity / quantity) plus two blend
aggregates. The peptide is NOT in the catalog — it lives on the analysis row
(lims_analyses.peptide_id / slot), so a blend is N rows of the same service.

Idempotent and admin-safe, mirroring service_spec_seed.py:
  * a service is keyed on (keyword, origin='mk1') — present ⇒ untouched;
  * the profile is keyed on key — present ⇒ untouched (vials_required,
    archetype, members are the admin's after first boot);
  * members are only written when the profile is created by THIS run;
  * spec rows use the wildcard slot (matrix IS NULL AND peptide_id IS NULL)
    and skip when any row — active or not — already occupies it.
Never resurrects a deactivated row. Every insert is audited via
catalog/change_log so the Catalog Change Log shows the boot as the actor.

NOT added to sub_samples.product_registry.PRODUCT_REGISTRY: that map is the
legacy profile set pinned by test_profile_parity.py.
"""
import logging
from decimal import Decimal

from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

HPLC_NATIVE_PROFILE_KEY = "hplc-purity-identity"
HPLC_NATIVE_PROFILE_NAME = "HPLC Purity + Identity"

# keyword, title, unit, result_type, variance_capable — ORDER = member sort_order
HPLC_NATIVE_SERVICES: tuple[tuple[str, str, str | None, str, bool], ...] = (
    ("HPLC-IDENTITY", "HPLC Identity", None, "string", False),
    ("HPLC-PURITY", "HPLC Purity", "%", "numeric", True),
    ("HPLC-QUANTITY", "HPLC Quantity", "mg", "numeric", True),
    ("HPLC-BLEND-PURITY", "HPLC Blend Purity (mass-weighted)", "%", "numeric", False),
    ("HPLC-BLEND-TOTAL", "HPLC Blend Total Quantity", "mg", "numeric", False),
)

# keyword -> (rule_kind, min, max, equals, unit, display_override)
# Handler rulings 2026-09-10: purity ≥ 98 % wildcard; quantity report-only
# ("As measured"); identity = literal Conforms.
HPLC_NATIVE_SPECS = {
    "HPLC-PURITY": ("range", Decimal("98"), None, None, "%", None),
    "HPLC-BLEND-PURITY": ("range", Decimal("98"), None, None, "%", None),
    "HPLC-QUANTITY": ("informational", None, None, None, "mg", "As measured"),
    "HPLC-BLEND-TOTAL": ("informational", None, None, None, "mg", "As measured"),
    "HPLC-IDENTITY": ("equals", None, None, "Conforms", None, None),
}

_SERVICE_LOG_FIELDS = ("title", "keyword", "unit", "result_type", "origin",
                       "department_id", "variance_capable", "category")
_PROFILE_LOG_FIELDS = ("key", "name", "is_addon", "vials_required",
                       "fulfillment_role", "fulfillment_dim", "active")


def seed_hplc_native_catalog(db: Session) -> dict[str, int]:
    from catalog.change_log import log_create, log_members
    from catalog.departments import department_id_by_name
    from catalog.service_spec_audit import record_spec_change
    from models import (AnalysisProfile, AnalysisService, AnalysisServiceSpec,
                        analysis_profile_members)

    report = {"services": 0, "profile": 0, "members": 0, "specs": 0}

    dept_id = department_id_by_name(db, "Analytical")
    if dept_id is None:
        log.warning("hplc_native_seed.no_analytical_department — services seed "
                    "with department_id NULL; backfill_departments tags HPLC-%% on this boot")

    # --- services ---
    services: dict[str, AnalysisService] = {}
    for keyword, title, unit, result_type, variance_capable in HPLC_NATIVE_SERVICES:
        svc = (db.query(AnalysisService)
               .filter(AnalysisService.keyword == keyword,
                       AnalysisService.origin == "mk1")
               .one_or_none())
        if svc is None:
            svc = AnalysisService(
                title=title, keyword=keyword, unit=unit, result_type=result_type,
                category="HPLC", origin="mk1", department_id=dept_id,
                variance_capable=variance_capable, active=True,
            )
            db.add(svc)
            db.flush()
            log_create(db, svc, _SERVICE_LOG_FIELDS, entity_type="analysis_service",
                       entity_pk=svc.id, user_id=None)
            report["services"] += 1
        services[keyword] = svc

    # --- profile (+ members only on first creation) ---
    prof = db.query(AnalysisProfile).filter_by(key=HPLC_NATIVE_PROFILE_KEY).one_or_none()
    if prof is None:
        prof = AnalysisProfile(
            key=HPLC_NATIVE_PROFILE_KEY, name=HPLC_NATIVE_PROFILE_NAME,
            is_addon=False, vials_required=1, fulfillment_role="hplc",
            fulfillment_dim="role", sort_order=0, active=True,
            coa_archetype=None,
        )
        db.add(prof)
        db.flush()
        log_create(db, prof, _PROFILE_LOG_FIELDS, entity_type="analysis_profile",
                   entity_pk=prof.id, user_id=None)
        report["profile"] = 1
        member_ids = [services[kw].id for kw, *_ in HPLC_NATIVE_SERVICES]
        for i, sid in enumerate(member_ids):
            db.execute(analysis_profile_members.insert().values(
                analysis_profile_id=prof.id, analysis_service_id=sid, sort_order=i))
        log_members(db, entity_type="analysis_profile", entity_pk=prof.id, user_id=None,
                    field="analysis_services", before_ids=[], after_ids=member_ids)
        report["members"] = len(member_ids)

    # --- wildcard spec rows ---
    for keyword, (kind, lo, hi, eq, unit, display) in HPLC_NATIVE_SPECS.items():
        svc = services[keyword]
        existing = (db.query(AnalysisServiceSpec)
                    .filter(AnalysisServiceSpec.analysis_service_id == svc.id,
                            AnalysisServiceSpec.matrix.is_(None),
                            AnalysisServiceSpec.peptide_id.is_(None))
                    .first())
        if existing is not None:
            continue
        spec = AnalysisServiceSpec(
            analysis_service_id=svc.id, matrix=None, rule_kind=kind,
            min_value=lo, max_value=hi, equals_value=eq, unit=unit,
            display_override=display,
        )
        db.add(spec)
        db.flush()
        record_spec_change(db, spec, before=None, actor_user_id=None)
        report["specs"] += 1

    db.commit()
    if any(report.values()):
        log.info("catalog.hplc_native_seed %s", report)
    return report
```

Verify against the code before running: the `analysis_profile_members` junction column names (`models.py:390-400`), `AnalysisService.category` column exists (yes, `category(200)`), `log_members` signature (`change_log.py:105`), and that `AnalysisServiceSpec` accepts `display_override` on construction. If the CHECK on `analysis_service_specs` (`ck_analysis_service_specs_rule_shape`) requires `informational` rows to carry no unit, drop `"mg"` from the two informational rows and note it in the module docstring.

- [ ] **Step 4: Wire into `init_db()`**

In `backend/database.py` `init_db()`, after the `seed_vial_roles` try-block and before the `seed_service_specs` try-block:

```python
    # HPLC-native family (spec 2026-09-10, M2): five generic services + the
    # hplc-purity-identity profile + wildcard specs. Before service_spec_seed
    # for symmetry; after vial roles (role 'hplc' is a system role and already
    # exists, but keep the order explicit).
    try:
        from catalog.hplc_native_seed import seed_hplc_native_catalog
        with SessionLocal() as _db:
            seed_hplc_native_catalog(_db)
    except Exception as e:  # never block startup
        log.warning("catalog_hplc_native_seed_skipped err=%s", e)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_hplc_native_catalog_seed.py tests/test_service_spec_seed.py tests/test_profile_parity.py tests/test_catalog_seeding.py -v`
Expected: PASS. If `test_profile_parity` fails because it counts `AnalysisProfile` rows after `seed_profiles_from_registry` only, it is unaffected (this seeder is not called there); if a parity test boots `init_db`, extend its expected key set — that is a stale-test case, record it in the commit message.

- [ ] **Step 6: Commit**

```bash
git add backend/catalog/hplc_native_seed.py backend/database.py backend/tests/test_hplc_native_catalog_seed.py
git commit -m "feat(catalog): seed native HPLC services, hplc-purity-identity profile, specs (M2)" -- backend/catalog/hplc_native_seed.py backend/database.py backend/tests/test_hplc_native_catalog_seed.py
```

---

### Task 5: Boot-order proof + admin-UI creatability guard

**Files:**
- Test: `backend/tests/test_hplc_native_catalog_seed.py` (extend)

**Interfaces:** none new. Pins that `init_db` calls the seeder between vial roles and spec seed, and that the admin route would accept the same rows (so the lab can recreate them by hand on a stack where the seed was skipped).

- [ ] **Step 1: Write the tests**

```python
def test_init_db_calls_hplc_native_seed_between_vial_roles_and_specs(monkeypatch):
    """Order pin: vial_roles → hplc_native → service_specs. Uses the same
    trick as test_workflow_engine: run the REAL init_db with every seeder
    stubbed to record its name."""
    import database
    calls = []

    def _rec(name):
        def _f(*a, **k):
            calls.append(name)
        return _f

    monkeypatch.setattr(database, "_run_migrations", _rec("migrations"))
    monkeypatch.setattr(database.Base.metadata, "create_all", _rec("create_all"))
    monkeypatch.setattr(database, "_seed_federal_holidays_window", _rec("holidays"))
    import catalog.vial_roles_seed as vr, catalog.hplc_native_seed as hn, catalog.service_spec_seed as ss
    monkeypatch.setattr(vr, "seed_vial_roles", _rec("vial_roles"))
    monkeypatch.setattr(hn, "seed_hplc_native_catalog", _rec("hplc_native"))
    monkeypatch.setattr(ss, "seed_service_specs", _rec("service_specs"))
    database.init_db()
    assert calls.index("vial_roles") < calls.index("hplc_native") < calls.index("service_specs")


def test_seeded_services_match_admin_create_contract(db_session):
    """The admin POST /analysis-services validator must accept every seeded
    keyword AFTER the seed too (exclude_id) — proves an operator can edit
    them without tripping the collision rule."""
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from main import validate_new_keyword
    from models import AnalysisService
    seed_hplc_native_catalog(db_session)
    for svc in db_session.query(AnalysisService).all():
        validate_new_keyword(db_session, svc.keyword, exclude_id=svc.id)
```

If `init_db` has other side-effecting calls the monkeypatch does not cover (e.g. `backfill_departments`, `seed_workflow_catalog`, `reconcile_per_substance_services`, `seed_profiles_from_registry`, `verify_demand_catalog`), stub each one the same way; the assertion only cares about relative order of three names.

- [ ] **Step 2: Run the tests**

Run: `cd backend && python -m pytest tests/test_hplc_native_catalog_seed.py -v`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_hplc_native_catalog_seed.py
git commit -m "test(catalog): pin hplc-native seed boot order + admin keyword contract" -- backend/tests/test_hplc_native_catalog_seed.py
```

---

### Task 6: Alias set — backend (`HPLC_PRIMARY_KEYS`)

**Files:**
- Create: `backend/catalog/hplc_keys.py`
- Modify: `backend/sub_samples/service.py` (`derive_variance_demand` ~1444; `derive_base_demand` ~1485)
- Modify: `backend/lims_analyses/seeder.py` (`ROLE_TO_WP_KEYS` ~80)
- Modify: `backend/catalog/demand_verify.py` (`LEGACY_DEMAND_KEYS` ~37)
- Test: `backend/tests/test_hplc_native_alias.py` (create)

**Interfaces:**
- Produces: `catalog.hplc_keys.LEGACY_HPLC_KEY = "hplcpurity_identity"`, `NATIVE_HPLC_KEY = "hplc-purity-identity"`, `HPLC_PRIMARY_KEYS: frozenset[str] = frozenset({LEGACY_HPLC_KEY, NATIVE_HPLC_KEY})`, `hplc_primary_selected(services: dict) -> bool`, `hplc_primary_count(entitlement: dict) -> int`.

`product_registry.py` is deliberately NOT changed: `PRODUCT_REGISTRY` is the legacy set pinned by `test_profile_parity.py`; the native key is a real `analysis_profiles` row (Task 4) and the catalog resolver already prefers rows over the registry for unknown keys.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_hplc_native_alias.py
"""Alias set (spec 2026-09-10, M2b): the new profile key
`hplc-purity-identity` must count as THE HPLC primary everywhere the
legacy `hplcpurity_identity` is hardcoded — otherwise an order carrying
only the new key silently yields 0 paid variance vials and the legacy
demand shadow logs demand_divergence forever."""
import pytest

import models  # noqa: F401


def test_keys_module_contract():
    from catalog.hplc_keys import (HPLC_PRIMARY_KEYS, LEGACY_HPLC_KEY, NATIVE_HPLC_KEY,
                                   hplc_primary_selected)
    assert HPLC_PRIMARY_KEYS == frozenset({"hplcpurity_identity", "hplc-purity-identity"})
    assert LEGACY_HPLC_KEY == "hplcpurity_identity" and NATIVE_HPLC_KEY == "hplc-purity-identity"
    assert hplc_primary_selected({"hplc-purity-identity": True}) is True
    assert hplc_primary_selected({"hplcpurity_identity": True}) is True
    assert hplc_primary_selected({"endotoxin": True}) is False


def test_variance_demand_counts_new_key_like_legacy():
    from sub_samples.service import derive_variance_demand
    legacy = derive_variance_demand({"hplcpurity_identity": True,
                                     "variance": {"hplcpurity_identity": 3}})
    native = derive_variance_demand({"hplc-purity-identity": True,
                                     "variance": {"hplc-purity-identity": 3}})
    assert legacy == native
    assert native["hplc"] == 2          # 3 replicates → 1 base vial + 2 paid


def test_base_demand_counts_new_key(db_session):
    from sub_samples.service import derive_base_demand
    assert derive_base_demand(db_session, {"hplc-purity-identity": True})["hplc"] == \
        derive_base_demand(db_session, {"hplcpurity_identity": True})["hplc"]


def test_seeder_role_map_includes_new_key():
    from lims_analyses.seeder import ROLE_TO_WP_KEYS
    assert "hplc-purity-identity" in ROLE_TO_WP_KEYS["hplc"]
    assert "hplcpurity_identity" in ROLE_TO_WP_KEYS["hplc"]


def test_demand_verify_knows_new_key():
    from catalog.demand_verify import LEGACY_DEMAND_KEYS
    assert "hplc-purity-identity" in LEGACY_DEMAND_KEYS
```

Read `derive_base_demand`'s real signature (`sub_samples/service.py` ~1470-1500) and `derive_variance_demand` (~1436) and adjust the calls: the variance entitlement shape comes from `normalize_variance_entitlement`, so pass the `services` dict exactly the way `tests/test_catalog_demand.py` and `tests/test_demand_ster_vials.py` do.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_hplc_native_alias.py -v`
Expected: FAIL — `ModuleNotFoundError: catalog.hplc_keys`; native variance demand `hplc == 0`.

- [ ] **Step 3: Create the keys module**

```python
# backend/catalog/hplc_keys.py
"""The HPLC primary's order key(s).

`hplcpurity_identity` is the legacy WordPress wire key (SENAITE-routed by
the Integration Service). `hplc-purity-identity` is the native profile key
(spec 2026-09-10) that WordPress emits once `profile_key` is set on the HPLC
test-service row. Both mean "the customer bought HPLC purity + identity";
every place that keys demand, chips, or seeding on the primary reads THIS
set, never the literal. Bac Water keeps its own key (`bac_water_panel`).
"""
LEGACY_HPLC_KEY = "hplcpurity_identity"
NATIVE_HPLC_KEY = "hplc-purity-identity"
HPLC_PRIMARY_KEYS: frozenset[str] = frozenset({LEGACY_HPLC_KEY, NATIVE_HPLC_KEY})


def hplc_primary_selected(services: dict | None) -> bool:
    """True when any HPLC primary key is truthy in an order's services dict."""
    services = services or {}
    return any(bool(services.get(k)) for k in HPLC_PRIMARY_KEYS)


def hplc_primary_count(entitlement: dict | None) -> int:
    """Max entitlement across the primary keys (variance replicate count)."""
    entitlement = entitlement or {}
    return max((int(entitlement.get(k, 0) or 0) for k in HPLC_PRIMARY_KEYS), default=0)
```

- [ ] **Step 4: Apply the alias at each site**

`backend/sub_samples/service.py` `derive_variance_demand` (~1444): replace

```python
    hplc_total = max(entitlement.get("hplcpurity_identity", 0), entitlement.get("bac_water_panel", 0))
```
with
```python
    from catalog.hplc_keys import hplc_primary_count
    hplc_total = max(hplc_primary_count(entitlement), entitlement.get("bac_water_panel", 0))
```

`derive_base_demand` (~1485): replace
```python
    hplc = bool(services.get("hplcpurity_identity") or services.get("bac_water_panel"))
```
with
```python
    from catalog.hplc_keys import hplc_primary_selected
    hplc = hplc_primary_selected(services) or bool(services.get("bac_water_panel"))
```

`backend/lims_analyses/seeder.py` `ROLE_TO_WP_KEYS`:
```python
from catalog.hplc_keys import HPLC_PRIMARY_KEYS
ROLE_TO_WP_KEYS: Dict[str, Set[str]] = {
    "hplc": set(HPLC_PRIMARY_KEYS) | {"bac_water_panel"},
    "endo": {"endotoxin"},
    "ster": {"sterility_pcr"},
    "xtra": set(),  # XTRA vials seed nothing; see scope decision #1
}
```
Keep the comment block above it; append one line: `# hplc: both primary keys (legacy + native profile key) — see catalog/hplc_keys.py`.

`backend/catalog/demand_verify.py`:
```python
from catalog.hplc_keys import HPLC_PRIMARY_KEYS
LEGACY_DEMAND_KEYS = tuple(sorted(HPLC_PRIMARY_KEYS)) + (
    "bac_water_panel", "endotoxin", "sterility_pcr",
)
```
Read how `LEGACY_DEMAND_KEYS` is consumed in `verify_demand_catalog` — if it asserts that every key has an `analysis_profiles` row (it does for the S9 gate), the native key now has one via Task 4; confirm on a fresh sqlite session the verifier logs no ERROR for it.

Also grep for any other literal: `grep -rn "hplcpurity_identity" backend --include=*.py | grep -v tests` — the variance-entitlement normalizer, `product_registry`, `profile_seed._DEMAND_DEFAULTS`, and `s9_demand_precheck.py` should be the only remaining hits; `product_registry` and `profile_seed` stay (legacy set). If `normalize_variance_entitlement` filters keys against a hardcoded allow-list, add `NATIVE_HPLC_KEY` there too and add an assertion for it to `test_variance_demand_counts_new_key_like_legacy`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_hplc_native_alias.py tests/test_catalog_demand.py tests/test_demand_ster_vials.py tests/test_lims_analyses_seeder.py tests/test_catalog_seeding.py tests/test_product_registry.py tests/test_profile_parity.py -v`
Expected: PASS, including every existing parity test (the legacy key's behaviour is unchanged).

- [ ] **Step 6: Commit**

```bash
git add backend/catalog/hplc_keys.py backend/sub_samples/service.py backend/lims_analyses/seeder.py backend/catalog/demand_verify.py backend/tests/test_hplc_native_alias.py
git commit -m "feat(catalog): hplc-purity-identity aliases the HPLC primary in demand/seeder/verify (M2b)" -- backend/catalog/hplc_keys.py backend/sub_samples/service.py backend/lims_analyses/seeder.py backend/catalog/demand_verify.py backend/tests/test_hplc_native_alias.py
```

---

### Task 7: Alias set — frontend (`HPLC_PACKAGE_KEYS`)

**Files:**
- Modify: `src/lib/product-completion.ts` (~119-136)
- Test: `src/test/product-completion.test.ts` (extend)

**Interfaces:**
- Produces: `HPLC_PACKAGE_KEYS` includes `'hplc-purity-identity'`; `familyMatchesProduct('hplc', 'hplc-purity-identity') === true`; the `core`/`accushield` completion checks treat an order whose product key is the native one exactly like the legacy one.

- [ ] **Step 1: Write the failing test**

Append to `src/test/product-completion.test.ts` (reuse the file's `prod`, `ana`, `promo`, `ctx` helpers — read the existing `it(...)` block that asserts the `hplcpurity_identity` chip completes on a promoted `ID_`/`HPLC-PUR` and copy its setup):

```ts
describe('native HPLC profile key', () => {
  it('treats hplc-purity-identity like hplcpurity_identity for completion', () => {
    const legacy = computeProductCompletion(
      ctx({ products: [prod('hplcpurity_identity')], analyses: [ana('HPLC-PUR', null)], promotions: [promo('HPLC-PUR', ['P-1-S01'])] })
    )
    const native = computeProductCompletion(
      ctx({ products: [prod('hplc-purity-identity')], analyses: [ana('HPLC-PUR', null)], promotions: [promo('HPLC-PUR', ['P-1-S01'])] })
    )
    expect(native.find(p => p.key === 'hplc-purity-identity')?.complete).toBe(
      legacy.find(p => p.key === 'hplcpurity_identity')?.complete
    )
    expect(native.find(p => p.key === 'hplc-purity-identity')?.complete).toBe(true)
  })
})
```

Adapt the `ctx({...})` argument names to the real `ctx` helper signature in the file (open it; the helper takes an options object — match its keys and the shape of the result returned by `computeProductCompletion`, e.g. `.complete` may be `.status === 'complete'`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/test/product-completion.test.ts -t "native HPLC"`
Expected: FAIL — native product reports incomplete.

- [ ] **Step 3: Add the key**

```ts
/** HPLC single-component package keys — each one's category is the hplc
 *  family (plus any keywords a dev-seeded catalog maps to them directly).
 *  'hplc-purity-identity' is the native profile key (spec 2026-09-10); it
 *  and the legacy 'hplcpurity_identity' both mean the HPLC primary. */
const HPLC_PACKAGE_KEYS = new Set([
  'core',
  'hplcpurity_identity',
  'hplc-purity-identity',
  'bac_water_panel',
])
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/test/product-completion.test.ts src/test/product-chip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint gate on the touched files only**

Run: `npx eslint src/lib/product-completion.ts src/test/product-completion.test.ts && npx prettier --check src/lib/product-completion.ts src/test/product-completion.test.ts && npx tsc --noEmit`
Expected: clean (repo rule: lint gates are failure-set diffs, never repo-wide prettier).

- [ ] **Step 6: Commit**

```bash
git add src/lib/product-completion.ts src/test/product-completion.test.ts
git commit -m "feat(ui): hplc-purity-identity counts as the HPLC package key (M2b)" -- src/lib/product-completion.ts src/test/product-completion.test.ts
```

---

### Task 8: Full-suite failure-set diff, CHANGELOG, PR

**Files:**
- Modify: `CHANGELOG.md` (Unreleased section; follow the file's existing heading style)
- Modify: `backend/pyproject.toml` / `package.json` version ONLY if the repo's release convention requires a bump per PR (check the last three `chore(release)` commits; if versions are bumped at deploy time, do not bump here).

- [ ] **Step 1: Baseline the full backend suite on master**

```bash
git worktree add C:/tmp/Accu-Mk1-master-baseline origin/master
cd C:/tmp/Accu-Mk1-master-baseline/backend && python -m pytest -q -p no:cacheprovider 2>&1 | grep -E "^(FAILED|ERROR)" | sort > C:/tmp/mk1-baseline-failures.txt
```

- [ ] **Step 2: Run the full suite on the branch and diff**

```bash
cd <branch worktree>/backend && python -m pytest -q -p no:cacheprovider 2>&1 | grep -E "^(FAILED|ERROR)" | sort > C:/tmp/mk1-branch-failures.txt
diff C:/tmp/mk1-baseline-failures.txt C:/tmp/mk1-branch-failures.txt
```
Expected: empty diff (no NEW failures). Any new failure is either a bug in this slice (fix it) or a stale test (record why in the PR body; do not silence).

- [ ] **Step 3: Frontend gate**

Run: `npm run check:all`
Expected: same failure set as master (compare the same way if the repo has known baseline failures).

- [ ] **Step 4: CHANGELOG entry**

Under the Unreleased heading:

```markdown
### Added
- HPLC-native foundation (slice 1 of the native-born HPLC program, spec `docs/superpowers/specs/2026-09-10-hplc-native-born-design.md`): `lims_analyses.peptide_id` + `slot` (nullable, additive) with slot-aware root unique indexes; boot seed of the five native HPLC services, the `hplc-purity-identity` profile and their wildcard specs; `hplc-purity-identity` accepted as the HPLC primary key alongside `hplcpurity_identity` in demand, seeding, verification and product-completion. Dark: no order carries the new key until the WordPress `profile_key` is set.
```

- [ ] **Step 5: Commit and open the PR**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): HPLC-native slice 1" -- CHANGELOG.md
git push -u origin feat/hplc-native-slice1
gh pr create --title "HPLC-native slice 1: peptide_id/slot schema, native catalog seed, primary-key alias set" --body-file - <<'EOF'
Implements M1 + M2 + M2b of docs/superpowers/specs/2026-09-10-hplc-native-born-design.md.

Behaviour-neutral: `slot` is NULL on every existing row (COALESCE(slot,0) keeps uniqueness identical), the new profile key is ordered by nobody until WordPress sets `profile_key`, and `hplcpurity_identity` behaviour is unchanged (alias tests prove parity).

- schema: peptide_id, slot, CHECK 1..8, five root indexes widened (DROP+CREATE, last-boot-wins), live-DB effect test
- catalog: `catalog/hplc_native_seed.py` — 5 services (origin=mk1, Analytical), profile `hplc-purity-identity` (role hplc, vials 1, archetype NULL), wildcard specs (purity ≥98 %, quantity informational "As measured", identity equals "Conforms"); audited via catalog change log
- alias set: `catalog/hplc_keys.py` consumed by derive_variance_demand / derive_base_demand / seeder ROLE_TO_WP_KEYS / demand_verify / product-completion.ts

Test gate: full-suite failure-set diff vs master is empty (attach the diff output).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 6: Stack smoke (after merge, before the next slice)**

On an isolated accumark-stack with this image: boot twice; `SELECT keyword, origin, department_id FROM analysis_services WHERE keyword LIKE 'HPLC-%'` → 5 rows once; `SELECT key, vials_required, fulfillment_role, coa_archetype FROM analysis_profiles WHERE key='hplc-purity-identity'` → (1, hplc, NULL); `SELECT indexdef FROM pg_indexes WHERE indexname LIKE 'uq_lims_analyses_%'` → all five contain `COALESCE(slot, 0)`; `GET /s2s/catalog/service-keys` lists `hplc-purity-identity`; place a legacy HPLC order and confirm registration/receive/seed behave exactly as before (rows have `slot IS NULL`).

---

## Self-review notes

- Spec coverage: M1 (Tasks 1–3), M2 (Tasks 4–5), M2b (Tasks 6–7). `product_registry.py:36` deliberately left unchanged (legacy set; explained in Task 6). Counter seed for `lims_native_id_sequences` (`P`=5000/`PB`=1000) is listed under M1 in the spec but depends on the customer-prefix mint in M3, so it moves to the M3 plan with that code — noted here so the M3 planner does not miss it.
- Type consistency: `create_analysis` kwargs (Task 3) are what the M4 seeder will call; `HPLC_NATIVE_SERVICES` ordering (Task 4) is the member `sort_order` and the future COA row order; `HPLC_PRIMARY_KEYS` (Task 6) is the single source for the M3/M4 branches.
- No placeholders: every code step carries its code; where a signature must be confirmed against the file, the step says which file and what to look for.
