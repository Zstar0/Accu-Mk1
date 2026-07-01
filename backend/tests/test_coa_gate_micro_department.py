"""Plan 1C Task 1: the COA-gate micro classifier is Department-based.

Live Postgres (catalog seeded at boot). Rollback-only teardown; ZZTEST rows.
"""
import pytest
from sqlalchemy import select

from database import SessionLocal
from models import AnalysisService, Department, ServiceGroup, service_group_members
from catalog.departments import department_id_by_name
from lims_analyses.seeder import _micro_group_keywords, _NON_HPLC_GROUPS


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _old_group_name_micro_keywords(db) -> set[str]:
    """The pre-1C group-NAME classifier, inlined, to assert parity against."""
    rows = db.execute(
        select(AnalysisService.keyword)
        .join(service_group_members,
              service_group_members.c.analysis_service_id == AnalysisService.id)
        .join(ServiceGroup, ServiceGroup.id == service_group_members.c.service_group_id)
        .where(ServiceGroup.name.in_(_NON_HPLC_GROUPS))
    ).scalars().all()
    return {k for k in rows if k}


def test_catches_microbiology_service_in_a_nonmicro_named_group(db):
    """A Microbiology-dept service whose only group is NOT named
    Microbiology/Endotoxin must still be micro — the landmine case."""
    micro_id = department_id_by_name(db, "Microbiology")
    assert micro_id is not None, "Microbiology department must be seeded"

    svc = AnalysisService(
        title="ZZ Sterility Probe", keyword="ZZTEST-STER-PROBE", department_id=micro_id
    )
    db.add(svc)
    db.flush()
    grp = ServiceGroup(name="ZZTEST Sterility PCR", department_id=micro_id, is_assignable=True)
    db.add(grp)
    db.flush()
    db.execute(service_group_members.insert().values(
        service_group_id=grp.id, analysis_service_id=svc.id))
    db.flush()

    assert "ZZTEST-STER-PROBE" in _micro_group_keywords(db)


def test_parity_no_existing_micro_keyword_is_dropped(db):
    """SAFE direction: Department set must be a superset of the legacy
    group-name set — no COA-gate regression for HPLC/existing micro."""
    old = _old_group_name_micro_keywords(db)
    new = _micro_group_keywords(db)
    assert old <= new, f"dropped micro keywords: {sorted(old - new)}"


# The only intended NEW additions to the micro-exempt set (native sterility
# services that live in a non-"Microbiology"-named group). Verified empirically
# 2026-07-01: the delta is empty pre-seed and exactly this set post-Task-2.
_EXPECTED_NEW_MICRO = {"STER-USP71"}


def test_no_unexpected_keyword_added_to_micro_exempt_set(db):
    """DANGEROUS direction: a keyword IN the micro set is EXEMPTED from the COA
    chromatogram requirement. The Department conversion must not silently exempt
    an analytical service that was mis-departmented Microbiology. Any addition
    beyond the known native sterility services fails loudly."""
    old = _old_group_name_micro_keywords(db)
    new = _micro_group_keywords(db)
    added = new - old
    assert added <= _EXPECTED_NEW_MICRO, (
        f"UNEXPECTED keywords newly exempted from COA-blocking: "
        f"{sorted(added - _EXPECTED_NEW_MICRO)} — check for a mis-departmented "
        f"analytical service (would skip a required chromatogram on a certificate)"
    )


def test_returns_exactly_microbiology_department_keywords(db):
    """The new set == every Microbiology-department service keyword."""
    micro_id = department_id_by_name(db, "Microbiology")
    expected = set(db.execute(
        select(AnalysisService.keyword).where(
            AnalysisService.department_id == micro_id,
            AnalysisService.keyword.isnot(None),
            AnalysisService.keyword != "",
        )
    ).scalars().all())
    assert _micro_group_keywords(db) == expected
