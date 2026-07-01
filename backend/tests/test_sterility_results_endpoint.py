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
        assert set(row.keys()) == {"keyword", "result_value", "review_state"}
        assert row["keyword"] in allowed


def test_excludes_retracted_and_no_duplicate_keywords():
    """The live-result filter (retest_of_id IS NULL + not retracted/rejected):
    a retracted/superseded result must never leak, and there is at most one
    row per keyword. P-0152 has a retracted 'Detected' STER-PCR alongside a
    verified '0' — only the '0' may appear (regression for the Step-8 finding
    that list_promotions_for_parent returned both). Tolerant of P-0152 absence."""
    resp = client.get("/samples/P-0152/sterility-results", headers=_auth())
    assert resp.status_code == 200
    rows = resp.json()["sterility_results"]
    assert all(r["review_state"] not in ("retracted", "rejected") for r in rows)
    kws = [r["keyword"] for r in rows]
    assert len(kws) == len(set(kws)), f"duplicate keywords leaked: {kws}"
    ster = [r for r in rows if r["keyword"] == "STER-PCR"]
    if ster:
        assert ster[0]["result_value"] == "0", "retracted 'Detected' leaked instead of live '0'"
