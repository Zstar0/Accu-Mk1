"""Endo slice 5 on the worksheet rows (spec
docs/superpowers/specs/2026-10-14-endo-slice5-method-rules-design.md, sections
4 to 8): the row columns, effective values in the server's floor and promote
checks, the lock events, release, override history and Re-apply.
In-memory SQLite + dependency overrides, with test_endo_v2_worksheets.py's
and test_endo_worksheet_promote.py's helpers."""
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import endo_prep_rules
from auth import get_current_user
from database import Base, get_db
from main import app
from models import AuditLog, EndoPrepRule, LimsAnalysis, LimsSample
from tests.test_endo_v2_worksheets import (
    _count_sql, _import, _reader_world, _row_world, _service, _vial_item, _ws,
)
from tests.test_endo_v2_worksheets import _line as _reader_line
from tests.test_endo_worksheet_promote import BAD, _promote, _refused, _results, _row, _world
from tests.test_endo_worksheet_promote import _line as _promote_line
from tests.test_hplc_native_schema import _captured
from tests.test_spec_rules import _mk_identity_service, _mk_peptide


@pytest.fixture(autouse=True)
def cascade_calls(monkeypatch):
    """test_endo_worksheet_promote.py's guard: the real run_cascades_bg opens
    its own session on the host Postgres."""
    monkeypatch.setattr("workflow.engine.run_cascades_bg", lambda parent_pk, user_id: None)


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


def _peptide(db, abbreviation="RETA", name="Retatrutide"):
    return _mk_peptide(db, abbreviation, name)


def _anchor(db, parent_sample_id, peptide):
    """Give the parent its catalog peptide: a family analysis on a
    peptide-linked service, which coa.spec_rules.sample_peptide_ids reads."""
    parent = db.execute(
        select(LimsSample).where(LimsSample.sample_id == parent_sample_id)).scalar_one()
    svc = _mk_identity_service(db, peptide.id, f"{peptide.abbreviation}-PURITY")
    db.add(LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id, keyword=svc.keyword,
                        title=svc.title, review_state="unassigned", provenance="canonical"))
    db.flush()


def _rule(db, peptide, *, sort_order=1, **values):
    """An active trial line for `peptide`, for any weight unless bounds are given."""
    rule = EndoPrepRule(peptide_id=peptide.id, status="trial", active=True,
                        sort_order=sort_order, **values)
    db.add(rule)
    db.flush()
    return rule


def _lock(rule, locked_by="result"):
    """A lock snapshot as lock_rows writes it (spec 6)."""
    return {"rule": endo_prep_rules.snapshot(rule) if rule is not None else None,
            "locked_at": "2026-10-14T09:00:00Z", "locked_by": locked_by, "user_id": 1}


# --- Task 3: the row columns --------------------------------------------------

_S5_DDL = [
    "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS prep_rule JSON",
    "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS prep_rules_off BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS prep_note TEXT",
    "ALTER TABLE worksheet_items ADD COLUMN IF NOT EXISTS prep_history JSON",
]


def test_the_row_columns_exist_with_their_defaults(db):
    cols = {c["name"] for c in inspect(db.get_bind()).get_columns("worksheet_items")}
    assert {"prep_rule", "prep_rules_off", "prep_note", "prep_history"} <= cols
    ws = _ws(db)
    item, _ = _vial_item(db, ws, 1, _service(db))
    db.commit()
    db.refresh(item)
    assert (item.prep_rule, item.prep_rules_off, item.prep_note, item.prep_history) == (
        None, False, None, None)


def test_boot_migrations_add_the_row_columns_above_the_last_statement():
    stmts = _captured()
    assert [s for s in stmts if s in _S5_DDL] == _S5_DDL
    assert stmts[-1] == "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS retest_of_sample_id TEXT"


# --- Task 3: a row's rule and its effective values ---------------------------

def _r(**fields):
    """A row as row_rule and effective_values read it."""
    return SimpleNamespace(**{"prep_total_dilution": None, "prep_steps": None,
                              "cartridge_type_id": None, "prep_rule": None,
                              "prep_rules_off": False, **fields})


_LINE = {"id": 7, "peptide_id": 3, "min_mg": None, "max_mg": None, "total_dilution": 300.0,
         "step1_ratio": 15.0, "cartridge_type_id": 42, "status": "trial", "note": None,
         "sort_order": 1, "active": True}


def test_effective_values_typed_beats_rule_beats_standard_per_field():
    ev = endo_prep_rules.effective_values
    none = {"total_dilution": False, "step1_ratio": False, "cartridge_type_id": False}
    assert ev(_r(), None, std_total=250) == {
        "total_dilution": 250, "step1_ratio": 10, "cartridge_type_id": None, "ruled": none}
    assert ev(_r(), _LINE, std_total=250) == {
        "total_dilution": 300.0, "step1_ratio": 15.0, "cartridge_type_id": 42,
        "ruled": dict.fromkeys(none, True)}
    # A typed total and cartridge win; step 1 with only its sample uL keeps the rule's ratio.
    assert ev(_r(prep_total_dilution=500, prep_steps=[[30], None, None], cartridge_type_id=5),
              _LINE, std_total=250) == {
        "total_dilution": 500, "step1_ratio": 15.0, "cartridge_type_id": 5,
        "ruled": {"total_dilution": False, "step1_ratio": True, "cartridge_type_id": False}}
    assert ev(_r(prep_steps=[[20, 4], None, None]), _LINE, std_total=250)["step1_ratio"] == 4.0
    # A line's null value leaves that field at the standard; a total of 0 is no total.
    assert ev(_r(prep_total_dilution=0), {**_LINE, "total_dilution": None},
              std_total=500)["total_dilution"] == 500


def test_row_rule_reads_the_switch_then_the_lock_then_todays_match(monkeypatch):
    asked = []
    monkeypatch.setattr(endo_prep_rules, "match_rule", lambda rules, **q: asked.append(q) or _LINE)
    q = {"rules": [], "peptide_id": 3, "weight_mg": 10.0, "is_bac": False, "endo_prep": "2ml"}
    assert endo_prep_rules.row_rule(_r(), **q) == _LINE
    assert asked == [{"peptide_id": 3, "weight_mg": 10.0, "is_bac": False, "endo_prep": "2ml",
                      "rules_off": False}]
    locked = {"rule": {**_LINE, "total_dilution": 400.0}, "locked_at": "2026-10-14T09:00:00Z",
              "locked_by": "print", "user_id": 1}
    assert endo_prep_rules.row_rule(_r(prep_rule=locked), **q)["total_dilution"] == 400.0
    assert endo_prep_rules.row_rule(_r(prep_rule={**locked, "rule": None}), **q) is None
    assert endo_prep_rules.row_rule(_r(prep_rules_off=True, prep_rule=locked), **q) is None
    assert len(asked) == 1  # a lock or the switch never asks for today's match


def test_row_facts_reads_peptide_weight_and_bac_for_endotoxin_rows_only(client, db):
    pep = _peptide(db)
    svc = _service(db)
    ws = _ws(db)
    plain, _ = _vial_item(db, ws, 1, svc)          # P-3001, 10 mg declared
    weighed, _ = _vial_item(db, ws, 2, svc)
    weighed.prep_weight_mg = 12.5
    bac_form, _ = _vial_item(db, ws, 3, svc)
    bac_form.prep_form = "bac"
    hplc, _ = _vial_item(db, ws, 4, _service(db, "BPC157-PURITY"), role="hplc")
    _anchor(db, "P-3001", pep)
    db.commit()
    assert endo_prep_rules.row_facts(db, ws, [plain, weighed, bac_form, hplc]) == {
        plain.id: {"peptide_id": pep.id, "weight_mg": 10.0, "is_bac": False},
        weighed.id: {"peptide_id": pep.id, "weight_mg": 12.5, "is_bac": False},
        bac_form.id: {"peptide_id": pep.id, "weight_mg": 10.0, "is_bac": True},
    }
    counts = []
    for items in ([plain], [plain, weighed, bac_form, hplc]):
        with _count_sql(db) as seen:
            endo_prep_rules.row_facts(db, ws, items)
        counts.append(len(seen))
    assert counts[0] == counts[1] <= 4, counts


def test_row_facts_reads_bac_off_the_sample_and_no_peptide_for_a_blend(client, db):
    w = _world(client, db)
    bw, _ = _row(db, w, "BW-0100-S01", sample_type="Bacteriostatic Water", reading=None)
    blend, _ = _row(db, w, "P-4001-S01", reading=None)
    _anchor(db, "P-4001", _peptide(db, "RETA", "Retatrutide"))
    _anchor(db, "P-4001", _peptide(db, "TESA", "Tesamorelin"))
    db.commit()
    assert endo_prep_rules.row_facts(db, w.ws, [bw, blend]) == {
        bw.id: {"peptide_id": None, "weight_mg": None, "is_bac": True},
        blend.id: {"peptide_id": None, "weight_mg": None, "is_bac": False},
    }


# --- Task 3: the serializer and the PATCH fields -------------------------------

_RULE_KEYS = ("prep_rule", "prep_rules_off", "prep_note", "prep_history", "sample_peptide_id")


def test_2ml_endotoxin_items_carry_the_rule_keys(client, db):
    pep = _peptide(db)
    svc = _service(db)
    ws = _ws(db)
    item, _ = _vial_item(db, ws, 1, svc)
    hplc, _ = _vial_item(db, ws, 2, _service(db, "BPC157-PURITY"), role="hplc")
    stock = _ws(db, "Stock run")
    stock.endo_prep = "stock"
    _vial_item(db, stock, 3, svc)
    _anchor(db, "P-3001", pep)
    item.prep_note = "special: 1:500 for PPC"
    db.commit()
    items = {it["id"]: it for it in client.get(f"/worksheets/{ws.id}").json()["items"]}
    assert {k: items[item.id][k] for k in _RULE_KEYS} == {
        "prep_rule": None, "prep_rules_off": False, "prep_note": "special: 1:500 for PPC",
        "prep_history": None, "sample_peptide_id": pep.id}
    # Other benches and stock worksheets are never ruled: no new keys.
    assert not set(_RULE_KEYS) & set(items[hplc.id])
    [stock_item] = client.get(f"/worksheets/{stock.id}").json()["items"]
    assert not set(_RULE_KEYS) & set(stock_item)
    listed = next(w for w in client.get("/worksheets").json() if w["id"] == ws.id)
    assert {k: listed["items"][0][k] for k in _RULE_KEYS} == {
        k: items[item.id][k] for k in _RULE_KEYS}


def test_the_peptide_lookup_is_one_query_whatever_the_row_count(client, db):
    svc = _service(db)
    small, big = _ws(db, "Small"), _ws(db, "Big")
    for n in range(1, 3):
        _vial_item(db, small, n, svc)
    for n in range(3, 11):
        _vial_item(db, big, n, svc)
    _anchor(db, "P-3001", _peptide(db))
    db.commit()
    counts = []
    for ws_id in (small.id, big.id):
        db.expire_all()
        with _count_sql(db) as seen:
            assert client.get(f"/worksheets/{ws_id}").status_code == 200
        counts.append(len(seen))
    assert counts[0] == counts[1], counts


def test_patch_sets_the_switch_and_the_note_and_audits_them(client, db):
    ws, item, _, _ = _row_world(db)
    url = f"/worksheets/{ws.id}/items/{item.id}"
    r = client.patch(url, json={"prep_rules_off": True, "prep_note": "  special: 1:500 for PPC  "})
    assert r.status_code == 200, r.text
    db.refresh(item)
    assert (item.prep_rules_off, item.prep_note) == (True, "special: 1:500 for PPC")
    # A blank note clears it.
    assert client.patch(url, json={"prep_note": "   "}).status_code == 200
    db.refresh(item)
    assert item.prep_note is None
    assert [(a.details["old"], a.details["new"]) for a in db.query(AuditLog).filter(
        AuditLog.operation == "endo_prep_inputs_set").order_by(AuditLog.id)] == [
        ({"prep_rules_off": False, "prep_note": None},
         {"prep_rules_off": True, "prep_note": "special: 1:500 for PPC"}),
        ({"prep_note": "special: 1:500 for PPC"}, {"prep_note": None}),
    ]


@pytest.mark.parametrize("raw", [
    '{"prep_rules_off": null}',
    '{"prep_note": "' + "x" * 201 + '"}',
    '{"prep_note": "a\\u0000b"}',
    '{"prep_note": "\\ud800"}',      # a lone surrogate: a 400 that never echoes it
])
def test_patch_refuses_a_bad_switch_or_note_and_writes_nothing(client, db, raw):
    ws, item, _, _ = _row_world(db)
    r = client.patch(f"/worksheets/{ws.id}/items/{item.id}", content=raw,
                     headers={"Content-Type": "application/json"})
    assert r.status_code == 400, r.text
    db.refresh(item)
    assert (item.prep_rules_off, item.prep_note) == (False, None)


def test_a_completed_worksheet_refuses_the_switch_and_the_note(client, db):
    ws, item, _, _ = _row_world(db)
    ws.status = "completed"
    db.commit()
    for payload in ({"prep_rules_off": True}, {"prep_note": "special"}):
        assert client.patch(f"/worksheets/{ws.id}/items/{item.id}",
                            json=payload).status_code == 409, payload


# --- Task 3: the server checks read effective values -------------------------

def _ruled_world(db, **line):
    """_row_world's open worksheet and endo vial (P-3001, 10 mg declared, no
    method: the standard total is 250), the parent anchored to Retatrutide,
    and one Retatrutide line for any weight."""
    ws, item, c05, c01 = _row_world(db)
    pep = _peptide(db)
    _anchor(db, "P-3001", pep)
    rule = _rule(db, pep, **line)
    db.commit()
    return SimpleNamespace(ws=ws, item=item, c05=c05, c01=c01, pep=pep, rule=rule,
                           url=f"/worksheets/{ws.id}/items/{item.id}")


def _floor(n):
    return (f"prep_total_dilution must be at least {n} (the step 1 ratio x the fixed 1:2 step) "
            "or step 2 cannot be made")


def test_the_floor_check_reads_the_rules_total(client, db):
    w = _ruled_world(db, total_dilution=300)
    # 1:140 x 2 = 280: makeable at the rule's 1:300, not at the standard 1:250.
    assert client.patch(w.url, json={"prep_steps": [[20, 140], None, None]}).status_code == 200
    r = client.patch(w.url, json={"prep_steps": [[20, 160], None, None]})
    assert (r.status_code, r.json()["detail"]) == (400, _floor(320))


def test_the_floor_check_reads_the_rules_step1_ratio(client, db):
    w = _ruled_world(db, step1_ratio=50)
    r = client.patch(w.url, json={"prep_total_dilution": 90})
    assert (r.status_code, r.json()["detail"]) == (400, _floor(100))
    assert client.patch(w.url, json={"prep_total_dilution": 100}).status_code == 200


def test_switching_a_row_to_no_rule_checks_its_floor_at_the_standard(client, db):
    w = _ruled_world(db, total_dilution=300)
    assert client.patch(w.url, json={"prep_steps": [[20, 140], None, None]}).status_code == 200
    r = client.patch(w.url, json={"prep_rules_off": True})
    assert (r.status_code, r.json()["detail"]) == (400, _floor(280))
    db.refresh(w.item)
    assert w.item.prep_rules_off is False


def test_the_floor_check_reads_a_locked_line_never_one_edited_since(client, db):
    w = _ruled_world(db, total_dilution=300)
    w.item.prep_rule = _lock(w.rule, "print")
    w.rule.total_dilution = 200      # edited after the lock
    db.commit()
    # The locked 1:300 still makes 1:140 (280); today's 1:200 would not.
    assert client.patch(w.url, json={"prep_steps": [[20, 140], None, None]}).status_code == 200
    # A row locked to the standard reads 250 whatever the lines say.
    w.item.prep_rule = _lock(None, "print")
    db.commit()
    r = client.patch(w.url, json={"prep_steps": [[20, 140], None, None]})
    assert (r.status_code, r.json()["detail"]) == (400, _floor(280))


def test_a_ruled_row_promotes_on_its_locked_total_and_a_tampered_value_is_refused(client, db):
    """Review Focus 3: the promote check (slice 3 I-3) reads the locked
    line's total. 0.05 x 300 x 2 = 30 EU per vial; the standard 1:250 gives 25."""
    w = _world(client, db)
    item, _ = _row(db, w)                 # P-4001-S01, "<0.05" on the 0.05
    pep = _peptide(db)
    _anchor(db, "P-4001", pep)
    rule = _rule(db, pep, total_dilution=300)
    item.prep_rule = _lock(rule)
    db.commit()
    assert _results(_promote(client, w.ws, _promote_line(item))) == [_refused(item, BAD)]
    rule.total_dilution = 400             # an edit after the lock never reaches the check
    db.commit()
    [res] = _results(_promote(client, w.ws, _promote_line(item, 30, loq=30)))
    assert res["promoted"] is True, res
    audit = db.query(AuditLog).filter(AuditLog.operation == "endo_worksheet_promoted").one()
    assert (audit.details["total_dilution"], audit.details["loq"]) == (300, 30)


def test_a_bac_row_is_never_ruled_even_one_locked_before_its_form_was_set(client, db):
    """Preflight F2 (A.0 item 8): a row locked to a line while its form was
    powder, whose form is now bac, gets no rule and the standard values, as
    the browser's ruleFor reads it. The lock stays on the row; bac only stops
    it applying. row_effective is the F8 helper the checks share."""
    w = _ruled_world(db, total_dilution=300)
    w.item.prep_form = "powder"
    w.item.prep_rule = _lock(w.rule, "print")
    db.commit()
    rule, eff = endo_prep_rules.row_effective(db, w.ws, w.item)
    assert (rule["id"], eff["total_dilution"], eff["ruled"]["total_dilution"]) == (
        w.rule.id, 300, True)
    assert client.patch(w.url, json={"prep_form": "bac"}).status_code == 200
    db.refresh(w.item)
    assert w.item.prep_rule["rule"]["id"] == w.rule.id
    facts = endo_prep_rules.row_facts(db, w.ws, [w.item])[w.item.id]
    assert facts["is_bac"] is True
    assert endo_prep_rules.row_rule(w.item, rules=endo_prep_rules.load_rules(db),
                                    endo_prep="2ml", **facts) is None
    assert endo_prep_rules.row_effective(db, w.ws, w.item) == (None, {
        "total_dilution": 250, "step1_ratio": 10, "cartridge_type_id": None,
        "ruled": {"total_dilution": False, "step1_ratio": False, "cartridge_type_id": False}})
    # The server floor reads the standard 1:250, so 1:140 (x 2 = 280) no longer fits.
    r = client.patch(w.url, json={"prep_steps": [[20, 140], None, None]})
    assert (r.status_code, r.json()["detail"]) == (400, _floor(280))


# --- Task 3 review I1: the form is a rule input, so it moves the floor ---------

def test_a_form_change_that_brings_a_rule_in_is_refused_below_its_floor(client, db):
    """A bac row is never ruled (F2), so its 1:90 is makeable at the standard
    1:10 (floor 20). Powder brings in the line's 1:50 (floor 100), and so
    does clearing the form: the sample rule then decides, and P-3001 is a
    peptide. Both are refused with the floor text and write nothing."""
    w = _ruled_world(db, step1_ratio=50)
    w.item.prep_form = "bac"
    db.commit()
    assert client.patch(w.url, json={"prep_total_dilution": 90}).status_code == 200
    for form in ("powder", None):
        r = client.patch(w.url, json={"prep_form": form})
        assert (r.status_code, r.json()["detail"]) == (400, _floor(100)), form
    db.refresh(w.item)
    assert (w.item.prep_form, w.item.prep_total_dilution) == ("bac", 90)


def test_a_form_change_that_keeps_the_floor_makeable_saves(client, db):
    w = _ruled_world(db, step1_ratio=50)
    w.item.prep_form = "bac"
    db.commit()
    assert client.patch(w.url, json={"prep_total_dilution": 100}).status_code == 200
    assert client.patch(w.url, json={"prep_form": "powder"}).status_code == 200
    db.refresh(w.item)
    assert w.item.prep_form == "powder"


def test_a_patch_with_the_form_and_a_floor_field_is_checked_on_the_new_form(client, db):
    w = _ruled_world(db, step1_ratio=50)
    # Ruled 1:50 as stored; going bac drops the line, so 1:90 fits the standard.
    assert client.patch(w.url, json={"prep_form": "bac",
                                     "prep_total_dilution": 90}).status_code == 200
    # Going back to powder brings the line in again: 1:90 is below its floor.
    r = client.patch(w.url, json={"prep_form": "powder", "prep_total_dilution": 90})
    assert (r.status_code, r.json()["detail"]) == (400, _floor(100))
    db.refresh(w.item)
    assert w.item.prep_form == "bac"


# --- Task 4: lock events, release, override history ---------------------------

def _locks_world(client, db, **line):
    """_reader_world's open 2 mL worksheet on the active Endotoxin method
    (vials P-3001-S01 and -S02, 10 mg declared; the 0.05 and 0.01
    cartridges), the parent anchored to Retatrutide, and one Retatrutide
    line for any weight, 1:300 unless `line` says otherwise."""
    w = _reader_world(client, db)
    pep = _peptide(db)
    _anchor(db, "P-3001", pep)
    w.rule = _rule(db, pep, **(line or {"total_dilution": 300}))
    db.commit()
    w.url_a = f"/worksheets/{w.ws.id}/items/{w.a.id}"
    w.url_b = f"/worksheets/{w.ws.id}/items/{w.b.id}"
    return w


def test_every_print_locks_the_unlocked_2ml_endotoxin_rows(client, db):
    w = _locks_world(client, db)
    hplc, _ = _vial_item(db, w.ws, 3, _service(db, "BPC157-PURITY"), role="hplc")
    w.b.prep_rules_off = True
    db.commit()
    assert client.post(f"/worksheets/{w.ws.id}/printed").status_code == 200
    for x in (w.a, w.b, hplc):
        db.refresh(x)
    first = w.a.prep_rule
    assert first == {"rule": endo_prep_rules.snapshot(w.rule), "locked_at": first["locked_at"],
                     "locked_by": "print", "user_id": 1}
    assert first["locked_at"].endswith("Z")
    # A "no rule" row needs no lock; another bench's row is never ruled.
    assert (w.b.prep_rule, hplc.prep_rule) == (None, None)
    # Review Focus 1: the line is edited after the print, and a row is added.
    w.rule.total_dilution = 400
    late, _ = _vial_item(db, w.ws, 4, w.svc)
    db.commit()
    assert client.post(f"/worksheets/{w.ws.id}/printed").status_code == 200
    db.refresh(w.a)
    db.refresh(late)
    assert w.a.prep_rule == first     # the printed row keeps the 1:300 the bench prepped
    assert (late.prep_rule["locked_by"], late.prep_rule["rule"]["total_dilution"]) == ("print", 400)
    items = {it["id"]: it for it in client.get(f"/worksheets/{w.ws.id}").json()["items"]}
    assert items[w.a.id]["prep_rule"] == first


def test_a_row_with_no_matching_line_locks_to_the_standard(client, db):
    w = _reader_world(client, db)     # no lines at all
    assert client.post(f"/worksheets/{w.ws.id}/printed").status_code == 200
    db.refresh(w.a)
    assert (w.a.prep_rule["rule"], w.a.prep_rule["locked_by"]) == (None, "print")


def test_stock_and_completed_worksheets_never_lock(client, db):
    w = _locks_world(client, db)
    w.ws.endo_prep = "stock"
    done = _ws(db, "Completed before slice 5", status="completed")
    old, _ = _vial_item(db, done, 5, w.svc)
    db.commit()
    assert client.post(f"/worksheets/{w.ws.id}/printed").status_code == 200
    assert client.patch(w.url_a, json={"result_reading": "0.8",
                                       "cartridge_type_id": w.c05.id}).status_code == 200
    assert _import(client, w.ws, _reader_line(w.b, "0.8", w.c05)).status_code == 200
    assert client.post(f"/worksheets/{w.ws.id}/complete").status_code == 200
    assert client.post(f"/worksheets/{done.id}/printed").status_code == 200
    for x in (w.a, w.b, old):
        db.refresh(x)
    assert (w.a.prep_rule, w.b.prep_rule, old.prep_rule) == (None, None, None)


def test_the_first_reading_locks_its_row_and_clearing_releases_only_a_result_lock(client, db):
    w = _locks_world(client, db)
    assert client.patch(w.url_a, json={"result_reading": "<0.05",
                                       "cartridge_type_id": w.c05.id}).status_code == 200
    db.refresh(w.a)
    db.refresh(w.b)
    first = w.a.prep_rule
    assert (first["locked_by"], first["rule"]["id"]) == ("result", w.rule.id)
    assert w.b.prep_rule is None
    w.rule.total_dilution = 400
    db.commit()
    assert client.patch(w.url_a, json={"result_reading": "0.8"}).status_code == 200
    db.refresh(w.a)
    assert w.a.prep_rule == first     # a later reading keeps the first result's lock
    # Cleared, a result lock is released: the row follows today's rules again.
    assert client.patch(w.url_a, json={"result_reading": None}).status_code == 200
    db.refresh(w.a)
    assert w.a.prep_rule is None
    # Once the sheet is printed nothing is released: the bench preps any rerun
    # from that paper. Row b takes a result lock before the print, row a a print lock.
    assert client.patch(w.url_b, json={"result_reading": "0.8",
                                       "cartridge_type_id": w.c05.id}).status_code == 200
    assert client.post(f"/worksheets/{w.ws.id}/printed").status_code == 200
    for url in (w.url_a, w.url_b):
        for payload in ({"result_reading": "0.8", "cartridge_type_id": w.c05.id},
                        {"result_reading": None}):
            assert client.patch(url, json=payload).status_code == 200
    db.refresh(w.a)
    db.refresh(w.b)
    assert (w.a.prep_rule["locked_by"], w.a.prep_rule["rule"]["total_dilution"]) == ("print", 400)
    assert (w.b.prep_rule["locked_by"], w.b.prep_rule["rule"]["total_dilution"]) == ("result", 400)


def test_a_reader_import_locks_the_rows_it_gave_a_reading(client, db):
    w = _locks_world(client, db)
    r = _import(client, w.ws, _reader_line(w.a, "<0.05", w.c05))
    assert r.status_code == 200, r.text
    items = {it["id"]: it for it in r.json()["items"]}
    assert items[w.a.id]["prep_rule"]["locked_by"] == "result"
    assert items[w.a.id]["prep_rule"]["rule"] == endo_prep_rules.snapshot(w.rule)
    assert items[w.b.id]["prep_rule"] is None


def test_completion_locks_every_row_not_locked_yet(client, db):
    w = _locks_world(client, db)
    assert client.patch(w.url_a, json={"result_reading": "<0.05",
                                       "cartridge_type_id": w.c05.id}).status_code == 200
    assert client.post(f"/worksheets/{w.ws.id}/complete").status_code == 200
    db.refresh(w.a)
    db.refresh(w.b)
    assert (w.a.prep_rule["locked_by"], w.b.prep_rule["locked_by"]) == ("result", "complete")


def test_an_override_on_a_row_with_a_result_keeps_the_replaced_run(client, db):
    w = _locks_world(client, db)
    assert client.patch(w.url_a, json={"result_reading": "<0.05",
                                       "cartridge_type_id": w.c05.id}).status_code == 200
    db.refresh(w.a)
    lock = w.a.prep_rule
    run = {"by": 1, "why": "override", "lock": lock, "result_reading": "<0.05",
           "reader_test_id": None, "result_entered_at": w.a.result_entered_at.isoformat() + "Z",
           "step1_ratio": 10, "cartridge_type_id": w.c05.id}
    assert client.patch(w.url_a, json={"prep_total_dilution": 500}).status_code == 200
    db.refresh(w.a)
    [first] = w.a.prep_history
    assert first == {**run, "at": first["at"], "total_dilution": 300}
    assert (w.a.prep_total_dilution, w.a.prep_rule) == (500, lock)
    # The switch is an override too: the typed 1:500 run is kept, and "no rule" drops the lock.
    assert client.patch(w.url_a, json={"prep_rules_off": True}).status_code == 200
    db.refresh(w.a)
    second = w.a.prep_history[1]
    assert second == {**run, "at": second["at"], "total_dilution": 500}
    assert (w.a.prep_rules_off, w.a.prep_rule) == (True, None)
    base = {"user_id": 1, "worksheet_id": w.ws.id, "sample_id": w.a.sample_id}
    assert [a.details for a in db.query(AuditLog).filter(
        AuditLog.operation == "endo_prep_override").order_by(AuditLog.id)] == [
        {**base, "old": {"prep_total_dilution": None}, "new": {"prep_total_dilution": 500}},
        {**base, "old": {"prep_rules_off": False}, "new": {"prep_rules_off": True}},
    ]
    # Without a result, a typed change is no override: no history, no override audit.
    assert client.patch(w.url_b, json={"prep_total_dilution": 500}).status_code == 200
    db.refresh(w.b)
    assert w.b.prep_history is None
    assert db.query(AuditLog).filter(AuditLog.operation == "endo_prep_override").count() == 2


def test_switching_back_to_rules_locks_at_once_once_printed_or_read(client, db):
    w = _locks_world(client, db)
    assert client.post(f"/worksheets/{w.ws.id}/printed").status_code == 200
    assert client.patch(w.url_a, json={"prep_rules_off": True}).status_code == 200
    db.refresh(w.a)
    assert (w.a.prep_rules_off, w.a.prep_rule) == (True, None)
    w.rule.total_dilution = 400       # edited while the row was on "no rule"
    db.commit()
    assert client.patch(w.url_a, json={"prep_rules_off": False}).status_code == 200
    db.refresh(w.a)
    assert (w.a.prep_rule["locked_by"], w.a.prep_rule["rule"]["total_dilution"]) == ("switch", 400)
    # On a sheet not printed yet: a row with a result locks, a row without one follows today's rules.
    fresh = _ws(db, "Not printed")
    read, _ = _vial_item(db, fresh, 5, w.svc)
    unread, _ = _vial_item(db, fresh, 6, w.svc)
    read.result_reading, read.cartridge_type_id = "0.8", w.c05.id
    read.prep_rules_off = unread.prep_rules_off = True
    db.commit()
    for row in (read, unread):
        assert client.patch(f"/worksheets/{fresh.id}/items/{row.id}",
                            json={"prep_rules_off": False}).status_code == 200
        db.refresh(row)
    assert read.prep_rule["locked_by"] == "switch"
    assert (unread.prep_rules_off, unread.prep_rule) == (False, None)


@pytest.mark.parametrize("field, value", [
    ("prep_total_dilution", 500), ("prep_steps", [[20, 5], None, None]),
    ("cartridge_type_id", "c01"), ("prep_rules_off", True), ("prep_note", "special: 1:500"),
])
def test_a_promoted_rows_prep_is_final(client, db, field, value):
    """Spec 8 (ruling on deviation B4): a typed value is allowed until the row is promoted."""
    w = _world(client, db)
    done, _ = _row(db, w, "P-4001-S01", state="promoted")
    live, _ = _row(db, w, "P-4002-S01")
    db.commit()
    body = {field: w.c01.id if value == "c01" else value}
    before = getattr(done, field)
    r = client.patch(f"/worksheets/{w.ws.id}/items/{done.id}", json=body)
    assert (r.status_code, r.json()["detail"]) == (409, "the row is promoted; its prep is final")
    db.refresh(done)
    assert getattr(done, field) == before
    # The same change saves on a row that is not promoted.
    assert client.patch(f"/worksheets/{w.ws.id}/items/{live.id}", json=body).status_code == 200
    db.refresh(live)
    assert getattr(live, field) == body[field]


def test_a_promoted_row_still_takes_readings_and_other_fields(client, db):
    w = _world(client, db)
    done, _ = _row(db, w, "P-4001-S01", state="promoted")
    db.commit()
    url = f"/worksheets/{w.ws.id}/items/{done.id}"
    for payload in ({"result_reading": "0.8"}, {"made": True}, {"prep_water_ml": 2.5},
                    # Sent as stored: no change, so no refusal.
                    {"cartridge_type_id": w.c05.id, "prep_note": None}):
        assert client.patch(url, json=payload).status_code == 200, payload
    db.refresh(done)
    assert (done.result_reading, done.prep_water_ml, done.cartridge_type_id) == ("0.8", 2.5, w.c05.id)
    assert done.made_at is not None


# --- Task 4 fix round 1: promoted-row integrity (review S1, S3, I5) -----------

def test_a_reader_import_skips_a_promoted_row_and_still_applies_the_rest(client, db):
    """Review S1: the import never changes a promoted row's reading, record or
    cartridge. It skips the row, says why, and the other rows still apply."""
    w = _world(client, db)
    done, _ = _row(db, w, "P-4001-S01", state="promoted")
    live, _ = _row(db, w, "P-4002-S01", reading=None)
    db.commit()
    r = _import(client, w.ws, _reader_line(done, "0.8", w.c01, replace=True, test_id="T-1"),
                _reader_line(live, "0.8", w.c05, test_id="T-2"))
    assert r.status_code == 200, r.text
    assert (r.json()["applied"], r.json()["skipped"]) == (1, [
        {"item_id": done.id, "sample_id": "P-4001-S01",
         "reason": "the row is promoted; its prep is final"}])
    db.refresh(done)
    db.refresh(live)
    assert (done.result_reading, done.cartridge_type_id, done.result_reader, done.ran_at) == (
        "<0.05", w.c05.id, None, None)
    assert (live.result_reading, live.result_reader["test_id"]) == ("0.8", "T-2")


def test_clearing_a_promoted_rows_reading_keeps_its_lock(client, db):
    """Review S3: before the first print a cleared reading releases a result
    lock, but never a promoted row's: the lock is what it was promoted on."""
    w = _world(client, db)
    done, _ = _row(db, w, "P-4001-S01", state="promoted")
    done.prep_rule = lock = _lock(None, "result")
    db.commit()
    assert client.patch(f"/worksheets/{w.ws.id}/items/{done.id}",
                        json={"result_reading": None}).status_code == 200
    db.refresh(done)
    assert (done.result_reading, done.prep_rule) == (None, lock)


def test_a_reader_import_that_moves_a_read_rows_cartridge_is_an_override(client, db):
    """Review I5 (ruled an override): the run the import replaces goes to the
    row's history first, with an endo_prep_override audit, as the item PATCH does."""
    w = _locks_world(client, db)
    assert _import(client, w.ws, _reader_line(w.a, "<0.05", w.c05, test_id="T-1")).status_code == 200
    db.refresh(w.a)
    lock, entered = w.a.prep_rule, w.a.result_entered_at
    # Same reading, a new test on the 0.01 cartridge: no replace needed.
    r = _import(client, w.ws, _reader_line(w.a, "<0.05", w.c01, test_id="T-2"))
    assert (r.status_code, r.json()["applied"]) == (200, 1), r.text
    db.refresh(w.a)
    [run] = w.a.prep_history
    assert run == {"at": run["at"], "by": 1, "why": "override", "lock": lock,
                   "total_dilution": 300, "step1_ratio": 10, "cartridge_type_id": w.c05.id,
                   "result_reading": "<0.05", "reader_test_id": "T-1",
                   "result_entered_at": entered.isoformat() + "Z"}
    assert (w.a.cartridge_type_id, w.a.result_reader["test_id"]) == (w.c01.id, "T-2")
    assert [a.details for a in db.query(AuditLog).filter(
        AuditLog.operation == "endo_prep_override")] == [
        {"user_id": 1, "worksheet_id": w.ws.id, "sample_id": w.a.sample_id,
         "old": {"cartridge_type_id": w.c05.id}, "new": {"cartridge_type_id": w.c01.id}}]


# --- Task 5: Re-apply ------------------------------------------------------------

def _preview(client, ws):
    return client.get(f"/worksheets/{ws.id}/prep-rules/reapply")


def _reapply(client, ws, *items):
    return client.post(f"/worksheets/{ws.id}/prep-rules/reapply",
                       json={"item_ids": [it.id for it in items]})


def test_reapply_moves_only_the_ruled_row_and_never_a_typed_value(client, db):
    """Review Focus 2: a typed total, a "no rule" row and a ruled row on one sheet."""
    w = _locks_world(client, db)
    ruled, _ = _vial_item(db, w.ws, 3, w.svc)
    w.a.prep_total_dilution = 500     # typed: the line's total never reaches it
    w.b.prep_rules_off = True         # special prep
    db.commit()
    assert client.post(f"/worksheets/{w.ws.id}/printed").status_code == 200
    w.rule.total_dilution = 400       # the lab moves the line after the print
    db.commit()
    db.refresh(w.a)
    db.refresh(ruled)
    typed_lock, old = w.a.prep_rule, ruled.prep_rule
    r = _preview(client, w.ws)
    assert r.status_code == 200, r.text
    assert r.json() == {"candidates": [{"item_id": ruled.id, "sample_id": ruled.sample_id,
                                        "old": old, "new_rule": endo_prep_rules.snapshot(w.rule)}]}
    r = _reapply(client, w.ws, w.a, w.b, ruled)
    assert r.status_code == 200, r.text
    assert r.json() == {"results": [
        {"item_id": w.a.id, "applied": False, "reason": endo_prep_rules.REAPPLY_UNCHANGED},
        {"item_id": w.b.id, "applied": False, "reason": endo_prep_rules.REAPPLY_RULES_OFF},
        {"item_id": ruled.id, "applied": True, "reason": None}]}
    for x in (w.a, w.b, ruled):
        db.refresh(x)
    assert (w.a.prep_total_dilution, w.a.prep_rule, w.a.prep_history) == (500, typed_lock, None)
    assert (w.b.prep_rule, w.b.prep_history) == (None, None)
    assert (ruled.prep_total_dilution, ruled.prep_steps, ruled.cartridge_type_id) == (None, None, None)
    new = ruled.prep_rule
    assert (new["rule"], new["locked_by"], new["user_id"]) == (
        endo_prep_rules.snapshot(w.rule), "reapply", 1)
    [entry] = ruled.prep_history
    assert entry == {"at": entry["at"], "by": 1, "why": "reapply", "lock": old,
                     "total_dilution": 300, "step1_ratio": 10, "cartridge_type_id": None,
                     "result_reading": None, "reader_test_id": None, "result_entered_at": None}
    audit = db.query(AuditLog).filter(AuditLog.operation == "endo_prep_rule_reapplied").one()
    assert (audit.entity_id, audit.details) == (str(ruled.id), {
        "user_id": 1, "worksheet_id": w.ws.id, "sample_id": ruled.sample_id,
        "old": old, "new": new})
    assert _preview(client, w.ws).json() == {"candidates": []}


def test_reapply_refuses_each_row_that_does_not_qualify(client, db):
    w = _world(client, db)
    promoted, _ = _row(db, w, "P-4001-S01", state="promoted")
    moved, _ = _row(db, w, "P-4001-S02", reading=None)
    stray, _ = _row(db, w, "P-4002-S01", reading=None, ws=_ws(db, "Another run"))
    pep = _peptide(db)
    _anchor(db, "P-4001", pep)
    rule = _rule(db, pep, total_dilution=300)
    db.commit()
    assert client.post(f"/worksheets/{w.ws.id}/printed").status_code == 200
    late, _ = _row(db, w, "P-4001-S03", reading=None)   # added after the print: not locked
    rule.total_dilution = 400
    db.commit()
    assert [c["item_id"] for c in _preview(client, w.ws).json()["candidates"]] == [moved.id]
    assert _reapply(client, w.ws, promoted, late, stray, moved, moved).json()["results"] == [
        {"item_id": promoted.id, "applied": False, "reason": "already promoted"},
        {"item_id": late.id, "applied": False, "reason": endo_prep_rules.REAPPLY_NOT_LOCKED},
        {"item_id": stray.id, "applied": False,
         "reason": endo_prep_rules.REAPPLY_NOT_ON_WORKSHEET},
        {"item_id": moved.id, "applied": True, "reason": None},
        # Listed twice: the row already has today's line.
        {"item_id": moved.id, "applied": False, "reason": endo_prep_rules.REAPPLY_UNCHANGED},
    ]
    # A stock or completed worksheet lists nothing and moves nothing.
    rule.total_dilution = 500
    db.commit()
    for status, prep, reason in (("open", "stock", endo_prep_rules.REAPPLY_STOCK),
                                 ("completed", "2ml", endo_prep_rules.REAPPLY_COMPLETED)):
        w.ws.status, w.ws.endo_prep = status, prep
        db.commit()
        assert _preview(client, w.ws).json() == {"candidates": []}
        assert _reapply(client, w.ws, moved).json()["results"] == [
            {"item_id": moved.id, "applied": False, "reason": reason}]
    assert db.query(AuditLog).filter(AuditLog.operation == "endo_prep_rule_reapplied").count() == 1
    assert _preview(client, SimpleNamespace(id=99999)).status_code == 404
    assert _reapply(client, SimpleNamespace(id=99999)).status_code == 404
    assert client.post(f"/worksheets/{w.ws.id}/prep-rules/reapply",
                       json={"item_ids": list(range(501))}).status_code == 422


def test_reapply_never_lists_a_bac_row_even_one_locked_before_its_form_was_set(client, db):
    """Preflight F2 (A.0 item 8): a bac row is never ruled, so its locked
    line reads as none (row_rule), today's match is none, and Re-apply has
    nothing to move. Row b, locked to the same line as powder, still moves."""
    w = _locks_world(client, db)
    w.a.prep_form = "powder"
    db.commit()
    assert client.post(f"/worksheets/{w.ws.id}/printed").status_code == 200
    db.refresh(w.a)
    lock = w.a.prep_rule
    assert lock["rule"]["id"] == w.rule.id
    w.a.prep_form = "bac"
    w.rule.total_dilution = 400
    db.commit()
    assert [c["item_id"] for c in _preview(client, w.ws).json()["candidates"]] == [w.b.id]
    assert _reapply(client, w.ws, w.a).json()["results"] == [
        {"item_id": w.a.id, "applied": False, "reason": endo_prep_rules.REAPPLY_UNCHANGED}]
    db.refresh(w.a)
    assert (w.a.prep_rule, w.a.prep_history) == (lock, None)
    assert db.query(AuditLog).filter(AuditLog.operation == "endo_prep_rule_reapplied").count() == 0


def test_reapply_lists_a_new_line_even_when_its_numbers_are_the_same(client, db):
    """A.0 item 2: a row whose locked line differs from today's match by id
    is listed with every number the same, so it can take the new line."""
    w = _locks_world(client, db)
    w.b.prep_rules_off = True
    db.commit()
    assert client.post(f"/worksheets/{w.ws.id}/printed").status_code == 200
    db.refresh(w.a)
    old = w.a.prep_rule
    # A narrower band for the 10 mg row at the same 1:300: it wins today.
    narrow = _rule(db, SimpleNamespace(id=w.rule.peptide_id), min_mg=5, max_mg=15,
                   total_dilution=300)
    db.commit()
    assert _preview(client, w.ws).json() == {"candidates": [
        {"item_id": w.a.id, "sample_id": w.a.sample_id, "old": old,
         "new_rule": endo_prep_rules.snapshot(narrow)}]}
    assert _reapply(client, w.ws, w.a).json()["results"] == [
        {"item_id": w.a.id, "applied": True, "reason": None}]
    db.refresh(w.a)
    assert (w.a.prep_rule["rule"], w.a.prep_history[0]["total_dilution"]) == (
        endo_prep_rules.snapshot(narrow), 300)


# --- Task 5 review I-1: Re-apply against a concurrent promote or Re-apply ------

def _movable(client, db):
    """_world's open 2 mL worksheet with row P-4001-S01 (no reading yet),
    locked at print to a 1:300 Retatrutide line that then moves to 1:400:
    a Re-apply candidate. Returns the row, its analysis, its lock and the
    line. Holding the analysis keeps it in the session, loaded, as a request
    that read it before waiting on its lock does."""
    w = _world(client, db)
    item, analysis = _row(db, w, "P-4001-S01", reading=None)
    pep = _peptide(db)
    _anchor(db, "P-4001", pep)
    rule = _rule(db, pep, total_dilution=300)
    db.commit()
    assert client.post(f"/worksheets/{w.ws.id}/printed").status_code == 200
    rule.total_dilution = 400
    db.commit()
    db.refresh(item)
    assert [c["item_id"] for c in _preview(client, w.ws).json()["candidates"]] == [item.id]
    return SimpleNamespace(ws=w.ws, item=item, analysis=analysis, lock=item.prep_rule,
                           rule=rule)


def _commit_lands_while_waiting(db, monkeypatch, table, sql, params):
    """Spy on the session's execute. Just before the first SELECT ... FOR
    UPDATE on `table` it runs `sql` behind the session's back, as another
    request's commit lands while this one waits on the row lock (SQLite
    ignores the lock). Returns the tables of the locking reads, in order."""
    real = db.execute
    locked = []

    def spy(stmt, *args, **kwargs):
        if getattr(stmt, "_for_update_arg", None) is not None:
            name = stmt.get_final_froms()[0].name
            if name == table and table not in locked:
                real(text(sql), params)
            locked.append(name)
        return real(stmt, *args, **kwargs)

    monkeypatch.setattr(db, "execute", spy)
    return locked


def test_reapply_locks_the_analysis_then_the_item_and_leaves_a_row_promoted_meanwhile(
        client, db, monkeypatch):
    """Review I-1: a promote that commits while the Re-apply waits on the
    vial's analysis lock wins. The apply locks the live analysis, then the
    item, before it judges the row, so it reads the row as promoted."""
    m = _movable(client, db)
    locked = _commit_lands_while_waiting(
        db, monkeypatch, "lims_analyses",
        "UPDATE lims_analyses SET review_state = 'promoted' WHERE id = :id", {"id": m.analysis.id})
    assert _reapply(client, m.ws, m.item).json()["results"] == [
        {"item_id": m.item.id, "applied": False, "reason": "already promoted"}]
    assert locked == ["lims_analyses", "worksheet_items"]
    db.expire_all()
    assert (m.item.prep_rule, m.item.prep_history) == (m.lock, None)
    assert db.query(AuditLog).filter(AuditLog.operation == "endo_prep_rule_reapplied").count() == 0


def test_a_second_reapply_that_waited_on_the_first_finds_nothing_to_move(client, db, monkeypatch):
    """Review I-1 and M3: two Re-apply requests for one row. The second
    waits on the row locks while the first commits its new lock, then reads
    the row as the first left it: nothing to re-apply, no second history
    entry and no second audit row."""
    m = _movable(client, db)
    first = {**m.lock, "rule": endo_prep_rules.snapshot(m.rule), "locked_by": "reapply"}
    _commit_lands_while_waiting(
        db, monkeypatch, "worksheet_items",
        "UPDATE worksheet_items SET prep_rule = :lock WHERE id = :id",
        {"lock": json.dumps(first), "id": m.item.id})
    assert _reapply(client, m.ws, m.item).json()["results"] == [
        {"item_id": m.item.id, "applied": False, "reason": endo_prep_rules.REAPPLY_UNCHANGED}]
    db.expire_all()
    assert (m.item.prep_rule, m.item.prep_history) == (first, None)
    assert db.query(AuditLog).filter(AuditLog.operation == "endo_prep_rule_reapplied").count() == 0
