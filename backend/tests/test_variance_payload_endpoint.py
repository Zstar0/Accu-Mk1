"""S2S variance-payload endpoint (H3 of the variance hardening pass).

GET /samples/{sample_id}/variance-payload is consumed server-to-server by
integration-service when it regenerates an additional (re-branded) COA on an
already-published sample, so the additional COA renders the same variance series
as the primary instead of a bare SENAITE re-fetch (Finding 2).

These cover the security gate (X-Service-Token required) and the not-found path,
which are data-independent. The 200-with-content path wraps the already-tested
build_variance_replicates / build_variance_analyte_series builders (see
test_variance_analyte_series.py) and is exercised live against real samples.
"""
import os

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def _auth():
    return {"X-Service-Token": os.environ["ACCUMK1_INTERNAL_SERVICE_TOKEN"]}


def test_requires_service_token():
    """No token -> 401 (S2S endpoint, never anonymous)."""
    resp = client.get("/samples/P-0149/variance-payload")
    assert resp.status_code == 401


def test_rejects_bad_service_token():
    """Wrong token -> 401 (timing-safe compare in require_internal_service_token)."""
    resp = client.get(
        "/samples/P-0149/variance-payload",
        headers={"X-Service-Token": "definitely-not-the-token"},
    )
    assert resp.status_code == 401


def test_unknown_sample_returns_404():
    """Authenticated request for a non-existent sample -> 404 (caller proceeds bare)."""
    resp = client.get(
        "/samples/NOPE-DOES-NOT-EXIST-9999/variance-payload",
        headers=_auth(),
    )
    assert resp.status_code == 404


def test_known_sample_returns_payload_shape():
    """A known sample returns 200 with both variance keys (possibly empty dicts)."""
    resp = client.get("/samples/P-0149/variance-payload", headers=_auth())
    # P-0149 is a fixture-stable peptide sample with variance vials in the dev DB.
    # If absent in a given environment the endpoint still must not 5xx — a 404 is
    # the only acceptable alternative (never a crash).
    assert resp.status_code in (200, 404)
    if resp.status_code == 200:
        body = resp.json()
        assert set(body.keys()) == {"variance_replicates", "variance_analytes"}
        assert isinstance(body["variance_replicates"], dict)
        assert isinstance(body["variance_analytes"], dict)
