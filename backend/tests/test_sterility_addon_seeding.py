"""Catalog 1D Task 3: addon-aware sterility seeding within the ster bucket.

Live Postgres (1C tenant seeded). Read-only. The legacy path (no
ordered_products kwarg) stays byte-identical; the new path resolves member
services from the ordered catalog groups.
"""
import pytest

from database import SessionLocal
from lims_analyses.seeder import select_services_for_role


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _kw(services):
    return {s.keyword for s in services}


# ── Legacy path unchanged (no kwarg) ───────────────────────────────────────────
def test_legacy_ster_role_still_selects_ster_pcr(db):
    assert _kw(select_services_for_role(db, "ster")) == {"STER-PCR"}


# ── Addon-aware: PCR-only seeds Fungi + Bacteria (not USP71) ────────────────────
def test_pcr_only_seeds_fungi_bacteria(db):
    services = select_services_for_role(db, "ster", ordered_products={"sterility_pcr"})
    assert _kw(services) == {"PCR-FUNGI", "PCR-BACTERIA"}


# ── Addon-aware: USP71-only seeds USP71 (not Fungi/Bacteria) ────────────────────
def test_usp71_only_seeds_usp71(db):
    services = select_services_for_role(db, "ster", ordered_products={"sterility_usp71"})
    assert _kw(services) == {"STER-USP71"}


# ── Addon-aware: both products seed all three member services ───────────────────
def test_both_products_seed_all_three(db):
    services = select_services_for_role(
        db, "ster", ordered_products={"sterility_pcr", "sterility_usp71"})
    assert _kw(services) == {"PCR-FUNGI", "PCR-BACTERIA", "STER-USP71"}


# ── Empty ordered set seeds nothing (no cross-contamination) ────────────────────
def test_empty_products_seeds_nothing(db):
    assert select_services_for_role(db, "ster", ordered_products=set()) == []
