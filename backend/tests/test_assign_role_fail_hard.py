"""Role assignment is atomic with seeding: a seeding failure rolls back the
role flip and propagates."""
import pytest
from sqlalchemy import select

import sub_samples.service as svc
import lims_analyses.seeder as seeder_mod
from lims_analyses.seeder import _micro_group_keywords
from models import LimsSubSample, LimsAnalysis, AnalysisService
from database import SessionLocal


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def test_failed_mirror_rolls_back_role(db, monkeypatch):
    sub = db.execute(select(LimsSubSample).limit(1)).scalar_one_or_none()
    if sub is None:
        pytest.skip("no sub-sample available")
    original = sub.assignment_role
    # Ensure seeding is actually attempted (don't depend on the real WP profile).
    monkeypatch.setattr(svc, "_fetch_wp_services_for_parent",
                        lambda pid: {"hplcpurity_identity": True})
    # Force the mirror's SENAITE read to fail.
    monkeypatch.setattr(
        "sub_samples.senaite.fetch_parent_analysis_keywords",
        lambda pid: (_ for _ in ()).throw(RuntimeError("SENAITE down")),
    )
    with pytest.raises(Exception):
        svc.set_assignment_role(db, sub.sample_id, "hplc", user_id=1)
    # Re-read from a fresh session: role must be unchanged (rolled back).
    db2 = SessionLocal()
    try:
        again = db2.execute(
            select(LimsSubSample).where(LimsSubSample.id == sub.id)
        ).scalar_one()
        assert again.assignment_role == original
    finally:
        db2.close()


def _fresh_hplc_keywords(db, sub, n=2):
    """Catalog keywords that would be mirrored onto an HPLC vial: present in the
    Mk1 catalog, NOT in the Microbiology exclude group, and NOT already seeded
    on this vial. Returns up to `n` such keywords (caller skips if too few)."""
    catalog = {
        k for k in db.execute(select(AnalysisService.keyword)).scalars().all() if k
    }
    micro = _micro_group_keywords(db)
    already = set(
        db.execute(
            select(LimsAnalysis.keyword).where(
                LimsAnalysis.lims_sub_sample_pk == sub.id
            )
        ).scalars().all()
    )
    fresh = sorted(catalog - micro - already)
    return fresh[:n]


def test_partial_seed_failure_rolls_back_role(db, monkeypatch):
    """Mid-loop failure: the SENAITE read succeeds and the loop seeds row 1
    successfully, then row 2 raises. Under the OLD per-row-commit code, row 1's
    inner db.commit() would have already committed the role flip + audit event +
    row 1 — leaving a partial analyte set behind a 5xx. Under the commit=False
    fix, nothing is committed until the single outer commit, so the whole unit
    rolls back."""
    sub = db.execute(select(LimsSubSample).limit(1)).scalar_one_or_none()
    if sub is None:
        pytest.skip("no sub-sample available")
    original = sub.assignment_role
    fresh = _fresh_hplc_keywords(db, sub, n=2)
    if len(fresh) < 2:
        pytest.skip("need >=2 fresh (unseeded, non-micro) catalog keywords")

    monkeypatch.setattr(svc, "_fetch_wp_services_for_parent",
                        lambda pid: {"hplcpurity_identity": True})
    # Read succeeds, returns >=2 real catalog keywords so the seed loop runs.
    monkeypatch.setattr("sub_samples.senaite.fetch_parent_analysis_keywords",
                        lambda pid: fresh)
    # Fail the SECOND create_analysis. First one flushes (and, under old code,
    # would have committed). Module-attribute patch so the seeder picks it up.
    real = seeder_mod.la_service.create_analysis
    state = {"n": 0}

    def flaky(*a, **k):
        state["n"] += 1
        if state["n"] >= 2:
            raise RuntimeError("boom on row 2")
        return real(*a, **k)

    monkeypatch.setattr(seeder_mod.la_service, "create_analysis", flaky)

    with pytest.raises(Exception):
        svc.set_assignment_role(db, sub.sample_id, "hplc", user_id=1)

    # Fresh session: role unchanged AND no analysis row for either fresh keyword
    # (no partial commit survived).
    db2 = SessionLocal()
    try:
        again = db2.execute(
            select(LimsSubSample).where(LimsSubSample.id == sub.id)
        ).scalar_one()
        assert again.assignment_role == original
        leaked = db2.execute(
            select(LimsAnalysis.keyword).where(
                LimsAnalysis.lims_sub_sample_pk == sub.id,
                LimsAnalysis.keyword.in_(fresh),
            )
        ).scalars().all()
        assert leaked == [], f"partial seed leaked rows: {leaked}"
    finally:
        db2.close()
