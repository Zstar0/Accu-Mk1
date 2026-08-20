"""Slice 2 (bench stamping) — Task 1: worksheet_items.instrument_id local FK leg.
Harness copied verbatim from tests/test_methods_catalog.py (in-memory SQLite +
TestClient, same idiom as tests/test_manage_native_routes.py)."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import models  # noqa: F401
from database import Base


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


def _client(db_session, admin=True):
    from unittest.mock import MagicMock

    from fastapi.testclient import TestClient

    from auth import get_current_user
    from database import get_db
    from main import app

    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, role="admin" if admin else "standard", email="admin@test")

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


@pytest.fixture
def client(db_session):
    yield from _client(db_session, admin=True)


def test_worksheet_item_instrument_id_roundtrip(client, db_session):
    from models import Instrument, Worksheet, WorksheetItem
    inst = Instrument(name="Agilent 7900 ICP-MS", origin="mk1", active=True)
    ws = Worksheet(title="hm#1", status="open")
    db_session.add_all([inst, ws]); db_session.flush()
    it = WorksheetItem(worksheet_id=ws.id, sample_uid="u-1", sample_id="PB-1-S01")
    db_session.add(it); db_session.commit()

    r = client.patch(f"/worksheets/{ws.id}/items/{it.id}", json={"instrument_id": inst.id})
    assert r.status_code == 200
    listed = client.get("/worksheets").json()
    item = listed[0]["items"][0]
    assert item["instrument_id"] == inst.id


def test_worksheet_item_instrument_id_rejects_unknown_instrument(client, db_session):
    from models import Worksheet, WorksheetItem
    ws = Worksheet(title="hm#2", status="open")
    db_session.add(ws); db_session.flush()
    it = WorksheetItem(worksheet_id=ws.id, sample_uid="u-2", sample_id="PB-2-S01")
    db_session.add(it); db_session.commit()

    r = client.patch(f"/worksheets/{ws.id}/items/{it.id}", json={"instrument_id": 999999})
    assert r.status_code == 400


def test_worksheet_item_instrument_id_clear_to_null(client, db_session):
    from models import Instrument, Worksheet, WorksheetItem
    inst = Instrument(name="Waters Alliance HPLC", origin="mk1", active=True)
    ws = Worksheet(title="hm#3", status="open")
    db_session.add_all([inst, ws]); db_session.flush()
    it = WorksheetItem(worksheet_id=ws.id, sample_uid="u-3", sample_id="PB-3-S01",
                       instrument_id=inst.id)
    db_session.add(it); db_session.commit()

    r = client.patch(f"/worksheets/{ws.id}/items/{it.id}", json={"instrument_id": None})
    assert r.status_code == 200
    listed = client.get("/worksheets").json()
    item = listed[0]["items"][0]
    assert item["instrument_id"] is None


def test_worksheet_item_instrument_id_omitted_is_noop(client, db_session):
    from models import Instrument, Worksheet, WorksheetItem
    inst = Instrument(name="Waters Alliance HPLC", origin="mk1", active=True)
    ws = Worksheet(title="hm#3b", status="open")
    db_session.add_all([inst, ws]); db_session.flush()
    it = WorksheetItem(worksheet_id=ws.id, sample_uid="u-3b", sample_id="PB-3B-S01",
                       instrument_id=inst.id)
    db_session.add(it); db_session.commit()

    r = client.patch(f"/worksheets/{ws.id}/items/{it.id}", json={"prep_status": "in_progress"})
    assert r.status_code == 200
    listed = client.get("/worksheets").json()
    item = listed[0]["items"][0]
    assert item["instrument_id"] == inst.id


_SEQ = iter(range(9100, 9999))


def _mk_vial_row(db, *, state="assigned", keyword="LEAD-PPM"):
    from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample
    n = next(_SEQ)  # unique sample ids per call — LimsSample.sample_id is UNIQUE
    parent = LimsSample(sample_id=f"P-{n}"); db.add(parent); db.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, sample_id=f"P-{n}-S01",
                         external_lims_uid=f"u-{n}", vial_sequence=1)
    db.add(vial); db.flush()
    svc = AnalysisService(title="Lead", keyword=keyword, origin="mk1", active=True,
                          variance_capable=False)
    db.add(svc); db.flush()
    row = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
                       keyword=keyword, title="Lead", review_state=state,
                       provenance="canonical")
    db.add(row); db.commit()
    return row


def test_stamp_guard_blocks_verified(db_session):
    from lims_analyses import service as svc_mod
    row = _mk_vial_row(db_session, state="verified")
    with pytest.raises(svc_mod.StateLockedError):
        svc_mod.set_method_instrument(db_session, analysis_id=row.id,
                                      method_id=None, instrument_id=None, user_id=None)


def test_stamp_allows_prep_bridge_states(db_session):
    """prep_bridge stamps rows in early states — the guard must not break it."""
    from lims_analyses import service as svc_mod
    for state in ("unassigned", "assigned", "to_be_verified"):
        row = _mk_vial_row(db_session, state=state, keyword=f"K-{state.upper()}")
        got = svc_mod.set_method_instrument(db_session, analysis_id=row.id,
                                            method_id=None, instrument_id=1, user_id=None)
        assert got.instrument_id == 1


def test_patch_method_instrument_409_on_published(client, db_session):
    row = _mk_vial_row(db_session, state="published")
    r = client.patch(f"/api/lims-analyses/{row.id}/method-instrument",
                     json={"method_id": None, "instrument_id": 1})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "state_locked"


def test_worksheet_item_instrument_uid_leg_untouched(client, db_session):
    """R0: instrument_uid (SENAITE leg) and instrument_id (local FK leg) are
    independent — setting one must not disturb the other."""
    from models import Instrument, Worksheet, WorksheetItem
    inst = Instrument(name="Agilent 7900 ICP-MS", origin="mk1", active=True)
    ws = Worksheet(title="hm#4", status="open")
    db_session.add_all([inst, ws]); db_session.flush()
    it = WorksheetItem(worksheet_id=ws.id, sample_uid="u-4", sample_id="PB-4-S01",
                       instrument_uid="senaite-uid-abc")
    db_session.add(it); db_session.commit()

    r = client.patch(f"/worksheets/{ws.id}/items/{it.id}", json={"instrument_id": inst.id})
    assert r.status_code == 200
    listed = client.get("/worksheets").json()
    item = listed[0]["items"][0]
    assert item["instrument_id"] == inst.id
    assert item["instrument_uid"] == "senaite-uid-abc"


# ─── Task 3: optional stamping on the submit transition ────────────────────


def test_submit_with_method_instrument_stamps_atomically(client, db_session):
    row = _mk_vial_row(db_session, state="assigned")
    mid = client.post("/hplc/methods", json={"name": "ICP-MS E"}).json()["id"]
    r = client.post(f"/api/lims-analyses/{row.id}/transitions",
                    json={"kind": "submit", "result_value": "1.2",
                          "method_id": mid, "instrument_id": None,
                          "reason": "bench-tech result entry"})
    assert r.status_code == 200
    b = r.json()
    assert b["review_state"] == "to_be_verified" and b["method_id"] == mid


def test_non_submit_kind_rejects_stamp_fields(client, db_session):
    row = _mk_vial_row(db_session, state="to_be_verified")
    r = client.post(f"/api/lims-analyses/{row.id}/transitions",
                    json={"kind": "verify", "method_id": 1})
    assert r.status_code == 400


def test_stamp_fields_on_legal_non_submit_kind_still_400(client, db_session):
    """The 'verify' case above 409s on tier mismatch regardless of the new
    guard, so it doesn't prove the guard does anything. 'assign' from
    'unassigned' IS a legal transition — without the guard this would 200
    and silently drop method_id. Pins that the guard fires before the state
    machine even gets a chance to succeed."""
    row = _mk_vial_row(db_session, state="unassigned")
    r = client.post(f"/api/lims-analyses/{row.id}/transitions",
                    json={"kind": "assign", "method_id": 1})
    assert r.status_code == 400


# ─── Task 4: bulk worksheet apply — service fn + route ─────────────────────


def _hm_world(client, db):
    """Worksheet with one HM vial carrying 2 covered analyses + 1 uncovered."""
    from models import (AnalysisService, Instrument, LimsAnalysis, LimsSample,
                        LimsSubSample, Worksheet, WorksheetItem, instrument_methods)
    mid = client.post("/hplc/methods", json={"name": "ICP-MS F", "technique": "ICP-MS"}).json()["id"]
    inst = Instrument(name="7900F", origin="mk1", active=True)
    db.add(inst); db.flush()
    db.execute(instrument_methods.insert().values(instrument_id=inst.id, method_id=mid))
    parent = LimsSample(sample_id="P-9200"); db.add(parent); db.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-9200-S01",
                         external_lims_uid="u-9200", vial_sequence=1)
    db.add(vial); db.flush()
    rows = {}
    for kw in ("LEAD-PPM", "ARSENIC-PPM", "MOISTURE-KF"):
        s = AnalysisService(title=kw, keyword=kw, origin="mk1", active=True,
                            variance_capable=False)
        db.add(s); db.flush()
        r = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=s.id,
                         keyword=kw, title=kw, review_state="assigned",
                         provenance="canonical")
        db.add(r); db.flush()
        rows[kw] = (s, r)
    client.put(f"/hplc/methods/{mid}/services", json=[
        {"analysis_service_id": rows["LEAD-PPM"][0].id, "is_default": True},
        {"analysis_service_id": rows["ARSENIC-PPM"][0].id, "is_default": True},
    ])
    ws = Worksheet(title="hm#1", status="open"); db.add(ws); db.flush()
    it = WorksheetItem(worksheet_id=ws.id, sample_uid="u-2", sample_id="P-9200-S01")
    db.add(it); db.commit()
    # lims_sub_sample_pk resolution in the payload joins on sample_id — the
    # bulk verb resolves the vial the same way (sub_sample_pk_map idiom).
    return ws, it, inst, mid, rows


def test_bulk_apply_coverage_and_skips(client, db_session):
    ws, it, inst, mid, rows = _hm_world(client, db_session)
    # one covered row already verified -> skipped_state
    rows["ARSENIC-PPM"][1].review_state = "verified"; db_session.commit()
    r = client.post(f"/worksheets/{ws.id}/apply-method-instrument",
                    json={"method_id": mid, "instrument_id": inst.id})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["stamped"] == 1                       # LEAD only
    assert b["items_updated"] == 1
    assert b["skipped_state"][0]["review_state"] == "verified"
    assert b["skipped_uncovered"][0]["keyword"] == "MOISTURE-KF"
    db_session.expire_all()
    assert rows["LEAD-PPM"][1].method_id == mid and rows["LEAD-PPM"][1].instrument_id == inst.id
    assert rows["MOISTURE-KF"][1].method_id is None    # never mis-stamped (R8)
    assert it.instrument_id == inst.id


def test_bulk_apply_unlinked_instrument_400(client, db_session):
    ws, it, inst, mid, rows = _hm_world(client, db_session)
    from models import Instrument
    other = Instrument(name="KF-V20", origin="mk1", active=True)
    db_session.add(other); db_session.commit()
    r = client.post(f"/worksheets/{ws.id}/apply-method-instrument",
                    json={"method_id": mid, "instrument_id": other.id})
    assert r.status_code == 400


def test_bulk_apply_unknown_worksheet_404(client, db_session):
    ws, it, inst, mid, rows = _hm_world(client, db_session)
    r = client.post("/worksheets/999999/apply-method-instrument",
                    json={"method_id": mid, "instrument_id": inst.id})
    assert r.status_code == 404


def test_bulk_apply_inactive_method_400(client, db_session):
    ws, it, inst, mid, rows = _hm_world(client, db_session)
    from models import HplcMethod
    m = db_session.get(HplcMethod, mid)
    m.active = False
    db_session.commit()
    r = client.post(f"/worksheets/{ws.id}/apply-method-instrument",
                    json={"method_id": mid, "instrument_id": inst.id})
    assert r.status_code == 400


def test_bulk_apply_inactive_instrument_400(client, db_session):
    ws, it, inst, mid, rows = _hm_world(client, db_session)
    inst.active = False
    db_session.commit()
    r = client.post(f"/worksheets/{ws.id}/apply-method-instrument",
                    json={"method_id": mid, "instrument_id": inst.id})
    assert r.status_code == 400


def test_bulk_apply_item_ids_scopes_to_subset(client, db_session):
    """item_ids restricts the bulk apply to a subset of worksheet items."""
    ws, it, inst, mid, rows = _hm_world(client, db_session)
    from models import LimsSample, LimsSubSample, WorksheetItem
    parent2 = LimsSample(sample_id="P-9300"); db_session.add(parent2); db_session.flush()
    vial2 = LimsSubSample(parent_sample_pk=parent2.id, sample_id="P-9300-S01",
                          external_lims_uid="u-9300", vial_sequence=1)
    db_session.add(vial2); db_session.flush()
    it2 = WorksheetItem(worksheet_id=ws.id, sample_uid="u-3", sample_id="P-9300-S01")
    db_session.add(it2); db_session.commit()

    r = client.post(f"/worksheets/{ws.id}/apply-method-instrument",
                    json={"method_id": mid, "instrument_id": inst.id, "item_ids": [it.id]})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["items_updated"] == 1
    db_session.expire_all()
    assert it.instrument_id == inst.id
    assert it2.instrument_id is None


# ─── Task 5: stamped method/instrument names on the payload ────────────────


def test_payload_carries_stamped_names(client, db_session):
    ws, it, inst, mid, rows = _hm_world(client, db_session)
    client.post(f"/worksheets/{ws.id}/apply-method-instrument",
                json={"method_id": mid, "instrument_id": inst.id})
    item = client.get("/worksheets").json()[0]["items"][0]
    assert item["stamped_method_name"] == "ICP-MS F"
    assert item["stamped_instrument_name"] == "7900F"
