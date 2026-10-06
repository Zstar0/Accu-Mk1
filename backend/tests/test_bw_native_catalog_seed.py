"""Boot seed for the native Bac Water family (spec 2026-10-05, MB1): three
origin=mk1 Analytical services, ONE inactive profile
`bacteriostatic-water-panel` (role hplc, 1 vial, archetype legacy_bw, no SLA
tier), wildcard specs, and the guarded BW-1000 counter. Idempotent; admin
edits survive; the legacy SENAITE trio and `bac_water_panel` are untouched."""
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import Base

KEYWORDS = ("PH-BW", "BENZYL-ALCOHOL-BW", "FILL-VOLUME-BW")


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _dept(db):
    from models import Department
    d = Department(name="Analytical")
    db.add(d)
    db.commit()
    return d


def test_keys_module_contract():
    from catalog.bw_keys import (BW_NATIVE_KEYWORDS, BW_PRIMARY_KEYS, LEGACY_BW_KEY,
                                 NATIVE_BW_KEY, NATIVE_TO_LEGACY_KEYWORD, bw_primary_count,
                                 bw_primary_selected, is_bw_sample)
    from models import LimsSample
    assert LEGACY_BW_KEY == "bac_water_panel" and NATIVE_BW_KEY == "bacteriostatic-water-panel"
    assert BW_PRIMARY_KEYS == frozenset({"bac_water_panel", "bacteriostatic-water-panel"})
    assert NATIVE_TO_LEGACY_KEYWORD == {"PH-BW": "PH-DETERM",
                                        "BENZYL-ALCOHOL-BW": "Benzyl_Alcohol_Assay",
                                        "FILL-VOLUME-BW": "FILL-NET-CONTENT"}
    assert BW_NATIVE_KEYWORDS == frozenset(KEYWORDS)
    assert bw_primary_selected({"bacteriostatic-water-panel": True}) is True
    assert bw_primary_selected({"bac_water_panel": True}) is True
    assert bw_primary_selected({"hplcpurity_identity": True}) is False
    assert bw_primary_count({"bacteriostatic-water-panel": 3}) == 3
    assert is_bw_sample(LimsSample(sample_type_title="Bacteriostatic Water")) is True
    assert is_bw_sample(LimsSample(sample_type_title=" bacteriostatic water ")) is True
    assert is_bw_sample(LimsSample(sample_type_title="Peptide")) is False
    assert is_bw_sample(LimsSample(sample_type_title=None)) is False


def test_shim_reexports_one_source_of_truth():
    from catalog import bw_keys
    from coa import bw_shim
    assert bw_shim.LEGACY_BW_ARCHETYPE == "legacy_bw"
    assert bw_shim.BW_NATIVE_KEYWORDS is bw_keys.BW_NATIVE_KEYWORDS
    assert bw_shim.NATIVE_TO_LEGACY_KEYWORD is bw_keys.NATIVE_TO_LEGACY_KEYWORD


def test_seed_creates_three_mk1_services_in_analytical(db_session):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import AnalysisService
    dept = _dept(db_session)
    report = seed_bw_native_catalog(db_session)
    assert report["services"] == 3
    rows = {s.keyword: s for s in db_session.query(AnalysisService).all()}
    assert set(rows) == set(KEYWORDS)
    for kw in KEYWORDS:
        assert rows[kw].origin == "mk1"
        assert rows[kw].department_id == dept.id
        assert rows[kw].result_type == "numeric"
        # NOT "HPLC": throughput.classify_keyword checks category BEFORE
        # BACW_KEYWORDS, so an HPLC category would file BA under hplc.
        assert rows[kw].category == "Bacteriostatic Water"
    assert (rows["PH-BW"].unit, rows["PH-BW"].variance_capable) == ("pH", True)
    assert (rows["BENZYL-ALCOHOL-BW"].unit, rows["BENZYL-ALCOHOL-BW"].variance_capable) == ("% (v/v)", True)
    # Titles and units mirror the prod SENAITE rows exactly (verified 2026-10-05).
    assert [rows[k].title for k in KEYWORDS] == [
        "pH Determination", "Benzyl Alcohol Assay (HPLC)", "Fill volume / Net content"]
    assert (rows["FILL-VOLUME-BW"].unit, rows["FILL-VOLUME-BW"].variance_capable) == ("mL", False)


def test_seed_creates_inactive_profile_with_ordered_members_and_no_sla_tier(db_session):
    from catalog.bw_native_seed import BW_NATIVE_PROFILE_KEY, seed_bw_native_catalog
    from models import AnalysisProfile
    _dept(db_session)
    seed_bw_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key=BW_NATIVE_PROFILE_KEY).one()
    assert BW_NATIVE_PROFILE_KEY == "bacteriostatic-water-panel"
    assert (prof.name, prof.is_addon, prof.vials_required, prof.fulfillment_role,
            prof.fulfillment_dim, prof.coa_archetype, prof.active, prof.sla_tier_id) == (
        "Bac Water Panel", False, 1, "hplc", "role", "legacy_bw", False, None)
    assert [s.keyword for s in prof.analysis_services] == list(KEYWORDS)


def test_seed_writes_wildcard_specs(db_session):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import AnalysisService, AnalysisServiceSpec
    _dept(db_session)
    assert seed_bw_native_catalog(db_session)["specs"] == 3

    def spec(kw):
        svc = db_session.query(AnalysisService).filter_by(keyword=kw).one()
        return (db_session.query(AnalysisServiceSpec)
                .filter(AnalysisServiceSpec.analysis_service_id == svc.id,
                        AnalysisServiceSpec.matrix.is_(None),
                        AnalysisServiceSpec.peptide_id.is_(None)).one())

    ph, ba, fill = spec("PH-BW"), spec("BENZYL-ALCOHOL-BW"), spec("FILL-VOLUME-BW")
    assert (ph.rule_kind, ph.min_value, ph.max_value, ph.display_override) == (
        "range", Decimal("4.5"), Decimal("7.0"), "4.5 – 7.0")
    assert (ba.rule_kind, ba.min_value, ba.max_value, ba.unit, ba.display_override) == (
        "range", Decimal("0.72"), Decimal("1.08"), "% (v/v)", "0.9% (v/v) ±20%")
    assert (fill.rule_kind, fill.unit, fill.display_override) == ("informational", "mL", None)


def test_seed_is_idempotent_and_keeps_admin_edits(db_session):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import AnalysisProfile, AnalysisService, CatalogChangeLog
    _dept(db_session)
    seed_bw_native_catalog(db_session)
    prof = db_session.query(AnalysisProfile).filter_by(key="bacteriostatic-water-panel").one()
    prof.vials_required = 2
    svc = db_session.query(AnalysisService).filter_by(keyword="PH-BW").one()
    svc.title = "pH (edited)"
    db_session.commit()
    before = db_session.query(CatalogChangeLog).count()
    assert seed_bw_native_catalog(db_session) == {"services": 0, "profile": 0, "members": 0, "specs": 0}
    assert db_session.query(AnalysisService).count() == 3
    assert prof.vials_required == 2 and svc.title == "pH (edited)" and prof.active is False
    assert db_session.query(CatalogChangeLog).count() == before


def test_change_log_rows_written(db_session):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import CatalogChangeLog
    _dept(db_session)
    seed_bw_native_catalog(db_session)
    actions = [(r.entity_type, r.action) for r in db_session.query(CatalogChangeLog).all()]
    assert actions.count(("service", "create")) == 3
    assert actions.count(("profile", "create")) == 1
    assert actions.count(("profile_members", "update")) == 1


def test_seed_refuses_without_analytical_department(db_session, caplog):
    """Unlike HPLC-%, nothing rescues PH-BW / BENZYL-ALCOHOL-BW / FILL-VOLUME-BW
    into a department later (catalog/departments.py
    _UNGROUPED_ANALYTICAL_LIKE_PATTERNS has no BW pattern), and a NULL
    department hid every BW card from the worksheet inbox on 09-01. So: seed
    nothing, ERROR, retry next boot (backfill_departments seeds the
    department before this seed in init_db)."""
    from catalog.bw_native_seed import seed_bw_native_catalog
    from models import AnalysisService
    with caplog.at_level("ERROR"):
        report = seed_bw_native_catalog(db_session)
    assert report == {"services": 0, "profile": 0, "members": 0, "specs": 0}
    assert db_session.query(AnalysisService).count() == 0
    assert any("bw_native_seed.no_analytical_department" in r.message for r in caplog.records)


def test_keyword_collision_skips_service_and_aborts_profile(db_session, caplog):
    from catalog.bw_native_seed import BW_NATIVE_PROFILE_KEY, seed_bw_native_catalog
    from models import AnalysisProfile, AnalysisService
    _dept(db_session)
    db_session.add(AnalysisService(title="pH (SENAITE)", keyword="PH-BW", origin="senaite"))
    db_session.commit()
    with caplog.at_level("ERROR"):
        report = seed_bw_native_catalog(db_session)
    assert db_session.query(AnalysisService).filter_by(keyword="PH-BW", origin="mk1").all() == []
    assert report["profile"] == 0 and report["services"] == 2
    assert db_session.query(AnalysisProfile).filter_by(key=BW_NATIVE_PROFILE_KEY).one_or_none() is None
    assert any("bw_native_seed.keyword_collision" in r.message for r in caplog.records)
    assert any("bw_native_seed.profile_creation_aborted" in r.message for r in caplog.records)


def test_legacy_senaite_trio_and_legacy_profile_untouched(db_session):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from catalog.profile_seed import seed_profiles_from_registry
    from models import AnalysisProfile, AnalysisService
    _dept(db_session)
    for kw in ("PH-DETERM", "Benzyl_Alcohol_Assay", "FILL-NET-CONTENT"):
        db_session.add(AnalysisService(title=kw, keyword=kw, origin="senaite",
                                       variance_capable=True))
    db_session.commit()
    seed_profiles_from_registry(db_session)
    legacy = db_session.query(AnalysisProfile).filter_by(key="bac_water_panel").one()
    snap = (legacy.name, legacy.active, legacy.vials_required, legacy.fulfillment_role,
            legacy.coa_archetype, legacy.sla_tier_id, list(legacy.analysis_services))
    seed_bw_native_catalog(db_session)
    db_session.refresh(legacy)
    assert (legacy.name, legacy.active, legacy.vials_required, legacy.fulfillment_role,
            legacy.coa_archetype, legacy.sla_tier_id, list(legacy.analysis_services)) == snap
    senaite = db_session.query(AnalysisService).filter_by(origin="senaite").all()
    assert sorted(s.keyword for s in senaite) == ["Benzyl_Alcohol_Assay", "FILL-NET-CONTENT", "PH-DETERM"]
    assert all(s.department_id is None and s.variance_capable for s in senaite)


def test_keywords_pass_native_keyword_rules(db_session):
    from main import validate_new_keyword
    for kw in KEYWORDS:
        validate_new_keyword(db_session, kw)


def test_profile_key_not_in_product_registry():
    from sub_samples.product_registry import PRODUCT_REGISTRY
    assert "bacteriostatic-water-panel" not in PRODUCT_REGISTRY


def test_inactive_profile_hidden_from_manage_analyses_picker(db_session):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from lims_analyses.manage_native import native_profiles_for_parent
    from models import LimsSample
    _dept(db_session)
    seed_bw_native_catalog(db_session)
    parent = LimsSample(sample_id="TEST-BW-PICKER-1", sample_type="x", status="received")
    db_session.add(parent)
    db_session.commit()
    assert "bacteriostatic-water-panel" not in {
        p["key"] for p in native_profiles_for_parent(db_session, parent=parent)}


def test_verify_demand_catalog_no_violation_for_seeded_profile(db_session, caplog):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from catalog.demand_verify import LEGACY_DEMAND_KEYS, verify_demand_catalog
    _dept(db_session)
    seed_bw_native_catalog(db_session)
    with caplog.at_level("ERROR"):
        violations = verify_demand_catalog(db_session)
    assert not any("bacteriostatic-water-panel" in v for v in violations)
    assert "bacteriostatic-water-panel" not in LEGACY_DEMAND_KEYS


def test_init_db_calls_bw_seed_after_hplc_and_before_specs(monkeypatch):
    import database
    calls = []

    def _rec(name):
        def _f(*a, **k):
            calls.append(name)
        return _f

    class _FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        def commit(self):
            pass

        def close(self):
            pass

    monkeypatch.setattr(database, "_run_migrations", _rec("migrations"))
    monkeypatch.setattr(database.Base.metadata, "create_all", _rec("create_all"))
    monkeypatch.setattr(database, "_seed_federal_holidays_window", _rec("holidays"))
    monkeypatch.setattr(database, "SessionLocal", lambda: _FakeSession())

    import catalog.bw_native_seed as bn
    import catalog.demand_verify as dv
    import catalog.departments as dep
    import catalog.hplc_native_seed as hn
    import catalog.per_substance_reconciler as psr
    import catalog.profile_seed as ps
    import catalog.service_spec_seed as ss
    import catalog.vial_roles_seed as vr
    import workflow.seeds as wfs

    monkeypatch.setattr(psr, "reconcile_per_substance_services", _rec("reconcile_per_substance"))
    monkeypatch.setattr(wfs, "seed_workflow_catalog", _rec("workflow_catalog"))
    monkeypatch.setattr(dep, "backfill_departments", _rec("backfill_departments"))
    monkeypatch.setattr(ps, "seed_profiles_from_registry", _rec("profiles_from_registry"))
    monkeypatch.setattr(vr, "seed_vial_roles", _rec("vial_roles"))
    monkeypatch.setattr(hn, "seed_hplc_native_catalog", _rec("hplc_native"))
    monkeypatch.setattr(hn, "upgrade_hplc_native_catalog", _rec("hplc_upgrade"))
    monkeypatch.setattr(bn, "seed_bw_native_catalog", _rec("bw_native"))
    monkeypatch.setattr(ss, "seed_service_specs", _rec("service_specs"))
    monkeypatch.setattr(dv, "verify_demand_catalog", _rec("demand_verify"))

    database.init_db()

    assert (calls.index("backfill_departments") < calls.index("hplc_upgrade")
            < calls.index("bw_native") < calls.index("service_specs"))
