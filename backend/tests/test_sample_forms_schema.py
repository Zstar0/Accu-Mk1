"""Sample Forms schema (spec 2026-10-26 sample-forms, task 2).

SQLite tests prove the model-level constraints; the migration-order test runs
the REAL database._run_migrations() against a fake connection, because SQLite
never executes the raw migration SQL.
"""

import pytest
from sqlalchemy.exc import IntegrityError

from models import LimsSampleForm


def _captured():
    """Same idiom as test_hplc_native_schema._captured: run the REAL
    _run_migrations() against a fake connection."""
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


def _index_of(sqls, needle):
    for i, sql in enumerate(sqls):
        if needle in sql:
            return i
    pytest.fail(f"no migration statement contains {needle!r}")


def test_form_name_unique_case_insensitive(db_session):
    db_session.add(LimsSampleForm(name="Pen", route="injectable"))
    db_session.flush()
    db_session.add(LimsSampleForm(name=" pen ", route="injectable"))
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_only_one_default(db_session):
    db_session.add_all([LimsSampleForm(name="A", route="oral", is_default=True),
                        LimsSampleForm(name="B", route="oral", is_default=True)])
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_route_check_rejects_unknown_route(db_session):
    db_session.add(LimsSampleForm(name="Patch", route="topical"))
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_migrations_create_forms_before_any_fk_and_seed_only_empty_table():
    sqls = _captured()
    i_create = _index_of(sqls, "CREATE TABLE IF NOT EXISTS lims_sample_forms")
    i_sample_fk = _index_of(sqls, "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS sample_form_id")
    i_spec_fk = _index_of(sqls, "ALTER TABLE analysis_service_specs ADD COLUMN IF NOT EXISTS sample_form_id")
    assert i_create < i_sample_fk and i_create < i_spec_fk
    seed = sqls[_index_of(sqls, "INSERT INTO lims_sample_forms")]
    assert "WHERE NOT EXISTS (SELECT 1 FROM lims_sample_forms)" in seed
    backfill = sqls[_index_of(sqls, "UPDATE lims_samples SET sample_form_id")]
    assert "sample_form_id IS NULL" in backfill and "'Peptide Blend'" in backfill
