"""Catalog-backed demand: MAX(vials_required) per fulfillment role.

Parity contract: for every combination of the five legacy keys the catalog
resolver returns byte-identical demand to the legacy hardcoded map. New
profile keys are new behavior outside the parity set.
"""
import itertools
import logging
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


def _mk_profile(db, key, *, vials=1, role, active=True, is_addon=False):
    from models import AnalysisProfile
    p = AnalysisProfile(key=key, name=key, is_addon=is_addon,
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


def test_divergence_catalog_prevails(db_session, caplog):
    """S9 ruling 2026-08-14: on divergence the CATALOG value wins and the
    divergence is logged. Reverting to legacy-wins re-cosmetizes the catalog
    — do not restore the clamp."""
    from sub_samples.service import derive_base_demand
    _mk_profile(db_session, "endotoxin", vials=2, role="endo")  # catalog says 2, legacy says 1
    with caplog.at_level(logging.ERROR):
        d = derive_base_demand({"endotoxin": True}, db=db_session)
    assert d["endo"] == 2, "catalog value must prevail over the legacy shadow"
    assert any("demand_divergence" in r.message for r in caplog.records)


def test_divergence_catalog_zero_prevails_and_screams(db_session, caplog):
    """The under-provision direction: catalog 0 vs legacy 1 also resolves to
    catalog (Handler: Mk1 catalog prevails, both directions) — but the log
    must fire so ops sees it. The boot-time verify (Task 3) is the guard
    that keeps this state from persisting silently."""
    from sub_samples.service import derive_base_demand
    # EXISTING row with vials_required=0 — the production-realistic shape
    # (admin-created rows default to 0, per demand_verify's check 3), not a
    # missing-row hypothetical.
    _mk_profile(db_session, "endotoxin", vials=0, role="endo")
    with caplog.at_level(logging.ERROR):
        d = derive_base_demand({"endotoxin": True}, db=db_session)
    assert d["endo"] == 0
    assert any("demand_divergence" in r.message for r in caplog.records)


def test_hm_passes_through_divergence_loop_untouched(db_session):
    """derive_base_demand's divergence loop iterates only the 3 legacy
    buckets (hplc/endo/ster) — hm (or any other catalog-only role) is never
    touched by it and reaches the caller straight from the catalog.
    vials=2 (not the default 1) makes this discriminating: the legacy map
    has no 'hm' entry at all, so only an untouched catalog passthrough can
    produce 2 here — a loop that (wrongly) swept hm in would clamp/compare
    it against a legacy value that doesn't exist."""
    from sub_samples.service import derive_base_demand
    _mk_hm_profile(db_session, vials=2)
    d = derive_base_demand({"heavy_metals": True}, db=db_session)
    assert d["hm"] == 2


def test_legacy_wins_kill_switch(db_session, monkeypatch, caplog):
    """MK1_DEMAND_LEGACY_WINS=1 restores the old clamp — the deploy rollback
    path. Temporary: dies with the shadow one release after the flip.

    The divergence log must still fire under the switch (an operator reading
    it during a rollback incident needs to know a clamp happened) and must
    say so accurately — never "catalog prevails" while the clamp is active."""
    from sub_samples.service import derive_base_demand
    monkeypatch.setenv("MK1_DEMAND_LEGACY_WINS", "1")
    _mk_profile(db_session, "endotoxin", vials=2, role="endo")
    with caplog.at_level(logging.ERROR):
        d = derive_base_demand({"endotoxin": True}, db=db_session)
    assert d["endo"] == 1, "kill switch must restore legacy-wins clamping"
    divergence_logs = [r.message for r in caplog.records if "demand_divergence" in r.message]
    assert divergence_logs, "divergence must still be logged under the kill switch"
    assert all("legacy clamp active" in m for m in divergence_logs)
    assert not any("catalog prevails" in m for m in divergence_logs), \
        "must not claim catalog prevails while the clamp is active"


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
