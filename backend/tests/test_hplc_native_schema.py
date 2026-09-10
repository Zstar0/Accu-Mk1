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


def test_slice1_boot_statements_execute_against_live_db():
    """Executes the M1 statements against the live dev Postgres inside a
    savepoint that is rolled back, then proves the EFFECT: two rows of the
    same service on one vial with slots 1 and 2 insert, while two slot-NULL
    rows collide. Same recipe as
    test_workflow_engine.test_sbs_boot_statements_execute_against_live_db."""
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError
    from database import SessionLocal

    # Task 1 (4 statements) and Task 2 (10 statements) are the final
    # contiguous block appended to the migrations list — nothing else is
    # appended after them, so the last 14 captured statements ARE exactly
    # these. (Marker-based substring matching is unsafe here: other tables
    # also gain a `peptide_id` column, and these five index names have
    # earlier DROP/CREATE history in the same list — both give false
    # positives on a substring filter.)
    all_stmts = _captured()
    stmts = all_stmts[-14:]
    assert "ADD COLUMN IF NOT EXISTS peptide_id" in stmts[0]
    assert "ADD COLUMN IF NOT EXISTS slot" in stmts[1]
    assert "ck_lims_analyses_slot_range" in stmts[2]
    assert "ix_lims_analyses_peptide_id" in stmts[3]
    assert sum(1 for s in stmts if "COALESCE(slot, 0)" in s) == 5
    assert sum(1 for s in stmts if s.strip().startswith("DROP INDEX IF EXISTS uq_lims_analyses_")) == 5

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
