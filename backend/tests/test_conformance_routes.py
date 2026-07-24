import json
from pathlib import Path
from unittest.mock import patch

FIX = Path(__file__).parent / "fixtures" / "conformance"


def _load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def test_run_conformance_routes_peptide_blend_to_peptide_engine():
    ar = _load("senaite_dump_PB-0010.json")  # SampleTypeTitle == "Peptide Blend"
    analyses = ar["_Analyses_Detailed"]
    with patch("conformance.service.fetch_ar_blob", return_value=ar), \
         patch("conformance.service.fetch_analysis_items", return_value=analyses):
        from conformance.service import run_conformance
        out = run_conformance("PB-0010")
    assert out["sample_id"] == "PB-0010"
    assert out["engine"] == "peptide"
    assert out["matrix"] == "Peptide Blend"
    assert isinstance(out["overall_pass"], bool)
    assert isinstance(out["results_table"], list)


def test_run_conformance_routes_non_peptide_to_generic_engine():
    ar = _load("senaite_dump_PB-0010.json")
    ar = dict(ar); ar["SampleTypeTitle"] = "Bacteriostatic Water"
    analyses = ar["_Analyses_Detailed"]
    with patch("conformance.service.fetch_ar_blob", return_value=ar), \
         patch("conformance.service.fetch_analysis_items", return_value=analyses):
        from conformance.service import run_conformance
        out = run_conformance("BW-9999")
    assert out["engine"] == "generic"


def test_conformance_router_defines_route():
    from conformance.routes import router
    paths = {r.path for r in router.routes}
    assert "/api/conformance/{sample_id}" in paths


def test_conformance_route_returns_verdict(monkeypatch):
    from types import SimpleNamespace
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user

    ar = _load("senaite_dump_PB-0010.json")
    analyses = ar["_Analyses_Detailed"]
    monkeypatch.setattr("conformance.service.fetch_ar_blob", lambda sid: ar)
    monkeypatch.setattr("conformance.service.fetch_analysis_items", lambda sid: analyses)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=42, role="standard", email="bot@x.t")
    try:
        client = TestClient(app)
        resp = client.get("/api/conformance/PB-0010")
        assert resp.status_code == 200
        body = resp.json()
        assert body["sample_id"] == "PB-0010"
        assert body["engine"] == "peptide"
        assert "overall_pass" in body and "results_table" in body
    finally:
        app.dependency_overrides.pop(get_current_user, None)
