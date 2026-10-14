"""Endo slice 5 on the worksheet rows (spec
docs/superpowers/specs/2026-10-14-endo-slice5-method-rules-design.md, sections
4 to 8): the row columns, effective values in the server's floor and promote
checks, the lock events, release, override history and Re-apply.
In-memory SQLite + dependency overrides, with test_endo_v2_worksheets.py's
and test_endo_worksheet_promote.py's helpers."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import endo_prep_rules
from auth import get_current_user
from database import Base, get_db
from main import app
from models import AuditLog, EndoPrepRule, LimsAnalysis, LimsSample
from tests.test_endo_v2_worksheets import _count_sql, _row_world, _service, _vial_item, _ws
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
