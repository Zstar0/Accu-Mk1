"""Clear an analyte slot (2026-09-08, PB-0469 follow-through).

KLOW -> GLOW dropped an analyte; the only tool was Replace, so the slot was
typed over and a peptide ended up in two slots. Clear is the sanctioned
"this blend has one analyte fewer" action: it mirrors Replace's gates and
cascade (pristine vial rows deleted, worked rows rejected on confirm, blocked
rows need force, parent identity service removed), blanks the slot's two
SENAITE fields, and never re-seeds. When the same peptide still occupies
ANOTHER slot (PB-0469's exact shape) it blanks the fields only -- the rows and
identity service belong to the surviving slot.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main as main_module
from auth import get_current_user
from database import Base, get_db
from lims_analyses.service import apply_transition, clear_analyte_slot, create_analysis
from main import app
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    LimsSubSampleEvent,
    Peptide,
    SampleAnalyteAlias,
)

SID = "PB-CLR-1"
UID = "uid-clr-1"


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()


def _peptide(db, name, abbr):
    p = Peptide(name=name, abbreviation=abbr)
    db.add(p)
    db.flush()
    return p


def _svc(db, *, keyword, peptide_id, title=None):
    s = AnalysisService(keyword=keyword, title=title or keyword, peptide_id=peptide_id)
    db.add(s)
    db.flush()
    return s


def _row(db, sub, svc, state="unassigned", result=None):
    a = create_analysis(db, host_kind="sub_sample", host_pk=sub.id,
                        analysis_service_id=svc.id, keyword=svc.keyword, title=svc.title,
                        result_value=None)
    if state == "to_be_verified":
        apply_transition(db, analysis_id=a.id, kind="assign")
        apply_transition(db, analysis_id=a.id, kind="submit", result_value=result or "1")
    return a


@pytest.fixture
def blend(db):
    """Parent with slot 2 = TP500 on two vials (one pristine, one worked) and
    slot 3 = BPC-157 that must survive untouched."""
    tp = _peptide(db, "TP500", "TP500")
    bpc = _peptide(db, "BPC-157", "BPC157")
    svcs = {f"{cat}_TP500": _svc(db, keyword=f"{cat}_TP500", peptide_id=tp.id) for cat in ("ID", "PUR", "QTY")}
    bpc_pur = _svc(db, keyword="PUR_BPC157", peptide_id=bpc.id)
    parent = LimsSample(sample_id=SID, external_lims_uid=UID)
    db.add(parent)
    db.flush()
    v1 = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://clr-1-S01",
                       sample_id=f"{SID}-S01", vial_sequence=1, assignment_role="hplc")
    v2 = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://clr-1-S02",
                       sample_id=f"{SID}-S02", vial_sequence=2, assignment_role="hplc")
    db.add_all([v1, v2])
    db.flush()
    for svc in svcs.values():
        _row(db, v1, svc)
    worked = {cat: _row(db, v2, svc) for cat, svc in svcs.items()}
    apply_transition(db, analysis_id=worked["PUR_TP500"].id, kind="assign")
    apply_transition(db, analysis_id=worked["PUR_TP500"].id, kind="submit", result_value="98.0")
    keep = _row(db, v1, bpc_pur)
    db.add(SampleAnalyteAlias(senaite_sample_id=SID, slot=2, alias="Customer TP"))
    db.commit()
    return dict(db=db, parent=parent, v1=v1, v2=v2, tp=tp, bpc=bpc, keep=keep, worked=worked)


def _live(db, sub):
    return {
        kw: st for kw, st in db.execute(
            select(LimsAnalysis.keyword, LimsAnalysis.review_state)
            .where(LimsAnalysis.lims_sub_sample_pk == sub.id)
        ).all()
    }


# ── service ──────────────────────────────────────────────────────────────────

def test_clear_slot_retires_vial_rows_without_reseeding(blend, monkeypatch):
    from lims_analyses import seeder as seeder_mod
    db = blend["db"]
    reseeded = []
    monkeypatch.setattr(seeder_mod, "seed_analyses_for_vial",
                        lambda db, **kw: reseeded.append(kw["sub_sample"].sample_id) or [])

    summary = clear_analyte_slot(
        db, parent_sample_id=SID, slot=2, old_peptide_id=blend["tp"].id,
        confirm_retract=True, user_id=7,
    )

    assert summary["slot"] == 2 and summary["cascade"] is True
    assert reseeded == []
    assert "PUR_TP500" not in _live(db, blend["v1"]) and "ID_TP500" not in _live(db, blend["v1"])
    assert _live(db, blend["v1"])["PUR_BPC157"] == "unassigned"  # other slot untouched
    v2 = _live(db, blend["v2"])
    assert v2["PUR_TP500"] == "rejected"
    assert "ID_TP500" not in v2 and "QTY_TP500" not in v2
    assert [e["keyword"] for e in summary["vials"]["retracted"]] == ["PUR_TP500"]
    assert len(summary["vials"]["deleted"]) == 5


def test_clear_slot_without_confirm_leaves_worked_rows(blend):
    db = blend["db"]
    summary = clear_analyte_slot(
        db, parent_sample_id=SID, slot=2, old_peptide_id=blend["tp"].id,
        confirm_retract=False, user_id=7,
    )
    assert _live(db, blend["v2"])["PUR_TP500"] == "to_be_verified"
    assert summary["vials"]["retracted"] == []


def test_clear_slot_fields_only_when_peptide_survives_elsewhere(blend):
    """PB-0469: slot 1 and slot 2 both GHK-Cu. Clearing slot 2 must not touch
    the per-substance rows or identity that slot 1 still relies on."""
    db = blend["db"]
    before = _live(db, blend["v2"])

    summary = clear_analyte_slot(
        db, parent_sample_id=SID, slot=2, old_peptide_id=blend["tp"].id,
        confirm_retract=True, user_id=7, cascade=False,
    )

    assert summary["cascade"] is False
    assert _live(db, blend["v2"]) == before
    assert summary["vials"] == {"deleted": [], "retracted": [], "blocked": []}


def test_clear_slot_emits_parent_event(blend):
    db = blend["db"]
    clear_analyte_slot(db, parent_sample_id=SID, slot=2, old_peptide_id=blend["tp"].id,
                       confirm_retract=True, user_id=7)
    ev = db.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.lims_sample_pk == blend["parent"].id,
        LimsSubSampleEvent.event == "analyte_slot_cleared")).scalar_one()
    assert ev.details["slot"] == 2 and ev.details["peptide_id"] == blend["tp"].id
    assert ev.user_id == 7


# ── route: POST /explorer/samples/{id}/analytes/{slot}/clear ─────────────────

@pytest.fixture
def client(db, monkeypatch):
    calls = {"fields": [], "identity_removed": [], "mirror": [], "refreshed": 0}

    async def _fake_update(uid, req, current_user, db):
        calls["fields"].append((uid, dict(req.fields), getattr(req, "_skip_slot_guards", False)))
        return main_module.SenaiteFieldUpdateResponse(success=True, message="ok",
                                                      updated_fields=list(req.fields))

    async def _fake_swap(client, sample_id, old_id_kw, new_id_svc, logger):
        calls["identity_removed"].append((sample_id, old_id_kw, new_id_svc))
        return {"removed": old_id_kw, "added": None}

    def _fake_mirror(**kw):
        calls["mirror"].append(kw)

    def _fake_refresh(db_, row):
        calls["refreshed"] += 1

    class _Client:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False

    import sub_samples.service as ss
    monkeypatch.setattr(main_module, "update_senaite_sample_fields", _fake_update)
    monkeypatch.setattr(main_module, "_swap_parent_identity_service", _fake_swap)
    monkeypatch.setattr(main_module, "_mirror_parent_analysis_bg", _fake_mirror)
    monkeypatch.setattr(main_module.httpx, "AsyncClient", _Client)
    monkeypatch.setattr(ss, "_refresh_parent_from_senaite", _fake_refresh)

    def _override_get_db():
        yield db

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=7, email="qa@accumark.test")
    try:
        yield TestClient(app), calls
    finally:
        for dep, prev in ((get_db, prev_db), (get_current_user, prev_user)):
            if prev is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = prev


def _slots(monkeypatch, mapping):
    import sub_samples.senaite as senaite_mod
    monkeypatch.setattr(senaite_mod, "fetch_parent_analyte_slots", lambda sid: dict(mapping))


def test_route_412_impact_until_confirmed(blend, client, monkeypatch):
    tc, calls = client
    _slots(monkeypatch, {1: "KPV - Identity (HPLC)", 2: "TP500 - Identity (HPLC)", 3: "BPC-157 - Identity (HPLC)"})

    resp = tc.post(f"/explorer/samples/{SID}/analytes/2/clear",
                   json={"senaite_uid": UID, "old_peptide_id": blend["tp"].id, "confirm": False})

    assert resp.status_code == 412, resp.text
    impact = resp.json()["detail"]
    assert [e["keyword"] for e in impact["worked_unverified"]] == ["PUR_TP500"]
    assert calls["fields"] == [] and calls["identity_removed"] == []


def test_route_clears_fields_identity_rows_alias_and_refreshes(blend, client, monkeypatch):
    tc, calls = client
    _slots(monkeypatch, {1: "KPV - Identity (HPLC)", 2: "TP500 - Identity (HPLC)", 3: "BPC-157 - Identity (HPLC)"})

    resp = tc.post(f"/explorer/samples/{SID}/analytes/2/clear",
                   json={"senaite_uid": UID, "old_peptide_id": blend["tp"].id, "confirm": True})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True and body["slot"] == 2 and body["cascade"] is True
    assert calls["fields"] == [(UID, {"Analyte2Peptide": "", "Analyte2DeclaredQuantity": ""}, True)]
    assert calls["identity_removed"] == [(SID, "ID_TP500", None)]
    assert calls["mirror"] and calls["mirror"][0]["keyword"] == "ID_TP500"
    assert calls["refreshed"] == 1
    db = blend["db"]
    assert db.execute(select(SampleAnalyteAlias).where(SampleAnalyteAlias.senaite_sample_id == SID)).scalar_one_or_none() is None
    assert _live(db, blend["v2"])["PUR_TP500"] == "rejected"


def test_route_fields_only_when_peptide_in_another_slot(blend, client, monkeypatch):
    tc, calls = client
    _slots(monkeypatch, {1: "TP500", 2: "TP500 - Identity (HPLC)", 3: "BPC-157 - Identity (HPLC)"})
    db = blend["db"]
    before = _live(db, blend["v2"])

    resp = tc.post(f"/explorer/samples/{SID}/analytes/2/clear",
                   json={"senaite_uid": UID, "old_peptide_id": blend["tp"].id, "confirm": True})

    assert resp.status_code == 200, resp.text
    assert resp.json()["cascade"] is False
    assert calls["fields"] == [(UID, {"Analyte2Peptide": "", "Analyte2DeclaredQuantity": ""}, True)]
    assert calls["identity_removed"] == []
    assert _live(db, blend["v2"]) == before


def test_route_404_on_empty_slot(blend, client, monkeypatch):
    tc, _ = client
    _slots(monkeypatch, {1: "KPV - Identity (HPLC)", 2: "TP500 - Identity (HPLC)"})
    resp = tc.post(f"/explorer/samples/{SID}/analytes/4/clear",
                   json={"senaite_uid": UID, "confirm": True})
    assert resp.status_code == 404, resp.text


def test_route_dry_run_reports_impact_without_writing(blend, client, monkeypatch):
    """The confirm dialog previews the cascade before anyone types a confirm."""
    tc, calls = client
    _slots(monkeypatch, {1: "KPV - Identity (HPLC)", 2: "TP500 - Identity (HPLC)", 3: "BPC-157 - Identity (HPLC)"})

    resp = tc.post(f"/explorer/samples/{SID}/analytes/2/clear",
                   json={"senaite_uid": UID, "old_peptide_id": blend["tp"].id, "dry_run": True})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["dry_run"] is True and body["cascade"] is True
    assert body["cleared_peptide"] == "TP500"
    assert [e["keyword"] for e in body["impact"]["worked_unverified"]] == ["PUR_TP500"]
    assert len(body["impact"]["pristine"]) == 5
    assert body["identity_keyword"] == "ID_TP500"
    assert calls["fields"] == [] and calls["identity_removed"] == []
    assert _live(blend["db"], blend["v2"])["PUR_TP500"] == "to_be_verified"
