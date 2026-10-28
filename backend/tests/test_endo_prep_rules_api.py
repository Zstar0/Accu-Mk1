"""Endo slice 5, Task 2: the prep rules API (spec
docs/superpowers/specs/2026-10-14-endo-slice5-method-rules-design.md section 3;
plan Review Focus 4 and 5): list, create, edit, reorder, every save check
with its 400 text, the two warnings, the audit rows and the sign-in guard.
In-memory SQLite + dependency overrides with test_endo_v2_worksheets.py's
helpers. Never `with TestClient(app)`: that runs the lifespan, whose init_db
writes to the host Postgres."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db
from main import app
from endo_prep_rules import OVERLAP_RULE
from models import AuditLog, EndoPrepRule
from tests.test_endo_v2_worksheets import _cartridge, _count_sql, _method, _service
from tests.test_spec_rules import _mk_peptide

SNAPSHOT_KEYS = ("id", "peptide_id", "min_mg", "max_mg", "recon_water_ml", "total_dilution",
                 "step1_ratio", "cartridge_type_id", "status", "note", "sort_order", "active")


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
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def reta(db):
    pep = _mk_peptide(db, "RETA", name="Retatrutide")
    db.commit()
    return pep


def _post(client, **body):
    return client.post("/endo-prep-rules", json=body)


def _refused(res, detail):
    assert (res.status_code, res.json()["detail"]) == (400, detail)


def _audits(db, operation):
    return db.execute(select(AuditLog).where(AuditLog.operation == operation)
                      .order_by(AuditLog.id)).scalars().all()


# --- list and create ----------------------------------------------------------


def test_create_appends_a_line_and_the_list_serves_it(client, db, reta):
    assert client.get("/endo-prep-rules").json() == []
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    db.commit()

    res = _post(client, peptide_id=reta.id, max_mg=30, status="validated",
                note="1:250 fine to 30 mg")
    assert res.status_code == 201
    assert res.json()["warnings"] == []
    first = res.json()["rule"]
    assert first["updated_at"]
    assert {k: v for k, v in first.items() if k != "updated_at"} == {
        "id": first["id"], "peptide_id": reta.id, "min_mg": None, "max_mg": 30.0,
        "recon_water_ml": None, "total_dilution": None, "step1_ratio": None,
        "cartridge_type_id": None,
        "status": "validated", "note": "1:250 fine to 30 mg", "sort_order": 0, "active": True,
        "peptide_name": "Retatrutide", "cartridge_name": None}

    second = _post(client, peptide_id=reta.id, min_mg=30, total_dilution=300,
                   cartridge_type_id=c01.id, note="  ").json()["rule"]
    assert (second["sort_order"], second["status"], second["note"], second["cartridge_name"]) == (
        1, "trial", None, "Endosafe 0.01")
    assert client.get("/endo-prep-rules").json() == [first, second]

    # Inactive lines stay on the list (there is no delete).
    client.patch(f"/endo-prep-rules/{first['id']}", json={"active": False})
    assert [r["active"] for r in client.get("/endo-prep-rules").json()] == [False, True]


def test_the_list_is_one_query(client, db, reta):
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    db.commit()
    for lo in (0, 10, 20):
        _post(client, peptide_id=reta.id, min_mg=lo, max_mg=lo + 10, cartridge_type_id=c01.id)
    with _count_sql(db) as seen:
        assert len(client.get("/endo-prep-rules").json()) == 3
    assert len(seen) == 1


def test_every_route_needs_a_signed_in_user(client, reta):
    app.dependency_overrides.pop(get_current_user)
    assert client.get("/endo-prep-rules").status_code == 401
    assert _post(client, peptide_id=reta.id).status_code == 401
    assert client.patch("/endo-prep-rules/1", json={"note": "x"}).status_code == 401
    assert client.post("/endo-prep-rules/reorder", json={"ids": []}).status_code == 401


# --- save checks ----------------------------------------------------------------


@pytest.mark.parametrize("body, detail", [
    ({"peptide_id": 987654}, "peptide 987654 not found"),
    ({"total_dilution": 0}, "total_dilution must be greater than zero"),
    ({"total_dilution": -300}, "total_dilution must be greater than zero"),
    ({"step1_ratio": 0.5}, "step1_ratio must be at least 1"),
    ({"min_mg": 30, "max_mg": 30}, "min_mg must be below max_mg"),
    ({"min_mg": 40, "max_mg": 30}, "min_mg must be below max_mg"),
    # Review Focus 5: the step 1 floor (total >= 2 x ratio).
    ({"total_dilution": 15},
     "total_dilution 1:15 is below 2 x the step 1 ratio 1:10, so step 2 cannot be made"),
    ({"total_dilution": 100, "step1_ratio": 60},
     "total_dilution 1:100 is below 2 x the step 1 ratio 1:60, so step 2 cannot be made"),
    ({"step1_ratio": 130},
     "step1_ratio 1:130 needs a total of at least 1:260, above the standard 1:250; "
     "set total_dilution too"),
    ({"cartridge_type_id": 987654}, "cartridge 987654 is not an active endotoxin cartridge"),
])
def test_create_refuses_with_the_reason(client, db, reta, body, detail):
    _refused(_post(client, **{"peptide_id": reta.id, **body}), detail)
    assert db.execute(select(EndoPrepRule)).first() is None


@pytest.mark.parametrize("raw, detail", [
    ('"total_dilution": Infinity', "total_dilution must be a finite number"),
    ('"min_mg": NaN', "min_mg must be a finite number"),
])
def test_create_refuses_a_number_that_is_not_finite(client, reta, raw, detail):
    # Raw JSON: httpx's json= refuses NaN and Infinity, FastAPI's parser accepts them.
    res = client.post("/endo-prep-rules", content=f'{{"peptide_id": {reta.id}, {raw}}}',
                      headers={"Content-Type": "application/json"})
    _refused(res, detail)


def test_create_refuses_a_retired_or_non_endo_cartridge(client, db, reta):
    retired = _cartridge(db, "Endosafe old", 0.05, active=False)
    tip = _cartridge(db, "Pipette tip", None, kind="pipette_tip")
    db.commit()
    for ct in (retired, tip):
        _refused(_post(client, peptide_id=reta.id, cartridge_type_id=ct.id),
                 f"cartridge {ct.id} is not an active endotoxin cartridge")


def test_status_is_trial_or_validated(client, reta):
    assert _post(client, peptide_id=reta.id, status="final").status_code == 422


def test_the_floor_itself_and_an_all_standard_line_save(client, reta):
    # Exactly 2 x 1:10 can be made; a line with no values confirms the standard.
    assert _post(client, peptide_id=reta.id, max_mg=10, total_dilution=20).status_code == 201
    assert _post(client, peptide_id=reta.id, min_mg=10).status_code == 201


def test_a_ratio_without_a_total_meets_the_active_methods_standard(client, db, reta):
    _method(client, db, "Endotoxin", _service(db),
            run_parameters={"endotoxin": {"std_total_dilution": 300}})
    # 1:140 needs 1:280: too much for Dennis's 1:250, fine for this method's 1:300.
    assert _post(client, peptide_id=reta.id, max_mg=10, step1_ratio=140).status_code == 201
    _refused(_post(client, peptide_id=reta.id, min_mg=10, step1_ratio=160),
             "step1_ratio 1:160 needs a total of at least 1:320, above the standard 1:300; "
             "set total_dilution too")


# --- warnings -------------------------------------------------------------------


def test_an_overlapping_band_saves_with_a_warning(client, db, reta):
    assert OVERLAP_RULE == ("for this peptide; where both match, the narrower band wins (an open "
                            "band is the widest) and a tie goes to the line listed first")
    # Review Focus 4 and 5: Dennis's e (up to 10 mg) and f (any weight) overlap.
    e = _post(client, peptide_id=reta.id, max_mg=10, total_dilution=400).json()
    assert e["warnings"] == []
    f = _post(client, peptide_id=reta.id, total_dilution=300)
    assert f.status_code == 201
    assert f.json()["warnings"] == [f"overlaps rule {e['rule']['id']} (up to 10 mg) {OVERLAP_RULE}"]
    # Dennis's a and b meet at 30 mg without overlapping.
    tesa = _mk_peptide(db, "TESA", name="Tesamorelin")
    db.commit()
    assert _post(client, peptide_id=tesa.id, max_mg=30).json()["warnings"] == []
    assert _post(client, peptide_id=tesa.id, min_mg=30, total_dilution=300).json()["warnings"] == []
    # An inactive line overlaps nothing, and an inactive line is not warned about.
    assert client.patch(f"/endo-prep-rules/{e['rule']['id']}",
                        json={"active": False}).json()["warnings"] == []
    assert client.patch(f"/endo-prep-rules/{f.json()['rule']['id']}",
                        json={"note": "any weight"}).json()["warnings"] == []


def test_the_overlap_warning_names_every_overlapping_band(client, db, reta):
    anyw = _post(client, peptide_id=reta.id, total_dilution=300).json()["rule"]["id"]
    mid = _post(client, peptide_id=reta.id, min_mg=10, max_mg=20).json()["rule"]["id"]
    res = _post(client, peptide_id=reta.id, min_mg=15, total_dilution=400)
    # Above 15 mg the any-weight line wins (both open, it is listed first): the
    # warning says how an overlap is settled, not that this line wins.
    assert res.json()["warnings"] == [
        f"overlaps rule {anyw} (any weight) {OVERLAP_RULE}",
        f"overlaps rule {mid} (above 10 up to 20 mg) {OVERLAP_RULE}"]
    above = res.json()["rule"]["id"]
    res = client.patch(f"/endo-prep-rules/{mid}", json={"note": "checked"})
    assert res.json()["warnings"] == [
        f"overlaps rule {anyw} (any weight) {OVERLAP_RULE}",
        f"overlaps rule {above} (above 15 mg) {OVERLAP_RULE}"]


def test_a_cartridge_the_active_method_does_not_allow_saves_with_a_warning(client, db, reta):
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    _method(client, db, "Endotoxin", _service(db), [(c05, True)])
    assert _post(client, peptide_id=reta.id, max_mg=10,
                 cartridge_type_id=c05.id).json()["warnings"] == []
    res = _post(client, peptide_id=reta.id, min_mg=10, cartridge_type_id=c01.id)
    assert res.status_code == 201
    assert res.json()["warnings"] == [
        "cartridge 'Endosafe 0.01' is not allowed by the active method 'Endotoxin' rev 1; "
        "its rows keep their usual cartridge"]


def test_no_cartridge_warning_without_an_endo_method_or_when_it_lists_none(client, db, reta):
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    db.commit()
    assert _post(client, peptide_id=reta.id, max_mg=10,
                 cartridge_type_id=c01.id).json()["warnings"] == []
    # A non-endotoxin method's cartridges say nothing about endotoxin rows.
    _method(client, db, "BPC-157 purity", _service(db, "BPC157-PURITY"), [(c05, True)])
    # An endotoxin method with no cartridge list allows every active one.
    _method(client, db, "Endotoxin", _service(db))
    assert _post(client, peptide_id=reta.id, min_mg=10,
                 cartridge_type_id=c01.id).json()["warnings"] == []


# --- edit -----------------------------------------------------------------------


def test_patch_changes_only_what_it_sends_and_checks_the_stored_line(client, reta):
    rid = _post(client, peptide_id=reta.id, min_mg=30, total_dilution=300,
                note="60 mg PPC low").json()["rule"]["id"]
    res = client.patch(f"/endo-prep-rules/{rid}", json={"total_dilution": 400, "status": "validated"})
    assert res.status_code == 200
    rule = res.json()["rule"]
    assert (rule["min_mg"], rule["total_dilution"], rule["status"], rule["note"]) == (
        30.0, 400.0, "validated", "60 mg PPC low")
    # An explicit null clears a value back to the standard.
    res = client.patch(f"/endo-prep-rules/{rid}", json={"total_dilution": None})
    assert res.json()["rule"]["total_dilution"] is None
    # The band check reads the stored bound beside the sent one.
    _refused(client.patch(f"/endo-prep-rules/{rid}", json={"max_mg": 20}),
             "min_mg must be below max_mg")
    # The floor reads the stored total beside a sent ratio.
    client.patch(f"/endo-prep-rules/{rid}", json={"total_dilution": 300})
    _refused(client.patch(f"/endo-prep-rules/{rid}", json={"step1_ratio": 200}),
             "total_dilution 1:300 is below 2 x the step 1 ratio 1:200, so step 2 cannot be made")
    for field in ("peptide_id", "status", "active"):
        _refused(client.patch(f"/endo-prep-rules/{rid}", json={field: None}),
                 f"{field} cannot be empty")
    res = client.patch("/endo-prep-rules/987654", json={"note": "x"})
    assert (res.status_code, res.json()["detail"]) == (404, "prep rule 987654 not found")


def test_a_line_whose_cartridge_was_retired_can_still_be_deactivated(client, db, reta):
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    db.commit()
    rid = _post(client, peptide_id=reta.id, cartridge_type_id=c01.id).json()["rule"]["id"]
    c01.active = False
    db.commit()
    res = client.patch(f"/endo-prep-rules/{rid}", json={"active": False, "note": "cartridge retired"})
    assert res.status_code == 200 and res.json()["rule"]["active"] is False
    _refused(client.patch(f"/endo-prep-rules/{rid}", json={"cartridge_type_id": c01.id}),
             f"cartridge {c01.id} is not an active endotoxin cartridge")


def test_reactivating_a_line_whose_cartridge_was_retired_is_refused(client, db, reta):
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    db.commit()
    rid = _post(client, peptide_id=reta.id, cartridge_type_id=c01.id).json()["rule"]["id"]
    client.patch(f"/endo-prep-rules/{rid}", json={"active": False})
    c01.active = False
    db.commit()
    _refused(client.patch(f"/endo-prep-rules/{rid}", json={"active": True}),
             f"cartridge {c01.id} is not an active endotoxin cartridge")
    assert db.get(EndoPrepRule, rid).active is False
    # Clearing the cartridge in the same request makes the line valid again.
    res = client.patch(f"/endo-prep-rules/{rid}", json={"active": True, "cartridge_type_id": None})
    assert res.status_code == 200 and res.json()["rule"]["active"] is True


def test_reactivating_a_line_that_no_longer_passes_the_other_checks_is_refused(client, db, reta):
    # Rows a past standard allowed: 1:130 needs 1:260, above today's 1:250.
    for values, detail in [
        ({"step1_ratio": 130},
         "step1_ratio 1:130 needs a total of at least 1:260, above the standard 1:250; "
         "set total_dilution too"),
        ({"total_dilution": 15},
         "total_dilution 1:15 is below 2 x the step 1 ratio 1:10, so step 2 cannot be made"),
        ({"min_mg": 30, "max_mg": 30}, "min_mg must be below max_mg"),
        ({"total_dilution": 0}, "total_dilution must be greater than zero"),
        ({"step1_ratio": 0.5}, "step1_ratio must be at least 1"),
    ]:
        stale = EndoPrepRule(peptide_id=reta.id, active=False, sort_order=0, **values)
        db.add(stale)
        db.commit()
        _refused(client.patch(f"/endo-prep-rules/{stale.id}", json={"active": True}), detail)
        assert db.get(EndoPrepRule, stale.id).active is False
        # Still inactive, such a line can be re-noted.
        assert client.patch(f"/endo-prep-rules/{stale.id}",
                            json={"note": "old"}).status_code == 200


def test_reactivating_a_valid_line_saves_with_the_warnings(client, db, reta):
    c05 = _cartridge(db, "Endosafe 0.05", 0.05)
    c01 = _cartridge(db, "Endosafe 0.01", 0.01)
    _method(client, db, "Endotoxin", _service(db), [(c05, True)])
    e = _post(client, peptide_id=reta.id, max_mg=10, cartridge_type_id=c01.id).json()["rule"]["id"]
    f = _post(client, peptide_id=reta.id, total_dilution=300).json()["rule"]["id"]
    client.patch(f"/endo-prep-rules/{e}", json={"active": False})
    res = client.patch(f"/endo-prep-rules/{e}", json={"active": True})
    assert res.status_code == 200 and res.json()["rule"]["active"] is True
    assert res.json()["warnings"] == [
        f"overlaps rule {f} (any weight) {OVERLAP_RULE}",
        "cartridge 'Endosafe 0.01' is not allowed by the active method 'Endotoxin' rev 1; "
        "its rows keep their usual cartridge"]
    # An already-active line sent active=true again is no reactivation: only its own field checks run.
    c01.active = False
    db.commit()
    assert client.patch(f"/endo-prep-rules/{e}", json={"active": True}).status_code == 200


# --- audit and reorder -------------------------------------------------------------


def test_a_rules_recon_water_is_saved_served_and_must_be_positive(client, db, reta):
    """Dennis's ask (Handler 2026-10-26): some products need more than the
    standard 2 mL. Blank keeps the standard, like every other value."""
    rule = _post(client, peptide_id=reta.id, max_mg=30, recon_water_ml=3).json()["rule"]
    assert rule["recon_water_ml"] == 3.0
    assert client.get("/endo-prep-rules").json()[0]["recon_water_ml"] == 3.0
    # Cleared back to the standard by an explicit null, like total_dilution.
    patched = client.patch(f"/endo-prep-rules/{rule['id']}", json={"recon_water_ml": None})
    assert (patched.status_code, patched.json()["rule"]["recon_water_ml"]) == (200, None)
    for bad in (0, -1):
        r = _post(client, peptide_id=reta.id, min_mg=100, recon_water_ml=bad)
        assert (r.status_code, r.json()["detail"]) == (
            400, "recon_water_ml must be greater than zero")


def test_create_and_update_are_audited_with_old_and_new(client, db, reta):
    first = _post(client, peptide_id=reta.id, max_mg=30).json()["rule"]
    second = _post(client, peptide_id=reta.id, min_mg=30, total_dilution=300).json()["rule"]
    created = _audits(db, "endo_prep_rule_created")
    assert [(a.entity_type, a.entity_id) for a in created] == [
        ("endo_prep_rule", str(first["id"])), ("endo_prep_rule", str(second["id"]))]
    assert created[0].details == {"user_id": 1, "old": None,
                                  "new": {k: first[k] for k in SNAPSHOT_KEYS}}

    client.patch(f"/endo-prep-rules/{second['id']}", json={"total_dilution": 350})
    client.patch(f"/endo-prep-rules/{second['id']}", json={"total_dilution": 350})   # no change
    updated = _audits(db, "endo_prep_rule_updated")
    assert len(updated) == 1
    assert updated[0].entity_id == str(second["id"])
    assert updated[0].details == {
        "user_id": 1, "old": {k: second[k] for k in SNAPSHOT_KEYS},
        "new": {**{k: second[k] for k in SNAPSHOT_KEYS}, "total_dilution": 350.0}}
    assert db.get(EndoPrepRule, second["id"]).updated_by_id == 1

    # Turning a line off is an update too: one row, old active and new inactive.
    client.patch(f"/endo-prep-rules/{first['id']}", json={"active": False})
    off = _audits(db, "endo_prep_rule_updated")[-1]
    assert (len(_audits(db, "endo_prep_rule_updated")), off.entity_id) == (2, str(first["id"]))
    assert (off.details["old"]["active"], off.details["new"]["active"]) == (True, False)


def test_reorder_sets_the_list_order_and_needs_every_rule_once(client, db, reta):
    ids = [_post(client, peptide_id=reta.id, min_mg=lo, max_mg=lo + 10).json()["rule"]["id"]
           for lo in (0, 10, 20)]
    client.patch(f"/endo-prep-rules/{ids[0]}", json={"active": False})   # ordered too
    order = [ids[2], ids[0], ids[1]]

    res = client.post("/endo-prep-rules/reorder", json={"ids": order})
    assert res.status_code == 200
    assert [(r["id"], r["sort_order"]) for r in res.json()] == [(ids[2], 0), (ids[0], 1), (ids[1], 2)]
    assert [r["id"] for r in client.get("/endo-prep-rules").json()] == order
    audits = _audits(db, "endo_prep_rules_reordered")
    assert [(a.entity_type, a.entity_id, a.details) for a in audits] == [
        ("endo_prep_rule", None, {"user_id": 1, "old": ids, "new": order})]

    for bad in ([ids[2], ids[0]], [ids[2], ids[0], ids[1], ids[1]], [ids[2], ids[0], 987654]):
        _refused(client.post("/endo-prep-rules/reorder", json={"ids": bad}),
                 "ids must list every rule exactly once")
    # The current order again changes nothing and writes no audit row.
    assert client.post("/endo-prep-rules/reorder", json={"ids": order}).status_code == 200
    assert len(_audits(db, "endo_prep_rules_reordered")) == 1
