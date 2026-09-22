"""PCR plate wells and run settings on worksheets (spec 2026-09-22-pcr-worksheet-design).

`plate_no` / `well_pos` freeze a vial's well once the plate is loaded; `bench_config`
holds the run's settings. In-memory SQLite + dependency overrides, no live stack.
"""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from database import Base, get_db
from models import AuditLog, LimsSample, LimsSubSample, Worksheet, WorksheetItem


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
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
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db, roles=("pcr", "ster"), status="open"):
    """One parent, one vial per role, all on one worksheet. Returns (ws, items)."""
    parent = LimsSample(sample_id="P-3001", external_lims_uid="SEN-P-3001",
                        client_order_number="WP-8120", peptide_name="BPC-157")
    db.add(parent)
    db.flush()
    ws = Worksheet(title="PCR 09/22/2026", status=status)
    db.add(ws)
    db.flush()
    items = []
    for n, role in enumerate(roles, start=1):
        sub = LimsSubSample(sample_id=f"P-3001-S0{n}", parent_sample_pk=parent.id,
                            vial_sequence=n, external_lims_uid=f"mk1://pcr-{n}",
                            assignment_role=role)
        db.add(sub)
        item = WorksheetItem(worksheet_id=ws.id, sample_uid=sub.external_lims_uid,
                             sample_id=sub.sample_id, sort_order=n)
        db.add(item)
        items.append(item)
    db.commit()
    return ws, items


def test_ster_vials_are_pcr_work_in_the_bench_log(client, db):
    ws, _ = _seed(db)
    rows = client.get("/worksheets/bench-log?kind=pcr").json()
    assert [r["id"] for r in rows] == [ws.id]
    assert client.get("/worksheets/bench-log?kind=sterility").json() == []


def test_items_carry_their_frozen_well_and_the_worksheet_its_settings(client, db):
    ws, (a, b) = _seed(db)
    a.plate_no, a.well_pos = 1, 3
    db.commit()
    body = client.get(f"/worksheets/{ws.id}").json()
    assert body["bench_config"] is None
    by_id = {it["id"]: it for it in body["items"]}
    assert (by_id[a.id]["plate_no"], by_id[a.id]["well_pos"]) == (1, 3)
    assert (by_id[b.id]["plate_no"], by_id[b.id]["well_pos"]) == (None, None)


def test_put_replaces_bench_config_whole(client, db):
    ws, _ = _seed(db)
    r = client.put(f"/worksheets/{ws.id}",
                   json={"bench_config": {"overage": 1.4, "curve": "Quantitative"}})
    assert r.status_code == 200, r.text
    assert client.get(f"/worksheets/{ws.id}").json()["bench_config"] == {
        "overage": 1.4, "curve": "Quantitative"}
    client.put(f"/worksheets/{ws.id}", json={"bench_config": {"overage": 1.1}})
    assert client.get(f"/worksheets/{ws.id}").json()["bench_config"] == {"overage": 1.1}
    # A title-only update leaves the settings alone.
    client.put(f"/worksheets/{ws.id}", json={"title": "Renamed"})
    assert client.get(f"/worksheets/{ws.id}").json()["bench_config"] == {"overage": 1.1}
