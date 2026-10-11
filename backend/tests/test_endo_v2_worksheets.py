"""Endo worksheet v2 on the server (spec
docs/superpowers/specs/2026-10-10-endo-worksheet-v2-design.md, sections 3.6,
3.7, 4 and 8 to 10): the run and row fields, the worksheet's endo method
(resolved in a fixed number of queries, pinned at first print or first
reading) and the reader import. In-memory SQLite + dependency overrides, no
live stack; the test_worksheet_endo_prep.py pattern."""
import json
from contextlib import contextmanager
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
    LimsSample, LimsSubSample, Worksheet, WorksheetItem, method_consumables,
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
