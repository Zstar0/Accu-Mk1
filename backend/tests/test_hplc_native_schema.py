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
