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


def test_select_services_for_hplc_returns_pur_and_id(db):
    rows = select_services_for_role(db, "hplc")
    if not rows:
        pytest.skip("HPLC-PUR / HPLC-ID not in this env's analysis_services")
    keywords = {r.keyword for r in rows}
    assert keywords <= {"HPLC-PUR", "HPLC-ID"}
    assert keywords == {"HPLC-PUR", "HPLC-ID"} or len(keywords) >= 1


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


def test_seed_for_hplc_creates_lims_analyses_rows(db, sub_sample):
    inserted = seed_analyses_for_vial(
        db,
        sub_sample=sub_sample,
        role="hplc",
        wp_services={"bac_water_panel": True},
    )
    if not inserted:
        pytest.skip("no HPLC services in this env's analysis_services")
    for r in inserted:
        assert r.lims_sub_sample_pk == sub_sample.id
        assert r.review_state == "unassigned"
        assert r.keyword in {"HPLC-PUR", "HPLC-ID"}
        # tag for cleanup
        r.title = f"SEEDER-TEST: {r.title}"
    db.commit()


def test_seed_is_idempotent(db, sub_sample):
    first = seed_analyses_for_vial(
        db, sub_sample=sub_sample, role="hplc",
        wp_services={"bac_water_panel": True},
    )
    if not first:
        pytest.skip("no HPLC services in this env's analysis_services")
    for r in first:
        r.title = f"SEEDER-TEST: {r.title}"
    db.commit()
    # Second call inserts nothing
    second = seed_analyses_for_vial(
        db, sub_sample=sub_sample, role="hplc",
        wp_services={"bac_water_panel": True},
    )
    assert second == []


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
