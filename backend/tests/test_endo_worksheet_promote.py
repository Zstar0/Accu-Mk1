"""Promote to Parent from the 2 mL endotoxin worksheet (endo slice 3, spec
docs/superpowers/specs/2026-10-12-endo-slice3-promote-loq-design.md sections
5 and 10): POST /worksheets/{id}/promote with its per-row refusals, each
row's fill and promote in one commit, the provenance audit, retest
supersession (Review Focus 1), rows promoted twice (Review Focus 2), stock
worksheets (Review Focus 5) and the endo_analysis key on worksheet items.
In-memory SQLite + dependency overrides, test_endo_v2_worksheets.py's
pattern and helpers."""
import json
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import worksheets_endo_promote
from auth import get_current_user
from coa.native_sections import build_native_sections
from database import Base, get_db
from lims_analyses import promote_flow
from lims_analyses.promote_flow import PromoteError
from lims_analyses.schemas import PromoteRequest
from lims_analyses.service import BadRequestError, apply_transition
from main import app
from models import (
    AnalysisProfile, AnalysisServiceSpec, AuditLog, LimsAnalysis, LimsAnalysisPromotion,
    LimsAnalysisTransition, LimsSample, LimsSubSample, ServiceGroup, WorksheetItem,
    analysis_profile_members, service_group_members,
)
from tests.test_endo_v2_worksheets import _cartridge, _count_sql, _method, _record, _service, _ws

BAD = "the value, LOQ or LOD does not match the worksheet row"
HOLDS = "the parent already holds a result; retest the vial to replace it"


@pytest.fixture(autouse=True)
def cascade_calls(monkeypatch):
    """Record the side-by-side cascade instead of running it: the real
    run_cascades_bg opens its own session on the host Postgres (the guard in
    test_promote_flow.py)."""
    calls = []
    monkeypatch.setattr("workflow.engine.run_cascades_bg",
                        lambda parent_pk, user_id: calls.append((parent_pk, user_id)))
    return calls


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, email="qa@accumark.test")
    yield TestClient(app)
    app.dependency_overrides.clear()


def _world(client, db, *, peptide_spec=True):
    """Service 281's shape (spec section 3): ENDOTOXIN-USP85LAL, native, EU/mL,
    with the catch-all 0 to 5 EU/mL, bac water 0 to 0.25 EU/mL and (launch
    step 2) Peptide 0 to 350 EU/vial specs. Its active default method allows
    the 0.05 (default) and 0.01 cartridges and is pinned on one open 2 mL
    worksheet, as the first reading pins it (v2)."""
    svc = _service(db)
    svc.unit = "EU/mL"
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    mid = _method(client, db, "Endotoxin", svc, [(c05, True), (c01, False)])
    specs = [(None, "5", "EU/mL", "2.5"), ("Bacteriostatic Water", "0.25", "EU/mL", "0.2")]
    if peptide_spec:
        specs.append(("Peptide", "350", "EU/vial", None))
    for matrix, hi, unit, loq in specs:
        db.add(AnalysisServiceSpec(analysis_service_id=svc.id, matrix=matrix, rule_kind="range",
                                   min_value=Decimal("0"), max_value=Decimal(hi), unit=unit,
                                   loq=Decimal(loq) if loq else None))
    ws = _ws(db)
    ws.endo_method_id = mid
    db.commit()
    return SimpleNamespace(svc=svc, c05=c05, c01=c01, mid=mid, ws=ws)


def _row(db, w, sample_id="P-4001-S01", *, sample_type="Peptide", reading="<0.05", cartridge=None,
         state="assigned", service=None, reader=None, total=None, role="endo85", ws=None):
    """Vial `sample_id` on a worksheet with one analysis on `service` (the
    native endotoxin service by default) in `state`, and the row's reading
    saved with its cartridge, as the item PATCH and the reader import store
    them. The parent is the id before -S; it is made on first use."""
    parent_id, n = sample_id.rsplit("-S", 1)
    parent = db.execute(select(LimsSample).where(LimsSample.sample_id == parent_id)).scalar_one_or_none()
    if parent is None:
        parent = LimsSample(sample_id=parent_id, external_lims_uid=f"SEN-{parent_id}",
                            sample_type_title=sample_type)
        db.add(parent)
        db.flush()
    vial = LimsSubSample(sample_id=sample_id, parent_sample_pk=parent.id, vial_sequence=int(n),
                         external_lims_uid=f"mk1://{sample_id}", assignment_role=role)
    db.add(vial)
    db.flush()
    svc = service or w.svc
    analysis = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
                            keyword=svc.keyword, title=svc.title, review_state=state,
                            provenance="canonical")
    item = WorksheetItem(worksheet_id=(ws or w.ws).id, sample_uid=vial.external_lims_uid,
                         sample_id=sample_id, result_reading=reading,
                         cartridge_type_id=(cartridge or w.c05).id if reading else None,
                         result_reader=reader, prep_total_dilution=total)
    db.add_all([analysis, item])
    db.flush()
    return item, analysis


def _imported(test_id, result, **over):
    """A stored reader record for `result`, in the reader import's shape."""
    return {**_record(test_id=test_id), "result": result, "valid": True, "why": [], **over}


def _line(item, value=25, *, unit="EU/vial", loq=25, lod=0.05, lod_unit="EU/mL",
          result_floor=False):
    """One ticked row as the confirm dialog sends it. The default is a
    peptide "<0.05" on the 0.05 cartridge at the standard 2 mL and 1:250:
    <25 EU per vial (0.05 x 250 x 2), sent as 25 with LOQ 25 and LOD 0.05."""
    return {"item_id": item.id, "value": value, "unit": unit, "loq": loq, "lod": lod,
            "lod_unit": lod_unit, "result_floor": result_floor}


def _promote(client, ws, *lines):
    return client.post(f"/worksheets/{ws.id}/promote", json={"rows": list(lines)})


def _results(r):
    assert r.status_code == 200, r.text
    return r.json()["results"]


def _refused(item, reason):
    return {"item_id": item.id, "promoted": False, "parent_analysis_id": None, "state": None,
            "reason": reason}


def _parent_rows(db, parent_sample_id):
    db.expire_all()
    parent = db.execute(select(LimsSample).where(LimsSample.sample_id == parent_sample_id)).scalar_one()
    return db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == parent.id, LimsAnalysis.lims_sub_sample_pk.is_(None))
        .order_by(LimsAnalysis.id)).scalars().all()


# --- the happy paths ---------------------------------------------------------

def test_a_below_loq_peptide_row_fills_the_vial_and_promotes_it(client, db):
    w = _world(client, db)
    item, vial = _row(db, w)
    db.commit()
    vial_id = vial.id
    [res] = _results(_promote(client, w.ws, _line(item)))
    [parent] = _parent_rows(db, "P-4001")
    assert res == {"item_id": item.id, "promoted": True, "parent_analysis_id": parent.id,
                   "state": "parent_to_verify", "reason": None}
    vial = db.get(LimsAnalysis, vial_id)
    # Stored as the number equal to its LOQ (spec section 4): "<25 EU/vial" is 25, LOQ 25.
    assert (vial.review_state, vial.result_value, vial.result_unit, vial.loq, vial.lod,
            vial.lod_unit, vial.method_id) == (
        "promoted", "25", "EU/vial", 25.0, 0.05, "EU/mL", w.mid)
    assert (parent.result_value, parent.result_unit, parent.loq, parent.lod, parent.lod_unit,
            parent.method_id) == ("25", "EU/vial", 25.0, 0.05, "EU/mL", w.mid)


def test_bac_water_promotes_in_eu_ml_judged_by_its_own_spec(client, db):
    w = _world(client, db)
    item, _ = _row(db, w, "BW-0100-S01", sample_type="Bacteriostatic Water", reading="<0.2",
                   cartridge=w.c01)
    db.commit()
    # Bac water reads in EU/mL of the water: a clean run on the 0.01 shows <0.2 (0.01 x 20).
    [res] = _results(_promote(client, w.ws, _line(item, 0.2, unit="EU/mL", loq=0.2, lod=0.01)))
    assert res["promoted"] is True, res
    [parent] = _parent_rows(db, "BW-0100")
    assert (parent.result_value, parent.result_unit, parent.loq, parent.lod) == (
        "0.2", "EU/mL", 0.2, 0.01)
    audit = db.query(AuditLog).filter(AuditLog.operation == "endo_worksheet_promoted").one()
    assert (audit.details["total_dilution"], audit.details["water_ml"]) == (20, None)


def test_the_promote_records_where_each_value_came_from(client, db):
    w = _world(client, db)
    item, vial = _row(db, w, reader=_imported("T-7", "<0.05"))
    db.commit()
    vial_id, item_id, ws_id = vial.id, item.id, w.ws.id
    [res] = _results(_promote(client, w.ws, _line(item)))
    why = f"promoted from worksheet WS-{ws_id} row P-4001-S01"
    audit = db.query(AuditLog).filter(AuditLog.operation == "endo_worksheet_promoted").one()
    assert (audit.entity_type, audit.entity_id) == ("lims_analysis", str(res["parent_analysis_id"]))
    assert audit.details == {
        "user_id": 1, "worksheet_id": ws_id, "item_id": item_id, "sample_id": "P-4001-S01",
        "reading": "<0.05", "reader_test_id": "T-7", "cartridge_type_id": w.c05.id,
        "cartridge_sensitivity": 0.05, "total_dilution": 250, "water_ml": 2,
        "value": 25.0, "unit": "EU/vial", "loq": 25.0, "lod": 0.05, "lod_unit": "EU/mL",
        "result_floor": False}
    submit = db.query(LimsAnalysisTransition).filter_by(analysis_id=vial_id,
                                                        transition_kind="submit").one()
    assert submit.reason == why
    assert {"result_value", "result_unit", "loq", "lod", "lod_unit", "method_id"} <= set(
        submit.details["changed"])
    assert db.query(LimsAnalysisPromotion).filter_by(source_analysis_id=vial_id).one().reason == why
    # Task 2's audit_reason: the promote's own transition rows name the worksheet row too.
    assert any(why in (t.reason or "") for t in db.query(LimsAnalysisTransition).filter(
        LimsAnalysisTransition.analysis_id.in_((vial_id, res["parent_analysis_id"])),
        LimsAnalysisTransition.transition_kind == "auto"))


def test_a_typed_reading_is_marked_for_the_reviewer(client, db):
    w = _world(client, db)
    typed, _ = _row(db, w, "P-4001-S01")
    # Typed over an import with another number: the record does not show this reading.
    over, _ = _row(db, w, "P-4002-S01", reading="0.1", reader=_imported("T-9", "<0.05"))
    db.commit()
    _results(_promote(client, w.ws, _line(typed), _line(over, 50)))
    marks = {a.details["sample_id"]: a.details["reader_test_id"] for a in
             db.query(AuditLog).filter(AuditLog.operation == "endo_worksheet_promoted")}
    assert marks == {"P-4001-S01": "typed, no reader record",
                     "P-4002-S01": "typed, no reader record"}


def test_a_completed_worksheet_still_promotes_and_staging_is_not_found(client, db):
    w = _world(client, db)
    item, _ = _row(db, w)
    w.ws.status = "staging"
    db.commit()
    assert _promote(client, w.ws, _line(item)).status_code == 404
    assert client.post("/worksheets/99999/promote", json={"rows": []}).status_code == 404
    w.ws.status = "completed"
    db.commit()
    assert _results(_promote(client, w.ws, _line(item)))[0]["promoted"] is True


@pytest.mark.parametrize("value, text", [
    (25.0, "25"), (350.0, "350"), (0.2, "0.2"), (12.5, "12.5"), (1e-05, "0.00001")])
def test_a_value_is_stored_as_plain_text(value, text):
    assert worksheets_endo_promote._num_text(value) == text


def test_a_result_on_the_limit_is_stored_as_350_never_in_exponent_form(client, db):
    w = _world(client, db)
    item, vial = _row(db, w, reading="0.7")   # 0.7 x 250 x 2 = 350 EU per vial: a pass
    db.commit()
    vial_id = vial.id
    [res] = _results(_promote(client, w.ws, _line(item, 350.0)))
    db.expire_all()
    assert (db.get(LimsAnalysis, vial_id).result_value,
            db.get(LimsAnalysis, res["parent_analysis_id"]).result_value) == ("350", "350")


# --- refusals (spec 5.3's table), one row each, none blocking the others -----

def test_each_rule_refuses_its_own_row_with_the_spec_reason(client, db):
    w = _world(client, db)
    lal = _service(db, "ENDO-LAL")
    lal.origin = "senaite"
    hplc = _service(db, "BPC157-PURITY")
    c5 = _cartridge(db, "Endosafe 0.5", 0.5)
    ok, _ = _row(db, w, "P-5000-S01")
    senaite, _ = _row(db, w, "P-5001-S01", service=lal)
    two, two_vial = _row(db, w, "P-5002-S01")
    db.add(LimsAnalysis(lims_sub_sample_pk=two_vial.lims_sub_sample_pk, analysis_service_id=w.svc.id,
                        keyword=w.svc.keyword, title=w.svc.title, review_state="assigned",
                        provenance="canonical"))
    none, _ = _row(db, w, "P-5003-S01", service=hplc)
    promoted, _ = _row(db, w, "P-5004-S01", state="promoted")
    holds, holds_vial = _row(db, w, "P-5005-S01")
    db.add(LimsAnalysis(
        lims_sample_pk=db.get(LimsSubSample, holds_vial.lims_sub_sample_pk).parent_sample_pk,
        analysis_service_id=w.svc.id, keyword=w.svc.keyword, title=w.svc.title,
        result_value="12", result_unit="EU/mL", review_state="verified", provenance="canonical"))
    unread, _ = _row(db, w, "P-5006-S01", reading=None)
    invalid, _ = _row(db, w, "P-5007-S01", reader=_imported(
        "T-1", "<0.05", spike_cv=30, valid=False, why=["spike CV 30 % over 25 %"]))
    inconclusive, _ = _row(db, w, "P-5008-S01", reading="<0.5", cartridge=c5, total=500)
    mismatched, _ = _row(db, w, "P-5009-S01", reading="<0.1")
    peptide_ml, _ = _row(db, w, "P-5010-S01")
    bac_vial, _ = _row(db, w, "BW-5011-S01", sample_type="Bacteriostatic Water", reading="<0.2",
                       cartridge=w.c01)
    bad_lod, _ = _row(db, w, "P-5012-S01")
    lt_off, _ = _row(db, w, "P-5013-S01")
    negative, _ = _row(db, w, "P-5014-S01", reading="0.8")
    lod_vial, _ = _row(db, w, "P-5015-S01")
    cancelled, _ = _row(db, w, "P-5016-S01", state="cancelled")
    db.commit()

    cases = [
        (ok, _line(ok), None),
        (senaite, _line(senaite), "manual entry: SENAITE-born endotoxin"),
        (two, _line(two), "the vial has more than one endotoxin analysis"),
        (none, _line(none), "the vial has no endotoxin analysis"),
        (promoted, _line(promoted), "already promoted"),
        (holds, _line(holds), HOLDS),
        (unread, _line(unread), "no reading"),
        (invalid, _line(invalid), "Invalid: spike CV 30 % over 25 %"),
        # "<0.5" on a 0.5 cartridge at 1:500 and 2 mL: <500 EU per vial cannot show a pass.
        (inconclusive, _line(inconclusive, 500, loq=500, lod=0.5),
         "inconclusive: LOQ 500 EU/vial is above the 350 limit"),
        (mismatched, _line(mismatched, 50, loq=50),
         "the reading <0.1 is not this cartridge's sensitivity (0.05)"),
        (peptide_ml, _line(peptide_ml, unit="EU/mL"), "peptides promote in EU/vial"),
        (bac_vial, _line(bac_vial, 0.2, unit="EU/vial", loq=0.2, lod=0.01),
         "bac water promotes in EU/mL"),
        (bad_lod, _line(bad_lod, lod=0.01), BAD),            # not the 0.05 cartridge's LOD
        (lt_off, _line(lt_off, 25, loq=30), BAD),           # a "<" value must equal its LOQ
        (negative, _line(negative, -1), BAD),
        (lod_vial, _line(lod_vial, lod_unit="EU/vial"), BAD),
        (cancelled, _line(cancelled), "the vial's endotoxin analysis is cancelled"),
    ]
    results = _results(_promote(client, w.ws, *(line for _, line, _ in cases)))
    assert [(r["item_id"], r["promoted"], r["reason"]) for r in results] == [
        (item.id, reason is None, reason) for item, _, reason in cases]
    # Only the eligible row wrote anything.
    assert db.query(LimsAnalysisPromotion).count() == 1
    assert db.query(AuditLog).filter(AuditLog.operation == "endo_worksheet_promoted").count() == 1
    assert db.query(LimsAnalysisTransition).filter(
        LimsAnalysisTransition.transition_kind == "submit").count() == 1


def test_bac_water_compares_a_less_than_reading_to_the_cartridges_floor(client, db):
    w = _world(client, db)
    item, _ = _row(db, w, "BW-0200-S01", sample_type="Bacteriostatic Water", reading="<0.01",
                   cartridge=w.c01)
    db.commit()
    assert _results(_promote(client, w.ws, _line(item, 0.01, unit="EU/mL", loq=0.01, lod=0.01))) == [
        _refused(item, "the reading <0.01 is not this cartridge's floor for bac water (0.2)")]


def test_without_an_eu_vial_spec_a_peptide_row_is_refused_never_judged_in_eu_ml(client, db):
    w = _world(client, db, peptide_spec=False)
    item, _ = _row(db, w)
    db.commit()
    assert _results(_promote(client, w.ws, _line(item))) == [_refused(
        item, "No active Endotoxin (ENDOTOXIN-USP85LAL) spec in EU/vial for Peptide")]


def test_non_finite_numbers_are_bad_numbers_and_write_nothing(client, db):
    w = _world(client, db)
    item, vial = _row(db, w)
    db.commit()
    vial_id = vial.id
    # FastAPI's JSON parsing takes Infinity; the row must never reach the audit JSON.
    body = ('{"rows": [{"item_id": %d, "value": Infinity, "unit": "EU/vial", '
            '"loq": Infinity, "lod": 0.05, "lod_unit": "EU/mL"}]}' % item.id)
    r = client.post(f"/worksheets/{w.ws.id}/promote", content=body,
                    headers={"Content-Type": "application/json"})
    assert _results(r) == [_refused(item, BAD)]
    db.expire_all()
    assert db.get(LimsAnalysis, vial_id).result_value is None


def test_an_item_of_another_worksheet_is_refused(client, db):
    w = _world(client, db)
    mine, _ = _row(db, w)
    _row(db, w, "P-4002-S01")     # a second row here, so two entries are not too many
    stray, _ = _row(db, w, "P-4003-S01", ws=_ws(db, "Another run"))
    db.commit()
    res = _results(_promote(client, w.ws, _line(mine), _line(stray)))
    assert res[0]["promoted"] is True
    assert res[1] == _refused(stray, "not on this worksheet")


def test_a_stock_worksheet_refuses_every_row_and_writes_nothing(client, db):
    w = _world(client, db)
    item, vial = _row(db, w)
    w.ws.endo_prep = "stock"
    db.commit()
    vial_id = vial.id
    assert _results(_promote(client, w.ws, _line(item))) == [
        _refused(item, "promote is for 2 mL worksheets")]
    db.expire_all()
    assert db.get(LimsAnalysis, vial_id).review_state == "assigned"
    assert db.query(LimsAnalysisPromotion).count() == 0


def test_a_malformed_request_is_a_400_or_422_that_writes_nothing(client, db):
    w = _world(client, db)
    item, vial = _row(db, w)
    stray, _ = _row(db, w, "P-4009-S01", ws=_ws(db, "Another run"))
    db.commit()
    vial_id = vial.id
    dup = _promote(client, w.ws, _line(item), _line(item))
    assert dup.status_code == 400 and "more than once" in dup.json()["detail"]
    too_many = _promote(client, w.ws, _line(item), _line(stray))   # 2 entries, 1 item
    assert too_many.status_code == 400 and "more rows" in too_many.json()["detail"]
    wrong_type = client.post(f"/worksheets/{w.ws.id}/promote",
                             json={"rows": [{**_line(item), "value": "lots"}]})
    assert wrong_type.status_code == 422
    db.expire_all()
    assert db.get(LimsAnalysis, vial_id).review_state == "assigned"
    assert db.query(LimsAnalysisPromotion).count() == 0
    assert db.query(AuditLog).filter(AuditLog.operation == "endo_worksheet_promoted").count() == 0


# --- the unit rule mirrors the browser (preflight ruling F1) ------------------

def test_a_peptide_row_set_to_the_bac_water_form_is_refused(client, db):
    # The browser's bac !== isBacWaterSample(s): the row's form says bac
    # water, the sample says peptide, so EU/mL is never accepted for it.
    w = _world(client, db)
    item, _ = _row(db, w, reading="<0.2", cartridge=w.c01)
    item.prep_form = "bac"
    db.commit()
    assert _results(_promote(client, w.ws, _line(item, 0.2, unit="EU/mL", loq=0.2, lod=0.01))) == [
        _refused(item, "peptides promote in EU/vial")]


@pytest.mark.parametrize("reading, value", [(">5", 2500), (">0.7", 350)])
def test_a_gt_reading_that_already_fails_promotes_as_a_floor(client, db, reading, value):
    """Handler ruling 2026-10-26: a ">" is judged as "at least this much". Once
    the floor itself reaches the 350 EU/vial limit it is a definitive failure
    whatever the true value is, so it reports. 350 exactly fails: the bound is
    inclusive, and "at least 350" is not a pass. The row carries result_floor,
    so the spec engine judges it as a floor instead of as a measurement."""
    w = _world(client, db)
    item, vial = _row(db, w, reading=reading, cartridge=w.c05)
    db.commit()
    vial_id = vial.id
    [res] = _results(_promote(client, w.ws,
                              _line(item, value, loq=25, result_floor=True)))
    assert res["promoted"] is True, res
    [parent] = _parent_rows(db, "P-4001")
    vial = db.get(LimsAnalysis, vial_id)
    # The floor flag rides the value from the vial to the parent, and the LOQ
    # stays the run's (25), unlike a "<" where value and LOQ are one number.
    assert (vial.result_value, vial.result_floor, vial.loq) == (str(value), True, 25.0)
    assert (parent.result_value, parent.result_unit, parent.result_floor,
            parent.loq) == (str(value), "EU/vial", True, 25.0)
    audit = db.query(AuditLog).filter(AuditLog.operation == "endo_worksheet_promoted").one()
    assert audit.details["result_floor"] is True


def test_bac_water_promotes_a_floor_in_its_own_unit(client, db):
    """Bac water has its own unit, its own spec (0 to 0.25 EU/mL) and scale=1:
    the reading IS the result, the instrument having applied the 20x. ">20"
    against 0.25 is a definitive failure by a wide margin."""
    w = _world(client, db)
    item, _ = _row(db, w, "BW-0200-S01", sample_type="Bacteriostatic Water", reading=">20",
                   cartridge=w.c01)
    db.commit()
    [res] = _results(_promote(client, w.ws,
                              _line(item, 20, unit="EU/mL", loq=0.2, lod=0.01,
                                    result_floor=True)))
    assert res["promoted"] is True, res
    [parent] = _parent_rows(db, "BW-0200")
    assert (parent.result_value, parent.result_unit, parent.result_floor,
            parent.loq) == ("20", "EU/mL", True, 0.2)
    # And a bac water floor under its own limit is refused, in EU/mL.
    under, _ = _row(db, w, "BW-0201-S01", sample_type="Bacteriostatic Water", reading=">0.1",
                    cartridge=w.c01)
    db.commit()
    assert _results(_promote(client, w.ws, _line(under, 0.1, unit="EU/mL", loq=0.2, lod=0.01,
                                                 result_floor=True))) == [
        _refused(under, "inconclusive: a floor of 0.1 EU/mL does not reach the "
                        f"0.25 limit; {worksheets_endo_promote.REASON_GT}")]


def test_a_gt_reading_under_the_limit_is_refused_as_inconclusive(client, db):
    """A floor that stops short of the limit says nothing: the true value may
    be either side of it. Refused, with the re-run instruction."""
    w = _world(client, db)
    item, _ = _row(db, w, reading=">0.5", cartridge=w.c05)
    db.commit()
    assert _results(_promote(client, w.ws, _line(item, 250, loq=25, result_floor=True))) == [
        _refused(item, "inconclusive: a floor of 250 EU/vial does not reach the "
                       f"350 limit; {worksheets_endo_promote.REASON_GT}")]


@pytest.mark.parametrize("reading, value, floor", [
    (">5", 2500, False),   # a floor passed off as a measurement
    ("<0.05", 25, True),   # a measurement passed off as a floor
])
def test_the_browser_cannot_lie_about_whether_the_value_is_a_floor(client, db, reading,
                                                                   value, floor):
    """result_floor is checked against the stored reading like every other
    number (final review I-3). Claiming a ">2500" is a measurement would have
    the spec engine judge the floor; claiming a measurement is a floor would
    print a ">" the bench never wrote."""
    w = _world(client, db)
    item, _ = _row(db, w, reading=reading, cartridge=w.c05)
    db.commit()
    assert _results(_promote(client, w.ws,
                             _line(item, value, loq=25, result_floor=floor))) == [
        _refused(item, worksheets_endo_promote.REASON_BAD_NUMBERS)]


def test_a_bw_sample_set_to_the_powder_form_is_refused(client, db):
    # Only the BW- id says bac water here; the row's form says powder.
    w = _world(client, db)
    item, _ = _row(db, w, "BW-0300-S01", sample_type=None)
    item.prep_form = "powder"
    db.commit()
    assert _results(_promote(client, w.ws, _line(item))) == [
        _refused(item, "bac water promotes in EU/mL")]


@pytest.mark.parametrize("source", ["analyses_json", "service_group"])
def test_bac_water_named_only_by_its_analyses_promotes_in_eu_ml(client, db, source):
    # The browser's endoIdentityFor: no sample identity, so the identity is
    # the item's analysis peptide names, as GET /worksheets serves them.
    w = _world(client, db)
    item, _ = _row(db, w, "P-4700-S01", sample_type=None, reading="<0.2", cartridge=w.c01)
    if source == "analyses_json":
        item.analyses_json = json.dumps([{"title": w.svc.title, "keyword": w.svc.keyword,
                                          "peptide_name": "Bacteriostatic Water", "method": None}])
    else:
        member = _service(db, "ENDOTOXIN-BW")
        member.peptide_name = "Bacteriostatic Water"
        group = ServiceGroup(name="Endotoxin bac water")
        db.add(group)
        db.flush()
        db.execute(service_group_members.insert().values(service_group_id=group.id,
                                                         analysis_service_id=member.id))
        item.service_group_id = group.id
    db.commit()
    item_id = item.id
    [served] = [it for it in client.get(f"/worksheets/{w.ws.id}").json()["items"]
                if it["id"] == item_id]
    assert (served["sample_identity"], served["prep_form"]) == (None, None)
    assert [a["peptide_name"] for a in served["analyses"]] == ["Bacteriostatic Water"]
    [res] = _results(_promote(client, w.ws, _line(item, 0.2, unit="EU/mL", loq=0.2, lod=0.01)))
    assert res["promoted"] is True, res
    [parent] = _parent_rows(db, "P-4700")
    assert (parent.result_value, parent.result_unit, parent.loq) == ("0.2", "EU/mL", 0.2)


# --- reason numbers print like the browser's fmt (preflight ruling F3) -------

@pytest.mark.parametrize("value, text", [
    (0.0025, "0.003"), (0.05, "0.05"), (0.2, "0.2"), (25.0, "25"), (350.0, "350"),
    (3.75, "3.75")])
def test_reason_numbers_print_like_the_browsers_fmt(value, text):
    assert worksheets_endo_promote._fmt(value) == text


def test_a_floor_reason_prints_the_sensitivity_to_three_decimals(client, db):
    # :g would print 0.0025; the browser's fmt prints 0.003.
    w = _world(client, db)
    c0025 = _cartridge(db, "Endosafe 0.0025", 0.0025)
    item, _ = _row(db, w, reading="<0.003", cartridge=c0025)
    db.commit()
    assert _results(_promote(client, w.ws, _line(item, 1.5, loq=1.5, lod=0.0025))) == [
        _refused(item, "the reading <0.003 is not this cartridge's sensitivity (0.003)")]


# --- the keyword is pinned (preflight ruling F5) -----------------------------

def test_a_native_endotoxin_service_under_another_keyword_is_manual_entry(client, db):
    w = _world(client, db)
    other = _service(db, "ENDOTOXIN-KINETIC")     # mk1 and an endo keyword, not USP85LAL
    item, _ = _row(db, w, service=other)
    db.commit()
    assert _results(_promote(client, w.ws, _line(item))) == [
        _refused(item, "manual entry: SENAITE-born endotoxin")]


# --- Review Focus 2: the same rows promoted twice ----------------------------

def test_the_same_rows_promoted_twice_are_refused_never_duplicated(client, db):
    w = _world(client, db)
    first, _ = _row(db, w)
    sibling, _ = _row(db, w, "P-4001-S02")   # a second endotoxin vial of the same sample
    db.commit()
    assert _results(_promote(client, w.ws, _line(first)))[0]["promoted"] is True
    # A double click, a second tab or a second analyst sends the rows again.
    assert _results(_promote(client, w.ws, _line(first), _line(sibling))) == [
        _refused(first, "already promoted"), _refused(sibling, HOLDS)]
    live = [p for p in _parent_rows(db, "P-4001") if p.review_state not in ("retracted", "rejected")]
    assert len(live) == 1


def test_a_parent_index_conflict_refuses_the_row_and_rolls_its_fill_back(client, db, monkeypatch):
    """Two requests racing past the checks: the parent's unique index
    refuses the second insert on Postgres, and Task 2 maps it to
    PromoteError("parent_row_already_exists"). The row is refused, never a
    500, and its fill is rolled back with it."""
    w = _world(client, db)
    item, vial = _row(db, w)
    db.commit()
    vial_id = vial.id

    def conflict(*args, **kwargs):
        raise PromoteError("parent_row_already_exists", 409, "a parent-tier row already exists")

    monkeypatch.setattr(promote_flow, "run_promote", conflict)
    assert _results(_promote(client, w.ws, _line(item))) == [_refused(item, HOLDS)]
    db.expire_all()
    v = db.get(LimsAnalysis, vial_id)
    assert (v.review_state, v.result_value, v.result_unit, v.loq) == ("assigned", None, None, None)
    assert db.query(LimsAnalysisTransition).filter_by(analysis_id=vial_id,
                                                      transition_kind="submit").count() == 0


def test_an_unexpected_error_refuses_only_its_own_row(client, db, monkeypatch):
    w = _world(client, db)
    first, first_vial = _row(db, w)
    second, _ = _row(db, w, "P-4002-S01")
    db.commit()
    first_vial_id = first_vial.id
    real = promote_flow.run_promote

    def flaky(db_, user, req, **kwargs):
        if req.sources[0].analysis_id == first_vial_id:
            raise RuntimeError("boom")
        return real(db_, user, req, **kwargs)

    monkeypatch.setattr(promote_flow, "run_promote", flaky)
    res = _results(_promote(client, w.ws, _line(first), _line(second)))
    assert [(r["promoted"], r["reason"]) for r in res] == [
        (False, "not promoted: an unexpected error, see the server log"), (True, None)]
    db.expire_all()
    v = db.get(LimsAnalysis, first_vial_id)
    assert (v.review_state, v.result_value) == ("assigned", None)


def test_a_later_rows_refusal_keeps_an_earlier_rows_audit(client, db, monkeypatch):
    """run_promote rolls the whole session back before any refusal (A6), so
    a promoted row's provenance audit must already be committed when the
    next row's promote is refused."""
    w = _world(client, db)
    first, _ = _row(db, w)
    second, second_vial = _row(db, w, "P-4002-S01")
    db.commit()
    first_id, second_vial_id = first.id, second_vial.id
    real = promote_flow.run_promote

    def refuse_second(db_, user, req, **kwargs):
        if req.sources[0].analysis_id == second_vial_id:
            db_.rollback()      # as run_promote does before every PromoteError
            raise PromoteError("bad_request", 400, "refused for the test")
        return real(db_, user, req, **kwargs)

    monkeypatch.setattr(promote_flow, "run_promote", refuse_second)
    res = _results(_promote(client, w.ws, _line(first), _line(second)))
    assert [(r["promoted"], r["reason"]) for r in res] == [(True, None),
                                                           (False, "refused for the test")]
    db.expire_all()
    audits = db.query(AuditLog).filter(AuditLog.operation == "endo_worksheet_promoted").all()
    assert [a.details["item_id"] for a in audits] == [first_id]


# --- final review I-1: two requests promoting one row at once -----------------

def test_plan_rereads_the_vial_under_a_row_lock_before_its_state_checks(client, db, monkeypatch):
    """_plan re-reads the vial with SELECT ... FOR UPDATE before it judges
    the state, so a request that waited on the lock judges the row as the
    winner committed it. SQLite ignores the lock; the spy shows the call and
    its order: the state it sets after the re-read decides the refusal."""
    w = _world(client, db)
    item, vial = _row(db, w)
    db.commit()
    vial_id = vial.id
    real = db.refresh
    locked = []

    def spy(instance, *args, **kwargs):
        real(instance, *args, **kwargs)
        if isinstance(instance, LimsAnalysis) and kwargs.get("with_for_update") is True:
            locked.append(instance.id)
            instance.review_state = "promoted"     # the winner's commit, as the waiter reads it

    monkeypatch.setattr(db, "refresh", spy)
    assert _results(_promote(client, w.ws, _line(item))) == [_refused(item, "already promoted")]
    assert locked == [vial_id]


@pytest.mark.parametrize("winner, reason", [
    ("review_state = 'promoted'", "already promoted"),
    # A reviewer filled and retested it meanwhile: the live row is one this request never loaded.
    ("review_state = 'to_be_verified', retested = 1", "the vial's endotoxin analysis is retested"),
])
def test_a_retest_row_changed_by_another_request_meanwhile_is_refused(client, db, monkeypatch,
                                                                       winner, reason):
    """Request B loaded the retest row before request A committed. The row
    changes in the database between B's batched load and its _plan, behind
    the session's back, as the lock waiter sees A's commit on Postgres. The
    re-read state wins: B is refused and never retracts the parent."""
    w = _world(client, db)
    item, vial = _row(db, w)
    db.commit()
    vial_id = vial.id
    [first] = _results(_promote(client, w.ws, _line(item)))
    apply_transition(db, analysis_id=first["parent_analysis_id"], kind="verify", user_id=1)
    retest_id = apply_transition(db, analysis_id=vial_id, kind="retest", user_id=1).id
    item.result_reading = "0.1"
    db.commit()
    parents = [(p.id, p.review_state) for p in _parent_rows(db, "P-4001")]
    real_plan = worksheets_endo_promote._plan

    def winner_commits_first(db_, *args):
        # Raw SQL leaves the session's loaded copy stale; a commit here would expire it.
        db_.execute(text(f"UPDATE lims_analyses SET {winner} WHERE id = :id"), {"id": retest_id})
        return real_plan(db_, *args)

    monkeypatch.setattr(worksheets_endo_promote, "_plan", winner_commits_first)
    assert _results(_promote(client, w.ws, _line(item, 50))) == [_refused(item, reason)]
    assert [(p.id, p.review_state) for p in _parent_rows(db, "P-4001")] == parents


# --- Review Focus 1: a vial retested after its reading was taken -------------

def test_a_retested_vial_promotes_its_current_row_and_supersedes_the_parent(client, db):
    w = _world(client, db)
    item, vial = _row(db, w)
    db.commit()
    vial_id = vial.id
    [first] = _results(_promote(client, w.ws, _line(item)))
    old_parent_id = first["parent_analysis_id"]
    # The reviewer verifies, then the lab retests the vial: the retest row is now its live row.
    apply_transition(db, analysis_id=old_parent_id, kind="verify", user_id=1)
    new_row_id = apply_transition(db, analysis_id=vial_id, kind="retest", user_id=1).id
    item.result_reading = "0.1"           # the rerun reads 0.1: 0.1 x 250 x 2 = 50 EU per vial
    db.commit()
    [res] = _results(_promote(client, w.ws, _line(item, 50)))
    assert res["promoted"] is True and res["parent_analysis_id"] != old_parent_id
    db.expire_all()
    assert db.get(LimsAnalysis, old_parent_id).review_state == "retracted"
    superseded = db.query(LimsAnalysisTransition).filter_by(analysis_id=old_parent_id,
                                                            to_state="retracted").one()
    assert superseded.reason.startswith("superseded by retest promotion")
    live = [p for p in _parent_rows(db, "P-4001") if p.review_state not in ("retracted", "rejected")]
    assert [(p.id, p.result_value, p.loq) for p in live] == [(res["parent_analysis_id"], "50", 25.0)]
    new = db.get(LimsAnalysis, new_row_id)
    assert (new.review_state, new.result_value, new.retest_of_id) == ("promoted", "50", vial_id)
    assert db.get(LimsAnalysis, vial_id).result_value == "25"     # the first attempt, as it was


# --- final review I-3: the sent numbers match the stored reading -------------

def _audits(db):
    return db.query(AuditLog).filter(AuditLog.operation == "endo_worksheet_promoted").all()


def test_a_peptide_loq_off_the_rows_sensitivity_x_total_x_water_is_refused(client, db):
    # 0.05 x 250 x 2 = 25 EU per vial is the only LOQ these rows can have.
    w = _world(client, db)
    exact, _ = _row(db, w, "P-4001-S01", reading="0.1")      # 0.1 x 250 x 2 = 50
    below, _ = _row(db, w, "P-4002-S01")                      # <0.05: <25
    db.commit()
    assert _results(_promote(client, w.ws, _line(exact, 50, loq=30),
                             _line(below, 30, loq=30))) == [_refused(exact, BAD),
                                                            _refused(below, BAD)]
    assert _audits(db) == []


@pytest.mark.parametrize("field, stored, sent", [
    ("prep_water_ml", 3.0, 37.5),          # 0.05 x 250 x 3
    ("prep_total_dilution", 500.0, 50.0),  # 0.05 x 500 x 2
])
def test_a_stale_tab_whose_row_changed_since_is_refused(client, db, field, stored, sent):
    """The browser computed 25 at 2 mL and 1:250; another analyst then
    changed the row. The stale numbers are refused; the row's current ones
    promote, and the audit records the inputs they came from."""
    w = _world(client, db)
    item, _ = _row(db, w)
    setattr(item, field, stored)
    db.commit()
    assert _results(_promote(client, w.ws, _line(item))) == [_refused(item, BAD)]
    [res] = _results(_promote(client, w.ws, _line(item, sent, loq=sent)))
    assert res["promoted"] is True, res
    [audit] = _audits(db)
    assert (audit.details["total_dilution"], audit.details["water_ml"], audit.details["loq"]) == (
        stored if field == "prep_total_dilution" else 250,
        stored if field == "prep_water_ml" else 2, sent)


@pytest.mark.parametrize("value, loq, ok", [
    (0.1, 0.2, True),      # the reading itself, LOQ 0.01 x 20
    (2.0, 0.2, False),     # the reading x 20: bac water reads in EU/mL already
    (0.1, 0.01, False),    # the LOQ without the 20x
])
def test_bac_water_sends_its_reading_and_an_loq_of_sensitivity_x_20(client, db, value, loq, ok):
    w = _world(client, db)
    item, _ = _row(db, w, "BW-0100-S01", sample_type="Bacteriostatic Water", reading="0.1",
                   cartridge=w.c01)
    db.commit()
    [res] = _results(_promote(client, w.ws, _line(item, value, unit="EU/mL", loq=loq, lod=0.01)))
    assert res == ({**res, "promoted": True} if ok else _refused(item, BAD)), res


@pytest.mark.parametrize("reading, cartridge, water, sent, ok", [
    # 0.1234567 x 250 x 2 = 61.72835; Box 3 shows 61.728. 61.729 is 0.00065 off.
    ("0.1234567", None, None, {"value": 61.728, "loq": 25}, True),
    ("0.1234567", None, None, {"value": 61.729, "loq": 25}, False),
    # <0.0025 x 250 x 1.7 = 1.0625, on the half: Box 3 shows 1.063.
    ("<0.0025", 0.0025, 1.7, {"value": 1.063, "loq": 1.063, "lod": 0.0025}, True),
])
def test_numbers_rounded_to_box_3s_three_decimals_still_match(client, db, reading, cartridge,
                                                               water, sent, ok):
    w = _world(client, db)
    c = _cartridge(db, f"Endosafe {cartridge}", cartridge) if cartridge else None
    item, _ = _row(db, w, reading=reading, cartridge=c)
    item.prep_water_ml = water
    db.commit()
    [res] = _results(_promote(client, w.ws, _line(item, **sent)))
    assert res["promoted"] is ok, res
    assert res["reason"] == (None if ok else BAD)
    assert len(_audits(db)) == (1 if ok else 0)


def test_an_exact_row_with_an_loq_far_above_its_value_is_refused(client, db):
    # The D8 case: an LOQ of 1000 would print "< LOQ" and Pass for 50 EU per vial.
    w = _world(client, db)
    item, vial = _row(db, w, reading="0.1")
    db.commit()
    vial_id = vial.id
    assert _results(_promote(client, w.ws, _line(item, 50, loq=1000))) == [_refused(item, BAD)]
    db.expire_all()
    assert db.get(LimsAnalysis, vial_id).result_value is None


def test_a_liquid_row_with_no_water_is_refused(client, db):
    """No stored water: the browser shows no value (waterOf is null) and
    refuses the row, so the server refuses any numbers sent for it, even the
    ones 2 mL would give (controller ruling, 2026-10-13)."""
    w = _world(client, db)
    item, vial = _row(db, w)
    item.prep_form = "liquid"
    db.commit()
    vial_id = vial.id
    assert _results(_promote(client, w.ws, _line(item, 40, loq=40))) == [_refused(item, BAD)]
    assert _results(_promote(client, w.ws, _line(item))) == [_refused(item, BAD)]
    assert _audits(db) == []
    db.expire_all()
    assert db.get(LimsAnalysis, vial_id).result_value is None


# --- the fill: apply_transition's submit-only unit and limits ----------------

def test_submit_alone_takes_the_unit_and_the_results_limits(client, db):
    w = _world(client, db)
    _, vial = _row(db, w)
    db.commit()
    vial_id = vial.id
    with pytest.raises(BadRequestError, match="only apply to kind='submit'"):
        apply_transition(db, analysis_id=vial_id, kind="reset", loq=25.0, user_id=1)
    db.rollback()
    apply_transition(db, analysis_id=vial_id, kind="submit", result_value="25",
                     result_unit="EU/vial", loq=25.0, lod=0.05, lod_unit="EU/mL", user_id=1)
    t = db.query(LimsAnalysisTransition).filter_by(analysis_id=vial_id,
                                                   transition_kind="submit").one()
    assert {f: c["after"] for f, c in t.details["changed"].items()} == {
        "result_value": "25", "result_unit": "EU/vial", "loq": 25.0, "lod": 0.05,
        "lod_unit": "EU/mL"}


@pytest.mark.parametrize("host", ["vial", "parent"])
def test_a_corrected_value_without_limits_clears_them_and_an_unchanged_one_keeps_them(db, host):
    """A worksheet LOQ describes the value it came with. A hand correction on
    the sample page (the to_be_verified self-edge) sends no limits, so they
    go, as they go with every cleared value (clear_result_limits); a re-save
    of the same value keeps them. On a vial, and on a parent-hosted row
    still acting as a vial (state_machine.tier_of)."""
    svc = _service(db)
    parent = LimsSample(sample_id="P-4100", external_lims_uid="SEN-P-4100",
                        sample_type_title="Peptide")
    db.add(parent)
    db.flush()
    host_fk = {"lims_sample_pk": parent.id}
    if host == "vial":
        vial = LimsSubSample(sample_id="P-4100-S01", parent_sample_pk=parent.id, vial_sequence=1,
                             external_lims_uid="mk1://P-4100-S01", assignment_role="endo85")
        db.add(vial)
        db.flush()
        host_fk = {"lims_sub_sample_pk": vial.id}
    row = LimsAnalysis(**host_fk, analysis_service_id=svc.id, keyword=svc.keyword,
                       title=svc.title, review_state="to_be_verified", provenance="canonical",
                       result_value="25", result_unit="EU/vial", loq=25.0, lod=0.05,
                       lod_unit="EU/mL")
    db.add(row)
    db.commit()
    row_id = row.id

    apply_transition(db, analysis_id=row_id, kind="submit", result_value="25", user_id=1)
    db.expire_all()
    kept = db.get(LimsAnalysis, row_id)
    assert (kept.result_value, kept.loq, kept.lod, kept.lod_unit) == ("25", 25.0, 0.05, "EU/mL")

    apply_transition(db, analysis_id=row_id, kind="submit", result_value="30", user_id=1)
    db.expire_all()
    cleared = db.get(LimsAnalysis, row_id)
    assert (cleared.result_value, cleared.loq, cleared.lod, cleared.lod_unit) == (
        "30", None, None, None)
    last = db.query(LimsAnalysisTransition).filter_by(
        analysis_id=row_id, transition_kind="submit").order_by(LimsAnalysisTransition.id.desc()).first()
    assert {f: last.details["changed"][f] for f in ("loq", "lod", "lod_unit")} == {
        "loq": {"before": 25.0, "after": None}, "lod": {"before": 0.05, "after": None},
        "lod_unit": {"before": "EU/mL", "after": None}}


# --- the internal promote's limits are bounded too ---------------------------

@pytest.mark.parametrize("field, value", [
    ("loq", float("nan")), ("loq", -1.0), ("lod", 0.0), ("lod", float("inf"))])
def test_a_promote_request_refuses_an_unusable_loq_or_lod(field, value):
    # The COA prints a stored LOQ (Task 4), so NaN, inf, 0 or a negative never
    # reaches it. Only the worksheet promote sends limits (final review I-3),
    # in the PromoteRequest it hands run_promote directly; the public route
    # refuses any (test_promote_flow.py). FastAPI's json.loads gives these floats.
    with pytest.raises(ValidationError) as caught:
        PromoteRequest(keyword="ENDOTOXIN-USP85LAL", result_value="25",
                       sources=[{"analysis_id": 1, "contribution_kind": "chosen"}],
                       **{field: value})
    assert [e["loc"] for e in caught.value.errors()] == [(field,)]


# --- end to end: the promoted "<" result prints "< <LOQ>" on the COA ---------

@pytest.mark.parametrize("sample_id, sample_type, reading, sensitivity, sent, loq", [
    # <0.05 on the 0.05 at the standard 1:250 and 2 mL: <25 EU per vial.
    ("P-4001-S01", "Peptide", "<0.05", 0.05,
     {"value": 25, "unit": "EU/vial", "loq": 25, "lod": 0.05}, 25.0),
    # Bac water <0.2 on the 0.01 (0.01 x 20), in EU/mL of the water.
    ("BW-0100-S01", "Bacteriostatic Water", "<0.2", 0.01,
     {"value": 0.2, "unit": "EU/mL", "loq": 0.2, "lod": 0.01}, 0.2),
    # A non-integer LOQ: <0.005 on the 0.005, 0.005 x 250 x 2 = 2.5 EU per vial.
    ("P-4001-S01", "Peptide", "<0.005", 0.005,
     {"value": 2.5, "unit": "EU/vial", "loq": 2.5, "lod": 0.005}, 2.5),
])
def test_a_promoted_below_loq_result_prints_less_than_loq_on_the_coa(
        client, db, monkeypatch, sample_id, sample_type, reading, sensitivity, sent, loq):
    w = _world(client, db)
    cartridge = {0.05: w.c05, 0.01: w.c01}.get(sensitivity) or _cartridge(
        db, f"Endosafe {sensitivity}", sensitivity)
    item, _ = _row(db, w, sample_id, sample_type=sample_type, reading=reading,
                   cartridge=cartridge)
    profile = AnalysisProfile(key="endotoxin", name="Endotoxin", is_addon=True,
                              coa_archetype="limit_table", coa_sort_order=10)
    db.add(profile)
    db.flush()
    db.execute(analysis_profile_members.insert().values(
        analysis_profile_id=profile.id, analysis_service_id=w.svc.id, sort_order=0))
    db.commit()

    [res] = worksheets_endo_promote.promote_rows(
        db, MagicMock(id=1, email="qa@accumark.test"), w.ws,
        [worksheets_endo_promote.EndoPromoteRowIn(item_id=item.id, lod_unit="EU/mL", **sent)])
    assert res.promoted is True, res
    apply_transition(db, analysis_id=res.parent_analysis_id, kind="verify", user_id=1)
    stored = db.get(LimsAnalysis, res.parent_analysis_id)
    # The same float, so the COA's value <= LOQ holds exactly.
    assert float(stored.result_value) == stored.loq == loq

    monkeypatch.setattr("coa.native_sections.fetch_sample_services",
                        lambda _sample_id: {"services": {"endotoxin": True}, "package": None})
    parent = db.get(LimsSample, stored.lims_sample_pk)
    [section] = build_native_sections(db, parent)["sections"]
    [row] = section["rows"]
    assert (row["result"], row["unit"], row["result_display"], row["conforms"],
            row["specification"]["loq"]) == (stored.result_value, sent["unit"], f"< {loq:g}", True, loq)
    assert row["result_display"] in ("< 25", "< 0.2", "< 2.5")


# --- endo_analysis on worksheet items ----------------------------------------

def test_endotoxin_items_carry_their_live_vial_analysis(client, db):
    w = _world(client, db)
    lal = _service(db, "ENDO-LAL")
    lal.origin = "senaite"
    hplc = _service(db, "BPC157-PURITY")
    done, done_vial = _row(db, w)
    senaite, senaite_vial = _row(db, w, "P-4002-S01", service=lal)
    two, two_vial = _row(db, w, "P-4003-S01")
    db.add(LimsAnalysis(lims_sub_sample_pk=two_vial.lims_sub_sample_pk, analysis_service_id=w.svc.id,
                        keyword=w.svc.keyword, title=w.svc.title, review_state="assigned",
                        provenance="canonical"))
    hplc_item, _ = _row(db, w, "P-4004-S01", service=hplc, reading=None, role="hplc")
    db.commit()
    ids = SimpleNamespace(done=done.id, done_vial=done_vial.id, senaite=senaite.id,
                          senaite_vial=senaite_vial.id, two=two.id, hplc=hplc_item.id)
    _results(_promote(client, w.ws, _line(done)))
    items = {it["id"]: it for it in client.get(f"/worksheets/{w.ws.id}").json()["items"]}
    assert items[ids.done]["endo_analysis"] == {
        "id": ids.done_vial, "state": "promoted", "keyword": "ENDOTOXIN-USP85LAL", "native": True}
    assert items[ids.senaite]["endo_analysis"] == {
        "id": ids.senaite_vial, "state": "assigned", "keyword": "ENDO-LAL", "native": False}
    assert items[ids.two]["endo_analysis"] is None
    assert "endo_analysis" not in items[ids.hplc]
    listed = next(ws for ws in client.get("/worksheets").json() if ws["id"] == w.ws.id)
    assert {it["id"]: it.get("endo_analysis") for it in listed["items"]} == {
        k: v.get("endo_analysis") for k, v in items.items()}


def test_the_endo_analysis_lookup_is_one_query_whatever_the_row_count(client, db):
    w = _world(client, db)
    small = [_row(db, w, f"P-61{n:02d}-S01")[0].sample_id for n in range(3)]
    big = [_row(db, w, f"P-62{n:02d}-S01")[0].sample_id for n in range(12)]
    db.commit()
    for sample_ids in (small, big):
        db.expire_all()
        with _count_sql(db) as seen:
            out = worksheets_endo_promote.endo_analysis_by_sample(db, sample_ids)
            assert all(v["native"] and v["state"] == "assigned" for v in out.values())
        assert len(seen) == 1, seen
    assert worksheets_endo_promote.endo_analysis_by_sample(db, []) == {}


def test_get_worksheet_reads_endo_analyses_in_a_fixed_number_of_queries(client, db):
    w = _world(client, db)
    big = _ws(db, "Big run")
    big.endo_method_id = w.mid     # pinned like the small one, so both resolve the method alike
    for n in range(2):
        _row(db, w, f"P-63{n:02d}-S01")
    for n in range(8):
        _row(db, w, f"P-64{n:02d}-S01", ws=big)
    db.commit()
    counts = []
    for ws_id in (w.ws.id, big.id):
        db.expire_all()
        with _count_sql(db) as seen:
            assert client.get(f"/worksheets/{ws_id}").status_code == 200
        counts.append(len(seen))
    assert counts[0] == counts[1], counts
