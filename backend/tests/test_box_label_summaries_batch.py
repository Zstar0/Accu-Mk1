"""POST /orders/box-label-summaries — batched expected-vials for the receive
by-order list.

Regression guard for the 2026-07-09 prod brownout: the per-row
GET /orders/{n}/box-label-summary held a DB pool connection through a
per-sample IS fan-out; ~50 concurrent rows under HTTP/2 exhausted the pool
(QueuePool timeout 30s waves) and took get_current_user — and therefore
login — down with it. The batched endpoint serves a whole page in ONE
request: one batched IS-DB order lookup + a bounded IS fan-out, per-order
failure isolation (an errored order lands in `errors`, never a silent
undercount; the rest still resolve)."""
from datetime import datetime
from unittest.mock import patch

from fastapi.testclient import TestClient

import main
from auth import get_current_user


def _client(authed: bool = True) -> TestClient:
    main.app.dependency_overrides.clear()
    if authed:
        main.app.dependency_overrides[get_current_user] = (
            lambda: {"email": "a@x", "role": "standard"})
    return TestClient(main.app)


def _row(order_number: str, sids: list[str]) -> dict:
    return {
        "order_number": order_number,
        "order_id": order_number,
        "created_at": datetime(2026, 7, 1, 12, 0, 0),
        "sample_results": {str(i): {"senaite_id": s} for i, s in enumerate(sids, 1)},
    }


def test_batch_resolves_multiple_orders_in_one_call():
    rows = {"WP-1": _row("1", ["P-1"]), "WP-2": _row("2", ["P-2", "P-3"])}
    services = {"P-1": {"services": {"hplc_identity": True}},
                "P-2": {"services": {"hplc_identity": True}},
                "P-3": {"services": {"hplc_identity": True}}}
    with patch.object(main, "_fetch_order_submission_rows_batch", return_value=rows), \
         patch.object(main.sub_service, "fetch_sample_services",
                      side_effect=lambda sid: services[sid]), \
         patch.object(main, "derive_base_demand",
                      return_value={"hplc": 1, "endo": 0, "ster": 0}):
        r = _client().post("/orders/box-label-summaries",
                           json={"order_numbers": ["WP-1", "WP-2"]})
    assert r.status_code == 200
    body = r.json()
    assert body["errors"] == []
    # keyed by the REQUESTED number so the frontend can map rows directly
    assert set(body["summaries"].keys()) == {"WP-1", "WP-2"}
    assert body["summaries"]["WP-1"]["counts"] == {"hplc": 1, "endo": 0, "ster": 0}
    assert body["summaries"]["WP-2"]["counts"] == {"hplc": 2, "endo": 0, "ster": 0}


def test_per_order_failure_isolation():
    # P-3's IS fetch raises → WP-2 lands in errors (fail loud, no silent
    # undercount) while WP-1 still resolves.
    rows = {"WP-1": _row("1", ["P-1"]), "WP-2": _row("2", ["P-2", "P-3"])}

    def _svc(sid):
        if sid == "P-3":
            raise RuntimeError("IS unreachable")
        return {"services": {"hplc_identity": True}}

    with patch.object(main, "_fetch_order_submission_rows_batch", return_value=rows), \
         patch.object(main.sub_service, "fetch_sample_services", side_effect=_svc), \
         patch.object(main, "derive_base_demand",
                      return_value={"hplc": 1, "endo": 0, "ster": 0}):
        r = _client().post("/orders/box-label-summaries",
                           json={"order_numbers": ["WP-1", "WP-2"]})
    body = r.json()
    assert list(body["summaries"].keys()) == ["WP-1"]
    assert body["errors"] == ["WP-2"]


def test_unknown_orders_are_simply_absent():
    with patch.object(main, "_fetch_order_submission_rows_batch", return_value={}):
        r = _client().post("/orders/box-label-summaries",
                           json={"order_numbers": ["WP-404"]})
    assert r.status_code == 200
    assert r.json() == {"summaries": {}, "errors": []}


def test_cap_at_100_orders():
    r = _client().post("/orders/box-label-summaries",
                       json={"order_numbers": [f"WP-{i}" for i in range(101)]})
    assert r.status_code == 400


def test_empty_list_is_a_cheap_noop():
    with patch.object(main, "_fetch_order_submission_rows_batch") as m:
        r = _client().post("/orders/box-label-summaries", json={"order_numbers": []})
    assert r.status_code == 200
    m.assert_not_called()


def test_requires_auth():
    r = _client(authed=False).post("/orders/box-label-summaries",
                                   json={"order_numbers": ["WP-1"]})
    assert r.status_code == 401
