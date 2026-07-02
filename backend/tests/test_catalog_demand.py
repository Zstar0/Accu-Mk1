"""Catalog 1D Task 1: the catalog-driven base-demand shadow-resolver.

Live Postgres (1C sterility tenant seeded at boot). Read-only — the two
sterility groups ("Sterility PCR", "Sterility USP<71>") each carry
vials_required=1 in the Microbiology department (verified 2026-07-02).

This is a SHADOW resolver: dead-until-wired (no order-flow caller in 1D).
The parity contract below scopes the §247 gate — legacy 'always both' == 2,
new single-product == 1 (NOT a regression).
"""
import pytest

from database import SessionLocal
from catalog.demand import catalog_base_demand
from sub_samples.service import derive_base_demand

# The two catalog assignable units that make up the sterility family (1C seed).
_PCR = "Sterility PCR"
_USP71 = "Sterility USP<71>"


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


# ── PARITY SET (§247): legacy sterility_pcr flag ≡ BOTH units ordered ──────────
# Every in-flight/existing sample was ordered under the "always both" regime.
# The catalog reproduces the legacy ster:2 as an additive 1+1 sum.
def test_parity_both_units_reproduce_legacy_two_vials(db):
    catalog = catalog_base_demand(db, [_PCR, _USP71])
    legacy = derive_base_demand({"sterility_pcr": True})
    assert catalog["ster"] == 2
    assert catalog["ster"] == legacy["ster"], (
        "catalog demand for both sterility units must reproduce the legacy "
        "sterility_pcr flag's ster:2 (the §247 parity contract)"
    )


def test_parity_no_sterility_is_zero(db):
    assert catalog_base_demand(db, [])["ster"] == 0
    assert derive_base_demand({"sterility_pcr": False})["ster"] == 0


# ── NEW-BEHAVIOR SET (§247): single-product orders demand 1 vial — NOT a ───────
# regression. These are OUTSIDE the parity set on purpose (arrives with 1D/1F).
def test_new_pcr_only_demands_one_vial(db):
    assert catalog_base_demand(db, [_PCR])["ster"] == 1


def test_new_usp71_only_demands_one_vial(db):
    assert catalog_base_demand(db, [_USP71])["ster"] == 1


# ── Plumbing guards ────────────────────────────────────────────────────────────
def test_returns_full_bucket_dict_shape(db):
    d = catalog_base_demand(db, [_PCR, _USP71])
    assert set(d.keys()) == {"hplc", "endo", "ster"}
    # Phase-1: sterility is the only catalog-driven family, so hplc/endo stay 0.
    assert d["hplc"] == 0 and d["endo"] == 0


def test_unknown_unit_name_is_skipped_not_raised(db):
    # A bogus/non-assignable unit contributes 0 and never raises (robustness).
    assert catalog_base_demand(db, ["Nonexistent Group ZZ"])["ster"] == 0
    # Non-assignable seeded groups (Analytics/Microbiology have NULL vials) → 0.
    assert catalog_base_demand(db, ["Microbiology", _PCR])["ster"] == 1
