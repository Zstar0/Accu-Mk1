"""Registry-inspect /parity endpoint: thin adapter over
scripts.parity_sample_details (2026-07-27 parity-convergence spec).
NO live SENAITE: fetch_pair_in_process is always patched."""
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import main
from auth import require_admin
from scripts.parity_sample_details import FieldDiff

SAMPLE = "TEST-RDPAR-1"


@pytest.fixture
def client():
    prev = dict(main.app.dependency_overrides)
    main.app.dependency_overrides[require_admin] = (
        lambda: SimpleNamespace(id=1, role="admin", email="admin@test"))
    tc = TestClient(main.app)
    yield tc
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides.update(prev)


def test_parity_orders_real_then_known_then_equal(client):
    diffs = [
        FieldDiff("a_equal", "equal"),
        FieldDiff("b_known", "known_expected", "cached_at_timestamps", "x", "y"),
        FieldDiff("c_real", "differing", None, "1", "2"),
        FieldDiff("d_real2", "mk1_only", None, "v", None),
    ]
    with patch("scripts.parity_sample_details.fetch_pair_in_process",
               return_value=({}, {})), \
         patch("scripts.parity_sample_details.compare_sample",
               return_value=diffs):
        out = client.get(f"/debug/sample-registry/{SAMPLE}/parity").json()
    assert out["error"] is None
    assert [f["path"] for f in out["fields"]] == [
        "c_real", "d_real2", "b_known", "a_equal"]  # stable within buckets
    assert out["fields"][0]["is_real"] is True
    assert out["fields"][2]["rule_id"] == "cached_at_timestamps"
    assert out["summary"] == {"total": 4, "equal": 1,
                              "known_expected": 1, "real": 2}
    assert out["verdict"] is False


def test_parity_clean_verdict_true(client):
    with patch("scripts.parity_sample_details.fetch_pair_in_process",
               return_value=({}, {})), \
         patch("scripts.parity_sample_details.compare_sample",
               return_value=[FieldDiff("a", "equal")]):
        out = client.get(f"/debug/sample-registry/{SAMPLE}/parity").json()
    assert out["verdict"] is True and out["summary"]["real"] == 0


def test_parity_real_pipeline_smoke(client):
    """Real compare_sample over empty payloads: exercises the lazy import
    and the full adapter path with zero SENAITE."""
    with patch("scripts.parity_sample_details.fetch_pair_in_process",
               return_value=({}, {})):
        resp = client.get(f"/debug/sample-registry/{SAMPLE}/parity")
    out = resp.json()
    assert resp.status_code == 200
    assert out["error"] is None
    assert out["summary"]["total"] == len(out["fields"]) > 0


def test_parity_fetch_failure_is_error_payload_not_500(client):
    with patch("scripts.parity_sample_details.fetch_pair_in_process",
               side_effect=RuntimeError("SENAITE unreachable")):
        resp = client.get(f"/debug/sample-registry/{SAMPLE}/parity")
    assert resp.status_code == 200
    out = resp.json()
    assert "SENAITE unreachable" in out["error"]
    assert out["fields"] == [] and out["summary"] is None and out["verdict"] is None


def test_parity_admin_gate():
    tc = TestClient(main.app)
    assert tc.get(
        f"/debug/sample-registry/{SAMPLE}/parity").status_code in (401, 403)
