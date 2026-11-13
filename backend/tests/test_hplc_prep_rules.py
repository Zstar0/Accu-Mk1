"""HPLC prep rules, Task 2 of plan 2026-11-12-hplc-prep-rules: the table, its
boot statement, the matcher and check_rule. The shared fixture
tests/fixtures/hplc_prep_rule_cases.json pins the matcher functions to their
TypeScript mirror (Task 4). In-memory SQLite (`db_session`, tests/conftest.py)."""
import json
import math
import re
from pathlib import Path

import pytest
from sqlalchemy import inspect

import hplc_prep_rules as hpr
from catalog.method_run_params import HPLC_RUN_PARAM_DEFAULTS
from endo_prep_rules import OVERLAP_RULE
from hplc_prep_rules import (DEFAULT_DILUENT, HPLC_DILUENTS, check_rule, load_rules,
                             row_floor, snapshot)
from models import HplcPrepRule, Instrument, blend_components
from tests.test_hplc_native_schema import _captured
from tests.test_spec_rules import _mk_peptide

FIXTURE = Path(__file__).parent / "fixtures" / "hplc_prep_rule_cases.json"
DATA = json.loads(FIXTURE.read_text(encoding="utf-8"))

# Every column of the table, as the brief's Interfaces block lists them.
COLUMNS = {"id", "peptide_id", "min_mg", "max_mg", "target_conc_ug_ml",
           "blend_target_conc_ug_ml", "lead_component_id", "lead_priority", "floor_ug_ml",
           "diluent", "default_instrument_id", "status", "note", "active", "sort_order",
           "created_at", "updated_at", "updated_by_id"}


# --- The shared fixture ------------------------------------------------------

def _run_case(case):
    rules = DATA["rule_sets"][case["rules"]]
    query = dict(case["query"])
    if "row_rule_id" in query:
        rid = query.pop("row_rule_id")
        query["row_rule"] = None if rid is None else next(r for r in rules if r["id"] == rid)
    if case["fn"] == "row_floor":
        return row_floor(query.pop("row_rule"), **query)
    result = getattr(hpr, case["fn"])(rules, **query)
    if case["fn"] == "match_rule":
        return result["id"] if result else None
    return result


@pytest.mark.parametrize("case", DATA["cases"], ids=[c["name"] for c in DATA["cases"]])
def test_every_fixture_case_gives_its_answer(case):
    assert _run_case(case) == case["expect"]


def test_the_fixture_covers_every_function():
    assert {c["fn"] for c in DATA["cases"]} == {
        "match_rule", "component_target", "pick_lead", "row_diluent", "row_instrument",
        "row_floor"}


def test_match_rule_returns_the_snapshot_itself():
    rules = DATA["rule_sets"]["main"]
    assert hpr.match_rule(rules, peptide_id=4, weight_mg=5) is rules[3]


def test_fixture_lines_are_whole_snapshots():
    # Exactly the snapshot keys, so the TypeScript side reads the fixture
    # lines as the rules API will serve them.
    for line in DATA["rule_sets"]["main"]:
        assert snapshot(HplcPrepRule(**line)) == line


def test_pick_lead_reads_a_component_with_no_declared_mg_key_as_no_weight():
    # A component built from a partial object: never the heaviest, never a KeyError.
    assert hpr.pick_lead([], [{"peptide_id": 5}, {"peptide_id": 6, "declared_mg": 4}],
                         row_rule=None) == {"peptide_id": 6, "why": "heaviest"}
    assert hpr.pick_lead([], [{"peptide_id": 5}, {"peptide_id": 6}],
                         row_rule=None) == {"peptide_id": 5, "why": "first"}


def test_constants():
    assert HPLC_DILUENTS == ("Water", "Water + 0.1% TFA")
    assert DEFAULT_DILUENT == "Water"


# --- Table, snapshot and load_rules ------------------------------------------

def test_a_new_rule_takes_the_table_defaults(db_session):
    pep = _mk_peptide(db_session, "RETA")
    rule = HplcPrepRule(peptide_id=pep.id)
    db_session.add(rule)
    db_session.flush()
    assert snapshot(rule) == {
        "id": rule.id, "peptide_id": pep.id, "min_mg": None, "max_mg": None,
        "target_conc_ug_ml": None, "blend_target_conc_ug_ml": None, "lead_component_id": None,
        "lead_priority": None, "floor_ug_ml": None, "diluent": None,
        "default_instrument_id": None, "status": "trial", "note": None, "active": True,
        "sort_order": 0}
    assert rule.created_at is not None and rule.updated_by_id is None
    json.dumps(snapshot(rule))


def test_snapshot_keys_are_the_table_minus_its_bookkeeping():
    table = {c.name for c in HplcPrepRule.__table__.columns}
    assert table == COLUMNS
    assert set(snapshot(HplcPrepRule())) == table - {"created_at", "updated_at", "updated_by_id"}


def test_load_rules_lists_by_sort_order_then_id(db_session):
    pep = _mk_peptide(db_session, "RETA")

    def add(sort_order, active=True):
        rule = HplcPrepRule(peptide_id=pep.id, sort_order=sort_order, active=active)
        db_session.add(rule)
        db_session.flush()
        return rule.id

    second = add(2)
    first = add(1)
    tie_low_id = add(3)
    tie_high_id = add(3)
    retired = add(0, active=False)
    db_session.commit()

    assert [r["id"] for r in load_rules(db_session)] == [first, second, tie_low_id, tie_high_id]
    assert [r["id"] for r in load_rules(db_session, active_only=False)] == [
        retired, first, second, tie_low_id, tie_high_id]
    assert load_rules(db_session)[0] == snapshot(db_session.get(HplcPrepRule, first))


def test_boot_migration_creates_the_table_above_the_pinned_last_statement():
    stmts = _captured()
    create = [s for s in stmts if "CREATE TABLE IF NOT EXISTS hplc_prep_rules" in s]
    assert len(create) == 1
    for column in COLUMNS:
        assert re.search(rf"\b{column}\b", create[0]), column
    for ref in ("REFERENCES peptides(id)", "REFERENCES instruments(id)",
                "REFERENCES users(id) ON DELETE SET NULL"):
        assert ref in create[0], ref
    assert create[0].count("REFERENCES peptides(id)") == 2
    assert stmts.index(create[0]) < len(stmts) - 1
    assert stmts[-1] == "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS retest_of_sample_id TEXT"


def test_the_post_deploy_check_wants_every_column_as_the_create_makes_it():
    from scripts.check_hplc_columns import RULES_EXPECTED, evaluate

    create = next(s for s in _captured() if "CREATE TABLE IF NOT EXISTS hplc_prep_rules" in s)
    not_null = {line.split()[0] for line in create.splitlines()[1:]
                if "NOT NULL" in line or "PRIMARY KEY" in line}
    assert set(RULES_EXPECTED) == COLUMNS
    assert {name for name, want in RULES_EXPECTED.items() if want == "NO"} == not_null
    found = {name: ("integer", want) for name, want in RULES_EXPECTED.items()}
    assert evaluate(found, RULES_EXPECTED)[1] == 0
    assert evaluate({k: v for k, v in found.items() if k != "diluent"}, RULES_EXPECTED)[1] == 1
    assert evaluate({}, RULES_EXPECTED)[1] == len(COLUMNS)


def test_the_post_deploy_check_takes_either_nullability_for_the_two_timestamps(db_session):
    # create_all (a fresh database) makes created_at and updated_at NOT NULL, the boot
    # CREATE TABLE leaves them nullable: both are a working table. Nothing else bends.
    from scripts.check_hplc_columns import RULES_EITHER_NULLABLE, RULES_EXPECTED, evaluate

    assert set(RULES_EITHER_NULLABLE) == {"created_at", "updated_at"}
    insp = inspect(db_session.get_bind())
    made = {c["name"]: ("timestamp", "YES" if c["nullable"] else "NO")
            for c in insp.get_columns("hplc_prep_rules")}
    assert made["created_at"][1] == "NO"
    assert evaluate(made, RULES_EXPECTED, RULES_EITHER_NULLABLE)[1] == 0
    assert evaluate(made, RULES_EXPECTED)[1] == 2
    found = {name: ("integer", want) for name, want in RULES_EXPECTED.items()}
    assert evaluate({**found, "note": ("text", "NO")}, RULES_EXPECTED,
                    RULES_EITHER_NULLABLE)[1] == 1


def test_the_table_has_every_column_and_its_foreign_keys(db_session):
    insp = inspect(db_session.get_bind())
    assert {c["name"] for c in insp.get_columns("hplc_prep_rules")} == COLUMNS
    fks = {(fk["constrained_columns"][0], fk["referred_table"])
           for fk in insp.get_foreign_keys("hplc_prep_rules")}
    assert fks == {("peptide_id", "peptides"), ("lead_component_id", "peptides"),
                   ("default_instrument_id", "instruments"), ("updated_by_id", "users")}


# --- check_rule ---------------------------------------------------------------

def _values(**over) -> dict:
    """Every snapshot field of a line as it will be stored, all-default unless given."""
    base = {key: None for key in hpr._SNAPSHOT_KEYS}
    base.update(status="trial", active=True, sort_order=0)
    base.update(over)
    return base


def _check(db, sent=None, rule_id=None, **over):
    return check_rule(db, _values(**over), over.keys() if sent is None else sent,
                      rule_id=rule_id)


@pytest.fixture
def pep(db_session):
    return _mk_peptide(db_session, "RETA")


@pytest.fixture
def blend(db_session):
    """A blend of two components, as blend_components holds it."""
    bpc = _mk_peptide(db_session, "BPC")
    ghk = _mk_peptide(db_session, "GHK")
    from models import Peptide
    mix = Peptide(name="GLOW", abbreviation="GLOW", is_blend=True)
    db_session.add(mix)
    db_session.flush()
    db_session.execute(blend_components.insert(), [
        {"blend_id": mix.id, "component_id": bpc.id, "display_order": 0, "vial_number": 1},
        {"blend_id": mix.id, "component_id": ghk.id, "display_order": 1, "vial_number": 1}])
    db_session.flush()
    return mix, bpc, ghk


def _instrument(db, name, active):
    inst = Instrument(name=name, active=active)
    db.add(inst)
    db.flush()
    return inst


def test_a_valid_line_saves_with_no_warnings(db_session, pep):
    inst = _instrument(db_session, "1290B", True)
    assert _check(db_session, peptide_id=pep.id, min_mg=5, max_mg=10, target_conc_ug_ml=150,
                  blend_target_conc_ug_ml=175, lead_priority=1,
                  diluent="Water + 0.1% TFA", default_instrument_id=inst.id) == []


@pytest.mark.parametrize("field", ["peptide_id", "status", "active"])
def test_a_required_field_sent_as_null_is_refused(db_session, pep, field):
    over = {"peptide_id": pep.id, field: None}
    with pytest.raises(ValueError, match=f"{field} cannot be empty"):
        _check(db_session, sent={field}, **over)


@pytest.mark.parametrize("field", ["min_mg", "max_mg", "target_conc_ug_ml",
                                   "blend_target_conc_ug_ml", "lead_priority", "floor_ug_ml"])
@pytest.mark.parametrize("raw", [math.inf, -math.inf, math.nan])
def test_a_number_that_is_not_finite_is_refused(db_session, pep, field, raw):
    with pytest.raises(ValueError, match=f"{field} must be a finite number"):
        _check(db_session, peptide_id=pep.id, **{field: raw})


def test_an_unknown_peptide_is_refused(db_session):
    with pytest.raises(ValueError, match="peptide 99999 not found"):
        _check(db_session, peptide_id=99999)


@pytest.mark.parametrize("field", ["target_conc_ug_ml", "blend_target_conc_ug_ml",
                                   "floor_ug_ml"])
@pytest.mark.parametrize("raw", [0, -5])
def test_a_concentration_not_above_zero_is_refused(db_session, pep, field, raw):
    with pytest.raises(ValueError, match=f"{field} must be greater than zero"):
        _check(db_session, peptide_id=pep.id, **{field: raw})


@pytest.mark.parametrize("lo, hi", [(10, 5), (5, 5)])
def test_a_band_whose_bottom_is_not_below_its_top_is_refused(db_session, pep, lo, hi):
    with pytest.raises(ValueError, match="min_mg must be below max_mg"):
        _check(db_session, peptide_id=pep.id, min_mg=lo, max_mg=hi)


@pytest.mark.parametrize("field", ["min_mg", "max_mg"])
def test_a_negative_band_bound_is_refused(db_session, pep, field):
    with pytest.raises(ValueError, match=f"{field} must not be negative"):
        _check(db_session, peptide_id=pep.id, **{field: -1})
    assert _check(db_session, peptide_id=pep.id, **{field: 0}) == []


@pytest.mark.parametrize("raw", [0, -1, 1.5, True, 1000, 2147483648, 10 ** 400],
                         ids=["0", "-1", "1.5", "True", "1000", "2^31", "10^400"])
def test_a_lead_priority_that_is_not_a_whole_number_from_1_to_999_is_refused(
        db_session, pep, raw):
    with pytest.raises(ValueError, match="lead_priority must be a whole number from 1 to 999"):
        _check(db_session, peptide_id=pep.id, lead_priority=raw)


def test_a_lead_priority_of_999_saves(db_session, pep):
    assert _check(db_session, peptide_id=pep.id, lead_priority=999) == []


def test_a_whole_float_lead_priority_saves(db_session, pep):
    assert _check(db_session, peptide_id=pep.id, lead_priority=2.0) == []


def test_a_diluent_outside_the_list_is_refused_and_the_message_lists_them(db_session, pep):
    with pytest.raises(ValueError) as err:
        _check(db_session, peptide_id=pep.id, diluent="Saline")
    assert "diluent 'Saline' is not one of: Water, Water + 0.1% TFA" == str(err.value)


def test_an_unknown_or_inactive_instrument_is_refused(db_session, pep):
    with pytest.raises(ValueError, match="instrument 99999 is not an active instrument"):
        _check(db_session, peptide_id=pep.id, default_instrument_id=99999)
    retired = _instrument(db_session, "1260 retired", False)
    with pytest.raises(ValueError, match=f"instrument {retired.id} is not an active instrument"):
        _check(db_session, peptide_id=pep.id, default_instrument_id=retired.id)


def test_a_lead_on_a_line_that_is_not_a_blend_is_refused(db_session, pep, blend):
    _, bpc, _ = blend
    with pytest.raises(ValueError, match="only a blend line names a lead"):
        _check(db_session, peptide_id=pep.id, lead_component_id=bpc.id)


def test_a_lead_that_is_not_one_of_the_blends_components_is_refused(db_session, pep, blend):
    mix, bpc, _ = blend
    with pytest.raises(ValueError, match=f"peptide {pep.id} is not a component of blend "
                                         f"{mix.id}"):
        _check(db_session, peptide_id=mix.id, lead_component_id=pep.id)
    assert _check(db_session, peptide_id=mix.id, lead_component_id=bpc.id,
                  diluent="Water + 0.1% TFA", target_conc_ug_ml=250) == []


@pytest.mark.parametrize("field, raw", [("blend_target_conc_ug_ml", 350), ("lead_priority", 1)])
def test_a_component_field_on_a_blend_line_is_refused(db_session, blend, field, raw):
    mix, _, _ = blend
    with pytest.raises(ValueError, match="a blend is never a component of another blend"):
        _check(db_session, peptide_id=mix.id, **{field: raw})


def test_a_floor_on_a_line_that_is_not_a_blend_is_refused(db_session, pep, blend):
    _, bpc, _ = blend
    for solo in (pep, bpc):   # a solo peptide, and a blend component
        with pytest.raises(ValueError, match="only a blend line sets a floor"):
            _check(db_session, peptide_id=solo.id, floor_ug_ml=40)
    # A line moved onto a solo peptide with its floor is refused too.
    with pytest.raises(ValueError, match="only a blend line sets a floor"):
        _check(db_session, sent={"peptide_id"}, peptide_id=pep.id, floor_ug_ml=40)


@pytest.mark.parametrize("over", [
    {"floor_ug_ml": 200},                              # the method target, 200
    {"target_conc_ug_ml": 50},                         # the method floor, 60
    {"target_conc_ug_ml": 100, "floor_ug_ml": 100},
    {"target_conc_ug_ml": 100, "floor_ug_ml": 150},
])
def test_a_floor_at_or_above_the_target_is_refused(db_session, blend, over):
    mix, _, _ = blend
    with pytest.raises(ValueError, match="floor .* must be below the target"):
        _check(db_session, peptide_id=mix.id, **over)


def test_the_floor_check_falls_back_to_the_method_defaults(db_session, blend):
    mix, _, _ = blend
    assert HPLC_RUN_PARAM_DEFAULTS["default_target_ug_ml"] == 200
    assert HPLC_RUN_PARAM_DEFAULTS["floor_ug_ml"] == 60
    assert _check(db_session, peptide_id=mix.id, floor_ug_ml=199) == []
    assert _check(db_session, peptide_id=mix.id, target_conc_ug_ml=61) == []


def test_the_floor_check_is_for_blend_lines_only(db_session, pep):
    # A solo line has no floor of its own: a target under the method floor saves.
    assert _check(db_session, peptide_id=pep.id, target_conc_ug_ml=50) == []


def test_a_line_an_old_value_no_longer_fits_can_still_be_deactivated(db_session, pep):
    # The line's instrument was retired after it was saved; a request that
    # sends only active (or only note) runs no instrument check.
    retired = _instrument(db_session, "1260 retired", False)
    assert _check(db_session, sent={"active"}, peptide_id=pep.id,
                  default_instrument_id=retired.id, active=False) == []
    assert _check(db_session, sent={"note"}, peptide_id=pep.id,
                  default_instrument_id=retired.id, note="moved") == []
    with pytest.raises(ValueError, match="not an active instrument"):
        _check(db_session, sent={"default_instrument_id"}, peptide_id=pep.id,
               default_instrument_id=retired.id)


def _stored(db, **over) -> HplcPrepRule:
    rule = HplcPrepRule(**over)
    db.add(rule)
    db.flush()
    return rule


def test_an_overlapping_band_saves_with_endos_overlap_warning(db_session, pep):
    other = _stored(db_session, peptide_id=pep.id, max_mg=10)
    assert _check(db_session, peptide_id=pep.id, min_mg=5, max_mg=20) == [
        f"overlaps rule {other.id} (up to 10 mg) {OVERLAP_RULE}"]
    # A line never warns against itself, an inactive line never warns, and a
    # band that only touches another (10 is in one, not both) does not overlap.
    assert _check(db_session, rule_id=other.id, peptide_id=pep.id, max_mg=15) == []
    assert _check(db_session, peptide_id=pep.id, min_mg=5, max_mg=20, active=False) == []
    assert _check(db_session, peptide_id=pep.id, min_mg=10) == []


def test_a_lead_priority_another_active_line_uses_saves_with_a_warning(db_session, pep):
    ipa = _mk_peptide(db_session, "IPA")
    other = _stored(db_session, peptide_id=ipa.id, lead_priority=1)
    _stored(db_session, peptide_id=ipa.id, lead_priority=2, active=False)
    assert _check(db_session, peptide_id=pep.id, lead_priority=1) == [
        f"lead_priority 1 is also used by rule {other.id}; ties go to the component "
        f"listed first"]
    assert _check(db_session, rule_id=other.id, peptide_id=ipa.id, lead_priority=1) == []
    assert _check(db_session, peptide_id=pep.id, lead_priority=2) == []
    assert _check(db_session, peptide_id=pep.id, lead_priority=1, active=False) == []


def test_two_bands_of_one_peptide_may_share_a_lead_priority(db_session, pep):
    _stored(db_session, peptide_id=pep.id, max_mg=10, lead_priority=1)
    assert _check(db_session, peptide_id=pep.id, min_mg=10, lead_priority=1) == []
