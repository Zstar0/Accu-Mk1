"""The seed for the lab's own HPLC prep rule lines (plan 2026-11-12-hplc-prep-rules,
Task 7): dry run by default, the source values verbatim, safe to run twice, a hand-made
line left alone, and a missing peptide or instrument reported while the rest still seed.
In-memory SQLite (conftest db_session); the tests make their own peptides and instrument."""
import pytest
from sqlalchemy import select

from models import AuditLog, HplcPrepRule, Instrument
from scripts.seed_hplc_prep_rules import seed
from tests.test_spec_rules import _mk_peptide


@pytest.fixture
def db(db_session):
    # Found by abbreviation (NAD+, GHK-Cu) and by name (Ipamorelin, Retatrutide), case aside.
    peps = {
        "NAD+": _mk_peptide(db_session, "NAD+", name="Nicotinamide adenine dinucleotide"),
        "GHK-Cu": _mk_peptide(db_session, "ghk-cu", name="Copper peptide"),
        "Ipamorelin": _mk_peptide(db_session, "IPA", name="Ipamorelin"),
        "Retatrutide": _mk_peptide(db_session, "RETA", name="retatrutide"),
    }
    db_session.add(Instrument(name="HPLC 1290B", active=True))
    db_session.commit()
    db_session.peps = peps
    return db_session


def _lines(db):
    return {r.peptide_id: r for r in db.execute(select(HplcPrepRule)).scalars()}


def test_dry_run_writes_nothing(db):
    out = seed(db, apply=False)
    assert sorted(out["inserted"]) == ["GHK-Cu", "Ipamorelin", "NAD+", "Retatrutide"]
    db.rollback()
    assert _lines(db) == {}
    assert db.execute(select(AuditLog)).first() is None


def test_apply_inserts_the_lines_with_the_source_values(db):
    out = seed(db, apply=True)
    assert out == {"inserted": ["NAD+", "GHK-Cu", "Ipamorelin", "Retatrutide"],
                   "skipped_existing": [], "not_found": []}
    lines = _lines(db)
    p = db.peps
    inst = db.execute(select(Instrument)).scalar_one()
    want = {
        "NAD+": (150, None, None, None, None),
        "GHK-Cu": (125, 350, 2, "Water + 0.1% TFA", None),
        "Ipamorelin": (150, 175, 1, None, None),
        "Retatrutide": (None, None, None, None, inst.id),
    }
    for name, values in want.items():
        r = lines[p[name].id]
        assert (r.target_conc_ug_ml, r.blend_target_conc_ug_ml, r.lead_priority, r.diluent,
                r.default_instrument_id) == values, name
        assert (r.min_mg, r.max_mg, r.floor_ug_ml, r.lead_component_id) == (None,) * 4
        assert r.status == "validated" and r.active and r.updated_by_id is None
        assert "DEFAULTS" in r.note and "2026-11-12" in r.note
    assert [lines[p[n].id].sort_order for n in want] == [0, 1, 2, 3]
    audits = db.execute(select(AuditLog)).scalars().all()
    assert len(audits) == 4
    assert {a.operation for a in audits} == {"hplc_prep_rule_created"}
    assert {a.entity_id for a in audits} == {str(r.id) for r in lines.values()}
    assert all(a.details["source"] == "seed_hplc_prep_rules" and a.details["user_id"] is None
               and a.details["old"] is None for a in audits)


def test_a_second_apply_inserts_nothing(db):
    seed(db, apply=True)
    out = seed(db, apply=True)
    assert out["inserted"] == [] and out["not_found"] == []
    assert sorted(out["skipped_existing"]) == ["GHK-Cu", "Ipamorelin", "NAD+", "Retatrutide"]
    assert len(_lines(db)) == 4


def test_a_peptide_with_a_hand_made_line_is_left_alone(db):
    ghk = db.peps["GHK-Cu"]
    db.add(HplcPrepRule(peptide_id=ghk.id, target_conc_ug_ml=99, active=False, sort_order=7))
    db.commit()
    out = seed(db, apply=True)
    assert out["skipped_existing"] == ["GHK-Cu"]
    assert "GHK-Cu" not in out["inserted"]
    ghk_lines = [r for r in db.execute(select(HplcPrepRule)).scalars() if r.peptide_id == ghk.id]
    assert [(r.target_conc_ug_ml, r.active) for r in ghk_lines] == [(99, False)]
    # New lines go after the existing maximum.
    assert sorted(r.sort_order for r in _lines(db).values() if r.peptide_id != ghk.id) == [8, 9, 10]


def test_a_missing_peptide_is_reported_and_the_rest_still_seed(db):
    db.delete(db.peps["NAD+"])
    db.delete(db.execute(select(Instrument)).scalar_one())
    db.commit()
    out = seed(db, apply=True)
    assert out["inserted"] == ["GHK-Cu", "Ipamorelin", "Retatrutide"]
    assert any(n.startswith("NAD+") for n in out["not_found"])
    assert any(n.startswith("HPLC 1290b") for n in out["not_found"])
    reta = _lines(db)[db.peps["Retatrutide"].id]
    assert reta.default_instrument_id is None


def test_an_inactive_instrument_counts_as_missing(db):
    db.execute(select(Instrument)).scalar_one().active = False
    db.commit()
    out = seed(db, apply=False)
    assert "Retatrutide" in out["inserted"]
    assert any(n.startswith("HPLC 1290b") and "no active instrument" in n
               and "would go in without an instrument" in n for n in out["not_found"])
    out = seed(db, apply=True)
    assert any("goes in without an instrument" in n for n in out["not_found"])
    assert _lines(db)[db.peps["Retatrutide"].id].default_instrument_id is None


def test_the_dry_run_says_the_values_it_would_insert_and_what_it_skips(db):
    ghk = db.peps["GHK-Cu"]
    db.add_all([HplcPrepRule(peptide_id=ghk.id, max_mg=10, sort_order=0),
                HplcPrepRule(peptide_id=ghk.id, min_mg=10, sort_order=1)])
    db.commit()
    said = []
    seed(db, apply=False, say=said.append)
    assert said == [
        "NAD+: would insert target 150, blend target standard, lead priority none, "
        "diluent standard, instrument none",
        "GHK-Cu: would skip, the peptide already has 2 line(s)",
        "Ipamorelin: would insert target 150, blend target 175, lead priority 1, "
        "diluent standard, instrument none",
        "Retatrutide: would insert target standard, blend target standard, "
        "lead priority none, diluent standard, instrument HPLC 1290B",
    ]


def test_main_dry_run_prints_the_details_as_intention_and_writes_nothing(
        db, monkeypatch, capsys):
    import database
    from scripts import seed_hplc_prep_rules as module

    ghk_id = db.peps["GHK-Cu"].id   # main() closes the session it is handed
    db.add(HplcPrepRule(peptide_id=ghk_id, sort_order=0))
    db.execute(select(Instrument)).scalar_one().active = False
    db.commit()
    monkeypatch.setattr(database, "SessionLocal", lambda: db)
    monkeypatch.setattr(module.sys, "argv", ["seed_hplc_prep_rules.py"])
    module.main()
    out = capsys.readouterr().out.splitlines()
    assert "NAD+: would insert target 150, blend target standard, lead priority none, " \
           "diluent standard, instrument none" in out
    assert "GHK-Cu: would skip, the peptide already has 1 line(s)" in out
    assert any(line.startswith("Not found or would not insert: HPLC 1290b")
               and "would go in without an instrument" in line for line in out)
    assert any(line.startswith("Would skip, the peptide already has a line") for line in out)
    assert out[-1] == "Dry run: nothing was written. Run again with --apply to write."
    assert {r.peptide_id for r in db.execute(select(HplcPrepRule)).scalars()} == {ghk_id}


def test_the_save_check_warnings_are_said(db):
    # Another peptide's active line already ranks 1, as Ipamorelin's will.
    other = _mk_peptide(db, "TESA", name="Tesamorelin")
    db.add(HplcPrepRule(peptide_id=other.id, lead_priority=1, sort_order=0))
    db.commit()
    said = []
    seed(db, apply=True, say=said.append)
    assert any(line.startswith("Ipamorelin: warning: lead_priority 1 is also used by rule")
               for line in said)


def test_a_refused_line_gets_no_instrument_note(db, monkeypatch):
    from scripts import seed_hplc_prep_rules as module

    db.execute(select(Instrument)).scalar_one().active = False
    db.commit()
    monkeypatch.setattr(module, "LINES", [("Retatrutide", {"diluent": "Saline"},
                                           module.INSTRUMENT)])
    out = seed(db, apply=False)
    assert out["inserted"] == []
    assert out["not_found"] == [
        "Retatrutide (would be refused by the save checks: diluent 'Saline' is not one of: "
        "Water, Water + 0.1% TFA)"]


def test_an_ambiguous_peptide_is_reported_not_guessed(db):
    # No abbreviation is "Retatrutide", and two names are, case aside.
    _mk_peptide(db, "RETA2", name="RETATRUTIDE")
    db.commit()
    out = seed(db, apply=True)
    assert "Retatrutide" not in out["inserted"]
    assert any(n.startswith("Retatrutide") and "more than one match" in n
               for n in out["not_found"])
