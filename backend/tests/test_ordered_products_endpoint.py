import pytest
import requests
from fastapi.testclient import TestClient
from main import app
from auth import get_current_user
from sub_samples import routes as ss_routes

client = TestClient(app)


@pytest.fixture(autouse=True)
def _override_auth():
    app.dependency_overrides[get_current_user] = lambda: type("U", (), {"id": 1, "email": "t@t"})()
    yield
    app.dependency_overrides.pop(get_current_user, None)


def test_ordered_products_ok(monkeypatch):
    monkeypatch.setattr(ss_routes.service, "fetch_sample_services",
                        lambda sid: {"services": {"endotoxin": True}, "package": "core",
                                     "wp_order_number": "WP-4242"})
    r = client.get("/api/sub-samples/P-0982/ordered-products")
    assert r.status_code == 200
    body = r.json()
    assert body["wp_order_number"] == "WP-4242"
    assert [p["label"] for p in body["products"]] == ["Core HPLC", "Endotoxin"]


def test_ordered_products_no_order_is_404(monkeypatch):
    monkeypatch.setattr(ss_routes.service, "fetch_sample_services", lambda sid: None)
    r = client.get("/api/sub-samples/P-9999/ordered-products")
    assert r.status_code == 404


def test_ordered_products_is_unreachable_is_502(monkeypatch):
    def boom(sid):
        raise requests.ConnectionError("connection refused")
    monkeypatch.setattr(ss_routes.service, "fetch_sample_services", boom)
    r = client.get("/api/sub-samples/P-0982/ordered-products")
    assert r.status_code == 502
    assert r.json()["detail"]["sample_id"] == "P-0982"
