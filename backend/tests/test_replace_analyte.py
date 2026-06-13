"""Replace-analyte tests (Phase 2 — wrong-variant correction).

peptide_has_full_service_set gates the offer-only picker; replace_analyte_slot
re-mirrors a slot's per-substance vial rows from the old peptide to the new one
(pristine -> delete + reseed, worked -> reject on confirm, verified -> blocked).
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.service import (
    apply_transition,
    create_analysis,
    peptide_has_full_service_set,
)
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample, Peptide


@pytest.fixture
def db_mem():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _peptide(db, name, abbreviation="ABBR"):
    p = Peptide(name=name, abbreviation=abbreviation)
    db.add(p)
    db.flush()
    return p


def _svc(db, *, keyword, peptide_id=None, title=None):
    s = AnalysisService(title=title or keyword, keyword=keyword, peptide_id=peptide_id)
    db.add(s)
    db.flush()
    return s


def test_full_service_set_true_when_id_pur_qty_present(db_mem):
    p = _peptide(db_mem, "TB500 (Thymosin Beta 4)")
    _svc(db_mem, keyword="ID_TB500BETA4", peptide_id=p.id)
    _svc(db_mem, keyword="PUR_TB500BETA4", peptide_id=p.id)
    _svc(db_mem, keyword="QTY_TB500BETA4", peptide_id=p.id)
    db_mem.commit()

    assert peptide_has_full_service_set(db_mem, peptide_id=p.id) is True


def test_full_service_set_false_when_incomplete(db_mem):
    p = _peptide(db_mem, "Obscure Variant")
    _svc(db_mem, keyword="ID_OBSCURE", peptide_id=p.id)  # ID only, no PUR/QTY
    db_mem.commit()

    assert peptide_has_full_service_set(db_mem, peptide_id=p.id) is False


# ─── replace_analyte_slot orchestrator ──────────────────────────────────────


@pytest.fixture
def blend_two_vials(db_mem):
    """Parent blend + two non-xtra vials, each carrying the OLD peptide's
    per-substance rows (PUR_/QTY_/ID_). new peptide has a full service set.
    Returns (db, parent, sub_pristine, sub_worked, old_pep, new_pep)."""
    old_pep = _peptide(db_mem, "TP500", "TP500")
    new_pep = _peptide(db_mem, "TB500 (Thymosin Beta 4)", "TB500B4")
    old = {
        "ID": _svc(db_mem, keyword="ID_TP500", peptide_id=old_pep.id),
        "PUR": _svc(db_mem, keyword="PUR_TP500", peptide_id=old_pep.id),
        "QTY": _svc(db_mem, keyword="QTY_TP500", peptide_id=old_pep.id),
    }
    for cat in ("ID", "PUR", "QTY"):
        _svc(db_mem, keyword=f"{cat}_TB500B4", peptide_id=new_pep.id)

    parent = LimsSample(sample_id="PB-REPL-1", external_lims_uid="uid-repl-1")
    db_mem.add(parent)
    db_mem.flush()
    sub_pristine = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="mk1://repl-1-S01",
        sample_id="PB-REPL-1-S01", vial_sequence=1, assignment_role="hplc",
    )
    sub_worked = LimsSubSample(
        parent_sample_pk=parent.id, external_lims_uid="mk1://repl-1-S02",
        sample_id="PB-REPL-1-S02", vial_sequence=2, assignment_role="hplc",
    )
    db_mem.add_all([sub_pristine, sub_worked])
    db_mem.commit()

    def row(sub, svc):
        return create_analysis(
            db_mem, host_kind="sub_sample", host_pk=sub.id,
            analysis_service_id=svc.id, keyword=svc.keyword,
            title=svc.keyword, result_value=None,
        )

    for svc in old.values():
        row(sub_pristine, svc)
    worked_rows = {cat: row(sub_worked, svc) for cat, svc in old.items()}
    # one row on the worked vial carries an entered result
    apply_transition(db_mem, analysis_id=worked_rows["PUR"].id, kind="assign")
    apply_transition(db_mem, analysis_id=worked_rows["PUR"].id, kind="submit", result_value="98.0")

    return db_mem, parent, sub_pristine, sub_worked, old_pep, new_pep


def test_replace_clears_old_rows_and_reseeds(blend_two_vials, monkeypatch):
    from lims_analyses import seeder as seeder_mod
    from lims_analyses.service import replace_analyte_slot

    db, parent, sub_pristine, sub_worked, old_pep, new_pep = blend_two_vials

    seeded_for = []
    monkeypatch.setattr(
        seeder_mod, "seed_analyses_for_vial",
        lambda db, **kw: seeded_for.append(kw["sub_sample"].sample_id) or [],
    )

    summary = replace_analyte_slot(
        db, parent_sample_id=parent.sample_id, slot=2,
        old_peptide_id=old_pep.id, new_peptide_id=new_pep.id,
        confirm_retract=True, user_id=None,
    )

    assert summary["old_peptide_id"] == old_pep.id
    assert summary["new_peptide_id"] == new_pep.id

    # pristine vial: all three old rows hard-deleted
    remaining_pristine = db.execute(
        select(LimsAnalysis).where(
            LimsAnalysis.lims_sub_sample_pk == sub_pristine.id,
            LimsAnalysis.review_state.notin_(["retracted", "rejected"]),
        )
    ).scalars().all()
    assert remaining_pristine == []

    # worked vial: the worked PUR row is rejected (audited), the two pristine
    # siblings deleted
    worked_states = db.execute(
        select(LimsAnalysis.keyword, LimsAnalysis.review_state).where(
            LimsAnalysis.lims_sub_sample_pk == sub_worked.id,
        )
    ).all()
    states = {kw: st for kw, st in worked_states}
    assert states.get("PUR_TP500") == "rejected"
    assert "ID_TP500" not in states and "QTY_TP500" not in states

    # both non-xtra vials re-seeded (new peptide rows produced by the seeder)
    assert sorted(seeded_for) == ["PB-REPL-1-S01", "PB-REPL-1-S02"]


def test_classify_slot_replacement_impact_buckets(blend_two_vials):
    from lims_analyses.service import classify_slot_replacement_impact

    db, parent, sub_pristine, sub_worked, old_pep, new_pep = blend_two_vials
    impact = classify_slot_replacement_impact(
        db, parent_sample_id=parent.sample_id, old_peptide_id=old_pep.id,
    )
    # pristine vial: 3 old rows; worked vial: 2 pristine + 1 worked (PUR)
    assert len(impact["pristine"]) == 5
    assert [r["keyword"] for r in impact["worked_unverified"]] == ["PUR_TP500"]
    assert impact["blocked"] == []
    # entries carry what the action loop needs
    assert all({"analysis_id", "sub_sample_pk", "sample_id", "keyword"} <= set(e)
               for e in impact["pristine"])


def test_replace_rejects_when_new_peptide_lacks_services(blend_two_vials):
    from lims_analyses.service import replace_analyte_slot, BadRequestError

    db, parent, _, _, old_pep, _ = blend_two_vials
    lonely = _peptide(db, "No Services", "NOSVC")
    db.commit()

    with pytest.raises(BadRequestError):
        replace_analyte_slot(
            db, parent_sample_id=parent.sample_id, slot=2,
            old_peptide_id=old_pep.id, new_peptide_id=lonely.id,
            confirm_retract=True, user_id=None,
        )
