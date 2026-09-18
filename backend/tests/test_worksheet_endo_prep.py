"""Endotoxin bench prep on worksheet items (spec 2026-09-18-endo-worksheet-design).

Three analyst overrides (`prep_weight_mg`, `prep_volume_ml`, `prep_dilution_factor`)
land on `worksheet_items` through the existing item PATCH, and the worksheet GET
carries the parent-sample facts the bench computes from (declared weight, sample
type, order number, identity). In-memory SQLite + dependency overrides, no live stack.
"""
import json
from datetime import datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from database import Base, get_db
from models import Department, LimsSample, LimsSubSample, Worksheet, WorksheetItem


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
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db, *, vial=True):
    micro = Department(name="Microbiology")
    db.add(micro)
    db.flush()
    parent = LimsSample(
        sample_id="P-2995",
        external_lims_uid="SEN-P-2995",
        declared_total_quantity="10.00",
        sample_type_title="Peptide",
        client_order_number="WP-7536",
        # Positional analyte slots, the shape sub_samples/service.py writes.
        analytes=json.dumps([{"name": "MOTS-c", "declared_quantity": None}]),
        date_received=datetime(2026, 9, 17, 16, 30),
    )
    db.add(parent)
    db.flush()
    sub = None
    if vial:
        sub = LimsSubSample(
            sample_id="P-2995-S02",
            parent_sample_pk=parent.id,
            vial_sequence=2,
            external_lims_uid="mk1://endo-1",
            assignment_role="endo85",
        )
        db.add(sub)
        db.flush()
    ws = Worksheet(title="Endo 09/17/2026", status="open")
    db.add(ws)
    db.flush()
    item = WorksheetItem(
        worksheet_id=ws.id,
        sample_uid=sub.external_lims_uid if sub else parent.external_lims_uid,
        sample_id=sub.sample_id if sub else parent.sample_id,
        department_id=micro.id,
    )
    db.add(item)
    db.commit()
    return ws, item


def test_patch_sets_and_clears_prep_overrides(client, db):
    ws, item = _seed(db)
    r = client.patch(
        f"/worksheets/{ws.id}/items/{item.id}",
        json={"prep_weight_mg": 30, "prep_volume_ml": 2, "prep_dilution_factor": 40},
    )
    assert r.status_code == 200, r.text
    db.refresh(item)
    assert (item.prep_weight_mg, item.prep_volume_ml, item.prep_dilution_factor) == (30, 2, 40)

    # Explicit null clears; an omitted field is untouched.
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"prep_volume_ml": None})
    assert r.status_code == 200, r.text
    db.refresh(item)
    assert item.prep_volume_ml is None
    assert item.prep_weight_mg == 30


def test_patch_rejects_non_positive_override(client, db):
    ws, item = _seed(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"prep_weight_mg": 0})
    assert r.status_code == 400
    db.refresh(item)
    assert item.prep_weight_mg is None


def test_get_worksheet_carries_parent_facts_for_vial_item(client, db):
    ws, item = _seed(db)
    client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"prep_volume_ml": 2})
    body = client.get(f"/worksheets/{ws.id}").json()
    it = body["items"][0]
    assert it["declared_weight_mg"] == 10.0
    assert it["sample_type"] == "Peptide"
    assert it["client_order_number"] == "WP-7536"
    assert it["sample_identity"] == "MOTS-c"
    assert it["prep_volume_ml"] == 2
    assert it["prep_weight_mg"] is None
    assert it["prep_dilution_factor"] is None


def test_get_worksheet_resolves_parent_sample_item(client, db):
    # Legacy "<order> E" worksheets hold bare P-XXXX ids, not vial ids.
    ws, item = _seed(db, vial=False)
    it = client.get(f"/worksheets/{ws.id}").json()["items"][0]
    assert it["declared_weight_mg"] == 10.0
    assert it["sample_identity"] == "MOTS-c"
    assert it["client_order_number"] == "WP-7536"


def test_list_worksheets_item_without_parent_is_none_safe(client, db):
    micro = Department(name="Microbiology")
    db.add(micro)
    db.flush()
    ws = Worksheet(title="Orphan", status="open")
    db.add(ws)
    db.flush()
    db.add(WorksheetItem(worksheet_id=ws.id, sample_uid="SEN-nowhere", sample_id="P-0000",
                         department_id=micro.id))
    db.commit()
    it = client.get("/worksheets").json()[0]["items"][0]
    assert it["declared_weight_mg"] is None
    assert it["sample_identity"] is None
    assert it["sample_type"] is None


# --- Bench ticks (Made / ran on the MCS), target override, run log ----------


def test_made_tick_stamps_who_and_when_and_logs_it(client, db):
    from models import AuditLog

    ws, item = _seed(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"made": True})
    assert r.status_code == 200, r.text
    db.refresh(item)
    assert item.made_at is not None
    assert item.made_by_user_id == 1
    assert item.prep_status == "in_progress"

    it = client.get(f"/worksheets/{ws.id}").json()["items"][0]
    assert it["made_at"].endswith("Z")
    assert it["made_by_user_id"] == 1
    assert it["ran_at"] is None

    # Ticking again keeps the first stamp; unticking clears it. Both clicks
    # that changed something are in the audit log, so the who/when of a tick
    # that was later undone is not lost.
    first = item.made_at
    client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"made": True})
    db.refresh(item)
    assert item.made_at == first
    client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"made": False})
    db.refresh(item)
    assert item.made_at is None and item.made_by_user_id is None
    assert item.prep_status == "ready"
    ops = [
        (a.operation, a.details["user_id"])
        for a in db.query(AuditLog).filter(AuditLog.entity_type == "worksheet_item").all()
    ]
    assert ops == [("bench_made_set", 1), ("bench_made_cleared", 1)]


def test_ran_tick_completes_the_item(client, db):
    ws, item = _seed(db)
    client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"made": True, "ran": True})
    db.refresh(item)
    assert item.ran_at is not None and item.ran_by_user_id == 1
    assert item.prep_status == "complete"
    client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"ran": False})
    db.refresh(item)
    assert item.prep_status == "in_progress"


def test_target_override_sets_and_clears(client, db):
    ws, item = _seed(db)
    client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"prep_target_mg_ml": 0.5})
    assert client.get(f"/worksheets/{ws.id}").json()["items"][0]["prep_target_mg_ml"] == 0.5
    client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"prep_target_mg_ml": None})
    assert client.get(f"/worksheets/{ws.id}").json()["items"][0]["prep_target_mg_ml"] is None
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"prep_target_mg_ml": 0})
    assert r.status_code == 400


def test_bench_log_lists_endo_only_worksheets_with_tick_counts(client, db):
    ws, item = _seed(db)
    client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"made": True})
    # A mixed worksheet (one endo vial, one bare parent id) is not an endo run.
    mixed = Worksheet(title="Mixed micro", status="open")
    db.add(mixed)
    db.flush()
    db.add(LimsSubSample(sample_id="P-2995-S03", parent_sample_pk=1, vial_sequence=3,
                         external_lims_uid="mk1://endo-2", assignment_role="endo85"))
    db.add(WorksheetItem(worksheet_id=mixed.id, sample_uid="mk1://endo-2", sample_id="P-2995-S03"))
    db.add(WorksheetItem(worksheet_id=mixed.id, sample_uid="SEN-x", sample_id="P-0001"))
    db.add(Worksheet(title="Empty", status="open"))
    db.commit()

    rows = client.get("/worksheets/bench-log?kind=endo").json()
    assert [r["id"] for r in rows] == [ws.id]
    assert rows[0]["title"] == "Endo 09/17/2026"
    assert rows[0]["item_count"] == 1
    assert rows[0]["made_count"] == 1
    assert rows[0]["ran_count"] == 0
    assert client.get("/worksheets/bench-log?kind=nope").status_code == 400
