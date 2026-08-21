"""Parent-tier verify tees the sign-off to SENAITE for senaite-origin services
(read-flip seam fix, 2026-08-20). #96 built the native second sign-off for the
Accu-Mk1 card (mk1-origin services, no SENAITE line); the read-flip main table
surfaces SENAITE-origin canonical rows in the same state — verifying those
natively must flip the SENAITE AR line in the same act, fail-closed, or the
two systems mint a silent divergence the COA gate later trips over.

The tee itself (writeback_parent_verify) is unit-tested in
test_senaite_writeback.py; these tests pin the apply_transition integration:
origin gate, fail-closed abort, and the route-layer 502 mapping.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from database import Base
from models import AnalysisService, LimsAnalysis, LimsSample
from lims_analyses import service as la_service
from lims_analyses.senaite_writeback import SenaiteWritebackError


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _parent_row(db, *, origin, keyword="HPLC-PUR", sid="ZZPV-0001"):
    svc = AnalysisService(title=keyword, keyword=keyword, origin=origin, unit="%")
    db.add(svc)
    db.flush()
    parent = LimsSample(sample_id=sid, external_lims_uid=f"{sid}-uid")
    db.add(parent)
    db.flush()
    row = LimsAnalysis(
        lims_sample_pk=parent.id, lims_sub_sample_pk=None,
        analysis_service_id=svc.id, keyword=keyword, title=keyword,
        result_value="98", review_state="parent_to_verify",
    )
    db.add(row)
    db.commit()
    return parent, row


def test_senaite_origin_parent_verify_tees_to_senaite(db, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "lims_analyses.senaite_writeback.writeback_parent_verify",
        lambda sample_id, keyword: calls.append((sample_id, keyword)) or "verified",
    )
    _parent, row = _parent_row(db, origin="senaite")

    out = la_service.apply_transition(db, analysis_id=row.id, kind="verify", user_id=1)

    assert out.review_state == "verified"
    assert out.verified_at is not None
    assert calls == [("ZZPV-0001", "HPLC-PUR")]


def test_mk1_origin_parent_verify_skips_tee(db, monkeypatch):
    def _boom(sample_id, keyword):
        raise AssertionError("tee must not fire for mk1-origin services")

    monkeypatch.setattr(
        "lims_analyses.senaite_writeback.writeback_parent_verify", _boom
    )
    _parent, row = _parent_row(db, origin="mk1", keyword="ZZFENT")

    out = la_service.apply_transition(db, analysis_id=row.id, kind="verify", user_id=1)

    assert out.review_state == "verified"


def test_senaite_writeback_failure_aborts_verify(db, monkeypatch):
    def _fail(sample_id, keyword):
        raise SenaiteWritebackError("boom")

    monkeypatch.setattr(
        "lims_analyses.senaite_writeback.writeback_parent_verify", _fail
    )
    _parent, row = _parent_row(db, origin="senaite")

    with pytest.raises(SenaiteWritebackError):
        la_service.apply_transition(db, analysis_id=row.id, kind="verify", user_id=1)

    db.rollback()
    db.refresh(row)
    assert row.review_state == "parent_to_verify"
    assert row.verified_at is None


def test_route_maps_writeback_error_to_502():
    from lims_analyses.routes import _handle_service_error

    exc = _handle_service_error(SenaiteWritebackError("nope"))
    assert exc.status_code == 502
    assert "nope" in str(exc.detail)
