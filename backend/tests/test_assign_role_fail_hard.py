"""Role assignment is atomic with seeding: a seeding failure rolls back the
role flip and propagates."""
import pytest
from sqlalchemy import select

import sub_samples.service as svc
from models import LimsSubSample
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
