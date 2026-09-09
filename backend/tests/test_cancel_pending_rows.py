from sqlalchemy import select

from models import (AnalysisService, LimsAnalysis, LimsSample, LimsSubSample, Worksheet,
                    WorksheetItem)


def _fixture(db):
    p = LimsSample(sample_id="P-CPR-1", status="sample_received", native_status="sample_received")
    db.add(p)
    db.flush()
    v = LimsSubSample(sample_id="P-CPR-1-S01", parent_sample_pk=p.id, vial_sequence=1,
                      external_lims_uid="mk1://vial/1")
    db.add(v)
    svc = AnalysisService(keyword="K-CPR", title="t")
    db.add(svc)
    db.flush()
    rows = {}
    for name, state, host in (("pending_vial", "assigned", "vial"),
                              ("done_vial", "promoted", "vial"),
                              ("pending_parent", "parent_to_verify", "parent"),
                              ("done_parent", "verified", "parent"),
                              ("dead_vial", "cancelled", "vial")):
        a = LimsAnalysis(analysis_service_id=svc.id, keyword="K-CPR", title="t", review_state=state,
                         provenance="canonical", retested=False,
                         lims_sub_sample_pk=v.id if host == "vial" else None,
                         lims_sample_pk=None if host == "vial" else p.id,
                         analyst_user_id=7 if name == "pending_vial" else None)
        db.add(a)
        db.flush()
        rows[name] = a
    ws = Worksheet(title="WS-CPR", status="open")
    db.add(ws)
    db.flush()
    item = WorksheetItem(worksheet_id=ws.id, sample_uid="mk1://vial/1", sample_id="P-CPR-1-S01")
    db.add(item)
    db.flush()
    return p, v, rows, ws, item


def test_preview_counts_without_writing(db_session):
    from lims_analyses.service import preview_cancel
    p, v, rows, ws, item = _fixture(db_session)
    pv = preview_cancel(db_session, parent_sample_pk=p.id)
    assert sorted(pv["cancelled_rows"]) == sorted([rows["pending_vial"].id, rows["pending_parent"].id])
    assert pv["released_worksheets"] == [ws.id]
    assert rows["pending_vial"].review_state == "assigned"
    assert sorted(pv["kept_rows"]) == sorted([rows["done_vial"].id, rows["done_parent"].id])
    assert rows["dead_vial"].id not in pv["cancelled_rows"]
    assert rows["dead_vial"].id not in pv["kept_rows"]


def test_cancel_pending_rows_cancels_releases_and_keeps_history(db_session):
    from lims_analyses.service import cancel_pending_rows
    p, v, rows, ws, item = _fixture(db_session)
    out = cancel_pending_rows(db_session, parent_sample_pk=p.id, user_id=None, reason="customer")
    assert sorted(out["cancelled_rows"]) == sorted([rows["pending_vial"].id, rows["pending_parent"].id])
    assert rows["pending_vial"].review_state == "cancelled"
    assert rows["pending_parent"].review_state == "cancelled"
    assert rows["done_vial"].review_state == "promoted"
    assert rows["done_parent"].review_state == "verified"
    assert rows["pending_vial"].analyst_user_id is None
    assert out["released_worksheets"] == [ws.id]
    assert db_session.execute(select(WorksheetItem).where(WorksheetItem.id == item.id)).scalar_one_or_none() is None
    assert sorted(out["kept_rows"]) == sorted([rows["done_vial"].id, rows["done_parent"].id])
    assert rows["dead_vial"].id not in out["cancelled_rows"]
    assert rows["dead_vial"].id not in out["kept_rows"]
