"""Registry-sourced inbox candidates (read-source 'mk1' for /worksheets/inbox).

Adapter tests use the shared in-memory db_session fixture; the route test
builds its own StaticPool session (TestClient crosses threads) and blanks
SENAITE_URL to prove the mk1 source needs no SENAITE at all — that IS the
feature.
"""
from __future__ import annotations

import json
from datetime import datetime

import pytest
from unittest.mock import MagicMock
from fastapi.testclient import TestClient

import main as main_module
from main import app
from auth import get_current_user
from models import AnalysisService, LimsAnalysis, LimsSample
from sub_samples.registry_inbox import inbox_candidates_from_registry


def _seed_service(db, keyword="HPLC-PUR", title="Purity"):
    svc = AnalysisService(title=title, keyword=keyword)
    db.add(svc)
    db.flush()
    return svc


def _seed_parent(db, sample_id="TEST-RINB-001", status="sample_received", **kw):
    row = LimsSample(
        sample_id=sample_id,
        external_lims_uid=kw.pop("uid", f"uid-{sample_id}"),
        status=status,
        sample_type="x",
        client_title=kw.pop("client_title", "Test Client"),
        client_order_number=kw.pop("client_order_number", "WP-9999"),
        date_received=kw.pop("date_received", datetime(2026, 7, 13, 12, 0, 0)),
        date_created=kw.pop("date_created", datetime(2026, 7, 13, 12, 0, 0)),
        analytes=kw.pop("analytes", None),
        assignment_role=kw.pop("assignment_role", "hplc"),
    )
    db.add(row)
    db.flush()
    return row


def test_only_sample_received_parents_emitted(db_session):
    _seed_parent(db_session, "TEST-RINB-001", status="sample_received")
    _seed_parent(db_session, "TEST-RINB-002", status="published")
    items, analyses = inbox_candidates_from_registry(db_session)
    ids = [it["id"] for it in items]
    assert "TEST-RINB-001" in ids
    assert "TEST-RINB-002" not in ids


def test_item_carries_senaite_brain_keys(db_session):
    _seed_parent(
        db_session, "TEST-RINB-003",
        analytes=json.dumps([
            {"name": "KPV - Identity (HPLC)", "declared_quantity": "1"},
            {"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "2"},
        ]),
    )
    items, _ = inbox_candidates_from_registry(db_session)
    it = next(i for i in items if i["id"] == "TEST-RINB-003")
    assert it["uid"] == "uid-TEST-RINB-003"
    assert it["title"] == "TEST-RINB-003"
    assert it["review_state"] == "sample_received"
    assert it["getClientTitle"] == "Test Client"
    assert it["getClientOrderNumber"] == "WP-9999"
    assert it["getDateReceived"].startswith("2026-07-13")
    assert it["Analyte1Peptide"] == "KPV - Identity (HPLC)"
    assert it["Analyte2Peptide"] == "BPC-157 - Identity (HPLC)"


def test_parent_analyses_mapped_with_mirror_state_and_retest(db_session):
    parent = _seed_parent(db_session, "TEST-RINB-004")
    svc = _seed_service(db_session)
    a1 = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="ANALYTE-1-PUR",
        title="Analyte 1 - Purity", review_state="unassigned",
    )
    a2 = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="ANALYTE-1-QTY",
        title="Analyte 1 - Quantity", review_state="senaite_mirror",
        mirror_review_state="to_be_verified",
    )
    db_session.add_all([a1, a2])
    db_session.flush()
    a3 = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="ANALYTE-1-PUR",
        title="Analyte 1 - Purity", review_state="unassigned",
        retest_of_id=a1.id,
    )
    db_session.add(a3)
    db_session.flush()

    _, analyses = inbox_candidates_from_registry(db_session)
    rows = analyses["TEST-RINB-004"]
    by_uid = {r["uid"]: r for r in rows}
    assert len(rows) == 3
    # mirror rows emit SENAITE-side truth
    mirror = next(r for r in rows if r["keyword"] == "ANALYTE-1-QTY")
    assert mirror["review_state"] == "to_be_verified"
    assert mirror["getReviewState"] == "to_be_verified"
    # retest linkage is truthy exactly on the retest row
    retest = by_uid[f"mk1-analysis://{a3.id}"]
    assert retest["RetestOf"] == a1.id
    original = by_uid[f"mk1-analysis://{a1.id}"]
    assert not original["RetestOf"]


def test_route_mk1_source_works_without_senaite(db_session, monkeypatch):
    """source=mk1 must serve the inbox with SENAITE unconfigured — the
    resilience gain is the point of the feature. Same request WITHOUT
    source=mk1 must still 503 (legacy contract unchanged)."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from database import Base, get_db

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    parent = _seed_parent(db, "TEST-RINB-010")
    svc = _seed_service(db)
    db.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="HPLC-PUR", title="Purity", review_state="unassigned",
    ))
    db.commit()

    def _override_db():
        yield db

    monkeypatch.setattr(main_module, "SENAITE_URL", "")
    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    client = TestClient(app)
    try:
        legacy = client.get("/worksheets/inbox")
        assert legacy.status_code == 503

        resp = client.get(
            "/worksheets/inbox",
            params={"source": "mk1", "hide_test_orders": "false"},
        )
        assert resp.status_code == 200
        body = resp.json()
        ids = [i["sample_id"] for i in body["items"]]
        assert "TEST-RINB-010" in ids

        bad = client.get("/worksheets/inbox", params={"source": "bogus"})
        assert bad.status_code == 400
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
