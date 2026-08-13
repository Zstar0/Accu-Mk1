"""Wire-level tests: department on the add / staging routes (S2 Task 5).

Worksheet items are re-keyed from service groups to departments. `department_id`
wins when present; a legacy group-only payload still works and DERIVES the
department from the group bridge, so every new row stores BOTH keys and old and
new key shapes collide with each other.

The group -> department collapse is many-to-one (Microbiology + Endotoxin both
land on the Microbiology department), so a department-keyed lookup can match two
historical rows: the scope lookup takes the lowest id and logs
`worksheet.item_scope_ambiguous` instead of raising MultipleResultsFound.

Ruled consequence, do not "reconcile" it: the both-None scope is strictly
NARROWER than the legacy `service_group_id IS NULL` filter — a row carrying a
department but no group is no longer a whole-sample claim.

These tests stay at the wire/row level: status code, the stored row's two scope
keys, and the kwargs the stamp call received. Which `lims_analyses` rows the
stamp actually touches is Task 4's contract, covered in
tests/test_worksheet_analyst_stamp.py.

Pure unit tests: in-memory SQLite + dependency overrides, no live stack.
"""
import logging
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
from models import Department, ServiceGroup, Worksheet, WorksheetItem

VIAL_UID = "mk1://21b60840294d4fe6953946f66f8fd68b"
VIAL_SID = "P-0146-S04"


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
def stamp_calls(monkeypatch):
    """Record stamp_for_item kwargs. The routes wrap the stamp in a bare
    `except Exception`, so asserting INSIDE the fake would be swallowed and the
    test would pass vacuously — record here, assert after the response."""
    calls: list[dict] = []

    def _fake_stamp(_db, **kwargs):
        calls.append(kwargs)
        return 0

    monkeypatch.setattr("lims_analyses.worksheet_analyst.stamp_for_item", _fake_stamp)
    return calls


@pytest.fixture
def client(db, monkeypatch):
    async def _no_notify(_sample_id):
        return None

    # NOT inside a try in the routes — a non-awaitable stub would surface as a 500.
    monkeypatch.setattr(main, "_notify_worksheet_assigned", _no_notify)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def catalog(db):
    """Two departments and the three group shapes that matter: two Microbiology
    groups (the many-to-one collapse), one Analytical group, one orphan group
    with no department at all."""
    micro = Department(name="Microbiology", color="green")
    analytical = Department(name="Analytical", color="blue")
    db.add_all([micro, analytical])
    db.flush()
    g_micro = ServiceGroup(name="Microbiology", department_id=micro.id)
    g_endo = ServiceGroup(name="Endotoxin", department_id=micro.id)
    g_hplc = ServiceGroup(name="Core HPLC", department_id=analytical.id)
    g_orphan = ServiceGroup(name="Unmapped", department_id=None)
    db.add_all([g_micro, g_endo, g_hplc, g_orphan])
    db.commit()
    return {
        "micro": micro.id,
        "analytical": analytical.id,
        "g_micro": g_micro.id,
        "g_endo": g_endo.id,
        "g_hplc": g_hplc.id,
        "g_orphan": g_orphan.id,
    }


def _worksheet(db, title="Brandon WS", status="open"):
    ws = Worksheet(title=title, status=status)
    db.add(ws)
    db.commit()
    return ws


def _add(client, ws_id, **payload):
    body = {"sample_uid": VIAL_UID, "sample_id": VIAL_SID}
    body.update(payload)
    return client.post(f"/worksheets/{ws_id}/add-group", json=body)


def _item(db, uid=VIAL_UID):
    return db.query(WorksheetItem).filter_by(sample_uid=uid).order_by(WorksheetItem.id).first()


# ── add-group: the two key shapes ────────────────────────────────────────────

def test_add_with_department_only(client, db, catalog, stamp_calls):
    """A department-only payload creates an item carrying department_id, and the
    stamp path receives the department."""
    ws = _worksheet(db)

    resp = _add(client, ws.id, department_id=catalog["micro"])

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "added"
    item = _item(db)
    assert item is not None
    assert item.department_id == catalog["micro"]
    assert item.service_group_id is None
    assert len(stamp_calls) == 1
    assert stamp_calls[0]["department_id"] == catalog["micro"]
    assert stamp_calls[0]["service_group_id"] is None


def test_add_with_group_only_derives_department(client, db, catalog, stamp_calls):
    """The legacy FE payload (group only) still works AND the stored item gets
    department_id derived from the group bridge — rollback compatibility."""
    ws = _worksheet(db)

    resp = _add(client, ws.id, service_group_id=catalog["g_endo"])

    assert resp.status_code == 200, resp.text
    item = _item(db)
    assert item.service_group_id == catalog["g_endo"]
    assert item.department_id == catalog["micro"], "department must derive from the group bridge"
    assert stamp_calls[0]["department_id"] == catalog["micro"]
    assert stamp_calls[0]["service_group_id"] == catalog["g_endo"]


def test_add_with_unmapped_group_keeps_group_scope(client, db, catalog, stamp_calls):
    """A group with no department bridges to nothing: the item keeps the legacy
    group-only scope rather than inventing a department."""
    ws = _worksheet(db)

    resp = _add(client, ws.id, service_group_id=catalog["g_orphan"])

    assert resp.status_code == 200, resp.text
    item = _item(db)
    assert item.service_group_id == catalog["g_orphan"]
    assert item.department_id is None
    assert stamp_calls[0]["department_id"] is None


def test_add_both_disagreeing_is_400(client, db, catalog, stamp_calls):
    """Department and group that map to different departments is a caller bug,
    not something to silently resolve."""
    ws = _worksheet(db)

    resp = _add(
        client, ws.id,
        department_id=catalog["analytical"],
        service_group_id=catalog["g_micro"],
    )

    assert resp.status_code == 400, resp.text
    assert "disagree" in resp.json()["detail"]
    assert db.query(WorksheetItem).count() == 0
    assert stamp_calls == []


def test_add_both_agreeing_is_accepted(client, db, catalog):
    """Both keys pointing at the same department is the post-Task-10 FE payload."""
    ws = _worksheet(db)

    resp = _add(
        client, ws.id,
        department_id=catalog["micro"],
        service_group_id=catalog["g_micro"],
    )

    assert resp.status_code == 200, resp.text
    item = _item(db)
    assert item.department_id == catalog["micro"]
    assert item.service_group_id == catalog["g_micro"]


def test_disagreement_does_not_preempt_the_404(client, db, catalog):
    """An unknown worksheet still 404s — the precedence check must not jump the
    worksheet lookup."""
    resp = _add(
        client, 999999,
        department_id=catalog["analytical"],
        service_group_id=catalog["g_micro"],
    )
    assert resp.status_code == 404


# ── collision guard across key shapes ────────────────────────────────────────

def test_collision_guard_matches_across_key_shapes(client, db, catalog, stamp_calls):
    """An item added by group (deriving Microbiology) collides with a later add
    of the same vial sent by department — the scope filter bridges old and new
    key shapes."""
    ws_a = _worksheet(db, title="Brandon WS")
    ws_b = _worksheet(db, title="Patrick WS")
    assert _add(client, ws_a.id, service_group_id=catalog["g_micro"]).status_code == 200

    other = _add(client, ws_b.id, department_id=catalog["micro"])
    assert other.status_code == 409, other.text
    assert "Brandon WS" in other.json()["detail"]

    same = _add(client, ws_a.id, department_id=catalog["micro"])
    assert same.status_code == 200, same.text
    assert same.json()["status"] == "already_exists"
    assert db.query(WorksheetItem).count() == 1


def test_ambiguous_scope_resolves_first_with_warning(client, db, catalog, caplog):
    """Two historical items (Microbiology group + Endotoxin group, same vial,
    both backfilled to the Microbiology department) — a department-keyed lookup
    takes the lowest id and warns; no MultipleResultsFound."""
    ws = _worksheet(db)
    older = WorksheetItem(
        worksheet_id=ws.id, sample_uid=VIAL_UID, sample_id=VIAL_SID,
        service_group_id=catalog["g_micro"], department_id=catalog["micro"],
    )
    newer = WorksheetItem(
        worksheet_id=ws.id, sample_uid=VIAL_UID, sample_id=VIAL_SID,
        service_group_id=catalog["g_endo"], department_id=catalog["micro"],
    )
    db.add_all([older, newer])
    db.commit()
    older_id = older.id

    with caplog.at_level(logging.WARNING, logger="main"):
        resp = _add(client, ws.id, department_id=catalog["micro"])

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "already_exists", "item_id": older_id}
    assert "worksheet.item_scope_ambiguous" in caplog.text


# ── create-from-drop ─────────────────────────────────────────────────────────

def test_create_from_drop_stores_both_keys(client, db, catalog, stamp_calls):
    resp = client.post(
        "/worksheets/create-from-drop",
        json={
            "sample_uid": VIAL_UID,
            "sample_id": VIAL_SID,
            "service_group_id": catalog["g_endo"],
        },
    )

    assert resp.status_code == 200, resp.text
    item = _item(db)
    assert item.service_group_id == catalog["g_endo"]
    assert item.department_id == catalog["micro"]
    assert stamp_calls[0]["department_id"] == catalog["micro"]


def test_create_from_drop_collides_with_department_keyed_item(client, db, catalog):
    ws = _worksheet(db, title="Brandon WS")
    db.add(WorksheetItem(
        worksheet_id=ws.id, sample_uid=VIAL_UID, sample_id=VIAL_SID,
        department_id=catalog["micro"], service_group_id=None,
    ))
    db.commit()

    resp = client.post(
        "/worksheets/create-from-drop",
        json={
            "sample_uid": VIAL_UID,
            "sample_id": VIAL_SID,
            "service_group_id": catalog["g_micro"],
        },
    )

    assert resp.status_code == 409, resp.text
    assert "Brandon WS" in resp.json()["detail"]


# ── bulk inbox staging ───────────────────────────────────────────────────────

def test_bulk_staging_accepts_department_and_stores_both(client, db, catalog):
    resp = client.put(
        "/worksheets/inbox/bulk",
        json={
            "sample_uids": [VIAL_UID],
            "department_id": catalog["micro"],
            "analyst_id": 1,
        },
    )

    assert resp.status_code == 200, resp.text
    item = _item(db)
    assert item.department_id == catalog["micro"]
    assert item.service_group_id is None
    assert item.assigned_analyst_id == 1


def test_bulk_staging_group_payload_derives_department(client, db, catalog):
    resp = client.put(
        "/worksheets/inbox/bulk",
        json={
            "sample_uids": [VIAL_UID],
            "service_group_id": catalog["g_endo"],
            "analyst_id": 1,
        },
    )

    assert resp.status_code == 200, resp.text
    item = _item(db)
    assert item.service_group_id == catalog["g_endo"]
    assert item.department_id == catalog["micro"]


def test_bulk_staging_requires_one_scope_key(client, db, catalog):
    resp = client.put(
        "/worksheets/inbox/bulk",
        json={"sample_uids": [VIAL_UID], "analyst_id": 1},
    )

    assert resp.status_code == 400, resp.text
    assert "department_id" in resp.json()["detail"]
    assert db.query(WorksheetItem).count() == 0


def test_bulk_staging_updates_existing_row_across_key_shapes(client, db, catalog):
    """A staging row written by the legacy group payload is UPDATED — not
    duplicated — by a later department-keyed bulk edit of the same vial."""
    assert client.put(
        "/worksheets/inbox/bulk",
        json={
            "sample_uids": [VIAL_UID],
            "service_group_id": catalog["g_micro"],
            "analyst_id": 1,
        },
    ).status_code == 200

    resp = client.put(
        "/worksheets/inbox/bulk",
        json={
            "sample_uids": [VIAL_UID],
            "department_id": catalog["micro"],
            "instrument_uid": "HPLC-7",
        },
    )

    assert resp.status_code == 200, resp.text
    assert db.query(WorksheetItem).count() == 1
    item = _item(db)
    assert item.instrument_uid == "HPLC-7"
    assert item.assigned_analyst_id == 1


def test_staging_pickup_bridges_key_shapes(client, db, catalog, stamp_calls):
    """A staging pre-assignment made by department is picked up by a legacy
    group-keyed add (which derives that same department) and consumed."""
    assert client.put(
        "/worksheets/inbox/bulk",
        json={
            "sample_uids": [VIAL_UID],
            "department_id": catalog["micro"],
            "analyst_id": 7,
            "instrument_uid": "HPLC-7",
        },
    ).status_code == 200
    ws = _worksheet(db)

    resp = _add(client, ws.id, service_group_id=catalog["g_endo"])

    assert resp.status_code == 200, resp.text
    assert db.query(WorksheetItem).count() == 1, "the staging row must be consumed"
    item = _item(db)
    assert item.worksheet_id == ws.id
    assert item.assigned_analyst_id == 7
    assert item.instrument_uid == "HPLC-7"
