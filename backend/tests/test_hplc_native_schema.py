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


_ROOT_INDEXES = (
    "uq_lims_analyses_sub_service_root",
    "uq_lims_analyses_sub_service_id_root",
    "uq_lims_analyses_parent_service_root",
    "uq_lims_analyses_parent_service_id_root",
    "uq_lims_analyses_parent_service_ordered",
)


def _do_block_for(stmts, name):
    """The LAST statement mentioning an index name is the atomic DO $$
    block that widens it — a boot leaves that block's effect in place."""
    hits = [s for s in stmts if name in s]
    assert hits, f"no statement mentions {name}"
    last = hits[-1]
    assert "DO $$" in last, f"last statement for {name} is not a DO block: {last!r}"
    return last


def test_root_indexes_widen_atomically():
    """Each of the five root indexes must be widened by ONE atomic DO $$
    block (DROP + CREATE inside a single transaction), never a standalone
    DROP followed by a standalone CREATE — _run_migrations swallows a
    failing CREATE as migration_skipped, so a DROP that already committed
    would silently delete the identity-uniqueness guarantee. (Finding 1 fix:
    two of these five names — the plain _root, non-_id_root pair — used to
    also carry an OLDER, pre-existing standalone DROP+CREATE pair earlier in
    the migrations list, from prior tasks that predate this slice. Once M1
    slot data exists, that legacy pair's unwidened CREATE fails on real
    duplicate rows and the already-committed DROP leaves the index briefly
    missing on every boot — the same hazard this test polices, reached
    through a different door. Those legacy pairs were converted to the same
    guarded DO $$ idiom; see test_no_standalone_drop_remains_for_root_indexes
    for the assertion that no standalone DROP remains anywhere for any of
    the five names.)"""
    stmts = _captured()
    for name in _ROOT_INDEXES:
        # _do_block_for already asserts the LAST statement mentioning this
        # name is a DO $$ block, not a standalone "DROP INDEX IF EXISTS" —
        # i.e. whatever a boot leaves in place is the atomic widen, never a
        # standalone DROP paired with a swallow-able CREATE.
        block = _do_block_for(stmts, name)
        assert f"DROP INDEX {name}" in block, name
        assert f"CREATE UNIQUE INDEX {name}" in block, name
        assert "COALESCE(slot, 0)" in block, name


def test_no_standalone_drop_remains_for_root_indexes():
    """Finding 1 fix also converted the pre-slice legacy
    `DROP INDEX IF EXISTS <name>` + `CREATE UNIQUE INDEX IF NOT EXISTS <name>`
    pairs (two sites for uq_lims_analyses_sub_service_root /
    uq_lims_analyses_parent_service_root, one extra site for the latter)
    into the same guarded DO $$ idiom used by the five Task-2 widen blocks.
    Those pairs used to run unconditionally on every boot; once M1 slot data
    exists the old unwidened CREATE fails on real duplicate rows, and the
    already-committed DROP leaves root uniqueness briefly unenforced. Assert
    no standalone `DROP INDEX IF EXISTS <name>` statement remains anywhere in
    the full migrations list for any of the five root index names."""
    stmts = _captured()
    for name in _ROOT_INDEXES:
        assert not any(f"DROP INDEX IF EXISTS {name}" in s for s in stmts), name


def test_slot_aware_indexes_keep_their_predicates():
    """Widening must not loosen the WHERE clauses — copy them verbatim."""
    stmts = _captured()
    sub_root = _do_block_for(stmts, "uq_lims_analyses_sub_service_root")
    assert "retest_of_id IS NULL AND lims_sub_sample_pk IS NOT NULL" in sub_root
    assert "review_state NOT IN ('retracted', 'rejected')" in sub_root
    parent_root = _do_block_for(stmts, "uq_lims_analyses_parent_service_root")
    assert "provenance = 'canonical'" in parent_root
    parent_id_root = _do_block_for(stmts, "uq_lims_analyses_parent_service_id_root")
    assert "provenance = 'canonical'" in parent_id_root
    ordered = _do_block_for(stmts, "uq_lims_analyses_parent_service_ordered")
    assert "provenance = 'ordered'" in ordered


def test_slice1_boot_statements_execute_against_live_db():
    """Executes the M1 statements against the live dev Postgres inside a
    savepoint that is rolled back, then proves the EFFECT: two rows of the
    same service on one vial with slots 1 and 2 insert, while two slot-NULL
    rows collide. Same recipe as
    test_workflow_engine.test_sbs_boot_statements_execute_against_live_db."""
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError
    from database import SessionLocal

    # Task 1's four statements are identified by markers scoped to
    # lims_analyses (bare "peptide_id"/"slot" substrings are too loose —
    # other tables gain their own peptide_id columns/indexes elsewhere in
    # this same migrations list). Task 2/Finding-B's five atomic widen
    # blocks are identified by `COALESCE(slot, 0)`, which appears only
    # inside those five DO $$ blocks (verified: no other statement in
    # database.py uses that literal). Position-based slicing (`stmts[-14:]`)
    # is deliberately NOT used — Finding B replaced the five standalone
    # DROP+CREATE pairs with five DO blocks, changing the statement count
    # for this section from 14 to 9.
    all_stmts = _captured()
    task1 = [s for s in all_stmts
             if "lims_analyses ADD COLUMN IF NOT EXISTS peptide_id" in s
             or "lims_analyses ADD COLUMN IF NOT EXISTS slot" in s
             or "ck_lims_analyses_slot_range" in s
             or "ix_lims_analyses_peptide_id" in s]
    do_blocks = [s for s in all_stmts if "COALESCE(slot, 0)" in s]
    stmts = task1 + do_blocks
    assert len(stmts) == 9
    assert any("ADD COLUMN IF NOT EXISTS peptide_id" in s for s in task1)
    assert any("ADD COLUMN IF NOT EXISTS slot" in s for s in task1)
    assert any("ck_lims_analyses_slot_range" in s for s in task1)
    assert any("ix_lims_analyses_peptide_id" in s for s in task1)
    assert len(do_blocks) == 5
    assert all("DO $$" in s for s in do_blocks)

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
            # Postgres normalizes indexdef with an explicit cast
            # (COALESCE((slot)::integer, 0)) — assert on the semantic
            # content rather than our literal source text.
            assert "COALESCE(" in defs[name] and "slot" in defs[name], defs[name]

        svc_id = conn.execute(text(
            "INSERT INTO analysis_services (title, keyword, origin, active, created_at, updated_at) "
            "VALUES ('t', 'ZZ-SLOT-TEST', 'mk1', TRUE, NOW(), NOW()) RETURNING id")).scalar()
        parent_pk = conn.execute(text(
            "INSERT INTO lims_samples (sample_id) VALUES ('ZZ-SLOT-1') RETURNING id")).scalar()
        vial_pk = conn.execute(text(
            "INSERT INTO lims_sub_samples (parent_sample_pk, external_lims_uid, sample_id, vial_sequence) "
            "VALUES (:p, 'ZZ-SLOT-1-S01', 'ZZ-SLOT-1-S01', 1) RETURNING id"), {"p": parent_pk}).scalar()
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


def test_root_index_widen_guard_is_idempotent_and_preserves_oid():
    """Finding 1 (final review): the guard `indexdef NOT LIKE '%COALESCE(slot%'`
    is TRUE even on an already-widened index, because Postgres normalizes the
    stored indexdef to `COALESCE((slot)::integer, 0)` — the literal substring
    `COALESCE(slot` never appears. That made every boot drop and rebuild all
    five unique indexes under an ACCESS EXCLUSIVE lock. The fix widened the
    guard to `NOT LIKE '%COALESCE%'`. Prove the fix on SEMANTICS, not source
    text: run the five DO blocks against the live dev DB inside a rolled-back
    savepoint, assert the guard condition is False for all five afterward
    (it would not fire again), run the blocks a SECOND time, and assert the
    five index OIDs are byte-identical between the two runs (no drop+recreate
    happened on the second pass)."""
    from sqlalchemy import text
    from database import SessionLocal

    all_stmts = _captured()
    do_blocks = [s for s in all_stmts if "COALESCE(slot, 0)" in s]
    assert len(do_blocks) == 5

    s = SessionLocal()
    conn = s.connection()
    outer = conn.begin_nested()
    try:
        # First pass: bring the indexes to the widened state (no-op if a
        # prior boot on this shared dev DB already widened them).
        for stmt in do_blocks:
            conn.execute(text(stmt))

        guard_rows = dict(conn.execute(text(
            "SELECT indexname, (indexdef NOT LIKE '%COALESCE%') FROM pg_indexes "
            "WHERE tablename='lims_analyses' AND indexname LIKE 'uq_lims_analyses_%'"
        )).all())
        for name in _ROOT_INDEXES:
            assert guard_rows[name] is False, (
                f"{name}: guard would still fire (indexdef missing COALESCE) -> "
                f"{guard_rows[name]!r}"
            )

        oid_rows_before = dict(conn.execute(text(
            "SELECT relname, oid FROM pg_class WHERE relname = ANY(:names)"
        ), {"names": list(_ROOT_INDEXES)}).all())
        assert set(oid_rows_before) == set(_ROOT_INDEXES)

        # Second pass: re-run the identical DO blocks. If the guard still
        # misfired, this would DROP + CREATE each index and mint new OIDs.
        for stmt in do_blocks:
            conn.execute(text(stmt))

        oid_rows_after = dict(conn.execute(text(
            "SELECT relname, oid FROM pg_class WHERE relname = ANY(:names)"
        ), {"names": list(_ROOT_INDEXES)}).all())

        assert oid_rows_before == oid_rows_after, (
            "index OIDs changed on re-run -> guard fired and rebuilt: "
            f"before={oid_rows_before} after={oid_rows_after}"
        )
    finally:
        outer.rollback()
        s.close()


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
    vial = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="P-9001-S01",
        sample_id="P-9001-S01",
        vial_sequence=1,
    )
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


def test_retest_child_inherits_peptide_id_and_slot(db_session):
    """The retest child is minted inside apply_transition(kind='retest')
    (service.py's retest branch, ~line 479). Walk a fresh vial-tier row
    through assign -> submit to reach 'to_be_verified' (the same setup
    idiom as tests/test_vial_retest.py's _walk_to_tbv), then retest it and
    confirm the child keeps the source row's slot/peptide_id identity."""
    from lims_analyses.service import apply_transition, create_analysis
    svc = _svc(db_session)
    vial = _vial(db_session)
    row = create_analysis(db_session, host_kind="sub_sample", host_pk=vial.id,
                          analysis_service_id=svc.id, keyword=svc.keyword,
                          title="t", slot=3, commit=False)
    db_session.commit()
    apply_transition(db_session, analysis_id=row.id, kind="assign", reason="t")
    apply_transition(db_session, analysis_id=row.id, kind="submit",
                     result_value="98.5", reason="t")
    child = apply_transition(db_session, analysis_id=row.id, kind="retest", reason="t")
    assert (child.slot, child.peptide_id) == (3, None)
