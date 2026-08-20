"""Methods controlled documents (slice 3) — Task 1: lifecycle columns +
revision-aware uniqueness. Harness copied verbatim from
tests/test_methods_catalog.py (in-memory SQLite, same idiom as
tests/test_manage_native_routes.py).

Scope note: create_method still mints active=True/status='active' by default
in this task — the draft-mint flip is a later task. These tests exercise the
schema directly via the ORM, as the brief's own Step 1 test does.
"""
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import models  # noqa: F401
from database import Base
from models import AnalysisService, HplcMethod


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


def test_lifecycle_columns_and_same_name_revisions(db_session):
    m1 = HplcMethod(name="ICP-MS", code="AM-E-1", revision=1, status="active",
                    active=True, origin="mk1")
    m2 = HplcMethod(name="ICP-MS", code="AM-E-1", revision=2, status="draft",
                    active=False, origin="mk1", supersedes_id=None)
    db_session.add_all([m1, m2])
    db_session.commit()   # (name,1)+(name,2) legal now; plain name-unique would raise
    assert m2.activated_at is None


def test_lifecycle_columns_default_to_active_revision_1(db_session):
    m = HplcMethod(name="KF Titration", origin="mk1", active=True)
    db_session.add(m)
    db_session.commit()
    row = db_session.execute(select(HplcMethod).where(HplcMethod.name == "KF Titration")).scalar_one()
    assert row.status == "active"
    assert row.revision == 1
    assert row.activated_at is None
    assert row.retired_at is None


def test_duplicate_name_revision_pair_rejected(db_session):
    m1 = HplcMethod(name="PCR Detection", revision=1, origin="mk1", active=True)
    db_session.add(m1)
    db_session.commit()

    m2 = HplcMethod(name="PCR Detection", revision=1, origin="mk1", active=True)
    db_session.add(m2)
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_code_revision_pair_unique_but_different_revisions_coexist(db_session):
    # Same code across two revisions is legal as long as only one is active
    # (uq_hplc_methods_code_active is a separate, narrower constraint).
    m1 = HplcMethod(name="ICP-MS R1", code="AM-E-2", revision=1, status="active",
                    active=True, origin="mk1")
    m2 = HplcMethod(name="ICP-MS R2", code="AM-E-2", revision=2, status="draft",
                    active=False, origin="mk1")
    db_session.add_all([m1, m2])
    db_session.commit()

    rows = db_session.execute(select(HplcMethod).where(HplcMethod.code == "AM-E-2")).scalars().all()
    assert {r.revision for r in rows} == {1, 2}


def test_duplicate_code_revision_pair_rejected(db_session):
    m1 = HplcMethod(name="ICP-MS Dup A", code="AM-E-3", revision=1, origin="mk1", active=True)
    db_session.add(m1)
    db_session.commit()

    m2 = HplcMethod(name="ICP-MS Dup B", code="AM-E-3", revision=1, origin="mk1", active=False)
    db_session.add(m2)
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_two_active_rows_same_code_rejected_even_across_revisions(db_session):
    # uq_hplc_methods_code_active: at most one status='active' row per code,
    # regardless of revision.
    m1 = HplcMethod(name="ICP-MS Active A", code="AM-E-4", revision=1, status="active",
                    active=True, origin="mk1")
    db_session.add(m1)
    db_session.commit()

    m2 = HplcMethod(name="ICP-MS Active B", code="AM-E-4", revision=2, status="active",
                    active=True, origin="mk1")
    db_session.add(m2)
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_null_code_rows_unconstrained_by_code_indexes(db_session):
    m1 = HplcMethod(name="No Code A", code=None, revision=1, origin="mk1", active=True)
    m2 = HplcMethod(name="No Code B", code=None, revision=1, origin="mk1", active=True)
    db_session.add_all([m1, m2])
    db_session.commit()  # both code=None rows coexist: partial indexes are WHERE code IS NOT NULL

    rows = db_session.execute(select(HplcMethod).where(HplcMethod.code.is_(None))).scalars().all()
    assert len(rows) == 2
