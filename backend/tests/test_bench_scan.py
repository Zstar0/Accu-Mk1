"""Bench stations + QR scan-in (spec 4, Task 12: catalog-driven bench).

Soft custody (Handler ruling Q2, deviation 7): a bench_scanned event is a
record, never a gate — no result-entry code is touched by this feature.

Covers:
  - /bench-stations admin CRUD (GET/POST/PATCH, no DELETE)
  - POST /bench-scans (JWT, desktop scanner-gun path) — writes bench_scanned
    with a real actor
  - Capture-token bench flow: POST /api/capture-tokens with station_id mints
    a station-scoped token; GET /api/bench/{token} resolves it; POST
    /api/bench/{token}/scan writes bench_scanned with user_id=None
  - GET /samples/{id}/activity surfaces the event with the human label
    "Scanned in at {station_name}"

Fixture idiom copied from test_api_vial_roles.py (StaticPool in-memory
SQLite + get_db/get_current_user dependency overrides).
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from database import get_db, Base
from models import BenchStation, LimsSample, LimsSubSample, LimsSubSampleEvent, User
from capture_tokens import service as capture_service


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
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, email="bench@accumark.test"
    )
    tc = TestClient(app)
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user


def _make_department(client, name="HPLC Bench Dept"):
    return client.post("/departments", json={"name": name}).json()


def _make_sub(db, sample_id="P-9100", sub_sample_id="P-9100-S01"):
    parent = LimsSample(sample_id=sample_id, external_lims_uid=f"uid-{sample_id}")
    db.add(parent)
    db.flush()
    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid=f"uid-{sub_sample_id}",
        sample_id=sub_sample_id,
        vial_sequence=1,
    )
    db.add(sub)
    db.commit()
    return sub


# ─── Bench station admin CRUD ────────────────────────────────────────────────


def test_get_bench_stations_empty_by_default(client):
    resp = client.get("/bench-stations")
    assert resp.status_code == 200
    assert resp.json() == []


def test_post_creates_station_with_department(client):
    dep = _make_department(client)
    resp = client.post("/bench-stations", json={
        "name": "HPLC Bench 1", "department_id": dep["id"],
    })
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "HPLC Bench 1"
    assert body["department_id"] == dep["id"]
    assert body["active"] is True
    assert body["sort_order"] == 0


def test_post_rejects_duplicate_name(client):
    dep = _make_department(client)
    first = client.post("/bench-stations", json={
        "name": "Dup Bench", "department_id": dep["id"],
    })
    assert first.status_code == 201
    second = client.post("/bench-stations", json={
        "name": "Dup Bench", "department_id": dep["id"],
    })
    assert second.status_code == 400


def test_post_rejects_unknown_department(client):
    resp = client.post("/bench-stations", json={
        "name": "Orphan Bench", "department_id": 999999,
    })
    assert resp.status_code == 400


def test_get_bench_stations_ordered_by_sort_order_then_name(client):
    dep = _make_department(client)
    client.post("/bench-stations", json={"name": "Zeta", "department_id": dep["id"], "sort_order": 1})
    client.post("/bench-stations", json={"name": "Alpha", "department_id": dep["id"], "sort_order": 0})
    client.post("/bench-stations", json={"name": "Beta", "department_id": dep["id"], "sort_order": 0})
    names = [s["name"] for s in client.get("/bench-stations").json()]
    assert names == ["Alpha", "Beta", "Zeta"]


def test_patch_updates_fields(client):
    dep = _make_department(client)
    dep2 = _make_department(client, "Second Dept")
    station = client.post("/bench-stations", json={
        "name": "Patchable", "department_id": dep["id"],
    }).json()

    resp = client.patch(f"/bench-stations/{station['id']}", json={
        "name": "Renamed", "department_id": dep2["id"], "active": False, "sort_order": 3,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Renamed"
    assert body["department_id"] == dep2["id"]
    assert body["active"] is False
    assert body["sort_order"] == 3


def test_patch_rejects_unknown_department(client):
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "Patch Dept Check", "department_id": dep["id"],
    }).json()
    resp = client.patch(f"/bench-stations/{station['id']}", json={"department_id": 999999})
    assert resp.status_code == 400


def test_patch_unknown_station_404(client):
    resp = client.patch("/bench-stations/999999", json={"name": "Nope"})
    assert resp.status_code == 404


def test_no_delete_route(client):
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "No Delete", "department_id": dep["id"],
    }).json()
    resp = client.delete(f"/bench-stations/{station['id']}")
    assert resp.status_code == 405


def test_department_delete_refused_while_bench_station_references_it(client):
    """bench_stations.department_id is NOT NULL (no ON DELETE SET NULL like
    vial_roles') — DELETE /departments/{id} must guard on it explicitly or
    the FK violation surfaces as a raw 500 instead of a clean 409."""
    dep = _make_department(client, "Guarded Dept")
    client.post("/bench-stations", json={
        "name": "Guard Station", "department_id": dep["id"],
    })
    resp = client.delete(f"/departments/{dep['id']}")
    assert resp.status_code == 409


# ─── JWT scan (desktop scanner-gun path) ─────────────────────────────────────


def test_jwt_scan_writes_event_with_details_and_actor(client, db_session):
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "HPLC Bench A", "department_id": dep["id"],
    }).json()
    sub = _make_sub(db_session)

    resp = client.post("/bench-scans", json={
        "station_id": station["id"], "sample_id": sub.sample_id,
    })
    assert resp.status_code == 201
    body = resp.json()
    assert body == {
        "recorded": True, "station_name": "HPLC Bench A", "sample_id": sub.sample_id,
    }

    ev = db_session.query(LimsSubSampleEvent).filter_by(sub_sample_pk=sub.id).one()
    assert ev.event == "bench_scanned"
    assert ev.details == {"station_id": station["id"], "station_name": "HPLC Bench A"}
    assert ev.user_id == 1


def test_jwt_scan_unknown_sample_404(client, db_session):
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "Bench B", "department_id": dep["id"],
    }).json()
    resp = client.post("/bench-scans", json={
        "station_id": station["id"], "sample_id": "NOPE-001",
    })
    assert resp.status_code == 404


def test_jwt_scan_unknown_station_404(client, db_session):
    sub = _make_sub(db_session)
    resp = client.post("/bench-scans", json={
        "station_id": 999999, "sample_id": sub.sample_id,
    })
    assert resp.status_code == 404


def test_jwt_scan_inactive_station_400(client, db_session):
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "Inactive Bench", "department_id": dep["id"], "active": False,
    }).json()
    sub = _make_sub(db_session)
    resp = client.post("/bench-scans", json={
        "station_id": station["id"], "sample_id": sub.sample_id,
    })
    assert resp.status_code == 400


# ─── Capture-token bench flow (phone/QR path) ────────────────────────────────


def test_mint_bench_token_and_get_context(client):
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "QR Bench", "department_id": dep["id"],
    }).json()

    mint = client.post("/api/capture-tokens", json={"station_id": station["id"]})
    assert mint.status_code == 201
    raw = mint.json()["token"]

    ctx = client.get(f"/api/bench/{raw}")
    assert ctx.status_code == 200
    assert ctx.json() == {"station_name": "QR Bench"}


def test_mint_bench_token_unknown_station_404(client):
    resp = client.post("/api/capture-tokens", json={"station_id": 999999})
    assert resp.status_code == 404


def test_mint_rejects_neither_samples_nor_station(client):
    resp = client.post("/api/capture-tokens", json={})
    assert resp.status_code == 422


def test_mint_rejects_inactive_station_400(client):
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "Dead Bench", "department_id": dep["id"], "active": False,
    }).json()
    resp = client.post("/api/capture-tokens", json={"station_id": station["id"]})
    assert resp.status_code == 400


def test_bench_context_404_after_station_deactivated_post_mint(client):
    """A station deactivated after its QR was already minted must stop
    resolving — same contract as a revoked token — for both the GET
    context read and the scan write."""
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "Soon Dead Bench", "department_id": dep["id"],
    }).json()
    raw = client.post("/api/capture-tokens", json={"station_id": station["id"]}).json()["token"]

    patch_resp = client.patch(f"/bench-stations/{station['id']}", json={"active": False})
    assert patch_resp.status_code == 200

    assert client.get(f"/api/bench/{raw}").status_code == 404
    assert client.post(f"/api/bench/{raw}/scan", json={"sample_id": "whatever"}).status_code == 404


def test_bench_token_against_capture_context_route_404_not_500(client):
    """Reverse-direction context confusion: a bench-scoped token
    (context_json=[{"station_id": N}]) hitting the pre-existing packaging
    GET /api/capture/{token} route used to crash with an unhandled
    pydantic ValidationError (CaptureSampleContext requires sample_id) —
    must 404 cleanly instead."""
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "Cross Bench 1", "department_id": dep["id"],
    }).json()
    raw = client.post("/api/capture-tokens", json={"station_id": station["id"]}).json()["token"]

    resp = client.get(f"/api/capture/{raw}")
    assert resp.status_code == 404


def test_bench_token_against_capture_photos_route_404_not_500(client):
    """Same confusion, POST side: used to crash with a bare KeyError on
    'sample_id' inside add_capture_photo — must 404 cleanly instead."""
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "Cross Bench 2", "department_id": dep["id"],
    }).json()
    raw = client.post("/api/capture-tokens", json={"station_id": station["id"]}).json()["token"]

    resp = client.post(f"/api/capture/{raw}/photos", json={"photo_base64": "not-real-but-unreached"})
    assert resp.status_code == 404


def test_token_scan_writes_event_with_user_id_none(client, db_session):
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "Token Bench", "department_id": dep["id"],
    }).json()
    sub = _make_sub(db_session)
    raw = client.post("/api/capture-tokens", json={"station_id": station["id"]}).json()["token"]

    resp = client.post(f"/api/bench/{raw}/scan", json={"sample_id": sub.sample_id})
    assert resp.status_code == 201
    body = resp.json()
    assert body == {
        "recorded": True, "station_name": "Token Bench", "sample_id": sub.sample_id,
    }

    ev = db_session.query(LimsSubSampleEvent).filter_by(sub_sample_pk=sub.id).one()
    assert ev.event == "bench_scanned"
    assert ev.details == {"station_id": station["id"], "station_name": "Token Bench"}
    assert ev.user_id is None


def test_token_scan_unknown_sample_404(client):
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "Token Bench 2", "department_id": dep["id"],
    }).json()
    raw = client.post("/api/capture-tokens", json={"station_id": station["id"]}).json()["token"]

    resp = client.post(f"/api/bench/{raw}/scan", json={"sample_id": "GHOST-001"})
    assert resp.status_code == 404


def test_get_bench_context_404_unknown_token(client):
    resp = client.get("/api/bench/not-a-real-token")
    assert resp.status_code == 404


def test_get_bench_context_404_expired(client, monkeypatch):
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "Expiring Bench", "department_id": dep["id"],
    }).json()
    monkeypatch.setattr(capture_service, "CAPTURE_TOKEN_TTL_HOURS", -1)
    raw = client.post("/api/capture-tokens", json={"station_id": station["id"]}).json()["token"]

    resp = client.get(f"/api/bench/{raw}")
    assert resp.status_code == 404


def test_get_bench_context_404_revoked(client):
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "Revocable Bench", "department_id": dep["id"],
    }).json()
    minted = client.post("/api/capture-tokens", json={"station_id": station["id"]}).json()
    assert client.delete(f"/api/capture-tokens/{minted['id']}").status_code == 204

    resp = client.get(f"/api/bench/{minted['token']}")
    assert resp.status_code == 404


def test_token_routes_work_without_auth_override(client, db_session):
    """The phone has no JWT — GET /api/bench/{token} and POST
    /api/bench/{token}/scan must work with get_current_user's override
    popped, mirroring test_capture_tokens_routes.py's
    test_public_routes_work_without_auth_override (the property that proves
    these two routes carry no auth dependency)."""
    dep = _make_department(client)
    station = client.post("/bench-stations", json={
        "name": "No-Auth Bench", "department_id": dep["id"],
    }).json()
    sub = _make_sub(db_session)
    raw = client.post("/api/capture-tokens", json={"station_id": station["id"]}).json()["token"]

    app.dependency_overrides.pop(get_current_user, None)
    try:
        ctx = client.get(f"/api/bench/{raw}")
        assert ctx.status_code == 200
        scan = client.post(f"/api/bench/{raw}/scan", json={"sample_id": sub.sample_id})
        assert scan.status_code == 201
    finally:
        app.dependency_overrides[get_current_user] = lambda: MagicMock(
            id=1, email="bench@accumark.test"
        )


def test_get_bench_context_404_wrong_context_samples_token(client, db_session):
    """A packaging-photo token (samples-scoped) is not a bench token — the
    bench routes must not accidentally resolve it."""
    parent = LimsSample(sample_id="P-9200", external_lims_uid="uid-P-9200")
    db_session.add(parent)
    db_session.commit()
    raw = client.post("/api/capture-tokens", json={
        "samples": [{"sample_id": parent.sample_id}],
    }).json()["token"]

    resp = client.get(f"/api/bench/{raw}")
    assert resp.status_code == 404


# ─── Activity feed label ─────────────────────────────────────────────────────


@pytest.fixture
def activity_client(db_session):
    """Same overrides as `client`, plus patches for get_sample_activity's
    external-DB side paths (mk1_db sample_preps + integration DB), which
    otherwise raise inside TestClient's un-mocked environment. Mirrors
    test_subsample_activity.py's activity_client fixture."""

    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, email="bench@accumark.test"
    )

    with (
        patch("mk1_db.ensure_sample_preps_table"),
        patch("mk1_db.get_mk1_db") as mock_mk1_db,
        patch("main.get_integration_db") as mock_int_db,
    ):
        mk1_conn = MagicMock()
        mk1_conn.__enter__ = MagicMock(return_value=mk1_conn)
        mk1_conn.__exit__ = MagicMock(return_value=False)
        mk1_cursor = MagicMock()
        mk1_cursor.__enter__ = MagicMock(return_value=mk1_cursor)
        mk1_cursor.__exit__ = MagicMock(return_value=False)
        mk1_cursor.fetchall.return_value = []
        mk1_conn.cursor.return_value = mk1_cursor
        mock_mk1_db.return_value = mk1_conn

        mock_int_db.side_effect = Exception("no integration db in tests")

        tc = TestClient(app)
        yield tc

    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user


def test_activity_endpoint_shows_bench_scanned_label(activity_client, db_session):
    # The activity_client fixture's get_current_user override is a fixed
    # MagicMock(id=1) — seed a real User row so it resolves to id=1 in this
    # fresh in-memory DB, matching the `by` attribution the endpoint reads
    # from the users table (not from the JWT payload).
    user = User(email="bench@accumark.test", hashed_password="x", role="standard")
    db_session.add(user)
    db_session.commit()
    assert user.id == 1

    dep = _make_department(activity_client)
    station = activity_client.post("/bench-stations", json={
        "name": "Activity Bench", "department_id": dep["id"],
    }).json()
    sub = _make_sub(db_session, sample_id="P-9300", sub_sample_id="P-9300-S01")

    scan = activity_client.post("/bench-scans", json={
        "station_id": station["id"], "sample_id": sub.sample_id,
    })
    assert scan.status_code == 201

    resp = activity_client.get(f"/samples/{sub.sample_id}/activity")
    assert resp.status_code == 200
    events = resp.json()["events"]

    bench_events = [e for e in events if e["event"] == "bench_scanned"]
    assert len(bench_events) == 1
    assert bench_events[0]["label"] == "Scanned in at Activity Bench"
    assert bench_events[0]["details"]["station_name"] == "Activity Bench"
    assert bench_events[0]["details"]["by"] == "bench@accumark.test"
