"""POST /s2s/lims-samples/{sample_id}/services (spec 2026-09-29-addon-same-sample)."""
import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database import Base, get_db
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED
from main import app
from models import (
    AnalysisProfile,
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    LimsSubSampleEvent,
    VialProfileAssignment,
)

TOKEN = {"ACCUMK1_INTERNAL_SERVICE_TOKEN": "svc-test"}
HDR = {"X-Service-Token": "svc-test"}


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
    with patch.dict(os.environ, TOKEN):
        yield TestClient(app)
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def world(db_session):
    db = db_session
    pur = AnalysisService(title="Purity", keyword="HPLC-PURITY", origin="mk1")
    kf = AnalysisService(title="Residual Moisture", keyword="MOISTURE-KF", origin="mk1")
    old = AnalysisService(title="Legacy", keyword="LEGACY-X", origin="senaite")
    hplc = AnalysisProfile(key="hplc-purity-identity", name="HPLC", is_addon=False, active=True)
    moist = AnalysisProfile(key="moisture", name="Residual Moisture", is_addon=True,
                            fulfillment_role="kf", fulfillment_dim="role", vials_required=1, active=True)
    legacy = AnalysisProfile(key="legacy-thing", name="Legacy", is_addon=False, active=True)
    db.add_all([pur, kf, old, hplc, moist, legacy])
    db.flush()
    hplc.analysis_services.append(pur)
    moist.analysis_services.append(kf)
    legacy.analysis_services.append(old)
    parent = LimsSample(sample_id="P-5191", external_lims_system="mk1", status="received",
                        client_order_number="WP-8600",
                        catalog_snapshot={
                            "profiles": [{"key": "hplc-purity-identity", "profile_id": hplc.id,
                                          "service_ids": [pur.id]}],
                            "addon_orders": [{"order_id": 8611, "order_number": "8611", "status": "completed",
                                              "profiles": ["moisture"], "fee": "free",
                                              "requested_at": "2026-09-29T10:00:00Z"}]})
    db.add(parent)
    db.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://p5191-s04",
                         sample_id="P-5191-S04", vial_sequence=4, assignment_role="kf")
    db.add(vial)
    db.commit()
    return {"parent": parent, "moist": moist, "kf": kf, "vial": vial}


def _body(**over):
    d = {"services": {"hplc-purity-identity": True, "moisture": True, "legacy-thing": True,
                      "no-such-key": True, "heavy_metals": False},
         "variance_value": None, "event_id": "evt-1", "order_id": 8611}
    d.update(over)
    return d


def _post(client, body, headers=HDR):
    return client.post("/s2s/lims-samples/P-5191/services", json=body, headers=headers)


def _parent(db):
    db.expire_all()
    return db.execute(select(LimsSample).where(LimsSample.sample_id == "P-5191")).scalar_one()


def test_adds_new_native_profile_skips_existing_ignores_unknown(client, db_session, world):
    r = _post(client, _body())
    assert r.status_code == 200, r.text
    assert r.json() == {"added": ["moisture"], "skipped": ["hplc-purity-identity"],
                        "ignored": ["legacy-thing", "no-such-key"]}
    p = _parent(db_session)
    # placeholder + host edge + vial row via add_profile_to_parent
    assert db_session.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == p.id, LimsAnalysis.provenance == PROVENANCE_ORDERED,
        LimsAnalysis.analysis_service_id == world["kf"].id)).scalars().first() is not None
    assert db_session.execute(select(VialProfileAssignment).where(
        VialProfileAssignment.lims_sub_sample_pk == world["vial"].id)).scalars().first() is not None
    # snapshot refreshed in the builder's shape
    snap = p.catalog_snapshot
    entry = next(e for e in snap["profiles"] if e["key"] == "moisture")
    assert entry["profile_id"] == world["moist"].id and entry["service_ids"] == [world["kf"].id]
    assert entry["fulfillment_role"] == "kf" and entry["vials_required"] == 1
    assert "ride_host_roles" in entry and "analytical_vials" in entry
    [order] = snap["addon_orders"]
    assert order["applied"] is True
    [ev] = db_session.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.event == "addon_services_applied")).scalars().all()
    assert ev.details["label"] == "Services added from WP order 8611: Residual Moisture (waived)"
    assert ev.details["added"] == ["moisture"] and ev.details["event_id"] == "evt-1"


def test_replay_is_idempotent(client, db_session, world):
    assert _post(client, _body()).status_code == 200
    r = _post(client, _body())
    assert r.status_code == 200
    assert r.json()["added"] == [] and "moisture" in r.json()["skipped"]
    p = _parent(db_session)
    assert [e["key"] for e in p.catalog_snapshot["profiles"]].count("moisture") == 1
    assert len(db_session.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.event == "addon_services_applied")).scalars().all()) == 1


def test_profile_added_by_lab_outside_snapshot_is_skipped(client, db_session, world):
    from lims_analyses.manage_native import add_profile_to_parent
    add_profile_to_parent(db_session, parent=world["parent"], profile=world["moist"], user_id=None)
    db_session.commit()
    r = _post(client, _body())
    assert r.status_code == 200
    assert r.json()["added"] == [] and "moisture" in r.json()["skipped"]


def test_null_snapshot_is_not_given_a_partial_profiles_list(client, db_session, world):
    p = _parent(db_session)
    p.catalog_snapshot = None
    db_session.commit()
    r = _post(client, _body())
    # No snapshot and no live HPLC rows in this fixture, so HPLC is added too.
    assert r.status_code == 200 and "moisture" in r.json()["added"]
    assert _parent(db_session).catalog_snapshot is None


def test_added_keys_limits_what_is_added(client, db_session, world):
    """IS diff present: only added_keys are considered, never the rest of services."""
    p = _parent(db_session)
    p.catalog_snapshot = None  # HPLC would be re-added from the full dict
    db_session.commit()
    r = _post(client, _body(added_keys=["moisture"]))
    assert r.status_code == 200, r.text
    assert r.json() == {"added": ["moisture"], "skipped": [], "ignored": []}


def test_added_keys_empty_adds_nothing(client, db_session, world):
    r = _post(client, _body(added_keys=[]))
    assert r.status_code == 200 and r.json() == {"added": [], "skipped": [], "ignored": []}


def test_parent_order_id_marks_addon_applied_by_profile_set_and_snapshot_gains_kind_profile(
        client, db_session, world):
    """Stack E2E P-9001: IS sends the PARENT order id; a non-role profile is
    not frozen by the registration builder but must still land in the snapshot."""
    fent_svc = AnalysisService(title="Fentanyl", keyword="FENTANYL", origin="mk1")
    fent = AnalysisProfile(key="fentanyl", name="Fentanyl Screening", is_addon=False, active=True,
                           fulfillment_dim="kind", vials_required=0, sort_order=40)
    db_session.add_all([fent_svc, fent])
    db_session.flush()
    fent.analysis_services.append(fent_svc)
    db_session.commit()
    p = _parent(db_session)
    p.catalog_snapshot = {**p.catalog_snapshot, "addon_orders": [
        *p.catalog_snapshot["addon_orders"],
        {"order_id": 3281, "order_number": "3281", "status": "completed", "profiles": ["fentanyl"],
         "fee": "free", "requested_at": "2026-09-29T12:00:00Z"}]}
    db_session.commit()
    r = _post(client, _body(order_id=3134, event_id="addon_3281_1727600000", added_keys=["fentanyl"]))
    assert r.status_code == 200, r.text
    assert r.json()["added"] == ["fentanyl"], r.json()
    snap = _parent(db_session).catalog_snapshot
    entry = next(e for e in snap["profiles"] if e["key"] == "fentanyl")
    assert entry["name"] == "Fentanyl Screening" and entry["is_addon"] is False
    assert entry["vials_required"] == 0 and entry["sort_order"] == 40
    assert entry["profile_id"] == fent.id and entry["service_ids"] == [fent_svc.id]
    moist_order, fent_order = snap["addon_orders"]
    assert fent_order["applied"] is True
    assert not moist_order.get("applied")  # moisture is not on the sample yet
    [ev] = db_session.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.event == "addon_services_applied")).scalars().all()
    assert ev.details["label"] == "Services added from WP add-on order 3281: Fentanyl Screening (waived)"
    # retest-options no longer offers it; the add-on route would refuse it anyway
    from lims_analyses.retest_carry import snapshot_profile_keys
    assert "fentanyl" in snapshot_profile_keys(_parent(db_session))


def test_snapshot_resolver_skips_non_role_addon_entries():
    from sub_samples.catalog_demand import _resolve_from_snapshot
    snap = {"profiles": [
        {"key": "moisture", "profile_id": 1, "fulfillment_role": "kf", "role_sort_order": None,
         "vials_required": 1, "ride_host_roles": []},
        {"key": "fentanyl", "profile_id": 2, "fulfillment_role": None, "fulfillment_dim": "kind",
         "role_sort_order": None, "vials_required": 0, "ride_host_roles": [], "source": "addon_apply"}]}
    out = _resolve_from_snapshot(snap)
    assert None not in out and out["kf"].host_profile_ids == [1]


@pytest.mark.parametrize("status", ["published", "cancelled", "rejected"])
def test_terminal_sample_409(client, db_session, world, status):
    p = _parent(db_session)
    p.status = status
    db_session.commit()
    r = _post(client, _body())
    assert r.status_code == 409 and r.json()["detail"] == f"sample is {status}"
    assert db_session.execute(select(LimsAnalysis).where(
        LimsAnalysis.analysis_service_id == world["kf"].id)).scalars().first() is None


def test_unknown_sample_404(client, db_session, world):
    r = client.post("/s2s/lims-samples/P-0000/services", json=_body(), headers=HDR)
    assert r.status_code == 404


def test_requires_service_token(client, db_session, world):
    assert _post(client, _body(), headers={"X-Service-Token": "wrong"}).status_code == 401
