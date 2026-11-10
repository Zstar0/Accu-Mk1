"""Add-on test Variance, Task 15: an a la carte sample (no HPLC panel) may
carry Variance on its four tests, and its certificate generates with one row
per run, flagged `page1: "none"`, with no HPLC variance shape on the wire.

World: a fentanyl-free a la carte order, endotoxin n=3 (core vial S01, two
replicate vials S02 and S03) and heavy metals n=2 (core digest S04 anchor +
S05 material, replicate digest S06 anchor + S07 material). Built with the
Task 13 helpers on in-memory SQLite (StaticPool); nothing touches the dev
Postgres. Also pins the mixed HPLC case: no per-vial certificate is ever
listed for a replicate vial of the four roles.
"""
from __future__ import annotations

import asyncio
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from coa.native_sections import NativeSectionsError
from coa.wire_document import build_coa_wire_document
from models import LimsAnalysis, LimsAnalysisPromotion, LimsParentAttachment
from tests.test_addon_variance_coa_rows import (ENDO_KEY, ENDO_KW, ENDO_NAME, HM_KEY, HM_KW,
                                                HPLC_KEY, _parent, _parent_row, _profile, _svc,
                                                _vial, _vial_row, db)  # noqa: F401 (fixture)

FLAGGED = {"source": "mk1", "rows": [], "page1": "none"}
SID = "P-7501"
HPLC_SHAPES = ("variance_replicates", "variance_analytes", "vial_figures")


def _patch_order(monkeypatch, services, package="alacarte"):
    order = {"services": services, "package": package}
    monkeypatch.setattr("coa.native_sections.fetch_sample_services", lambda sid: order)
    monkeypatch.setattr("sub_samples.service.fetch_sample_services", lambda sid: order)


def _mk1_mode(monkeypatch):
    monkeypatch.setattr("coa.source_setting.coa_generation_source", lambda db: "mk1")
    monkeypatch.setattr("coa.wire_document.coa_generation_source", lambda db: "mk1")
    monkeypatch.setattr("coa.wire_document.build_sample_meta",
                        lambda db, p, vial=None: {"source": "mk1"})


def _alc_world(db, monkeypatch, *, endo_reps=(("0.5", "variance_verified"),
                                              ("0.6", "variance_verified")),
               locked=True):
    """Endotoxin max 25 EU/mL, heavy metals max 100 ppm."""
    _p, [endo] = _profile(db, ENDO_KEY, "endo85", ENDO_KW)
    _p, hms = _profile(db, HM_KEY, "hm", HM_KW, vials_required=2, analytical_vials=1,
                       max_value="100", unit="ppm", sort=20)
    parent = _parent(db, SID, sample_type_title="Peptide")
    core = _vial(db, parent, 1, "endo85", "core")
    _vial_row(db, core, endo, "1.2", state="promoted")
    _parent_row(db, parent, endo, "1.2")
    reps = []
    for seq, (value, state) in enumerate(endo_reps, 2):
        vial = _vial(db, parent, seq, "endo85", "variance")
        _vial_row(db, vial, endo, value, state=state)
        reps.append(vial)
    hm_core = _vial(db, parent, 4, "hm", "core", in_set=False)
    _vial(db, parent, 5, "hm", "core", in_set=False)
    hm_rep = _vial(db, parent, 6, "hm", "variance")
    _vial(db, parent, 7, "hm", "variance")
    for svc, value in zip(hms, ("0.1", "0.2", "0.3", "0.4")):
        _vial_row(db, hm_core, svc, "0.05", state="promoted")
        _parent_row(db, parent, svc, "0.05")
        _vial_row(db, hm_rep, svc, value)
    if locked:
        parent.variance_locked_at = datetime(2026, 11, 10, 12, 0, 0)
    services = {ENDO_KEY: True, HM_KEY: True, "samplevariance": True,
                "variance": {ENDO_KEY: 3, HM_KEY: 2}}
    _patch_order(monkeypatch, services)
    _mk1_mode(monkeypatch)
    db.commit()
    return SimpleNamespace(parent=parent, reps=reps, hm_rep=hm_rep)


def _rows(doc, key):
    [section] = [s for s in doc["sections"] if s["profile_key"] == key]
    return section["rows"]


def _patch_generate(db, monkeypatch, parent):
    from tests.test_coa_deferred_sections_warning import _patch_generate_prereqs
    db.add(LimsParentAttachment(
        lims_sample_pk=parent.id, kind="receive_image", filename="f",
        content_type="image/png", storage="s3", storage_key="k",
        render_in_report=True, attachment_type="Sample Image", created_by_user_id=None))
    db.commit()
    return _patch_generate_prereqs(
        monkeypatch, {"verification_code": "ALCV-7501", "generation_number": 1,
                      "warnings": []})


def _generate(db):
    import main
    # asyncio.run, as test_a_la_carte_routes.py does.
    return asyncio.run(main.generate_sample_coa(
        sample_id=SID, db=db, current_user=SimpleNamespace(id=1)))


def test_a_la_carte_variance_wire_is_flagged_with_run_rows(db, monkeypatch):
    w = _alc_world(db, monkeypatch)
    doc = build_coa_wire_document(db, w.parent)
    assert doc["legacy_rows"] == FLAGGED
    assert [(r["name"], r["result"]) for r in _rows(doc, ENDO_KEY)] == [
        (f"{ENDO_NAME}, Vial 1", "1.2"), (f"{ENDO_NAME}, Vial 2", "0.5"),
        (f"{ENDO_NAME}, Vial 3", "0.6")]
    hm = _rows(doc, HM_KEY)
    assert len(hm) == 8
    assert [r["name"] for r in hm] == [f"{kw.title()}, Digest {i}"
                                       for i in (1, 2) for kw in HM_KW]
    assert all(r["conforms"] is True for r in _rows(doc, ENDO_KEY) + hm)


def test_a_la_carte_variance_generate_posts_no_hplc_shapes(db, monkeypatch):
    w = _alc_world(db, monkeypatch)
    client = _patch_generate(db, monkeypatch, w.parent)
    result = _generate(db)
    assert result.success is True, result.message
    # One POST: the primary only, no per-vial certificate, no Regular child.
    assert len(client.calls) == 1
    body = client.calls[0][1]["json"]
    assert not any(k in body for k in HPLC_SHAPES)
    assert body["native_sections"]["legacy_rows"]["page1"] == "none"
    assert len(_rows(body["native_sections"], ENDO_KEY)) == 3
    assert len(_rows(body["native_sections"], HM_KEY)) == 8


def test_a_la_carte_one_failing_replicate_is_a_false_row(db, monkeypatch):
    import main
    w = _alc_world(db, monkeypatch, endo_reps=(("30", "variance_verified"),
                                               ("0.6", "variance_verified")))
    doc = build_coa_wire_document(db, w.parent)
    rows = _rows(doc, ENDO_KEY) + _rows(doc, HM_KEY)
    assert [r["name"] for r in rows if r["conforms"] is False] == [f"{ENDO_NAME}, Vial 2"]
    assert doc["legacy_rows"] == FLAGGED
    # COABuilder prints that certificate FAILED; the a la carte publish guard
    # refuses only IN REVIEW, so a FAILED badge passes it.
    monkeypatch.setattr("integration_db.fetch_publish_draft_badge", lambda sid: {
        "page1": "none", "overall_status": "FAILED", "generation_number": 1,
        "verification_code": "ALCV-7501"})
    assert main._refuse_in_review_a_la_carte(SID) is None


def test_a_la_carte_unsigned_replicate_never_reaches_in_review(db, monkeypatch):
    w = _alc_world(db, monkeypatch, endo_reps=(("0.5", "variance_verified"),
                                               ("0.6", "to_be_verified")),
                   locked=False)
    client = _patch_generate(db, monkeypatch, w.parent)
    with pytest.raises(HTTPException) as e:
        _generate(db)
    assert e.value.status_code == 422
    assert [b["code"] for b in e.value.detail["blockers"]] == ["variance_not_locked"]

    # Locked anyway (the lock skipped its guard during an outage): the builder
    # refuses, naming the run and the vial.
    w.parent.variance_locked_at = datetime(2026, 11, 10, 12, 0, 0)
    db.commit()
    result = _generate(db)
    assert result.success is False
    assert (f"native sections: '{ENDO_KEY}' run 3 (vial {SID}-S03) member "
            f"'{ENDO_KW[0]}' is not signed off") in result.message
    with pytest.raises(NativeSectionsError):
        build_coa_wire_document(db, w.parent)
    # No COABuilder call, so no draft exists that Publish could pick.
    assert client.calls == []


# ── Required: no per-vial certificate for a replicate of the four roles ────

def _promote(db, vial_row, parent_row):
    db.add(LimsAnalysisPromotion(parent_analysis_id=parent_row.id,
                                 source_analysis_id=vial_row.id, contribution_kind="chosen"))
    db.flush()


def test_mixed_hplc_and_endo_variance_lists_no_replicate_vial_for_certificates(
        db, monkeypatch):
    import main
    from coa.variance_series import list_vials_for_certificates
    from models import Peptide
    _p, [endo] = _profile(db, ENDO_KEY, "endo85", ENDO_KW)
    parent = _parent(db, "P-7502")
    endo_core = _vial(db, parent, 1, "endo85", "core")
    _promote(db, _vial_row(db, endo_core, endo, "1.2", state="promoted"),
             _parent_row(db, parent, endo, "1.2"))
    endo_reps = [_vial(db, parent, seq, "endo85", "variance") for seq in (2, 3)]
    for vial in endo_reps:
        _vial_row(db, vial, endo, "0.5")
    pep = Peptide(name="BPC-157", abbreviation="BPC157", active=True)
    db.add(pep)
    db.flush()
    pur = _svc(db, "PUR_BPC157", pep.id)
    hplc = [_vial(db, parent, seq, "hplc", kind) for seq, kind in ((10, "core"),
                                                                    (11, "variance"))]
    for vial, state in zip(hplc, ("promoted", "variance_verified")):
        _vial_row(db, vial, pur, "99.1", state=state, reportable=True)
    _patch_order(monkeypatch, {ENDO_KEY: True, HPLC_KEY: True, "samplevariance": True,
                               "variance": {HPLC_KEY: 2, ENDO_KEY: 3}}, package="core")
    db.commit()
    figs = {v.id: {"BPC-157": {"PURITY": f"{v.vial_sequence}%"}} for v in hplc}
    monkeypatch.setattr("coa.variance_series.build_vial_figures",
                        lambda db, sub, unit="mg", iu_factor=None: figs.get(sub.id, {}))

    listed = list_vials_for_certificates(db, parent)
    by_seq = {seq: (f, ids) for seq, f, ids in listed}
    assert 2 not in by_seq and 3 not in by_seq
    assert by_seq[1] == ({}, {db.query(LimsAnalysis).filter_by(
        lims_sample_pk=parent.id).one().id})
    certifiable, blocked = main._split_certifiable_vials(listed)
    assert [c[0] for c in certifiable] == [10, 11]
    assert [b["vial_sequence"] for b in blocked] == [1]

    # The HPLC vials are listed exactly as without the endotoxin entry and vials.
    hplc_entries = [e for e in listed if e[0] in (10, 11)]
    db.query(LimsAnalysisPromotion).delete()
    for vial in [endo_core, *endo_reps]:
        db.query(LimsAnalysis).filter(LimsAnalysis.lims_sub_sample_pk == vial.id).delete()
        db.delete(vial)
    db.commit()
    assert list_vials_for_certificates(db, parent) == hplc_entries
