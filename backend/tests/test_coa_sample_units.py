"""coa.sample_units: the form icon, the unit word and the vial count a
certificate prints in its page 1 header (Handler rulings, 2026-11-13)."""
from __future__ import annotations

from typing import get_args

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import coa.wire_document as wd
from coa.sample_units import DEFAULT_WORDS, UNIT_WORDS, build_sample_units, unit_words
from database import Base
from models import AnalysisProfile, LimsSample, LimsSampleForm, LimsSubSample
from sample_forms.routes import FormIcon


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


NAMES = {"powder_vial": "Lyophilized Powder", "pen": "Pen", "capsule": "Capsule",
         "nasal_spray": "Nasal Spray"}


def _parent(db, *, icon=None, form=True, container=True, sample_id="P-5010"):
    form_id = None
    if form:
        f = LimsSampleForm(name=NAMES.get(icon, f"Form {icon}"), route="injectable", icon=icon)
        db.add(f)
        db.flush()
        form_id = f.id
    parent = LimsSample(sample_id=sample_id, external_lims_uid=f"uid-{sample_id}",
                        sample_form_id=form_id, container_mode=container)
    db.add(parent)
    db.flush()
    return parent


def _vials(db, parent, plan):
    """plan: (role, kind, in_set) per vial, in vial order."""
    for seq, (role, kind, in_set) in enumerate(plan, start=1):
        db.add(LimsSubSample(
            parent_sample_pk=parent.id, external_lims_uid=f"mk1://v{seq}",
            sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
            assignment_role=role, assignment_kind=kind, in_variance_set=in_set))
    db.flush()


# P-5010 on the variance stack: seven vials, one test each.
P5010 = [("hplc", "core", True), ("endo85", "core", False), ("pcr", "core", False),
         ("hplc", "variance", True), ("endo85", "variance", True),
         ("endo85", "variance", True), ("pcr", "variance", True)]


def test_every_form_icon_has_a_word():
    assert set(UNIT_WORDS) == set(get_args(FormIcon))


def test_counts_every_vial_a_printed_test_used(db):
    parent = _parent(db, icon="powder_vial")
    _vials(db, parent, P5010)
    assert build_sample_units(db, parent, {"sections": []}) == {
        "icon": "powder_vial", "one": "Vial", "many": "Vials", "form": "Lyophilized Powder",
        "count": 7, "variance": True}


def test_deferred_section_vials_do_not_count(db):
    parent = _parent(db, icon="powder_vial")
    _vials(db, parent, P5010)
    db.add_all([
        AnalysisProfile(key="endotoxin-usp85-lal", name="Endotoxin", is_addon=True,
                        fulfillment_role="endo85"),
        AnalysisProfile(key="rapid-sterility-pcr", name="Rapid PCR", is_addon=True,
                        fulfillment_role="pcr")])
    db.flush()
    doc = {"sections": [], "deferred_sections": ["endotoxin-usp85-lal", "rapid-sterility-pcr"]}
    units = build_sample_units(db, parent, doc)
    assert units["count"] == 2 and units["variance"] is True  # the two HPLC vials


def test_unused_and_excluded_vials_do_not_count(db):
    parent = _parent(db, icon="pen")
    _vials(db, parent, [("hplc", "core", True), ("hplc", "variance", False),
                        ("xtra", None, True), (None, None, True)])
    units = build_sample_units(db, parent, {})
    assert units == {"icon": "pen", "one": "Pen", "many": "Pens", "form": "Pen", "count": 1,
                     "variance": False}


def test_parent_that_is_vial_one_counts_once(db):
    parent = _parent(db, icon="powder_vial", container=False)
    _vials(db, parent, [("hplc", "variance", True), ("hplc", "variance", True)])
    assert build_sample_units(db, parent, {})["count"] == 3


def test_nothing_to_count_sends_the_word_only(db):
    parent = _parent(db, icon="capsule")
    assert build_sample_units(db, parent, {}) == {
        "icon": "capsule", "one": "Capsule", "many": "Capsules", "form": "Capsule"}
    # No form: today's word, no icon and no form name.
    bare = _parent(db, form=False, sample_id="P-5011")
    assert build_sample_units(db, bare, {}) == {"one": "Vial", "many": "Vials"}
    assert unit_words(db, bare) == DEFAULT_WORDS


def test_one_vial_certificate_is_one_unit(db):
    parent = _parent(db, icon="nasal_spray")
    _vials(db, parent, P5010)
    assert build_sample_units(db, parent, single_vial=True) == {
        "icon": "nasal_spray", "one": "Nasal Spray", "many": "Nasal Sprays",
        "form": "Nasal Spray", "count": 1, "variance": False}


def test_wire_document_carries_the_block_and_survives_a_failure(db, monkeypatch):
    parent = _parent(db, icon="powder_vial")
    _vials(db, parent, P5010)
    monkeypatch.setattr(wd, "build_native_sections",
                        lambda db, p: {"sample_id": p.sample_id, "ordered_profiles": [],
                                       "sections": []})
    monkeypatch.setattr(wd, "coa_generation_source", lambda db: "senaite")
    assert wd.build_coa_wire_document(db, parent)["sample_units"]["count"] == 7

    def boom(*a, **kw):
        raise RuntimeError("lookup failed")

    monkeypatch.setattr(wd, "build_sample_units", boom)
    doc = wd.build_coa_wire_document(db, parent)
    assert "sample_units" not in doc and doc["sections"] == []  # cosmetic: never blocks
