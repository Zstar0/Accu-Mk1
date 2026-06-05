"""Result type + options on AnalysisService (analysis_services)."""
from __future__ import annotations

from models import AnalysisService


def test_analysis_service_result_type_columns(db_session):
    svc = AnalysisService(
        title="Rapid Sterility Screening (PCR)",
        keyword="STER-PCR",
        result_type="select",
        result_options=[
            {"value": "1", "label": "Conforms"},
            {"value": "0", "label": "Does Not Conform"},
        ],
    )
    db_session.add(svc)
    db_session.commit()
    db_session.refresh(svc)

    assert svc.result_type == "select"
    assert svc.result_options == [
        {"value": "1", "label": "Conforms"},
        {"value": "0", "label": "Does Not Conform"},
    ]


def test_analysis_service_result_type_defaults_none(db_session):
    svc = AnalysisService(title="HPLC Purity", keyword="HPLC-PUR")
    db_session.add(svc)
    db_session.commit()
    db_session.refresh(svc)
    assert svc.result_type is None
    assert svc.result_options is None


from main import _parse_service_result_options, _apply_service_result_type


def test_parse_service_result_options_maps_value_label():
    raw = [
        {"ResultValue": 1, "ResultText": "Conforms"},
        {"ResultValue": 0, "ResultText": "Does Not Conform"},
    ]
    assert _parse_service_result_options(raw) == [
        {"value": "1", "label": "Conforms"},
        {"value": "0", "label": "Does Not Conform"},
    ]


def test_parse_service_result_options_handles_empty():
    assert _parse_service_result_options(None) == []
    assert _parse_service_result_options([]) == []


def test_apply_seeds_when_result_type_null(db_session):
    svc = AnalysisService(title="Ster", keyword="STER-PCR")  # result_type is None
    db_session.add(svc)
    db_session.flush()
    item = {"ResultType": "select", "ResultOptions": [{"ResultValue": 1, "ResultText": "Conforms"}]}

    _apply_service_result_type(svc, item)

    assert svc.result_type == "select"
    assert svc.result_options == [{"value": "1", "label": "Conforms"}]


def test_apply_does_not_overwrite_existing(db_session):
    svc = AnalysisService(
        title="Ster", keyword="STER-PCR",
        result_type="numeric", result_options=[{"value": "x", "label": "y"}],
    )
    db_session.add(svc)
    db_session.flush()
    item = {"ResultType": "select", "ResultOptions": [{"ResultValue": 1, "ResultText": "Conforms"}]}

    _apply_service_result_type(svc, item)  # local-wins: unchanged

    assert svc.result_type == "numeric"
    assert svc.result_options == [{"value": "x", "label": "y"}]


def test_apply_seeds_from_get_prefixed_keys(db_session):
    svc = AnalysisService(title="Ster", keyword="STER-PCR")
    db_session.add(svc)
    db_session.flush()
    item = {"getResultType": "select",
            "getResultOptions": [{"ResultValue": 1, "ResultText": "Conforms"}]}

    _apply_service_result_type(svc, item)

    assert svc.result_type == "select"
    assert svc.result_options == [{"value": "1", "label": "Conforms"}]


# ─── PATCH /analysis-services/{id}/result-type ───────────────────────────────

import pytest
from unittest.mock import MagicMock
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient
from main import app
from auth import get_current_user
from database import get_db, Base


@pytest.fixture
def route_client():
    """TestClient with a single-connection in-memory SQLite engine.

    Uses StaticPool so every session (test thread + ASGI handler thread) shares
    the exact same underlying connection, which keeps in-memory tables visible
    across the boundary.  check_same_thread=False allows the ASGI worker thread
    to use the connection created in the test thread.
    """
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

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    tc = TestClient(app)
    # Bundle session onto client object for convenience in tests
    tc._test_session = shared_session
    yield tc
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    shared_session.close()


def test_update_result_type_endpoint(route_client):
    db = route_client._test_session
    svc = AnalysisService(title="Ster", keyword="STER-PCR")
    db.add(svc)
    db.commit()

    resp = route_client.patch(
        f"/analysis-services/{svc.id}/result-type",
        json={"result_type": "select",
              "result_options": [{"value": "1", "label": "Conforms"}]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["result_type"] == "select"
    assert body["result_options"] == [{"value": "1", "label": "Conforms"}]
