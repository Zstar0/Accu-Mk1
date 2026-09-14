"""Task 1b (controller ruling, 2026-09-14): the default sample-lookup route
(`GET /wizard/senaite/lookup`, `source` defaults to 'senaite' on the FE) must
serve native-born samples (lims_samples.external_lims_system == "mk1") from
the registry-read builder — zero SENAITE HTTP, `external_lims_system`
populated — regardless of which read-source the caller defaulted to.
SENAITE-born rows keep the existing SENAITE HTTP path byte-identical.
`GET /wizard/senaite/raw-fields/{sample_id}` gets the same native-born
short-circuit (no SENAITE fields exist to diagnose for a sample with no
SENAITE AR).
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main
from auth import get_current_user
from database import Base, get_db
from tests.hplc_native_family import native_family


@pytest.fixture
def client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def _get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    main.app.dependency_overrides[get_db] = _get_db
    main.app.dependency_overrides[get_current_user] = lambda: {"email": "a@x", "role": "admin"}
    c = TestClient(main.app)
    c._Session = Session
    yield c
    main.app.dependency_overrides.clear()
    main._senaite_lookup_cache.clear()


def _mock_senaite_http_empty():
    """Broad httpx.AsyncClient patch (idiom copied from
    test_native_remarks_read.py): every request returns 200 with an
    empty-items JSON payload, so downstream analyses/attachments/published-
    COA fetches on the SENAITE-born path tolerate it. Returns the patcher
    (caller must .stop())."""
    mock_instance = AsyncMock()
    resp = MagicMock()
    resp.status_code = 200
    resp.json = MagicMock(return_value={"count": 0, "items": []})
    resp.raise_for_status = MagicMock()
    mock_instance.get = AsyncMock(return_value=resp)
    mock_instance.post = AsyncMock(return_value=resp)
    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p


def _senaite_env():
    """Context managers that make the route think SENAITE is configured
    (the SENAITE_URL is None guard runs before the native-born gate on both
    routes, so this must be patched even for native-born assertions)."""
    return (
        patch.object(main, "SENAITE_URL", "http://senaite.test"),
        patch.object(main, "SENAITE_USER", "u"),
        patch.object(main, "SENAITE_PASSWORD", "p"),
    )


# ═══════════════════════════════════════════════════════════════════════════
# /wizard/senaite/lookup
# ═══════════════════════════════════════════════════════════════════════════

def test_native_born_lookup_serves_registry_no_senaite_http(client):
    db = client._Session()
    parent, *_ = native_family(db, sample_id="PB-9001", slots=[("BPC-157", "BPC157")])
    db.commit()
    sample_id = parent.sample_id
    db.close()

    u1, u2, u3 = _senaite_env()
    fetch_mock = AsyncMock(side_effect=AssertionError("SENAITE fetch must not be called for a native-born sample"))
    with u1, u2, u3, patch.object(main, "_fetch_senaite_sample", fetch_mock), \
         patch("httpx.AsyncClient", side_effect=AssertionError("httpx must not be used for a native-born sample")):
        r = client.get("/wizard/senaite/lookup", params={"id": sample_id})

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["external_lims_system"] == "mk1"
    assert body["sample_id"] == sample_id
    fetch_mock.assert_not_called()


def test_native_born_lookup_explicit_source_mk1_identical(client):
    """The FE's `source=mk1` request hits a different route entirely
    (/registry/sample/{id}/details) — but nothing in this route reads a
    `source` query param, so passing one changes nothing: same native-born
    short-circuit, same response."""
    db = client._Session()
    parent, *_ = native_family(db, sample_id="PB-9002", slots=[("BPC-157", "BPC157")])
    db.commit()
    sample_id = parent.sample_id
    db.close()

    u1, u2, u3 = _senaite_env()
    fetch_mock = AsyncMock(side_effect=AssertionError("SENAITE fetch must not be called for a native-born sample"))
    with u1, u2, u3, patch.object(main, "_fetch_senaite_sample", fetch_mock):
        r = client.get("/wizard/senaite/lookup", params={"id": sample_id, "source": "mk1"})

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["external_lims_system"] == "mk1"
    fetch_mock.assert_not_called()


def test_senaite_born_lookup_unchanged(client):
    """No lims_samples row at all (pure SENAITE-born, never registered
    native) — the existing SENAITE HTTP path must still run exactly once
    and the response is unaffected by the new gate."""
    sample_id = "PB-9003"
    ar_item = {
        "id": sample_id,
        "uid": "UID-9003",
        "getClientTitle": "SenaiteCo",
    }

    u1, u2, u3 = _senaite_env()
    fetch_mock = AsyncMock(return_value={"count": 1, "items": [ar_item]})
    http_patcher = _mock_senaite_http_empty()
    try:
        with u1, u2, u3, patch.object(main, "_fetch_senaite_sample", fetch_mock):
            r = client.get("/wizard/senaite/lookup", params={"id": sample_id})
    finally:
        http_patcher.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["sample_id"] == sample_id
    assert body["client"] == "SenaiteCo"
    assert body.get("external_lims_system") is None
    fetch_mock.assert_called_once()


# ═══════════════════════════════════════════════════════════════════════════
# /wizard/senaite/raw-fields/{sample_id}
# ═══════════════════════════════════════════════════════════════════════════

def test_native_born_raw_fields_no_senaite_http(client):
    db = client._Session()
    parent, *_ = native_family(db, sample_id="PB-9004", slots=[("BPC-157", "BPC157")])
    db.commit()
    sample_id = parent.sample_id
    db.close()

    u1, u2, u3 = _senaite_env()
    fetch_mock = AsyncMock(side_effect=AssertionError("SENAITE fetch must not be called for a native-born sample"))
    with u1, u2, u3, patch.object(main, "_fetch_senaite_sample", fetch_mock):
        r = client.get(f"/wizard/senaite/raw-fields/{sample_id}")

    assert r.status_code == 200, r.text
    assert r.json() == {"native_born": True}
    fetch_mock.assert_not_called()


def test_senaite_born_raw_fields_unchanged(client):
    sample_id = "PB-9005"
    ar_item = {"id": sample_id, "title": sample_id, "SampleType": "Peptide"}

    u1, u2, u3 = _senaite_env()
    fetch_mock = AsyncMock(return_value={"count": 1, "items": [ar_item]})
    with u1, u2, u3, patch.object(main, "_fetch_senaite_sample", fetch_mock):
        r = client.get(f"/wizard/senaite/raw-fields/{sample_id}")

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == sample_id
    assert body["SampleType"] == "Peptide"
    fetch_mock.assert_called_once()
