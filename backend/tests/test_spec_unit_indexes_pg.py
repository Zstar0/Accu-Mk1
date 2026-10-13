"""Endo slice 3: the spec uniqueness index swap on Postgres (spec
docs/superpowers/specs/2026-10-12-endo-slice3-promote-loq-design.md sections
6, 9 and 10).

The swap's indexes are btrim expressions, so this file runs only when
MK1_TEST_POSTGRES_URL names a Postgres it may write to, and skips everywhere
else (the test_endo_v2_migration_pg.py idiom). Everything runs in a throwaway
schema that is dropped afterwards. Inside a stack container (Task 9):

    MK1_TEST_POSTGRES_URL="postgresql+psycopg2://$MK1_DB_USER:$MK1_DB_PASSWORD@$MK1_DB_HOST:$MK1_DB_PORT/$MK1_DB_NAME" \\
        python -m pytest tests/test_spec_unit_indexes_pg.py -q -p no:cacheprovider
"""
import os
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import models  # noqa: F401  (register the tables on Base, as init_db does)
import flags.models  # noqa: F401
import documents.models  # noqa: F401
import groups.models  # noqa: F401
import boards.models  # noqa: F401
from database import Base, _SPEC_UNIT_INDEX_SWAP
from models import AnalysisService, AnalysisServiceSpec, Peptide

URL = os.environ.get("MK1_TEST_POSTGRES_URL")
SCHEMA = "spec_unit_index_test"

pytestmark = pytest.mark.skipif(not URL, reason="set MK1_TEST_POSTGRES_URL to run the Postgres migration test")

NEW = {"uq_analysis_service_specs_matrix_unit", "uq_analysis_service_specs_peptide_unit",
       "uq_analysis_service_specs_wildcard_unit"}
OLD_NAMES = {"uq_analysis_service_specs_matrix", "uq_analysis_service_specs_peptide",
             "uq_analysis_service_specs_wildcard"}
# The three indexes a deployed database holds before this release (database.py at 93490a84).
OLD = (
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_analysis_service_specs_matrix "
    "ON analysis_service_specs (analysis_service_id, matrix) WHERE active AND matrix IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_analysis_service_specs_peptide "
    "ON analysis_service_specs (analysis_service_id, peptide_id) WHERE active AND peptide_id IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_analysis_service_specs_wildcard "
    "ON analysis_service_specs (analysis_service_id) WHERE active AND matrix IS NULL AND peptide_id IS NULL",
)


@pytest.fixture
def pg():
    admin = create_engine(URL)
    with admin.begin() as c:
        c.execute(text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        c.execute(text(f"CREATE SCHEMA {SCHEMA}"))
    engine = create_engine(URL, connect_args={"options": f"-csearch_path={SCHEMA}"})
    try:
        Base.metadata.create_all(engine)
        # create_all builds the new indexes from the model; trade them for the
        # old ones to get the shape a deployed database has before this release.
        with engine.begin() as c:
            for name in NEW:
                c.execute(text(f"DROP INDEX {name}"))
            for ddl in OLD:
                c.execute(text(ddl))
        with Session(engine) as s:
            svc = AnalysisService(title="Endotoxin USP85 LAL", keyword="ENDOTOXIN-USP85LAL",
                                  origin="mk1", unit="EU/mL")
            pep = Peptide(name="BPC-157", abbreviation="BPC157")
            s.add_all([svc, pep])
            s.flush()
            # Service 281's EU/mL rows as production held them on 2026-10-12.
            for scope in ({}, {"matrix": "Bacteriostatic Water"}, {"peptide_id": pep.id}):
                s.add(AnalysisServiceSpec(analysis_service_id=svc.id, rule_kind="range",
                                          min_value=Decimal("0"), max_value=Decimal("5"),
                                          unit="EU/mL", **scope))
            s.commit()
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as c:
            c.execute(text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        admin.dispose()


def _indexes(engine) -> dict:
    with engine.connect() as c:
        return dict(c.execute(text(
            "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = :s "
            "AND tablename = 'analysis_service_specs' "
            "AND indexname LIKE 'uq_analysis_service_specs%'"), {"s": SCHEMA}).all())


def _boot(engine) -> None:
    """The swap as _run_migrations runs it: one statement, one commit."""
    with engine.begin() as c:
        c.execute(text(_SPEC_UNIT_INDEX_SWAP))


def _service_id(engine) -> int:
    with engine.connect() as c:
        return c.execute(text(
            "SELECT id FROM analysis_services WHERE keyword = 'ENDOTOXIN-USP85LAL'")).scalar_one()


def test_the_swap_replaces_the_old_indexes_and_a_second_boot_changes_nothing(pg):
    assert set(_indexes(pg)) == OLD_NAMES
    _boot(pg)
    first = _indexes(pg)
    assert set(first) == NEW
    assert all("lower(btrim(" in d and "WHERE (active" in d for d in first.values()), first
    _boot(pg)
    assert _indexes(pg) == first


def test_an_older_image_boot_is_undone_by_the_next_boot(pg):
    _boot(pg)
    with pg.begin() as c:      # an older image re-creates its own names (LAST-BOOT-WINS)
        for ddl in OLD:
            c.execute(text(ddl))
    assert set(_indexes(pg)) == NEW | OLD_NAMES
    _boot(pg)
    assert set(_indexes(pg)) == NEW


def test_one_active_row_per_scope_and_unit(pg):
    _boot(pg)
    sid = _service_id(pg)

    def spec(**over):
        return AnalysisServiceSpec(analysis_service_id=sid, rule_kind="range",
                                   min_value=Decimal("0"), max_value=Decimal("350"), **over)

    with Session(pg) as s:
        # EU/vial beside the EU/mL rows, in a matrix scope and in the wildcard.
        s.add_all([spec(matrix="Peptide", unit="EU/vial"), spec(unit="EU/vial")])
        s.commit()
        s.add(spec(matrix="Peptide", unit=" eu/VIAL "))
        with pytest.raises(IntegrityError):
            s.commit()
        s.rollback()
        s.add(spec(matrix="Peptide", unit=" eu/VIAL ", active=False))
        s.commit()             # an inactive duplicate is history, never a conflict
