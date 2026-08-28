"""GET /explorer/orders routing for the search axes (v1.11.3).

v1.11.2 wired the Order Status page's filters to the four IS search axes,
but the backend forwarded them ONLY on the customer-scoped branch — the
unscoped branch called fetch_orders(), which ignores them, so the page's
server-side search was a silent no-op (order 5739 still unfindable).

Pins: any non-empty axis routes to the IS proxy (customer_id omitted,
newest-first sort default); no axes keeps the legacy direct-DB branch;
empty-string axes do NOT trigger the proxy (debounce-flush back-compat).
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from auth import get_current_user
from main import app


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, role="admin")
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _mock_async_client(captured):
    """httpx.AsyncClient context-manager mock capturing get(url, params)."""
    resp = MagicMock()
    resp.json.return_value = []
    resp.raise_for_status.return_value = None
    inner = MagicMock()
    inner.get = AsyncMock(return_value=resp)
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=inner)
    ctx.__aexit__ = AsyncMock(return_value=False)
    captured["client"] = inner
    return ctx


def test_axis_search_routes_to_is_without_customer_scope(client):
    captured: dict = {}
    with patch("httpx.AsyncClient", side_effect=lambda **kw: _mock_async_client(captured)), \
         patch("main.fetch_orders") as direct:
        r = client.get("/explorer/orders?limit=200&search_order_number=5739")
    assert r.status_code == 200
    direct.assert_not_called()
    params = captured["client"].get.call_args.kwargs["params"]
    assert params["search_order_number"] == "5739"
    assert "customer_id" not in params
    assert params["sort"] == "date_desc"  # newest-first, matching the browse view


def test_no_axes_keeps_the_direct_db_branch(client):
    with patch("main.fetch_orders", return_value=[]) as direct, \
         patch("httpx.AsyncClient") as proxy:
        r = client.get("/explorer/orders?limit=200")
    assert r.status_code == 200
    direct.assert_called_once()
    proxy.assert_not_called()


def test_empty_string_axes_do_not_trigger_the_proxy(client):
    with patch("main.fetch_orders", return_value=[]) as direct:
        r = client.get("/explorer/orders?limit=200&search_order_number=&search_lot=")
    assert r.status_code == 200
    direct.assert_called_once()
