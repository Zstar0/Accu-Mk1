"""seed_parent_placeholders on native-born parents mints the trio PER SLOT
(spec 2026-09-10 M4); SENAITE-born parents are unchanged."""
import json
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import (AnalysisProfile, AnalysisService, Base, LimsAnalysis, LimsSample, Peptide,
                    analysis_profile_members)
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED, seed_parent_placeholders


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _seed(db):
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    seed_hplc_native_catalog(db)
    prof = db.query(AnalysisProfile).filter_by(key="hplc-purity-identity").one()
    prof.active = True
    db.add(Peptide(name="BPC-157", abbreviation="BPC157"))
    db.add(Peptide(name="TB-500", abbreviation="TB500"))
    db.commit()


def _parent(db, *, system, analytes, sample_id):
    p = LimsSample(sample_id=sample_id, external_lims_system=system, sample_type_title="Peptide",
                   analytes=json.dumps(analytes))
    db.add(p); db.commit()
    return p


SERVICES = {"hplc-purity-identity": True}


def _rows(db, parent):
    return db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id, provenance=PROVENANCE_ORDERED).all()


def test_native_blend_parent_gets_one_placeholder_per_slot_plus_aggregates(db):
    _seed(db)
    p = _parent(db, system="mk1", sample_id="PB-1000",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "5"},
                          {"name": "TB-500 - Identity (HPLC)", "declared_quantity": "5"}])
    stats = seed_parent_placeholders(db, parent=p, services=SERVICES)
    rows = _rows(db, p)
    assert stats["created"] == 8 and len(rows) == 8
    bpc = db.query(Peptide).filter_by(name="BPC-157").one().id
    assert ("HPLC-PURITY", 1, bpc, "BPC-157 - Purity (HPLC)") in {(r.keyword, r.slot, r.peptide_id, r.title) for r in rows}
    assert {r.keyword for r in rows if r.slot is None} == {"HPLC-BLEND-PURITY", "HPLC-BLEND-TOTAL"}


def test_native_single_parent_gets_three_placeholders_no_aggregates(db):
    _seed(db)
    p = _parent(db, system="mk1", sample_id="P-5000",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "10"}])
    seed_parent_placeholders(db, parent=p, services=SERVICES)
    assert sorted((r.keyword, r.slot) for r in _rows(db, p)) == [
        ("HPLC-IDENTITY", 1), ("HPLC-PURITY", 1), ("HPLC-QUANTITY", 1)]


def test_native_placeholders_idempotent_per_slot(db):
    _seed(db)
    p = _parent(db, system="mk1", sample_id="PB-1001",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None},
                          {"name": "TB-500 - Identity (HPLC)", "declared_quantity": None}])
    seed_parent_placeholders(db, parent=p, services=SERVICES)
    again = seed_parent_placeholders(db, parent=p, services=SERVICES)
    assert again["created"] == 0 and again["existing"] == 8 and len(_rows(db, p)) == 8


def test_native_unresolved_slot_placeholder_has_null_peptide_and_reason(db):
    _seed(db)
    p = _parent(db, system="mk1", sample_id="P-5001",
                analytes=[{"name": "Mystery - Identity (HPLC)", "declared_quantity": None}])
    seed_parent_placeholders(db, parent=p, services=SERVICES)
    rows = _rows(db, p)
    assert all(r.peptide_id is None and r.reportable_reason.startswith("analyte_unresolved") for r in rows)


def test_native_parent_no_occupied_slots_logs_error_and_mints_nothing(db, caplog):
    _seed(db)
    p = _parent(db, system="mk1", sample_id="P-5002", analytes=[])
    stats = seed_parent_placeholders(db, parent=p, services=SERVICES)
    assert stats["created"] == 0
    assert len(_rows(db, p)) == 0
    assert any("registry.native_placeholder_no_analyte_slots" in r.message for r in caplog.records)


def test_senaite_born_parent_unchanged_slot_null_one_per_service(db):
    """Legacy behaviour: a SENAITE-born parent ordering the native profile
    (only possible after the WP flip in an edge case) still gets one row per
    member with slot NULL — exactly what today's code mints."""
    _seed(db)
    p = _parent(db, system="senaite", sample_id="P-0141",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None},
                          {"name": "TB-500 - Identity (HPLC)", "declared_quantity": None}])
    stats = seed_parent_placeholders(db, parent=p, services=SERVICES)
    rows = _rows(db, p)
    assert stats["created"] == 5 and all(r.slot is None and r.peptide_id is None for r in rows)
