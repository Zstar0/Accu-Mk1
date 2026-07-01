"""Plan 1C Task 2: the Sterility tenant is seeded into the catalog.

Live Postgres — the rows are produced by database._run_migrations() +
backfill_departments() at boot. Read-only assertions; no writes.
"""
import pytest
from sqlalchemy import select

from database import SessionLocal
from models import AnalysisService, Department, ServiceGroup, SlaTier, service_group_members
from catalog.departments import department_for_group_name


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _group(db, name):
    return db.execute(select(ServiceGroup).where(ServiceGroup.name == name)).scalar_one_or_none()


def _members(db, group):
    return set(db.execute(
        select(AnalysisService.keyword)
        .join(service_group_members, service_group_members.c.analysis_service_id == AnalysisService.id)
        .where(service_group_members.c.service_group_id == group.id)
    ).scalars().all())


def test_usp71_sla_tier_seeded():
    with SessionLocal() as db:
        tier = db.execute(select(SlaTier).where(SlaTier.name == "Sterility USP<71>")).scalar_one_or_none()
        assert tier is not None
        assert tier.target_minutes == 20160
        assert tier.is_default is False


def test_native_usp71_service(db):
    svc = db.execute(select(AnalysisService).where(AnalysisService.keyword == "STER-USP71")).scalar_one_or_none()
    assert svc is not None
    assert svc.senaite_id is None and svc.senaite_uid is None      # SENAITE-free
    micro = db.execute(select(Department).where(Department.name == "Microbiology")).scalar_one()
    assert svc.department_id == micro.id                           # backfill cascaded the dept


def test_sterility_pcr_group(db):
    g = _group(db, "Sterility PCR")
    assert g is not None
    micro = db.execute(select(Department).where(Department.name == "Microbiology")).scalar_one()
    assert g.department_id == micro.id
    assert g.vials_required == 1
    assert g.is_assignable is True
    assert _members(db, g) == {"PCR-FUNGI", "PCR-BACTERIA"}


def test_usp71_group_is_single_member_with_14day_tier(db):
    g = _group(db, "Sterility USP<71>")
    assert g is not None
    assert g.vials_required == 1
    assert g.is_assignable is True
    tier = db.execute(select(SlaTier).where(SlaTier.name == "Sterility USP<71>")).scalar_one()
    assert g.sla_tier_id == tier.id
    assert _members(db, g) == {"STER-USP71"}


def test_group_name_department_map_extended():
    assert department_for_group_name("Sterility PCR") == "Microbiology"
    assert department_for_group_name("Sterility USP<71>") == "Microbiology"
