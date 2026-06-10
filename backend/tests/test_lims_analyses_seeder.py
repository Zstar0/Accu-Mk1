"""Tests for the lims_analyses seeder.

Pure-logic tests cover the WP-key/role table without touching the DB.
The catalog-filter + seed_analyses_for_vial paths run against the live
subvial DB.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select

from database import SessionLocal
from lims_analyses.seeder import (
    ROLE_TO_KEYWORDS,
    ROLE_TO_WP_KEYS,
    role_implies_seeding,
    seed_analyses_for_vial,
    select_services_for_role,
)
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSubSample


@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture
def sub_sample(db):
    sub = db.execute(select(LimsSubSample).limit(1)).scalar_one_or_none()
    if sub is None:
        pytest.skip("no lims_sub_samples row available")
    return sub


@pytest.fixture(autouse=True)
def cleanup(db):
    """Each seeder test that creates rows tags them by re-writing the title
    to start with 'SEEDER-TEST:' after seeding. Cleanup matches that tag.
    Cascade FK removes the matching LimsAnalysisTransition rows."""
    yield
    db.execute(delete(LimsAnalysis).where(
        LimsAnalysis.title.like("%SEEDER-TEST%")
    ))
    db.commit()


# ── pure logic ──────────────────────────────────────────────────────────────


def test_role_implies_seeding_hplc_yes_when_bac_water_panel():
    assert role_implies_seeding("hplc", {"bac_water_panel": True})


def test_role_implies_seeding_hplc_yes_when_hplcpurity_identity():
    assert role_implies_seeding("hplc", {"hplcpurity_identity": True})


def test_role_implies_seeding_hplc_no_when_neither():
    assert not role_implies_seeding("hplc", {"endotoxin": True, "sterility_pcr": True})


def test_role_implies_seeding_endo_yes_when_endotoxin():
    assert role_implies_seeding("endo", {"endotoxin": True})


def test_role_implies_seeding_ster_yes_when_sterility_pcr():
    assert role_implies_seeding("ster", {"sterility_pcr": True})


def test_role_implies_seeding_xtra_always_no():
    assert not role_implies_seeding("xtra", {"hplcpurity_identity": True, "endotoxin": True})


def test_role_implies_seeding_null_role_no():
    assert not role_implies_seeding(None, {"hplcpurity_identity": True})


# ── live catalog filter ─────────────────────────────────────────────────────


def test_select_services_for_hplc_returns_nothing(db):
    # HPLC is no longer whitelist-driven: it mirrors the parent's Analytics
    # analyte set (see mirror_parent_hplc_analyses / test_seeder_mirror.py), so
    # "hplc" was removed from ROLE_TO_KEYWORDS and select_services_for_role is
    # empty for it.
    assert select_services_for_role(db, "hplc") == []


def test_select_services_for_endo_returns_endo_lal(db):
    rows = select_services_for_role(db, "endo")
    if not rows:
        pytest.skip("ENDO-LAL not in this env's analysis_services")
    assert {r.keyword for r in rows} == {"ENDO-LAL"}


def test_select_services_for_ster_returns_ster_pcr(db):
    rows = select_services_for_role(db, "ster")
    if not rows:
        pytest.skip("STER-PCR not in this env's analysis_services")
    assert {r.keyword for r in rows} == {"STER-PCR"}


def test_select_services_for_xtra_returns_nothing(db):
    assert select_services_for_role(db, "xtra") == []


# ── seed_analyses_for_vial integration ──────────────────────────────────────


@pytest.mark.skip(
    reason="HPLC no longer seeds a generic HPLC-PUR/HPLC-ID whitelist; it mirrors "
    "the parent's analyte set. Mirror behavior is covered in "
    "test_seeder_mirror.py (test_mirror_seeds_analyte_rows_and_excludes_micro)."
)
def test_seed_for_hplc_creates_lims_analyses_rows(db, sub_sample):
    pass


@pytest.mark.skip(
    reason="HPLC seeding is now the parent-mirror path; idempotency is covered in "
    "test_seeder_mirror.py (test_mirror_is_idempotent)."
)
def test_seed_is_idempotent(db, sub_sample):
    pass


def test_seed_xtra_inserts_nothing(db, sub_sample):
    inserted = seed_analyses_for_vial(
        db, sub_sample=sub_sample, role="xtra",
        wp_services={"hplcpurity_identity": True, "endotoxin": True},
    )
    assert inserted == []


def test_seed_role_without_wp_request_inserts_nothing(db, sub_sample):
    """If the WP profile doesn't ask for HPLC, an HPLC-role vial seeds nothing."""
    inserted = seed_analyses_for_vial(
        db, sub_sample=sub_sample, role="hplc",
        wp_services={"endotoxin": True},  # no HPLC requested
    )
    assert inserted == []
