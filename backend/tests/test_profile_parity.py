"""The profiles-backed product lookup must reproduce PRODUCT_REGISTRY exactly,
including its deliberate fail-open behavior for unregistered keys."""
import itertools

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def db_session():
    from database import Base
    import models  # noqa: F401
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def seeded(db_session):
    from catalog.profile_seed import seed_profiles_from_registry
    seed_profiles_from_registry(db_session)
    return db_session


SERVICE_KEYS = ["hplcpurity_identity", "bac_water_panel", "endotoxin",
                "sterility_pcr", "samplevariance"]
PACKAGES = [None, "core", "accushield"]


def test_seed_creates_one_profile_per_registry_entry(seeded):
    from models import AnalysisProfile
    from sub_samples.product_registry import PRODUCT_REGISTRY
    keys = {p.key for p in seeded.query(AnalysisProfile).all()}
    assert keys == set(PRODUCT_REGISTRY.keys())


def test_seed_is_idempotent(seeded):
    from catalog.profile_seed import seed_profiles_from_registry
    from models import AnalysisProfile
    before = seeded.query(AnalysisProfile).count()
    seed_profiles_from_registry(seeded)
    assert seeded.query(AnalysisProfile).count() == before


def test_seed_preserves_is_addon_for_primaries(seeded):
    from models import AnalysisProfile
    for key in ("hplcpurity_identity", "bac_water_panel"):
        p = seeded.query(AnalysisProfile).filter_by(key=key).one()
        assert p.is_addon is False


# Spec-3 (catalog_demand / profile_seed backfill) sets fulfillment_role="hplc"
# on these two HPLC-family primaries so derive_base_demand_catalog can
# attribute their vial demand; PRODUCT_REGISTRY's frozen ProductDef keeps
# fulfillment_role=None (it never gets that backfill). This is the one known,
# intentional divergence between the legacy and catalog product lookups —
# every other field for every other key must still match exactly.
_SPEC3_ROLE_BACKFILL = {"hplcpurity_identity": "hplc", "bac_water_panel": "hplc"}


@pytest.mark.parametrize("package", PACKAGES)
def test_parity_across_every_service_combination(seeded, package):
    """Legacy path vs profiles path must be byte-identical, except the known
    spec-3 fulfillment_role backfill on the two HPLC-family primaries."""
    from sub_samples.product_registry import build_ordered_products
    for r in range(len(SERVICE_KEYS) + 1):
        for combo in itertools.combinations(SERVICE_KEYS, r):
            services = {k: True for k in combo}
            legacy = build_ordered_products(services, package)
            catalog = build_ordered_products(services, package, db=seeded)
            expected = [
                {**p, "fulfillment_role": _SPEC3_ROLE_BACKFILL.get(p["key"], p["fulfillment_role"])}
                for p in legacy
            ]
            assert catalog == expected, f"drift for {combo} / package={package}"


def test_unregistered_service_key_still_renders_fail_open(seeded):
    """An unknown key must be SYNTHESISED, not dropped and not raised. This
    feeds the sample page's PRODUCTS section; a miss must never 500."""
    from sub_samples.product_registry import build_ordered_products
    out = build_ordered_products({"brand_new_thing": True}, None, db=seeded)
    keys = [p["key"] for p in out]
    assert "brand_new_thing" in keys


def test_unregistered_package_still_renders_fail_open(seeded):
    from sub_samples.product_registry import build_ordered_products
    out = build_ordered_products({}, "mystery_bundle", db=seeded)
    keys = [p["key"] for p in out]
    assert "mystery_bundle" in keys


# ─── rider-aware ride_host_roles (spec 2026-08-20-rider-vial-visibility) ─────

def test_rider_profile_ride_host_roles_populated(db_session):
    """A db-seeded RIDER profile (fulfills on a HOST role's vial, not its own)
    carries its priority-ordered ride list on the resolved ProductDef, so the
    sample-page banner can check ride hosts instead of the rider's own role."""
    from models import AnalysisProfile, profile_ride_hosts
    from sub_samples.product_registry import build_ordered_products

    rider = AnalysisProfile(key="fentanyl", name="Fentanyl", is_addon=True,
                            vials_required=0, fulfillment_role="fentanyl",
                            fulfillment_dim="role", active=True)
    db_session.add(rider)
    db_session.flush()
    db_session.execute(profile_ride_hosts.insert().values(
        analysis_profile_id=rider.id, host_role_code="hplc", priority=0))
    db_session.commit()

    out = build_ordered_products({"fentanyl": True}, None, db=db_session)
    v = [p for p in out if p["key"] == "fentanyl"][0]
    assert v["ride_host_roles"] == ["hplc"]


def test_legacy_key_has_empty_ride_host_roles(seeded):
    """A legacy PRODUCT_REGISTRY key (no ride list row) resolves with an
    empty ride_host_roles, both via the db-backed lookup and the static
    fallback — no false rider-fulfillment for products that self-mint."""
    from sub_samples.product_registry import build_ordered_products
    out_db = build_ordered_products({"hplcpurity_identity": True}, None, db=seeded)
    v_db = [p for p in out_db if p["key"] == "hplcpurity_identity"][0]
    assert v_db["ride_host_roles"] == []

    out_legacy = build_ordered_products({"hplcpurity_identity": True}, None)
    v_legacy = [p for p in out_legacy if p["key"] == "hplcpurity_identity"][0]
    assert v_legacy["ride_host_roles"] == []
