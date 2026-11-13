"""Inline field edits on a native-born parent (P-5178, 2026-09-28).

A native-born parent (`external_lims_system == 'mk1'`) has no SENAITE AR and
no `external_lims_uid`, so the page posted
`/wizard/senaite/samples//update` (empty uid) and every Client Lot /
Declared Qty edit died with FastAPI's routing 404 "Not Found" before any
write. The page now sends the sample_id in the uid slot
(`parent-identity.ts::fieldEditKey`) and `update_senaite_sample_fields`
writes the registry row directly (`_update_native_sample_fields`).

Harness: in-memory SQLite (StaticPool), get_db + get_current_user
overridden, httpx.AsyncClient patched to PROVE the native path never talks
to SENAITE. Same shape as test_client_sample_id_mk1_override.py.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from models import LimsSample, LimsSampleRemark, LimsSubSampleEvent, User

NATIVE_ID = "P-5178"
LEGACY_ID = "P-3097"
LEGACY_UID = "UID-LEGACY-3097"


@pytest.fixture
def client():
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
        sample_id=NATIVE_ID, external_lims_uid=None, external_lims_system="mk1",
        client_lot="B26IR014", client_sample_id="Retatrutide",
        analytes=json.dumps([{"name": "Retatrutide", "declared_quantity": None, "peptide_id": 7}]),
        declared_total_quantity="30", status="sample_due",
    ))
    session.add(LimsSample(
        sample_id=LEGACY_ID, external_lims_uid=LEGACY_UID,
        external_lims_system="senaite", client_lot="OLD", status="sample_due",
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


def _post(client, key, fields):
    with patch("main.httpx.AsyncClient") as async_client:
        resp = client.post(
            f"/wizard/senaite/samples/{key}/update", json={"fields": fields}
        )
    return resp, async_client


def _row(client, sample_id):
    client.session.expire_all()
    return client.session.execute(
        select(LimsSample).where(LimsSample.sample_id == sample_id)
    ).scalar_one()


def _events(client, row):
    return client.session.execute(
        select(LimsSubSampleEvent)
        .where(LimsSubSampleEvent.lims_sample_pk == row.id)
        .order_by(LimsSubSampleEvent.id)
    ).scalars().all()


# ── native-born parent ────────────────────────────────────────────────────


def test_client_lot_lands_on_the_registry_row_without_senaite(client):
    resp, senaite = _post(client, NATIVE_ID, {"ClientLot": "B26IR0141"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True
    assert body["updated_fields"] == ["ClientLot"]
    senaite.assert_not_called()

    row = _row(client, NATIVE_ID)
    assert row.client_lot == "B26IR0141"
    (ev,) = _events(client, row)
    assert ev.event == "sample_field_updated"
    assert ev.user_id == 1
    assert ev.details == {
        "field": "ClientLot", "label": "Client Lot",
        "from": "B26IR014", "to": "B26IR0141", "senaite": "native",
    }


def test_declared_quantities_update_the_analyte_slots(client):
    resp, senaite = _post(client, NATIVE_ID, {
        "Analyte1DeclaredQuantity": 30, "DeclaredTotalQuantity": "30",
    })

    assert resp.status_code == 200, resp.text
    assert resp.json()["success"] is True
    senaite.assert_not_called()

    row = _row(client, NATIVE_ID)
    slots = json.loads(row.analytes)
    assert slots[0]["declared_quantity"] == "30"
    assert slots[0]["peptide_id"] == 7, "a quantity edit must not drop the peptide link"
    assert row.declared_total_quantity == "30"
    assert {e.details["field"] for e in _events(client, row)} == {
        "Analyte1DeclaredQuantity", "DeclaredTotalQuantity",
    }


def test_sample_id_key_is_case_insensitive_and_clears_with_empty(client):
    resp, _ = _post(client, "p-5178", {"ClientLot": ""})

    assert resp.status_code == 200, resp.text
    assert _row(client, NATIVE_ID).client_lot is None


def test_date_sampled_is_stored_and_a_bad_date_fails_closed(client):
    ok, senaite = _post(client, NATIVE_ID, {"DateSampled": "2026-09-28T19:06:00+00:00"})
    assert ok.status_code == 200, ok.text
    senaite.assert_not_called()
    assert _row(client, NATIVE_ID).date_sampled.isoformat() == "2026-09-28T19:06:00"

    bad, _ = _post(client, NATIVE_ID, {"DateSampled": "yesterday-ish"})
    assert bad.status_code == 400
    assert _row(client, NATIVE_ID).date_sampled.isoformat() == "2026-09-28T19:06:00"


def test_unknown_field_and_peptide_relabel_fail_closed(client):
    unknown, _ = _post(client, NATIVE_ID, {"Contact": "someone"})
    assert unknown.status_code == 400
    assert "Contact" in unknown.json()["detail"]

    peptide, _ = _post(client, NATIVE_ID, {"Analyte1Peptide": "BPC-157"})
    assert peptide.status_code == 409

    row = _row(client, NATIVE_ID)
    assert json.loads(row.analytes)[0]["name"] == "Retatrutide"
    assert _events(client, row) == []


def test_remarks_on_a_native_parent_write_natively(client):
    resp, senaite = _post(client, NATIVE_ID, {"Remarks": "  arrived warm  "})

    assert resp.status_code == 200, resp.text
    assert resp.json()["updated_fields"] == ["Remarks"]
    senaite.assert_not_called()
    row = _row(client, NATIVE_ID)
    remarks = client.session.execute(
        select(LimsSampleRemark).where(LimsSampleRemark.lims_sample_pk == row.id)
    ).scalars().all()
    assert [r.content for r in remarks] == ["arrived warm"]


# ── legacy (SENAITE-born) parent: path unchanged ──────────────────────────


def _senaite_update_url(senaite):
    """The URL the route POSTed to through the patched AsyncClient."""
    post = senaite.return_value.__aenter__.return_value.post
    post.assert_called_once()
    return post.call_args[0][0]


def test_legacy_parent_addressed_by_uid_still_forwards_to_senaite(client):
    resp, senaite = _post(client, LEGACY_UID, {"ClientLot": "NEW"})

    # The patched client "accepts" the write, so the route mirrors it onto
    # the registry row exactly as before -- the legacy dual-write path.
    assert _senaite_update_url(senaite).endswith(f"/update/{LEGACY_UID}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["success"] is True
    assert _row(client, LEGACY_ID).client_lot == "NEW"


def test_legacy_parent_addressed_by_sample_id_is_not_treated_as_native(client):
    resp, senaite = _post(client, LEGACY_ID, {"ClientLot": "NEW"})

    # Not native -> forwarded to SENAITE with whatever key it was given
    # (SENAITE answers 404 for real); the native branch never wrote the row.
    assert _senaite_update_url(senaite).endswith(f"/update/{LEGACY_ID}")
    assert resp.status_code == 200
    assert _row(client, LEGACY_ID).client_lot == "OLD"
