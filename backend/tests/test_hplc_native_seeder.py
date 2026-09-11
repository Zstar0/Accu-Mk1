"""seed_analyses_for_vial forks on native-born parents (spec 2026-09-10 M4);
SENAITE-born parents still hit mirror_parent_hplc_analyses byte-identically."""
import json
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models  # noqa: F401
from models import AnalysisService, Base, Department, LimsAnalysis, LimsSample, LimsSubSample, Peptide


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
    from catalog.hplc_native_seed import HPLC_NATIVE_SERVICES
    dept = Department(name="Analytical"); db.add(dept); db.flush()
    for kw, title, unit, rtype, vc in HPLC_NATIVE_SERVICES:
        db.add(AnalysisService(title=title, keyword=kw, unit=unit, result_type=rtype,
                               origin="mk1", variance_capable=vc, department_id=dept.id))
    db.add(Peptide(name="BPC-157", abbreviation="BPC157"))
    db.add(Peptide(name="TB-500", abbreviation="TB500"))
    db.flush()


def _parent(db, *, system, analytes, sample_id):
    p = LimsSample(sample_id=sample_id, external_lims_system=system, sample_type_title="Peptide",
                   external_lims_uid=None if system == "mk1" else f"uid-{sample_id}",
                   analytes=json.dumps(analytes))
    db.add(p); db.flush()
    return p


def _vial(db, parent, seq=1, role="hplc"):
    v = LimsSubSample(sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
                      parent_sample_pk=parent.id, external_lims_uid=f"zz-{parent.sample_id}-{seq}",
                      assignment_role=role)
    db.add(v); db.flush()
    return v


WP = {"hplc-purity-identity": True}


def test_native_born_hplc_vial_seeds_trio_not_mirror(db, monkeypatch):
    from lims_analyses import seeder
    _catalog(db)
    called = []
    monkeypatch.setattr(seeder, "mirror_parent_hplc_analyses",
                        lambda *a, **k: called.append(1) or [])
    p = _parent(db, system="mk1", sample_id="P-5000",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "10"}])
    v = _vial(db, p)
    rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=WP,
                                         parent_sample_id=p.sample_id, commit=False)
    assert called == []
    assert sorted(r.keyword for r in rows) == ["HPLC-IDENTITY", "HPLC-PURITY", "HPLC-QUANTITY"]
    assert {r.slot for r in rows} == {1}


def test_native_born_blend_seeds_per_slot_plus_aggregates(db):
    from lims_analyses import seeder
    _catalog(db)
    p = _parent(db, system="mk1", sample_id="PB-1000",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": "5"},
                          {"name": "TB-500 - Identity (HPLC)", "declared_quantity": "5"}])
    v = _vial(db, p)
    rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=WP,
                                         parent_sample_id=p.sample_id, commit=False)
    assert len(rows) == 8
    assert sorted((r.keyword, r.slot) for r in rows if r.slot) == [
        ("HPLC-IDENTITY", 1), ("HPLC-IDENTITY", 2), ("HPLC-PURITY", 1), ("HPLC-PURITY", 2),
        ("HPLC-QUANTITY", 1), ("HPLC-QUANTITY", 2)]


def test_native_born_seed_is_idempotent_on_rerun(db):
    from lims_analyses import seeder
    _catalog(db)
    p = _parent(db, system="mk1", sample_id="PB-1001",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None},
                          {"name": "TB-500 - Identity (HPLC)", "declared_quantity": None}])
    v = _vial(db, p)
    first = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=WP,
                                          parent_sample_id=p.sample_id, commit=False)
    second = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=WP,
                                           parent_sample_id=p.sample_id, commit=False)
    assert len(first) == 8 and second == []


def test_senaite_born_parent_still_uses_the_mirror(db, monkeypatch):
    from lims_analyses import seeder
    _catalog(db)
    seen = {}
    def fake_mirror(db_, *, sub_sample, parent_sample_id, existing_kw, existing_service_ids, **k):
        seen["parent"] = parent_sample_id
        seen["kw_type"] = type(next(iter(existing_kw))) if existing_kw else None
        return []
    monkeypatch.setattr(seeder, "mirror_parent_hplc_analyses", fake_mirror)
    p = _parent(db, system="senaite", sample_id="P-0141",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None}])
    v = _vial(db, p)
    seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services={"hplcpurity_identity": True},
                                  parent_sample_id=p.sample_id, commit=False)
    assert seen["parent"] == "P-0141"
    assert seen["kw_type"] is tuple


def test_native_born_without_parent_sample_id_does_not_raise(db):
    """The legacy mirror raised ValueError without a parent id; a native-born
    parent is resolved from the vial itself."""
    from lims_analyses import seeder
    _catalog(db)
    p = _parent(db, system="mk1", sample_id="P-5002",
                analytes=[{"name": "BPC-157 - Identity (HPLC)", "declared_quantity": None}])
    v = _vial(db, p)
    rows = seeder.seed_analyses_for_vial(db, sub_sample=v, role="hplc", wp_services=WP, commit=False)
    assert len(rows) == 3


def test_legacy_dedupe_still_blocks_same_keyword_reseed(db):
    """Slot-NULL legacy rows compare as slot 0 — a second seed of the same
    keyword is still skipped (byte-identical legacy behaviour)."""
    from lims_analyses.seeder import _seed_rows_from_services
    _catalog(db)
    p = _parent(db, system="senaite", sample_id="P-0142", analytes=[])
    v = _vial(db, p, role="hm")
    svc = db.query(AnalysisService).filter_by(keyword="HPLC-PURITY").one()
    kw, ids = set(), set()
    a = _seed_rows_from_services(db, sub_sample=v, services=[svc], existing_kw=kw, existing_service_ids=ids,
                                 created_by_user_id=None, commit=False, log_event="t")
    b = _seed_rows_from_services(db, sub_sample=v, services=[svc], existing_kw=kw, existing_service_ids=ids,
                                 created_by_user_id=None, commit=False, log_event="t")
    assert len(a) == 1 and b == [] and ("HPLC-PURITY", 0) in kw and (svc.id, 0) in ids
