"""Worksheets and sample preps resolve SLA by the analysis row's own service FK,
not its keyword. That needs the FK to survive every hop:

    native inbox item -> add-to-worksheet payload -> worksheet_items.analyses_json
                      -> GET /worksheets  (what the FE builds SLA subjects from)
    GET /sample-preps -> sla.analyses      (per live row: FK + keyword)

Keyword -> service is last-writer-wins when two services share a keyword
across origins (uq_analysis_services_mk1_keyword is partial on origin='mk1'),
so the FK is the identity and keyword is only for a row that has none.
"""
import json
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db
from main import app, _fetch_mk1_inbox_analyses_for_sub_sample
from models import (
    AnalysisService, LimsAnalysis, LimsSample, LimsSubSample, Worksheet, WorksheetItem,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
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


def _vial_with_analysis(db, *, keyword="HPLC-PURITY"):
    parent = LimsSample(sample_id="P-9100", external_lims_uid=None,
                        date_received=datetime(2026, 9, 1, 9, 0, 0))
    db.add(parent); db.flush()
    vial = LimsSubSample(sample_id="P-9100-S01", external_lims_uid="uid-9100-s01",
                         parent_sample_pk=parent.id, vial_sequence=1,
                         received_at=datetime(2026, 9, 1, 10, 0, 0))
    db.add(vial); db.flush()
    svc = AnalysisService(title="HPLC Purity", keyword=keyword, origin="mk1")
    db.add(svc); db.flush()
    db.add(LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
                        keyword=keyword, title="BPC-157 - Purity (HPLC)",
                        review_state="unassigned", slot=1))
    db.commit()
    return vial, svc


def test_native_inbox_item_carries_its_service_fk(db):
    vial, svc = _vial_with_analysis(db)
    (item,) = _fetch_mk1_inbox_analyses_for_sub_sample(db, vial.id, "hplc", {})
    assert item.analysis_service_id == svc.id
    assert item.keyword == "HPLC-PURITY"
    # Declared on the pydantic model, so the typed /worksheets/inbox response
    # cannot silently strip it (the FastAPI response_model trap).
    assert "analysis_service_id" in item.model_dump()


def test_add_group_persists_the_fk_and_the_list_returns_it(client, db):
    vial, svc = _vial_with_analysis(db)
    ws = Worksheet(title="WS", status="open")
    db.add(ws); db.commit()

    resp = client.post(f"/worksheets/{ws.id}/add-group", json={
        "sample_uid": vial.external_lims_uid, "sample_id": vial.sample_id,
        "analyses": [
            {"title": "BPC-157 - Purity (HPLC)", "keyword": "HPLC-PURITY",
             "analysis_service_id": svc.id, "peptide_name": None, "method": None},
            # A SENAITE-derived inbox item: no Mk1 service id exists for it.
            {"title": "Endotoxin", "keyword": "ENDO-LAL"},
        ],
    })
    assert resp.status_code in (200, 201), resp.text

    stored = db.execute(select(WorksheetItem)).scalars().one()
    by_kw = {a["keyword"]: a for a in json.loads(stored.analyses_json)}
    assert by_kw["HPLC-PURITY"]["analysis_service_id"] == svc.id
    assert by_kw["ENDO-LAL"]["analysis_service_id"] is None

    listed = client.get("/worksheets").json()
    rows = listed["worksheets"] if isinstance(listed, dict) else listed
    item = next(w for w in rows if w["id"] == ws.id)["items"][0]
    got = {a["keyword"]: a.get("analysis_service_id") for a in item["analyses"]}
    assert got == {"HPLC-PURITY": svc.id, "ENDO-LAL": None}


def test_sample_prep_sla_block_pairs_each_row_with_its_fk(client, db):
    vial, svc = _vial_with_analysis(db)
    row = {"id": 1, "sample_id": "SP-1", "senaite_sample_id": "P-9100",
           "lims_sub_sample_pk": vial.id, "status": "awaiting_hplc",
           "created_at": datetime(2026, 9, 1, 11, 0, 0),
           "updated_at": datetime(2026, 9, 1, 11, 0, 0)}
    with patch("mk1_db.ensure_sample_preps_table"), \
         patch("mk1_db.list_sample_preps", return_value=[row]):
        r = client.get("/sample-preps")
    assert r.status_code == 200
    sla = r.json()[0]["sla"]
    assert sla["analyses"] == [{"analysis_service_id": svc.id, "keyword": "HPLC-PURITY"}]
    assert sla["keywords"] == ["HPLC-PURITY"]          # older clients: unchanged
