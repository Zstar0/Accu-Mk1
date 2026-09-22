"""scripts/backfill_endo_worksheets: Mk1 worksheets from Dennis's endotoxin run
log (spec 2026-09-18-endo-worksheet-design §5). In-memory SQLite, no live stack.
"""
import json
from datetime import date, datetime

from sqlalchemy import select

from models import (
    AnalysisService,
    Department,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    User,
    Worksheet,
    WorksheetItem,
)
from scripts.backfill_endo_worksheets import load_runs, run_backfill, worksheet_title_for_run


def _seed(db):
    micro = Department(name="Microbiology")
    db.add(micro)
    db.flush()
    guian = User(email="guian@lab.test", hashed_password="x", first_name="Guian", last_name="C")
    db.add(guian)
    db.flush()
    svc = AnalysisService(keyword="ENDOTOXIN-USP85LAL", title="Endotoxin USP85 LAL", department_id=micro.id)
    db.add(svc)
    db.flush()

    def parent(sample_id, declared, **kw):
        p = LimsSample(sample_id=sample_id, external_lims_uid=f"SEN-{sample_id}",
                       declared_total_quantity=declared, client_order_number="WP-7536",
                       date_received=datetime(2026, 9, 10, 16, 30), **kw)
        db.add(p)
        db.flush()
        return p

    def vial(p, sample_id, uid, state):
        s = LimsSubSample(sample_id=sample_id, parent_sample_pk=p.id, vial_sequence=2,
                          external_lims_uid=uid, assignment_role="endo85")
        db.add(s)
        db.flush()
        a = LimsAnalysis(lims_sub_sample_pk=s.id, analysis_service_id=svc.id, keyword=svc.keyword,
                         title=svc.title, review_state=state, result_value="0.5" if state == "promoted" else None)
        db.add(a)
        db.flush()
        return s, a

    v1, a1 = vial(parent("P-2995", "10", sample_type_title="Peptide"), "P-2995-S02", "mk1://v1", "promoted")
    v2, a2 = vial(parent("P-2826", "24", sample_type_title="Peptide"), "P-2826-S02", "mk1://v2", "unassigned")
    v3, a3 = vial(parent("P-2757", "10", sample_type_title="Peptide"), "P-2757-S02", "mk1://v3", "promoted")
    v4, a4 = vial(parent("BW-0114", None, sample_type_title="Bacteriostatic Water"), "BW-0114-S02", "mk1://v4", "promoted")

    # v3 is already on one of the lab's own per-order worksheets.
    old = Worksheet(title="6268 E", status="completed", created_at=datetime(2026, 9, 2, 17))
    db.add(old)
    db.flush()
    old_item = WorksheetItem(worksheet_id=old.id, sample_uid=v3.external_lims_uid, sample_id=v3.sample_id,
                             department_id=micro.id)
    db.add(old_item)
    db.commit()
    return {"micro": micro, "guian": guian, "a1": a1, "a2": a2, "a3": a3, "a4": a4, "old_item": old_item}


def _run(name="09112026-3", analyst="Guian", rows=None):
    return {
        "name": name, "analyst": analyst, "dateMade": "2026-09-11", "dueDate": "2026-09-14",
        "orders": "7536, 7539", "seq": 17,
        "rows": rows if rows is not None else [
            {"id": "r1", "b": "7536", "c": "P-2995-S02", "d": "MOTS-c", "e": 1, "f": 30, "g": None, "p": "high", "rc": "2026-09-10"},
            {"id": "r2", "b": "7539", "c": "P-2826", "d": "Retatrutide", "e": 1, "f": 24, "g": 2},
            {"id": "r3", "b": "7695", "c": "P-2757", "d": "Tesamorelin", "e": 1, "f": 10, "g": 3},
            {"id": "r4", "b": "7695", "c": "BW-0114", "d": "Bacteriostatic Water", "e": 1,
             "f": "40X Dilution in 1 EU/mL Cartridge", "g": None},
            {"id": "r5", "b": "1", "c": "P-9999", "d": "Nope", "e": 1, "f": 5, "g": None},
        ],
    }


def test_load_runs_reads_the_live_store_shape(tmp_path):
    p = tmp_path / "endotoxin-data.json"
    p.write_text(json.dumps({"savedAt": "2026-09-18T04:09:34Z",
                             "store": {"runs/09112026-3": _run(), "runs/09102026": _run("09102026", "")}}))
    runs = load_runs(str(p))
    assert [r["name"] for r in runs] == ["09102026", "09112026-3"]  # sorted by run name


def test_worksheet_title_from_run_name_and_label():
    assert worksheet_title_for_run({"name": "09112026-3", "dateMade": "2026-09-11"}) == "Endo 09/11/2026 #3"
    assert worksheet_title_for_run({"name": "09102026", "dateMade": "2026-09-10"}) == "Endo 09/10/2026"
    assert worksheet_title_for_run({"name": "09102026", "label": "Monday bench", "dateMade": "2026-09-10"}) == "Monday bench"


def test_dry_run_reports_and_writes_nothing(db_session):
    s = _seed(db_session)
    report = run_backfill(db_session, [_run()], apply=False, today=date(2026, 9, 18))
    r = report["runs"][0]
    assert r["name"] == "09112026-3"
    assert r["analyst_user_id"] == s["guian"].id
    assert r["resolved"] == 4
    assert r["unresolved"] == ["P-9999"]
    assert r["existing"] == 1
    assert r["new"] == 3
    assert r["status"] == "open"  # one endo row is still unassigned
    assert report["applied"] is False
    assert db_session.query(Worksheet).count() == 1
    db_session.refresh(s["old_item"])
    assert s["old_item"].prep_volume_ml is None


def test_apply_creates_the_worksheet_stamps_analysts_and_is_idempotent(db_session):
    s = _seed(db_session)
    run_backfill(db_session, [_run()], apply=True, today=date(2026, 9, 18))

    ws = db_session.execute(select(Worksheet).where(Worksheet.title == "Endo 09/11/2026 #3")).scalar_one()
    assert ws.status == "open"
    assert ws.assigned_analyst_id == s["guian"].id
    assert ws.created_at.date() == date(2026, 9, 11)
    assert json.loads(ws.notes)["text"].startswith("Backfilled from Dennis's endotoxin log run 09112026-3")
    items = {it.sample_id: it for it in db_session.query(WorksheetItem).filter_by(worksheet_id=ws.id).all()}
    assert set(items) == {"P-2995-S02", "P-2826-S02", "BW-0114-S02"}
    assert all(it.department_id == s["micro"].id for it in items.values())
    assert items["P-2995-S02"].prep_weight_mg == 30        # log 30 vs declared 10
    assert items["P-2995-S02"].prep_volume_ml is None
    assert items["P-2826-S02"].prep_weight_mg is None      # log 24 == declared 24
    assert items["P-2826-S02"].prep_volume_ml == 2
    assert items["BW-0114-S02"].prep_dilution_factor == 40
    assert items["P-2995-S02"].date_received == datetime(2026, 9, 10, 16, 30)
    assert json.loads(items["P-2995-S02"].analyses_json)[0]["keyword"] == "ENDOTOXIN-USP85LAL"

    for a in (s["a1"], s["a2"], s["a4"]):
        db_session.refresh(a)
    assert s["a1"].analyst_user_id == s["guian"].id   # promoted row: attribution backfilled
    assert s["a2"].analyst_user_id == s["guian"].id
    assert s["a2"].review_state == "assigned"           # the drawer's own assign transition
    assert s["a4"].analyst_user_id == s["guian"].id

    # The vial already on "6268 E" keeps that worksheet and its own attribution;
    # only its empty prep override is filled in from the log.
    db_session.refresh(s["a3"])
    db_session.refresh(s["old_item"])
    assert s["a3"].analyst_user_id is None
    assert s["old_item"].prep_volume_ml == 3
    assert db_session.query(Worksheet).count() == 2

    # Second apply: nothing new.
    report = run_backfill(db_session, [_run()], apply=True, today=date(2026, 9, 18))
    assert report["runs"][0]["new"] == 0
    assert report["runs"][0]["existing"] == 4
    assert db_session.query(Worksheet).count() == 2
    assert db_session.query(WorksheetItem).count() == 4


def test_run_with_every_row_past_submission_is_completed(db_session):
    _seed(db_session)
    rows = [{"id": "r1", "b": "7536", "c": "P-2995-S02", "d": "MOTS-c", "e": 1, "f": 10, "g": None}]
    run_backfill(db_session, [_run(rows=rows)], apply=True, today=date(2026, 9, 18))
    ws = db_session.execute(select(Worksheet).where(Worksheet.title == "Endo 09/11/2026 #3")).scalar_one()
    assert ws.status == "completed"
    assert ws.completed_at is not None


def test_unknown_analyst_leaves_the_worksheet_unassigned(db_session):
    s = _seed(db_session)
    run = _run(analyst="Nobody", rows=[{"id": "r1", "b": "7536", "c": "P-2995-S02", "d": "MOTS-c", "e": 1, "f": 10, "g": None}])
    report = run_backfill(db_session, [run], apply=True, today=date(2026, 9, 18))
    assert report["runs"][0]["analyst_user_id"] is None
    assert report["runs"][0]["analyst_unresolved"] == "Nobody"
    ws = db_session.execute(select(Worksheet).where(Worksheet.title == "Endo 09/11/2026 #3")).scalar_one()
    assert ws.assigned_analyst_id is None
    db_session.refresh(s["a1"])
    assert s["a1"].analyst_user_id is None
