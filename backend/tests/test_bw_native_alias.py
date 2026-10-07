"""Alias set (spec 2026-10-05, MB2): `bacteriostatic-water-panel` counts as
THE Bac Water primary everywhere `bac_water_panel` is hardcoded, so a native
BW order plans the same hplc vial, never logs demand_divergence, and seeds
its hplc vial. Legacy behaviour is pinned alongside each site."""
import logging

import models  # noqa: F401


def _seed(db):
    from catalog.bw_native_seed import seed_bw_native_catalog
    from catalog.profile_seed import seed_profiles_from_registry
    from models import Department
    db.add(Department(name="Analytical"))
    db.commit()
    seed_profiles_from_registry(db)
    seed_bw_native_catalog(db)
    db.commit()


def test_variance_demand_counts_native_key_like_legacy():
    from sub_samples.service import derive_variance_demand
    legacy = derive_variance_demand({"bac_water_panel": True, "variance": {"bac_water_panel": 3}})
    native = derive_variance_demand({"bacteriostatic-water-panel": True,
                                     "variance": {"bacteriostatic-water-panel": 3}})
    assert legacy == native
    assert native["hplc"] == 2


def test_base_demand_legacy_only_signature_counts_native_key():
    from sub_samples.service import derive_base_demand
    native = derive_base_demand({"bacteriostatic-water-panel": True})
    legacy = derive_base_demand({"bac_water_panel": True})
    assert native == legacy == {"hplc": 1, "endo": 0, "ster": 0}


def test_base_demand_catalog_path_no_divergence(db_session, caplog):
    from sub_samples.service import derive_base_demand
    _seed(db_session)
    with caplog.at_level(logging.ERROR):
        native = derive_base_demand({"bacteriostatic-water-panel": True}, db=db_session)
        legacy = derive_base_demand({"bac_water_panel": True}, db=db_session)
    assert native["hplc"] == legacy["hplc"] == 1
    assert not any("demand_divergence" in r.message for r in caplog.records)


def test_seeder_role_map_and_gate_include_native_key():
    from lims_analyses.seeder import ROLE_TO_WP_KEYS, role_implies_seeding
    assert {"bac_water_panel", "bacteriostatic-water-panel",
            "hplcpurity_identity", "hplc-purity-identity"} <= ROLE_TO_WP_KEYS["hplc"]
    assert role_implies_seeding("hplc", {"bacteriostatic-water-panel": True})
    assert role_implies_seeding("hplc", {"bac_water_panel": True})


def test_parent_bench_only_keeps_legacy_trio_and_adds_native():
    from lims_analyses.seeder import _PARENT_BENCH_ONLY_KEYWORDS
    assert {"Benzyl_Alcohol_Assay", "PH-DETERM", "FILL-NET-CONTENT",
            "PH-BW", "BENZYL-ALCOHOL-BW", "FILL-VOLUME-BW"} == set(_PARENT_BENCH_ONLY_KEYWORDS)


def test_throughput_files_native_trio_under_bac_water():
    from throughput import classify_keyword
    for kw in ("PH-BW", "BENZYL-ALCOHOL-BW", "FILL-VOLUME-BW"):
        assert classify_keyword(kw, None) == "bacw"
        assert classify_keyword(kw, "Bacteriostatic Water") == "bacw"
    for kw in ("Benzyl_Alcohol_Assay", "PH-DETERM", "FILL-NET-CONTENT"):
        assert classify_keyword(kw, None) == "bacw"


def test_ordered_products_resolve_native_key_from_catalog_row(db_session):
    from sub_samples.product_registry import build_ordered_products
    _seed(db_session)
    native = build_ordered_products({"bacteriostatic-water-panel": True}, None, db=db_session)
    legacy = build_ordered_products({"bac_water_panel": True}, None, db=db_session)
    assert [(p["key"], p["label"], p["is_addon"]) for p in native] == [
        ("bacteriostatic-water-panel", "Bac Water Panel", False)]
    assert [(p["key"], p["label"]) for p in legacy] == [("bac_water_panel", "Bac Water")]


def test_demand_verify_legacy_keys_unchanged():
    from catalog.demand_verify import LEGACY_DEMAND_KEYS
    assert LEGACY_DEMAND_KEYS == (
        "hplcpurity_identity", "bac_water_panel", "endotoxin", "sterility_pcr",
    )
