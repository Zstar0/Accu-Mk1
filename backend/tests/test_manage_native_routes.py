"""Route tests for the native Manage Analyses slice (FastAPI TestClient +
in-memory SQLite, get_db / get_current_user overridden — same idiom as
tests/test_custody_edges.py)."""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

import models  # noqa: F401
from main import app
from auth import get_current_user, require_admin
from database import get_db, Base
from models import (AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample, LimsSubSample,
                    LimsSubSampleEvent, VialProfileAssignment)
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED
from lims_analyses import manage_native as mn


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _client(db_session, *, admin: bool):
    app.dependency_overrides[get_db] = lambda: db_session
    user = MagicMock(); user.id = 9; user.role = "admin" if admin else "user"; user.email = "t@x"
    app.dependency_overrides[get_current_user] = lambda: user
    if admin:
        app.dependency_overrides[require_admin] = lambda: user
    else:
        app.dependency_overrides.pop(require_admin, None)
    return TestClient(app)


@pytest.fixture
def client(db_session):
    yield _client(db_session, admin=False)
    app.dependency_overrides.clear()


@pytest.fixture
def admin_client(db_session):
    yield _client(db_session, admin=True)
    app.dependency_overrides.clear()


@pytest.fixture
def world(db_session):
    db = db_session
    parent = LimsSample(sample_id="RT-PARENT", sample_type="x", status="received", external_lims_system="senaite")
    db.add(parent); db.commit(); db.refresh(parent)
    kf = AnalysisService(title="Residual Moisture", keyword="MOISTURE-KF", origin="mk1")
    db.add(kf); db.commit(); db.refresh(kf)
    prof = AnalysisProfile(key="moisture", name="Residual Moisture", is_addon=True, coa_archetype="limit_table",
                           fulfillment_role="kf", fulfillment_dim="role", vials_required=1, active=True)
    prof.analysis_services.append(kf)
    db.add(prof); db.commit(); db.refresh(prof)
    vial = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://rt-s04", sample_id="RT-PARENT-S04",
                         vial_sequence=4, assignment_role="kf")
    db.add(vial); db.commit(); db.refresh(vial)
    return {"parent": parent, "kf": kf, "profile": prof, "vial": vial}


def test_native_profiles_lists_moisture_with_host(client, world):
    r = client.get("/api/lims-analyses/parent/RT-PARENT/native-profiles")
    assert r.status_code == 200, r.text
    (p,) = r.json()
    assert p["key"] == "moisture" and p["on_sample"] == "none" and p["host_vials"] == ["RT-PARENT-S04"]
    assert p["members"][0]["keyword"] == "MOISTURE-KF"


def test_add_profile_then_409_then_remove_then_re_add(client, world, db_session):
    r = client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": world["profile"].id})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["placeholders_created"] == 1 and body["no_host_vial"] is False
    assert body["hosts"] == [{"vial_id": "RT-PARENT-S04", "edge_created": True, "vial_rows_created": 1}]

    r = client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": world["profile"].id})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "profile_already_on_sample"

    ph = db_session.execute(select(LimsAnalysis).where(LimsAnalysis.provenance == PROVENANCE_ORDERED)).scalars().one()
    r = client.delete(f"/api/lims-analyses/parent/RT-PARENT/native-analyses/{ph.id}")
    assert r.status_code == 200, r.text
    assert r.json()["vial_rows_deleted"] == 1 and r.json()["edges_superseded"] == 1

    r = client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": world["profile"].id})
    assert r.status_code == 201 and r.json()["placeholders_created"] == 1


def test_add_profile_422_and_404s(client, world, db_session):
    world["profile"].active = False; db_session.commit()
    r = client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": world["profile"].id})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "profile_inactive"
    r = client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": 999})
    assert r.status_code == 404
    r = client.post("/api/lims-analyses/parent/NOPE/profiles", json={"profile_id": world["profile"].id})
    assert r.status_code == 404


def test_remove_worked_row_412_then_confirm(client, world, db_session):
    client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": world["profile"].id})
    vr = db_session.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == world["vial"].id)).scalars().one()
    vr.result_value = "1"; vr.review_state = "assigned"; db_session.commit()
    ph = db_session.execute(select(LimsAnalysis).where(LimsAnalysis.provenance == PROVENANCE_ORDERED)).scalars().one()
    r = client.delete(f"/api/lims-analyses/parent/RT-PARENT/native-analyses/{ph.id}")
    assert r.status_code == 412, r.text
    d = r.json()["detail"]
    assert d["code"] == "confirm_required" and d["impact"]["worked_unverified"][0]["sample_id"] == "RT-PARENT-S04"
    r = client.delete(f"/api/lims-analyses/parent/RT-PARENT/native-analyses/{ph.id}?confirm=true")
    assert r.status_code == 200 and r.json()["vial_rows_rejected"] == 1


def test_resync_requires_admin_and_reports_counts(db_session, world, monkeypatch):
    # NOTE: client/admin_client fixtures both mutate the same shared
    # app.dependency_overrides dict; requesting both in one test lets
    # whichever fixture is instantiated second (admin_client) clobber the
    # other's overrides before the test body runs a single request. Build
    # each client fresh, immediately before it's used, to keep the two
    # identities from colliding.
    monkeypatch.setattr(mn, "fetch_sample_services", lambda sid: {"services": {"moisture": True}, "package": None})
    try:
        r = _client(db_session, admin=False).post("/api/lims-analyses/parent/RT-PARENT/resync-from-order")
        assert r.status_code == 403
        r = _client(db_session, admin=True).post("/api/lims-analyses/parent/RT-PARENT/resync-from-order")
        assert r.status_code == 200, r.text
        assert r.json() == {"placeholders_created": 1, "edges_created": 1, "vial_rows_created": 1}
    finally:
        app.dependency_overrides.clear()


def test_resync_502_when_is_unavailable(admin_client, world, monkeypatch):
    def boom(sid): raise RuntimeError("down")
    monkeypatch.setattr(mn, "fetch_sample_services", boom)
    r = admin_client.post("/api/lims-analyses/parent/RT-PARENT/resync-from-order")
    assert r.status_code == 502 and r.json()["detail"]["code"] == "order_services_unavailable"


def test_analysis_services_origin_and_active_filters(client, world, db_session):
    db_session.add(AnalysisService(title="Endo", keyword="ENDO-LAL", origin="senaite"))
    db_session.add(AnalysisService(title="Old", keyword="OLD-KF", origin="mk1", active=False))
    db_session.commit()
    r = client.get("/analysis-services?origin=mk1&active=true")
    assert r.status_code == 200
    assert [s["keyword"] for s in r.json()] == ["MOISTURE-KF"]
    r = client.get("/analysis-services?origin=mk1")
    assert sorted(s["keyword"] for s in r.json()) == ["MOISTURE-KF", "OLD-KF"]


def test_explorer_native_vial_add_by_keyword_ensures_parent_placeholder(client, world, db_session):
    r = client.post("/explorer/samples/RT-PARENT-S04/analyses", json={"keyword": "MOISTURE-KF"})
    assert r.status_code in (200, 201), r.text
    vial_rows = db_session.execute(select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == world["vial"].id)).scalars().all()
    assert [x.keyword for x in vial_rows] == ["MOISTURE-KF"]
    ph = db_session.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == world["parent"].id, LimsAnalysis.provenance == PROVENANCE_ORDERED)).scalars().one()
    assert ph.keyword == "MOISTURE-KF"


def test_explorer_native_vial_add_of_non_mk1_service_does_not_409_after_commit(client, world, db_session):
    # Regression: ensure_parent_placeholder refuses non-mk1-origin services
    # (ProfileNotNativeError), but add_analysis_to_native_vial — called first
    # and committing internally — accepts any origin via keyword/senaite_uid.
    # The explorer route must swallow that error rather than report a false
    # 409 for a vial row that's already durably committed.
    db_session.add(AnalysisService(title="Endo", keyword="ENDO-LAL", origin="senaite"))
    db_session.commit()
    r = client.post("/explorer/samples/RT-PARENT-S04/analyses", json={"keyword": "ENDO-LAL"})
    assert r.status_code in (200, 201), r.text
    vial_rows = db_session.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sub_sample_pk == world["vial"].id, LimsAnalysis.keyword == "ENDO-LAL")).scalars().all()
    assert len(vial_rows) == 1
    ph = db_session.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == world["parent"].id, LimsAnalysis.keyword == "ENDO-LAL")).scalars().all()
    assert ph == []  # no parent placeholder minted for a non-mk1 service


def test_explorer_native_vial_add_survives_placeholder_integrity_error(client, world, db_session, monkeypatch):
    # Regression: a concurrent duplicate-placeholder race trips the partial
    # unique index uq_lims_analyses_parent_service_ordered (real Postgres
    # only) and ensure_parent_placeholder's db.flush() raises IntegrityError.
    # The explorer route's inner guard must swallow that too — the vial add
    # already committed and is the primary action; the placeholder ensure is
    # best-effort.
    from sqlalchemy.exc import IntegrityError

    def _boom(*args, **kwargs):
        raise IntegrityError("INSERT ...", {}, Exception("dup key value violates unique constraint"))

    monkeypatch.setattr(mn, "ensure_parent_placeholder", _boom)
    r = client.post("/explorer/samples/RT-PARENT-S04/analyses", json={"keyword": "MOISTURE-KF"})
    assert r.status_code in (200, 201), r.text
    vial_rows = db_session.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sub_sample_pk == world["vial"].id, LimsAnalysis.keyword == "MOISTURE-KF")).scalars().all()
    assert len(vial_rows) == 1


def test_senaite_shape_rows_carry_provenance(client, world):
    client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": world["profile"].id})
    r = client.get("/api/lims-analyses/parent/RT-PARENT/native-analyses?as=senaite_shape")
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [(x["keyword"], x["provenance"], x["review_state"]) for x in rows] == [("MOISTURE-KF", "ordered", "unassigned")]
    assert rows[0]["uid"].startswith("mk1:")


def test_activity_labels_native_events(client, world, db_session):
    client.post("/api/lims-analyses/parent/RT-PARENT/profiles", json={"profile_id": world["profile"].id})
    r = client.get("/samples/RT-PARENT/activity")
    assert r.status_code == 200, r.text
    labels = [e["label"] for e in r.json()["events"] if e["event"] == "native_profile_added"]
    assert labels and labels[0].startswith("Residual Moisture added (native)")
