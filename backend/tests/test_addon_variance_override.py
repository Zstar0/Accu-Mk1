"""Task 4: the lab override at check-in refuses a Variance entry for the
four add-on tests that Mk1 cannot run, before anything is stored. A map
with only HPLC or legacy keys behaves exactly as today (never calls IS)."""
import json

import pytest

from models import LimsSample
from sub_samples import service as sub_service
from tests.test_variance_demand import (  # noqa: F401 (fixtures)
    ENDO85_KEY, HM_KEY, _lite_catalog, _lite_parent, lite, lite_client)

PREVIOUS = '{"hplcpurity_identity": 3}'


def _order(monkeypatch, services):
    calls = []

    def fake(sid):
        calls.append(sid)
        return {"services": services, "wp_order_number": "WP-T4"}
    monkeypatch.setattr(sub_service, "fetch_sample_services", fake)
    return calls


def _parent(db, sample_id, **kw):
    _lite_catalog(db)
    parent = _lite_parent(db, sample_id, 0, **kw)
    parent.variance_override = PREVIOUS
    db.commit()
    return parent


def _stored(db, sample_id):
    db.expire_all()
    return db.query(LimsSample).filter_by(sample_id=sample_id).one().variance_override


# --- characterization (passes before the change) ---


def test_override_legacy_keys_unchanged(lite, monkeypatch):
    _parent(lite, "ZZT4-LEG")
    calls = _order(monkeypatch, {ENDO85_KEY: True})
    out = sub_service.set_variance_override(
        lite, "ZZT4-LEG", {"hplcpurity_identity": 3, "endotoxin": 1})
    assert out == {"hplcpurity_identity": 3}
    assert json.loads(_stored(lite, "ZZT4-LEG")) == {"hplcpurity_identity": 3}
    assert calls == []


# --- the change ---


def test_override_accepts_valid_four_key_map(lite, monkeypatch):
    _parent(lite, "ZZT4-OK")
    _order(monkeypatch, {ENDO85_KEY: True})
    out = sub_service.set_variance_override(lite, "ZZT4-OK", {ENDO85_KEY: 3})
    assert out == {ENDO85_KEY: 3}
    assert _stored(lite, "ZZT4-OK") == '{"endotoxin-usp85-lal": 3}'


def test_override_refuses_test_not_on_sample(lite, monkeypatch):
    _parent(lite, "ZZT4-NOT")
    _order(monkeypatch, {ENDO85_KEY: True})
    with pytest.raises(sub_service.VarianceOverrideError, match="not on this sample"):
        sub_service.set_variance_override(lite, "ZZT4-NOT", {HM_KEY: 2})
    assert _stored(lite, "ZZT4-NOT") == PREVIOUS


@pytest.mark.parametrize("n", [1, 11])
def test_override_refuses_n_out_of_range(lite, monkeypatch, n):
    _parent(lite, f"ZZT4-N{n}")
    _order(monkeypatch, {ENDO85_KEY: True})
    with pytest.raises(sub_service.VarianceOverrideError, match="whole number from 2 to 10"):
        sub_service.set_variance_override(lite, f"ZZT4-N{n}", {ENDO85_KEY: n})
    assert _stored(lite, f"ZZT4-N{n}") == PREVIOUS


def test_override_refuses_when_order_lookup_fails(lite, monkeypatch):
    _parent(lite, "ZZT4-IS")

    def boom(sid):
        raise RuntimeError("IS down")
    monkeypatch.setattr(sub_service, "fetch_sample_services", boom)
    with pytest.raises(sub_service.VarianceOverrideError, match="the order lookup failed"):
        sub_service.set_variance_override(lite, "ZZT4-IS", {ENDO85_KEY: 2})
    assert _stored(lite, "ZZT4-IS") == PREVIOUS


def test_override_refuses_when_order_not_found(lite, monkeypatch):
    _parent(lite, "ZZT4-404")
    monkeypatch.setattr(sub_service, "fetch_sample_services", lambda sid: None)
    with pytest.raises(sub_service.VarianceOverrideError, match="the order lookup failed"):
        sub_service.set_variance_override(lite, "ZZT4-404", {ENDO85_KEY: 2})
    assert _stored(lite, "ZZT4-404") == PREVIOUS


def test_override_refuses_four_key_on_senaite_born_sample(lite, monkeypatch):
    _parent(lite, "ZZT4-SEN", native=False)
    _order(monkeypatch, {ENDO85_KEY: True})
    with pytest.raises(sub_service.VarianceOverrideError, match="Mk1-native sample"):
        sub_service.set_variance_override(lite, "ZZT4-SEN", {ENDO85_KEY: 2})
    assert _stored(lite, "ZZT4-SEN") == PREVIOUS


def test_override_refuses_four_key_on_retest_sample(lite, monkeypatch):
    # R3: the resolver only notes a retest; the override path refuses it.
    parent = _parent(lite, "ZZT4-RT")
    parent.is_retest = True
    lite.commit()
    _order(monkeypatch, {ENDO85_KEY: True})
    with pytest.raises(sub_service.VarianceOverrideError, match="not carried to a retest"):
        sub_service.set_variance_override(lite, "ZZT4-RT", {ENDO85_KEY: 2})
    assert _stored(lite, "ZZT4-RT") == PREVIOUS


def test_override_refusal_names_every_bad_entry(lite, monkeypatch):
    _parent(lite, "ZZT4-TWO")
    _order(monkeypatch, {ENDO85_KEY: True})
    with pytest.raises(sub_service.VarianceOverrideError) as ei:
        sub_service.set_variance_override(
            lite, "ZZT4-TWO", {"hplcpurity_identity": 3, ENDO85_KEY: 11, HM_KEY: 2})
    msg = str(ei.value)
    assert f"Variance for {ENDO85_KEY}: " in msg and f"Variance for {HM_KEY}: " in msg
    assert "; " in msg
    assert _stored(lite, "ZZT4-TWO") == PREVIOUS


def test_override_lock_check_stays_first(lite, monkeypatch):
    from datetime import datetime
    parent = _parent(lite, "ZZT4-LOCK")
    parent.variance_locked_at = datetime(2026, 11, 10)
    lite.commit()
    calls = _order(monkeypatch, {ENDO85_KEY: True})
    with pytest.raises(sub_service.VarianceLockedError):
        sub_service.set_variance_override(lite, "ZZT4-LOCK", {HM_KEY: 2})
    assert calls == []


def test_override_refused_when_locked_during_order_lookup(lite, monkeypatch):
    # Lock race: another request locks the set while the IS lookup runs.
    # Raw SQL with no commit through this session, so the in-memory parent
    # stays stale (unlocked): only a fresh re-read before the write sees it.
    from sqlalchemy import text
    parent = _parent(lite, "ZZT4-RACE")
    pk = parent.id

    def lock_then_answer(sid):
        lite.execute(text("UPDATE lims_samples SET variance_locked_at = '2026-11-10 12:00:00' "
                          "WHERE id = :id"), {"id": pk})
        return {"services": {ENDO85_KEY: True}}
    monkeypatch.setattr(sub_service, "fetch_sample_services", lock_then_answer)
    with pytest.raises(sub_service.VarianceLockedError, match="ZZT4-RACE is locked"):
        sub_service.set_variance_override(lite, "ZZT4-RACE", {ENDO85_KEY: 2})
    assert _stored(lite, "ZZT4-RACE") == PREVIOUS


def test_put_override_route_returns_422(lite, lite_client, monkeypatch):
    _parent(lite, "ZZT4-RTE")
    _order(monkeypatch, {ENDO85_KEY: True})
    resp = lite_client.put("/api/sub-samples/ZZT4-RTE/variance-override",
                           json={"variance": {HM_KEY: 2}})
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "variance_override_invalid"
    assert "not on this sample" in detail["message"]
    assert _stored(lite, "ZZT4-RTE") == PREVIOUS
