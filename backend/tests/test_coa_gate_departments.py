"""COA-generation blocking gate: department-keyed exemption via a transition
union (S2 Task 9).

`coa_exempt_keywords` = keywords(dept in {Microbiology, Heavy Metals}) UNION
`_micro_group_keywords` (the legacy service-group set). The union exists so
the gate's fail posture cannot invert if either source is empty — prod may
lack the Endotoxin group, department backfill may lag a given service.

RULED 2026-08-12 (Handler): Heavy Metals analytes do NOT block COA
generation. This REVERSES the pre-S2 behavior, where HM blocked by omission
from `_NON_HPLC_GROUPS` (seeder.py). Revisitable once HM turnaround time is
known — do not "fix" it back to blocking without a new Handler ruling.

Live-PG, transaction-rollback fixture (mirrors test_departments_catalog.py):
each test inserts its own service rows (and group membership where needed)
against the real seeded Analytical/Microbiology/Heavy Metals departments and
the real Microbiology service group, then rolls back.
"""
import pytest
from sqlalchemy import select

from models import AnalysisService, Department, ServiceGroup, service_group_members


@pytest.fixture
def db():
    from database import SessionLocal
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def _dept_id(db, name):
    return db.execute(
        select(Department.id).where(Department.name == name)
    ).scalar_one()


def _group_id(db, name):
    return db.execute(
        select(ServiceGroup.id).where(ServiceGroup.name == name)
    ).scalar_one()


def test_micro_by_department_exempt(db):
    """A Microbiology-DEPARTMENT service with NO group membership is in the
    exempt set (the widening the ruling accepted)."""
    from lims_analyses.seeder import coa_exempt_keywords

    micro_id = _dept_id(db, "Microbiology")
    svc = AnalysisService(
        title="Test Micro Dept Only",
        keyword="TEST_MICRO_DEPT_ONLY",
        department_id=micro_id,
    )
    db.add(svc)
    db.flush()

    assert "TEST_MICRO_DEPT_ONLY" in coa_exempt_keywords(db)


def test_micro_by_group_only_still_exempt(db):
    """A service in the Microbiology GROUP whose department_id is NULL stays
    exempt during transition (the union's group half)."""
    from lims_analyses.seeder import coa_exempt_keywords

    group_id = _group_id(db, "Microbiology")
    svc = AnalysisService(
        title="Test Micro Group Only",
        keyword="TEST_MICRO_GROUP_ONLY",
        department_id=None,
    )
    db.add(svc)
    db.flush()
    db.execute(
        service_group_members.insert().values(
            service_group_id=group_id, analysis_service_id=svc.id
        )
    )
    db.flush()

    assert "TEST_MICRO_GROUP_ONLY" in coa_exempt_keywords(db)


def test_heavy_metals_exempt_ruling_2026_08_12(db):
    """RULED 2026-08-12: HM analytes do NOT block COA generation. A Heavy
    Metals-department service (e.g. an hm catalog service) is in the exempt
    set. This test pins a deliberate production-behavior REVERSAL — do not
    'fix' it back without a new Handler ruling."""
    from lims_analyses.seeder import coa_exempt_keywords

    hm_id = _dept_id(db, "Heavy Metals")
    svc = AnalysisService(
        title="Test HM Dept Only",
        keyword="TEST_HM_DEPT_ONLY",
        department_id=hm_id,
    )
    db.add(svc)
    db.flush()

    assert "TEST_HM_DEPT_ONLY" in coa_exempt_keywords(db)


def test_analytical_never_exempt(db):
    """An Analytical-department service is NOT in the set (still blocks)."""
    from lims_analyses.seeder import coa_exempt_keywords

    analytical_id = _dept_id(db, "Analytical")
    svc = AnalysisService(
        title="Test Analytical Only",
        keyword="TEST_ANALYTICAL_ONLY",
        department_id=analytical_id,
    )
    db.add(svc)
    db.flush()

    assert "TEST_ANALYTICAL_ONLY" not in coa_exempt_keywords(db)
