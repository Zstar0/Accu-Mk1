"""Starting a vial-scoped HPLC prep moves the order to Analyzing.

HPLC-only native samples never go on a worksheet, so the worksheet routes'
`_notify_worksheet_assigned` (the only native Analyzing trigger) never fired for
them and their orders went Sample Received -> Under Review with no Analyzing
email. Prep start is the first bench signal, so `POST /wizard/sessions` notifies
the IS with the vial's PARENT id. The IS keeps orders forward-only, so a re-prep
or an order already past Analyzing is a no-op there.

Pure unit tests: in-memory SQLite + dependency overrides, no live stack.
"""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main
from main import app
from auth import get_current_user
from database import Base, get_db
from models import CalibrationCurve, LimsSample, LimsSubSample, Peptide


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
def notified(monkeypatch):
    calls: list[str] = []

    async def _record(sample_id):
        calls.append(sample_id)

    monkeypatch.setattr(main, "_notify_worksheet_assigned", _record)
    return calls


@pytest.fixture
def client(db, notified):
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()
    app.dependency_overrides.update(previous)


@pytest.fixture
def vial(db):
    peptide = Peptide(name="BPC-157", abbreviation="BPC157")
    db.add(peptide)
    db.flush()
    db.add(CalibrationCurve(peptide_id=peptide.id, slope=1.0, intercept=0.0,
                            r_squared=0.999, is_active=True))
    parent = LimsSample(sample_id="P-5001", external_lims_system="mk1", external_lims_uid=None)
    db.add(parent)
    db.flush()
    v = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-5001-S01",
                      external_lims_uid="mk1://p5001s01", vial_sequence=1)
    db.add(v)
    db.commit()
    return {"peptide_id": peptide.id, "vial_pk": v.id}


def test_vial_prep_notifies_parent_sample(client, vial, notified):
    # Free-text label on purpose: the parent id must come from the vial row.
    resp = client.post("/wizard/sessions", json={
        "peptide_id": vial["peptide_id"],
        "lims_sub_sample_pk": vial["vial_pk"],
        "sample_id_label": "bench label",
        "target_conc_ug_ml": 500,
        "target_total_vol_ul": 1000,
    })

    assert resp.status_code == 201, resp.text
    assert notified == ["P-5001"]


def test_standard_prep_does_not_notify(client, vial, notified):
    resp = client.post("/wizard/sessions", json={
        "peptide_id": vial["peptide_id"],
        "lims_sub_sample_pk": vial["vial_pk"],
        "is_standard": True,
    })

    assert resp.status_code == 201, resp.text
    assert notified == []
