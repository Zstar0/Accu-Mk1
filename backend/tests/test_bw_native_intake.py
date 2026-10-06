"""Native-born Bac Water intake (spec 2026-10-05, MB3): placeholders for the
panel mint WITHOUT the peptide slot machinery (no slot resolution, no
unresolved-analyte flag, which would block the COA); the customer-id counter
headroom check is loud and never blocks boot."""
import inspect
import json
import logging

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from flags import seams as flag_seams
from flags.models import FlagFlag
from flags.types_service import seed_builtins
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED, seed_parent_placeholders
from models import Department, LimsAnalysis, LimsNativeIdSequence, LimsSample


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _catalog(db):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from catalog.profile_seed import seed_profiles_from_registry
    seed_builtins(db)
    flag_seams.register_mk1_entities()
    db.add(Department(name="Analytical"))
    db.commit()
    seed_profiles_from_registry(db)
    seed_bw_native_catalog(db)


def _bw_parent(db, *, system, sample_id):
    p = LimsSample(sample_id=sample_id, external_lims_system=system,
                   sample_type_title="Bacteriostatic Water",
                   analytes=json.dumps([{"name": "Benzyl Alcohol", "declared_quantity": "30"}]))
    db.add(p)
    db.commit()
    return p


def _ordered(db, parent):
    return db.query(LimsAnalysis).filter_by(lims_sample_pk=parent.id,
                                            provenance=PROVENANCE_ORDERED).all()


def test_native_bw_parent_gets_three_placeholders_and_zero_flags(db, caplog):
    _catalog(db)
    p = _bw_parent(db, system="mk1", sample_id="BW-1000")
    with caplog.at_level(logging.ERROR):
        stats = seed_parent_placeholders(db, parent=p,
                                         services={"bacteriostatic-water-panel": True})
    rows = _ordered(db, p)
    assert stats["created"] == 3
    assert sorted((r.keyword, r.slot, r.peptide_id) for r in rows) == [
        ("BENZYL-ALCOHOL-BW", None, None), ("FILL-VOLUME-BW", None, None), ("PH-BW", None, None)]
    flags = db.execute(select(FlagFlag).where(FlagFlag.entity_type == "sample",
                                              FlagFlag.entity_id == str(p.id))).scalars().all()
    assert flags == []
    assert not any("native_placeholder_no_analyte_slots" in r.message for r in caplog.records)


def test_senaite_born_bw_parent_legacy_key_unchanged(db):
    """Legacy bac_water_panel has no members, so no 'ordered' rows: today's behaviour."""
    _catalog(db)
    p = _bw_parent(db, system="senaite", sample_id="BW-0135")
    stats = seed_parent_placeholders(db, parent=p, services={"bac_water_panel": True})
    assert stats["created"] == 0 and _ordered(db, p) == []


def test_senaite_born_bw_parent_with_native_key_gets_no_native_placeholders(db):
    """Review Focus 3: IS valve OFF maps the native key to the legacy SENAITE
    panel but does NOT rewrite the stored payload, so a SENAITE-born BW sample
    can arrive carrying bacteriostatic-water-panel. Its SENAITE trio already
    shadows onto the parent; minting the native trio too would put two
    entry surfaces on the bench."""
    _catalog(db)
    p = _bw_parent(db, system="senaite", sample_id="BW-0136")
    stats = seed_parent_placeholders(db, parent=p,
                                     services={"bacteriostatic-water-panel": True})
    assert stats["created"] == 0 and _ordered(db, p) == []


def test_native_peptide_without_title_still_resolves_slots(db):
    """The gate is BW-exclusion, not peptide-only: a native row with a NULL
    sample_type_title (test_apply_retest_spec._retest shape) still gets the
    slot-aware trio."""
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from models import AnalysisProfile, Peptide
    seed_hplc_native_catalog(db)
    db.query(AnalysisProfile).filter_by(key="hplc-purity-identity").one().active = True
    db.add(Peptide(name="BPC-157", abbreviation="BPC157"))
    p = LimsSample(sample_id="P-5003", external_lims_system="mk1",
                   analytes=json.dumps([{"name": "BPC-157 - Identity (HPLC)"}]))
    db.add(p)
    db.commit()
    seed_parent_placeholders(db, parent=p, services={"hplc-purity-identity": True})
    assert sorted((r.keyword, r.slot) for r in _ordered(db, p)) == [
        ("HPLC-IDENTITY", 1), ("HPLC-PURITY", 1), ("HPLC-QUANTITY", 1)]


def test_headroom_silent_when_counters_above_senaite_max(db, caplog):
    from sub_samples.native_id import customer_id_headroom_violations
    db.add_all([LimsNativeIdSequence(prefix="BW", next_value=1000),
                LimsNativeIdSequence(prefix="P", next_value=5000),
                LimsNativeIdSequence(prefix="PB", next_value=1000),
                LimsSample(sample_id="BW-0135", external_lims_system="senaite"),
                LimsSample(sample_id="P-4999", external_lims_system="senaite"),
                LimsSample(sample_id="BW-1000", external_lims_system="mk1")])
    db.commit()
    with caplog.at_level(logging.ERROR):
        assert customer_id_headroom_violations(db) == []
    assert not caplog.records


def test_headroom_errors_when_senaite_reaches_counter(db, caplog):
    from sub_samples.native_id import customer_id_headroom_violations
    db.add_all([LimsNativeIdSequence(prefix="BW", next_value=1000),
                LimsSample(sample_id="BW-1000", external_lims_system="senaite"),
                LimsSample(sample_id="BW-1000-X", external_lims_system="senaite")])
    db.commit()
    with caplog.at_level(logging.ERROR):
        out = customer_id_headroom_violations(db)
    assert len(out) == 1 and "BW" in out[0] and "BW-1000" in out[0]
    assert any("native_id.counter_headroom" in r.message for r in caplog.records)


def test_init_db_runs_headroom_check():
    import database
    assert "customer_id_headroom_violations" in inspect.getsource(database.init_db)
