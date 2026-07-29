"""Catalog: departments table + department_id columns + idempotent backfill."""
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
    assert d.sort_order == 0
    assert d.color == "blue"
    assert d.is_system is False


def test_group_and_service_have_department_id(db_session):
    from models import Department, ServiceGroup, AnalysisService
    dept = Department(name="Analytical")
    db_session.add(dept)
    db_session.commit()
    g = ServiceGroup(name="Analytics", department_id=dept.id)
    s = AnalysisService(title="Purity X", keyword="PUR_X", department_id=dept.id)
    db_session.add_all([g, s])
    db_session.commit()
    assert g.department_id == dept.id
    assert s.department_id == dept.id


def _seed_groups_and_services(db_session):
    from models import ServiceGroup, AnalysisService, service_group_members
    analytics = ServiceGroup(name="Analytics")
    micro = ServiceGroup(name="Microbiology")
    db_session.add_all([analytics, micro])
    db_session.commit()
    pur = AnalysisService(title="Purity X", keyword="PUR_X")
    ster = AnalysisService(title="Sterility PCR", keyword="STER-PCR")
    analyte = AnalysisService(title="Analyte 1 Purity", keyword="ANALYTE-1-PUR")
    db_session.add_all([pur, ster, analyte])
    db_session.commit()
    for gid, sid in ((analytics.id, pur.id), (micro.id, ster.id)):
        db_session.execute(service_group_members.insert().values(
            service_group_id=gid, analysis_service_id=sid))
    db_session.commit()
    return analytics, micro, pur, ster, analyte


def test_backfill_seeds_departments_and_assigns_from_live_groups(db_session):
    from catalog.departments import backfill_departments
    from models import Department
    analytics, micro, pur, ster, analyte = _seed_groups_and_services(db_session)

    backfill_departments(db_session)

    names = {d.name for d in db_session.query(Department).all()}
    assert names == {"Analytical", "Microbiology"}
    analytical_id = db_session.query(Department).filter_by(name="Analytical").one().id
    micro_id = db_session.query(Department).filter_by(name="Microbiology").one().id

    db_session.refresh(analytics); db_session.refresh(micro)
    db_session.refresh(pur); db_session.refresh(ster); db_session.refresh(analyte)
    assert analytics.department_id == analytical_id
    assert micro.department_id == micro_id
    assert pur.department_id == analytical_id
    assert ster.department_id == micro_id
    # Ungrouped ANALYTE-* services are tagged Analytical, or the fail-closed
    # HPLC allow-list in Task 2 would drop the very rows the mirror exists for.
    assert analyte.department_id == analytical_id


def test_backfill_is_idempotent(db_session):
    from catalog.departments import backfill_departments
    from models import Department
    _seed_groups_and_services(db_session)
    backfill_departments(db_session)
    backfill_departments(db_session)
    assert db_session.query(Department).count() == 2


def test_backfill_never_clobbers_a_manual_reassignment(db_session):
    from catalog.departments import backfill_departments
    from models import Department
    analytics, _micro, _pur, _ster, _a = _seed_groups_and_services(db_session)
    backfill_departments(db_session)
    micro_id = db_session.query(Department).filter_by(name="Microbiology").one().id

    analytics.department_id = micro_id      # admin moves it by hand
    db_session.commit()
    backfill_departments(db_session)        # a restart must not undo that
    db_session.refresh(analytics)
    assert analytics.department_id == micro_id


def test_department_id_by_name(db_session):
    from catalog.departments import backfill_departments, department_id_by_name
    _seed_groups_and_services(db_session)
    backfill_departments(db_session)
    assert department_id_by_name(db_session, "Analytical") is not None
    assert department_id_by_name(db_session, "Nope") is None
