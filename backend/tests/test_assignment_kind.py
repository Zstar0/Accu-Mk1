"""assignment_kind column: stored, serialized, defaults NULL. Live DB; ZZTEST fixtures."""
from datetime import datetime
import pytest
from sqlalchemy import text
from database import SessionLocal
from models import LimsSample, LimsSubSample
from sub_samples import service as sub_service
from lims_analyses.service import BadRequestError


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback(); s.close()


@pytest.fixture()
def fixture(db):
    parent = LimsSample(sample_id="ZZTEST-AK", peptide_name="ZZ", status="received", assignment_role="hplc")
    db.add(parent); db.flush()
    db.add(LimsSubSample(sample_id="ZZTEST-AK-S01", parent_sample_pk=parent.id, vial_sequence=1,
                         received_at=datetime.utcnow(), assignment_role="hplc",
                         external_lims_uid="zz-ak-s01", assignment_kind="variance"))
    db.commit()
    yield
    db.rollback()
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-AK%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-AK%'"))
    db.commit()


def test_assignment_kind_round_trips(db, fixture):
    sub = db.execute(text("SELECT assignment_kind FROM lims_sub_samples WHERE sample_id='ZZTEST-AK-S01'")).scalar_one()
    assert sub == "variance"


def test_assignment_kind_serializes_through_api_path(db, fixture):
    """_serialize is the real API constructor (routes.py builds every
    SubSampleResponse manually) — raw SQL tests alone would miss an
    omitted field because of the schema's None default."""
    from sub_samples.routes import _serialize
    sub = db.query(LimsSubSample).filter(LimsSubSample.sample_id == "ZZTEST-AK-S01").one()
    assert _serialize(sub).assignment_kind == "variance"


def test_assignment_kind_defaults_null(db, fixture):
    db.execute(text("INSERT INTO lims_sub_samples (sample_id, parent_sample_pk, vial_sequence, received_at, external_lims_uid) "
                    "SELECT 'ZZTEST-AK-S02', id, 2, now(), 'zz-ak-s02' FROM lims_samples WHERE sample_id='ZZTEST-AK'"))
    db.commit()
    k = db.execute(text("SELECT assignment_kind FROM lims_sub_samples WHERE sample_id='ZZTEST-AK-S02'")).scalar_one()
    assert k is None


def test_set_assignment_role_sets_kind(db, fixture):
    sub_service.set_assignment_role(db, "ZZTEST-AK-S01", "hplc", kind="core")
    k = db.execute(text("SELECT assignment_kind FROM lims_sub_samples WHERE sample_id='ZZTEST-AK-S01'")).scalar_one()
    assert k == "core"


def test_set_assignment_rejects_bad_kind(db, fixture):
    with pytest.raises(ValueError):
        sub_service.set_assignment_role(db, "ZZTEST-AK-S01", "hplc", kind="bogus")


def test_reassignment_blocked_when_variance_locked(db, fixture):
    db.execute(text("UPDATE lims_samples SET variance_locked_at = now() WHERE sample_id='ZZTEST-AK'"))
    db.commit()
    with pytest.raises(BadRequestError):
        sub_service.set_assignment_role(db, "ZZTEST-AK-S01", "endo", kind="core")
