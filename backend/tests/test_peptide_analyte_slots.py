"""Tests for the peptide_analytes 4-slot ceiling (S6c, 2026-08-11).

Every SENAITE-shaped surface enumerates Analyte1..Analyte4, so slot is capped
at 4 by product decision (see PeptideAnalyte docstring in models.py). The DB
CHECK (ck_peptide_analyte_slot_range) only exists on tables create_all built
after the constraint was added — the API edge is the reliable gate:
- AnalyteInput.slot is bounded 1-4 (Pydantic validation on manual create/update payloads).
- The blend auto-slot loops (create + update /peptides) raise 400 before
  minting a 5th slot from resolving components.

Fixture mirrors test_analysis_service_routes.py's route_client.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError
from unittest.mock import MagicMock
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app, AnalyteInput
from auth import get_current_user
from database import get_db, Base
from models import AnalysisService, Peptide, PeptideAnalyte


# ─── AnalyteInput bounds (unit-level) ───

def test_analyte_input_slot_5_rejected():
    with pytest.raises(ValidationError):
        AnalyteInput(slot=5, analysis_service_id=1)


def test_analyte_input_slot_0_rejected():
    with pytest.raises(ValidationError):
        AnalyteInput(slot=0, analysis_service_id=1)


@pytest.mark.parametrize("slot", [1, 2, 3, 4])
def test_analyte_input_slot_1_to_4_accepted(slot):
    a = AnalyteInput(slot=slot, analysis_service_id=1)
    assert a.slot == slot


# ─── Blend auto-slot loop (route-level) ───

@pytest.fixture
def route_client():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared_session = Session()

    def _override_get_db():
        yield shared_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, email="tester@example.com")
    tc = TestClient(app)
    tc._test_session = shared_session
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user
    shared_session.close()


def _make_component(db, n: int) -> int:
    """A standalone peptide with a single slot-1 analyte, as the blend loop expects."""
    svc = AnalysisService(title=f"Component {n} Purity", keyword=f"COMP{n}-PURITY", unit="%")
    db.add(svc)
    db.flush()
    comp = Peptide(name=f"Component {n}", abbreviation=f"CMP{n}")
    db.add(comp)
    db.flush()
    db.add(PeptideAnalyte(peptide_id=comp.id, analysis_service_id=svc.id, slot=1))
    db.flush()
    return comp.id


def test_create_blend_five_components_returns_400(route_client):
    db = route_client._test_session
    component_ids = [_make_component(db, n) for n in range(1, 6)]  # 5 components
    db.commit()

    resp = route_client.post(
        "/peptides",
        json={
            "name": "Overfull Blend",
            "abbreviation": "OFB1",
            "is_blend": True,
            "component_ids": component_ids,
        },
    )
    assert resp.status_code == 400
    assert "4-slot ceiling" in resp.json()["detail"]


def test_create_blend_four_components_succeeds(route_client):
    db = route_client._test_session
    component_ids = [_make_component(db, n) for n in range(1, 5)]  # 4 components
    db.commit()

    resp = route_client.post(
        "/peptides",
        json={
            "name": "Full Blend",
            "abbreviation": "FB1",
            "is_blend": True,
            "component_ids": component_ids,
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert len(body["analytes"]) == 4
    assert sorted(a["slot"] for a in body["analytes"]) == [1, 2, 3, 4]


def test_create_blend_five_components_one_unresolved_succeeds(route_client):
    """The ceiling counts slots actually consumed by resolving components, not
    raw component count — a 5th component with no slot-1 analyte of its own
    doesn't mint a slot and so doesn't trip the guard."""
    db = route_client._test_session
    resolving_ids = [_make_component(db, n) for n in range(1, 5)]  # 4 resolving
    unresolved = Peptide(name="Unresolved Component", abbreviation="UNR1")
    db.add(unresolved)
    db.flush()
    component_ids = resolving_ids + [unresolved.id]
    db.commit()

    resp = route_client.post(
        "/peptides",
        json={
            "name": "Mixed Blend",
            "abbreviation": "MXB1",
            "is_blend": True,
            "component_ids": component_ids,
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert sorted(a["slot"] for a in body["analytes"]) == [1, 2, 3, 4]


def test_update_blend_five_components_returns_400(route_client):
    db = route_client._test_session
    component_ids = [_make_component(db, n) for n in range(1, 6)]  # 5 components
    blend = Peptide(name="Growable Blend", abbreviation="GRB1", is_blend=True)
    db.add(blend)
    db.commit()

    resp = route_client.put(
        f"/peptides/{blend.id}",
        json={"component_ids": component_ids},
    )
    assert resp.status_code == 400
    assert "4-slot ceiling" in resp.json()["detail"]
