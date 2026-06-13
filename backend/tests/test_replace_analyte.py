"""Replace-analyte tests (Phase 2 — wrong-variant correction).

peptide_has_full_service_set gates the offer-only picker; replace_analyte_slot
re-mirrors a slot's per-substance vial rows from the old peptide to the new one
(pristine -> delete + reseed, worked -> reject on confirm, verified -> blocked).
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
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
