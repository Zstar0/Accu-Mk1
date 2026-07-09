"""GET /senaite/samples?slim=true — catalog-brains listing (no complete=yes).

slim mode is the mk1-read-mode list refresh's path: review_state is a catalog
index (cheap, no object wake-up); Analyte{N}Peptide/VerificationCode are NOT
in the brains, but the sole slim caller merges review_state only. Default
(non-slim) requests must keep sending complete=yes — SENAITE mode needs the
full payload."""
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from database import Base, get_db
import main
from auth import get_current_user

BRAIN_ITEM = {
    "uid": "UID-1", "id": "P-0001", "title": "P-0001",
    "review_state": "sample_received", "created": "2026-07-01T00:00:00",
    "getClientTitle": "client@example.com", "getClientOrderNumber": "WP-1",
    "getDateReceived": "2026-07-02T00:00:00", "getDateSampled": None,
    "getSampleTypeTitle": "Peptide",
    # deliberately NO Analyte1Peptide / VerificationCode — catalog brains
    # don't carry them (spike-verified 2026-07-08 on the registry stack).
}


@pytest.fixture
def client(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def _get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    monkeypatch.setattr(main, "SENAITE_URL", "http://senaite.test")
    monkeypatch.setattr(main, "SENAITE_USER", "u")
    monkeypatch.setattr(main, "SENAITE_PASSWORD", "p")
    main.app.dependency_overrides[get_db] = _get_db
    main.app.dependency_overrides[get_current_user] = lambda: {"email": "a@x", "role": "admin"}
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def _mock_senaite(captured):
    """Patch httpx.AsyncClient so client.get(url, params=...) records params."""
    mock_instance = AsyncMock()

    async def _get(url, params=None, **kw):
        captured.append({"url": url, "params": dict(params or {})})
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json = MagicMock(return_value={"items": [BRAIN_ITEM], "count": 1})
        return resp

    mock_instance.get = AsyncMock(side_effect=_get)
    p = patch("httpx.AsyncClient")
    mock_cls = p.start()
    mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p


def test_slim_listing_omits_complete_and_passes_review_state(client):
    captured = []
    p = _mock_senaite(captured)
    try:
        r = client.get("/senaite/samples?slim=true&review_state=sample_received")
    finally:
        p.stop()
    assert r.status_code == 200
    assert len(captured) == 1
    assert "complete" not in captured[0]["params"]
    item = r.json()["items"][0]
    assert item["review_state"] == "sample_received"
    assert item["id"] == "P-0001"
    assert item["analytes"] == []          # brains have no Analyte fields
    assert item["verification_code"] is None


def test_default_listing_still_sends_complete_yes(client):
    captured = []
    p = _mock_senaite(captured)
    try:
        r = client.get("/senaite/samples?review_state=sample_received")
    finally:
        p.stop()
    assert r.status_code == 200
    assert captured[0]["params"].get("complete") == "yes"


def test_slim_applies_to_search_path_too(client):
    # search= routes through the handler's _query helper (a different code
    # path than browse) — it must inherit the slim/complete decision from
    # base_params identically.
    captured = []
    p = _mock_senaite(captured)
    try:
        r = client.get("/senaite/samples?slim=true&search=P-0001")
    finally:
        p.stop()
    assert r.status_code == 200
    assert len(captured) >= 1
    assert all("complete" not in c["params"] for c in captured)
