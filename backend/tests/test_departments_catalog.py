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
