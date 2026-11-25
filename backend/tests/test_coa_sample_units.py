"""coa.sample_units: the form icon, the unit word and the vial count a
certificate prints in its page 1 header (Handler rulings, 2026-11-13).

The count is a number on a certificate: it is sent only when every vial can
be accounted for, and left off (COABuilder keeps its old header row) when the
rule would have to guess."""
from __future__ import annotations

from typing import get_args

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker

import coa.wire_document as wd
from coa.sample_units import DEFAULT_WORDS, UNIT_WORDS, build_sample_units, unit_words
from database import Base
from models import AnalysisProfile, LimsSample, LimsSampleForm, LimsSubSample
from sample_forms.routes import FormIcon

ENDO, PCR = "endotoxin-usp85-lal", "rapid-sterility-pcr"
NAMES = {"powder_vial": "Lyophilized Powder", "pen": "Pen", "capsule": "Capsule",
         "nasal_spray": "Nasal Spray"}


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _parent(db, *, icon=None, form=True, container=True, sample_id="P-5010", **kw):
    form_id = None
    if form:
        f = LimsSampleForm(name=NAMES.get(icon, f"Form {icon}"), route="injectable", icon=icon)
        db.add(f)
        db.flush()
        form_id = f.id
    parent = LimsSample(sample_id=sample_id, external_lims_uid=f"uid-{sample_id}",
                        sample_form_id=form_id, container_mode=container, **kw)
    db.add(parent)
    db.flush()
    return parent


def _vials(db, parent, plan):
    """plan: (role, kind, in_set) per vial, in vial order."""
    for seq, (role, kind, in_set) in enumerate(plan, start=1):
        db.add(LimsSubSample(
            parent_sample_pk=parent.id, external_lims_uid=f"mk1://{parent.sample_id}/v{seq}",
            sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
            assignment_role=role, assignment_kind=kind, in_variance_set=in_set))
    db.flush()


def _profiles(db, **role_by_key):
    for key, role in role_by_key.items():
        db.add(AnalysisProfile(key=key, name=key, is_addon=True, fulfillment_role=role))
    db.flush()


def _doc(*printed, deferred=(), page1=True):
    doc = {"sections": [{"profile_key": k} for k in printed]}
    if deferred:
        doc["deferred_sections"] = list(deferred)
    if not page1:
        doc["legacy_rows"] = {"source": "mk1", "rows": [], "page1": "none"}
    return doc


# P-5010 on the variance stack: seven vials, one test each.
P5010 = [("hplc", "core", True), ("endo85", "core", False), ("pcr", "core", False),
         ("hplc", "variance", True), ("endo85", "variance", True),
         ("endo85", "variance", True), ("pcr", "variance", True)]


def _p5010(db, **kw):
    parent = _parent(db, icon="powder_vial", **kw)
    _vials(db, parent, P5010)
    _profiles(db, **{ENDO: "endo85", PCR: "pcr"})
    return parent


def test_every_form_icon_has_a_word():
    assert set(UNIT_WORDS) == set(get_args(FormIcon))


def test_counts_every_vial_a_printed_test_used(db):
    parent = _p5010(db)
    assert build_sample_units(db, parent, _doc(ENDO, PCR), variance_keys=[ENDO, PCR]) == {
        "icon": "powder_vial", "one": "Vial", "many": "Vials", "form": "Lyophilized Powder",
        "count": 7, "variance": True}


def test_deferred_section_vials_do_not_count(db):
    parent = _p5010(db)
    units = build_sample_units(db, parent, _doc(deferred=[ENDO, PCR]))
    assert units["count"] == 2 and units["variance"] is True  # the two HPLC vials


def test_replicate_vials_count_only_when_their_runs_print(db):
    # Endotoxin printed its Variance runs, Rapid PCR printed one row only (no
    # Variance plan, as on a retest): its replicate vial reported nothing.
    parent = _p5010(db)
    units = build_sample_units(db, parent, _doc(ENDO, PCR), variance_keys=[ENDO])
    assert units["count"] == 6
    # No runs printed anywhere and no HPLC Variance vial: not a Variance header.
    solo = _parent(db, form=False, sample_id="P-5012")
    _vials(db, solo, [("hplc", "core", True), ("pcr", "core", False),
                      ("pcr", "variance", True)])
    assert build_sample_units(db, solo, _doc(PCR)) == {
        "one": "Vial", "many": "Vials", "count": 2, "variance": False}


def test_unused_and_excluded_vials_do_not_count(db):
    parent = _parent(db, icon="pen")
    _vials(db, parent, [("hplc", "core", True), ("hplc", "variance", False),
                        ("xtra", None, True), (None, None, True)])
    assert build_sample_units(db, parent, {}) == {
        "icon": "pen", "one": "Pen", "many": "Pens", "form": "Pen", "count": 1,
        "variance": False}


@pytest.mark.parametrize("case", ["legacy parent", "unknown role", "shared role",
                                  "no page 1", "no vials"])
def test_no_count_when_the_vials_cannot_be_accounted_for(db, case):
    """Each of these would make the rule guess, so the block carries the word
    and the icon only and COABuilder keeps its old header row."""
    if case == "legacy parent":
        # The parent is itself vial 1: other vials may be untracked.
        parent = _p5010(db, container=False)
        doc, keys = _doc(ENDO, PCR), [ENDO, PCR]
    elif case == "unknown role":
        # A legacy-keyed endotoxin vial prints through the legacy rows, which
        # this document does not describe.
        parent = _parent(db, icon="powder_vial")
        _vials(db, parent, [("hplc", "core", True), ("endo", "core", False)])
        doc, keys = _doc(), []
    elif case == "shared role":
        # One role, one test printed and one waiting: whose vials are they?
        parent = _parent(db, icon="powder_vial")
        _vials(db, parent, [("hplc", "core", True), ("micro", "core", False)])
        _profiles(db, **{"micro-a": "micro", "micro-b": "micro"})
        doc, keys = _doc("micro-a", deferred=["micro-b"]), []
    elif case == "no page 1":
        # A la carte: nothing on this certificate reports the HPLC vial.
        parent = _parent(db, icon="powder_vial")
        _vials(db, parent, [("hplc", "core", True), ("endo85", "core", False)])
        _profiles(db, **{ENDO: "endo85"})
        doc, keys = _doc(ENDO, page1=False), []
    else:
        parent = _parent(db, icon="capsule")
        doc, keys = _doc(), []
    units = build_sample_units(db, parent, doc, variance_keys=keys)
    assert "count" not in units and "variance" not in units
    assert units["one"] and units["many"]


def test_a_la_carte_counts_its_native_vials(db):
    parent = _parent(db, icon="powder_vial")
    _vials(db, parent, [("endo85", "core", False), ("pcr", "core", False)])
    _profiles(db, **{ENDO: "endo85", PCR: "pcr"})
    units = build_sample_units(db, parent, _doc(ENDO, PCR, page1=False))
    assert (units["count"], units["variance"]) == (2, False)


def test_the_registration_snapshot_role_wins_over_a_renamed_catalog_role(db):
    # The catalog role was renamed after this sample registered; its vials
    # still carry the old code, which the snapshot remembers.
    parent = _parent(db, icon="powder_vial", catalog_snapshot={
        "profiles": [{"key": ENDO, "fulfillment_role": "endo85"}]})
    _vials(db, parent, [("hplc", "core", True), ("endo85", "core", False)])
    _profiles(db, **{ENDO: "endo-renamed"})
    assert build_sample_units(db, parent, _doc(ENDO))["count"] == 2
    assert build_sample_units(db, parent, _doc(deferred=[ENDO]))["count"] == 1


def test_no_form_sends_the_default_word_only(db):
    bare = _parent(db, form=False)
    assert build_sample_units(db, bare, {}) == {"one": "Vial", "many": "Vials"}
    assert unit_words(db, bare) == DEFAULT_WORDS


def test_one_vial_certificate_is_one_unit(db):
    parent = _parent(db, icon="nasal_spray")
    _vials(db, parent, P5010)
    assert build_sample_units(db, parent, single_vial=True) == {
        "icon": "nasal_spray", "one": "Nasal Spray", "many": "Nasal Sprays",
        "form": "Nasal Spray", "count": 1, "variance": False}


def _patch_builders(monkeypatch, *, source="senaite", trace=()):
    def native(db, p, **kw):
        if kw.get("trace") is not None:
            kw["trace"].extend(trace)
        return {"sample_id": p.sample_id, "ordered_profiles": [ENDO, PCR],
                "sections": [{"profile_key": ENDO}, {"profile_key": PCR}]}

    monkeypatch.setattr(wd, "build_native_sections", native)
    monkeypatch.setattr(wd, "coa_generation_source", lambda db: source)
    monkeypatch.setattr(wd, "build_legacy_rows", lambda db, p, **kw: [{"Keyword": "HPLC-PUR"}])
    monkeypatch.setattr(wd, "build_sample_meta", lambda db, p, vial=None: {"source": "mk1"})


def test_wire_document_carries_the_block_with_the_runs_that_printed(db, monkeypatch):
    parent = _p5010(db)
    ran = [{"profile_key": ENDO, "deferred": False, "runs": []},
           {"profile_key": PCR, "deferred": True, "runs": []}]
    _patch_builders(monkeypatch, trace=ran)
    # The caller's own trace list is filled as before, and read for the count:
    # Rapid PCR's runs were deferred, so its replicate vial is not counted.
    mine = []
    assert wd.build_coa_wire_document(db, parent, trace=mine)["sample_units"]["count"] == 6
    assert mine == ran
    assert wd.build_coa_wire_document(db, parent)["sample_units"]["count"] == 6


def test_vial_document_is_one_unit(db, monkeypatch):
    parent = _p5010(db)
    _patch_builders(monkeypatch, source="mk1")
    doc = wd.build_vial_wire_document(db, parent)
    assert doc["sample_units"] == {
        "icon": "powder_vial", "one": "Vial", "many": "Vials", "form": "Lyophilized Powder",
        "count": 1, "variance": False}


def test_a_failed_lookup_leaves_the_key_off_and_the_session_usable(db, monkeypatch):
    parent = _p5010(db)
    _patch_builders(monkeypatch)
    pending = LimsSample(sample_id="P-5011", external_lims_uid="uid-P-5011")
    db.add(pending)  # the caller's own unflushed work must survive

    def bad_sql(db, parent, doc, **kw):
        db.execute(text("select * from no_such_table"))

    monkeypatch.setattr(wd, "build_sample_units", bad_sql)
    doc = wd.build_coa_wire_document(db, parent)
    assert "sample_units" not in doc and len(doc["sections"]) == 2  # cosmetic: never blocks
    db.commit()
    assert db.execute(select(LimsSample.sample_id).order_by(LimsSample.sample_id)
                      ).scalars().all() == ["P-5010", "P-5011"]
