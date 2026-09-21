"""Guard: the SENAITE-backed remove control must refuse mk1-origin services
instead of proxying a call the Integration Service can never satisfy.

P-2823 (2026-09-18): the lab clicked that trash on MECURY-PPM four times and
got 422 "it may be in a locked state" every time. MECURY-PPM is an mk1-origin
service with no SENAITE analysis object, so the IS existence check failed and
it reported its generic failure. Same TestClient idiom as
tests/test_manage_native_routes.py.
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

import models  # noqa: F401
from main import app
from auth import get_current_user
from database import get_db, Base
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample
from lims_analyses.service import create_analysis


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    user = MagicMock(); user.id = 9; user.role = "admin"; user.email = "t@x"
    app.dependency_overrides[get_current_user] = lambda: user
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def world(db_session):
    """Parent with one 'mk1://' hm vial, one mk1-origin service, one senaite one."""
    db = db_session
    parent = LimsSample(sample_id="G-PARENT", sample_type="x", status="received",
                        external_lims_system="senaite")
    db.add(parent); db.commit(); db.refresh(parent)
    hg = AnalysisService(title="Mercury", keyword="MECURY-PPM", origin="mk1")
    pur = AnalysisService(title="Purity (HPLC)", keyword="HPLC-PUR", origin="senaite")
    db.add_all([hg, pur]); db.commit(); db.refresh(hg); db.refresh(pur)
    vial = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://g-s02",
                         sample_id="G-PARENT-S02", vial_sequence=2, assignment_role="hm")
    db.add(vial); db.commit(); db.refresh(vial)
    return {"parent": parent, "hg": hg, "pur": pur, "vial": vial}


def test_mk1_origin_on_parent_is_refused_and_names_the_native_block(client, world):
    r = client.delete("/explorer/samples/G-PARENT/analyses/MECURY-PPM")
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert "MECURY-PPM is an Accu-Mk1 analysis" in detail
    assert "Native (Accu-Mk1)" in detail


def test_guard_runs_before_the_confirm_retract_write(client, world, db_session):
    """confirm_retract=true rejects worked vial rows. The guard must refuse
    FIRST, or a call that cannot succeed would still have mutated the bench."""
    row = create_analysis(db_session, host_kind="sub_sample", host_pk=world["vial"].id,
                          analysis_service_id=world["hg"].id, keyword="MECURY-PPM",
                          title="Mercury")
    row.review_state = "assigned"; row.result_value = "0.9"; db_session.commit()

    r = client.delete("/explorer/samples/G-PARENT/analyses/MECURY-PPM?confirm_retract=true")
    assert r.status_code == 409, r.text

    db_session.refresh(row)
    assert row.review_state == "assigned", "guard fired too late, the vial row was rejected"


def test_guard_stands_down_on_a_native_vial_page(client, world, db_session):
    """A vial page removes mk1-origin rows legitimately via the native branch."""
    create_analysis(db_session, host_kind="sub_sample", host_pk=world["vial"].id,
                    analysis_service_id=world["hg"].id, keyword="MECURY-PPM", title="Mercury")

    r = client.delete("/explorer/samples/G-PARENT-S02/analyses/MECURY-PPM")
    assert r.status_code == 200, r.text
    assert db_session.execute(
        select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == world["vial"].id)
    ).scalars().first() is None


def test_senaite_origin_service_is_not_intercepted(client, world):
    """HPLC-PUR must fall through to the existing proxy path, not the guard."""
    r = client.delete("/explorer/samples/G-PARENT/analyses/HPLC-PUR")
    assert not (r.status_code == 409 and "Accu-Mk1 analysis" in str(r.json().get("detail", "")))
