"""Alias set (spec 2026-09-10, M2b): the new profile key
`hplc-purity-identity` must count as THE HPLC primary everywhere the
legacy `hplcpurity_identity` is hardcoded — otherwise an order carrying
only the new key silently yields 0 paid variance vials and the legacy
demand shadow logs demand_divergence forever."""
import models  # noqa: F401


def test_keys_module_contract():
    from catalog.hplc_keys import (HPLC_PRIMARY_KEYS, LEGACY_HPLC_KEY, NATIVE_HPLC_KEY,
                                   hplc_primary_selected)
    assert HPLC_PRIMARY_KEYS == frozenset({"hplcpurity_identity", "hplc-purity-identity"})
    assert LEGACY_HPLC_KEY == "hplcpurity_identity" and NATIVE_HPLC_KEY == "hplc-purity-identity"
    assert hplc_primary_selected({"hplc-purity-identity": True}) is True
    assert hplc_primary_selected({"hplcpurity_identity": True}) is True
    assert hplc_primary_selected({"endotoxin": True}) is False


def test_variance_demand_counts_new_key_like_legacy():
    from sub_samples.service import derive_variance_demand
    legacy = derive_variance_demand({"hplcpurity_identity": True,
                                     "variance": {"hplcpurity_identity": 3}})
    native = derive_variance_demand({"hplc-purity-identity": True,
                                     "variance": {"hplc-purity-identity": 3}})
    assert legacy == native
    assert native["hplc"] == 2          # 3 replicates -> 1 base vial + 2 paid


def test_variance_demand_new_key_survives_normalization():
    # normalize_variance_entitlement is key-agnostic (passes through any
    # int >= 2), so the native key's count is never filtered out.
    from sub_samples.service import normalize_variance_entitlement
    entitlement = normalize_variance_entitlement({"variance": {"hplc-purity-identity": 3}})
    assert entitlement.get("hplc-purity-identity") == 3


def test_base_demand_counts_new_key(db_session):
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from catalog.profile_seed import seed_profiles_from_registry
    from sub_samples.service import derive_base_demand

    seed_profiles_from_registry(db_session)
    seed_hplc_native_catalog(db_session)
    db_session.commit()

    native = derive_base_demand({"hplc-purity-identity": True}, db=db_session)
    legacy = derive_base_demand({"hplcpurity_identity": True}, db=db_session)
    assert native["hplc"] == legacy["hplc"] == 1


def test_base_demand_legacy_only_signature_counts_new_key():
    from sub_samples.service import derive_base_demand
    native = derive_base_demand({"hplc-purity-identity": True})
    legacy = derive_base_demand({"hplcpurity_identity": True})
    assert native["hplc"] == legacy["hplc"] == 1


def test_build_ordered_products_suppresses_native_key_like_legacy_when_packaged():
    from sub_samples.product_registry import build_ordered_products

    def labels(products):
        return [p["label"] for p in products]

    native_packaged = build_ordered_products({"hplc-purity-identity": True}, "core")
    legacy_packaged = build_ordered_products({"hplcpurity_identity": True}, "core")
    assert labels(native_packaged) == labels(legacy_packaged) == ["Core HPLC"]

    native_standalone = build_ordered_products({"hplc-purity-identity": True}, None)
    legacy_standalone = build_ordered_products({"hplcpurity_identity": True}, None)
    assert "hplc-purity-identity" in [p["key"] for p in native_standalone]
    assert "hplcpurity_identity" in [p["key"] for p in legacy_standalone]


def test_seeder_role_map_includes_new_key():
    from lims_analyses.seeder import ROLE_TO_WP_KEYS
    assert "hplc-purity-identity" in ROLE_TO_WP_KEYS["hplc"]
    assert "hplcpurity_identity" in ROLE_TO_WP_KEYS["hplc"]


def test_demand_verify_knows_new_key():
    from catalog.demand_verify import LEGACY_DEMAND_KEYS
    assert "hplc-purity-identity" in LEGACY_DEMAND_KEYS


def test_demand_verify_no_error_for_native_key(db_session):
    """The S9 legacy-key-completeness check (LEGACY_DEMAND_KEYS loop, check
    #1) must not flag `hplc-purity-identity` as missing/inactive/misconfigured
    now that Task 4 seeds it as a real analysis_profiles row. Department/
    vial_roles wiring (checks #2-4) is orthogonal — those flag every
    role-dim profile equally in this minimal fixture (no boot-time
    department backfill here), so the legacy `hplcpurity_identity` key
    trips them too. What matters is parity: the native key is never worse
    off than the legacy key it aliases."""
    from catalog.demand_verify import verify_demand_catalog
    from catalog.hplc_native_seed import seed_hplc_native_catalog
    from catalog.profile_seed import seed_profiles_from_registry

    seed_hplc_native_catalog(db_session)
    seed_profiles_from_registry(db_session)
    db_session.commit()

    violations = verify_demand_catalog(db_session)
    # Confirm the verifier actually ran against the seeded catalog (checks
    # #2-4 fire for every role-dim profile in this minimal fixture — no
    # department backfill here — so a non-empty list proves this isn't a
    # vacuous pass from the total==0 early-return).
    assert isinstance(violations, list) and len(violations) > 0

    completeness_hits = [v for v in violations if v.startswith("legacy demand key ")]
    assert not any("hplc-purity-identity" in v for v in completeness_hits)
    # Parity both ways: the legacy key it aliases must not be flagged either.
    assert not any("hplcpurity_identity" in v for v in completeness_hits)
