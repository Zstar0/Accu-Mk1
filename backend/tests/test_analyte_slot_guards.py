"""Analyte-slot write guards (PB-0469, 2026-09-08).

Two Mk1 write paths could put the same peptide in two SENAITE analyte slots:
the sample-details inline "Peptide" editor (POST /wizard/senaite/samples/{uid}/
update, free text, no gates) and Replace (a peptide picker with gates that never
checked the OTHER slots). Both now refuse a duplicate, and the inline editor
refuses to touch a slot's peptide once the sample has vials -- Replace/Clear
own that transition.

Hermetic: StaticPool SQLite, dependency_overrides, SENAITE reads monkeypatched.
The SENAITE HTTP client is stubbed to COUNT construction attempts and fail:
a guard that fired leaves the count at 0; a request that legitimately passed
the guards reaches the stub (count 1) and the route reports the stub's error
as success=false -- which is exactly how we prove the guard stood aside.
"""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main as main_module
from auth import get_current_user
from database import Base, get_db
from main import app
from models import AnalysisService, LimsSample, LimsSubSample, Peptide

UID = "uid-guard-1"
SID = "PB-GUARD-1"


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


@pytest.fixture
def client(db, monkeypatch):
    hits = {"network": 0}

    class _NoNetwork:
        def __init__(self, *a, **k):
            hits["network"] += 1
            raise RuntimeError("no SENAITE/IS network in tests")

    monkeypatch.setattr(main_module.httpx, "AsyncClient", _NoNetwork)
    monkeypatch.setattr(main_module, "SENAITE_URL", "http://senaite.test")

    def _override_get_db():
        yield db

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, email="qa@accumark.test", senaite_password_encrypted=None
    )
    try:
        yield TestClient(app), hits
    finally:
        for dep, prev in ((get_db, prev_db), (get_current_user, prev_user)):
            if prev is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = prev


def _parent(db, *, with_vial: bool):
    p = LimsSample(sample_id=SID, external_lims_uid=UID)
    db.add(p)
    db.flush()
    if with_vial:
        db.add(LimsSubSample(parent_sample_pk=p.id, external_lims_uid="mk1://guard-1-S01",
                             sample_id=f"{SID}-S01", vial_sequence=1, assignment_role="hplc"))
    db.commit()
    return p


def _slots(monkeypatch, mapping):
    import sub_samples.senaite as senaite_mod
    monkeypatch.setattr(senaite_mod, "fetch_analyte_slots_by_uid", lambda uid: dict(mapping))
    monkeypatch.setattr(senaite_mod, "fetch_parent_analyte_slots", lambda sid: dict(mapping))


def _update(tc, fields):
    return tc.post(f"/wizard/senaite/samples/{UID}/update", json={"fields": fields})


# ── inline editor: POST /wizard/senaite/samples/{uid}/update ─────────────────

def test_update_refuses_slot_peptide_once_vials_exist(client, db, monkeypatch):
    tc, hits = client
    _parent(db, with_vial=True)
    _slots(monkeypatch, {1: "KPV - Identity (HPLC)", 2: "GHK-Cu - Identity (HPLC)"})

    resp = _update(tc, {"Analyte1Peptide": "GHK-Cu"})

    assert resp.status_code == 409, resp.text
    assert "Replace" in resp.json()["detail"]
    assert hits["network"] == 0


def test_update_refuses_duplicate_peptide_across_slots(client, db, monkeypatch):
    """PB-0469: slot 1 typed as 'GHK-Cu' while slot 2 already held GHK-Cu."""
    tc, hits = client
    _parent(db, with_vial=False)
    _slots(monkeypatch, {1: "KPV - Identity (HPLC)", 2: "GHK-Cu - Identity (HPLC)"})

    resp = _update(tc, {"Analyte1Peptide": "GHK-Cu"})

    assert resp.status_code == 409, resp.text
    assert "slot 2" in resp.json()["detail"]
    assert hits["network"] == 0


def test_update_duplicate_check_ignores_the_slot_being_edited(client, db, monkeypatch):
    """Re-saving slot 2's own peptide is not a duplicate -- only OTHER slots
    count. With no vials and no duplicate the guard stands aside and the
    write reaches SENAITE (the network stub)."""
    tc, hits = client
    _parent(db, with_vial=False)
    _slots(monkeypatch, {1: "KPV - Identity (HPLC)", 2: "GHK-Cu - Identity (HPLC)"})

    resp = _update(tc, {"Analyte2Peptide": "GHK-Cu"})

    assert resp.status_code == 200 and resp.json()["success"] is False
    assert hits["network"] == 1


def test_update_blanking_a_slot_is_never_a_duplicate(client, db, monkeypatch):
    tc, hits = client
    _parent(db, with_vial=False)
    _slots(monkeypatch, {1: "GHK-Cu", 2: "GHK-Cu - Identity (HPLC)"})

    resp = _update(tc, {"Analyte1Peptide": ""})

    assert resp.status_code == 200 and resp.json()["success"] is False
    assert hits["network"] == 1


def test_update_slot_read_failure_is_fail_closed(client, db, monkeypatch):
    import sub_samples.senaite as senaite_mod
    tc, hits = client
    _parent(db, with_vial=False)

    def _boom(uid):
        raise RuntimeError("senaite down")
    monkeypatch.setattr(senaite_mod, "fetch_analyte_slots_by_uid", _boom)

    resp = _update(tc, {"Analyte1Peptide": "GHK-Cu"})

    assert resp.status_code == 502, resp.text
    assert hits["network"] == 0


def test_update_non_slot_fields_are_not_gated(client, db, monkeypatch):
    """ClientLot etc. still flow straight through to SENAITE even with vials."""
    tc, hits = client
    _parent(db, with_vial=True)

    resp = _update(tc, {"ClientLot": "LOT-9"})

    assert resp.status_code == 200 and resp.json()["success"] is False
    assert hits["network"] == 1


# ── Replace: POST /explorer/samples/{id}/analytes/{slot}/replace ─────────────

def _ghk(db):
    ghk = Peptide(name="GHK-Cu", abbreviation="GHK-CU")
    db.add(ghk)
    db.flush()
    for kw in ("ID_GHKCU", "PUR_GHKCU", "QTY_GHKCU"):
        db.add(AnalysisService(keyword=kw, title=f"GHK-Cu {kw}", peptide_id=ghk.id))
    db.commit()
    return ghk


def test_replace_refuses_peptide_already_in_another_slot(client, db, monkeypatch):
    tc, hits = client
    _parent(db, with_vial=True)
    ghk = _ghk(db)
    _slots(monkeypatch, {1: "KPV - Identity (HPLC)", 2: "GHK-Cu - Identity (HPLC)"})

    resp = tc.post(f"/explorer/samples/{SID}/analytes/1/replace",
                   json={"new_peptide_id": ghk.id, "old_peptide_id": 0,
                         "senaite_uid": UID, "force": False})

    assert resp.status_code == 409, resp.text
    assert "slot 2" in resp.json()["detail"]
    assert hits["network"] == 0


def test_replace_own_slot_write_bypasses_the_inline_guard(client, db, monkeypatch):
    """Replace on a vialled sample must NOT trip the inline editor's has-vials
    409 when it writes the slot itself (it owns the cascade). With no
    duplicate and a pristine old slot it proceeds to the SENAITE write."""
    tc, hits = client
    _parent(db, with_vial=True)
    ghk = _ghk(db)
    _slots(monkeypatch, {1: "KPV - Identity (HPLC)", 2: "BPC-157 - Identity (HPLC)"})

    resp = tc.post(f"/explorer/samples/{SID}/analytes/1/replace",
                   json={"new_peptide_id": ghk.id, "old_peptide_id": 0,
                         "senaite_uid": UID, "force": False})

    # The slot write reached the (stubbed) SENAITE client: the inline guard
    # did not 409 it. The route then fails on the stub -- that's fine here.
    assert hits["network"] >= 1, resp.text
    assert resp.status_code != 409
