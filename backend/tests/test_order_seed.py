"""lims_analyses/order_seed.py — seed native parent placeholders from a
services dict (order upsert / registration signal / heal) + the finder the
heal script uses. Fixture idiom copied from test_parent_placeholders.py."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401 — registers the catalog models before create_all()
from database import Base
from models import AnalysisProfile, AnalysisService, LimsAnalysis, LimsSample, LimsSubSample

from lims_analyses.order_seed import (
    find_parents_missing_native_placeholders,
    seed_parent_from_services,
)
from lims_analyses.parent_placeholders import PROVENANCE_ORDERED


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def parent(db):
    p = LimsSample(sample_id="P-9001", sample_type="x", status="received")
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def _svc(db, keyword, origin="mk1"):
    s = AnalysisService(title=keyword, keyword=keyword, origin=origin)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _profile(db, key, members):
    prof = AnalysisProfile(key=key, name=key, is_addon=True, coa_archetype="limit_table")
    for m in members:
        prof.analysis_services.append(m)
    db.add(prof)
    db.commit()
    db.refresh(prof)
    return prof


@pytest.fixture
def pcr_profile(db):
    return _profile(db, "sterility_pcr", [_svc(db, "STERILITY-PCR")])


def _ordered_rows(db, parent):
    return db.execute(select(LimsAnalysis).where(
        LimsAnalysis.lims_sample_pk == parent.id,
        LimsAnalysis.lims_sub_sample_pk.is_(None),
        LimsAnalysis.provenance == PROVENANCE_ORDERED,
    )).scalars().all()


def test_seeds_one_ordered_row_per_native_member(db, parent, pcr_profile):
    with patch("catalog.snapshot.compute_catalog_snapshot", return_value={"profiles": []}):
        stats = seed_parent_from_services(
            db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
    db.commit()
    assert stats["created"] == 1
    rows = _ordered_rows(db, parent)
    assert [r.keyword for r in rows] == ["STERILITY-PCR"]


def test_second_call_is_idempotent(db, parent, pcr_profile):
    with patch("catalog.snapshot.compute_catalog_snapshot", return_value={"profiles": []}):
        seed_parent_from_services(db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
        db.commit()
        stats = seed_parent_from_services(db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
    db.commit()
    assert stats["created"] == 0 and stats["existing"] == 1
    assert len(_ordered_rows(db, parent)) == 1


def test_snapshot_stamped_once_only(db, parent, pcr_profile):
    with patch("catalog.snapshot.compute_catalog_snapshot", return_value={"profiles": ["first"]}) as snap:
        seed_parent_from_services(db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
        db.commit()
        assert parent.catalog_snapshot == {"profiles": ["first"]}
        snap.return_value = {"profiles": ["second"]}
        seed_parent_from_services(db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
        db.commit()
    assert parent.catalog_snapshot == {"profiles": ["first"]}
    assert snap.call_count == 1


def test_snapshot_failure_keeps_seeded_rows(db, parent, pcr_profile):
    with patch("catalog.snapshot.compute_catalog_snapshot", side_effect=RuntimeError("bad catalog")):
        stats = seed_parent_from_services(
            db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
    db.commit()
    assert stats["created"] == 1
    assert len(_ordered_rows(db, parent)) == 1
    assert parent.catalog_snapshot is None


# ── finder ────────────────────────────────────────────────────────────────


def _vial(db, parent, seq):
    v = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid=f"mk1://{seq}",
                      sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq)
    db.add(v)
    db.commit()
    db.refresh(v)
    return v


def _vial_row(db, vial, svc, state="unassigned"):
    r = LimsAnalysis(lims_sub_sample_pk=vial.id, lims_sample_pk=None,
                     analysis_service_id=svc.id, keyword=svc.keyword, title=svc.title,
                     provenance="canonical", review_state=state)
    db.add(r)
    db.commit()
    return r


def test_finder_reports_parent_with_native_vial_row_and_no_parent_row(db, parent, pcr_profile):
    svc = pcr_profile.analysis_services[0]
    _vial_row(db, _vial(db, parent, 5), svc)
    found = find_parents_missing_native_placeholders(db)
    assert [(p.sample_id, missing) for p, missing in found] == [("P-9001", {svc.id})]


def test_finder_ignores_parent_once_placeholder_exists(db, parent, pcr_profile):
    svc = pcr_profile.analysis_services[0]
    _vial_row(db, _vial(db, parent, 5), svc)
    with patch("catalog.snapshot.compute_catalog_snapshot", return_value={}):
        seed_parent_from_services(db, parent=parent, services={"sterility_pcr": True}, package=None, source="test")
    db.commit()
    assert find_parents_missing_native_placeholders(db) == []


def test_finder_ignores_senaite_origin_and_dead_vial_rows(db, parent):
    legacy = _svc(db, "HPLC-PUR", origin="senaite")
    native = _svc(db, "LEAD-PPM", origin="mk1")
    vial = _vial(db, parent, 1)
    _vial_row(db, vial, legacy)
    _vial_row(db, vial, native, state="rejected")
    assert find_parents_missing_native_placeholders(db) == []
