"""Add-on test Variance, Tasks 13 and 14: the certificate prints one native
row per run of the four tests, and the builder refuses a document while any
paid run is missing, unsigned or empty.

Contract pinned here: run 1 is today's row with the suffix `", Vial 1"` or
`", Digest 1"`; runs 2..n come from the in-set replicate anchors in vial
order, one row per printed member, run by run, each judged by the same spec
engine with its own `conforms` and `specification.loq`. No four-key entry
(no plan) means today's document byte for byte, even with variance vials on
the sample. The per-vial document and a retest sample never print a run row.

In-memory SQLite (StaticPool), so nothing touches the shared dev Postgres.
`fetch_sample_services` is patched on both modules that call it (the builder
and the generate route's lock gate).
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from coa.native_sections import NativeSectionsError, build_native_sections
from database import Base
from models import (AnalysisProfile, AnalysisService, AnalysisServiceSpec, LimsAnalysis,
                    LimsSample, LimsSubSample, Peptide, VialRole, analysis_profile_members)
from sub_samples import service as sub_service

ENDO_KEY = "endotoxin-usp85-lal"
HM_KEY = "heavy_metals"
HPLC_KEY = "hplc-purity-identity"
ENDO_KW = ["ENDOTOXIN-USP85LAL"]
HM_KW = ["HM-PB", "HM-AS", "HM-CD", "HM-HG"]
ENDO_NAME = "Endotoxin-Usp85Lal"


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()
        engine.dispose()


# ── world builders ──────────────────────────────────────────────────────────

def _role(db, code):
    if db.query(VialRole).filter_by(code=code).first() is None:
        db.add(VialRole(code=code, label=code, department_id=None, variance_eligible=True,
                        sort_order=100, boxable=False, frozen=False, is_system=False))
        db.flush()


def _profile(db, key, role, keywords, *, vials_required=1, analytical_vials=None,
             max_value="25", unit="EU/mL", sort=10):
    """A native, role-fulfilled profile with one range spec (max) per member."""
    _role(db, role)
    prof = AnalysisProfile(key=key, name=key, is_addon=True, coa_archetype="limit_table",
                           coa_section_title=key, coa_sort_order=sort, fulfillment_dim="role",
                           fulfillment_role=role, vials_required=vials_required,
                           analytical_vials=analytical_vials, active=True)
    db.add(prof)
    db.flush()
    svcs = []
    for i, kw in enumerate(keywords):
        svc = AnalysisService(title=kw.title(), keyword=kw, origin="mk1", unit=unit)
        db.add(svc)
        db.flush()
        db.execute(analysis_profile_members.insert().values(
            analysis_profile_id=prof.id, analysis_service_id=svc.id, sort_order=i))
        db.add(AnalysisServiceSpec(analysis_service_id=svc.id, matrix=None, rule_kind="range",
                                   max_value=Decimal(max_value), unit=unit))
        svcs.append(svc)
    db.flush()
    return prof, svcs


def _parent(db, sample_id, **kw):
    parent = LimsSample(sample_id=sample_id, external_lims_uid=f"{sample_id}-uid",
                        external_lims_system="mk1", container_mode=True, **kw)
    db.add(parent)
    db.flush()
    return parent


def _vial(db, parent, seq, role, kind, *, in_set=True):
    vial = LimsSubSample(sample_id=f"{parent.sample_id}-S{seq:02d}", vial_sequence=seq,
                         parent_sample_pk=parent.id,
                         external_lims_uid=f"{parent.sample_id}-s{seq:02d}-uid",
                         assignment_role=role, assignment_kind=kind, in_variance_set=in_set)
    db.add(vial)
    db.flush()
    return vial


def _vial_row(db, vial, svc, value, *, state="variance_verified", **kw):
    row = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
                       keyword=svc.keyword, title=svc.title, result_value=value,
                       result_unit=svc.unit, review_state=state, **kw)
    db.add(row)
    db.flush()
    return row


def _parent_row(db, parent, svc, value, *, state="verified", **kw):
    row = LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                       keyword=svc.keyword, title=svc.title, result_value=value,
                       result_unit=svc.unit, review_state=state, provenance="canonical", **kw)
    db.add(row)
    db.flush()
    return row


def _order(monkeypatch, services):
    def fake(sid):
        return {"services": services, "package": None}
    monkeypatch.setattr("coa.native_sections.fetch_sample_services", fake)
    monkeypatch.setattr(sub_service, "fetch_sample_services", fake)


def _endo_world(db, monkeypatch, sid, *, n=None, replicates=(("0.5", "variance_verified"),),
                core_value="1.2", max_value="25", extra_services=None):
    """Endotoxin core vial S01 (promoted row, verified parent row) and one
    variance vial per `replicates` entry (value, state); a None entry is a
    material vial with no row. `n` None leaves the variance map out."""
    prof, [svc] = _profile(db, ENDO_KEY, "endo85", ENDO_KW, max_value=max_value)
    parent = _parent(db, sid)
    core = _vial(db, parent, 1, "endo85", "core")
    _vial_row(db, core, svc, core_value, state="promoted")
    base = _parent_row(db, parent, svc, core_value)
    reps = []
    for seq, entry in enumerate(replicates, 2):
        vial = _vial(db, parent, seq, "endo85", "variance")
        if entry is not None:
            value, state = entry
            _vial_row(db, vial, svc, value, state=state)
        reps.append(vial)
    services = {ENDO_KEY: True, **(extra_services or {})}
    if n is not None:
        services["variance"] = {**services.get("variance", {}), ENDO_KEY: n}
    _order(monkeypatch, services)
    db.commit()
    return SimpleNamespace(parent=parent, prof=prof, svc=svc, core=core, reps=reps,
                           base=base, services=services)


def _hm_world(db, monkeypatch, sid, *, n=2, rep_values=("0.1", "0.2", "0.3", "0.4"),
              withdraw_hg=False):
    """Heavy metals, two vials a run, one analytical: core digest S01 anchor +
    S02 material, replicate digest S03 anchor + S04 material."""
    prof, svcs = _profile(db, HM_KEY, "hm", HM_KW, vials_required=2, analytical_vials=1,
                          max_value="100", unit="ppm")
    parent = _parent(db, sid)
    core = _vial(db, parent, 1, "hm", "core")
    _vial(db, parent, 2, "hm", "core", in_set=False)
    rep = _vial(db, parent, 3, "hm", "variance")
    _vial(db, parent, 4, "hm", "variance")
    for svc, value in zip(svcs, rep_values):
        withdrawn = withdraw_hg and svc.keyword == "HM-HG"
        _vial_row(db, core, svc, "0.05", state="promoted")
        if withdrawn:
            _parent_row(db, parent, svc, None, state="rejected", )
            # The replicate's Hg row is left unsigned on purpose: a member
            # withdrawn on the parent is skipped on every run, never checked.
            _vial_row(db, rep, svc, None, state="unassigned")
        else:
            _parent_row(db, parent, svc, "0.05")
            _vial_row(db, rep, svc, value)
    services = {HM_KEY: True, "variance": {HM_KEY: n}}
    _order(monkeypatch, services)
    db.commit()
    return SimpleNamespace(parent=parent, prof=prof, svcs=svcs, core=core, rep=rep)


def _rows(doc, key):
    [section] = [s for s in doc["sections"] if s["profile_key"] == key]
    return section["rows"]


def _names(doc, key):
    return [r["name"] for r in _rows(doc, key)]


def _drop_vials(db, vials):
    for vial in vials:
        db.query(LimsAnalysis).filter(LimsAnalysis.lims_sub_sample_pk == vial.id).delete()
        db.delete(vial)
    db.commit()


# ── Task 13: characterization (no plan, today's document) ──────────────────

def test_no_variance_map_sends_todays_rows_even_with_replicate_vials(db, monkeypatch):
    w = _endo_world(db, monkeypatch, "P-7401", n=None)
    with_vial = build_native_sections(db, w.parent)
    assert _names(with_vial, ENDO_KEY) == [ENDO_NAME]
    _drop_vials(db, w.reps)
    assert build_native_sections(db, w.parent) == with_vial


# Captured on the base checkout (ca191646) by
# C:/tmp/variance-sdd/scratch/mk1-t13-capture.py with the same world as
# _plain_multi_member_world below: the _member_row refactor is a pure move.
BASE_MULTI_MEMBER_DOC = {
    "sample_id": "P-7313",
    "ordered_profiles": ["heavy_metals"],
    "sections": [{
        "profile_key": "heavy_metals", "title": "Heavy Metals", "archetype": "limit_table",
        "sort_order": 10, "basis_note": "Limits scale with dose (LOD 0.01 ppm, 0.02 ppm)",
        "method_text": "ICP-MS", "prep_text": None, "footnotes": [],
        "rows": [
            {"keyword": "HM-PB", "name": "Hm-Pb", "result": "0.12", "unit": "ppm", "method": "",
             "specification": {"rule_kind": "range", "equals": None, "min": None, "max": 100.0,
                               "unit": "ppm", "display": None, "loq": None},
             "conforms": True, "result_display": None},
            {"keyword": "HM-AS", "name": "Hm-As", "result": "0.5", "unit": "ppm", "method": "",
             "specification": {"rule_kind": "range", "equals": None, "min": None, "max": 100.0,
                               "unit": "ppm", "display": None, "loq": 0.5},
             "conforms": True, "result_display": "< 0.5"},
            {"keyword": "HM-CD", "name": "Hm-Cd", "result": "0.04", "unit": "ppm", "method": "",
             "specification": {"rule_kind": "range", "equals": None, "min": None, "max": 100.0,
                               "unit": "ppm", "display": None, "loq": 0.05},
             "conforms": True, "result_display": "< 0.05"},
            {"keyword": "HM-HG", "name": "Hm-Hg", "result": "150", "unit": "ppm", "method": "",
             "specification": {"rule_kind": "range", "equals": None, "min": None, "max": 100.0,
                               "unit": "ppm", "display": None, "loq": None},
             "conforms": False, "result_display": None},
        ],
    }],
}


def _plain_multi_member_world(db, monkeypatch):
    prof = AnalysisProfile(key="heavy_metals", name="Heavy Metals", is_addon=True,
                           coa_archetype="limit_table", coa_section_title="Heavy Metals",
                           coa_sort_order=10,
                           coa_basis_note="Limits scale with dose[ (LOD {lod})]",
                           coa_method_text="ICP-MS", coa_prep_text=None, coa_footnotes=[])
    db.add(prof)
    db.flush()
    svcs = []
    for i, kw in enumerate(HM_KW):
        svc = AnalysisService(title=kw.title(), keyword=kw, origin="mk1", unit="ppm")
        db.add(svc)
        db.flush()
        db.execute(analysis_profile_members.insert().values(
            analysis_profile_id=prof.id, analysis_service_id=svc.id, sort_order=i))
        db.add(AnalysisServiceSpec(analysis_service_id=svc.id, matrix=None, rule_kind="range",
                                   max_value=Decimal("100"), unit="ppm",
                                   loq=Decimal("0.05") if kw == "HM-CD" else None))
        svcs.append(svc)
    parent = _parent(db, "P-7313")
    for svc, value, loq, lod in zip(svcs, ["0.12", "0.5", "0.04", "150"],
                                    [None, 0.5, None, None], [0.01, 0.02, None, 0.01]):
        _parent_row(db, parent, svc, value, loq=loq, lod=lod, lod_unit="ppm")
    vial = _vial(db, parent, 2, "hm", "variance")
    _vial_row(db, vial, svcs[0], "0.3")
    # HPLC Variance only: no four-key entry, so no plan.
    _order(monkeypatch, {"heavy_metals": True, "variance": {"hplcpurity_identity": 3}})
    db.commit()
    return parent


def test_multi_member_document_without_variance_matches_base_literal(db, monkeypatch):
    parent = _plain_multi_member_world(db, monkeypatch)
    assert build_native_sections(db, parent) == BASE_MULTI_MEMBER_DOC


# ── Task 13: one row per run ────────────────────────────────────────────────

def test_endo_three_runs_print_three_rows_in_run_order(db, monkeypatch):
    w = _endo_world(db, monkeypatch, "P-7402", n=3,
                    replicates=(("0.5", "variance_verified"), ("30", "variance_verified")))
    rows = _rows(build_native_sections(db, w.parent), ENDO_KEY)
    assert [r["name"] for r in rows] == [f"{ENDO_NAME}, Vial 1", f"{ENDO_NAME}, Vial 2",
                                         f"{ENDO_NAME}, Vial 3"]
    assert [r["result"] for r in rows] == ["1.2", "0.5", "30"]
    assert [r["conforms"] for r in rows] == [True, True, False]
    assert {r["keyword"] for r in rows} == {"ENDOTOXIN-USP85LAL"}
    assert {r["unit"] for r in rows} == {"EU/mL"}
    specs = [{k: v for k, v in r["specification"].items() if k != "loq"} for r in rows]
    assert specs[0] == specs[1] == specs[2]
    assert list(rows[1]) == list(rows[0])     # same keys, same order, no new wire field


def test_hm_two_digests_print_run_by_run(db, monkeypatch):
    w = _hm_world(db, monkeypatch, "P-7403")
    rows = _rows(build_native_sections(db, w.parent), HM_KEY)
    assert [r["name"] for r in rows] == [
        "Hm-Pb, Digest 1", "Hm-As, Digest 1", "Hm-Cd, Digest 1", "Hm-Hg, Digest 1",
        "Hm-Pb, Digest 2", "Hm-As, Digest 2", "Hm-Cd, Digest 2", "Hm-Hg, Digest 2"]
    assert [r["result"] for r in rows[4:]] == ["0.1", "0.2", "0.3", "0.4"]
    assert [r["keyword"] for r in rows] == HM_KW * 2


def test_replicate_loq_is_its_own(db, monkeypatch):
    prof, [svc] = _profile(db, ENDO_KEY, "endo85", ENDO_KW, max_value="100")
    parent = _parent(db, "P-7404")
    core = _vial(db, parent, 1, "endo85", "core")
    _vial_row(db, core, svc, "1.2", state="promoted")
    _parent_row(db, parent, svc, "1.2")
    rep = _vial(db, parent, 2, "endo85", "variance")
    _vial_row(db, rep, svc, "30", loq=50)
    _order(monkeypatch, {ENDO_KEY: True, "variance": {ENDO_KEY: 2}})
    db.commit()
    base, replicate = _rows(build_native_sections(db, parent), ENDO_KEY)
    assert base["specification"]["loq"] is None and base["result_display"] is None
    assert replicate["specification"]["loq"] == 50.0
    assert replicate["result_display"] == "< 50"
    assert replicate["conforms"] is True


def test_withdrawn_member_skipped_on_every_run(db, monkeypatch):
    w = _hm_world(db, monkeypatch, "P-7405", withdraw_hg=True)
    rows = _rows(build_native_sections(db, w.parent), HM_KEY)
    assert [r["name"] for r in rows] == [
        "Hm-Pb, Digest 1", "Hm-As, Digest 1", "Hm-Cd, Digest 1",
        "Hm-Pb, Digest 2", "Hm-As, Digest 2", "Hm-Cd, Digest 2"]


def test_no_identity_gate_on_replicate_rows(db, monkeypatch):
    w = _endo_world(db, monkeypatch, "P-7406", n=2, replicates=(("30", "variance_verified"),))
    ident = AnalysisService(title="HPLC Identity", keyword="HPLC-ID", origin="mk1")
    db.add(ident)
    db.flush()
    _parent_row(db, w.parent, ident, "FAILED")
    _vial_row(db, w.reps[0], ident, "FAILED")
    db.commit()
    rows = _rows(build_native_sections(db, w.parent), ENDO_KEY)
    assert [(r["name"], r["result"], r["conforms"]) for r in rows] == [
        (f"{ENDO_NAME}, Vial 1", "1.2", True), (f"{ENDO_NAME}, Vial 2", "30", False)]


def _svc(db, keyword, peptide_id=None):
    svc = AnalysisService(title=keyword, keyword=keyword, peptide_id=peptide_id, origin="senaite")
    db.add(svc)
    db.flush()
    return svc


def test_hplc_order_with_endo_variance_prints_runs_only_in_endo_section(db, monkeypatch):
    from coa.variance_series import build_variance_replicates, process_variance_fields
    hm_prof, hm_svcs = _profile(db, HM_KEY, "hm", ["HM-PB"], max_value="100", unit="ppm",
                                sort=20)
    w = _endo_world(db, monkeypatch, "P-7407", n=2,
                    replicates=(("0.5", "variance_verified"),),
                    extra_services={HPLC_KEY: True, HM_KEY: True,
                                    "variance": {HPLC_KEY: 2}})
    _parent_row(db, w.parent, hm_svcs[0], "0.05")
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep)
    db.flush()
    pur, idsvc = _svc(db, "PUR_BPC157", pep.id), _svc(db, "ID_BPC157", pep.id)
    hplc_core = _vial(db, w.parent, 10, "hplc", "core")
    hplc_rep = _vial(db, w.parent, 11, "hplc", "variance")
    for vial, value, state in ((hplc_core, "99.1", "promoted"),
                               (hplc_rep, "98.4", "variance_verified")):
        _vial_row(db, vial, pur, value, state=state, reportable=True)
        _vial_row(db, vial, idsvc, "BPC-157", state=state, reportable=True)
    db.commit()

    doc = build_native_sections(db, w.parent)
    series = build_variance_replicates(db, w.parent)
    fields = process_variance_fields(db, w.parent)
    assert _names(doc, ENDO_KEY) == [f"{ENDO_NAME}, Vial 1", f"{ENDO_NAME}, Vial 2"]
    assert [r["vial_sequence"] for r in series["BPC-157"]] == [10, 11]
    assert "variance_analytes" not in fields

    # Without the endotoxin entry and its vials: the HPLC series and every
    # other section are exactly the same.
    hm_rows = _rows(doc, HM_KEY)
    _drop_vials(db, [w.core, *w.reps])
    _order(monkeypatch, {ENDO_KEY: True, HPLC_KEY: True, HM_KEY: True,
                         "variance": {HPLC_KEY: 2}})
    plain = build_native_sections(db, w.parent)
    assert build_variance_replicates(db, w.parent) == series
    assert process_variance_fields(db, w.parent) == fields
    assert _rows(plain, HM_KEY) == hm_rows == [{**hm_rows[0], "name": "Hm-Pb"}]
    assert _names(plain, ENDO_KEY) == [ENDO_NAME]
    assert [s["profile_key"] for s in plain["sections"]] == [
        s["profile_key"] for s in doc["sections"]]


def test_per_vial_document_unchanged(db, monkeypatch):
    # An unsigned replicate would refuse the parent document; the per-vial
    # document never resolves a plan, so it builds exactly as without one.
    w = _endo_world(db, monkeypatch, "P-7408", n=2, replicates=(("0.5", "to_be_verified"),))
    with_map = build_native_sections(db, w.parent, vial_parent_ids={w.base.id})
    _order(monkeypatch, {ENDO_KEY: True})
    assert build_native_sections(db, w.parent, vial_parent_ids={w.base.id}) == with_map
    assert _names(with_map, ENDO_KEY) == [ENDO_NAME]


def test_retest_sample_prints_todays_rows_and_raises_nothing_new(db, monkeypatch):
    w = _endo_world(db, monkeypatch, "P-7409", n=3, replicates=(("0.5", "to_be_verified"),))
    w.parent.is_retest = True
    w.parent.retest_of_sample_id = "P-7000"
    db.commit()
    doc = build_native_sections(db, w.parent)
    assert _names(doc, ENDO_KEY) == [ENDO_NAME]
    _drop_vials(db, w.reps)
    _order(monkeypatch, {ENDO_KEY: True})
    assert build_native_sections(db, w.parent) == doc


# ── Task 13: the HPLC fence holds after a catalog edit ─────────────────────

def _fence_world(db, sample_id):
    """An HPLC core vial with promoted rows and an in-set endo85 replicate,
    registered with endo85 in the frozen snapshot."""
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep)
    db.flush()
    pur, idsvc = _svc(db, "PUR_BPC157", pep.id), _svc(db, "ID_BPC157", pep.id)
    endo = _svc(db, "ENDOTOXIN-USP85LAL")
    db.add(AnalysisProfile(key=ENDO_KEY, name="Endotoxin", is_addon=True, vials_required=1,
                           fulfillment_dim="role", fulfillment_role="endo85", active=True))
    parent = _parent(db, sample_id, catalog_snapshot={"profiles": [
        {"key": ENDO_KEY, "fulfillment_role": "endo85", "vials_required": 1,
         "analytical_vials": None}]})
    core = _vial(db, parent, 1, "hplc", "core")
    rep = _vial(db, parent, 2, "endo85", "variance")
    _vial_row(db, core, pur, "99.1", state="promoted", reportable=True)
    _vial_row(db, core, idsvc, "BPC-157", state="promoted", reportable=True)
    _vial_row(db, rep, endo, "0.5", reportable=True)
    db.commit()
    return parent


@pytest.mark.parametrize("live_role", [None, "endo85-renamed"])
def test_fence_holds_when_live_role_changes_after_registration(db, live_role):
    from coa.variance_series import build_variance_replicates, process_variance_fields
    parent = _fence_world(db, "P-7410")
    db.query(AnalysisProfile).filter_by(key=ENDO_KEY).update({"fulfillment_role": live_role})
    db.commit()
    assert build_variance_replicates(db, parent) == {}
    assert process_variance_fields(db, parent) == {}


def test_fence_role_set_is_live_plus_snapshot(db):
    from sub_samples.variance_tests import variance_test_roles
    parent = _fence_world(db, "P-7411")
    db.query(AnalysisProfile).filter_by(key=ENDO_KEY).update({"fulfillment_role": "endo86"})
    db.commit()
    assert variance_test_roles(db) == frozenset({"endo86"})
    assert variance_test_roles(db, parent) == frozenset({"endo86", "endo85"})
    parent.catalog_snapshot = {"profiles": [{"key": ENDO_KEY, "fulfillment_role": "hplc"},
                                            {"key": "zz-other", "fulfillment_role": "zz"}]}
    db.commit()
    assert variance_test_roles(db, parent) == frozenset({"endo86"})


# ── Task 14: the builder refuses an unfinished Variance run ────────────────

def test_unsigned_replicate_aborts_even_when_lock_skipped_its_guard(db, monkeypatch):
    w = _endo_world(db, monkeypatch, "P-7420", n=2, replicates=(("0.5", "to_be_verified"),))
    w.parent.variance_locked_at = datetime(2026, 11, 10, 12, 0, 0)
    db.commit()
    with pytest.raises(NativeSectionsError) as e:
        build_native_sections(db, w.parent)
    assert e.value.detail == (
        "native sections: 'endotoxin-usp85-lal' run 2 (vial P-7420-S02) member "
        "'ENDOTOXIN-USP85LAL' is not signed off (needs variance_verified with a result) "
        "on P-7420")


def test_never_entered_replicate_aborts_naming_run_and_vial(db, monkeypatch):
    # The worksheet completed but the reading never reached the row: it is
    # still a live row (so the lock counts it as an anchor) with no result.
    w = _endo_world(db, monkeypatch, "P-7421", n=2, replicates=((None, "unassigned"),))
    w.parent.variance_locked_at = datetime(2026, 11, 10, 12, 0, 0)
    db.commit()
    with pytest.raises(NativeSectionsError, match=r"run 2 \(vial P-7421-S02\) member "
                                                  r"'ENDOTOXIN-USP85LAL' is not signed off"):
        build_native_sections(db, w.parent)


def test_signed_off_row_with_blank_result_aborts(db, monkeypatch):
    w = _endo_world(db, monkeypatch, "P-7422", n=2, replicates=(("  ", "variance_verified"),))
    with pytest.raises(NativeSectionsError, match=r"run 2 \(vial P-7422-S02\).*is not signed off"):
        build_native_sections(db, w.parent)


def test_replicate_missing_a_member_row_aborts(db, monkeypatch):
    w = _hm_world(db, monkeypatch, "P-7423")
    db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=w.rep.id, keyword="HM-CD").delete()
    db.commit()
    with pytest.raises(NativeSectionsError, match=r"'heavy_metals' run 2 \(vial P-7423-S03\) "
                                                  r"member 'HM-CD' is not signed off"):
        build_native_sections(db, w.parent)


def test_missing_replicate_run_aborts(db, monkeypatch):
    w = _endo_world(db, monkeypatch, "P-7424", n=3, replicates=(("0.5", "variance_verified"),))
    with pytest.raises(NativeSectionsError) as e:
        build_native_sections(db, w.parent)
    assert e.value.detail == (
        "native sections: 'endotoxin-usp85-lal' bought 3 runs, 1 replicate runs carry "
        "results on P-7424; finish them or set the Variance count")


def test_material_only_replicate_vial_is_a_missing_run(db, monkeypatch):
    w = _endo_world(db, monkeypatch, "P-7425", n=2, replicates=(None,))
    with pytest.raises(NativeSectionsError, match="bought 2 runs, 0 replicate runs carry results"):
        build_native_sections(db, w.parent)


def test_extra_in_set_replicate_aborts_and_out_of_set_is_left_out(db, monkeypatch):
    w = _endo_world(db, monkeypatch, "P-7426", n=2,
                    replicates=(("0.5", "variance_verified"), ("0.6", "variance_verified")))
    with pytest.raises(NativeSectionsError) as e:
        build_native_sections(db, w.parent)
    assert e.value.detail == (
        "native sections: 'endotoxin-usp85-lal' bought 2 runs, 2 replicate runs carry "
        "results on P-7426; take the extra vials out of the variance set")
    w.reps[1].in_variance_set = False
    db.commit()
    rows = _rows(build_native_sections(db, w.parent), ENDO_KEY)
    assert [(r["name"], r["result"]) for r in rows] == [
        (f"{ENDO_NAME}, Vial 1", "1.2"), (f"{ENDO_NAME}, Vial 2", "0.5")]


def test_missing_core_run_aborts(db, monkeypatch):
    w = _endo_world(db, monkeypatch, "P-7427", n=2)
    db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=w.core.id).update(
        {"review_state": "retracted"})
    db.commit()
    with pytest.raises(NativeSectionsError) as e:
        build_native_sections(db, w.parent)
    assert e.value.detail == (
        "native sections: 'endotoxin-usp85-lal' core run has no live result on its core "
        "vial (role endo85) on P-7427; restore or re-run the core vial")


def test_unfulfillable_entry_aborts(db, monkeypatch):
    _profile(db, HM_KEY, "hm", HM_KW, vials_required=2, analytical_vials=1)
    w = _endo_world(db, monkeypatch, "P-7428", n=None,
                    extra_services={"variance": {HM_KEY: 2}})
    with pytest.raises(NativeSectionsError) as e:
        build_native_sections(db, w.parent)
    assert e.value.detail == (
        "native sections: Variance for heavy_metals: the test is not on this sample on P-7428")


def test_retested_replicate_blocks_until_resigned_then_prints_current_value(db, monkeypatch):
    from lims_analyses.service import apply_transition
    w = _endo_world(db, monkeypatch, "P-7429", n=2, replicates=(("0.5", "variance_verified"),))
    old = db.query(LimsAnalysis).filter_by(lims_sub_sample_pk=w.reps[0].id).one()
    new = apply_transition(db, analysis_id=old.id, kind="retest")
    assert new.review_state == "unassigned"
    with pytest.raises(NativeSectionsError, match=r"run 2 \(vial P-7429-S02\).*not signed off"):
        build_native_sections(db, w.parent)
    apply_transition(db, analysis_id=new.id, kind="submit", result_value="0.7")
    with pytest.raises(NativeSectionsError, match="not signed off"):
        build_native_sections(db, w.parent)
    apply_transition(db, analysis_id=new.id, kind="variance_verify")
    rows = _rows(build_native_sections(db, w.parent), ENDO_KEY)
    assert [(r["name"], r["result"]) for r in rows] == [
        (f"{ENDO_NAME}, Vial 1", "1.2"), (f"{ENDO_NAME}, Vial 2", "0.7")]


# ── Task 14: every path that builds the document refuses ───────────────────

class _FakeClient:
    def __init__(self):
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        raise AssertionError("COABuilder must not be called")


def _patch_coabuilder(monkeypatch):
    import main
    monkeypatch.setattr(main, "COA_BUILDER_URL", "http://coabuilder.test")
    monkeypatch.setattr(main, "SENAITE_URL", None)
    client = _FakeClient()
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda *a, **k: client)
    return main, client


UNSIGNED_P7430 = ("native sections: 'endotoxin-usp85-lal' run 2 (vial P-7430-S02) member "
                  "'ENDOTOXIN-USP85LAL' is not signed off (needs variance_verified with a "
                  "result) on P-7430")


def _unsigned_locked_world(db, monkeypatch):
    w = _endo_world(db, monkeypatch, "P-7430", n=2, replicates=(("0.5", "to_be_verified"),))
    w.parent.variance_locked_at = datetime(2026, 11, 10, 12, 0, 0)
    db.commit()
    return w


@pytest.mark.asyncio
async def test_generate_refuses_with_clear_message(db, monkeypatch):
    _unsigned_locked_world(db, monkeypatch)
    main, client = _patch_coabuilder(monkeypatch)
    result = await main.generate_sample_coa(sample_id="P-7430", db=db,
                                            current_user=SimpleNamespace(id=1))
    assert result.success is False
    assert UNSIGNED_P7430 in result.message
    assert client.calls == []


@pytest.mark.asyncio
async def test_regen_primary_refuses_with_clear_message(db, monkeypatch):
    _unsigned_locked_world(db, monkeypatch)
    main, client = _patch_coabuilder(monkeypatch)
    result = await main.regen_primary_coa(sample_id="P-7430", db=db,
                                          current_user=SimpleNamespace(id=1))
    assert result.success is False
    assert UNSIGNED_P7430 in result.message
    assert client.calls == []


def test_coa_sections_route_answers_502_with_the_message(db, monkeypatch):
    from fastapi import HTTPException
    import main
    _unsigned_locked_world(db, monkeypatch)
    with pytest.raises(HTTPException) as e:
        main.get_sample_coa_sections(sample_id="P-7430", db=db, _=None)
    assert e.value.status_code == 502
    assert e.value.detail == UNSIGNED_P7430


@pytest.mark.asyncio
async def test_regular_child_is_not_emitted(db, monkeypatch, caplog):
    # Retired since 2026-10-20 and HPLC-series only; forced on here so the
    # child's own fail-closed attach is exercised with the new refusal.
    import logging

    import coa.variance_series as vs
    w = _unsigned_locked_world(db, monkeypatch)
    main, client = _patch_coabuilder(monkeypatch)
    monkeypatch.setattr(main, "_emit_regular_child_enabled", lambda: True)
    monkeypatch.setattr(vs, "build_variance_replicates", lambda db, parent: {"X": [{}]})
    with caplog.at_level(logging.ERROR):
        await main._maybe_emit_regular_coa_child(db, "P-7430", w.parent,
                                                 {"generation_id": "g-1"})
    assert client.calls == []
    assert any(UNSIGNED_P7430 in r.getMessage() for r in caplog.records)
