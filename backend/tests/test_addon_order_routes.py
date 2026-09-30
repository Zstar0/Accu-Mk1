"""Same-sample add-on order route (spec 2026-09-29-addon-same-sample)."""
import hashlib
import json
import os
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import auth
from database import Base, get_db
from main import app
from models import AnalysisProfile, AnalysisService, LimsSample, LimsSubSampleEvent

ENV = {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}


class _FakeUser:
    id = 9
    email = "josh@accumark.test"


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


@pytest.fixture
def client(db_session):
    app.dependency_overrides[get_db] = lambda: (yield db_session)
    app.dependency_overrides[auth.get_current_user] = lambda: _FakeUser()
    yield TestClient(app)
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(auth.get_current_user, None)


def _seed(db, status="in_progress"):
    pur = AnalysisService(title="Purity", keyword="HPLC-PURITY", origin="mk1")
    ster = AnalysisService(title="Sterility", keyword="STERILITY-USP71", origin="mk1")
    old = AnalysisService(title="Legacy", keyword="LEGACY-X", origin="senaite")
    hplc = AnalysisProfile(key="hplc-purity-identity", name="HPLC", is_addon=False, active=True)
    usp71 = AnalysisProfile(key="sterility-usp71", name="Sterility USP-71", is_addon=False, active=True)
    dead = AnalysisProfile(key="old-thing", name="Old", is_addon=False, active=False)
    legacy = AnalysisProfile(key="legacy-thing", name="Legacy", is_addon=False, active=True)
    db.add_all([pur, ster, old, hplc, usp71, dead, legacy])
    db.flush()
    hplc.analysis_services.append(pur)
    usp71.analysis_services.append(ster)
    dead.analysis_services.append(ster)
    legacy.analysis_services.append(old)
    db.add(LimsSample(sample_id="P-5191", external_lims_system="mk1", status=status,
                      client_order_number="WP-8600",
                      catalog_snapshot={"profiles": [{"key": "hplc-purity-identity", "profile_id": hplc.id,
                                                      "service_ids": [pur.id]}]}))
    db.commit()


def _body(**over):
    d = {"profiles": ["sterility-usp71"], "variance_points": 0, "additional_vials": 1,
         "fee": "free", "reason": "lab wants USP-71 on the running sample"}
    d.update(over)
    return d


IS_OK = {"order_id": 8611, "order_number": "8611", "status": "completed", "payment_url": None, "total": 0.0}


def _post(client, body, resp_json=IS_OK, status_code=200):
    resp = MagicMock(status_code=status_code, text="x")
    resp.json.return_value = resp_json
    with patch.dict(os.environ, ENV), \
            patch("lims_analyses.retest_routes.requests.post", return_value=resp) as post:
        r = client.post("/api/samples/P-5191/addon-order", json=body)
    return r, post


def test_forwards_body_and_idempotency_key(client, db_session):
    _seed(db_session)
    r, post = _post(client, _body())
    assert r.status_code == 200, r.text
    assert r.json() == IS_OK
    assert post.call_args.args[0] == "http://is/api/service/addon-orders"
    sent = post.call_args.kwargs["json"]
    assert sent["sample_id"] == "P-5191" and sent["profiles"] == ["sterility-usp71"]
    assert sent["fee"] == "free" and sent["additional_vials"] == 1 and sent["variance_points"] == 0
    assert sent["requested_by_user_id"] == 9 and sent["requested_at"].endswith("Z")
    assert sent["reason"].startswith("lab wants")
    headers = post.call_args.kwargs["headers"]
    assert headers["X-API-Key"] == "k"
    body = {k: v for k, v in sent.items() if k != "requested_at"}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert headers["Idempotency-Key"] == f"addon:P-5191:{digest[:16]}"


def test_success_stores_order_on_snapshot_and_emits_event(client, db_session):
    _seed(db_session)
    r, _ = _post(client, _body())
    assert r.status_code == 200
    db_session.expire_all()
    s = db_session.execute(select(LimsSample).where(LimsSample.sample_id == "P-5191")).scalar_one()
    [entry] = s.catalog_snapshot["addon_orders"]
    assert entry["order_id"] == 8611 and entry["order_number"] == "8611"
    assert entry["status"] == "completed" and entry["profiles"] == ["sterility-usp71"]
    assert entry["fee"] == "free" and entry["requested_at"].endswith("Z")
    # profiles untouched
    assert [p["key"] for p in s.catalog_snapshot["profiles"]] == ["hplc-purity-identity"]
    [ev] = db_session.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.event == "addon_order_requested")).scalars().all()
    assert ev.lims_sample_pk == s.id and ev.user_id == 9
    assert "8611" in ev.details["label"] and "Sterility USP-71" in ev.details["label"]
    assert not any(ord(c) in (0x2013, 0x2014) for c in ev.details["label"])


def test_snapshot_rewritten_during_is_call_is_not_overwritten(client, db_session):
    """A waived order is applied inside the IS round-trip (WP -> IS -> Mk1 s2s):
    the route must reload the sample and keep the applied flag and profiles."""
    _seed(db_session)
    resp = MagicMock(status_code=200)
    resp.json.return_value = IS_OK

    def during_is_call(*_a, **_k):
        # Rewrite the row underneath the ORM object (what the s2s apply does in
        # its own transaction): a core UPDATE bypasses the identity map, so the
        # route's in-memory sample is now stale.
        from sqlalchemy import update
        current = db_session.execute(select(LimsSample.catalog_snapshot).where(
            LimsSample.sample_id == "P-5191")).scalar_one() or {}
        snap = dict(current)
        snap["profiles"] = [*snap.get("profiles", []), {"key": "sterility-usp71", "name": "Sterility USP 71"}]
        snap["addon_orders"] = [{"order_id": 8611, "order_number": "8611", "status": "completed",
                                 "profiles": ["sterility-usp71"], "fee": "free", "applied": True}]
        db_session.execute(update(LimsSample).where(LimsSample.sample_id == "P-5191").values(catalog_snapshot=snap))
        db_session.flush()
        return resp

    with (patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}),
          patch("lims_analyses.retest_routes.requests.post", side_effect=during_is_call)):
        r = client.post("/api/samples/P-5191/addon-order", json=_body())
    assert r.status_code == 200, r.text
    db_session.expire_all()
    s = db_session.execute(select(LimsSample).where(LimsSample.sample_id == "P-5191")).scalar_one()
    [entry] = s.catalog_snapshot["addon_orders"]
    assert entry["applied"] is True
    assert "sterility-usp71" in [p["key"] for p in s.catalog_snapshot["profiles"]]


def test_same_order_id_replaces_entry(client, db_session):
    _seed(db_session)
    _post(client, _body())
    _post(client, _body(), resp_json={**IS_OK, "status": "processing"})
    db_session.expire_all()
    s = db_session.execute(select(LimsSample).where(LimsSample.sample_id == "P-5191")).scalar_one()
    [entry] = s.catalog_snapshot["addon_orders"]
    assert entry["status"] == "processing"


def test_null_snapshot_gets_addon_orders_only(client, db_session):
    _seed(db_session)
    s = db_session.execute(select(LimsSample).where(LimsSample.sample_id == "P-5191")).scalar_one()
    s.catalog_snapshot = None
    db_session.commit()
    r, _ = _post(client, _body())
    assert r.status_code == 200, r.text
    db_session.expire_all()
    assert "profiles" not in s.catalog_snapshot and len(s.catalog_snapshot["addon_orders"]) == 1


@pytest.mark.parametrize("body, needle", [
    (_body(profiles=["nope"]), "unknown"),
    (_body(profiles=["old-thing"]), "inactive"),
    (_body(profiles=["legacy-thing"]), "native"),
    (_body(profiles=["hplc-purity-identity"]), "already on"),
    (_body(profiles=[], variance_points=0), "nothing selected"),
    (_body(profiles=[], variance_points=2), "variance is sold through a retest; use the Re-test tab"),
    (_body(variance_points=1), "variance is sold through a retest; use the Re-test tab"),
])
def test_validation_400s_never_call_is(client, db_session, body, needle):
    _seed(db_session)
    r, post = _post(client, body)
    assert r.status_code == 400 and needle in r.json()["detail"], r.text
    post.assert_not_called()


def test_offer_list_excludes_profiles_with_live_parent_rows(client, db_session):
    """retest-options must not offer what the add-on route would refuse."""
    from lims_analyses.manage_native import add_profile_to_parent
    _seed(db_session)
    s = db_session.execute(select(LimsSample).where(LimsSample.sample_id == "P-5191")).scalar_one()
    usp71 = db_session.execute(select(AnalysisProfile).where(
        AnalysisProfile.key == "sterility-usp71")).scalar_one()
    add_profile_to_parent(db_session, parent=s, profile=usp71, user_id=None)
    db_session.commit()
    resp = MagicMock(status_code=200)
    resp.json.return_value = {"addons": {}, "variance": {"point_price": None}}
    with (patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}),
          patch("lims_analyses.retest_routes.requests.get", return_value=resp)):
        r = client.get("/api/samples/P-5191/retest-options")
    assert r.status_code == 200, r.text
    assert "sterility-usp71" not in [a["key"] for a in r.json()["addons"]]


def test_profile_with_live_parent_rows_is_already_on(client, db_session):
    """Added by the lab via Manage Analyses (not in the snapshot): still refused."""
    from lims_analyses.manage_native import add_profile_to_parent
    _seed(db_session)
    s = db_session.execute(select(LimsSample).where(LimsSample.sample_id == "P-5191")).scalar_one()
    usp71 = db_session.execute(select(AnalysisProfile).where(
        AnalysisProfile.key == "sterility-usp71")).scalar_one()
    add_profile_to_parent(db_session, parent=s, profile=usp71, user_id=None)
    db_session.commit()
    r, post = _post(client, _body())
    assert r.status_code == 400
    assert r.json()["detail"] == "profile 'sterility-usp71' is already on P-5191"
    post.assert_not_called()


def test_published_sample_400(client, db_session):
    _seed(db_session, status="published")
    r, post = _post(client, _body())
    assert r.status_code == 400
    assert r.json()["detail"] == "sample is published; use the retest route"
    post.assert_not_called()


def test_reason_required(client, db_session):
    _seed(db_session)
    body = _body()
    del body["reason"]
    r, post = _post(client, body)
    assert r.status_code == 422
    r, post = _post(client, _body(reason=""))
    assert r.status_code == 422
    post.assert_not_called()


def test_fee_must_be_paid_or_free(client, db_session):
    _seed(db_session)
    r, post = _post(client, _body(fee="gratis"))
    assert r.status_code == 422
    post.assert_not_called()


def _stored_orders(db_session):
    db_session.expire_all()
    s = db_session.execute(select(LimsSample).where(LimsSample.sample_id == "P-5191")).scalar_one()
    return s.catalog_snapshot.get("addon_orders")


def test_is_error_4xx_relayed_5xx_502_and_stores_nothing(client, db_session):
    _seed(db_session)
    r, _ = _post(client, _body(), status_code=409, resp_json={
        "detail": {"code": "already_on_sample", "message": "sterility-usp71 is already on P-5191"}})
    assert r.status_code == 409 and r.json()["detail"] == "sterility-usp71 is already on P-5191"
    assert _stored_orders(db_session) is None
    r, _ = _post(client, _body(), status_code=400, resp_json={"detail": "invalid_profile"})
    assert r.status_code == 400 and r.json()["detail"] == "invalid_profile"
    r, _ = _post(client, _body(), status_code=500)
    assert r.status_code == 502 and r.json()["detail"] == "Integration Service returned 500"
    assert _stored_orders(db_session) is None


def test_is_4xx_non_json_falls_back_to_raw_text(client, db_session):
    _seed(db_session)
    resp = MagicMock(status_code=404, text="sample in no order")
    resp.json.side_effect = ValueError("not json")
    with patch.dict(os.environ, ENV), patch("lims_analyses.retest_routes.requests.post", return_value=resp):
        r = client.post("/api/samples/P-5191/addon-order", json=_body())
    assert r.status_code == 404 and r.json()["detail"] == "sample in no order"


@pytest.mark.parametrize("status", ["cancelled", "rejected"])
def test_terminal_sample_400(client, db_session, status):
    _seed(db_session, status=status)
    r, post = _post(client, _body())
    assert r.status_code == 400 and r.json()["detail"] == f"sample is {status}; use the retest route"
    post.assert_not_called()


def test_replayed_create_logs_one_event(client, db_session):
    _seed(db_session)
    _post(client, _body())
    _post(client, _body())
    assert len(db_session.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.event == "addon_order_requested")).scalars().all()) == 1


def test_options_staff_addon_without_mk1_entry_applied_from_wp_status(client, db_session):
    _seed(db_session)
    ctx = {"order": None, "retest_fee": None, "addons": {}, "variance": {},
           "retest_orders": [
               {"order_id": 9001, "kind": "addon", "same_sample": True, "status": "pending"},
               {"order_id": 9002, "kind": "addon", "same_sample": True, "status": "processing"},
               {"order_id": 9003, "kind": "addon", "same_sample": True, "status": "completed"}]}
    resp = MagicMock(status_code=200)
    resp.json.return_value = ctx
    with patch.dict(os.environ, ENV), patch("lims_analyses.retest_routes.requests.get", return_value=resp):
        a, b, c = client.get("/api/samples/P-5191/retest-options").json()["context"]["orders"]
    assert a["applied"] is False and b["applied"] is True and c["applied"] is True


def test_reprovision_keeps_addon_orders(db_session, monkeypatch):
    from types import SimpleNamespace
    s = LimsSample(sample_id="P-7000", status="received",
                   catalog_snapshot={"profiles": [], "addon_orders": [{"order_id": 1, "applied": True}]})
    db_session.add(s)
    db_session.commit()
    admin = SimpleNamespace(id=7, role="admin", email="a@test")
    app.dependency_overrides[get_db] = lambda: (yield db_session)
    app.dependency_overrides[auth.get_current_user] = lambda: admin
    app.dependency_overrides[auth.require_admin] = lambda: admin
    monkeypatch.setattr("sub_samples.service.fetch_sample_services",
                        lambda _sid: {"services": {"x": True}, "package": None})
    try:
        r = TestClient(app).post("/lims-samples/P-7000/reprovision-snapshot")
    finally:
        for dep in (get_db, auth.get_current_user, auth.require_admin):
            app.dependency_overrides.pop(dep, None)
    assert r.status_code == 200, r.text
    snap = r.json()["catalog_snapshot"]
    assert snap["addon_orders"] == [{"order_id": 1, "applied": True}] and "resolved_at" in snap


def test_is_unreachable_502(client, db_session):
    _seed(db_session)
    with patch.dict(os.environ, ENV), \
            patch("lims_analyses.retest_routes.requests.post", side_effect=OSError("host:1 refused")):
        r = client.post("/api/samples/P-5191/addon-order", json=_body())
    assert r.status_code == 502 and r.json()["detail"] == "Integration Service unreachable"


def test_unknown_sample_404(client, db_session):
    assert client.post("/api/samples/P-0000/addon-order", json=_body()).status_code == 404


def test_options_marks_same_sample_orders_and_published_flag(client, db_session):
    _seed(db_session)
    s = db_session.execute(select(LimsSample).where(LimsSample.sample_id == "P-5191")).scalar_one()
    s.catalog_snapshot = {**s.catalog_snapshot, "addon_orders": [
        {"order_id": 8611, "order_number": "8611", "status": "completed", "profiles": ["sterility-usp71"],
         "fee": "free", "requested_at": "2026-09-29T10:00:00Z", "applied": True},
        {"order_id": 8612, "order_number": "8612", "status": "pending", "profiles": ["sterility-usp71"],
         "fee": "paid", "requested_at": "2026-09-29T11:00:00Z"}]}
    db_session.commit()
    ctx = {"order": None, "retest_fee": None, "addons": {}, "variance": {},
           "retest_orders": [{"order_id": "8611", "kind": "addon"}, {"order_id": 8612, "kind": "addon"},
                             {"order_id": 3277, "kind": "retest"}]}
    resp = MagicMock(status_code=200)
    resp.json.return_value = ctx
    with patch.dict(os.environ, ENV), patch("lims_analyses.retest_routes.requests.get", return_value=resp):
        body = client.get("/api/samples/P-5191/retest-options").json()
    assert body["original_published"] is False
    a, b, c = body["context"]["orders"]
    assert a["same_sample"] is True and a["applied"] is True
    assert b["same_sample"] is True and b["applied"] is False
    assert "same_sample" not in c


def test_options_original_published_without_is(client, db_session):
    _seed(db_session, status="published")
    with patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "", "ACCU_MK1_API_KEY": ""}):
        body = client.get("/api/samples/P-5191/retest-options").json()
    assert body["original_published"] is True and body["context"] is None


def test_addon_orders_only_snapshot_still_gets_frozen_by_order_seed(db_session):
    """A dict holding only addon_orders is not a freeze: the registration seed
    still stamps profiles, and keeps addon_orders."""
    from lims_analyses.order_seed import seed_parent_from_services
    _seed(db_session)
    s = db_session.execute(select(LimsSample).where(LimsSample.sample_id == "P-5191")).scalar_one()
    s.catalog_snapshot = {"addon_orders": [{"order_id": 1}]}
    frozen = {"resolved_at": "t", "profiles": [{"key": "x"}]}
    with patch("catalog.snapshot.compute_catalog_snapshot", return_value=frozen), \
            patch("lims_analyses.order_seed.seed_parent_placeholders",
                  return_value={"created": 0, "existing": 0, "skipped": 0}):
        seed_parent_from_services(db_session, parent=s, services={}, package=None, source="test")
    assert s.catalog_snapshot["profiles"] == [{"key": "x"}]
    assert s.catalog_snapshot["addon_orders"] == [{"order_id": 1}]


def test_activity_label_for_addon_events():
    from main import retest_activity_label
    assert retest_activity_label("addon_services_applied", {"label": "Services added"}) == "Services added"
    assert retest_activity_label("addon_order_requested", {"label": "Add-on order 1"}) == "Add-on order 1"
