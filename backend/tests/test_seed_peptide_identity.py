"""Tests for per-peptide identity service seeding (RETIRED).

OBSOLETE: this module covered the _seed_peptide_identity_services helper and
select_identity_service_by_title, which seeded a single Analyte1 identity
service onto an HPLC vial from lims_samples.peptide_name. That path was
removed when the HPLC branch was reworked to MIRROR the parent's full
Analytics analyte set (per-analyte ID_*/PUR/QTY, BLEND-PUR, PEPT-Total,
HPLC-ID) from the parent SENAITE sample. The replacement behavior — including
the identity services these tests used to assert — is covered in
test_seeder_mirror.py.

The whole module is skipped at collection because its module-top imports
reference the now-deleted helpers. Kept (rather than deleted) as a tombstone
documenting the retired contract.
"""

from __future__ import annotations

import pytest

pytest.skip(
    "per-peptide identity seeding retired by the HPLC parent-mirror; "
    "behavior now covered in test_seeder_mirror.py",
    allow_module_level=True,
)

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from database import Base
from lims_analyses.seeder import (
    _seed_peptide_identity_services,
    seed_analyses_for_vial,
    select_identity_service_by_title,
)
from models import AnalysisService, LimsAnalysis, LimsSample, LimsSubSample


# ── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    yield s
    s.close()


@pytest.fixture()
def generic_services(db):
    """Insert HPLC-PUR and HPLC-ID generic services into the catalog."""
    pur = AnalysisService(title="HPLC Purity", keyword="HPLC-PUR", active=True)
    hid = AnalysisService(title="HPLC Identity", keyword="HPLC-ID", active=True)
    db.add_all([pur, hid])
    db.commit()
    return pur, hid


@pytest.fixture()
def bpc157_identity_service(db):
    """Insert the per-peptide BPC-157 Identity service using the load-bearing title."""
    svc = AnalysisService(
        title="BPC-157 - Identity (HPLC)",
        keyword="ID_BPC157",
        active=True,
    )
    db.add(svc)
    db.commit()
    return svc


@pytest.fixture()
def parent_with_peptide(db):
    """LimsSample whose peptide_name matches the BPC-157 identity service title."""
    parent = LimsSample(
        sample_id="P-TEST-001",
        external_lims_uid="uid-parent-001",
        peptide_name="BPC-157 - Identity (HPLC)",
    )
    db.add(parent)
    db.commit()
    return parent


@pytest.fixture()
def sub_sample(db, parent_with_peptide):
    """LimsSubSample linked to the BPC-157 parent."""
    sub = LimsSubSample(
        parent_sample_pk=parent_with_peptide.id,
        external_lims_uid="uid-sub-001",
        sample_id="P-TEST-001-S01",
        vial_sequence=1,
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return sub


# ── Tests: select_identity_service_by_title ─────────────────────────────────


def test_select_identity_service_by_title_finds_exact_match(db, bpc157_identity_service):
    svc = select_identity_service_by_title(db, "BPC-157 - Identity (HPLC)")
    assert svc is not None
    assert svc.keyword == "ID_BPC157"


def test_select_identity_service_by_title_returns_none_for_unknown(db, bpc157_identity_service):
    svc = select_identity_service_by_title(db, "ZZZ-UNKNOWN - Identity (HPLC)")
    assert svc is None


# ── Tests: _seed_peptide_identity_services ───────────────────────────────────


def test_seed_peptide_identity_inserts_row_for_known_analyte(
    db, bpc157_identity_service, sub_sample
):
    """HPLC seed adds the matching per-peptide ID service by title."""
    inserted = _seed_peptide_identity_services(
        db,
        sub_sample=sub_sample,
        existing_kw=set(),
        created_by_user_id=None,
    )
    assert len(inserted) == 1
    row = inserted[0]
    assert row.keyword == "ID_BPC157"
    assert row.lims_sub_sample_pk == sub_sample.id
    assert row.review_state == "unassigned"


def test_seed_peptide_identity_skips_when_no_peptide_name(db, bpc157_identity_service):
    """Parent with no peptide_name → no ID row, no error."""
    parent = LimsSample(
        sample_id="P-NOPEPTIDE-001",
        external_lims_uid="uid-no-peptide",
        peptide_name=None,
    )
    db.add(parent)
    db.commit()
    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="uid-nop-sub",
        sample_id="P-NOPEPTIDE-001-S01",
        vial_sequence=1,
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)

    inserted = _seed_peptide_identity_services(
        db,
        sub_sample=sub,
        existing_kw=set(),
        created_by_user_id=None,
    )
    assert inserted == []


def test_seed_peptide_identity_skips_unmatched_analyte_name_without_error(
    db, bpc157_identity_service
):
    """Unrecognised analyte name → skips silently, no exception."""
    parent = LimsSample(
        sample_id="P-UNKNOWN-001",
        external_lims_uid="uid-unknown",
        peptide_name="ZZZ-NOTAPEPTIDE - Identity (HPLC)",
    )
    db.add(parent)
    db.commit()
    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid="uid-unk-sub",
        sample_id="P-UNKNOWN-001-S01",
        vial_sequence=1,
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)

    inserted = _seed_peptide_identity_services(
        db,
        sub_sample=sub,
        existing_kw=set(),
        created_by_user_id=None,
    )
    assert inserted == []


def test_seed_peptide_identity_idempotent_on_re_seed(
    db, bpc157_identity_service, sub_sample
):
    """Re-seeding returns nothing when the keyword is already in existing_kw."""
    # First seed
    first = _seed_peptide_identity_services(
        db,
        sub_sample=sub_sample,
        existing_kw=set(),
        created_by_user_id=None,
    )
    assert len(first) == 1

    # Second seed: pass the now-occupied keyword set
    second = _seed_peptide_identity_services(
        db,
        sub_sample=sub_sample,
        existing_kw={"ID_BPC157"},
        created_by_user_id=None,
    )
    assert second == []

    # Confirm only one lims_analyses row exists
    rows = db.execute(
        select(LimsAnalysis).where(LimsAnalysis.lims_sub_sample_pk == sub_sample.id)
    ).scalars().all()
    assert len(rows) == 1


# ── Tests: seed_analyses_for_vial integration ────────────────────────────────


def test_hplc_seed_includes_peptide_identity_service(
    db, generic_services, bpc157_identity_service, sub_sample
):
    """seed_analyses_for_vial for hplc role inserts generic + per-peptide rows."""
    inserted = seed_analyses_for_vial(
        db,
        sub_sample=sub_sample,
        role="hplc",
        wp_services={"hplcpurity_identity": True},
    )
    keywords = {r.keyword for r in inserted}
    assert "ID_BPC157" in keywords, f"per-peptide ID missing; got {keywords}"
    # Generic services also present
    assert "HPLC-PUR" in keywords
    assert "HPLC-ID" in keywords


def test_hplc_seed_idempotent_on_reseed(
    db, generic_services, bpc157_identity_service, sub_sample
):
    """Calling seed_analyses_for_vial twice inserts nothing the second time."""
    first = seed_analyses_for_vial(
        db,
        sub_sample=sub_sample,
        role="hplc",
        wp_services={"hplcpurity_identity": True},
    )
    assert len(first) == 3  # HPLC-PUR, HPLC-ID, ID_BPC157

    second = seed_analyses_for_vial(
        db,
        sub_sample=sub_sample,
        role="hplc",
        wp_services={"hplcpurity_identity": True},
    )
    assert second == []


def test_non_hplc_role_does_not_seed_peptide_identity(
    db, generic_services, bpc157_identity_service, sub_sample
):
    """Non-hplc roles (endo, ster) never seed the per-peptide ID service."""
    # Add ENDO-LAL service so endo seeding has something to find
    endo = AnalysisService(title="Endotoxin LAL", keyword="ENDO-LAL", active=True)
    db.add(endo)
    db.commit()

    inserted = seed_analyses_for_vial(
        db,
        sub_sample=sub_sample,
        role="endo",
        wp_services={"endotoxin": True},
    )
    keywords = {r.keyword for r in inserted}
    assert "ID_BPC157" not in keywords, f"ID_BPC157 should not be seeded for endo; got {keywords}"
