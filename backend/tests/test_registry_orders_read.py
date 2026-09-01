"""Batched registry orders read — GET /registry/orders.

Authenticated (not admin-only), same access-control rationale as
/registry/samples and test_registry_list.py. The Receive page uses this for
one batched request per visible order group (never per-row lookups)."""
from models import LimsOrder
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from database import Base, get_db
import main
from auth import get_current_user


@pytest.fixture
def client():
    # StaticPool + check_same_thread=False (per test_registry_list.py
    # convention): TestClient dispatches the ASGI app on a different thread
    # than this fixture, so tables created here would be invisible to the
    # request ("no such table") without a pool shared across threads.
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def _get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    main.app.dependency_overrides[get_db] = _get_db
    main.app.dependency_overrides[get_current_user] = lambda: {"email": "a@x", "role": "standard"}
    c = TestClient(main.app)
    c._Session = Session
    yield c
    main.app.dependency_overrides.clear()


def test_returns_requested_orders(client):
    db = client._Session()
    db.add(LimsOrder(wp_order_id=1, order_number="WP-1",
                      billing={"city": "Austin", "state": "TX"}))
    db.commit()
    db.close()
    r = client.get("/registry/orders", params={"numbers": "WP-1,WP-404"})
    assert r.status_code == 200
    orders = r.json()["orders"]
    assert len(orders) == 1
    assert orders[0]["order_number"] == "WP-1"
    assert orders[0]["billing"]["city"] == "Austin"


def test_caps_request_at_100_numbers_silently_truncating(client):
    # 101 distinct orders exist in the registry, all requested. The route
    # silently truncates the `numbers` list to the first 100 entries rather
    # than 422ing — verify only WP-1..WP-100 are consulted and WP-101 (last
    # in the list) never makes it into the query.
    db = client._Session()
    for i in range(1, 102):
        db.add(LimsOrder(wp_order_id=i, order_number=f"WP-{i}"))
    db.commit()
    db.close()
    numbers = ",".join(f"WP-{i}" for i in range(1, 102))
    r = client.get("/registry/orders", params={"numbers": numbers})
    assert r.status_code == 200
    order_numbers = {o["order_number"] for o in r.json()["orders"]}
    # Pins input-list truncation specifically (first 100 of `numbers`
    # consulted) rather than an output-side `.limit(100)`, which — with no
    # ORDER BY — could return any 100 of the 101 rows and pass flakily.
    assert order_numbers == {f"WP-{i}" for i in range(1, 101)}


def test_unauthenticated_rejected_401():
    from database import Base as B
    eng = create_engine("sqlite:///:memory:")
    B.metadata.create_all(eng)
    c = TestClient(main.app)
    r = c.get("/registry/orders", params={"numbers": "WP-1"})
    assert r.status_code == 401
