"""Catalog-backed demand: MAX(vials_required) per fulfillment role.

Parity contract: for every combination of the five legacy keys the catalog
resolver returns byte-identical demand to the legacy hardcoded map. New
profile keys are new behavior outside the parity set.
"""
import itertools
import pytest

# Registers analysis_profiles on Base.metadata before conftest's db_session
# fixture runs create_all(), so this file is self-contained when run standalone.
import models  # noqa: F401

LEGACY_KEYS = ["hplcpurity_identity", "bac_water_panel", "endotoxin",
               "sterility_pcr", "samplevariance"]


def _seed(db):
    from catalog.profile_seed import seed_profiles_from_registry
    seed_profiles_from_registry(db)
    db.commit()


def _mk_hm_profile(db, *, vials=1, role="hm", active=True):
    from models import AnalysisProfile
    p = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True,
                        vials_required=vials, fulfillment_role=role,
                        fulfillment_dim="role", active=active)
    db.add(p)
    db.commit()
    return p


def test_parity_all_32_legacy_combos(db_session):
    from sub_samples.catalog_demand import derive_base_demand_catalog
    from sub_samples.service import derive_base_demand
    _seed(db_session)
    for bits in itertools.product([True, False], repeat=5):
        services = dict(zip(LEGACY_KEYS, bits))
        legacy = derive_base_demand(services)          # db=None -> pure legacy
        catalog = derive_base_demand_catalog(db_session, services)
        assert {k: catalog.get(k, 0) for k in ("hplc", "endo", "ster")} == legacy, services


def test_hm_alone_provisions_one_hm_vial(db_session):
    from sub_samples.catalog_demand import derive_base_demand_catalog
    _seed(db_session)
    _mk_hm_profile(db_session)
    d = derive_base_demand_catalog(db_session, {"heavy_metals": True})
    assert d["hm"] == 1
    assert d["hplc"] == 0 and d["endo"] == 0 and d["ster"] == 0


def test_hm_plus_legacy_composes(db_session):
    from sub_samples.catalog_demand import derive_base_demand_catalog
    _seed(db_session)
    _mk_hm_profile(db_session)
    d = derive_base_demand_catalog(
        db_session, {"hplcpurity_identity": True, "heavy_metals": True})
    assert d == {"hplc": 1, "endo": 0, "ster": 0, "hm": 1}


def test_unknown_key_contributes_nothing_and_warns(db_session, caplog):
    from sub_samples.catalog_demand import derive_base_demand_catalog
    _seed(db_session)
    with caplog.at_level("WARNING"):
        d = derive_base_demand_catalog(db_session, {"mystery_key": True})
    assert d == {"hplc": 0, "endo": 0, "ster": 0}
    assert any("mystery_key" in r.message for r in caplog.records)


def test_variance_keys_are_quiet_skips(db_session, caplog):
    """samplevariance/variance never hit the warning path (every variance
    order would otherwise log noise) and never add base demand."""
    from sub_samples.catalog_demand import derive_base_demand_catalog
    _seed(db_session)
    with caplog.at_level("WARNING"):
        d = derive_base_demand_catalog(
            db_session, {"samplevariance": True, "variance": {"endotoxin": 3}})
    assert d == {"hplc": 0, "endo": 0, "ster": 0}
    assert not caplog.records


def test_inactive_profile_still_fulfills_but_warns(db_session, caplog):
    from sub_samples.catalog_demand import derive_base_demand_catalog
    _seed(db_session)
    _mk_hm_profile(db_session, active=False)
    with caplog.at_level("WARNING"):
        d = derive_base_demand_catalog(db_session, {"heavy_metals": True})
    assert d["hm"] == 1  # paid orders always fulfil
    assert any("inactive" in r.message for r in caplog.records)


def test_flip_shadow_compare_prefers_legacy_on_divergence(db_session, caplog):
    """If an admin edit makes the catalog disagree with legacy on a legacy
    bucket, derive_base_demand(db=...) keeps the LEGACY value for that bucket
    (and logs an error), while catalog-only buckets pass through."""
    from models import AnalysisProfile
    from sub_samples.service import derive_base_demand
    _seed(db_session)
    _mk_hm_profile(db_session)
    row = db_session.query(AnalysisProfile).filter_by(key="endotoxin").one()
    row.vials_required = 5  # bad admin edit
    db_session.commit()
    with caplog.at_level("ERROR"):
        d = derive_base_demand({"endotoxin": True, "heavy_metals": True},
                               db=db_session)
    assert d["endo"] == 1     # legacy wins the legacy bucket
    assert d["hm"] == 1       # catalog-only bucket unaffected
    assert any("demand_divergence" in r.message for r in caplog.records)


def test_seed_backfills_demand_fields(db_session):
    from models import AnalysisProfile
    _seed(db_session)
    rows = {p.key: p for p in db_session.query(AnalysisProfile).all()}
    assert (rows["hplcpurity_identity"].vials_required,
            rows["hplcpurity_identity"].fulfillment_role) == (1, "hplc")
    assert (rows["bac_water_panel"].vials_required,
            rows["bac_water_panel"].fulfillment_role) == (1, "hplc")
    assert (rows["endotoxin"].vials_required,
            rows["endotoxin"].fulfillment_role) == (1, "endo")
    assert (rows["sterility_pcr"].vials_required,
            rows["sterility_pcr"].fulfillment_role) == (1, "ster")
    assert rows["variance"].vials_required == 0  # variance NEVER folds into base


def test_seed_backfills_on_fresh_db_under_production_autoflush_config():
    """Regression (review finding): production's SessionLocal is built with
    autoflush=False (database.py:40). On a fresh DB the backfill's SELECT
    queries the same rows db.add() staged earlier in the same call, with no
    committed data yet to find via autoflush — without an explicit flush
    between the insert loop and the backfill loop, every key resolves to
    None, the backfill silently no-ops, and the seed commits at
    vials_required=0 (inert until a second boot re-seeds against
    already-committed rows). conftest's db_session fixture defaults to
    autoflush=True, which would mask this — so this test builds its own
    session matching production instead of using that fixture."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from database import Base
    from catalog.profile_seed import seed_profiles_from_registry
    from models import AnalysisProfile

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine, autoflush=False)()
    try:
        seed_profiles_from_registry(db)
        rows = {p.key: p for p in db.query(AnalysisProfile).all()}
        assert (rows["hplcpurity_identity"].vials_required,
                rows["hplcpurity_identity"].fulfillment_role) == (1, "hplc")
        assert (rows["bac_water_panel"].vials_required,
                rows["bac_water_panel"].fulfillment_role) == (1, "hplc")
        assert (rows["endotoxin"].vials_required,
                rows["endotoxin"].fulfillment_role) == (1, "endo")
        assert (rows["sterility_pcr"].vials_required,
                rows["sterility_pcr"].fulfillment_role) == (1, "ster")
    finally:
        db.close()
