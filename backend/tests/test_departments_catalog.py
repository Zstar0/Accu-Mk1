"""Catalog: departments table + extended group/service columns. Self-restoring."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401  (register all models on Base)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def test_department_persists_with_defaults(db_session):
    from models import Department
    d = Department(name="Microbiology")
    db_session.add(d)
    db_session.commit()
    db_session.refresh(d)
    assert d.id is not None
    assert d.name == "Microbiology"
    assert d.sort_order == 0
    assert d.color == "blue"
    assert d.is_system is False


def test_service_group_and_service_have_catalog_columns(db_session):
    from models import Department, ServiceGroup, AnalysisService
    dept = Department(name="Analytical")
    db_session.add(dept)
    db_session.commit()

    g = ServiceGroup(name="Analytics", department_id=dept.id, vials_required=1, is_assignable=True)
    s = AnalysisService(
        title="HPLC Purity", keyword="PUR_X",
        department_id=dept.id, vials_required=1, is_assignable=False, sla_tier_id=None,
    )
    db_session.add_all([g, s])
    db_session.commit()
    db_session.refresh(g)
    db_session.refresh(s)

    assert g.department_id == dept.id
    assert g.vials_required == 1
    assert g.is_assignable is True
    assert s.department_id == dept.id
    assert s.vials_required == 1
    assert s.is_assignable is False
    assert s.sla_tier_id is None


def _seed_groups_and_services(db_session):
    from models import ServiceGroup, AnalysisService
    from models import service_group_members
    analytics = ServiceGroup(name="Analytics")
    micro = ServiceGroup(name="Microbiology")
    db_session.add_all([analytics, micro])
    db_session.commit()
    pur = AnalysisService(title="Purity X", keyword="PUR_X")
    ster = AnalysisService(title="Sterility PCR", keyword="STER-PCR")
    db_session.add_all([pur, ster])
    db_session.commit()
    db_session.execute(service_group_members.insert().values(
        service_group_id=analytics.id, analysis_service_id=pur.id))
    db_session.execute(service_group_members.insert().values(
        service_group_id=micro.id, analysis_service_id=ster.id))
    db_session.commit()
    return analytics, micro, pur, ster


def test_backfill_seeds_departments_and_assigns_ids(db_session):
    from catalog.departments import backfill_departments
    from models import Department, ServiceGroup, AnalysisService
    analytics, micro, pur, ster = _seed_groups_and_services(db_session)

    backfill_departments(db_session)

    dept_names = {d.name for d in db_session.query(Department).all()}
    assert {"Analytical", "Microbiology"} <= dept_names

    analytical = db_session.query(Department).filter_by(name="Analytical").one()
    microbiology = db_session.query(Department).filter_by(name="Microbiology").one()
    assert db_session.get(ServiceGroup, analytics.id).department_id == analytical.id
    assert db_session.get(ServiceGroup, micro.id).department_id == microbiology.id
    assert db_session.get(AnalysisService, pur.id).department_id == analytical.id
    assert db_session.get(AnalysisService, ster.id).department_id == microbiology.id


def test_backfill_is_idempotent(db_session):
    from catalog.departments import backfill_departments
    from models import Department, ServiceGroup, AnalysisService
    analytics, micro, pur, ster = _seed_groups_and_services(db_session)
    backfill_departments(db_session)

    # Capture department_id assignments after the first run.
    analytics_dept_id = db_session.get(ServiceGroup, analytics.id).department_id
    micro_dept_id = db_session.get(ServiceGroup, micro.id).department_id
    pur_dept_id = db_session.get(AnalysisService, pur.id).department_id
    ster_dept_id = db_session.get(AnalysisService, ster.id).department_id

    backfill_departments(db_session)

    # No duplicate department rows.
    assert db_session.query(Department).filter_by(name="Microbiology").count() == 1
    assert db_session.query(Department).filter_by(name="Analytical").count() == 1
    # department_id assignments are stable across runs.
    assert db_session.get(ServiceGroup, analytics.id).department_id == analytics_dept_id
    assert db_session.get(ServiceGroup, micro.id).department_id == micro_dept_id
    assert db_session.get(AnalysisService, pur.id).department_id == pur_dept_id
    assert db_session.get(AnalysisService, ster.id).department_id == ster_dept_id
