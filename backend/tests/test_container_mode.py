"""container_mode: stored, set at creation, serialized. Live DB; ZZTEST fixtures."""
from datetime import datetime

import pytest
from sqlalchemy import text

from database import SessionLocal
from models import LimsSample, LimsSubSample
from sub_samples import service as sub_service


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture()
def cleanup(db):
    yield
    db.rollback()
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-CM%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-CM%'"))
    db.commit()


def test_container_mode_defaults_false_for_existing_rows(db, cleanup):
    # Raw INSERT bypasses the ORM default — proves the DB-level default that
    # legacy rows rely on.
    db.execute(text(
        "INSERT INTO lims_samples (sample_id, status) VALUES ('ZZTEST-CM-LEGACY', 'received')"))
    db.commit()
    v = db.execute(text(
        "SELECT container_mode FROM lims_samples WHERE sample_id='ZZTEST-CM-LEGACY'")).scalar_one()
    assert v is False


def test_ensure_sample_row_creates_container_parent(db, cleanup, monkeypatch):
    # ensure_sample_row is the single parent-creation path — new parents are containers.
    monkeypatch.setattr(sub_service.senaite, "fetch_parent_metadata", lambda sid: {
        "uid": "zz-cm-uid", "review_state": "received"})
    row = sub_service.ensure_sample_row(db, "ZZTEST-CM-NEW")
    db.commit()
    assert row.container_mode is True


def test_parent_summary_serializes_container_mode(db, cleanup):
    parent = LimsSample(sample_id="ZZTEST-CM-SER", status="received", container_mode=True)
    db.add(parent)
    db.commit()
    from sub_samples.schemas import ParentSampleSummary
    s = ParentSampleSummary(
        sample_id=parent.sample_id, external_lims_uid=None, peptide_name=None,
        status=parent.status, sub_sample_count=0, last_synced_at=datetime.utcnow(),
        container_mode=parent.container_mode,
    )
    assert s.container_mode is True
