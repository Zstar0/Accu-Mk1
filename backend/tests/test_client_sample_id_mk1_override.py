"""Client Sample ID edits on a SENAITE-locked AR (PB-0553, 2026-09-16).

SENAITE field-locks ClientSampleID once an AR is verified/published and
answers 401 "Not allowed to set the field 'ClientSampleID'". Mk1 is the read
source for this field in mk1 read mode, so the edit is accepted locally
instead of failing closed: the registry row is updated,
`client_sample_id_locked_in_senaite` is set so the 5-minute SENAITE refresh
(`_populate_basic_info`) never overwrites it, and a `sample_field_updated`
parent-hosted event records who changed what (`senaite='locked'`).

Every accepted field edit through the generic endpoint now writes the same
event (`senaite='accepted'`) so the activity log carries the actor, and the
activity feed overlays Mk1-recorded actors onto the Integration-DB COA and
status rows (which have no actor column of their own).

Harness: in-memory SQLite (StaticPool), get_db + get_current_user
overridden, httpx.AsyncClient patched with the same single-POST shape as
test_update_fields_remarks_intercept.py.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from models import LimsSample, LimsSubSampleEvent, User

SAMPLE_ID = "TEST-CSID-1"
UID = "UID-CSID-1"
LOCK_BODY = (
    '{"_runtime": 0.02, "message": "Not allowed to set the field '
    "'ClientSampleID'\", \"success\": false}"
)


# ── fixtures ─────────────────────────────────────────────────────────────


@pytest.fixture
def client():
    """TestClient sharing one in-memory SQLite session with the app."""
    from database import Base, get_db
    from auth import get_current_user
    from main import app
    from fastapi.testclient import TestClient

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(User(id=1, email="tester@lab.com", hashed_password="x", is_active=True))
    session.add(LimsSample(
        sample_id=SAMPLE_ID, external_lims_uid=UID,
        client_sample_id="KLOW", status="verified",
    ))
    session.commit()

    prev = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = lambda: (yield session)
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, email="tester@lab.com")
    tc = TestClient(app)
    tc.session = session
    try:
        with patch.object(__import__("main"), "SENAITE_URL", "http://senaite.test"):
            yield tc
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(prev)
        session.close()


def _senaite_post(status_code: int, text: str = ""):
    """Patch httpx.AsyncClient so the endpoint's single POST answers
    `status_code`; non-2xx raises HTTPStatusError like the real client."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.text = text
    if status_code >= 400:
        err = httpx.HTTPStatusError("err", request=MagicMock(), response=resp)
        resp.raise_for_status = MagicMock(side_effect=err)
    else:
        resp.raise_for_status = MagicMock()
    inst = AsyncMock()
    inst.post = AsyncMock(return_value=resp)
    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=inst)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p, inst


def _row(client) -> LimsSample:
    client.session.expire_all()
    return client.session.execute(
        select(LimsSample).where(LimsSample.sample_id == SAMPLE_ID)
    ).scalar_one()


def _events(client) -> list[LimsSubSampleEvent]:
    return client.session.execute(
        select(LimsSubSampleEvent).where(LimsSubSampleEvent.event == "sample_field_updated")
    ).scalars().all()


# ── endpoint ─────────────────────────────────────────────────────────────


def test_locked_client_sample_id_is_accepted_locally_and_logged(client):
    p, inst = _senaite_post(401, LOCK_BODY)
    try:
        r = client.post(f"/wizard/senaite/samples/{UID}/update",
                        json={"fields": {"ClientSampleID": "GLOW"}})
    finally:
        p.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert body["updated_fields"] == ["ClientSampleID"]
    assert "SENAITE" in (body.get("warning") or "")

    row = _row(client)
    assert row.client_sample_id == "GLOW"
    assert row.client_sample_id_locked_in_senaite is True

    (ev,) = _events(client)
    assert ev.lims_sample_pk == row.id and ev.sub_sample_pk is None
    assert ev.user_id == 1
    assert ev.details["field"] == "ClientSampleID"
    assert ev.details["from"] == "KLOW" and ev.details["to"] == "GLOW"
    assert ev.details["senaite"] == "locked"


def test_generic_401_is_not_treated_as_a_field_lock(client):
    """A bad-credentials 401 carries no lock message: fail closed, no local write."""
    p, _ = _senaite_post(401, '{"message": "Unauthorized"}')
    try:
        r = client.post(f"/wizard/senaite/samples/{UID}/update",
                        json={"fields": {"ClientSampleID": "GLOW"}})
    finally:
        p.stop()

    assert r.json()["success"] is False
    row = _row(client)
    assert row.client_sample_id == "KLOW"
    assert not row.client_sample_id_locked_in_senaite
    assert _events(client) == []


def test_lock_on_a_field_mk1_does_not_own_still_fails(client):
    """Only ClientSampleID is Mk1-owned on lock; a locked ClientLot fails as before."""
    p, _ = _senaite_post(401, LOCK_BODY.replace("ClientSampleID", "ClientLot"))
    try:
        r = client.post(f"/wizard/senaite/samples/{UID}/update",
                        json={"fields": {"ClientLot": "L-2"}})
    finally:
        p.stop()
    assert r.json()["success"] is False
    assert _events(client) == []


def test_accepted_edit_is_logged_with_actor(client):
    p, inst = _senaite_post(200)
    try:
        r = client.post(f"/wizard/senaite/samples/{UID}/update",
                        json={"fields": {"ClientSampleID": "GLOW"}})
    finally:
        p.stop()

    assert r.json()["success"] is True
    assert r.json().get("warning") in (None, "")
    assert inst.post.await_count == 1
    row = _row(client)
    assert row.client_sample_id == "GLOW"
    assert not row.client_sample_id_locked_in_senaite
    (ev,) = _events(client)
    assert ev.user_id == 1
    assert ev.details["senaite"] == "accepted"
    assert ev.details["from"] == "KLOW" and ev.details["to"] == "GLOW"


# ── refresh guard ────────────────────────────────────────────────────────


def test_refresh_keeps_mk1_client_sample_id_once_locked():
    from sub_samples.service import _populate_basic_info

    meta = {"uid": UID, "ClientSampleID": "KLOW", "review_state": "verified"}

    row = LimsSample(sample_id=SAMPLE_ID, client_sample_id="GLOW",
                     client_sample_id_locked_in_senaite=True)
    _populate_basic_info(row, meta)
    assert row.client_sample_id == "GLOW"

    row = LimsSample(sample_id=SAMPLE_ID, client_sample_id="GLOW",
                     client_sample_id_locked_in_senaite=False)
    _populate_basic_info(row, meta)
    assert row.client_sample_id == "KLOW"


# ── activity feed ────────────────────────────────────────────────────────


def test_activity_lists_field_update_with_actor(client):
    p, _ = _senaite_post(401, LOCK_BODY)
    try:
        client.post(f"/wizard/senaite/samples/{UID}/update",
                    json={"fields": {"ClientSampleID": "GLOW"}})
    finally:
        p.stop()

    with (
        patch("mk1_db.ensure_sample_preps_table"),
        patch("mk1_db.get_mk1_db", side_effect=Exception("no mk1 db")),
        patch("main.get_integration_db", side_effect=Exception("no integration db")),
    ):
        r = client.get(f"/samples/{SAMPLE_ID}/activity")

    assert r.status_code == 200, r.text
    (ev,) = [e for e in r.json()["events"] if e["event"] == "sample_field_updated"]
    assert ev["details"]["by"] == "tester@lab.com"
    assert ev["details"]["senaite"] == "locked"
    assert "Client Sample ID" in ev["label"]
    assert "KLOW" in ev["label"] and "GLOW" in ev["label"]


def test_overlay_actors_onto_integration_rows():
    """Pure overlay: Mk1's coa_* events match by (event, verification_code);
    Mk1 transitions match a status_change on to_status within 15 minutes."""
    from main import _overlay_mk1_actors

    t0 = datetime(2026, 9, 16, 12, 0, 0)
    events = [
        {"event": "coa_generated", "source": "coa_generations", "timestamp": t0.isoformat(),
         "details": {"verification_code": "ABC-123"}},
        {"event": "coa_published", "source": "coa_generations", "timestamp": t0.isoformat(),
         "details": {"verification_code": "ABC-123"}},
        {"event": "coa_generated", "source": "coa_generations", "timestamp": t0.isoformat(),
         "details": {"verification_code": "ZZZ-999"}},
        {"event": "status_change", "source": "sample_status_events",
         "timestamp": (t0 + timedelta(minutes=3)).isoformat() + "+00:00",
         "details": {"new_status": "published"}},
        {"event": "status_change", "source": "sample_status_events",
         "timestamp": (t0 - timedelta(hours=2)).isoformat() + "+00:00",
         "details": {"new_status": "published"}},
    ]
    coa_actors = {("coa_generated", "ABC-123"): "gen@lab.com",
                  ("coa_published", "ABC-123"): "pub@lab.com"}
    transitions = [("published", t0, "pub@lab.com")]

    _overlay_mk1_actors(events, coa_actors, transitions)

    assert events[0]["details"]["by"] == "gen@lab.com"
    assert events[1]["details"]["by"] == "pub@lab.com"
    assert "by" not in events[2]["details"]
    assert events[3]["details"]["by"] == "pub@lab.com"      # 3 min away
    assert "by" not in events[4]["details"]                  # 2 h away
