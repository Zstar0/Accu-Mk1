"""Reassign moves a claimed vial between open worksheets WITHOUT bouncing its
rows through reset -> assign (2026-09-08 worksheet -> `assigned` wiring).

Route under test: POST /worksheets/{worksheet_id}/items/{item_id}/reassign.
Hermetic: StaticPool SQLite + dependency_overrides (test_sub_samples_board
harness)."""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db
from main import app
from models import (
    AnalysisService,
    Department,
    LimsAnalysis,
    LimsAnalysisTransition,
    LimsSample,
    LimsSubSample,
    User,
    Worksheet,
    WorksheetItem,
)
from lims_analyses.worksheet_analyst import stamp_for_item


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture
def client(db):
    def _override_get_db():
        yield db

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1, email="qa@accumark.test")
    try:
        yield TestClient(app)
    finally:
        for dep, prev in ((get_db, prev_db), (get_current_user, prev_user)):
            if prev is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = prev


def test_reassign_keeps_assigned_state_and_swaps_analyst(client, db):
    dept = Department(name="Analytical")
    old, new = User(email="old@x.test", hashed_password="x"), User(email="new@x.test", hashed_password="x")
    db.add_all([dept, old, new])
    db.flush()
    parent = LimsSample(sample_id="P-RA-001", external_lims_uid="SEN-P-RA-001")
    db.add(parent)
    db.flush()
    sub = LimsSubSample(sample_id="P-RA-001-S01", parent_sample_pk=parent.id, vial_sequence=1,
                        external_lims_uid="mk1://ra-1", assignment_role="hplc")
    svc = AnalysisService(keyword="HPLC-PUR", title="Purity", department_id=dept.id)
    db.add_all([sub, svc])
    db.flush()
    row = LimsAnalysis(lims_sub_sample_pk=sub.id, analysis_service_id=svc.id, keyword="HPLC-PUR",
                       title="Purity", review_state="unassigned", method_id=42)
    src = Worksheet(title="WS-SRC", status="open", assigned_analyst_id=old.id)
    dst = Worksheet(title="WS-DST", status="open", assigned_analyst_id=new.id)
    db.add_all([row, src, dst])
    db.flush()
    item = WorksheetItem(worksheet_id=src.id, sample_uid=sub.external_lims_uid,
                         sample_id=sub.sample_id, department_id=dept.id)
    db.add(item)
    db.flush()
    stamp_for_item(db, sample_uid=sub.external_lims_uid, service_group_id=None,
                   department_id=dept.id, analyst_user_id=old.id, acting_user_id=1,
                   worksheet_id=src.id, worksheet_title=src.title)
    db.commit()
    assert row.review_state == "assigned" and row.analyst_user_id == old.id

    resp = client.post(f"/worksheets/{src.id}/items/{item.id}/reassign",
                       json={"target_worksheet_id": dst.id})
    assert resp.status_code == 200, resp.text

    db.refresh(row)
    db.refresh(item)
    assert item.worksheet_id == dst.id
    assert row.review_state == "assigned"
    assert row.analyst_user_id == new.id
    assert row.method_id == 42
    kinds = [t.transition_kind for t in db.execute(
        select(LimsAnalysisTransition).where(LimsAnalysisTransition.analysis_id == row.id)
        .order_by(LimsAnalysisTransition.id)).scalars()]
    assert kinds == ["assign"], f"reassign must not bounce through reset: {kinds}"
