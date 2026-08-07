"""Tests for lims_analyses/parent_placeholders.py.

Task 2 fixtures are self-contained in-memory SQLite, modelled on
test_catalog_demand.py's `db_session` idiom (models.py registers
AnalysisProfile/AnalysisService on Base.metadata before create_all(), so this
file needs no live DB and no other test's seeded catalog state). That
isolation is deliberate here specifically because the idempotency + origin-
filter assertions need `origin` pinned exactly — 'mk1' for the native
profile, genuinely 'senaite' for the legacy one — rather than whatever the
shared dev catalog happens to contain today.

`seed_parent_placeholders` delegates "what was ordered" entirely to
coa.native_sections._ordered_native_profiles, which excludes a profile
WHOLESALE the moment any one of its member services has origin != 'mk1'
(coa/native_sections.py:66). So the legacy-service test below only needs a
profile with a single genuinely-'senaite' member for the whole profile
(and therefore every service on it) to never reach the minting loop at all.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401 — registers AnalysisProfile/AnalysisService before create_all()
from database import Base
from models import AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample

from lims_analyses.parent_placeholders import PROVENANCE_ORDERED, seed_parent_placeholders


def test_provenance_ordered_is_a_third_distinct_value():
    """Must not collide with the two existing provenances — every safety
    property (promote untouched, COA blind, workflow gates unperturbed)
    depends on it being neither."""
    assert PROVENANCE_ORDERED == "ordered"
    assert PROVENANCE_ORDERED not in ("canonical", "shadow")


# ── Task 2: seed_parent_placeholders ────────────────────────────────────────


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def parent_sample(db):
    parent = LimsSample(sample_id="TEST-PLACEHOLDER-PARENT", sample_type="x", status="received")
    db.add(parent)
    db.commit()
    db.refresh(parent)
    return parent


def _mk_service(db, *, keyword, title, origin):
    svc = AnalysisService(title=title, keyword=keyword, origin=origin)
    db.add(svc)
    db.commit()
    db.refresh(svc)
    return svc


def _mk_profile(db, *, key, name, members, coa_archetype="limit_table"):
    prof = AnalysisProfile(
        key=key, name=name, is_addon=True, coa_archetype=coa_archetype,
    )
    for svc in members:
        prof.analysis_services.append(svc)
    db.add(prof)
    db.commit()
    db.refresh(prof)
    return prof


@pytest.fixture
def usp71_profile(db):
    """A native (origin='mk1') sterility profile, reportable on the COA
    (coa_archetype set) — the shape _ordered_native_profiles requires to
    return it at all."""
    svc = _mk_service(db, keyword="STER-USP71", title="Sterility (USP<71>)", origin="mk1")
    return _mk_profile(db, key="sterility_usp71", name="Sterility USP<71>", members=[svc])


def test_mints_one_row_per_ordered_native_service(db, parent_sample, usp71_profile):
    stats = seed_parent_placeholders(
        db, parent=parent_sample, services={"sterility_usp71": True}
    )
    db.commit()
    rows = db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent_sample.id, provenance=PROVENANCE_ORDERED
    ).all()
    assert stats["created"] == 1
    assert len(rows) == 1
    r = rows[0]
    assert r.lims_sub_sample_pk is None
    assert r.review_state == "unassigned"
    assert r.result_value is None
    assert r.retest_of_id is None


def test_is_idempotent(db, parent_sample, usp71_profile):
    seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    stats = seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": True})
    db.commit()
    assert stats["created"] == 0 and stats["existing"] == 1
    assert db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent_sample.id, provenance=PROVENANCE_ORDERED
    ).count() == 1


def test_unordered_service_mints_nothing(db, parent_sample, usp71_profile):
    stats = seed_parent_placeholders(db, parent=parent_sample, services={"sterility_usp71": False})
    db.commit()
    assert stats["created"] == 0
    assert db.query(LimsAnalysis).filter_by(provenance=PROVENANCE_ORDERED).count() == 0


def test_legacy_senaite_service_is_not_placeheld(db, parent_sample):
    """endotoxin/sterility_pcr are SENAITE-sourced — they already get a
    'shadow' row from the registration mirror. Double-placeholding them
    would put two pending rows on the same parent line.

    The 'endotoxin' member service is built with origin='senaite' for real
    (not origin='mk1' with the intent hand-waved) so this proves the actual
    origin gate in _ordered_native_profiles, not a fixture that begs the
    question.
    """
    svc = _mk_service(db, keyword="ENDO-LAL", title="Endotoxin (LAL)", origin="senaite")
    _mk_profile(db, key="endotoxin", name="Endotoxin", members=[svc])

    stats = seed_parent_placeholders(db, parent=parent_sample, services={"endotoxin": True})
    db.commit()
    assert stats["created"] == 0
