import pytest
import requests
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from main import app
from auth import get_current_user
from database import get_db, Base
from sub_samples import routes as ss_routes

client = TestClient(app)


@pytest.fixture(autouse=True)
def _override_auth():
    app.dependency_overrides[get_current_user] = lambda: type("U", (), {"id": 1, "email": "t@t"})()
    yield
    app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture
def db_client(db_session):
    """`client` wired to a real (in-memory) db session, for asserting on
    response_model-serialized fields that only the db-backed profile lookup
    populates (e.g. ride_host_roles)."""
    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db
    tc = TestClient(app)
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db


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


# ─── ride_host_roles survives response_model serialization (fix round 1,
# spec 2026-08-20-rider-vial-visibility, Task 8) ─────────────────────────────

def test_ride_host_roles_present_on_route_response(monkeypatch, db_session, db_client):
    """OrderedProduct (the route's response_model) must carry ride_host_roles
    through — build_ordered_products already returns it in the dict, but a
    pydantic response_model silently strips any key it doesn't declare. A
    rider profile (db-seeded, with a profile_ride_hosts row) must show its
    ride list; a legacy PRODUCT_REGISTRY key (no db row) must show []."""
    from models import AnalysisProfile, profile_ride_hosts

    rider = AnalysisProfile(
        key="fentanyl", name="Fentanyl", is_addon=True, vials_required=0,
        fulfillment_role="fentanyl", fulfillment_dim="role", active=True,
    )
    db_session.add(rider)
    db_session.flush()
    db_session.execute(profile_ride_hosts.insert().values(
        analysis_profile_id=rider.id, host_role_code="hplc", priority=0))
    db_session.commit()

    monkeypatch.setattr(
        ss_routes.service, "fetch_sample_services",
        lambda sid: {
            "services": {"fentanyl": True, "hplcpurity_identity": True},
            "package": None, "wp_order_number": "WP-5150",
        },
    )

    r = db_client.get("/api/sub-samples/P-0982/ordered-products")
    assert r.status_code == 200
    products = {p["key"]: p for p in r.json()["products"]}

    assert products["fentanyl"]["ride_host_roles"] == ["hplc"]
    assert products["hplcpurity_identity"]["ride_host_roles"] == []
