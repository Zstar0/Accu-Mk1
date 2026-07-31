"""Transfer lineage readback — mirrors the retest-info endpoint."""
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_non_transferred_sample_reports_false():
    resp = client.get("/samples/P-0301/transfer-info")
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_transfer"] is False
    assert body["source_sample_id"] is None
    assert body["transferred_as"] == []


def test_response_shape_is_stable():
    body = client.get("/samples/P-0301/transfer-info").json()
    for key in (
        "is_transfer",
        "source_sample_id",
        "source_order_id",
        "source_user_id",
        "transferred_as",
    ):
        assert key in body, f"missing key {key}"
