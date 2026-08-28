"""Additive per-row `sla` context on GET /sample-preps (v1.11.1).

The Sample Preps page gained the shared SLA column; the list rows come from
the raw mk1_db table which carries no received date / priority / keywords,
so the endpoint batch-resolves an `sla` block per row from the lims tables:
vial link preferred (row's lims_sub_sample_pk, then senaite_sample_id as a
vial id), parent fallback (senaite_sample_id as a parent id, no keywords),
unlinked rows get NO block. Enrichment is fail-open — a lims outage must
not take down the preps list.
"""
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db
from main import app
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    SamplePriority,
)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, role="admin")
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _seed_vial_world(db):
    parent = LimsSample(
        sample_id="P-9001", external_lims_uid="uid-parent-9001",
        date_received=datetime(2026, 8, 20, 9, 0, 0),
    )
    db.add(parent); db.flush()
    vial = LimsSubSample(
        sample_id="P-9001-S01", external_lims_uid="uid-vial-9001-s01",
        parent_sample_pk=parent.id, vial_sequence=1,
        received_at=datetime(2026, 8, 24, 12, 12, 0),
    )
    db.add(vial); db.flush()
    svc = AnalysisService(title="Sterility USP71", keyword="STER-USP71", department_id=None)
    db.add(svc); db.flush()
    db.add(LimsAnalysis(
        lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
        keyword="STER-USP71", title="Sterility USP71", review_state="unassigned",
    ))
    db.add(SamplePriority(sample_uid="uid-vial-9001-s01", priority="high"))
    db.commit()
    return parent, vial


def _prep_row(**over):
    row = {
        "id": 1, "sample_id": "SP-20260827-0001", "senaite_sample_id": None,
        "lims_sub_sample_pk": None, "status": "awaiting_hplc",
        "created_at": datetime(2026, 8, 27, 10, 0, 0),
        "updated_at": datetime(2026, 8, 27, 10, 0, 0),
    }
    row.update(over)
    return row


def test_vial_linked_prep_gets_full_sla_block(client, db):
    """Row linked by lims_sub_sample_pk: vial received date, vial-uid priority,
    live keywords ride the block (the profile step's input on the FE)."""
    _, vial = _seed_vial_world(db)
    with patch("mk1_db.ensure_sample_preps_table"), \
         patch("mk1_db.list_sample_preps", return_value=[
             _prep_row(senaite_sample_id="P-9001", lims_sub_sample_pk=vial.id),
         ]):
        r = client.get("/sample-preps")
    assert r.status_code == 200
    sla = r.json()[0]["sla"]
    assert sla["received_at"].startswith("2026-08-24T12:12:00")
    assert sla["priority"] == "high"
    assert sla["keywords"] == ["STER-USP71"]


def test_parent_only_prep_falls_back_to_parent_dates(client, db):
    """Legacy whole-sample prep (parent id, no vial pk): parent date_received,
    normal priority, no keywords (SENAITE-era analyses aren't native rows)."""
    _seed_vial_world(db)
    with patch("mk1_db.ensure_sample_preps_table"), \
         patch("mk1_db.list_sample_preps", return_value=[
             _prep_row(senaite_sample_id="P-9001"),
         ]):
        r = client.get("/sample-preps")
    assert r.status_code == 200
    sla = r.json()[0]["sla"]
    assert sla["received_at"].startswith("2026-08-20T09:00:00")
    assert sla["priority"] == "normal"
    assert sla["keywords"] == []
    assert sla["department_id"] is None


def test_unlinked_prep_gets_no_sla_block(client, db):
    with patch("mk1_db.ensure_sample_preps_table"), \
         patch("mk1_db.list_sample_preps", return_value=[
             _prep_row(senaite_sample_id="ZZ-NOPE"),
         ]):
        r = client.get("/sample-preps")
    assert r.status_code == 200
    assert "sla" not in r.json()[0]


def test_enrichment_failure_is_fail_open(client, db):
    """A lims-side error must not 500 the preps list — rows come back
    without `sla` (the FE renders the indicator's none state)."""
    with patch("mk1_db.ensure_sample_preps_table"), \
         patch("mk1_db.list_sample_preps", return_value=[
             _prep_row(senaite_sample_id="P-9001"),
         ]), \
         patch("main._attach_prep_sla", side_effect=RuntimeError("lims down")):
        r = client.get("/sample-preps")
    assert r.status_code == 200
    assert "sla" not in r.json()[0]
