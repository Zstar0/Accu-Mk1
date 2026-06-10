"""Role re-assignment drops the previous role's unassigned rows (Microbiology
leftover on an HPLC vial). Throwaway vial; no live-DB pollution.

set_assignment_role commits internally (sub_samples/service.py), so the throwaway
parent/vial/rows are persisted past the fixture rollback. The test therefore
tears down its own ZZTEST-ROLECLEAN rows explicitly at the end and asserts none
remain.
"""
import pytest
from sqlalchemy import select, delete
from database import SessionLocal
import sub_samples.service as svc
from models import (
    LimsAnalysis,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
    LimsSubSampleEvent,
)


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _throwaway_vial(db):
    parent = LimsSample(sample_id="ZZTEST-ROLECLEAN", external_lims_uid="zz-uid-roleclean")
    db.add(parent)
    db.flush()
    v = LimsSubSample(sample_id="ZZTEST-ROLECLEAN-S01", vial_sequence=0,
                      parent_sample_pk=parent.id, external_lims_uid="zz-vuid-roleclean")
    db.add(v)
    db.flush()
    return v


def _cleanup_zztest(db):
    """Delete every ZZTEST-ROLECLEAN row this test could have committed."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == "ZZTEST-ROLECLEAN")
    ).scalar_one_or_none()
    subs = db.execute(
        select(LimsSubSample).where(LimsSubSample.sample_id.like("ZZTEST-ROLECLEAN%"))
    ).scalars().all()
    sub_ids = [s.id for s in subs]
    if sub_ids:
        analysis_ids = db.execute(
            select(LimsAnalysis.id).where(LimsAnalysis.lims_sub_sample_pk.in_(sub_ids))
        ).scalars().all()
        if analysis_ids:
            db.execute(delete(LimsAnalysisTransition).where(
                LimsAnalysisTransition.analysis_id.in_(analysis_ids)))
            db.execute(delete(LimsAnalysis).where(LimsAnalysis.id.in_(analysis_ids)))
        db.execute(delete(LimsSubSampleEvent).where(
            LimsSubSampleEvent.sub_sample_pk.in_(sub_ids)))
        db.execute(delete(LimsSubSample).where(LimsSubSample.id.in_(sub_ids)))
    if parent is not None:
        db.execute(delete(LimsSample).where(LimsSample.id == parent.id))
    db.commit()


def test_role_change_drops_old_role_unassigned_rows(db, monkeypatch):
    try:
        vial = _throwaway_vial(db)
        vial_pk = vial.id

        # Assign ster -> seeds STER-PCR (Microbiology). The parent isn't in
        # SENAITE, so force the WP profile that gates ster seeding.
        monkeypatch.setattr(svc, "_fetch_wp_services_for_parent",
                            lambda pid: {"sterility_pcr": True})
        svc.set_assignment_role(db, vial.sample_id, "ster", user_id=1)
        kws = set(db.execute(select(LimsAnalysis.keyword).where(
            LimsAnalysis.lims_sub_sample_pk == vial_pk)).scalars().all())
        assert "STER-PCR" in kws

        # Now re-assign hplc. The hplc mirror reads SENAITE — monkeypatch it to a
        # small Analytics set so the test is deterministic and offline.
        monkeypatch.setattr("sub_samples.senaite.fetch_parent_analysis_keywords",
                            lambda pid: ["HPLC-ID", "BLEND-PUR"])
        monkeypatch.setattr("sub_samples.senaite.fetch_parent_analyte_slots", lambda pid: {})
        # _fetch_wp_services_for_parent also hits SENAITE; force hplc seeding.
        monkeypatch.setattr(svc, "_fetch_wp_services_for_parent",
                            lambda pid: {"hplcpurity_identity": True})
        svc.set_assignment_role(db, vial.sample_id, "hplc", user_id=1)
        kws2 = set(db.execute(select(LimsAnalysis.keyword).where(
            LimsAnalysis.lims_sub_sample_pk == vial_pk)).scalars().all())
        assert "STER-PCR" not in kws2           # stale Microbiology row dropped
        assert {"HPLC-ID", "BLEND-PUR"} <= kws2  # hplc set present
    finally:
        _cleanup_zztest(db)
        remaining = db.execute(select(LimsSubSample.id).where(
            LimsSubSample.sample_id.like("ZZTEST-ROLECLEAN%"))).scalars().all()
        assert remaining == []
