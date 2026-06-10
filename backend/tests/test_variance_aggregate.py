"""Aggregates endpoint surfaces a per-parent variance bucket map (read directly
from lims_samples.variance_override). Service test runs against the LIVE
accumark_mk1 DB: ZZTEST-AGGV fixtures with explicit teardown."""
from datetime import datetime

import pytest
from sqlalchemy import text

from database import SessionLocal
from sub_samples import service as sub_service
from models import LimsSample, LimsSubSample


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _make_parent(db, sample_id, override):
    parent = LimsSample(
        sample_id=sample_id, peptide_name="ZZ Agg", status="received",
        assignment_role="hplc", variance_override=override,
    )
    db.add(parent)
    db.flush()
    db.add(LimsSubSample(
        sample_id=f"{sample_id}-S01", parent_sample_pk=parent.id,
        vial_sequence=1, received_at=datetime.utcnow(), assignment_role="hplc",
        external_lims_uid=f"zz-uid-aggv-{sample_id}-s01",
    ))
    db.commit()


@pytest.fixture()
def aggv_fixture(db):
    _make_parent(db, "ZZTEST-AGGV-ON", '{"hplcpurity_identity": 2}')
    _make_parent(db, "ZZTEST-AGGV-OFF", None)
    yield
    db.rollback()
    db.execute(text("DELETE FROM lims_sub_samples WHERE sample_id LIKE 'ZZTEST-AGGV%'"))
    db.execute(text("DELETE FROM lims_samples WHERE sample_id LIKE 'ZZTEST-AGGV%'"))
    db.commit()


def test_variance_map_reflects_override(db, aggv_fixture):
    out = sub_service.aggregate_by_parent(db, ["ZZTEST-AGGV-ON", "ZZTEST-AGGV-OFF"])
    assert out["ZZTEST-AGGV-ON"]["variance"] == {"hplc": 2, "endo": 0, "ster": 0}
    assert out["ZZTEST-AGGV-OFF"]["variance"] == {"hplc": 0, "endo": 0, "ster": 0}


def test_zztest_cleaned(db):
    n = db.execute(text(
        "SELECT count(*) FROM lims_samples WHERE sample_id LIKE 'ZZTEST-AGGV%'"
    )).scalar_one()
    assert n == 0
