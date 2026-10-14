"""Endo slice 5, Task 1: the prep rule table, its boot statement and the
matcher (spec docs/superpowers/specs/2026-10-14-endo-slice5-method-rules-design.md
sections 3, 4 and 11). The shared fixture tests/fixtures/endo_prep_rule_cases.json
pins match_rule to the TypeScript matchRule (Task 6). In-memory SQLite
(`db_session`, tests/conftest.py)."""
import json
import re
from pathlib import Path

import pytest

import worksheets_endo
from endo_prep_rules import LOCK_EVENTS, STEP1_RATIO, load_rules, match_rule, snapshot
from models import EndoPrepRule
from tests.test_hplc_native_schema import _captured
from tests.test_spec_rules import _mk_peptide

FIXTURE = Path(__file__).parent / "fixtures" / "endo_prep_rule_cases.json"
DATA = json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", DATA["cases"], ids=[c["name"] for c in DATA["cases"]])
def test_match_rule_gives_the_fixture_answer(case):
    rule = match_rule(DATA["rule_sets"][case["rules"]], **case["query"])
    assert (rule["id"] if rule else None) == case["expect"]


def test_fixture_lines_are_whole_snapshots():
    # Exactly the snapshot keys, so the TypeScript side reads the fixture
    # lines as GET /endo-prep-rules serves them.
    for line in DATA["rule_sets"]["main"]:
        assert snapshot(EndoPrepRule(**line)) == line


def test_constants_match_the_contract_and_the_step1_floor_check():
    assert STEP1_RATIO == worksheets_endo.STEP1_STANDARD_RATIO == 10
    assert LOCK_EVENTS == ("print", "result", "complete", "reapply", "switch")


def test_a_new_rule_takes_the_table_defaults(db_session):
    pep = _mk_peptide(db_session, "RETA")
    rule = EndoPrepRule(peptide_id=pep.id)
    db_session.add(rule)
    db_session.flush()
    assert snapshot(rule) == {
        "id": rule.id, "peptide_id": pep.id, "min_mg": None, "max_mg": None,
        "total_dilution": None, "step1_ratio": None, "cartridge_type_id": None,
        "status": "trial", "note": None, "sort_order": 0, "active": True}
    assert rule.created_at is not None and rule.updated_by_id is None
    json.dumps(snapshot(rule))   # a lock stores it in a JSON column


def test_load_rules_lists_by_sort_order_then_id(db_session):
    pep = _mk_peptide(db_session, "RETA")

    def add(sort_order, active=True):
        rule = EndoPrepRule(peptide_id=pep.id, sort_order=sort_order, active=active,
                            total_dilution=300.0)
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
    assert load_rules(db_session)[0] == snapshot(db_session.get(EndoPrepRule, first))


def test_boot_migration_creates_the_table_above_the_pinned_last_statement():
    stmts = _captured()
    create = [s for s in stmts if "CREATE TABLE IF NOT EXISTS endo_prep_rules" in s]
    assert len(create) == 1
    # Every model column is in the statement, so the two cannot drift apart unseen.
    for column in EndoPrepRule.__table__.columns:
        assert re.search(rf"\b{column.name}\b", create[0]), column.name
    assert stmts.index(create[0]) < len(stmts) - 1
    assert stmts[-1] == "ALTER TABLE lims_samples ADD COLUMN IF NOT EXISTS retest_of_sample_id TEXT"
