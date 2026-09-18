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
