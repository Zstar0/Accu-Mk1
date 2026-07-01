"""S2S sterility-results endpoint (Catalog 1E-a).

GET /samples/{sample_id}/sterility-results is consumed server-to-server by
coabuilder to read native (Accu-Mk1) sterility results for the shadow-diff
against SENAITE. Auth + shape are data-independent; the 200-with-content path
is exercised live against a real promoted-sterility sample on the stack.
"""
import os

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def _auth():
    return {"X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"]}


def test_requires_service_token():
    resp = client.get("/samples/BW-0013/sterility-results")
    assert resp.status_code == 401


def test_rejects_bad_service_token():
    resp = client.get(
        "/samples/BW-0013/sterility-results",
        headers={"X-Service-Token": "definitely-not-the-token"},
    )
    assert resp.status_code == 401


def test_unknown_sample_returns_empty_list():
    """Unknown sample -> 200 with empty list (caller proceeds bare, no 404)."""
    resp = client.get(
        "/samples/NOPE-DOES-NOT-EXIST-9999/sterility-results", headers=_auth()
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"sample_id": "NOPE-DOES-NOT-EXIST-9999", "sterility_results": []}


def test_shape_and_sterility_only_filter():
    """A known sample returns 200 with the sterility_results shape, and every
    returned row's keyword is in the sterility set (never HPLC/endo)."""
    # BW-0013 is a fixture-stable sterility sample on the dev/stack DB; if absent
    # in a given environment the endpoint still must not 5xx.
    resp = client.get("/samples/BW-0013/sterility-results", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == {"sample_id", "sterility_results"}
    assert isinstance(body["sterility_results"], list)
    allowed = {"STER-PCR", "STER-USP71", "PCR-FUNGI", "PCR-BACTERIA"}
    for row in body["sterility_results"]:
        assert set(row.keys()) == {"keyword", "result_value", "promoted_at"}
        assert row["keyword"] in allowed
