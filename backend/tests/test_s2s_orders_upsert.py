"""POST /s2s/orders/upsert — idempotent order upsert from the integration
service (order-entity Task 3, 2026-08-28). Fixture idiom copied from
test_s2s_shipping_update.py: StaticPool in-memory SQLite + get_db override,
ACCUMK1_INTERNAL_SERVICE_TOKEN patched in per-test via patch.dict, auth via
X-Service-Token header against require_internal_service_token.
"""
import os
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from database import get_db, Base
from models import LimsOrder, LimsSample

SVC_TOKEN = "test-svc-token"
HDR = {"X-Service-Token": SVC_TOKEN}
URL = "/s2s/orders/upsert"


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def client(db_session):
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


def test_rejects_without_service_token(client, db_session):
    body = {"orders": [{
        "wp_order_id": 6344, "order_number": "WP-6344",
        "status": "order-submitted",
        "customer": {"user_id": 3181, "name": "Jane Doe", "email": "j@x.com"},
        "billing": {"city": "Austin", "state": "TX", "country": "US"},
        "shipping": None,
        "wp_created_at": "2026-08-19T23:02:46Z",
        "wp_paid_at": "2026-08-20T00:10:22Z",
        "samples": [],
    }]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body)
    assert r.status_code in (401, 403)


def test_upsert_insert_then_update(client, db_session):
    body = {"orders": [{
        "wp_order_id": 6344, "order_number": "WP-6344",
        "status": "order-submitted",
        "customer": {"user_id": 3181, "name": "Jane Doe", "email": "j@x.com"},
        "billing": {"city": "Austin", "state": "TX", "country": "US"},
        "shipping": None,
        "wp_created_at": "2026-08-19T23:02:46Z",
        "wp_paid_at": "2026-08-20T00:10:22Z",
        "samples": [],
    }]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body, headers=HDR)
        assert r.status_code == 200 and r.json()["upserted"] == 1
        body["orders"][0]["status"] = "sample-received"
        r2 = client.post(URL, json=body, headers=HDR)
    assert r2.status_code == 200
    rows = db_session.query(LimsOrder).filter_by(wp_order_id=6344).all()
    assert len(rows) == 1 and rows[0].status == "sample-received"


def test_upsert_stamps_line_items_and_reports_missing(client, db_session):
    db_session.add(LimsSample(sample_id="P-2289", client_order_number="WP-6344"))
    db_session.commit()
    body = {"orders": [{
        "wp_order_id": 6344, "order_number": "WP-6344", "status": None,
        "customer": None, "billing": None, "shipping": None,
        "wp_created_at": None, "wp_paid_at": None,
        "samples": [
            {"senaite_sample_id": "P-2289", "line_item_ids": [13049, 13052]},
            {"senaite_sample_id": "P-9999", "line_item_ids": [1]},
        ],
    }]}
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=body, headers=HDR)
    assert r.json() == {"upserted": 1, "samples_stamped": 1, "samples_missing": 1,
                        "placeholders_created": 0}  # 2026-09-08: no services on the stamps
    row = db_session.query(LimsSample).filter_by(sample_id="P-2289").one()
    assert row.wc_line_item_ids == [13049, 13052]



# ── 2026-09-08: order upsert seeds native parent placeholders from stamps ──
from unittest.mock import patch as _patch  # noqa: E402

from models import AnalysisProfile, AnalysisService, LimsAnalysis  # noqa: E402
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED  # noqa: E402


def _native_pcr_profile(db):
    svc = AnalysisService(title="Sterility PCR", keyword="STERILITY-PCR", origin="mk1")
    db.add(svc)
    db.commit()
    prof = AnalysisProfile(key="sterility_pcr", name="Sterility PCR", is_addon=True,
                           coa_archetype="limit_table")
    prof.analysis_services.append(svc)
    db.add(prof)
    db.commit()
    return prof


def _order_with_services(sample_id="P-8001", services=None, line_item_ids=None):
    stamp = {"senaite_sample_id": sample_id, "line_item_ids": line_item_ids or []}
    if services is not None:
        stamp["services"] = services
        stamp["package"] = None
    return {"orders": [{"wp_order_id": 8001, "order_number": "WP-8001",
                        "status": "order-submitted", "samples": [stamp]}]}


def _ordered_rows(db, parent_id):
    return db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent_id, lims_sub_sample_pk=None, provenance=PROVENANCE_ORDERED).all()


def test_stamp_with_services_seeds_placeholders(client, db_session):
    _native_pcr_profile(db_session)
    parent = LimsSample(sample_id="P-8001", sample_type="x", status="received")
    db_session.add(parent)
    db_session.commit()
    with _patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}),          _patch("catalog.snapshot.compute_catalog_snapshot", return_value={"profiles": []}):
        r = client.post(URL, json=_order_with_services(services={"sterility_pcr": True}), headers=HDR)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["samples_stamped"] == 1
    assert body["placeholders_created"] == 1
    assert [x.keyword for x in _ordered_rows(db_session, parent.id)] == ["STERILITY-PCR"]


def test_re_upsert_is_idempotent(client, db_session):
    _native_pcr_profile(db_session)
    db_session.add(LimsSample(sample_id="P-8001", sample_type="x", status="received"))
    db_session.commit()
    body = _order_with_services(services={"sterility_pcr": True})
    with _patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}),          _patch("catalog.snapshot.compute_catalog_snapshot", return_value={}):
        client.post(URL, json=body, headers=HDR)
        r = client.post(URL, json=body, headers=HDR)
    assert r.json()["placeholders_created"] == 0
    parent = db_session.query(LimsSample).filter_by(sample_id="P-8001").one()
    assert len(_ordered_rows(db_session, parent.id)) == 1


def test_stamp_without_services_seeds_nothing(client, db_session):
    _native_pcr_profile(db_session)
    parent = LimsSample(sample_id="P-8001", sample_type="x", status="received")
    db_session.add(parent)
    db_session.commit()
    with _patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        r = client.post(URL, json=_order_with_services(), headers=HDR)
    assert r.json()["placeholders_created"] == 0
    assert _ordered_rows(db_session, parent.id) == []


def test_empty_line_item_ids_does_not_clear_existing(client, db_session):
    parent = LimsSample(sample_id="P-8001", sample_type="x", status="received",
                        wc_line_item_ids=[41, 42])
    db_session.add(parent)
    db_session.commit()
    with _patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}):
        client.post(URL, json=_order_with_services(), headers=HDR)
    db_session.refresh(parent)
    assert parent.wc_line_item_ids == [41, 42]


def test_seed_failure_does_not_fail_upsert(client, db_session):
    parent = LimsSample(sample_id="P-8001", sample_type="x", status="received")
    db_session.add(parent)
    db_session.commit()
    with _patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}),          _patch("main.seed_parent_from_services", side_effect=RuntimeError("boom")):
        r = client.post(URL, json=_order_with_services(services={"sterility_pcr": True},
                                                       line_item_ids=[7]), headers=HDR)
    assert r.status_code == 200
    assert r.json()["samples_stamped"] == 1
    assert r.json()["placeholders_created"] == 0
    db_session.refresh(parent)
    assert parent.wc_line_item_ids == [7]


# --- the seed race with the registration-signal seeder (2026-09-21) ---------
# Both seeders write the same parent placeholders concurrently. Whichever
# commits second hits uq_lims_analyses_parent_service_ordered. Seen on the
# priority stack for P-5008 and PB-1002 (2 of 8 native samples): logged as
# order_upsert_seed_FAILED although every placeholder was present.

import logging  # noqa: E402

from sqlalchemy.exc import IntegrityError  # noqa: E402


def _race_once(real_seed, *, winner_seeds: bool):
    """First call: behave as the LOSER of the race (optionally after the
    winner's rows land), raising the unique violation. Later calls: real."""
    calls = {"n": 0}

    def fake(db, *, parent, services, package, source):
        calls["n"] += 1
        if calls["n"] == 1:
            if winner_seeds:
                real_seed(db, parent=parent, services=services, package=package,
                          source="registration_signal")
                db.commit()
            raise IntegrityError("INSERT", {}, Exception(
                'duplicate key value violates unique constraint '
                '"uq_lims_analyses_parent_service_ordered"'))
        return real_seed(db, parent=parent, services=services, package=package, source=source)

    return fake, calls


def test_losing_the_seed_race_is_benign_and_verified(client, db_session, caplog):
    import main
    _native_pcr_profile(db_session)
    parent = LimsSample(sample_id="P-8001", sample_type="x", status="received")
    db_session.add(parent)
    db_session.commit()
    fake, calls = _race_once(main.seed_parent_from_services, winner_seeds=True)
    with _patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
         _patch("catalog.snapshot.compute_catalog_snapshot", return_value={"profiles": []}), \
         _patch("main.seed_parent_from_services", side_effect=fake), \
         caplog.at_level(logging.INFO):
        r = client.post(URL, json=_order_with_services(services={"sterility_pcr": True},
                                                       line_item_ids=[7]), headers=HDR)
    assert r.status_code == 200
    assert calls["n"] == 2                                   # it retried
    # The winner's row is the only one: the retry created nothing.
    assert [x.keyword for x in _ordered_rows(db_session, parent.id)] == ["STERILITY-PCR"]
    assert r.json()["placeholders_created"] == 0
    msgs = " | ".join(rec.getMessage() for rec in caplog.records)
    assert "order_upsert_seed_already_present sample_id=P-8001 created=0 existing=1" in msgs
    assert "order_upsert_seed_failed" not in msgs
    db_session.refresh(parent)
    assert parent.wc_line_item_ids == [7]                    # stamps untouched


def test_retry_creates_what_the_winner_did_not(client, db_session, caplog):
    """Why this retries instead of just relabelling the log: if the rollback
    discarded rows nobody else wrote, "already present" would be a lie."""
    import main
    _native_pcr_profile(db_session)
    parent = LimsSample(sample_id="P-8001", sample_type="x", status="received")
    db_session.add(parent)
    db_session.commit()
    fake, calls = _race_once(main.seed_parent_from_services, winner_seeds=False)
    with _patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
         _patch("catalog.snapshot.compute_catalog_snapshot", return_value={"profiles": []}), \
         _patch("main.seed_parent_from_services", side_effect=fake), \
         caplog.at_level(logging.INFO):
        r = client.post(URL, json=_order_with_services(services={"sterility_pcr": True}), headers=HDR)
    assert r.status_code == 200
    assert [x.keyword for x in _ordered_rows(db_session, parent.id)] == ["STERILITY-PCR"]
    assert r.json()["placeholders_created"] == 1
    assert "created=1 existing=0" in " | ".join(rec.getMessage() for rec in caplog.records)


def test_a_retry_that_also_fails_is_still_reported_as_a_failure(client, db_session, caplog):
    parent = LimsSample(sample_id="P-8001", sample_type="x", status="received")
    db_session.add(parent)
    db_session.commit()
    boom = IntegrityError("INSERT", {}, Exception("uq_lims_analyses_parent_service_ordered"))
    with _patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
         _patch("main.seed_parent_from_services", side_effect=boom), \
         caplog.at_level(logging.INFO):
        r = client.post(URL, json=_order_with_services(services={"sterility_pcr": True}), headers=HDR)
    assert r.status_code == 200                              # never fails the upsert
    msgs = " | ".join(rec.getMessage() for rec in caplog.records)
    assert "order_upsert_seed_failed sample_id=P-8001" in msgs
    assert "already_present" not in msgs



def test_stamp_with_retest_spec_routes_through_apply_retest_spec(client, db_session):
    """A stamp carrying retest_spec must NOT go through the plain seed: the
    retest path filters demand, carries results and stamps lineage."""
    db_session.add(LimsSample(sample_id="P-8002", external_lims_system="mk1", status="sample_due"))
    db_session.commit()
    body = _order_with_services(sample_id="P-8002", services={"hplcpurity_identity": True, "heavy_metals": True})
    spec = {"retest_of_sample_id": "P-2799", "retest": ["hplcpurity_identity"], "carry": ["heavy_metals"],
            "add": None, "auto_checkin": False, "fee": "free", "reason": "t"}
    body["orders"][0]["samples"][0]["retest_spec"] = spec
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
            patch("main.apply_retest_spec", return_value={"applied": True, "carried": 0,
                                                          "missing": [], "demand_keys": []}) as ap, \
            patch("main.seed_parent_from_services") as plain:
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200, r.text
    ap.assert_called_once()
    assert ap.call_args.kwargs["raw_spec"] == spec
    assert ap.call_args.kwargs["parent"].sample_id == "P-8002"
    plain.assert_not_called()


def test_stamp_without_retest_spec_uses_the_plain_seed(client, db_session):
    db_session.add(LimsSample(sample_id="P-8003", external_lims_system="mk1", status="sample_due"))
    db_session.commit()
    body = _order_with_services(sample_id="P-8003", services={"heavy_metals": True})
    with patch.dict(os.environ, {"ACCUMK1_INTERNAL_SERVICE_TOKEN": SVC_TOKEN}), \
            patch("main.apply_retest_spec") as ap, \
            patch("main.seed_parent_from_services", return_value={"created": 0, "existing": 0, "skipped": 0}) as plain:
        r = client.post(URL, json=body, headers=HDR)
    assert r.status_code == 200, r.text
    ap.assert_not_called()
    plain.assert_called_once()
