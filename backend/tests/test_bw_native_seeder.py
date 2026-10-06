"""seed_analyses_for_vial on a native-born Bac Water parent's hplc vial seeds
the bacteriostatic-water-panel members on the VIAL (spec 2026-10-05 MB4, as
ruled in the plan: parent-tier 'ordered' rows cannot carry a result). The
SENAITE-born BW mirror and the native peptide trio paths are unchanged."""
import json
import logging

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import AnalysisProfile, Base, Department, LimsSample, LimsSubSample


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _catalog(db):
    from catalog.bw_native_seed import seed_bw_native_catalog
    db.add(Department(name="Analytical"))
    db.commit()
    seed_bw_native_catalog(db)


def _parent(db, *, system, sample_id, title="Bacteriostatic Water"):
    p = LimsSample(sample_id=sample_id, external_lims_system=system, sample_type_title=title,
                   external_lims_uid=None if system == "mk1" else f"uid-{sample_id}",
                   analytes=json.dumps([{"name": "Benzyl Alcohol", "declared_quantity": "30"}]))
    db.add(p)
    db.flush()
    return p


def _vial(db, parent, seq=1):
    v = LimsSubSample(sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
                      parent_sample_pk=parent.id, external_lims_uid=f"zz-{parent.sample_id}-{seq}",
                      assignment_role="hplc")
    db.add(v)
    db.flush()
    return v


NATIVE_WP = {"bacteriostatic-water-panel": True, "endotoxin-usp85-lal": True}


def test_native_bw_vial_seeds_panel_not_mirror_not_peptide_trio(db, monkeypatch):
    from lims_analyses import hplc_native, seeder
    _catalog(db)
    called = []
    monkeypatch.setattr(seeder, "mirror_parent_hplc_analyses", lambda *a, **k: called.append("mirror") or [])
    monkeypatch.setattr(hplc_native, "seed_native_hplc_rows", lambda *a, **k: called.append("trio") or [])
    p = _parent(db, system="mk1", sample_id="BW-1000")
    v = _vial(db, p)
    rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=NATIVE_WP,
                                         commit=False)
    assert called == []
    assert sorted((r.keyword, r.slot, r.peptide_id, r.lims_sub_sample_pk) for r in rows) == [
        ("BENZYL-ALCOHOL-BW", None, None, v.id), ("FILL-VOLUME-BW", None, None, v.id),
        ("PH-BW", None, None, v.id)]


def test_native_bw_vial_seed_is_idempotent(db):
    from lims_analyses import seeder
    _catalog(db)
    p = _parent(db, system="mk1", sample_id="BW-1001")
    v = _vial(db, p)
    first = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=NATIVE_WP, commit=False)
    second = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=NATIVE_WP, commit=False)
    assert len(first) == 3 and second == []


def test_native_bw_vial_without_panel_logs_error_and_does_not_raise(db, caplog):
    from lims_analyses import seeder
    db.add(Department(name="Analytical"))
    db.commit()   # no BW seed: profile absent
    p = _parent(db, system="mk1", sample_id="BW-1002")
    v = _vial(db, p)
    with caplog.at_level(logging.ERROR):
        rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=NATIVE_WP,
                                             commit=False)
    assert rows == []
    assert any("seeder.native_bw.no_panel_members" in r.message for r in caplog.records)


def test_native_bw_vial_with_non_mk1_member_seeds_nothing(db, caplog):
    """Origin gate (same as every catalog family): a mixed-origin panel is not native."""
    from lims_analyses import seeder
    from models import AnalysisService
    _catalog(db)
    prof = db.query(AnalysisProfile).filter_by(key="bacteriostatic-water-panel").one()
    prof.analysis_services.append(AnalysisService(title="x", keyword="PH-DETERM", origin="senaite"))
    db.commit()
    p = _parent(db, system="mk1", sample_id="BW-1003")
    v = _vial(db, p)
    with caplog.at_level(logging.ERROR):
        rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=NATIVE_WP,
                                             commit=False)
    assert rows == []
    assert any("seeder.native_bw.no_panel_members" in r.message for r in caplog.records)


def test_senaite_born_bw_vial_still_uses_the_mirror(db, monkeypatch):
    from lims_analyses import seeder
    _catalog(db)
    seen = {}

    def fake_mirror(db_, *, sub_sample, parent_sample_id, **k):
        seen["parent"] = parent_sample_id
        return []
    monkeypatch.setattr(seeder, "mirror_parent_hplc_analyses", fake_mirror)
    p = _parent(db, system="senaite", sample_id="BW-0135")
    v = _vial(db, p)
    rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc",
                                         wp_services={"bac_water_panel": True},
                                         parent_sample_id=p.sample_id, commit=False)
    assert seen == {"parent": "BW-0135"} and rows == []


def test_native_peptide_vial_still_uses_the_trio_path(db, monkeypatch):
    from lims_analyses import hplc_native, seeder
    _catalog(db)
    called = []
    monkeypatch.setattr(hplc_native, "seed_native_hplc_rows", lambda *a, **k: called.append("trio") or [])
    p = _parent(db, system="mk1", sample_id="P-5004", title="Peptide")
    v = _vial(db, p)
    seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc",
                                  wp_services={"hplc-purity-identity": True}, commit=False)
    assert called == ["trio"]


@pytest.mark.parametrize("title", [None, "Peptide"])
def test_bw_routing_keys_on_ordered_profile_not_sample_type_title(db, monkeypatch, title):
    """Handler ruling: the native BW key in the ordered services decides, the title does not."""
    from lims_analyses import hplc_native, seeder
    _catalog(db)
    called = []
    monkeypatch.setattr(hplc_native, "seed_native_hplc_rows", lambda *a, **k: called.append("trio") or [])
    p = _parent(db, system="mk1", sample_id="BW-1010", title=title)
    v = _vial(db, p)
    rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=NATIVE_WP,
                                         commit=False)
    assert called == []
    assert sorted(r.keyword for r in rows) == ["BENZYL-ALCOHOL-BW", "FILL-VOLUME-BW", "PH-BW"]


def test_bw_titled_parent_without_native_key_takes_the_trio_path(db, monkeypatch):
    from lims_analyses import hplc_native, seeder
    _catalog(db)
    called = []
    monkeypatch.setattr(hplc_native, "seed_native_hplc_rows", lambda *a, **k: called.append("trio") or [])
    p = _parent(db, system="mk1", sample_id="BW-1011", title="Bacteriostatic Water")
    v = _vial(db, p)
    rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc",
                                         wp_services={"hplc-purity-identity": True}, commit=False)
    assert called == ["trio"] and rows == []
