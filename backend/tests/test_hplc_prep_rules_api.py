"""HPLC prep rules, Task 3 of plan 2026-11-12-hplc-prep-rules: the four
routes, the HPLC twin of test_endo_prep_rules_api.py. List, create, edit,
reorder, the save checks with their 400 text, the warnings, the audit rows and
the sign-in guard. In-memory SQLite + dependency overrides. Never
`with TestClient(app)`: that runs the lifespan, whose init_db writes to the
host Postgres."""
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
from models import AuditLog, HplcPrepRule, Instrument, Peptide, blend_components
from tests.test_endo_v2_worksheets import _count_sql
from tests.test_spec_rules import _mk_peptide

SNAPSHOT_KEYS = ("id", "peptide_id", "min_mg", "max_mg", "target_conc_ug_ml",
                 "blend_target_conc_ug_ml", "lead_component_id", "lead_priority",
                 "floor_ug_ml", "diluent", "default_instrument_id", "status", "note",
                 "sort_order", "active")


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


@pytest.fixture
def blend(db):
    """A blend of two components, as blend_components holds it."""
    bpc = _mk_peptide(db, "BPC", name="BPC-157")
    ghk = _mk_peptide(db, "GHK", name="GHK-Cu")
    mix = Peptide(name="GLOW", abbreviation="GLOW", is_blend=True)
    db.add(mix)
    db.flush()
    db.execute(blend_components.insert(), [
        {"blend_id": mix.id, "component_id": bpc.id, "display_order": 0, "vial_number": 1},
        {"blend_id": mix.id, "component_id": ghk.id, "display_order": 1, "vial_number": 1}])
    db.commit()
    return mix, bpc, ghk


@pytest.fixture
def seeded(client, reta):
    return _post(client, peptide_id=reta.id, max_mg=30).json()["rule"]


def _instrument(db, name, active=True):
    inst = Instrument(name=name, active=active)
    db.add(inst)
    db.commit()
    return inst


def _post(client, **body):
    return client.post("/hplc-prep-rules", json=body)


def _refused(res, detail):
    assert (res.status_code, res.json()["detail"]) == (400, detail)


def _audits(db, operation):
    return db.execute(select(AuditLog).where(AuditLog.operation == operation)
                      .order_by(AuditLog.id)).scalars().all()


# --- list and create ----------------------------------------------------------


def test_create_appends_a_line_and_the_list_serves_it(client, db, reta):
    assert client.get("/hplc-prep-rules").json() == []
    inst = _instrument(db, "1260 Infinity")

    res = _post(client, peptide_id=reta.id, max_mg=30, target_conc_ug_ml=250,
                status="validated", note="250 fine to 30 mg")
    assert res.status_code == 201
    assert res.json()["warnings"] == []
    first = res.json()["rule"]
    assert first["updated_at"]
    assert {k: v for k, v in first.items() if k != "updated_at"} == {
        "id": first["id"], "peptide_id": reta.id, "min_mg": None, "max_mg": 30.0,
        "target_conc_ug_ml": 250.0, "blend_target_conc_ug_ml": None,
        "lead_component_id": None, "lead_priority": None, "floor_ug_ml": None,
        "diluent": None, "default_instrument_id": None,
        "status": "validated", "note": "250 fine to 30 mg", "sort_order": 0, "active": True,
        "peptide_name": "Retatrutide", "peptide_is_blend": False,
        "lead_component_name": None, "default_instrument_name": None}

    second = _post(client, peptide_id=reta.id, min_mg=30, diluent="Water + 0.1% TFA",
                   default_instrument_id=inst.id, note="  ").json()["rule"]
    assert (second["sort_order"], second["status"], second["note"], second["diluent"],
            second["default_instrument_name"]) == (
        1, "trial", None, "Water + 0.1% TFA", "1260 Infinity")
    assert client.get("/hplc-prep-rules").json() == [first, second]

    # Inactive lines stay on the list (there is no delete).
    client.patch(f"/hplc-prep-rules/{first['id']}", json={"active": False})
    assert [r["active"] for r in client.get("/hplc-prep-rules").json()] == [False, True]


def test_out_declares_every_key_the_page_reads(client, seeded):
    row = client.get("/hplc-prep-rules").json()[0]
    assert set(row) == {"id", "peptide_id", "min_mg", "max_mg", "target_conc_ug_ml",
                        "blend_target_conc_ug_ml", "lead_component_id", "lead_priority",
                        "floor_ug_ml", "diluent", "default_instrument_id", "status", "note",
                        "sort_order", "active", "peptide_name", "peptide_is_blend",
                        "lead_component_name", "default_instrument_name", "updated_at"}


def test_a_blend_line_serves_its_lead_and_a_component_line_its_priority(client, blend):
    mix, bpc, ghk = blend
    line = _post(client, peptide_id=mix.id, lead_component_id=ghk.id).json()["rule"]
    assert (line["peptide_name"], line["peptide_is_blend"], line["lead_component_id"],
            line["lead_component_name"]) == ("GLOW", True, ghk.id, "GHK-Cu")
    comp = _post(client, peptide_id=bpc.id, lead_priority=1,
                 blend_target_conc_ug_ml=150).json()["rule"]
    assert (comp["peptide_is_blend"], comp["lead_priority"], comp["blend_target_conc_ug_ml"],
            comp["lead_component_name"]) == (False, 1, 150.0, None)


def test_the_list_is_one_query(client, db, reta, blend):
    inst = _instrument(db, "1260 Infinity")
    mix, _bpc, ghk = blend
    for lo in (0, 10, 20):
        _post(client, peptide_id=reta.id, min_mg=lo, max_mg=lo + 10,
              default_instrument_id=inst.id)
    _post(client, peptide_id=mix.id, lead_component_id=ghk.id)
    with _count_sql(db) as seen:
        assert len(client.get("/hplc-prep-rules").json()) == 4
    assert len(seen) == 1


def test_every_route_needs_a_signed_in_user(client, reta):
    app.dependency_overrides.pop(get_current_user)
    assert client.get("/hplc-prep-rules").status_code == 401
    assert _post(client, peptide_id=reta.id).status_code == 401
    assert client.patch("/hplc-prep-rules/1", json={"note": "x"}).status_code == 401
    assert client.post("/hplc-prep-rules/reorder", json={"ids": []}).status_code == 401


# --- save checks ----------------------------------------------------------------


@pytest.mark.parametrize("body, detail", [
    ({"peptide_id": 987654}, "peptide 987654 not found"),
    ({"target_conc_ug_ml": 0}, "target_conc_ug_ml must be greater than zero"),
    ({"floor_ug_ml": -5}, "floor_ug_ml must be greater than zero"),
    ({"min_mg": 30, "max_mg": 30}, "min_mg must be below max_mg"),
    ({"min_mg": 40, "max_mg": 30}, "min_mg must be below max_mg"),
    ({"lead_priority": 0}, "lead_priority must be a whole number from 1 to 999"),
    ({"lead_priority": 1000}, "lead_priority must be a whole number from 1 to 999"),
    ({"lead_priority": 2147483648}, "lead_priority must be a whole number from 1 to 999"),
    ({"min_mg": -1}, "min_mg must not be negative"),
    ({"max_mg": -1}, "max_mg must not be negative"),
    ({"diluent": "Methanol"},
     "diluent 'Methanol' is not one of: Water, Water + 0.1% TFA"),
    ({"default_instrument_id": 987654}, "instrument 987654 is not an active instrument"),
    ({"floor_ug_ml": 40}, "only a blend line sets a floor"),
])
def test_create_refuses_with_the_reason(client, db, reta, body, detail):
    _refused(_post(client, **{"peptide_id": reta.id, **body}), detail)
    assert db.execute(select(HplcPrepRule)).first() is None


@pytest.mark.parametrize("body, detail", [
    ({"floor_ug_ml": 200}, "the floor 200 ug/mL must be below the target 200 ug/mL"),
    ({"target_conc_ug_ml": 50}, "the floor 60 ug/mL must be below the target 50 ug/mL"),
])
def test_create_refuses_a_blend_floor_not_below_the_target(client, db, blend, body, detail):
    mix, _bpc, _ghk = blend
    _refused(_post(client, **{"peptide_id": mix.id, **body}), detail)
    assert db.execute(select(HplcPrepRule)).first() is None


def test_a_solo_line_has_no_floor_check(client, reta):
    assert _post(client, peptide_id=reta.id, target_conc_ug_ml=50).status_code == 201


@pytest.mark.parametrize("raw, detail", [
    ('"target_conc_ug_ml": Infinity', "target_conc_ug_ml must be a finite number"),
    ('"min_mg": NaN', "min_mg must be a finite number"),
])
def test_create_refuses_a_number_that_is_not_finite(client, reta, raw, detail):
    # Raw JSON: httpx's json= refuses NaN and Infinity, FastAPI's parser accepts them.
    res = client.post("/hplc-prep-rules", content=f'{{"peptide_id": {reta.id}, {raw}}}',
                      headers={"Content-Type": "application/json"})
    _refused(res, detail)


def test_create_refuses_a_retired_instrument(client, db, reta):
    retired = _instrument(db, "1100 old", active=False)
    _refused(_post(client, peptide_id=reta.id, default_instrument_id=retired.id),
             f"instrument {retired.id} is not an active instrument")


def test_create_refuses_a_lead_off_the_blend_and_component_fields_on_a_blend(
        client, reta, blend):
    mix, bpc, _ghk = blend
    _refused(_post(client, peptide_id=bpc.id, lead_component_id=reta.id),
             "only a blend line names a lead")
    _refused(_post(client, peptide_id=mix.id, lead_component_id=reta.id),
             f"peptide {reta.id} is not a component of blend {mix.id}")
    _refused(_post(client, peptide_id=mix.id, lead_priority=1),
             "blend_target_conc_ug_ml and lead_priority are for component lines: "
             "a blend is never a component of another blend")


def test_status_is_trial_or_validated(client, reta):
    assert _post(client, peptide_id=reta.id, status="final").status_code == 422


def test_lead_priority_is_a_whole_number(client, reta):
    assert _post(client, peptide_id=reta.id, lead_priority=1.5).status_code == 422


def test_an_all_standard_line_saves(client, reta):
    assert _post(client, peptide_id=reta.id).status_code == 201


# --- warnings -------------------------------------------------------------------


def test_an_overlapping_band_saves_with_a_warning(client, db, reta):
    e = _post(client, peptide_id=reta.id, max_mg=10, target_conc_ug_ml=300).json()
    assert e["warnings"] == []
    f = _post(client, peptide_id=reta.id, target_conc_ug_ml=250)
    assert f.status_code == 201
    assert f.json()["warnings"] == [f"overlaps rule {e['rule']['id']} (up to 10 mg) {OVERLAP_RULE}"]
    # Bands that meet at 30 mg do not overlap.
    tesa = _mk_peptide(db, "TESA", name="Tesamorelin")
    db.commit()
    assert _post(client, peptide_id=tesa.id, max_mg=30).json()["warnings"] == []
    assert _post(client, peptide_id=tesa.id, min_mg=30).json()["warnings"] == []
    # An inactive line overlaps nothing, and an inactive line is not warned about.
    assert client.patch(f"/hplc-prep-rules/{e['rule']['id']}",
                        json={"active": False}).json()["warnings"] == []
    assert client.patch(f"/hplc-prep-rules/{f.json()['rule']['id']}",
                        json={"note": "any weight"}).json()["warnings"] == []


def test_a_shared_lead_priority_saves_with_a_warning(client, db, blend):
    _mix, bpc, ghk = blend
    first = _post(client, peptide_id=bpc.id, lead_priority=1).json()["rule"]["id"]
    res = _post(client, peptide_id=ghk.id, lead_priority=1)
    assert res.status_code == 201
    assert res.json()["warnings"] == [
        f"lead_priority 1 is also used by rule {first}; ties go to the component listed first"]
    # A second band of the same peptide carries its priority without a warning.
    tesa = _mk_peptide(db, "TESA", name="Tesamorelin")
    db.commit()
    _post(client, peptide_id=tesa.id, max_mg=10, lead_priority=2)
    assert _post(client, peptide_id=tesa.id, min_mg=10,
                 lead_priority=2).json()["warnings"] == []


# --- edit -----------------------------------------------------------------------


def test_patch_changes_only_what_it_sends_and_checks_the_stored_line(client, reta):
    rid = _post(client, peptide_id=reta.id, min_mg=30, target_conc_ug_ml=250,
                note="60 mg PPC low").json()["rule"]["id"]
    res = client.patch(f"/hplc-prep-rules/{rid}",
                       json={"target_conc_ug_ml": 300, "status": "validated"})
    assert res.status_code == 200
    rule = res.json()["rule"]
    assert (rule["min_mg"], rule["target_conc_ug_ml"], rule["status"], rule["note"]) == (
        30.0, 300.0, "validated", "60 mg PPC low")
    # The band check reads the stored bound beside the sent one.
    _refused(client.patch(f"/hplc-prep-rules/{rid}", json={"max_mg": 20}),
             "min_mg must be below max_mg")
    # A solo line sets no floor.
    _refused(client.patch(f"/hplc-prep-rules/{rid}", json={"floor_ug_ml": 40}),
             "only a blend line sets a floor")
    for field in ("peptide_id", "status", "active"):
        _refused(client.patch(f"/hplc-prep-rules/{rid}", json={field: None}),
                 f"{field} cannot be empty")
    res = client.patch("/hplc-prep-rules/987654", json={"note": "x"})
    assert (res.status_code, res.json()["detail"]) == (404, "prep rule 987654 not found")


def test_the_floor_check_reads_the_stored_target_beside_a_sent_floor(client, blend):
    mix, _bpc, _ghk = blend
    rid = _post(client, peptide_id=mix.id, target_conc_ug_ml=300).json()["rule"]["id"]
    _refused(client.patch(f"/hplc-prep-rules/{rid}", json={"floor_ug_ml": 300}),
             "the floor 300 ug/mL must be below the target 300 ug/mL")
    assert client.patch(f"/hplc-prep-rules/{rid}",
                        json={"floor_ug_ml": 80}).json()["rule"]["floor_ug_ml"] == 80.0


def test_moving_a_blend_line_that_names_a_lead_onto_a_solo_peptide_is_refused(
        client, db, reta, blend):
    mix, _bpc, ghk = blend
    rid = _post(client, peptide_id=mix.id, lead_component_id=ghk.id).json()["rule"]["id"]
    _refused(client.patch(f"/hplc-prep-rules/{rid}", json={"peptide_id": reta.id}),
             "only a blend line names a lead")
    db.expire_all()
    stored = db.get(HplcPrepRule, rid)
    assert (stored.peptide_id, stored.lead_component_id) == (mix.id, ghk.id)
    assert _audits(db, "hplc_prep_rule_updated") == []


def test_an_explicit_null_clears_a_value_back_to_the_standard(client, db, blend):
    mix, _bpc, _ghk = blend
    inst = _instrument(db, "1260 Infinity")
    rid = _post(client, peptide_id=mix.id, target_conc_ug_ml=250, floor_ug_ml=80,
                diluent="Water + 0.1% TFA", default_instrument_id=inst.id,
                note="keep").json()["rule"]["id"]
    res = client.patch(f"/hplc-prep-rules/{rid}",
                       json={"target_conc_ug_ml": None, "diluent": None,
                             "default_instrument_id": None})
    assert res.status_code == 200
    rule = res.json()["rule"]
    assert (rule["target_conc_ug_ml"], rule["diluent"], rule["default_instrument_id"],
            rule["default_instrument_name"], rule["floor_ug_ml"], rule["note"]) == (
        None, None, None, None, 80.0, "keep")
    # A target cleared back to the method's 200 is re-checked against the floor.
    client.patch(f"/hplc-prep-rules/{rid}", json={"target_conc_ug_ml": 500, "floor_ug_ml": 250})
    _refused(client.patch(f"/hplc-prep-rules/{rid}", json={"target_conc_ug_ml": None}),
             "the floor 250 ug/mL must be below the target 200 ug/mL")


def test_a_line_whose_instrument_was_retired_can_still_be_deactivated(client, db, reta):
    inst = _instrument(db, "1260 Infinity")
    rid = _post(client, peptide_id=reta.id, default_instrument_id=inst.id).json()["rule"]["id"]
    inst.active = False
    db.commit()
    res = client.patch(f"/hplc-prep-rules/{rid}",
                       json={"active": False, "note": "instrument retired"})
    assert res.status_code == 200 and res.json()["rule"]["active"] is False
    _refused(client.patch(f"/hplc-prep-rules/{rid}", json={"default_instrument_id": inst.id}),
             f"instrument {inst.id} is not an active instrument")


def test_reactivating_a_line_rechecks_a_retired_instrument(client, db, reta):
    inst = _instrument(db, "1260 Infinity")
    rid = _post(client, peptide_id=reta.id, default_instrument_id=inst.id).json()["rule"]["id"]
    client.patch(f"/hplc-prep-rules/{rid}", json={"active": False})
    inst.active = False
    db.commit()
    _refused(client.patch(f"/hplc-prep-rules/{rid}", json={"active": True}),
             f"instrument {inst.id} is not an active instrument")
    assert db.get(HplcPrepRule, rid).active is False
    # Clearing the instrument in the same request makes the line valid again.
    res = client.patch(f"/hplc-prep-rules/{rid}",
                       json={"active": True, "default_instrument_id": None})
    assert res.status_code == 200 and res.json()["rule"]["active"] is True


def test_reactivating_a_line_that_no_longer_passes_the_other_checks_is_refused(
        client, db, reta, blend):
    mix, _bpc, _ghk = blend
    for peptide, values, detail in [
        (mix, {"floor_ug_ml": 250}, "the floor 250 ug/mL must be below the target 200 ug/mL"),
        (reta, {"floor_ug_ml": 40}, "only a blend line sets a floor"),
        (reta, {"min_mg": 30, "max_mg": 30}, "min_mg must be below max_mg"),
        (reta, {"target_conc_ug_ml": 0}, "target_conc_ug_ml must be greater than zero"),
        (reta, {"diluent": "Methanol"},
         "diluent 'Methanol' is not one of: Water, Water + 0.1% TFA"),
    ]:
        stale = HplcPrepRule(peptide_id=peptide.id, active=False, sort_order=0, **values)
        db.add(stale)
        db.commit()
        _refused(client.patch(f"/hplc-prep-rules/{stale.id}", json={"active": True}), detail)
        assert db.get(HplcPrepRule, stale.id).active is False
        # Still inactive, such a line can be re-noted.
        assert client.patch(f"/hplc-prep-rules/{stale.id}",
                            json={"note": "old"}).status_code == 200


def test_reactivating_a_valid_line_saves_with_the_warnings(client, db, reta):
    inst = _instrument(db, "1260 Infinity")
    e = _post(client, peptide_id=reta.id, max_mg=10,
              default_instrument_id=inst.id).json()["rule"]["id"]
    f = _post(client, peptide_id=reta.id, target_conc_ug_ml=250).json()["rule"]["id"]
    client.patch(f"/hplc-prep-rules/{e}", json={"active": False})
    res = client.patch(f"/hplc-prep-rules/{e}", json={"active": True})
    assert res.status_code == 200 and res.json()["rule"]["active"] is True
    assert res.json()["warnings"] == [f"overlaps rule {f} (any weight) {OVERLAP_RULE}"]
    # An already-active line sent active=true again is no reactivation: only its own field checks run.
    inst.active = False
    db.commit()
    assert client.patch(f"/hplc-prep-rules/{e}", json={"active": True}).status_code == 200


# --- audit and reorder -------------------------------------------------------------


def test_create_and_update_are_audited_with_old_and_new(client, db, reta):
    first = _post(client, peptide_id=reta.id, max_mg=30).json()["rule"]
    second = _post(client, peptide_id=reta.id, min_mg=30, target_conc_ug_ml=250).json()["rule"]
    created = _audits(db, "hplc_prep_rule_created")
    assert [(a.entity_type, a.entity_id) for a in created] == [
        ("hplc_prep_rule", str(first["id"])), ("hplc_prep_rule", str(second["id"]))]
    assert created[0].details == {"user_id": 1, "old": None,
                                  "new": {k: first[k] for k in SNAPSHOT_KEYS}}

    client.patch(f"/hplc-prep-rules/{second['id']}", json={"target_conc_ug_ml": 300})
    updated = _audits(db, "hplc_prep_rule_updated")
    assert len(updated) == 1
    assert updated[0].entity_id == str(second["id"])
    assert updated[0].details == {
        "user_id": 1, "old": {k: second[k] for k in SNAPSHOT_KEYS},
        "new": {**{k: second[k] for k in SNAPSHOT_KEYS}, "target_conc_ug_ml": 300.0}}
    assert db.get(HplcPrepRule, second["id"]).updated_by_id == 1

    # Turning a line off is an update too: one row, old active and new inactive.
    client.patch(f"/hplc-prep-rules/{first['id']}", json={"active": False})
    off = _audits(db, "hplc_prep_rule_updated")[-1]
    assert (len(_audits(db, "hplc_prep_rule_updated")), off.entity_id) == (2, str(first["id"]))
    assert (off.details["old"]["active"], off.details["new"]["active"]) == (True, False)


def test_a_save_that_changes_nothing_writes_no_audit_row(client, db, reta):
    rid = _post(client, peptide_id=reta.id, target_conc_ug_ml=250,
                note="same").json()["rule"]["id"]
    for body in ({"target_conc_ug_ml": 250}, {"note": "same"}, {}):
        assert client.patch(f"/hplc-prep-rules/{rid}", json=body).status_code == 200
    assert _audits(db, "hplc_prep_rule_updated") == []
    assert db.get(HplcPrepRule, rid).updated_by_id == 1


def test_reorder_sets_the_list_order_and_needs_every_rule_once(client, db, reta):
    ids = [_post(client, peptide_id=reta.id, min_mg=lo, max_mg=lo + 10).json()["rule"]["id"]
           for lo in (0, 10, 20)]
    client.patch(f"/hplc-prep-rules/{ids[0]}", json={"active": False})   # ordered too
    order = [ids[2], ids[0], ids[1]]

    res = client.post("/hplc-prep-rules/reorder", json={"ids": order})
    assert res.status_code == 200
    assert [(r["id"], r["sort_order"]) for r in res.json()] == [(ids[2], 0), (ids[0], 1), (ids[1], 2)]
    assert [r["id"] for r in client.get("/hplc-prep-rules").json()] == order
    audits = _audits(db, "hplc_prep_rules_reordered")
    assert [(a.entity_type, a.entity_id, a.details) for a in audits] == [
        ("hplc_prep_rule", None, {"user_id": 1, "old": ids, "new": order})]

    for bad in ([ids[2], ids[0], ids[1], ids[1]], [ids[2], ids[0], 987654]):
        _refused(client.post("/hplc-prep-rules/reorder", json={"ids": bad}),
                 "ids must list every rule exactly once")
    # The current order again changes nothing and writes no audit row.
    assert client.post("/hplc-prep-rules/reorder", json={"ids": order}).status_code == 200
    assert len(_audits(db, "hplc_prep_rules_reordered")) == 1


def test_reorder_with_a_stale_id_list_is_refused_whole(client, db, reta):
    ids = [_post(client, peptide_id=reta.id, min_mg=lo, max_mg=lo + 10).json()["rule"]["id"]
           for lo in (0, 10, 20)]
    # A page loaded before the third line was added sends only the first two.
    _refused(client.post("/hplc-prep-rules/reorder", json={"ids": [ids[1], ids[0]]}),
             "ids must list every rule exactly once")
    db.expire_all()
    assert [(r.id, r.sort_order) for r in db.execute(
        select(HplcPrepRule).order_by(HplcPrepRule.id)).scalars()] == [
        (ids[0], 0), (ids[1], 1), (ids[2], 2)]
    assert _audits(db, "hplc_prep_rules_reordered") == []
