"""Tests for GET /reports/ready-to-publish.

The route is guarded by get_current_user (JWT). It loads Mk1 rows through
``_load_ready_to_publish_inputs(db)`` (patched here) and the test-order set
through ``_test_order_senaite_ids`` (patched), then delegates to the pure
engine in ready_to_publish.py, which has its own tests.
"""
from datetime import datetime, time
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main as main_module
from auth import get_current_user
from database import get_db
from main import app
from ready_to_publish import FlagIn, FlagTypeIn, SampleIn, TierIn
from sla_engine import BusinessSchedule

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_report_cache():
    """The route reads through a 60 s process cache (2026-09-11); each test
    wants its own patched inputs to be what is served."""
    import ready_to_publish_cache
    ready_to_publish_cache.invalidate()
    yield
    ready_to_publish_cache.invalidate()

SCHEDULE = BusinessSchedule(open_time=time(9, 0), close_time=time(17, 0), timezone="America/Los_Angeles",
                            working_days=frozenset({0, 1, 2, 3, 4}))
STANDARD = TierIn(id=1, name="Standard", target_minutes=1440, is_default=True)
READY_T = FlagTypeIn(slug="new_type_3", label="Ready for Publish", color="#088000")
PARTIAL_T = FlagTypeIn(slug="new_type_4", label="Ready for Partial Publish", color="#7e8f00")
HOLD_T = FlagTypeIn(slug="new_type_7", label="On Hold", color="#64748b")


def _inputs(samples, line_states, flags=()):
    return {
        "samples": list(samples),
        "line_states_by_pk": dict(line_states),
        "flags": list(flags),
        "flag_types": [READY_T, PARTIAL_T, HOLD_T],
        "priorities": {},
        "services_of": {},
        "tiers": [STANDARD],
        "groups": [],
        "schedule": SCHEDULE,
        "holidays": frozenset(),
    }


def _use(monkeypatch, inputs, test_ids=frozenset()):
    def _fake_db():
        yield MagicMock()

    monkeypatch.setitem(app.dependency_overrides, get_current_user, lambda: MagicMock(id=1, email="lab@x"))
    monkeypatch.setitem(app.dependency_overrides, get_db, _fake_db)
    monkeypatch.setattr(main_module, "_load_ready_to_publish_inputs", lambda db: inputs)
    monkeypatch.setattr(main_module, "_test_order_senaite_ids", lambda: set(test_ids))


def _sample(pk, sid, status="verified", order="7001", received=datetime(2026, 9, 1, 16, 0)):
    return SampleIn(pk=pk, sample_id=sid, status=status, order=order, client="Acme",
                    email="lab@acme.test", date_received=received, lot="L1",
                    analytes=("BPC-157 - Identity (HPLC)",))


def test_requires_auth():
    assert client.get("/reports/ready-to-publish").status_code == 401


def test_rows_sorted_and_totals(monkeypatch):
    _use(monkeypatch, _inputs(
        [_sample(1, "P-1", received=datetime(2026, 9, 8, 16, 0)),      # recent → green
         _sample(2, "P-2", received=datetime(2026, 8, 1, 16, 0)),      # long overdue → red
         _sample(3, "P-3", status="waiting_for_addon_results", order="7002")],
        {1: {"HPLC-PUR": "verified"}, 2: {"HPLC-PUR": "verified"}, 3: {"STER": "to_be_verified"}},
        flags=[FlagIn(id=5, sample_id="P-3", type_slug="new_type_4", status="open", title="Waiting on USP 71")],
    ))
    r = client.get("/reports/ready-to-publish")
    assert r.status_code == 200, r.text
    body = r.json()
    ids = [row["sample_id"] for row in body["rows"]]
    assert ids[0] == "P-2" and set(ids) == {"P-1", "P-2", "P-3"}
    by_id = {row["sample_id"]: row for row in body["rows"]}
    assert by_id["P-2"]["sla"]["breached"] is True and by_id["P-2"]["sla"]["color"] == "red"
    assert by_id["P-3"]["reasons"] == ["flag_partial"]
    assert by_id["P-3"]["flags"][0]["label"] == "Ready for Partial Publish"
    assert by_id["P-1"]["analytes"] == ["BPC-157"]
    assert body["totals"] == {"rows": 3, "orders": 2, "all_verified": 2, "flag_ready": 0,
                              "flag_partial": 1, "breached": 2, "held": 0}
    assert [ft["kind"] for ft in body["flag_types"]] == ["flag_ready", "flag_partial", "hold"]
    assert all(row["hold"] is None for row in body["rows"])
    assert body["generated_at"].endswith("Z")


def test_test_orders_excluded_by_default(monkeypatch):
    _use(monkeypatch, _inputs([_sample(1, "P-1"), _sample(2, "P-2")],
                              {1: {"HPLC-PUR": "verified"}, 2: {"HPLC-PUR": "verified"}}),
         test_ids=frozenset({"P-2"}))
    assert [r["sample_id"] for r in client.get("/reports/ready-to-publish").json()["rows"]] == ["P-1"]
    with_test = client.get("/reports/ready-to-publish?include_test_orders=true").json()["rows"]
    assert {r["sample_id"] for r in with_test} == {"P-1", "P-2"}


def test_loader_failure_is_503(monkeypatch):
    _use(monkeypatch, {})

    def _boom(db):
        raise RuntimeError("db down")

    monkeypatch.setattr(main_module, "_load_ready_to_publish_inputs", _boom)
    r = client.get("/reports/ready-to-publish")
    assert r.status_code == 503 and "db down" in r.json()["detail"]


def test_held_rows_are_returned_but_left_out_of_totals(monkeypatch):
    _use(monkeypatch, _inputs(
        [_sample(1, "P-1"), _sample(2, "P-2")],
        {1: {"HPLC-PUR": "verified"}, 2: {"HPLC-PUR": "verified"}},
        flags=[FlagIn(id=9, sample_id="P-2", type_slug="new_type_7", status="open", title="Customer paying")],
    ))
    body = client.get("/reports/ready-to-publish").json()
    by_id = {row["sample_id"]: row for row in body["rows"]}
    assert by_id["P-2"]["hold"]["title"] == "Customer paying"
    assert by_id["P-2"]["hold"]["label"] == "On Hold"
    assert by_id["P-1"]["hold"] is None
    assert body["totals"]["rows"] == 1 and body["totals"]["held"] == 1
    assert body["totals"]["breached"] == 1  # only P-1 counts
