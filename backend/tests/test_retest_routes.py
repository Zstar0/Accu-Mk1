"""Retest routes: options for the overlay, and the forward to IS."""
import os
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import auth
from database import Base, get_db
from main import app
from models import AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample


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


def _seed(db, hplc_key="hplcpurity_identity"):
    hplc = AnalysisProfile(key=hplc_key, name="HPLC", is_addon=False, active=True)
    hm = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True, active=True, vials_required=2)
    endo = AnalysisProfile(key="endotoxin-usp85-lal", name="Endotoxin", is_addon=True, active=True, vials_required=1)
    dead = AnalysisProfile(key="old-thing", name="Old", is_addon=True, active=False)
    legacy = AnalysisProfile(key="sterility_pcr", name="Sterility (legacy alias)", is_addon=True, active=True)
    # A catalog profile that is NOT flagged is_addon: spec v2 sells the whole
    # active catalog, not just is_addon rows.
    fentanyl = AnalysisProfile(key="fentanyl", name="Fentanyl Screening", is_addon=False,
                               active=True, vials_required=0)
    arsenic = AnalysisService(title="Arsenic", keyword="ARSENIC-PPM", origin="mk1")
    pur = AnalysisService(title="Purity", keyword="HPLC-PURITY", origin="mk1")
    db.add_all([hplc, hm, endo, dead, legacy, fentanyl, arsenic, pur])
    db.flush()
    hm.analysis_services.append(arsenic)
    hplc.analysis_services.append(pur)
    original = LimsSample(sample_id="P-2799", external_lims_system="mk1", status="published",
                          client_order_number="WP-7437",
                          catalog_snapshot={"profiles": [{"key": hplc_key, "profile_id": hplc.id, "service_ids": [pur.id]},
                                                         {"key": "heavy_metals", "profile_id": hm.id, "service_ids": [arsenic.id]}]})
    db.add(original)
    db.flush()
    db.add(LimsAnalysis(lims_sample_pk=original.id, analysis_service_id=arsenic.id, keyword="ARSENIC-PPM",
                        title="Arsenic", provenance="canonical", review_state="published", result_value="9.077",
                        verified_at=datetime(2026, 9, 20, 10, 0, 0)))
    db.add(LimsAnalysis(lims_sample_pk=original.id, analysis_service_id=pur.id, keyword="HPLC-PURITY",
                        title="Purity", provenance="canonical", review_state="parent_to_verify", result_value="99"))
    db.commit()


CONTEXT = {
    "order": {"number": "WP-7437", "placed_at": "2026-09-20T10:00:00Z",
              "customer_name": "Jane Doe", "customer_email": "jane@example.com",
              "total": 285.0, "currency": "USD", "status": "processing",
              "lines": [{"key": "hplc", "label": "HPLC Purity", "price": 85.0}]},
    "retest_fee": {"price": 85.0},
    "addons": {"endotoxin": {"price": 200.0, "vials": 1}},
    "variance": {"point_price": 76.5},
    "pending_retest_orders": [{"order_id": 501, "order_number": "WP-7501", "status": "pending",
                               "total": 85.0, "currency": "USD", "created_at": "2026-09-27T10:00:00Z",
                               "payment_url": "https://accumarklabs.com/checkout/order-pay/501"}],
}


def test_options_lists_profiles_eligibility_addons_and_prices(client, db_session):
    _seed(db_session)
    resp = MagicMock(status_code=200)
    resp.json.return_value = CONTEXT
    with patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}), \
            patch("lims_analyses.retest_routes.requests.get", return_value=resp):
        r = client.get("/api/samples/P-2799/retest-options")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["order_number"] == "WP-7437" and body["status"] == "published"
    by_key = {p["key"]: p for p in body["profiles"]}
    assert by_key["heavy_metals"]["carry_eligible"] is True and by_key["heavy_metals"]["state"] == "published"
    assert by_key["heavy_metals"]["verified_at"] == "2026-09-20T10:00:00"
    assert by_key["heavy_metals"]["state_label"] == "Verified 9/20"
    assert by_key["hplcpurity_identity"]["carry_eligible"] is False
    assert by_key["hplcpurity_identity"]["verified_at"] is None
    assert by_key["hplcpurity_identity"]["state_label"] == "Pending"
    # HM is on the original; old-thing inactive; sterility_pcr is a legacy alias (excluded). Endo is priced (sellable),
    # fentanyl is active catalog but WP has no price for it (not sellable);
    # sellable sorts first.
    addon_keys = [a["key"] for a in body["addons"]]
    assert addon_keys == ["endotoxin-usp85-lal", "fentanyl"]
    [endo, fentanyl] = body["addons"]
    assert endo["price"] == 200.0 and endo["vials"] == 1 and endo["sellable"] is True
    assert fentanyl["price"] is None and fentanyl["sellable"] is False
    assert body["variance"] == {"point_price": 76.5, "allowed": True}
    assert body["prices_available"] is True
    assert body["context"]["order"]["customer_email"] == "jane@example.com"
    assert body["context"]["retest_fee"]["price"] == 85.0
    [pending] = body["context"]["pending_orders"]
    assert pending["order_number"] == "WP-7501" and pending["payment_url"].endswith("/501")


def test_options_prices_addons_keyed_by_native_key(client, db_session):
    """Theme 2.57.1+ keys add-on prices by the native LIMS key, not the old short type."""
    _seed(db_session)
    ctx = dict(CONTEXT, addons={"endotoxin-usp85-lal": {"price": 200.0, "vials": 1}})
    resp = MagicMock(status_code=200)
    resp.json.return_value = ctx
    with (patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}),
          patch("lims_analyses.retest_routes.requests.get", return_value=resp)):
        r = client.get("/api/samples/P-2799/retest-options")
    by_key = {a["key"]: a for a in r.json()["addons"]}
    assert by_key["endotoxin-usp85-lal"]["price"] == 200.0


def test_options_pending_orders_defaults_to_empty_list_when_absent(client, db_session):
    _seed(db_session)
    resp = MagicMock(status_code=200)
    resp.json.return_value = {k: v for k, v in CONTEXT.items() if k != "pending_retest_orders"}
    with patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}), \
            patch("lims_analyses.retest_routes.requests.get", return_value=resp):
        r = client.get("/api/samples/P-2799/retest-options")
    assert r.status_code == 200, r.text
    assert r.json()["context"]["pending_orders"] == []


@pytest.mark.parametrize("hplc_key", ["hplcpurity_identity", "hplc-purity-identity"])
def test_options_variance_allowed_for_either_hplc_key(client, db_session, hplc_key):
    _seed(db_session, hplc_key=hplc_key)
    with patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "", "ACCU_MK1_API_KEY": ""}):
        body = client.get("/api/samples/P-2799/retest-options").json()
    assert body["variance"]["allowed"] is True


def test_options_without_is_still_renders(client, db_session):
    _seed(db_session)
    with patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}), \
            patch("lims_analyses.retest_routes.requests.get", side_effect=ConnectionError("down")):
        r = client.get("/api/samples/P-2799/retest-options")
    assert r.status_code == 200
    body = r.json()
    assert body["prices_available"] is False and body["addons"][0]["price"] is None
    assert body["variance"]["point_price"] is None
    assert body["context"] is None


def test_options_unknown_sample_404(client, db_session):
    assert client.get("/api/samples/P-0000/retest-options").status_code == 404


def _body(**over):
    d = {"retest": ["hplcpurity_identity"], "carry": ["heavy_metals"], "drop": [],
         "add": {"profiles": ["endotoxin-usp85-lal"], "variance_points": 0, "additional_vials": 1},
         "auto_checkin": True, "fee": "paid", "reason": "customer asked"}
    d.update(over)
    return d


def test_retest_request_accepts_drop(client, db_session):
    _seed(db_session)
    resp = MagicMock(status_code=200)
    resp.json.return_value = {"order_id": 1, "order_number": "WP-1", "status": "pending"}
    with patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}), \
            patch("lims_analyses.retest_routes.requests.post", return_value=resp) as post:
        r = client.post("/api/samples/P-2799/retest",
                        json=_body(retest=["hplcpurity_identity"], carry=[], drop=["heavy_metals"]))
    assert r.status_code == 200, r.text
    assert post.call_args.kwargs["json"]["retest_spec"]["drop"] == ["heavy_metals"]


def test_retest_forwards_a_stamped_spec_to_is(client, db_session):
    _seed(db_session)
    resp = MagicMock(status_code=200)
    resp.json.return_value = {"order_id": 7920, "order_number": "WP-7920", "status": "pending",
                              "payment_url": "https://x/pay"}
    with patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}), \
            patch("lims_analyses.retest_routes.requests.post", return_value=resp) as post:
        r = client.post("/api/samples/P-2799/retest", json=_body())
    assert r.status_code == 200, r.text
    assert r.json()["order_number"] == "WP-7920"
    sent = post.call_args.kwargs["json"]
    assert sent["sample_id"] == "P-2799"
    spec = sent["retest_spec"]
    assert spec["retest_of_sample_id"] == "P-2799" and spec["requested_by_user_id"] == 9
    assert spec["requested_at"].endswith("Z") and spec["carry"] == ["heavy_metals"]
    assert post.call_args.args[0] == "http://is/api/service/retest-orders"
    assert post.call_args.kwargs["headers"]["X-API-Key"] == "k"
    # M7: idempotency key over the spec minus requested_at.
    import hashlib
    import json as _json
    body = {k: v for k, v in spec.items() if k != "requested_at"}
    digest = hashlib.sha256(_json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert post.call_args.kwargs["headers"]["Idempotency-Key"] == f"retest:P-2799:{digest[:16]}"


def test_retest_rejects_a_bad_spec_before_calling_is(client, db_session):
    _seed(db_session)
    with patch("lims_analyses.retest_routes.requests.post") as post:
        r = client.post("/api/samples/P-2799/retest", json=_body(carry=["hplcpurity_identity"], retest=["heavy_metals"]))
    assert r.status_code == 400 and "hplcpurity_identity" in r.text
    post.assert_not_called()


def test_retest_502_when_is_fails(client, db_session):
    _seed(db_session)
    bad = MagicMock(status_code=500, text="boom")
    with patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}), \
            patch("lims_analyses.retest_routes.requests.post", return_value=bad):
        r = client.post("/api/samples/P-2799/retest", json=_body())
    assert r.status_code == 502 and r.json()["detail"] == "Integration Service returned 500"


def test_retest_502_unreachable_detail_is_short(client, db_session):
    # M8: transport errors are logged, not echoed to the client.
    _seed(db_session)
    with patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}),             patch("lims_analyses.retest_routes.requests.post", side_effect=OSError("secret-host:5432 refused")):
        r = client.post("/api/samples/P-2799/retest", json=_body())
    assert r.status_code == 502 and r.json()["detail"] == "Integration Service unreachable"


def test_retest_unknown_sample_404(client, db_session):
    assert client.post("/api/samples/P-0000/retest", json=_body()).status_code == 404


def test_options_orders_join_the_minted_retest_sample(client, db_session):
    _seed(db_session)
    db_session.add(LimsSample(sample_id="P-3001", external_lims_system="mk1", status="received",
                              client_order_number="WP-3277", retest_of_sample_id="P-2799"))
    db_session.commit()
    ctx = dict(CONTEXT, retest_orders=[
        {"order_id": 3278, "order_number": "3278", "status": "pending", "total": 85.0, "currency": "USD",
         "created_at": "2026-09-28T10:00:00Z", "paid_at": None,
         "payment_url": "https://x/checkout/order-pay/3278", "kind": "retest"},
        {"order_id": 3277, "order_number": "3277", "status": "processing", "total": 85.0, "currency": "USD",
         "created_at": "2026-09-27T10:00:00Z", "paid_at": "2026-09-27T11:00:00Z",
         "payment_url": None, "kind": "retest"},
    ])
    resp = MagicMock(status_code=200)
    resp.json.return_value = ctx
    with patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}),             patch("lims_analyses.retest_routes.requests.get", return_value=resp):
        body = client.get("/api/samples/P-2799/retest-options").json()
    [pending, paid] = body["context"]["orders"]
    assert pending["order_id"] == 3278 and pending["sample_id"] is None and pending["sample_status"] is None
    assert paid["order_id"] == 3277 and paid["sample_id"] == "P-3001" and paid["sample_status"] == "received"
    assert paid["kind"] == "retest" and paid["paid_at"] == "2026-09-27T11:00:00Z"


def test_options_orders_default_to_empty_list_when_absent(client, db_session):
    _seed(db_session)
    resp = MagicMock(status_code=200)
    resp.json.return_value = CONTEXT
    with patch.dict(os.environ, {"INTEGRATION_SERVICE_URL": "http://is", "ACCU_MK1_API_KEY": "k"}),             patch("lims_analyses.retest_routes.requests.get", return_value=resp):
        body = client.get("/api/samples/P-2799/retest-options").json()
    assert body["context"]["orders"] == []
