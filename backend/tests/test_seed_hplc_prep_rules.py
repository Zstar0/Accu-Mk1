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


def test_an_ambiguous_peptide_is_reported_not_guessed(db):
    # No abbreviation is "Retatrutide", and two names are, case aside.
    _mk_peptide(db, "RETA2", name="RETATRUTIDE")
    db.commit()
    out = seed(db, apply=True)
    assert "Retatrutide" not in out["inserted"]
    assert any(n.startswith("Retatrutide") and "more than one match" in n
               for n in out["not_found"])
