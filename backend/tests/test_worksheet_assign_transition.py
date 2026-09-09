"""Worksheet membership drives the vial-tier `assigned` state (2026-09-08).

Root cause fixed here: add-to-worksheet stamped analyst_user_id but never
applied the state machine's `assign` transition, so `assigned` was never
written in prod (Vial Status Board "Assigned" column empty by construction).
Now: stamp -> assign pending rows; clear -> reset assigned rows; worksheet
complete -> release unfinished rows. Rows are scoped exactly like the
analyst stamp (department / group / wildcard).
"""
from sqlalchemy import select

from lims_analyses.service import apply_transition, create_analysis
from lims_analyses.worksheet_analyst import (
    clear_for_item,
    release_for_worksheet,
    stamp_for_item,
)
from models import (
    AnalysisService,
    Department,
    LimsAnalysis,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
    LimsSubSampleEvent,
    User,
    Worksheet,
    WorksheetItem,
)


def _parent(db, sid="P-WA-001"):
    p = LimsSample(sample_id=sid, external_lims_uid=f"SEN-{sid}")
    db.add(p)
    db.flush()
    return p


def _sub(db, parent, sid="P-WA-001-S01", uid="mk1://wa-sub-1", role="hplc"):
    s = LimsSubSample(
        sample_id=sid, parent_sample_pk=parent.id, vial_sequence=1,
        external_lims_uid=uid, assignment_role=role,
    )
    db.add(s)
    db.flush()
    return s


def _dept(db, name="Analytical"):
    d = Department(name=name)
    db.add(d)
    db.flush()
    return d


def _svc(db, keyword, title, department=None):
    svc = AnalysisService(keyword=keyword, title=title)
    if department is not None:
        svc.department_id = department.id
    db.add(svc)
    db.flush()
    return svc


def _row(db, sub, svc, state="unassigned", result=None):
    a = LimsAnalysis(
        lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
        keyword=svc.keyword, title=svc.title, review_state=state,
        result_value=result,
    )
    db.add(a)
    db.flush()
    return a


def _user(db, email="tech@accumark.test"):
    u = User(email=email, hashed_password="x")
    db.add(u)
    db.flush()
    return u


def _kinds(db, row):
    return [
        t.transition_kind for t in db.execute(
            select(LimsAnalysisTransition)
            .where(LimsAnalysisTransition.analysis_id == row.id)
            .order_by(LimsAnalysisTransition.id)
        ).scalars()
    ]


def _events(db, sub, event):
    return [
        e for e in db.execute(
            select(LimsSubSampleEvent).where(LimsSubSampleEvent.sub_sample_pk == sub.id)
        ).scalars() if e.event == event
    ]


def _stamp(db, sub, dept, analyst, acting, ws_id=7, title="WS-2026-09-08-001"):
    return stamp_for_item(
        db, sample_uid=sub.external_lims_uid, service_group_id=None,
        department_id=dept.id, analyst_user_id=analyst.id, acting_user_id=acting.id,
        worksheet_id=ws_id, worksheet_title=title,
    )


# -- stamp -> assign ----------------------------------------------------------

def test_stamp_assigns_pending_rows_and_audits(db_session):
    db = db_session
    dept = _dept(db)
    analyst, acting = _user(db, "a@x.test"), _user(db, "b@x.test")
    sub = _sub(db, _parent(db))
    pur = _svc(db, "HPLC-PUR", "Purity", dept)
    idr = _svc(db, "ID_BPC", "Identity", dept)
    dead = _svc(db, "HPLC-X", "Retracted thing", dept)
    pending = _row(db, sub, pur)
    entered = _row(db, sub, idr, state="to_be_verified", result="conforms")
    retracted = _row(db, sub, dead, state="retracted")

    _stamp(db, sub, dept, analyst, acting)

    assert pending.review_state == "assigned"
    assert _kinds(db, pending) == ["assign"]
    tr = db.execute(select(LimsAnalysisTransition).where(
        LimsAnalysisTransition.analysis_id == pending.id)).scalar_one()
    assert (tr.from_state, tr.to_state, tr.user_id) == ("unassigned", "assigned", acting.id)
    assert entered.review_state == "to_be_verified" and _kinds(db, entered) == []
    assert retracted.review_state == "retracted" and _kinds(db, retracted) == []
    (ev,) = _events(db, sub, "worksheet_assigned")
    assert ev.details["assigned_keywords"] == ["HPLC-PUR"]


def test_stamp_respects_department_scope_for_assign(db_session):
    db = db_session
    analytical, micro = _dept(db, "Analytical"), _dept(db, "Microbiology")
    analyst, acting = _user(db, "a@x.test"), _user(db, "b@x.test")
    sub = _sub(db, _parent(db))
    hplc_row = _row(db, sub, _svc(db, "HPLC-PUR", "Purity", analytical))
    endo_row = _row(db, sub, _svc(db, "ENDO-LAL", "Endotoxin", micro))

    _stamp(db, sub, analytical, analyst, acting)

    assert hplc_row.review_state == "assigned"
    assert endo_row.review_state == "unassigned"


def test_stamp_twice_is_idempotent_for_assign(db_session):
    db = db_session
    dept = _dept(db)
    analyst, acting = _user(db, "a@x.test"), _user(db, "b@x.test")
    sub = _sub(db, _parent(db))
    row = _row(db, sub, _svc(db, "HPLC-PUR", "Purity", dept))

    _stamp(db, sub, dept, analyst, acting)
    _stamp(db, sub, dept, analyst, acting)

    assert row.review_state == "assigned"
    assert _kinds(db, row) == ["assign"]


def test_stamp_does_not_commit_the_host_transaction(db_session, monkeypatch):
    """The add-item route owns the commit; a mid-route commit would persist a
    half-applied worksheet operation. apply_transition commits by default --
    the stamp path must opt out."""
    db = db_session
    dept = _dept(db)
    analyst, acting = _user(db, "a@x.test"), _user(db, "b@x.test")
    sub = _sub(db, _parent(db))
    row = _row(db, sub, _svc(db, "HPLC-PUR", "Purity", dept))
    commits = []
    real_commit = db.commit
    monkeypatch.setattr(db, "commit", lambda: commits.append(1) or real_commit())

    _stamp(db, sub, dept, analyst, acting)

    assert row.review_state == "assigned"
    assert commits == []


# -- clear -> reset -----------------------------------------------------------

def test_clear_resets_assigned_rows_only(db_session):
    db = db_session
    dept = _dept(db)
    analyst, acting = _user(db, "a@x.test"), _user(db, "b@x.test")
    sub = _sub(db, _parent(db))
    pending = _row(db, sub, _svc(db, "HPLC-PUR", "Purity", dept))
    entered = _row(db, sub, _svc(db, "ID_BPC", "Identity", dept),
                   state="to_be_verified", result="conforms")
    _stamp(db, sub, dept, analyst, acting)
    assert pending.review_state == "assigned"

    clear_for_item(
        db, sample_uid=sub.external_lims_uid, service_group_id=None,
        department_id=dept.id, acting_user_id=acting.id, worksheet_id=7,
        worksheet_title="WS-2026-09-08-001",
    )

    assert pending.review_state == "unassigned"
    assert pending.analyst_user_id is None
    assert _kinds(db, pending) == ["assign", "reset"]
    assert entered.review_state == "to_be_verified"
    (ev,) = _events(db, sub, "worksheet_removed")
    assert ev.details["reset_keywords"] == ["HPLC-PUR"]


# -- complete -> release ------------------------------------------------------

def test_release_for_worksheet_resets_unfinished_rows(db_session):
    db = db_session
    dept = _dept(db)
    analyst, acting = _user(db, "a@x.test"), _user(db, "b@x.test")
    sub = _sub(db, _parent(db))
    pur = _svc(db, "HPLC-PUR", "Purity", dept)
    idr = _svc(db, "ID_BPC", "Identity", dept)
    unfinished = _row(db, sub, pur)
    finished = _row(db, sub, idr)
    ws = Worksheet(title="WS-2026-09-08-001", status="open", assigned_analyst_id=analyst.id)
    db.add(ws)
    db.flush()
    db.add(WorksheetItem(worksheet_id=ws.id, sample_uid=sub.external_lims_uid,
                         sample_id=sub.sample_id, department_id=dept.id))
    db.flush()
    _stamp(db, sub, dept, analyst, acting, ws_id=ws.id, title=ws.title)
    apply_transition(db, analysis_id=finished.id, kind="submit",
                     result_value="conforms", user_id=analyst.id)
    assert unfinished.review_state == "assigned"

    n = release_for_worksheet(db, worksheet=ws, acting_user_id=acting.id)

    assert n == 1
    assert unfinished.review_state == "unassigned"
    assert unfinished.analyst_user_id is None
    assert _kinds(db, unfinished) == ["assign", "reset"]
    assert finished.review_state == "to_be_verified"
    assert finished.analyst_user_id == analyst.id
    (ev,) = _events(db, sub, "worksheet_released")
    assert ev.details["reset_keywords"] == ["HPLC-PUR"]


# -- the HPLC bridge must still find rows that are on a worksheet -------------

def test_prep_bridge_writes_result_onto_assigned_row(db_session):
    from lims_analyses.prep_bridge import bridge_prep_result_to_vial
    from models import HPLCAnalysis, Peptide
    db = db_session
    pep = Peptide(name="BPC-157", abbreviation="BPC-157")
    db.add(pep)
    db.flush()
    sub = _sub(db, _parent(db), sid="P-0142-S01", uid="UID-P-0142-S01")
    pur = create_analysis(db, host_kind="sub_sample", host_pk=sub.id,
                          analysis_service_id=73, keyword="HPLC-PUR", title="Peptide Purity (HPLC)")
    apply_transition(db, analysis_id=pur.id, kind="assign", user_id=1)
    assert pur.review_state == "assigned"
    a = HPLCAnalysis(
        sample_id_label="P-0142-S01", peptide_id=pep.id,
        stock_vial_empty=1.0, stock_vial_with_diluent=2.0, dil_vial_empty=1.0,
        dil_vial_with_diluent=2.0, dil_vial_with_diluent_and_sample=3.0,
        purity_percent=98.5,
    )
    db.add(a)
    db.flush()

    ids = bridge_prep_result_to_vial(db, lims_sub_sample_pk=sub.id, analysis=a, peptide=pep, user_id=1)

    assert ids == [pur.id]
    db.refresh(pur)
    assert pur.review_state == "to_be_verified" and pur.result_value == "98.5"


# -- one-time prod backfill (scripts/backfill_worksheet_assign.py) ------------

def _open_ws_with_pending_row(db, dept, analyst, *, title, status="open", sid="P-BF-S01",
                              uid="mk1://bf-1"):
    sub = _sub(db, _parent(db, sid=f"PAR-{sid}"), sid=sid, uid=uid)
    row = _row(db, sub, _svc(db, f"HPLC-{sid}", "Purity", dept))
    row.analyst_user_id = analyst.id  # prod shape: analyst stamped, state never moved
    ws = Worksheet(title=title, status=status, assigned_analyst_id=analyst.id)
    db.add(ws)
    db.flush()
    db.add(WorksheetItem(worksheet_id=ws.id, sample_uid=sub.external_lims_uid,
                         sample_id=sub.sample_id, department_id=dept.id))
    db.flush()
    return row


def test_backfill_dry_run_reports_without_changing_state(db_session):
    from scripts.backfill_worksheet_assign import run
    db = db_session
    dept, analyst = _dept(db), _user(db)
    row = _open_ws_with_pending_row(db, dept, analyst, title="WS-OPEN-1")

    report = run(db, apply=False)

    assert report["open_worksheets"] == 1
    assert report["rows_to_assign"] == 1
    assert report["applied"] is False
    assert row.review_state == "unassigned"
    assert _kinds(db, row) == []


def test_backfill_apply_assigns_open_worksheet_rows_only(db_session):
    from scripts.backfill_worksheet_assign import run
    db = db_session
    dept, analyst = _dept(db), _user(db)
    open_row = _open_ws_with_pending_row(db, dept, analyst, title="WS-OPEN-1")
    done_row = _open_ws_with_pending_row(db, dept, analyst, title="WS-DONE-1", status="completed",
                                         sid="P-BF-S02", uid="mk1://bf-2")

    report = run(db, apply=True)

    assert report["applied"] is True and report["rows_to_assign"] == 1
    assert open_row.review_state == "assigned"
    assert _kinds(db, open_row) == ["assign"]
    assert done_row.review_state == "unassigned"
    # idempotent: a second apply finds nothing left to do
    assert run(db, apply=True)["rows_to_assign"] == 0


# -- worksheet-path reset must not destroy prep stamps / bench drafts ---------

def test_clear_preserves_draft_and_prep_stamps(db_session):
    """Removal never wiped method/instrument/result before the assign wiring
    landed; the state machine's generic `reset` does. Worksheet-path resets
    only revert the claim."""
    db = db_session
    dept = _dept(db)
    analyst, acting = _user(db, "a@x.test"), _user(db, "b@x.test")
    sub = _sub(db, _parent(db))
    row = _row(db, sub, _svc(db, "HPLC-PUR", "Purity", dept))
    _stamp(db, sub, dept, analyst, acting)
    row.method_id, row.instrument_id, row.result_value = 42, 7, "97.1"
    db.flush()

    clear_for_item(
        db, sample_uid=sub.external_lims_uid, service_group_id=None,
        department_id=dept.id, acting_user_id=acting.id, worksheet_id=7,
    )

    assert row.review_state == "unassigned"
    assert (row.method_id, row.instrument_id, row.result_value) == (42, 7, "97.1")


def test_clear_with_reset_state_false_keeps_the_claim(db_session):
    """The reassign route does clear -> stamp to swap analysts; the row must
    stay `assigned` across that swap (no reset/assign bounce)."""
    db = db_session
    dept = _dept(db)
    old, new, acting = _user(db, "old@x.test"), _user(db, "new@x.test"), _user(db, "b@x.test")
    sub = _sub(db, _parent(db))
    row = _row(db, sub, _svc(db, "HPLC-PUR", "Purity", dept))
    _stamp(db, sub, dept, old, acting)

    clear_for_item(
        db, sample_uid=sub.external_lims_uid, service_group_id=None,
        department_id=dept.id, acting_user_id=acting.id, worksheet_id=7,
        reset_state=False,
    )
    _stamp(db, sub, dept, new, acting)

    assert row.review_state == "assigned"
    assert row.analyst_user_id == new.id
    assert _kinds(db, row) == ["assign"]
