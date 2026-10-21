"""Per-vial certificates (Handler ruling 2026-10-20, spec
docs/superpowers/specs/2026-10-20-per-vial-certificates-design.md).

A vial certificate carries the certified parent results promoted from that
vial (chosen / aggregated_in links), next to its own HPLC figures. The vial
set comes from walking the sub-samples; unused vials get nothing; HPLC-less
vials are reported, not sent, until COABuilder can render a certificate with
no legacy results table. The parent document is unchanged.
"""
from __future__ import annotations

import pytest

from coa.native_sections import build_native_sections
from coa.variance_series import list_vials_for_certificates, vial_parent_row_ids
from models import LimsAnalysis, LimsAnalysisPromotion, LimsSample, LimsSubSample
from tests.test_native_sections import _mk_native_profile

SERVICES = {"services": {"endotoxin": True, "heavy_metals": True}, "package": "core"}


@pytest.fixture
def lot(db_session, monkeypatch):
    """Parent with an endotoxin profile and a heavy-metals profile. Vial 1 is
    the core HPLC vial (its own HPLC rows), vial 2 a variance HPLC vial, vial
    3 the endotoxin vial (no HPLC), vial 4 unused. Endotoxin was chosen from
    vial 3, lead from vial 1, arsenic from vial 2."""
    db = db_session
    monkeypatch.setattr("coa.native_sections.fetch_sample_services", lambda sid: SERVICES)
    _, (endo,) = _mk_native_profile(db, key="endotoxin", services=[("ENDO-V2", "mk1")], sort=20)
    _, (pb, as_) = _mk_native_profile(db, key="heavy_metals",
                                      services=[("HM-PB", "mk1"), ("HM-AS", "mk1")], sort=10)
    parent = LimsSample(sample_id="P-7001")
    db.add(parent); db.flush()
    vials = {}
    for seq, role, kind in ((1, "hplc", "core"), (2, "hplc", "variance"),
                            (3, "micro", "core"), (4, "hplc", "variance")):
        v = LimsSubSample(parent_sample_pk=parent.id, sample_id=f"P-7001-S{seq:02d}",
                          external_lims_uid=f"mk1://v{seq}", vial_sequence=seq,
                          assignment_role=role, assignment_kind=kind)
        db.add(v); db.flush()
        vials[seq] = v

    def promote(svc, vial, kind="chosen", parent_state="verified", value="0.12"):
        src = LimsAnalysis(lims_sub_sample_pk=vial.id, analysis_service_id=svc.id,
                           keyword=svc.keyword, title=svc.title, result_value=value,
                           result_unit=svc.unit, review_state="promoted")
        tgt = LimsAnalysis(lims_sample_pk=parent.id, analysis_service_id=svc.id,
                           keyword=svc.keyword, title=svc.title, result_value=value,
                           result_unit=svc.unit, review_state=parent_state)
        db.add_all([src, tgt]); db.flush()
        db.add(LimsAnalysisPromotion(parent_analysis_id=tgt.id, source_analysis_id=src.id,
                                     contribution_kind=kind))
        db.flush()
        return tgt

    rows = {
        "endo": promote(endo, vials[3]),
        "pb": promote(pb, vials[1]),
        "as": promote(as_, vials[2]),
    }
    return parent, vials, rows, promote, (endo, pb, as_)


def test_lineage_finds_each_vials_promoted_results(db_session, lot):
    parent, vials, rows, _, _ = lot
    assert vial_parent_row_ids(db_session, vials[1]) == {rows["pb"].id}
    assert vial_parent_row_ids(db_session, vials[2]) == {rows["as"].id}
    assert vial_parent_row_ids(db_session, vials[3]) == {rows["endo"].id}
    assert vial_parent_row_ids(db_session, vials[4]) == set()


def test_reference_and_uncertified_links_do_not_count(db_session, lot):
    parent, vials, _, promote, (endo, _, _) = lot
    promote(endo, vials[4], kind="reference")
    promote(endo, vials[4], kind="chosen", parent_state="to_be_verified")
    assert vial_parent_row_ids(db_session, vials[4]) == set()


def test_vial_sections_carry_only_that_vials_results(db_session, lot):
    parent, vials, rows, _, _ = lot
    v3 = build_native_sections(db_session, parent,
                               vial_parent_ids=vial_parent_row_ids(db_session, vials[3]))
    assert v3["ordered_profiles"] == ["endotoxin"]
    assert [s["profile_key"] for s in v3["sections"]] == ["endotoxin"]
    assert "deferred_sections" not in v3

    # A profile split across vials prints each vial's own member only, and the
    # other vial's member is skipped, not treated as pending (no Rule 4 abort).
    v2 = build_native_sections(db_session, parent,
                               vial_parent_ids=vial_parent_row_ids(db_session, vials[2]))
    [hm] = v2["sections"]
    assert v2["ordered_profiles"] == ["heavy_metals"]
    assert [r["keyword"] for r in hm["rows"]] == ["HM-AS"]


def test_parent_document_is_unchanged(db_session, lot):
    parent, *_ = lot
    doc = build_native_sections(db_session, parent)
    assert doc["ordered_profiles"] == ["heavy_metals", "endotoxin"]
    assert {s["profile_key"]: [r["keyword"] for r in s["rows"]] for s in doc["sections"]} == {
        "heavy_metals": ["HM-PB", "HM-AS"], "endotoxin": ["ENDO-V2"],
    }


def test_vial_set_walks_every_sub_sample_and_drops_unused(db_session, lot, monkeypatch):
    parent, vials, rows, _, _ = lot
    figs = {vials[1].id: {"BPC-157": {"PURITY": "99.1%"}},
            vials[2].id: {"BPC-157": {"PURITY": "98.7%"}}}
    monkeypatch.setattr("coa.variance_series.build_vial_figures",
                        lambda db, sub, unit="mg": figs.get(sub.id, {}))
    out = list_vials_for_certificates(db_session, parent)
    assert [(seq, bool(f), ids) for seq, f, ids in out] == [
        (1, True, {rows["pb"].id}),
        (2, True, {rows["as"].id}),
        (3, False, {rows["endo"].id}),
    ]


def test_hplc_less_vials_are_reported_not_sent():
    import main
    certifiable, blocked = main._split_certifiable_vials([
        (1, {"BPC-157": {"PURITY": "99.1%"}}, {11}),
        (3, {}, {12}),
    ])
    assert [c[0] for c in certifiable] == [1]
    assert blocked == [{"vial_sequence": 3, "reason":
                        "no HPLC results on this vial; a certificate without HPLC is not supported yet"}]


def test_core_child_is_off_by_default(monkeypatch):
    import main
    monkeypatch.delenv("COA_EMIT_REGULAR_CHILD", raising=False)
    assert main._emit_regular_child_enabled() is False
    monkeypatch.setenv("COA_EMIT_REGULAR_CHILD", "1")
    assert main._emit_regular_child_enabled() is True


def test_publish_refuses_a_draft_older_than_the_live_primary(monkeypatch):
    import main
    from fastapi import HTTPException
    monkeypatch.setattr("integration_db.fetch_stale_draft_primary", lambda sid: {
        "draft_generation_number": 1, "draft_code": "8ZNV-M485",
        "live_generation_number": 3, "live_code": "BMBS-EFPR"})
    with pytest.raises(HTTPException) as ei:
        main._refuse_stale_draft_primary("P-5324")
    assert ei.value.status_code == 409
    assert "8ZNV-M485" in ei.value.detail and "BMBS-EFPR" in ei.value.detail

    monkeypatch.setattr("integration_db.fetch_stale_draft_primary", lambda sid: None)
    main._refuse_stale_draft_primary("P-5324")  # no raise

    def boom(sid):
        raise RuntimeError("IS down")
    monkeypatch.setattr("integration_db.fetch_stale_draft_primary", boom)
    main._refuse_stale_draft_primary("P-5324")  # fails open


def test_vial_body_carries_aliases_and_the_vials_own_sections(db_session, monkeypatch):
    """The loop posts one body per vial with that vial's figures, its scoped
    document (built with its parent_row_ids) and the sample's analyte aliases,
    the same aliases the primary and regular child send."""
    import asyncio
    from unittest.mock import AsyncMock, MagicMock
    import main

    parent = LimsSample(sample_id="P-7002")
    db_session.add(parent); db_session.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-7002-S02",
                         external_lims_uid="mk1://x", vial_sequence=2,
                         assignment_role="hplc", assignment_kind="variance")
    db_session.add(vial); db_session.flush()

    docs = []
    monkeypatch.setattr("coa.wire_document.build_vial_wire_document",
                        lambda db, p, v, vial_parent_ids=None:
                        docs.append((v.sample_id, vial_parent_ids)) or {"sections": []})
    monkeypatch.setattr(main, "_load_sample_aliases", lambda db, sid: {1: "BPC-157 (alias)"})
    monkeypatch.setattr(main, "_record_parent_event", lambda *a, **k: None)
    monkeypatch.setattr(main, "COA_BUILDER_URL", "http://coab.test")
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json = MagicMock(return_value={"verification_code": "VIAL-0002", "generation_id": "g2"})
    client = MagicMock()
    client.post = AsyncMock(return_value=resp)
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=client)
    cm.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **k: cm)

    figs = {"BPC-157": {"PURITY": "98.7%"}}
    generated, skipped, errors = asyncio.run(main._generate_vial_coas_loop(
        db_session, parent, [(2, figs, {41, 42})], "prim-1", set(),
        include_remarks=False, lab_remarks=""))
    assert errors == [] and skipped == []
    assert generated[0]["verification_code"] == "VIAL-0002"
    assert docs == [("P-7002-S02", {41, 42})]
    body = client.post.call_args.kwargs["json"]
    assert body["vial_sequence"] == 2 and body["parent_generation_id"] == "prim-1"
    assert body["vial_figures"] == figs
    assert body["analyte_display_names"] == {"1": "BPC-157 (alias)"}
    assert body["native_sections"] == {"sections": []}
