from fastapi.testclient import TestClient
from main import app
import uuid
import os


client = TestClient(app)


def headers():
    return {
        "X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"],
        "Idempotency-Key": str(uuid.uuid4()),
    }


def test_create_rejects_missing_token():
    resp = client.post("/api/peptide-requests", json={}, headers={})
    assert resp.status_code == 401


def test_create_rejects_invalid_token():
    resp = client.post("/api/peptide-requests", json={},
                       headers={"X-Service-Token": "bogus", "Idempotency-Key": "k"})
    assert resp.status_code == 401


def test_create_validates_body():
    resp = client.post("/api/peptide-requests", json={}, headers=headers())
    assert resp.status_code == 422


def test_create_returns_201_on_success():
    resp = client.post("/api/peptide-requests", headers=headers(), json={
        "compound_kind": "peptide",
        "compound_name": "Retatrutide",
        "vendor_producer": "PepMart",
        "submitted_by_wp_user_id": 42,
        "submitted_by_email": "a@b.c",
        "submitted_by_name": "Jane",
    })
    assert resp.status_code == 201
    assert resp.json()["compound_name"] == "Retatrutide"
    assert resp.json()["status"] == "new"


def test_create_is_idempotent():
    idem = str(uuid.uuid4())
    body = {
        "compound_kind": "peptide", "compound_name": "X",
        "vendor_producer": "Y", "submitted_by_wp_user_id": 99,
        "submitted_by_email": "a@b.c", "submitted_by_name": "N",
    }
    h = {"X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"],
         "Idempotency-Key": idem}
    first = client.post("/api/peptide-requests", headers=h, json=body)
    second = client.post("/api/peptide-requests", headers=h, json=body)
    assert first.json()["id"] == second.json()["id"]
