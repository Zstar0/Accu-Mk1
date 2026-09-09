"""One-off repair for PB-0469 (2026-09-08): the same peptide in two analyte
slots left (a) two spurious pending GHK-Cu retest rows on the vial after the
slot-2 un-promote, and (b) SENAITE slot 2 still naming GHK-Cu, so the parent's
declared-analytes list carries it twice.

The script is dry-run by default and fully injectable, so this test proves the
plan and the writes without SENAITE: the SENAITE field write and the registry
refresh are passed in as callables."""
from sqlalchemy import select

from lims_analyses.service import apply_transition, create_analysis
from models import (
    AnalysisService,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    LimsSubSampleEvent,
    Peptide,
)
from scripts.repair_pb0469_duplicate_slot import run

SID = "PB-0469"
UID = "uid-pb0469"


def _seed(db):
    ghk = Peptide(name="GHK-Cu", abbreviation="GHK-CU")
    db.add(ghk)
    db.flush()
    pur = AnalysisService(keyword="PUR_GHKCU", title="GHK-Cu - Purity", peptide_id=ghk.id)
    qty = AnalysisService(keyword="QTY_GHKCU", title="GHK-Cu - Quantity", peptide_id=ghk.id)
    idr = AnalysisService(keyword="ID_GHKCU", title="GHK-Cu - Identity (HPLC)", peptide_id=ghk.id)
    db.add_all([pur, qty, idr])
    db.flush()
    parent = LimsSample(sample_id=SID, external_lims_uid=UID, client_sample_id="KLOW",
                        analytes='[{"name": "GHK-Cu"}, {"name": "GHK-Cu - Identity (HPLC)"}]')
    db.add(parent)
    db.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, external_lims_uid="mk1://pb0469-s01",
                         sample_id=f"{SID}-S01", vial_sequence=1, assignment_role="hplc")
    db.add(vial)
    db.flush()
    # the promoted originals (superseded by the retest) + their spurious children
    orig_pur = create_analysis(db, host_kind="sub_sample", host_pk=vial.id, analysis_service_id=pur.id,
                               keyword="PUR_GHKCU", title=pur.title, result_value="99.975")
    apply_transition(db, analysis_id=orig_pur.id, kind="submit", result_value="99.975")
    child_pur = apply_transition(db, analysis_id=orig_pur.id, kind="retest")
    orig_qty = create_analysis(db, host_kind="sub_sample", host_pk=vial.id, analysis_service_id=qty.id,
                               keyword="QTY_GHKCU", title=qty.title, result_value="54.478")
    apply_transition(db, analysis_id=orig_qty.id, kind="submit", result_value="54.478")
    child_qty = apply_transition(db, analysis_id=orig_qty.id, kind="retest")
    # an unrelated pending identity row that must be left alone
    keep = create_analysis(db, host_kind="sub_sample", host_pk=vial.id, analysis_service_id=idr.id,
                           keyword="ID_GHKCU", title=idr.title)
    db.commit()
    return dict(parent=parent, vial=vial, child_pur=child_pur, child_qty=child_qty,
                orig_pur=orig_pur, orig_qty=orig_qty, keep=keep)


def _state(db, row_id):
    return db.get(LimsAnalysis, row_id).review_state


def test_dry_run_plans_everything_and_writes_nothing(db_session):
    db = db_session
    s = _seed(db)
    senaite_writes, refreshes = [], []

    report = run(db, apply=False, senaite_update=lambda uid, fields: senaite_writes.append((uid, fields)),
                 refresh=lambda db_, row: refreshes.append(row.sample_id))

    assert report["applied"] is False
    assert sorted(report["reject_rows"]) == sorted([s["child_pur"].id, s["child_qty"].id])
    assert report["slot_to_blank"] == 2
    assert report["senaite_fields"] == {"Analyte2Peptide": "", "Analyte2DeclaredQuantity": ""}
    assert senaite_writes == [] and refreshes == []
    assert _state(db, s["child_pur"].id) == "unassigned"


def test_apply_rejects_children_blanks_slot_refreshes_and_audits(db_session):
    db = db_session
    s = _seed(db)
    senaite_writes, refreshes = [], []

    report = run(db, apply=True, senaite_update=lambda uid, fields: senaite_writes.append((uid, fields)),
                 refresh=lambda db_, row: refreshes.append(row.sample_id))

    assert report["applied"] is True
    assert _state(db, s["child_pur"].id) == "rejected"
    assert _state(db, s["child_qty"].id) == "rejected"
    assert _state(db, s["orig_pur"].id) == "to_be_verified"  # superseded originals untouched
    assert _state(db, s["keep"].id) == "unassigned"          # unrelated row untouched
    assert senaite_writes == [(UID, {"Analyte2Peptide": "", "Analyte2DeclaredQuantity": ""})]
    assert refreshes == [SID]
    ev = db.execute(select(LimsSubSampleEvent).where(
        LimsSubSampleEvent.lims_sample_pk == s["parent"].id,
        LimsSubSampleEvent.event == "analyte_slot_cleared")).scalar_one()
    assert ev.details["slot"] == 2 and ev.details["cascade"] is False

    # idempotent: nothing left to do
    again = run(db, apply=True, senaite_update=lambda uid, fields: senaite_writes.append((uid, fields)),
                refresh=lambda db_, row: refreshes.append(row.sample_id))
    assert again["reject_rows"] == []


def test_apply_with_rename_writes_client_sample_id(db_session):
    db = db_session
    s = _seed(db)
    senaite_writes = []

    run(db, apply=True, rename_to="GLOW",
        senaite_update=lambda uid, fields: senaite_writes.append((uid, fields)),
        refresh=lambda db_, row: None)

    assert (UID, {"ClientSampleID": "GLOW"}) in senaite_writes
    db.refresh(s["parent"])
    assert s["parent"].client_sample_id == "GLOW"
