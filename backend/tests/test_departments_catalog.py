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


import auth
from fastapi.testclient import TestClient
from sqlalchemy import text as _text


def _client():
    from main import app
    app.dependency_overrides[auth.get_current_user] = lambda: {"id": 0, "username": "test"}
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cleanup_departments():
    from database import engine
    with engine.connect() as c:
        before = {r[0] for r in c.execute(_text("SELECT id FROM departments")).fetchall()}
    yield
    with engine.begin() as c:
        after = {r[0] for r in c.execute(_text("SELECT id FROM departments")).fetchall()}
        new = list(after - before)
        if new:
            c.execute(_text("DELETE FROM departments WHERE id = ANY(:i)"), {"i": new})


def test_create_and_list_department():
    client = _client()
    resp = client.post("/departments", json={"name": "ZZ Test Dept", "sort_order": 9})
    assert resp.status_code == 201, resp.text
    assert resp.json()["name"] == "ZZ Test Dept"
    listed = client.get("/departments").json()
    assert any(d["name"] == "ZZ Test Dept" for d in listed)


def test_duplicate_department_name_rejected():
    client = _client()
    first = client.post("/departments", json={"name": "ZZ Dup Dept"})
    assert first.status_code == 201, first.text
    resp = client.post("/departments", json={"name": "ZZ Dup Dept"})
    assert resp.status_code == 400


def test_service_groups_response_includes_department_fields():
    client = _client()
    groups = client.get("/service-groups").json()
    assert isinstance(groups, list)
    if groups:
        assert "department_id" in groups[0]
        assert "is_assignable" in groups[0]
        assert "vials_required" in groups[0]


def test_backfill_does_not_overwrite_existing_group_department(db_session):
    """Review follow-up #4a: a manually-reassigned group.department_id survives a
    re-run (backfill owns NULLs only, not a foot-gun once a UI can reassign)."""
    from models import Department, ServiceGroup
    from catalog.departments import backfill_departments
    # Seed a group whose name maps to Analytical, but pin it to Microbiology by hand.
    backfill_departments(db_session)  # creates Analytical + Microbiology
    analytical = db_session.query(Department).filter_by(name="Analytical").one()
    micro = db_session.query(Department).filter_by(name="Microbiology").one()
    g = ServiceGroup(name="Analytics", department_id=micro.id)  # deliberately "wrong"
    db_session.add(g)
    db_session.commit()
    backfill_departments(db_session)  # re-run must NOT clobber the manual choice
    assert db_session.get(ServiceGroup, g.id).department_id == micro.id


def test_backfill_tags_ungrouped_analyte_services_analytical(db_session):
    """The ungrouped ANALYTE-N-* generics (the HPLC-mirror fallback rows) get the
    Analytical department so the fail-closed allow-list (Task 2) keeps them."""
    from models import Department, AnalysisService
    from catalog.departments import backfill_departments
    svc = AnalysisService(keyword="ANALYTE-1-PUR", title="Analyte 1 (Purity)", category="Peptide Analysis")
    db_session.add(svc)
    db_session.commit()
    assert svc.department_id is None  # ungrouped → starts NULL
    backfill_departments(db_session)
    analytical = db_session.query(Department).filter_by(name="Analytical").one()
    assert db_session.get(AnalysisService, svc.id).department_id == analytical.id
