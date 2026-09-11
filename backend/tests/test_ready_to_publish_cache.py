"""Ready to Publish cache (2026-09-11): TTL, publish invalidation, and the
summary route reading through the same cache as the full report."""
from datetime import datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main as main_module
import ready_to_publish_cache as cache
from auth import get_current_user
from database import get_db
from main import app
from ready_to_publish import FlagTypeIn, SampleIn, TierIn
from sla_engine import BusinessSchedule
from datetime import time

client = TestClient(app)
SCHEDULE = BusinessSchedule(open_time=time(9, 0), close_time=time(17, 0), timezone="America/Los_Angeles",
                            working_days=frozenset({0, 1, 2, 3, 4}))


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.invalidate()
    yield
    cache.invalidate()


def test_get_or_build_serves_within_ttl_and_rebuilds_after():
    calls = []
    build = lambda: calls.append(1) or {"n": len(calls)}
    assert cache.get_or_build(False, build, now=0.0) == {"n": 1}
    assert cache.get_or_build(False, build, now=cache.TTL_SECONDS - 1) == {"n": 1}
    assert cache.get_or_build(True, build, now=1.0) == {"n": 2}       # variants are separate
    assert cache.get_or_build(False, build, now=cache.TTL_SECONDS + 1) == {"n": 3}


def test_invalidate_forces_rebuild():
    calls = []
    build = lambda: calls.append(1) or len(calls)
    assert cache.get_or_build(False, build, now=0.0) == 1
    cache.invalidate()
    assert cache.get_or_build(False, build, now=1.0) == 2


def _use(monkeypatch, counter):
    def _inputs(db):
        counter.append(1)
        return {
            "samples": [SampleIn(pk=1, sample_id="P-1", status="verified", order="7001", client="Acme",
                                 email="lab@acme.test", date_received=datetime(2026, 9, 8, 16, 0), lot="L1",
                                 analytes=("BPC-157 - Identity (HPLC)",))],
            "line_states_by_pk": {1: {"HPLC-PUR": "verified"}},
            "flags": [], "flag_types": [FlagTypeIn(slug="new_type_3", label="Ready for Publish", color="#088000")],
            "priorities": {}, "services_of": {},
            "tiers": [TierIn(id=1, name="Standard", target_minutes=1440, is_default=True)],
            "groups": [], "schedule": SCHEDULE, "holidays": frozenset(),
        }
    def _fake_db():
        yield MagicMock()
    monkeypatch.setitem(app.dependency_overrides, get_current_user, lambda: MagicMock(id=1, email="lab@x"))
    monkeypatch.setitem(app.dependency_overrides, get_db, _fake_db)
    monkeypatch.setattr(main_module, "_load_ready_to_publish_inputs", _inputs)
    monkeypatch.setattr(main_module, "_test_order_senaite_ids", lambda: set())


def test_summary_requires_auth():
    assert client.get("/reports/ready-to-publish/summary").status_code == 401


def test_summary_and_report_share_one_build(monkeypatch):
    built = []
    _use(monkeypatch, built)
    s = client.get("/reports/ready-to-publish/summary")
    assert s.status_code == 200, s.text
    assert set(s.json()) == {"generated_at", "totals"}
    assert s.json()["totals"]["rows"] == 1
    r = client.get("/reports/ready-to-publish")
    assert r.status_code == 200 and r.json()["totals"] == s.json()["totals"]
    assert len(built) == 1, "second call must come from the cache"
    # A different variant is its own build.
    client.get("/reports/ready-to-publish/summary?include_test_orders=true")
    assert len(built) == 2


def test_publish_clears_the_cache(monkeypatch):
    built = []
    _use(monkeypatch, built)
    client.get("/reports/ready-to-publish/summary")
    assert len(built) == 1
    # The publish helper never raises and clears the cache first thing, even
    # when the rest of its body cannot run against a MagicMock session.
    main_module._after_publish_native(MagicMock(), sample_id="P-1", pre_publish_status="verified",
                                      actor_user_id=1, senaite_actual_state="published")
    client.get("/reports/ready-to-publish/summary")
    assert len(built) == 2
