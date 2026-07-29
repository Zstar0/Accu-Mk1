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


@pytest.mark.parametrize("package", PACKAGES)
def test_parity_across_every_service_combination(seeded, package):
    """Legacy path vs profiles path must be byte-identical."""
    from sub_samples.product_registry import build_ordered_products
    for r in range(len(SERVICE_KEYS) + 1):
        for combo in itertools.combinations(SERVICE_KEYS, r):
            services = {k: True for k in combo}
            legacy = build_ordered_products(services, package)
            catalog = build_ordered_products(services, package, db=seeded)
            assert catalog == legacy, f"drift for {combo} / package={package}"


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
