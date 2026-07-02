"""Role-flip stale-row cleanup keys off Department, not group name.

Live Postgres session (real catalog); throwaway ZZTEST vial seeded with
commit=False, discarded by the fixture rollback. A hplc→ster flip must drop the
vial's unassigned Analytical-department rows; an Analytical row with a result is
never touched."""
import pytest
from sqlalchemy import select

from models import LimsAnalysis, LimsSample, LimsSubSample, AnalysisService, Department
from sub_samples.service import _drop_stale_role_rows
from database import SessionLocal


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _vial(db):
    parent = LimsSample(sample_id="ZZTEST-STALE", external_lims_uid="zz-stale")
    db.add(parent); db.flush()
    v = LimsSubSample(sample_id="ZZTEST-STALE-S01", vial_sequence=0,
                      parent_sample_pk=parent.id, external_lims_uid="zz-vstale")
    db.add(v); db.flush()
    return v


def test_hplc_to_ster_drops_unassigned_analytical_rows(db):
    v = _vial(db)
    analytical_svc = db.execute(
        select(AnalysisService).join(Department, Department.id == AnalysisService.department_id)
        .where(Department.name == "Analytical").limit(1)).scalars().one()
    row = LimsAnalysis(lims_sub_sample_pk=v.id, analysis_service_id=analytical_svc.id,
                       keyword=analytical_svc.keyword, title=analytical_svc.title or analytical_svc.keyword,
                       review_state="unassigned")
    db.add(row); db.flush()
    n = _drop_stale_role_rows(db, sub=v, old_role="hplc", new_role="ster")
    assert n == 1
    remaining = db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().all()
    assert remaining == []


def test_hplc_to_ster_sheds_ungrouped_analyte_row(db):
    """Locks the Handler-approved latent-bug fix: a hplc->ster flip sheds an
    unassigned UNGROUPED ANALYTE-N-* row (department Analytical via Task 1 backfill,
    no service_group_members entry) that the old group-membership query structurally
    missed. Safety triple still applies — only unassigned/no-result/no-retest."""
    analyte = db.execute(
        select(AnalysisService).where(AnalysisService.keyword.like("ANALYTE-%")).limit(1)
    ).scalars().one()
    analytical = db.execute(
        select(Department).where(Department.name == "Analytical")).scalars().one()
    assert analyte.department_id == analytical.id   # Task 1 tagged it Analytical
    v = _vial(db)
    row = LimsAnalysis(
        lims_sub_sample_pk=v.id, analysis_service_id=analyte.id,
        keyword=analyte.keyword, title=analyte.title or analyte.keyword,
        review_state="unassigned")
    db.add(row); db.flush()
    n = _drop_stale_role_rows(db, sub=v, old_role="hplc", new_role="ster")
    assert n == 1
    assert db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sub_sample_pk == v.id)).scalars().all() == []


def test_cleanup_never_touches_rows_with_a_result(db):
    v = _vial(db)
    analytical_svc = db.execute(
        select(AnalysisService).join(Department, Department.id == AnalysisService.department_id)
        .where(Department.name == "Analytical").limit(1)).scalars().one()
    row = LimsAnalysis(lims_sub_sample_pk=v.id, analysis_service_id=analytical_svc.id,
                       keyword=analytical_svc.keyword, title=analytical_svc.title or analytical_svc.keyword,
                       review_state="unassigned", result_value="99.1")
    db.add(row); db.flush()
    n = _drop_stale_role_rows(db, sub=v, old_role="hplc", new_role="ster")
    assert n == 0  # has a result → never deleted
