"""GET /api/sub-samples/board — cross-order vial status board (spec
docs/superpowers/specs/2026-08-31-vial-status-board-design.md §4).

Hermetic: StaticPool SQLite + dependency_overrides; the test-order lookup
(main._test_order_senaite_ids) is monkeypatched per-test."""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from auth import get_current_user
from database import Base, get_db
from main import app
from models import (
    AnalysisService,
    Department,
    LimsAnalysis,
    LimsSample,
    LimsSubSample,
    SamplePriority,
    User,
    VialRole,
    Worksheet,
    WorksheetItem,
)

DEPT_ANALYTICAL = 101
DEPT_MICRO = 102


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    _seed_catalog(session)
    yield session
    session.close()


@pytest.fixture
def client(db, monkeypatch):
    import main as main_module

    monkeypatch.setattr(main_module, "_test_order_senaite_ids", lambda: set())

    def _override_get_db():
        yield db

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, email="qa@accumark.test"
    )
    try:
        yield TestClient(app)
    finally:
        if prev_db is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = prev_db
        if prev_user is None:
            app.dependency_overrides.pop(get_current_user, None)
        else:
            app.dependency_overrides[get_current_user] = prev_user


def _seed_catalog(db):
    db.add_all([
        Department(id=DEPT_ANALYTICAL, name="Analytical", color="blue", sort_order=1),
        Department(id=DEPT_MICRO, name="Microbiology", color="violet", sort_order=2),
    ])
    db.add_all([
        VialRole(code="hplc", label="HPLC", department_id=DEPT_ANALYTICAL, sort_order=1),
        VialRole(code="ster", label="Sterility", department_id=DEPT_MICRO, sort_order=2),
        VialRole(code="endo", label="Endotoxin", department_id=DEPT_MICRO, sort_order=3),
        VialRole(code="xtra", label="Extra", department_id=None, sort_order=9),
    ])
    svc = AnalysisService(title="Purity Hplc", keyword="PURITY", department_id=DEPT_ANALYTICAL)
    db.add(svc)
    db.commit()


def _svc(db):
    return db.query(AnalysisService).first()


def _parent(db, *, sid, uid=None, role="hplc", peptide=None):
    row = LimsSample(
        sample_id=sid,
        external_lims_uid=uid or f"uid-{sid}",
        status="sample_received",
        assignment_role=role,
        peptide_name=peptide,
    )
    db.add(row)
    db.flush()
    return row


def _vial(db, *, parent, seq=1, role="hplc"):
    row = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid=f"uid-{parent.sample_id}-S{seq:02d}",
        sample_id=f"{parent.sample_id}-S{seq:02d}",
        vial_sequence=seq,
        assignment_role=role,
    )
    db.add(row)
    db.flush()
    return row


def _analysis(db, *, vial, state="unassigned", retested=False, analyst=None, title=None):
    svc = _svc(db)
    row = LimsAnalysis(
        lims_sub_sample_pk=vial.id,
        analysis_service_id=svc.id,
        keyword=svc.keyword,
        title=title or svc.title,
        review_state=state,
        retested=retested,
        analyst_user_id=analyst,
        provenance="canonical",
    )
    db.add(row)
    db.flush()
    return row


def _get_board(client, **params):
    resp = client.get("/api/sub-samples/board", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_mixed_state_vial_appears_with_full_analysis_list(client, db):
    """A vial with one live + one promoted + one rejected + one retracted
    analysis is on the board, and the payload carries ALL four rows (terminal
    columns render the vial's whole story while it is in flight — spec §4)."""
    p = _parent(db, sid="PB-9001", peptide="Semaglutide 5 mg")
    v = _vial(db, parent=p)
    _analysis(db, vial=v, state="assigned")
    _analysis(db, vial=v, state="promoted")
    _analysis(db, vial=v, state="rejected")
    _analysis(db, vial=v, state="retracted")
    db.commit()

    body = _get_board(client)
    assert body["total"] == 1
    vial = body["vials"][0]
    assert vial["sample_id"] == "PB-9001-S01"
    assert vial["parent"]["sample_id"] == "PB-9001"
    assert vial["parent"]["label"] == "Semaglutide 5 mg"
    states = sorted(a["review_state"] for a in vial["analyses"])
    assert states == ["assigned", "promoted", "rejected", "retracted"]


def test_fully_promoted_vial_excluded(client, db):
    p = _parent(db, sid="PB-9002")
    v = _vial(db, parent=p)
    _analysis(db, vial=v, state="promoted")
    _analysis(db, vial=v, state="variance_verified")
    db.commit()
    assert _get_board(client)["total"] == 0


def test_retracted_only_vial_excluded(client, db):
    p = _parent(db, sid="PB-9003")
    v = _vial(db, parent=p)
    _analysis(db, vial=v, state="retracted")
    db.commit()
    assert _get_board(client)["total"] == 0


def test_superseded_retest_rows_do_not_include_or_surface(client, db):
    """A retested=True row in a live-looking state neither includes the vial
    nor appears in the payload (current-row idiom, main.py:19189)."""
    p = _parent(db, sid="PB-9004")
    v = _vial(db, parent=p)
    _analysis(db, vial=v, state="assigned", retested=True)
    db.commit()
    assert _get_board(client)["total"] == 0

    _analysis(db, vial=v, state="to_be_verified")
    db.commit()
    body = _get_board(client)
    assert body["total"] == 1
    assert [a["review_state"] for a in body["vials"][0]["analyses"]] == ["to_be_verified"]


def test_null_role_excluded_and_xtra_gated_by_show_xtra(client, db):
    p = _parent(db, sid="PB-9005")
    v_null = _vial(db, parent=p, seq=1)
    v_null.assignment_role = None
    v_xtra = _vial(db, parent=p, seq=2, role="xtra")
    _analysis(db, vial=v_null, state="unassigned")
    _analysis(db, vial=v_xtra, state="unassigned")
    db.commit()

    assert _get_board(client)["total"] == 0
    body = _get_board(client, show_xtra="true")
    assert body["total"] == 1
    assert body["vials"][0]["assignment_role"] == "xtra"


def test_lane_filters_to_lane_role_codes(client, db):
    p = _parent(db, sid="PB-9006")
    v_hplc = _vial(db, parent=p, seq=1, role="hplc")
    v_endo = _vial(db, parent=p, seq=2, role="endo")
    _analysis(db, vial=v_hplc, state="assigned")
    _analysis(db, vial=v_endo, state="assigned")
    db.commit()

    body = _get_board(client, lane="microbiology")
    assert body["total"] == 1
    assert body["vials"][0]["assignment_role"] == "endo"


def test_unknown_lane_400(client, db):
    resp = client.get("/api/sub-samples/board", params={"lane": "nope"})
    assert resp.status_code == 400
    assert "nope" in resp.json()["detail"]


def test_vials_sorted_by_parent_then_sequence(client, db):
    p2 = _parent(db, sid="PB-9008")
    p1 = _parent(db, sid="PB-9007")
    vb = _vial(db, parent=p2, seq=1)
    va2 = _vial(db, parent=p1, seq=2)
    va1 = _vial(db, parent=p1, seq=1)
    for v in (vb, va2, va1):
        _analysis(db, vial=v, state="unassigned")
    db.commit()

    ids = [v["sample_id"] for v in _get_board(client)["vials"]]
    assert ids == ["PB-9007-S01", "PB-9007-S02", "PB-9008-S01"]
