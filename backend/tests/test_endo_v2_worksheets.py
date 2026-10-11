"""Endo worksheet v2 on the server (spec
docs/superpowers/specs/2026-10-10-endo-worksheet-v2-design.md, sections 3.6,
3.7, 4 and 8 to 10): the run and row fields, the worksheet's endo method
(resolved in a fixed number of queries, pinned at first print or first
reading) and the reader import. In-memory SQLite + dependency overrides, no
live stack; the test_worksheet_endo_prep.py pattern."""
import json
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import worksheets_endo
from auth import get_current_user
from database import Base, get_db
from main import app
from models import (
    AnalysisService, AuditLog, ConsumableType, HplcMethod, Instrument, LimsAnalysis,
    LimsSample, LimsSubSample, Worksheet, WorksheetItem, instrument_methods,
    method_consumables,
)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


# --- Task 5: reading and step grammar ----------------------------------------


@pytest.mark.parametrize("text, expected", [
    ("0.8", (False, 0.8)),
    ("0", (False, 0.0)),
    (".5", (False, 0.5)),
    ("<0.05", (True, 0.05)),
    ("< 0.05", (True, 0.05)),
    (" 0.8 ", (False, 0.8)),
])
def test_parse_reading_accepts_the_instrument_display(text, expected):
    assert worksheets_endo.parse_reading(text) == expected


@pytest.mark.parametrize("text", [
    "", "   ", "abc", "0,8", "-1", "<0", "< 0", "1.", "1e3", "0.8 EU", "1" * 41,
])
def test_parse_reading_refuses_anything_else_with_a_reason(text):
    with pytest.raises(ValueError, match="reading"):
        worksheets_endo.parse_reading(text)


def test_validate_prep_steps_keeps_standard_and_own_values():
    assert worksheets_endo.validate_prep_steps([None, None, None]) == [None, None, None]
    assert worksheets_endo.validate_prep_steps([[20, 5], [30], None]) == [[20, 5], [30], None]
    # A null field inside a step means "standard" for that field (Dennis's stepsOf).
    assert worksheets_endo.validate_prep_steps([[None, 4], None, [100]]) == [[None, 4], None, [100]]


@pytest.mark.parametrize("bad", [
    "steps",
    [],
    [None, None],
    [None, None, None, None],
    [[], None, None],
    [[0, 10], None, None],          # sample uL must be above zero
    [[20, 0.5], None, None],        # step 1 ratio below 1
    [None, [20, 3], None],          # only step 1 carries a ratio
    [None, None, [-5]],
    [["20"], None, None],
    [[True], None, None],
    [[float("inf")], None, None],
    [[10**400], None, None],        # too big for a float: a 400, never a 500
    [{"sampleUl": 20}, None, None],
])
def test_validate_prep_steps_refuses_malformed_values(bad):
    with pytest.raises(ValueError):
        worksheets_endo.validate_prep_steps(bad)


# --- Task 5: method resolution, pinning, serializer -------------------------


def _cartridge(db, name, sensitivity, *, kind="endo_cartridge", active=True):
    ct = ConsumableType(kind=kind, name=name, active=active, origin="mk1",
                        specs={"sensitivity_eu_ml": sensitivity} if sensitivity is not None else {})
    db.add(ct)
    db.flush()
    return ct


def _service(db, keyword="ENDOTOXIN-USP85LAL"):
    svc = AnalysisService(title=f"Endotoxin ({keyword})", keyword=keyword, origin="mk1",
                          active=True, variance_capable=False)
    db.add(svc)
    db.flush()
    return svc


def _method(client, db, name, service, cartridges=(), run_parameters=None):
    """An active method, the default for `service`, allowing `cartridges`
    ((type, is_default) pairs). The links go in while it is a draft, because
    method consumables are draft-only (Task 3)."""
    mid = client.post("/hplc/methods", json={"name": name, "technique": "LAL"}).json()["id"]
    for ct, is_default in cartridges:
        db.execute(method_consumables.insert().values(
            method_id=mid, consumable_type_id=ct.id, kind=ct.kind, is_default=is_default))
    if run_parameters is not None:
        db.get(HplcMethod, mid).run_parameters = run_parameters
    db.commit()
    client.put(f"/hplc/methods/{mid}/services",
               json=[{"analysis_service_id": service.id, "is_default": True}])
    assert client.post(f"/hplc/methods/{mid}/activate").status_code == 200
    return mid


def _ws(db, title="Endo 10/09/2026", status="open"):
    ws = Worksheet(title=title, status=status)
    db.add(ws)
    db.flush()
    return ws


def _vial_item(db, ws, n, service, *, state="assigned", role="endo85"):
    """Vial P-3001-S<n> on `ws`, with one analysis on `service` in `state`."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == "P-3001")).scalar_one_or_none()
    if parent is None:
        parent = LimsSample(sample_id="P-3001", external_lims_uid="SEN-P-3001",
                            declared_total_quantity="10.00", sample_type_title="Peptide",
                            analytes=json.dumps([{"name": "BPC-157", "declared_quantity": None}]))
        db.add(parent)
        db.flush()
    vial = LimsSubSample(sample_id=f"P-3001-S{n:02d}", parent_sample_pk=parent.id,
                         vial_sequence=n, external_lims_uid=f"mk1://endo-{n}",
                         assignment_role=role)
    db.add(vial)
    db.flush()
    row = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=service.id,
                       keyword=service.keyword, title=service.title, review_state=state,
                       provenance="canonical")
    item = WorksheetItem(worksheet_id=ws.id, sample_uid=vial.external_lims_uid,
                         sample_id=vial.sample_id)
    db.add_all([row, item])
    db.flush()
    return item, row


@contextmanager
def _count_sql(db):
    """Every SQL statement the session's engine runs inside the block (the
    counter in test_flags_context_batch.py)."""
    seen: list[str] = []

    def _on(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", _on)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", _on)


_WS_KEYS = ("endo_prep", "cartridge_type_id", "cartridge_sensitivity_eu_ml", "endo_method_id")
_ITEM_KEYS = ("prep_form", "prep_water_ml", "prep_total_dilution", "prep_steps",
              "cartridge_type_id", "cartridge_sensitivity_eu_ml", "result_reading",
              "result_reader", "result_entered_at", "result_entered_by_user_id")


def test_worksheet_and_item_carry_the_new_keys(client, db):
    ws = _ws(db)
    _vial_item(db, ws, 1, _service(db))
    db.commit()
    body = client.get(f"/worksheets/{ws.id}").json()
    assert {k: body[k] for k in _WS_KEYS} == {
        "endo_prep": "2ml", "cartridge_type_id": None,
        "cartridge_sensitivity_eu_ml": None, "endo_method_id": None}
    assert body["endo_method"] is None
    assert {k: body["items"][0][k] for k in _ITEM_KEYS} == dict.fromkeys(_ITEM_KEYS)
    listed = client.get("/worksheets").json()[0]
    assert {k: listed[k] for k in _WS_KEYS} == {k: body[k] for k in _WS_KEYS}
    # The list endpoint never resolves the method (spec 4.1, cost).
    assert "endo_method" not in listed


def test_endo_method_resolves_to_the_single_active_default_method(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    _cartridge(db, "Endosafe 0.005", 0.005)  # active, but not on the method
    mid = _method(client, db, "Endotoxin", svc, [(c05, True), (c01, False)],
                  run_parameters={"endotoxin": {"cv_limit_pct": 20}})
    # An HPLC row on the same worksheet has its own method; only endo rows count.
    hplc_svc = _service(db, "BPC157-PURITY")
    _method(client, db, "BPC-157 purity", hplc_svc)
    ws = _ws(db)
    _vial_item(db, ws, 1, svc)
    _vial_item(db, ws, 2, svc)
    _vial_item(db, ws, 3, hplc_svc, role="hplc")
    db.commit()

    method = client.get(f"/worksheets/{ws.id}").json()["endo_method"]
    assert {k: method[k] for k in ("id", "name", "revision", "status")} == {
        "id": mid, "name": "Endotoxin", "revision": 1, "status": "active"}
    # The stored column as is; the browser fills missing keys with Dennis's values.
    assert method["run_parameters"] == {"endotoxin": {"cv_limit_pct": 20}}
    assert sorted((c["name"], c["sensitivity_eu_ml"], c["is_default"], c["active"])
                  for c in method["cartridges"]) == [
        ("Endosafe 0.01", 0.01, False, True), ("Endosafe 0.05", 0.05, True, True)]
    # A method that lists cartridges restricts the choice to them.
    assert worksheets_endo.allowed_cartridge_ids(db, ws) == {c05.id, c01.id}


def test_a_method_that_lists_no_cartridges_allows_every_active_endo_cartridge(client, db):
    # Before the lab links cartridges to the method (spec 12, launch step 3)
    # the bench is not blocked: same fallback as when no method resolves.
    svc = _service(db)
    mid = _method(client, db, "Endotoxin", svc)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    _cartridge(db, "Endosafe retired", 0.05, active=False)
    _cartridge(db, "Pipette tip", None, kind="pipette_tip")
    ws = _ws(db)
    _vial_item(db, ws, 1, svc)
    db.commit()
    method = client.get(f"/worksheets/{ws.id}").json()["endo_method"]
    assert method["id"] == mid
    assert method["cartridges"] == []  # so no default either
    assert worksheets_endo.allowed_cartridge_ids(db, ws) == {c05.id, c01.id}


def test_endo_method_is_null_when_rows_disagree_or_any_row_resolves_nothing(client, db):
    svc_a = _service(db, "ENDOTOXIN-USP85LAL")
    svc_b = _service(db, "ENDO-LAL")
    no_method = _service(db, "ENDO-NOMETHOD")
    _method(client, db, "Endotoxin", svc_a)
    _method(client, db, "Endotoxin legacy", svc_b)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    _cartridge(db, "Endosafe retired", 0.05, active=False)
    _cartridge(db, "Pipette tip", None, kind="pipette_tip")
    mixed = _ws(db, "Two methods")
    _vial_item(db, mixed, 1, svc_a)
    _vial_item(db, mixed, 2, svc_b)
    partial = _ws(db, "One row without a method")
    _vial_item(db, partial, 3, svc_a)
    _vial_item(db, partial, 4, no_method)
    bare = _ws(db, "No method")
    _vial_item(db, bare, 5, no_method)
    empty = _ws(db, "No rows")
    db.commit()

    for ws in (mixed, partial, bare, empty):
        assert client.get(f"/worksheets/{ws.id}").json()["endo_method"] is None, ws.title
        # No method: every active endotoxin cartridge is allowed (spec 4.3).
        assert worksheets_endo.allowed_cartridge_ids(db, ws) == {c05.id}, ws.title


def test_a_retested_vial_resolves_through_its_current_row(client, db):
    # The retracted original's service has a different default method. Read
    # through it, the worksheet would look mixed and resolve to nothing.
    old_svc = _service(db, "ENDO-LAL")
    new_svc = _service(db, "ENDOTOXIN-USP85LAL")
    _method(client, db, "Endotoxin legacy", old_svc)
    current = _method(client, db, "Endotoxin", new_svc)
    ws = _ws(db)
    _item, old_row = _vial_item(db, ws, 1, old_svc, state="retracted")
    old_row.retested = True
    db.add(LimsAnalysis(lims_sub_sample_pk=old_row.lims_sub_sample_pk,
                        analysis_service_id=new_svc.id, keyword=new_svc.keyword,
                        title=new_svc.title, review_state="unassigned",
                        provenance="canonical", retest_of_id=old_row.id))
    db.commit()
    assert client.get(f"/worksheets/{ws.id}").json()["endo_method"]["id"] == current


def test_endo_method_resolution_is_batched_not_per_item(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    _method(client, db, "Endotoxin", svc, [(c05, True)])
    small, big = _ws(db, "Small"), _ws(db, "Big")
    for n in range(1, 4):
        _vial_item(db, small, n, svc)
    for n in range(4, 16):
        _vial_item(db, big, n, svc)
    db.commit()

    counts = []
    for ws_id in (small.id, big.id):
        db.expunge_all()
        ws = db.execute(select(Worksheet).where(Worksheet.id == ws_id)).scalar_one()
        with _count_sql(db) as seen:
            assert worksheets_endo.resolve_endo_method(db, ws)["name"] == "Endotoxin"
        counts.append(len(seen))
    # Items with their vials, live analyses, default methods, the method, its cartridges.
    assert counts[0] == counts[1] <= 5, counts


def test_a_pinned_worksheet_keeps_its_revision_after_a_new_one_is_activated(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    rev1 = _method(client, db, "Endotoxin", svc, [(c05, True)],
                   run_parameters={"endotoxin": {"std_total_dilution": 250}})
    printed, control = _ws(db, "Printed"), _ws(db, "Not printed yet")
    _vial_item(db, printed, 1, svc)
    _vial_item(db, control, 2, svc)
    db.commit()
    assert client.post(f"/worksheets/{printed.id}/printed").status_code == 200

    rev2 = client.post(f"/hplc/methods/{rev1}/new-revision").json()["id"]
    db.execute(method_consumables.delete().where(method_consumables.c.method_id == rev2))
    db.execute(method_consumables.insert().values(
        method_id=rev2, consumable_type_id=c01.id, kind=c01.kind, is_default=True))
    db.get(HplcMethod, rev2).run_parameters = {"endotoxin": {"std_total_dilution": 500}}
    db.commit()
    assert client.post(f"/hplc/methods/{rev2}/activate").status_code == 200

    pinned = client.get(f"/worksheets/{printed.id}").json()
    assert pinned["endo_method_id"] == rev1
    assert (pinned["endo_method"]["id"], pinned["endo_method"]["status"]) == (rev1, "retired")
    assert pinned["endo_method"]["run_parameters"] == {"endotoxin": {"std_total_dilution": 250}}
    assert [c["id"] for c in pinned["endo_method"]["cartridges"]] == [c05.id]
    floating = client.get(f"/worksheets/{control.id}").json()
    assert floating["endo_method_id"] is None
    assert (floating["endo_method"]["id"], floating["endo_method"]["revision"]) == (rev2, 2)
    assert [c["id"] for c in floating["endo_method"]["cartridges"]] == [c01.id]


def test_the_first_print_pins_the_method_once(client, db):
    svc = _service(db)
    mid = _method(client, db, "Endotoxin", svc)
    ws = _ws(db)
    _vial_item(db, ws, 1, svc)
    unresolved = _ws(db, "No method")
    _vial_item(db, unresolved, 2, _service(db, "ENDO-NOMETHOD"))
    done = _ws(db, "Completed", status="completed")
    _vial_item(db, done, 3, svc)
    db.commit()

    for _ in range(2):
        assert client.post(f"/worksheets/{ws.id}/printed").status_code == 200
    db.refresh(ws)
    assert ws.endo_method_id == mid
    pins = db.query(AuditLog).filter(AuditLog.operation == "endo_method_pinned").all()
    assert [(p.entity_id, p.details) for p in pins] == [
        (str(ws.id), {"user_id": 1, "old": None, "new": mid})]
    assert client.get(f"/worksheets/{ws.id}").json()["endo_method_id"] == mid

    # Nothing resolves: nothing is pinned. A completed worksheet is read-only.
    for other in (unresolved, done):
        assert client.post(f"/worksheets/{other.id}/printed").status_code == 200
        db.refresh(other)
        assert other.endo_method_id is None, other.title
    assert db.query(AuditLog).filter(AuditLog.operation == "endo_method_pinned").count() == 1


def test_a_retired_cartridge_in_use_still_serializes_with_its_sensitivity(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    _method(client, db, "Endotoxin", svc, [(c05, True)])
    ws = _ws(db)
    item, _ = _vial_item(db, ws, 1, svc)
    ws.cartridge_type_id = c05.id
    item.cartridge_type_id = c05.id
    db.commit()
    c05.active = False  # retired after the run used it
    db.commit()

    body = client.get(f"/worksheets/{ws.id}").json()
    assert (body["cartridge_type_id"], body["cartridge_sensitivity_eu_ml"]) == (c05.id, 0.05)
    assert body["items"][0]["cartridge_sensitivity_eu_ml"] == 0.05
    assert body["endo_method"]["cartridges"] == [
        {"id": c05.id, "name": "Endosafe 0.05", "sensitivity_eu_ml": 0.05,
         "is_default": True, "active": False}]
    listed = next(r for r in client.get("/worksheets").json() if r["id"] == ws.id)
    assert listed["cartridge_sensitivity_eu_ml"] == 0.05
    assert listed["items"][0]["cartridge_sensitivity_eu_ml"] == 0.05
    # Gone from the picker: no new run or row can choose it.
    assert worksheets_endo.allowed_cartridge_ids(db, ws) == set()


def test_instrument_id_for_serial_matches_active_instruments_only(db):
    live = Instrument(name="Nexgen-MCS 1", origin="mk1", active=True, serial_number="NX-1001")
    gone = Instrument(name="Nexgen-MCS old", origin="mk1", active=False, serial_number="NX-0999")
    db.add_all([live, gone])
    db.commit()
    assert worksheets_endo.instrument_id_for_serial(db, " NX-1001 ") == live.id
    assert worksheets_endo.instrument_id_for_serial(db, "NX-0999") is None
    assert worksheets_endo.instrument_id_for_serial(db, "NX-4040") is None
    assert worksheets_endo.instrument_id_for_serial(db, "") is None
    assert worksheets_endo.instrument_id_for_serial(db, None) is None


# --- Task 5: run fields on PUT /worksheets/{id} -----------------------------


def test_put_run_fields_validate_audit_and_lock_on_completion(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    off_method = _cartridge(db, "Endosafe 0.005", 0.005)
    tip = _cartridge(db, "Pipette tip", None, kind="pipette_tip")
    _method(client, db, "Endotoxin", svc, [(c05, True), (c01, False), (tip, False)])
    ws = _ws(db)
    _vial_item(db, ws, 1, svc)
    db.commit()
    url = f"/worksheets/{ws.id}"

    r = client.put(url, json={"endo_prep": "stock", "cartridge_type_id": c01.id})
    assert r.status_code == 200, r.text
    db.refresh(ws)
    assert (ws.endo_prep, ws.cartridge_type_id) == ("stock", c01.id)
    # Null clears the run cartridge; the method default applies again.
    assert client.put(url, json={"cartridge_type_id": None}).status_code == 200
    db.refresh(ws)
    assert ws.cartridge_type_id is None
    assert [(a.operation, a.details["old"], a.details["new"]) for a in db.query(AuditLog)
            .filter(AuditLog.entity_type == "worksheet").order_by(AuditLog.id)] == [
        ("endo_prep_set", "2ml", "stock"),
        ("endo_cartridge_set", None, c01.id),
        ("endo_cartridge_set", c01.id, None)]

    # An unknown prep; a cartridge off the method, of another kind, or missing.
    for bad in ({"endo_prep": "1mg"}, {"endo_prep": None}, {"cartridge_type_id": off_method.id},
                {"cartridge_type_id": tip.id}, {"cartridge_type_id": 99999}):
        assert client.put(url, json=bad).status_code == 400, bad
    c05.active = False  # retired
    db.commit()
    assert client.put(url, json={"cartridge_type_id": c05.id}).status_code == 400

    ws.status = "completed"
    db.commit()
    assert client.put(url, json={"endo_prep": "2ml"}).status_code == 409
    # The older fields keep today's behaviour on a completed worksheet.
    assert client.put(url, json={"title": "Endo 10/09/2026 (done)"}).status_code == 200
    db.refresh(ws)
    assert (ws.endo_prep, ws.title) == ("stock", "Endo 10/09/2026 (done)")


# --- Task 6: row fields on PATCH /worksheets/{ws}/items/{item} ---------------


def _row_world(db):
    """An open worksheet with one endo vial and two active cartridges. No
    method resolves, so every active endotoxin cartridge is allowed (4.3)."""
    ws = _ws(db)
    item, _ = _vial_item(db, ws, 1, _service(db))
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    db.commit()
    return ws, item, c05, c01


_ROW_FIELDS = ("prep_form", "prep_water_ml", "prep_total_dilution", "prep_steps",
               "cartridge_type_id", "result_reading", "result_entered_at",
               "result_entered_by_user_id")


def _row(item):
    return {f: getattr(item, f) for f in _ROW_FIELDS}


def test_patch_sets_and_clears_the_prep_fields_and_audits_the_cartridge(client, db):
    ws, item, c05, _ = _row_world(db)
    url = f"/worksheets/{ws.id}/items/{item.id}"
    r = client.patch(url, json={"prep_form": "liquid", "prep_water_ml": 1.5,
                                "prep_total_dilution": 500, "prep_steps": [[20, 5], None, [100]],
                                "cartridge_type_id": c05.id})
    assert r.status_code == 200, r.text
    # The response keeps today's keys and adds the worksheet's endo method.
    assert {"status", "item_id", "resolved_method", "endo_method"} <= set(r.json())
    db.refresh(item)
    assert (item.prep_form, item.prep_water_ml, item.prep_total_dilution, item.prep_steps,
            item.cartridge_type_id) == ("liquid", 1.5, 500, [[20, 5], None, [100]], c05.id)
    it = client.get(f"/worksheets/{ws.id}").json()["items"][0]
    assert it["prep_steps"] == [[20, 5], None, [100]]
    assert it["cartridge_sensitivity_eu_ml"] == 0.05

    r = client.patch(url, json={"prep_form": None, "prep_water_ml": None,
                                "prep_total_dilution": None, "prep_steps": None,
                                "cartridge_type_id": None})
    assert r.status_code == 200, r.text
    db.refresh(item)
    assert _row(item) == dict.fromkeys(_ROW_FIELDS)
    assert [(a.operation, a.details["old"], a.details["new"]) for a in db.query(AuditLog)
            .filter(AuditLog.operation == "endo_cartridge_set").order_by(AuditLog.id)] == [
        ("endo_cartridge_set", None, c05.id), ("endo_cartridge_set", c05.id, None)]


@pytest.mark.parametrize("payload", [
    {"prep_form": "gel"},
    {"prep_water_ml": 0},
    {"prep_water_ml": -1},
    {"prep_total_dilution": 1.5},
    {"prep_total_dilution": 15},   # below 2 x the standard 1:10 step 1
    {"prep_steps": [[20, 10], None]},
    {"prep_steps": [[20, 0.5], None, None]},
    {"prep_steps": [None, None, [0]]},
    {"cartridge_type_id": 99999},
    # Too big for a float (spec 10: a 400 with the reason, never a 422 or 500).
    {"prep_water_ml": 10**400},
    {"prep_total_dilution": 10**400},
    # A finite but huge int ratio: the floor must not overflow into a 500.
    {"prep_total_dilution": 20, "prep_steps": [[20, 10**308], None, None]},
])
def test_patch_refuses_bad_row_values_and_writes_nothing(client, db, payload):
    ws, item, _, _ = _row_world(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json=payload)
    assert r.status_code == 400, payload
    db.refresh(item)
    assert _row(item) == dict.fromkeys(_ROW_FIELDS)


def test_patch_refuses_a_total_the_steps_cannot_make(client, db):
    ws, item, _, _ = _row_world(db)
    url = f"/worksheets/{ws.id}/items/{item.id}"
    # Standard step 1 (1:10) x the fixed 1:2 step: 20 is the smallest makeable total.
    r = client.patch(url, json={"prep_total_dilution": 19.5})
    assert r.status_code == 400 and "prep_total_dilution" in r.json()["detail"]
    assert client.patch(url, json={"prep_total_dilution": 20}).status_code == 200
    # The row's own step 1 ratio moves the floor, sent with the total ...
    assert client.patch(url, json={"prep_total_dilution": 8,
                                   "prep_steps": [[20, 4], None, None]}).status_code == 200
    # ... or already stored: a new ratio of 5 cannot make the stored total of 8.
    assert client.patch(url, json={"prep_steps": [[20, 5], None, None]}).status_code == 400
    # A step 1 with only its sample uL keeps the standard 1:10, so 20 again.
    assert client.patch(url, json={"prep_total_dilution": 12,
                                   "prep_steps": [[30], None, None]}).status_code == 400
    db.refresh(item)
    assert (item.prep_total_dilution, item.prep_steps) == (8, [[20, 4], None, None])


def test_a_stored_huge_step1_ratio_refuses_a_later_total_with_400(client, db):
    # A huge ratio stored before the standard-total floor (final review D1)
    # refused it. A total sent later must then be a 400 with the reason,
    # never a 500.
    ws, item, _, _ = _row_world(db)
    url = f"/worksheets/{ws.id}/items/{item.id}"
    item.prep_steps = [[20, 10**308], None, None]
    db.commit()
    r = client.patch(url, json={"prep_total_dilution": 20})
    assert r.status_code == 400 and "prep_total_dilution" in r.json()["detail"]
    db.refresh(item)
    assert item.prep_total_dilution is None


def test_patch_refuses_a_cartridge_the_method_does_not_allow(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    off_method = _cartridge(db, "Endosafe 0.005", 0.005)
    _method(client, db, "Endotoxin", svc, [(c05, True)])
    ws = _ws(db)
    item, _ = _vial_item(db, ws, 1, svc)
    db.commit()
    url = f"/worksheets/{ws.id}/items/{item.id}"
    r = client.patch(url, json={"cartridge_type_id": off_method.id})
    assert r.status_code == 400 and r.json()["detail"] == worksheets_endo.CARTRIDGE_REFUSED
    assert client.patch(url, json={"cartridge_type_id": c05.id}).status_code == 200


def test_a_completed_worksheet_refuses_only_the_new_row_fields(client, db):
    ws, item, c05, _ = _row_world(db)
    ws.status = "completed"
    db.commit()
    url = f"/worksheets/{ws.id}/items/{item.id}"
    for payload in ({"prep_form": "powder"}, {"prep_steps": None},
                    {"result_reading": "0.8", "cartridge_type_id": c05.id}):
        assert client.patch(url, json=payload).status_code == 409, payload
    # Existing fields keep today's behaviour (no guard).
    assert client.patch(url, json={"made": True}).status_code == 200
    db.refresh(item)
    assert item.made_at is not None
    assert _row(item) == dict.fromkeys(_ROW_FIELDS)


@pytest.mark.parametrize("typed, stored", [
    ("< 0.05", "< 0.05"), (" 0.8 ", "0.8"), ("<0.05", "<0.05"), ("0", "0"),
])
def test_a_reading_is_stored_as_typed_after_trimming(client, db, typed, stored):
    ws, item, c05, _ = _row_world(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}",
                     json={"result_reading": typed, "cartridge_type_id": c05.id})
    assert r.status_code == 200, r.text
    db.refresh(item)
    assert item.result_reading == stored
    assert item.result_entered_by_user_id == 1 and item.result_entered_at is not None
    it = client.get(f"/worksheets/{ws.id}").json()["items"][0]
    assert it["result_reading"] == stored and it["result_entered_at"].endswith("Z")


@pytest.mark.parametrize("typed", ["0,8", "-1", "<0", "abc", ""])
def test_a_reading_that_does_not_parse_is_refused_with_a_reason(client, db, typed):
    ws, item, c05, _ = _row_world(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}",
                     json={"result_reading": typed, "cartridge_type_id": c05.id})
    assert r.status_code == 400
    assert "reading" in r.json()["detail"]
    db.refresh(item)
    assert _row(item) == dict.fromkeys(_ROW_FIELDS)


def test_a_reading_needs_the_rows_cartridge(client, db):
    ws, item, c05, _ = _row_world(db)
    url = f"/worksheets/{ws.id}/items/{item.id}"
    r = client.patch(url, json={"result_reading": "0.8"})
    assert r.status_code == 400 and "cartridge" in r.json()["detail"]
    assert client.patch(url, json={"result_reading": "0.8",
                                   "cartridge_type_id": None}).status_code == 400
    assert client.patch(url, json={"result_reading": "0.8",
                                   "cartridge_type_id": c05.id}).status_code == 200
    # The row now has its cartridge, so a later reading may come alone. The
    # cartridge cannot be dropped from under a stored reading (spec 3.1).
    assert client.patch(url, json={"result_reading": "<0.05"}).status_code == 200
    assert client.patch(url, json={"cartridge_type_id": None}).status_code == 400
    db.refresh(item)
    assert (item.result_reading, item.cartridge_type_id) == ("<0.05", c05.id)


def test_reading_set_and_clear_are_audited_and_the_first_one_pins_the_method(client, db):
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    mid = _method(client, db, "Endotoxin", svc, [(c05, True)])
    ws = _ws(db)
    item, _ = _vial_item(db, ws, 1, svc)
    db.commit()
    url = f"/worksheets/{ws.id}/items/{item.id}"

    r = client.patch(url, json={"result_reading": "0.8", "cartridge_type_id": c05.id})
    assert r.status_code == 200, r.text
    assert r.json()["endo_method"]["id"] == mid
    db.refresh(ws)
    assert ws.endo_method_id == mid
    assert client.patch(url, json={"result_reading": None}).status_code == 200
    db.refresh(item)
    assert (item.result_reading, item.result_entered_at,
            item.result_entered_by_user_id) == (None, None, None)
    assert item.cartridge_type_id == c05.id
    assert [(a.operation, a.details["old"], a.details["new"]) for a in db.query(AuditLog).filter(
        AuditLog.operation.in_(("endo_reading_set", "endo_reading_cleared"))
    ).order_by(AuditLog.id)] == [
        ("endo_reading_set", None, "0.8"), ("endo_reading_cleared", "0.8", None)]
    assert db.query(AuditLog).filter(AuditLog.operation == "endo_method_pinned").count() == 1


_IMPORTED = {"test_id": "T-1", "reader": "NX-1001", "slot": 1, "recovery": 98.0,
             "sample_cv": 3.1, "spike_cv": 4.0, "valid": True, "why": []}


def _imported_row(db):
    """A row as the reader import leaves it (Task 7 writes these columns)."""
    ws, item, c05, _ = _row_world(db)
    item.cartridge_type_id = c05.id
    item.result_reading = "<0.05"
    item.result_reader = dict(_IMPORTED)
    db.commit()
    return ws, item


def test_a_typed_reading_over_an_imported_one_keeps_the_reader_record(client, db):
    # The page flags the mismatch; validity still comes from the reader's numbers.
    ws, item = _imported_row(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"result_reading": "0.8"})
    assert r.status_code == 200, r.text
    db.refresh(item)
    assert (item.result_reading, item.result_reader) == ("0.8", _IMPORTED)


def test_clearing_the_reading_clears_the_reader_record_and_audits_it(client, db):
    ws, item = _imported_row(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"result_reading": None})
    assert r.status_code == 200, r.text
    db.refresh(item)
    assert (item.result_reading, item.result_reader) == (None, None)
    cleared = db.query(AuditLog).filter(AuditLog.operation == "endo_reading_cleared").one()
    assert (cleared.details["old"], cleared.details["old_reader"]) == ("<0.05", _IMPORTED)


# --- Task 7: POST /worksheets/{id}/reader-import ----------------------------


def _record(test_id="T-0001", reader="NX-1001", slot=1):
    """A reader record shaped like src/lib/endo-reader.ts toReaderRecord
    (spec 8.4). Made-up values, never a real export."""
    return {"test_id": test_id, "reader": reader, "slot": slot, "operator": "DL",
            "tested_at": "2026-10-09T14:02:00", "temp_start": 37.0, "temp_end": 37.1,
            "software": "EndoScan-V 6.2", "cartridge_lot": "L1234",
            "cartridge_expiry": "2027-03", "cartridge_range": "0.05-5", "spike_level": 0.5,
            "recovery": 98.0, "rec_min": 50, "rec_max": 200, "sample_cv": 3.1,
            "spike_cv": 4.0, "cv_limit": 25, "reader_pass": True, "valid": True, "why": [],
            "file_name": "EndoScanV-Export-2026-10-09.csv"}


def _line(item, reading, cartridge, *, replace=False, **record):
    # The browser sends the reader's own result as the reading, so the record's
    # `result` is the same text (EndoReaderImportDialog.tsx apply()).
    return {"item_id": item.id, "reading": reading,
            "record": {**_record(**record), "result": reading},
            "cartridge_type_id": cartridge.id, "replace": replace}


def _import(client, ws, *lines):
    return client.post(f"/worksheets/{ws.id}/reader-import",
                       json={"file_name": "EndoScanV-Export-2026-10-09.csv", "tests": list(lines)})


def _reader_world(client, db, *, serials=(None,), run_parameters=None):
    """Two endo vials (P-3001-S01 and -S02) on an open worksheet. An active
    method allows the 0.05 (default) and 0.01 cartridges. One instrument is
    linked to it per entry in `serials`."""
    svc = _service(db)
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    mid = _method(client, db, "Endotoxin", svc, [(c05, True), (c01, False)],
                  run_parameters=run_parameters)
    ws = _ws(db)
    a, row_a = _vial_item(db, ws, 1, svc)
    b, row_b = _vial_item(db, ws, 2, svc)
    instruments = []
    for n, serial in enumerate(serials, start=1):
        inst = Instrument(name=f"Nexgen-MCS {n}", origin="mk1", active=True, serial_number=serial)
        db.add(inst)
        db.flush()
        db.execute(instrument_methods.insert().values(instrument_id=inst.id, method_id=mid))
        instruments.append(inst.id)
    db.commit()
    return SimpleNamespace(svc=svc, c05=c05, c01=c01, mid=mid, ws=ws, a=a, b=b,
                           row_a=row_a, row_b=row_b, instruments=instruments)


_IMPORT_OPS = ("endo_reader_imported", "endo_method_pinned", "bench_ran_set")


def test_import_stores_each_reading_ticks_ran_pins_and_audits(client, db):
    w = _reader_world(client, db)
    r = _import(client, w.ws, _line(w.a, "<0.05", w.c05, test_id="T-1", slot=1),
                _line(w.b, " 0.8 ", w.c01, test_id="T-2", slot=2))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["applied"] == 2 and body["endo_method"]["id"] == w.mid
    items = {it["id"]: it for it in body["items"]}
    a, b = items[w.a.id], items[w.b.id]
    assert (a["result_reading"], b["result_reading"]) == ("<0.05", "0.8")
    assert (a["cartridge_type_id"], b["cartridge_type_id"]) == (w.c05.id, w.c01.id)
    assert b["cartridge_sensitivity_eu_ml"] == 0.01
    assert a["result_reader"]["test_id"] == "T-1" and a["result_reader"]["recovery"] == 98.0
    assert a["result_reader"]["imported_by_user_id"] == 1
    assert a["result_reader"]["imported_at"].endswith("Z")
    assert a["ran_at"] is not None and a["result_entered_by_user_id"] == 1
    db.refresh(w.ws)
    assert w.ws.endo_method_id == w.mid
    assert [(x.entity_id, x.details["test_id"], x.details["reader"], x.details["slot"],
             x.details["file_name"]) for x in db.query(AuditLog)
            .filter(AuditLog.operation == "endo_reader_imported").order_by(AuditLog.id)] == [
        (str(w.a.id), "T-1", "NX-1001", 1, "EndoScanV-Export-2026-10-09.csv"),
        (str(w.b.id), "T-2", "NX-1001", 2, "EndoScanV-Export-2026-10-09.csv")]


def test_import_on_a_missing_or_completed_worksheet_changes_nothing(client, db):
    w = _reader_world(client, db)
    assert client.post("/worksheets/99999/reader-import",
                       json={"file_name": "x.csv", "tests": []}).status_code == 404
    # Another analyst completes the worksheet while the import dialog is open.
    w.ws.status = "completed"
    db.commit()
    assert _import(client, w.ws, _line(w.a, "0.8", w.c05)).status_code == 409
    db.refresh(w.a)
    db.refresh(w.ws)
    assert (w.a.result_reading, w.a.result_reader, w.a.cartridge_type_id,
            w.a.ran_at) == (None, None, None, None)
    assert w.ws.endo_method_id is None
    assert db.query(AuditLog).filter(AuditLog.operation.in_(_IMPORT_OPS)).count() == 0


def test_import_is_all_or_nothing_and_names_each_failing_row(client, db):
    w = _reader_world(client, db)
    elsewhere = _ws(db, "Another run")
    stray, _ = _vial_item(db, elsewhere, 3, w.svc)
    retired = _cartridge(db, "Endosafe old", 0.05, active=False)
    off_method = _cartridge(db, "Endosafe 0.005", 0.005)
    # A mixed worksheet: an HPLC vial sits beside the endo rows.
    hplc_row, _ = _vial_item(db, w.ws, 4, _service(db, "BPC157-PURITY"), role="hplc")
    db.commit()
    bad_rows = [
        (_line(stray, "0.8", w.c05), f"item {stray.id}: not on this worksheet"),
        (_line(hplc_row, "0.8", w.c05), "P-3001-S04: not an endotoxin row"),
        (_line(w.b, "0,8", w.c05), "P-3001-S02: '0,8' is not a reading"),
        (_line(w.b, "0.8", retired), f"P-3001-S02: {worksheets_endo.CARTRIDGE_REFUSED}"),
        (_line(w.b, "0.8", off_method), f"P-3001-S02: {worksheets_endo.CARTRIDGE_REFUSED}"),
        (_line(w.b, "0.8", w.c05, test_id=""), "P-3001-S02: the reader record has no test_id"),
        (_line(w.a, "0.9", w.c05, test_id="T-2"), "P-3001-S01: listed twice"),
    ]
    for bad, reason in bad_rows:
        r = _import(client, w.ws, _line(w.a, "0.8", w.c05), bad)
        assert r.status_code == 400, bad
        assert r.json()["detail"].startswith("Nothing was imported.")
        assert reason in r.json()["detail"], r.json()["detail"]
        db.refresh(w.a)
        assert w.a.result_reading is None and w.a.ran_at is None  # the good row was not written either
    assert db.query(AuditLog).filter(AuditLog.operation.in_(_IMPORT_OPS)).count() == 0


def test_import_repeats_are_no_ops_and_a_different_reading_needs_replace(client, db):
    w = _reader_world(client, db)
    assert _import(client, w.ws, _line(w.a, "<0.05", w.c05, test_id="T-1")).json()["applied"] == 1
    # The same file again, spacing aside: same reading, same test, nothing to do.
    r = _import(client, w.ws, _line(w.a, "< 0.05", w.c05, test_id="T-1"))
    assert r.status_code == 200 and r.json()["applied"] == 0
    assert db.query(AuditLog).filter(AuditLog.operation == "endo_reader_imported").count() == 1
    # A different reading is refused without replace, naming the row ...
    r = _import(client, w.ws, _line(w.a, "1.2", w.c05, test_id="T-9"))
    assert r.status_code == 400
    assert "P-3001-S01" in r.json()["detail"] and "replace" in r.json()["detail"]
    db.refresh(w.a)
    assert w.a.result_reading == "<0.05"
    # ... and applied with it.
    r = _import(client, w.ws, _line(w.a, "1.2", w.c05, test_id="T-9", replace=True))
    assert r.status_code == 200 and r.json()["applied"] == 1
    db.refresh(w.a)
    assert (w.a.result_reading, w.a.result_reader["test_id"]) == ("1.2", "T-9")
    # The overwritten record lives on in the audit trail (the file is not stored).
    first, replaced = db.query(AuditLog).filter(
        AuditLog.operation == "endo_reader_imported").order_by(AuditLog.id).all()
    assert first.details["old_reader"] is None
    assert (replaced.details["old"], replaced.details["new"]) == ("<0.05", "1.2")
    assert replaced.details["old_reader"]["test_id"] == "T-1"
    assert replaced.details["old_reader"]["imported_by_user_id"] == 1


def test_import_stamps_the_instrument_named_by_the_reader_serial(client, db):
    # Two analyzers: the catalog alone will not choose between them; the serial does.
    w = _reader_world(client, db, serials=("NX-1001", "NX-2002"))
    r = _import(client, w.ws, _line(w.a, "0.8", w.c05, reader="NX-2002"))
    assert r.status_code == 200, r.text
    db.refresh(w.a)
    db.refresh(w.row_a)
    assert w.a.instrument_id == w.instruments[1]
    assert w.row_a.instrument_id == w.instruments[1]
    assert w.row_a.method_id is None  # a method is never written


def test_import_without_a_serial_match_falls_back_to_the_sole_instrument(client, db):
    w = _reader_world(client, db, serials=("NX-1001",))
    r = _import(client, w.ws, _line(w.a, "0.8", w.c05, reader="NX-UNKNOWN"),
                _line(w.b, "0.5", w.c05, reader=None, test_id="T-2"))
    assert r.status_code == 200, r.text
    db.refresh(w.a)
    db.refresh(w.b)
    assert w.a.instrument_id == w.instruments[0] and w.b.instrument_id == w.instruments[0]


@pytest.mark.parametrize("field, raw, refusal", [
    ("reading", '"' + "1" * 41 + '"', "Row P-3001-S02: A reading is at most 40 characters"),
    # A lone surrogate cannot be written as UTF-8: echoed in the reason, it would 500.
    ("reading", r'"\ud800"', "Row P-3001-S02: the reading holds"),
    ("recovery", "1e400", "Row P-3001-S02: the reader record holds"),  # arrives as inf
    ("recovery", "NaN", "Row P-3001-S02: the reader record holds"),
    # Stored, it would break every later GET of the worksheet.
    ("operator", r'"\ud800"', "Row P-3001-S02: the reader record holds"),
    # Postgres refuses a NUL in the serial lookup's query parameter.
    ("reader", r'"NX\u00001001"', "Row P-3001-S02: the reader record holds"),
    ("file_name", r'"Export\ud800.csv"', "The file name holds"),
    # Spec 8.4's keys with plain values only. Stored, a deep value commits and
    # then fails every later serialization of the worksheet.
    ("operator", '{"a":' * 300 + "1" + "}" * 300, "Row P-3001-S02: the reader record's operator"),
    ("colour", '"red"', "Row P-3001-S02: the reader record has an unknown key 'colour'"),
    ("software", '"' + "x" * 201 + '"', "Row P-3001-S02: the reader record's software"),
    ("why", json.dumps(["x"] * 21), "Row P-3001-S02: the reader record's why"),
])
def test_import_refuses_pathological_values_with_400_and_writes_nothing(client, db, field, raw,
                                                                        refusal):
    """Spec 10: a 400 with the reason, never a 500. The value goes on the wire
    as raw JSON (httpx's json= refuses NaN and lone surrogates); FastAPI's
    json.loads accepts all of them."""
    w = _reader_world(client, db)
    bad = _line(w.b, "0.8", w.c05, test_id="T-2")
    body = {"file_name": "EndoScanV-Export-2026-10-09.csv",
            "tests": [_line(w.a, "0.8", w.c05), bad]}
    target = body if field == "file_name" else bad if field == "reading" else bad["record"]
    target[field] = "@raw@"
    r = client.post(f"/worksheets/{w.ws.id}/reader-import",
                    content=json.dumps(body).replace('"@raw@"', raw),
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 400, r.text
    assert r.json()["detail"].startswith("Nothing was imported. " + refusal), r.json()["detail"]
    db.refresh(w.a)
    db.refresh(w.ws)
    assert (w.a.result_reading, w.a.result_reader, w.a.ran_at) == (None, None, None)
    assert w.ws.endo_method_id is None
    assert db.query(AuditLog).filter(AuditLog.operation.in_(_IMPORT_OPS)).count() == 0


def test_import_keeps_the_record_as_the_reader_exported_it(client, db):
    # Appendix A.0 item 5: `result` is the reading exactly as the reader showed
    # it, so the page can flag a typed reading that differs. The row's reading
    # is trimmed; the record is stored as sent.
    w = _reader_world(client, db)
    line = _line(w.a, " 0.8 ", w.c05)
    line["record"]["result"] = " 0.8 "
    assert _import(client, w.ws, line).status_code == 200
    db.refresh(w.a)
    assert (w.a.result_reading, w.a.result_reader["result"]) == ("0.8", " 0.8 ")


# --- Task 7 fix round 1 ------------------------------------------------------

_DROP = object()  # a _record key the reader left out


@pytest.mark.parametrize("patch, run_parameters, why", [
    ({}, None, []),  # 98 %, CVs 3.1 and 4.0: inside Dennis's 50-200 % and 25 %
    ({"valid": False, "why": ["typed by hand"]}, None, []),
    ({"recovery": 44}, None, ["spike recovery 44 % outside 50-200 %"]),
    ({"recovery": _DROP}, None, ["no spike recovery"]),
    ({"recovery": None, "sample_cv": _DROP, "spike_cv": "4.0"}, None,
     ["no spike recovery", "no sample CV", "no spike CV"]),
    ({"spike_cv": True}, None, ["no spike CV"]),  # a bool is not a number
    ({"sample_cv": 26, "cv_limit": 30}, None, ["sample CV 26 % over 25 %"]),
    ({"recovery": 85, "rec_min": 50}, {"endotoxin": {"spike_recovery_min_pct": 90}},
     ["spike recovery 85 % outside 90-200 %"]),
])
def test_import_recomputes_validity_against_the_method_limits(client, db, patch,
                                                              run_parameters, why):
    """Spec 4.5: the server never trusts the browser's verdict (every record
    here claims valid) nor the file's own limits (rec_min, cv_limit). The
    worksheet's pinned method sets them, else Dennis's 50-200 % and 25 %;
    a missing or non-numeric number fails closed."""
    w = _reader_world(client, db, run_parameters=run_parameters)
    assert client.post(f"/worksheets/{w.ws.id}/printed").status_code == 200  # pins the method
    line = _line(w.a, "0.8", w.c05)
    for key, value in patch.items():
        if value is _DROP:
            del line["record"][key]
        else:
            line["record"][key] = value
    r = _import(client, w.ws, line)
    assert r.status_code == 200, r.text
    db.refresh(w.a)
    assert (w.a.result_reader["valid"], w.a.result_reader["why"]) == (not why, why)


def test_import_ignores_a_serial_whose_instrument_the_method_does_not_link(client, db):
    # Spec 4.5: the serial chooses only among the catalog's candidates. An
    # active analyzer outside them is not stamped; the catalog fallback is.
    w = _reader_world(client, db, serials=("NX-1001",))
    db.add(Instrument(name="Nexgen-MCS loaner", origin="mk1", active=True,
                      serial_number="NX-3003"))
    db.commit()
    r = _import(client, w.ws, _line(w.a, "0.8", w.c05, reader="NX-3003"))
    assert r.status_code == 200, r.text
    db.refresh(w.a)
    db.refresh(w.row_a)
    assert (w.a.instrument_id, w.row_a.instrument_id) == (w.instruments[0], w.instruments[0])


def test_a_serial_instrument_is_stamped_only_onto_the_rows_it_covers(client, db):
    w = _reader_world(client, db, serials=("NX-1001", "NX-2002"))
    other = _service(db, "BPC157-PURITY")  # no method links it to the analyzer
    extra = LimsAnalysis(lims_sub_sample_pk=w.row_a.lims_sub_sample_pk,
                         analysis_service_id=other.id, keyword=other.keyword,
                         title=other.title, review_state="assigned", provenance="canonical")
    db.add(extra)
    db.commit()
    r = _import(client, w.ws, _line(w.a, "0.8", w.c05, reader="NX-2002"))
    assert r.status_code == 200, r.text
    for x in (w.a, w.row_a, extra):
        db.refresh(x)
    assert (w.a.instrument_id, w.row_a.instrument_id, extra.instrument_id) == (
        w.instruments[1], w.instruments[1], None)


def test_patch_refuses_a_reading_with_a_lone_surrogate_with_400(client, db):
    # parse_reading shows the refused text through ascii(). Echoed raw, a lone
    # surrogate could not be encoded and the 400 became a 500.
    ws, item, c05, _ = _row_world(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}",
                     content=json.dumps({"result_reading": "\ud800", "cartridge_type_id": c05.id}),
                     headers={"Content-Type": "application/json"})
    assert r.status_code == 400
    assert r.json()["detail"].startswith(r"'\ud800' is not a reading")
    db.refresh(item)
    assert _row(item) == dict.fromkeys(_ROW_FIELDS)


def test_import_judges_against_the_pinned_revision_not_a_newer_one(client, db):
    w = _reader_world(client, db, run_parameters={"endotoxin": {"spike_recovery_min_pct": 90}})
    assert client.post(f"/worksheets/{w.ws.id}/printed").status_code == 200  # pins revision 1
    rev2 = client.post(f"/hplc/methods/{w.mid}/new-revision").json()["id"]
    db.get(HplcMethod, rev2).run_parameters = None  # back to Dennis's 50-200 %
    db.commit()
    assert client.post(f"/hplc/methods/{rev2}/activate").status_code == 200
    line = _line(w.a, "0.8", w.c05)
    line["record"]["recovery"] = 85
    assert _import(client, w.ws, line).status_code == 200
    db.refresh(w.a)
    assert w.a.result_reader["why"] == ["spike recovery 85 % outside 90-200 %"]


# --- Final review fix wave ---------------------------------------------------


def test_a_vial_resolves_through_its_endotoxin_analyses_only(client, db):
    # The UAT stack's BW-0015-S04: an endo vial that also carries a live
    # STER-PCR analysis. Only the vial's endotoxin analyses speak for its
    # method (main.py's keyword rule), so the PCR one is not counted.
    svc = _service(db)
    pcr = _service(db, "STER-PCR")
    mid = _method(client, db, "Endotoxin", svc)
    _method(client, db, "Sterility PCR", pcr)
    ws = _ws(db)
    _item, row = _vial_item(db, ws, 1, svc, role="endo")
    db.add(LimsAnalysis(lims_sub_sample_pk=row.lims_sub_sample_pk, analysis_service_id=pcr.id,
                        keyword=pcr.keyword, title=pcr.title, review_state="assigned",
                        provenance="canonical"))
    pcr_only = _ws(db, "An endo vial with only a PCR analysis")
    _vial_item(db, pcr_only, 2, pcr, role="endo")
    db.commit()
    assert client.get(f"/worksheets/{ws.id}").json()["endo_method"]["id"] == mid
    # No endotoxin analysis on the vial: still nothing (the strict rule).
    assert client.get(f"/worksheets/{pcr_only.id}").json()["endo_method"] is None


def test_a_completed_worksheet_never_pinned_resolves_no_method(client, db):
    # Every reading and print pins, so a completed sheet without a pin was
    # worked on Dennis's values; a method resolved today never speaks for it.
    svc = _service(db)
    mid = _method(client, db, "Endotoxin", svc)
    unpinned = _ws(db, "Completed, never pinned", status="completed")
    _vial_item(db, unpinned, 1, svc)
    pinned = _ws(db, "Completed, pinned", status="completed")
    _vial_item(db, pinned, 2, svc)
    pinned.endo_method_id = mid
    db.commit()
    assert client.get(f"/worksheets/{unpinned.id}").json()["endo_method"] is None
    assert worksheets_endo.resolve_endo_method(db, unpinned) is None
    assert client.get(f"/worksheets/{pinned.id}").json()["endo_method"]["id"] == mid


def test_a_worksheet_unresolved_at_its_first_print_pins_at_a_later_one(client, db):
    svc = _service(db)
    ws = _ws(db)
    _vial_item(db, ws, 1, svc)
    db.commit()
    assert client.post(f"/worksheets/{ws.id}/printed").status_code == 200
    db.refresh(ws)
    assert ws.endo_method_id is None
    mid = _method(client, db, "Endotoxin", svc)  # the method appears after print 1
    assert client.post(f"/worksheets/{ws.id}/printed").status_code == 200
    db.refresh(ws)
    assert ws.endo_method_id == mid
    assert client.get(f"/worksheets/{ws.id}").json()["endo_method"]["id"] == mid


def test_patch_audits_the_prep_inputs_it_changes_in_one_row(client, db):
    # Spec 9: the row's prep inputs are audited like its cartridge and reading.
    ws, item, _, _ = _row_world(db)
    url = f"/worksheets/{ws.id}/items/{item.id}"
    assert client.patch(url, json={"prep_form": "liquid", "prep_water_ml": 1.5,
                                   "prep_total_dilution": 500,
                                   "prep_steps": [[20, 5], None, [100]]}).status_code == 200
    # Only what changes is logged: the form is sent again unchanged.
    assert client.patch(url, json={"prep_form": "liquid", "prep_water_ml": 2}).status_code == 200
    # Nothing changes: no row at all.
    assert client.patch(url, json={"prep_form": "liquid", "prep_steps": [[20, 5], None, [100]]}
                        ).status_code == 200
    base = {"user_id": 1, "worksheet_id": ws.id, "sample_id": item.sample_id}
    assert [(a.entity_type, a.entity_id, a.details) for a in db.query(AuditLog).filter(
        AuditLog.operation == "endo_prep_inputs_set").order_by(AuditLog.id)] == [
        ("worksheet_item", str(item.id), {
            **base,
            "old": {"prep_form": None, "prep_water_ml": None, "prep_total_dilution": None,
                    "prep_steps": None},
            "new": {"prep_form": "liquid", "prep_water_ml": 1.5, "prep_total_dilution": 500,
                    "prep_steps": [[20, 5], None, [100]]}}),
        ("worksheet_item", str(item.id), {
            **base, "old": {"prep_water_ml": 1.5}, "new": {"prep_water_ml": 2}}),
    ]


_FLOOR_400 = ("prep_total_dilution must be at least 400 (the step 1 ratio x the fixed 1:2 step) "
              "or step 2 cannot be made")


def test_a_row_on_the_standard_total_refuses_a_step1_ratio_it_cannot_make(client, db):
    # No total of its own: the row runs on the method's standard total (250
    # here: no method resolves, so Dennis's value), which must stay makeable.
    ws, item, _, _ = _row_world(db)
    url = f"/worksheets/{ws.id}/items/{item.id}"
    r = client.patch(url, json={"prep_steps": [[20, 200], None, None]})
    assert (r.status_code, r.json()["detail"]) == (400, _FLOOR_400)
    assert client.patch(url, json={"prep_steps": [[20, 100], None, None]}).status_code == 200
    # Clearing an own total back to the standard is checked the same way.
    assert client.patch(url, json={"prep_total_dilution": 1000,
                                   "prep_steps": [[20, 200], None, None]}).status_code == 200
    r = client.patch(url, json={"prep_total_dilution": None})
    assert (r.status_code, r.json()["detail"]) == (400, _FLOOR_400)
    db.refresh(item)
    assert (item.prep_total_dilution, item.prep_steps) == (1000, [[20, 200], None, None])


def test_the_standard_total_comes_from_the_worksheets_method(client, db):
    svc = _service(db)
    _method(client, db, "Endotoxin", svc, run_parameters={"endotoxin": {"std_total_dilution": 500}})
    ws = _ws(db)
    item, _ = _vial_item(db, ws, 1, svc)
    db.commit()
    url = f"/worksheets/{ws.id}/items/{item.id}"
    assert client.patch(url, json={"prep_steps": [[20, 200], None, None]}).status_code == 200
    r = client.patch(url, json={"prep_steps": [[20, 300], None, None]})
    assert r.status_code == 400 and "at least 600" in r.json()["detail"]


def test_a_patch_without_endo_fields_never_resolves_the_method(client, db, monkeypatch):
    ws, item, _, _ = _row_world(db)
    url = f"/worksheets/{ws.id}/items/{item.id}"
    calls = []
    real = worksheets_endo.resolve_endo_method
    monkeypatch.setattr(worksheets_endo, "resolve_endo_method",
                        lambda *a: calls.append(a) or real(*a))
    r = client.patch(url, json={"made": True})
    assert r.status_code == 200, r.text
    assert "endo_method" not in r.json() and calls == []
    r = client.patch(url, json={"prep_form": "powder"})
    assert r.status_code == 200 and "endo_method" in r.json()
    assert len(calls) == 1


def test_a_failing_method_resolution_after_the_commit_is_not_a_500(client, db, monkeypatch):
    # The row is already saved when the response resolves the method: a
    # failure there is logged and the key left out, never a 500.
    ws, item, _, _ = _row_world(db)

    def boom(*_args):
        raise RuntimeError("resolution failed")

    monkeypatch.setattr(worksheets_endo, "resolve_endo_method", boom)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", json={"prep_form": "powder"})
    assert r.status_code == 200, r.text
    assert "endo_method" not in r.json()
    db.refresh(item)
    assert item.prep_form == "powder"


def test_import_bounds_the_test_count_and_the_file_name(client, db):
    w = _reader_world(client, db)
    url = f"/worksheets/{w.ws.id}/reader-import"
    line = _line(w.a, "0.8", w.c05)
    # 500 entries pass the bound (and are refused as repeats); 501 do not.
    assert client.post(url, json={"file_name": "x.csv", "tests": [line] * 500}).status_code == 400
    assert client.post(url, json={"file_name": "x.csv", "tests": [line] * 501}).status_code == 422
    assert client.post(url, json={"file_name": "x" * 201, "tests": [line]}).status_code == 422
    # A long name that is not clean text still gets the 400 that never echoes
    # it: a 422 would echo the lone surrogate, which cannot be encoded (a 500).
    raw = json.dumps({"file_name": "x" * 201 + "@s@", "tests": [line]}).replace("@s@", r"\ud800")
    r = client.post(url, content=raw, headers={"Content-Type": "application/json"})
    assert r.status_code == 400 and r.json()["detail"].startswith(
        "Nothing was imported. The file name holds"), r.text
    db.refresh(w.a)
    assert (w.a.result_reading, w.a.result_reader) == (None, None)
    r = client.post(url, json={"file_name": "x" * 196 + ".csv", "tests": [line]})
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("result", ["0.9", "<0.8", "", None, 0.8, "abc", _DROP])
def test_import_refuses_a_reading_the_reader_record_does_not_show(client, db, result):
    w = _reader_world(client, db)
    line = _line(w.a, "0.8", w.c05)
    if result is _DROP:
        del line["record"]["result"]
    else:
        line["record"]["result"] = result
    r = _import(client, w.ws, line)
    assert r.status_code == 400
    assert r.json()["detail"] == (
        "Nothing was imported. Row P-3001-S01: the reading does not match the reader record")
    db.refresh(w.a)
    assert (w.a.result_reading, w.a.result_reader, w.a.ran_at) == (None, None, None)
    assert db.query(AuditLog).filter(AuditLog.operation.in_(_IMPORT_OPS)).count() == 0


def test_import_compares_the_reading_and_the_record_as_parsed_values(client, db):
    w = _reader_world(client, db)
    line = _line(w.a, "<0.05", w.c05)
    line["record"]["result"] = " < 0.05 "
    assert _import(client, w.ws, line).status_code == 200
