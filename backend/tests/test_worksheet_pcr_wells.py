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


# --- Freezing wells --------------------------------------------------------


def _freeze(client, ws, wells):
    return client.post(f"/worksheets/{ws.id}/freeze-wells", json={"wells": wells})


def test_freeze_pins_unfrozen_items_and_never_moves_a_frozen_one(client, db):
    ws, (a, b) = _seed(db)
    r = _freeze(client, ws, [{"item_id": a.id, "plate_no": 1, "well_pos": 0}])
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "frozen", "frozen": 1}
    db.refresh(a)
    assert (a.plate_no, a.well_pos) == (1, 0)

    # A second layout that would move a onto well 5 leaves it where it was and
    # only pins b. The audit row counts what was pinned.
    r = _freeze(client, ws, [{"item_id": a.id, "plate_no": 1, "well_pos": 5},
                             {"item_id": b.id, "plate_no": 1, "well_pos": 1}])
    assert r.json()["frozen"] == 1
    db.refresh(a)
    db.refresh(b)
    assert (a.plate_no, a.well_pos) == (1, 0)
    assert (b.plate_no, b.well_pos) == (1, 1)
    rows = db.query(AuditLog).filter(AuditLog.operation == "worksheet_wells_frozen").all()
    assert [(r.entity_id, r.details["frozen"], r.details["user_id"]) for r in rows] == [
        (str(ws.id), 1, 1), (str(ws.id), 1, 1)]


def test_freeze_refuses_a_taken_well_and_bad_input(client, db):
    ws, (a, b) = _seed(db)
    _freeze(client, ws, [{"item_id": a.id, "plate_no": 1, "well_pos": 0}])
    r = _freeze(client, ws, [{"item_id": b.id, "plate_no": 1, "well_pos": 0}])
    assert r.status_code == 409
    db.refresh(b)
    assert b.well_pos is None
    assert _freeze(client, ws, [{"item_id": b.id, "plate_no": 0, "well_pos": 0}]).status_code == 400
    assert _freeze(client, ws, [{"item_id": b.id, "plate_no": 1, "well_pos": 48}]).status_code == 400
    assert _freeze(client, ws, [{"item_id": 99999, "plate_no": 1, "well_pos": 2}]).status_code == 404
    # Two new items on the same well in one request: neither lands.
    r = _freeze(client, ws, [{"item_id": b.id, "plate_no": 2, "well_pos": 0},
                             {"item_id": b.id, "plate_no": 2, "well_pos": 0}])
    assert r.status_code == 409
    db.refresh(b)
    assert b.well_pos is None


def test_unfreeze_releases_every_well_once(client, db):
    ws, (a, b) = _seed(db)
    _freeze(client, ws, [{"item_id": a.id, "plate_no": 1, "well_pos": 0},
                         {"item_id": b.id, "plate_no": 1, "well_pos": 1}])
    r = client.delete(f"/worksheets/{ws.id}/frozen-wells")
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "cleared", "cleared": 2}
    db.refresh(a)
    db.refresh(b)
    assert a.well_pos is None and a.plate_no is None and b.well_pos is None
    assert client.delete(f"/worksheets/{ws.id}/frozen-wells").json()["cleared"] == 0
    assert db.query(AuditLog).filter(AuditLog.operation == "worksheet_wells_unfrozen").count() == 1


def test_wells_are_locked_on_a_completed_worksheet(client, db):
    ws, (a, _) = _seed(db, status="completed")
    assert _freeze(client, ws, [{"item_id": a.id, "plate_no": 1, "well_pos": 0}]).status_code == 409
    assert client.delete(f"/worksheets/{ws.id}/frozen-wells").status_code == 409
    assert client.post("/worksheets/99999/freeze-wells", json={"wells": []}).status_code == 404
