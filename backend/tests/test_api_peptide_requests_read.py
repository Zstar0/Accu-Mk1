from fastapi.testclient import TestClient
from backend.main import app
import uuid
import os


client = TestClient(app)


def headers():
    """Headers for POST (includes Idempotency-Key) — fresh uuid per call."""
    return {
        "X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"],
        "Idempotency-Key": str(uuid.uuid4()),
    }


def auth_headers():
    """Headers for GET (token only)."""
    return {"X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"]}


def _make_request(wp_user_id: int, compound_name: str = "Semaglutide") -> dict:
    """POST a peptide request and return the created row as dict."""
    resp = client.post(
        "/api/peptide-requests",
        headers=headers(),
        json={
            "compound_kind": "peptide",
            "compound_name": compound_name,
            "vendor_producer": "PepMart",
            "submitted_by_wp_user_id": wp_user_id,
            "submitted_by_email": "user@example.com",
            "submitted_by_name": "Test User",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_list_rejects_missing_token():
    resp = client.get("/api/peptide-requests", params={"wp_user_id": 101})
    assert resp.status_code == 401


def test_list_requires_wp_user_id():
    resp = client.get("/api/peptide-requests", headers=auth_headers())
    assert resp.status_code == 422


def test_list_returns_envelope_shape():
    wp_user = 101
    created = _make_request(wp_user, compound_name="Tirzepatide")
    resp = client.get(
        "/api/peptide-requests",
        headers=auth_headers(),
        params={"wp_user_id": wp_user},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body.keys()) >= {"total", "limit", "offset", "items"}
    assert isinstance(body["items"], list)
    assert isinstance(body["total"], int)
    assert isinstance(body["limit"], int)
    assert isinstance(body["offset"], int)
    ids = [item["id"] for item in body["items"]]
    assert created["id"] in ids


def test_list_filters_by_status():
    wp_user = 102
    _make_request(wp_user, compound_name="Retatrutide")
    resp = client.get(
        "/api/peptide-requests",
        headers=auth_headers(),
        params={"wp_user_id": wp_user, "status": "new"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["items"]) >= 1
    for item in body["items"]:
        assert item["status"] in {"new"}


def test_detail_rejects_missing_token():
    resp = client.get(f"/api/peptide-requests/{uuid.uuid4()}")
    assert resp.status_code == 401


def test_detail_returns_record():
    wp_user = 103
    created = _make_request(wp_user, compound_name="BPC-157")
    resp = client.get(
        f"/api/peptide-requests/{created['id']}",
        headers=auth_headers(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == created["id"]
    assert body["compound_name"] == "BPC-157"
    assert body["submitted_by_wp_user_id"] == wp_user
    assert body["status"] == "new"


def test_detail_returns_404_for_missing():
    resp = client.get(
        f"/api/peptide-requests/{uuid.uuid4()}",
        headers=auth_headers(),
    )
    assert resp.status_code == 404
