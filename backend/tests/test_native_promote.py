"""Native (origin='mk1') promote: no SENAITE write-back, ID-keyed identity.

The SENAITE-origin path must stay byte-identical: write-back still runs and
still rolls the whole promote back on failure (fail-closed).

Fixture idiom copied from test_analysis_service_routes.py's `route_client`
(StaticPool in-memory SQLite + get_db/get_current_user dependency overrides,
snapshot/restore on teardown).
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from main import app
from auth import get_current_user
from database import get_db, Base
from lims_analyses.senaite_writeback import SenaiteWritebackError


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture
def client(db_session):
    def _override_get_db():
        yield db_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(
        id=1, email="qa@accumark.test"
    )
    tc = TestClient(app)
    yield tc
    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user


def _mk_service(db, *, keyword, origin, unit=None):
    from models import AnalysisService
    svc = AnalysisService(title=keyword.title(), keyword=keyword, origin=origin, unit=unit)
    db.add(svc)
    db.flush()
    return svc


def _mk_parent_and_vial_rows(db, svc, *, n_vials=1):
    """One LimsSample parent + n sub-samples, each with a to_be_verified
    lims_analyses row for svc. Returns (parent, [vial_rows])."""
    from models import LimsAnalysis, LimsSample, LimsSubSample
    parent = LimsSample(sample_id="P-9001")
    db.add(parent)
    db.flush()
    rows = []
    for i in range(n_vials):
        sub = LimsSubSample(
            parent_sample_pk=parent.id,
            external_lims_uid=f"uid-P-9001-S{i+1:02d}",
            sample_id=f"P-9001-S{i+1:02d}",
            vial_sequence=i + 1,
        )
        db.add(sub)
        db.flush()
        row = LimsAnalysis(
            lims_sub_sample_pk=sub.id, analysis_service_id=svc.id,
            keyword=svc.keyword, title=svc.title,
            result_value="0.12", review_state="to_be_verified",
        )
        db.add(row)
        db.flush()
        rows.append(row)
    return parent, rows


def test_native_promote_never_touches_senaite(client, db_session):
    """origin='mk1' parent service: promote succeeds with the write-back
    hard-broken. If the gate is deleted, this test fails with a 502."""
    svc = _mk_service(db_session, keyword="HM-PB", origin="mk1", unit="ppm")
    parent, rows = _mk_parent_and_vial_rows(db_session, svc)
    db_session.commit()
    with patch(
        "lims_analyses.routes.senaite_writeback.writeback_promotion",
        side_effect=AssertionError("SENAITE write-back must not be called for a native promote"),
    ):
        resp = client.post("/api/lims-analyses/promote", json={
            "keyword": "HM-PB", "result_value": "0.12", "result_unit": "ppm",
            "sources": [{"analysis_id": rows[0].id, "contribution_kind": "chosen"}],
        })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["parent"]["review_state"] == "verified"
    assert body["parent"]["analysis_service_id"] == svc.id


def test_senaite_origin_promote_still_fail_closed(client, db_session):
    """origin='senaite' path unchanged: write-back failure -> 502 AND the
    parent row is rolled back (not committed)."""
    svc = _mk_service(db_session, keyword="STER-XYZ", origin="senaite")
    parent, rows = _mk_parent_and_vial_rows(db_session, svc)
    db_session.commit()
    with patch(
        "lims_analyses.routes.senaite_writeback.writeback_promotion",
        side_effect=SenaiteWritebackError("boom"),
    ):
        resp = client.post("/api/lims-analyses/promote", json={
            "keyword": "STER-XYZ", "result_value": "ND",
            "sources": [{"analysis_id": rows[0].id, "contribution_kind": "chosen"}],
        })
    assert resp.status_code == 502
    from models import LimsAnalysis
    parents = db_session.query(LimsAnalysis).filter(
        LimsAnalysis.lims_sample_pk == parent.id,
        LimsAnalysis.lims_sub_sample_pk.is_(None),
    ).all()
    assert parents == []  # rolled back


def test_native_source_validation_is_id_based(client, db_session):
    """A native source row whose keyword string was mangled (but whose
    service FK is right) still promotes: identity comes from the FK."""
    svc = _mk_service(db_session, keyword="HM-PB", origin="mk1", unit="ppm")
    parent, rows = _mk_parent_and_vial_rows(db_session, svc)
    rows[0].keyword = "HM-PB-LEGACY-LABEL"   # drifted display string
    db_session.commit()
    with patch(
        "lims_analyses.routes.senaite_writeback.writeback_promotion",
        side_effect=AssertionError("must not be called"),
    ):
        resp = client.post("/api/lims-analyses/promote", json={
            "keyword": "HM-PB", "result_value": "0.12",
            "sources": [{"analysis_id": rows[0].id, "contribution_kind": "chosen"}],
        })
    assert resp.status_code == 201, resp.text
    # Parent row's keyword is the SERVICE's keyword, not the drifted string.
    assert resp.json()["parent"]["keyword"] == "HM-PB"


def test_native_retest_supersession_is_id_keyed(client, db_session):
    """Retest promotion of a native service retracts the old parent row even
    when its keyword string drifted — the supersession lookup keys on
    analysis_service_id for origin='mk1'."""
    from models import LimsAnalysis
    svc = _mk_service(db_session, keyword="HM-PB", origin="mk1", unit="ppm")
    parent, rows = _mk_parent_and_vial_rows(db_session, svc, n_vials=2)
    old_parent_row = LimsAnalysis(
        lims_sample_pk=parent.id, analysis_service_id=svc.id,
        keyword="HM-PB-OLD-LABEL", title=svc.title,
        result_value="0.50", review_state="verified",
    )
    db_session.add(old_parent_row)
    retest_row = rows[1]
    retest_row.retest_of_id = rows[0].id
    rows[0].review_state = "retracted"
    db_session.commit()
    with patch(
        "lims_analyses.routes.senaite_writeback.writeback_promotion",
        side_effect=AssertionError("must not be called"),
    ):
        resp = client.post("/api/lims-analyses/promote", json={
            "keyword": "HM-PB", "result_value": "0.11",
            "sources": [{"analysis_id": retest_row.id, "contribution_kind": "chosen"}],
        })
    assert resp.status_code == 201, resp.text
    db_session.expire_all()
    assert db_session.get(LimsAnalysis, old_parent_row.id).review_state == "retracted"
