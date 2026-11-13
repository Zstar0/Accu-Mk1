"""MB5: the bacteriostatic-water-panel profile (coa_archetype legacy_bw)
rides page 1 via coa/bw_shim.py and must never surface as a native_sections
page-2 section (COABuilder aborts on an unknown archetype). A native
endotoxin row on the same BW sample still resolves the 'Bacteriostatic
Water' matrix tier (0-0.25 EU/mL), not the 0-5 wildcard. Real sqlite
catalog; fetch_sample_services monkeypatched (live IS pass-through)."""
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from coa.bw_shim import BW_NATIVE_KEYWORDS, LEGACY_BW_ARCHETYPE
from coa.native_sections import _ordered_native_profiles, build_native_sections
from database import Base

BW_PROFILE_KEY = "bacteriostatic-water-panel"
ENDO_PROFILE_KEY = "endotoxin-usp85-lal"


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
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import Department
    db.add(Department(name="Analytical"))
    db.flush()
    seed_bw_native_catalog(db)


def _endotoxin(db):
    from models import (AnalysisProfile, AnalysisService, AnalysisServiceSpec,
                        analysis_profile_members)
    prof = AnalysisProfile(key=ENDO_PROFILE_KEY, name="Endotoxin", is_addon=True,
                           coa_archetype="limit_table", coa_sort_order=10)
    svc = AnalysisService(title="Endotoxin (USP<85> LAL)", keyword="ENDOTOXIN-USP85LAL",
                          origin="mk1", unit="EU/mL")
    db.add_all([prof, svc])
    db.flush()
    db.execute(analysis_profile_members.insert().values(
        analysis_profile_id=prof.id, analysis_service_id=svc.id, sort_order=0))
    # Prod shape (verified 2026-10-05): wildcard 0-5 plus ONE matrix tier.
    db.add_all([
        AnalysisServiceSpec(analysis_service_id=svc.id, matrix=None,
                            rule_kind="range", max_value=Decimal("5"), unit="EU/mL"),
        AnalysisServiceSpec(analysis_service_id=svc.id, matrix="Bacteriostatic Water",
                            rule_kind="range", max_value=Decimal("0.25"), unit="EU/mL"),
    ])
    db.flush()
    return svc


def _verified(db, parent, svc, value):
    from models import LimsAnalysis
    db.add(LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.title, result_value=value,
        result_unit=svc.unit, review_state="verified", provenance="canonical",
    ))
    db.flush()


def _native_bw_sample(db, monkeypatch, *, endo_result):
    from models import AnalysisService, LimsSample
    _seed(db)
    endo = _endotoxin(db)
    parent = LimsSample(sample_id="BW-1001", external_lims_system="mk1",
                        sample_type_title="Bacteriostatic Water")
    db.add(parent)
    db.flush()
    for kw, value in (("PH-BW", "5.5"), ("BENZYL-ALCOHOL-BW", "0.90"),
                      ("FILL-VOLUME-BW", "10.1")):
        svc = db.query(AnalysisService).filter_by(keyword=kw, origin="mk1").one()
        _verified(db, parent, svc, value)
    _verified(db, parent, endo, endo_result)
    monkeypatch.setattr(
        "coa.native_sections.fetch_sample_services",
        lambda sample_id: {"services": {BW_PROFILE_KEY: True, ENDO_PROFILE_KEY: True},
                           "package": None},
    )
    return parent


def test_seeded_bw_profile_carries_legacy_bw(db):
    from models import AnalysisProfile
    _seed(db)
    prof = db.query(AnalysisProfile).filter_by(key=BW_PROFILE_KEY).one()
    assert prof.coa_archetype == LEGACY_BW_ARCHETYPE == "legacy_bw"
    assert {s.keyword for s in prof.analysis_services} == set(BW_NATIVE_KEYWORDS)


def test_legacy_bw_profile_excluded_from_reportable_profiles(db):
    _seed(db)
    assert _ordered_native_profiles(db, {BW_PROFILE_KEY: True}, None) == []
    # Placeholder path (require_archetype=False) still sees it: archetype is
    # a rendering concern, never a visibility one.
    assert [p.key for p in _ordered_native_profiles(
        db, {BW_PROFILE_KEY: True}, None, require_archetype=False)] == [BW_PROFILE_KEY]


def test_bw_panel_never_a_page_two_section_endotoxin_uses_bw_tier(db, monkeypatch):
    parent = _native_bw_sample(db, monkeypatch, endo_result="0.2")
    doc = build_native_sections(db, parent)
    assert doc["ordered_profiles"] == [ENDO_PROFILE_KEY]
    [section] = doc["sections"]
    assert section["profile_key"] == ENDO_PROFILE_KEY
    [row] = section["rows"]
    assert row["keyword"] == "ENDOTOXIN-USP85LAL"
    assert row["specification"]["max"] == 0.25
    assert row["conforms"] is True


def test_endotoxin_above_bw_tier_fails_even_though_under_wildcard(db, monkeypatch):
    # 0.3 passes the 5 EU/mL wildcard; failing here proves the matrix tier won.
    parent = _native_bw_sample(db, monkeypatch, endo_result="0.3")
    [section] = build_native_sections(db, parent)["sections"]
    [row] = section["rows"]
    assert row["specification"]["max"] == 0.25
    assert row["conforms"] is False
