"""Tests for native-vial Manage Analyses add/remove.

Task 1: service-layer functions add_analysis_to_native_vial and
        delete_pristine_analysis in lims_analyses.service.
Task 2: explorer proxy endpoint native branch in main.py.

All tests use in-memory SQLite via the db_session fixture (conftest.py).
Route tests use the route_client pattern from test_analysis_service_result_type.py.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from unittest.mock import MagicMock, patch, AsyncMock

from database import Base
from models import AnalysisService, LimsAnalysis, LimsAnalysisTransition, LimsSubSample, LimsSample


# ─── Shared helpers ──────────────────────────────────────────────────────────


def _make_service(db, *, keyword="TST-KWD", senaite_uid="SENAITE-UID-001", title="Test Service"):
    svc = AnalysisService(
        title=title,
        keyword=keyword,
        senaite_uid=senaite_uid,
        unit="%",
    )
    db.add(svc)
    db.flush()
    return svc


def _make_sample(db, *, sample_id="P-TEST"):
    parent = LimsSample(
        sample_id=sample_id,
        external_lims_uid=None,
        external_lims_system="mk1",
        assignment_role="hplc",
    )
    db.add(parent)
    db.flush()
    return parent


def _make_sub(db, parent, *, uid="mk1://test-uuid-001", sample_id="P-TEST-S01", seq=1):
    sub = LimsSubSample(
        parent_sample_pk=parent.id,
        external_lims_uid=uid,
        sample_id=sample_id,
        vial_sequence=seq,
    )
    db.add(sub)
    db.flush()
    return sub


# ═══════════════════════════════════════════════════════════════════════════════
# Task 1 — service-layer tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestAddAnalysisToNativeVial:
    """Tests for add_analysis_to_native_vial()."""

    def test_add_resolves_by_senaite_uid(self, db_session):
        from lims_analyses.service import add_analysis_to_native_vial

        svc = _make_service(db_session, keyword="TST-PUR", senaite_uid="SN-UID-001")
        parent = _make_sample(db_session)
        sub = _make_sub(db_session, parent)
        db_session.commit()

        result = add_analysis_to_native_vial(
            db_session,
            sub_sample_pk=sub.id,
            senaite_service_uid="SN-UID-001",
            keyword=None,
            user_id=None,
        )

        assert result.keyword == "TST-PUR"
        assert result.review_state == "unassigned"
        assert result.lims_sub_sample_pk == sub.id
        assert result.analysis_service_id == svc.id

    def test_add_resolves_by_keyword_fallback(self, db_session):
        from lims_analyses.service import add_analysis_to_native_vial

        svc = _make_service(db_session, keyword="TST-KW2", senaite_uid=None)
        parent = _make_sample(db_session, sample_id="P-TEST2")
        sub = _make_sub(db_session, parent, uid="mk1://test-uuid-002", sample_id="P-TEST2-S01")
        db_session.commit()

        result = add_analysis_to_native_vial(
            db_session,
            sub_sample_pk=sub.id,
            senaite_service_uid=None,
            keyword="TST-KW2",
            user_id=None,
        )

        assert result.keyword == "TST-KW2"
        assert result.analysis_service_id == svc.id

    def test_add_by_senaite_uid_not_found_raises(self, db_session):
        from lims_analyses.service import NotFoundError, add_analysis_to_native_vial

        parent = _make_sample(db_session)
        sub = _make_sub(db_session, parent)
        db_session.commit()

        with pytest.raises(NotFoundError):
            add_analysis_to_native_vial(
                db_session,
                sub_sample_pk=sub.id,
                senaite_service_uid="DOES-NOT-EXIST",
                keyword=None,
                user_id=None,
            )

    def test_add_by_keyword_not_found_raises(self, db_session):
        from lims_analyses.service import NotFoundError, add_analysis_to_native_vial

        parent = _make_sample(db_session)
        sub = _make_sub(db_session, parent)
        db_session.commit()

        with pytest.raises(NotFoundError):
            add_analysis_to_native_vial(
                db_session,
                sub_sample_pk=sub.id,
                senaite_service_uid=None,
                keyword="NO-SUCH-KWD",
                user_id=None,
            )

    def test_duplicate_add_raises_bad_request(self, db_session):
        from lims_analyses.service import BadRequestError, add_analysis_to_native_vial

        svc = _make_service(db_session, keyword="TST-DUP", senaite_uid="SN-UID-DUP")
        parent = _make_sample(db_session, sample_id="P-TEST3")
        sub = _make_sub(db_session, parent, uid="mk1://test-uuid-003", sample_id="P-TEST3-S01")
        db_session.commit()

        # First add succeeds
        add_analysis_to_native_vial(
            db_session,
            sub_sample_pk=sub.id,
            senaite_service_uid="SN-UID-DUP",
            keyword=None,
            user_id=None,
        )

        # Second add (same keyword, active row, retest_of_id IS NULL) → 409
        with pytest.raises(BadRequestError):
            add_analysis_to_native_vial(
                db_session,
                sub_sample_pk=sub.id,
                senaite_service_uid="SN-UID-DUP",
                keyword=None,
                user_id=None,
            )

    def test_no_identifier_raises_bad_request(self, db_session):
        from lims_analyses.service import BadRequestError, add_analysis_to_native_vial

        parent = _make_sample(db_session)
        sub = _make_sub(db_session, parent)
        db_session.commit()

        with pytest.raises(BadRequestError):
            add_analysis_to_native_vial(
                db_session,
                sub_sample_pk=sub.id,
                senaite_service_uid=None,
                keyword=None,
                user_id=None,
            )


class TestDeletePristineAnalysis:
    """Tests for delete_pristine_analysis()."""

    def test_delete_pristine_removes_row_and_audit(self, db_session):
        from lims_analyses.service import add_analysis_to_native_vial, delete_pristine_analysis

        svc = _make_service(db_session, keyword="TST-DEL", senaite_uid="SN-UID-DEL")
        parent = _make_sample(db_session, sample_id="P-TEST4")
        sub = _make_sub(db_session, parent, uid="mk1://test-uuid-004", sample_id="P-TEST4-S01")
        db_session.commit()

        row = add_analysis_to_native_vial(
            db_session,
            sub_sample_pk=sub.id,
            senaite_service_uid="SN-UID-DEL",
            keyword=None,
            user_id=None,
        )
        row_id = row.id

        delete_pristine_analysis(
            db_session,
            sub_sample_pk=sub.id,
            keyword="TST-DEL",
            user_id=None,
        )

        # Row gone
        assert db_session.get(LimsAnalysis, row_id) is None
        # Audit rows gone
        remaining = db_session.execute(
            select(LimsAnalysisTransition).where(
                LimsAnalysisTransition.analysis_id == row_id
            )
        ).scalars().all()
        assert remaining == []

    def test_delete_not_found_raises(self, db_session):
        from lims_analyses.service import NotFoundError, delete_pristine_analysis

        parent = _make_sample(db_session, sample_id="P-TEST5")
        sub = _make_sub(db_session, parent, uid="mk1://test-uuid-005", sample_id="P-TEST5-S01")
        db_session.commit()

        with pytest.raises(NotFoundError):
            delete_pristine_analysis(
                db_session,
                sub_sample_pk=sub.id,
                keyword="NO-SUCH-KWD",
                user_id=None,
            )

    def test_delete_with_result_raises(self, db_session):
        from lims_analyses.service import (
            BadRequestError,
            add_analysis_to_native_vial,
            apply_transition,
            delete_pristine_analysis,
        )

        svc = _make_service(db_session, keyword="TST-RES", senaite_uid="SN-UID-RES")
        parent = _make_sample(db_session, sample_id="P-TEST6")
        sub = _make_sub(db_session, parent, uid="mk1://test-uuid-006", sample_id="P-TEST6-S01")
        db_session.commit()

        row = add_analysis_to_native_vial(
            db_session,
            sub_sample_pk=sub.id,
            senaite_service_uid="SN-UID-RES",
            keyword=None,
            user_id=None,
        )
        # Advance to assigned then submit result
        apply_transition(db_session, analysis_id=row.id, kind="assign")
        apply_transition(db_session, analysis_id=row.id, kind="submit", result_value="99.1")

        with pytest.raises(BadRequestError, match="retract"):
            delete_pristine_analysis(
                db_session,
                sub_sample_pk=sub.id,
                keyword="TST-RES",
                user_id=None,
            )

    def test_delete_with_non_unassigned_state_raises(self, db_session):
        from lims_analyses.service import (
            BadRequestError,
            add_analysis_to_native_vial,
            apply_transition,
            delete_pristine_analysis,
        )

        svc = _make_service(db_session, keyword="TST-STA", senaite_uid="SN-UID-STA")
        parent = _make_sample(db_session, sample_id="P-TEST7")
        sub = _make_sub(db_session, parent, uid="mk1://test-uuid-007", sample_id="P-TEST7-S01")
        db_session.commit()

        row = add_analysis_to_native_vial(
            db_session,
            sub_sample_pk=sub.id,
            senaite_service_uid="SN-UID-STA",
            keyword=None,
            user_id=None,
        )
        # Move to "assigned" state (no result, but non-unassigned)
        apply_transition(db_session, analysis_id=row.id, kind="assign")

        with pytest.raises(BadRequestError, match="retract"):
            delete_pristine_analysis(
                db_session,
                sub_sample_pk=sub.id,
                keyword="TST-STA",
                user_id=None,
            )


# ═══════════════════════════════════════════════════════════════════════════════
# Task 2 — route endpoint tests
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def route_client():
    """TestClient with a single-connection in-memory SQLite engine.

    Uses StaticPool so every session (test thread + ASGI handler thread) shares
    the exact same underlying connection, which keeps in-memory tables visible
    across the boundary.  check_same_thread=False allows the ASGI worker thread
    to use the connection created in the test thread.

    Restores previous dependency overrides on teardown.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import get_db, Base

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared_session = Session()

    def _override_get_db():
        yield shared_session

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=42)

    tc = TestClient(app)
    tc._test_session = shared_session
    yield tc

    if prev_db is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = prev_db
    if prev_user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = prev_user
    shared_session.close()


class TestNativeAddEndpoint:
    """POST /explorer/samples/{sample_id}/analyses — native branch."""

    def test_native_add_200_row_exists(self, route_client):
        db = route_client._test_session
        svc = _make_service(db, keyword="TST-RT1", senaite_uid="SN-RT-001")
        parent = _make_sample(db, sample_id="P-RT01")
        sub = _make_sub(db, parent, uid="mk1://rt-uuid-001", sample_id="P-RT01-S01")
        db.commit()

        resp = route_client.post(
            f"/explorer/samples/P-RT01-S01/analyses",
            json={"service_uid": "SN-RT-001"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True

        # Row exists in DB
        row = db.execute(
            select(LimsAnalysis).where(
                LimsAnalysis.lims_sub_sample_pk == sub.id,
                LimsAnalysis.keyword == "TST-RT1",
            )
        ).scalar_one_or_none()
        assert row is not None
        assert row.review_state == "unassigned"

    def test_native_add_duplicate_409(self, route_client):
        db = route_client._test_session
        svc = _make_service(db, keyword="TST-RT2", senaite_uid="SN-RT-002")
        parent = _make_sample(db, sample_id="P-RT02")
        sub = _make_sub(db, parent, uid="mk1://rt-uuid-002", sample_id="P-RT02-S01")
        db.commit()

        # First add
        resp = route_client.post(
            "/explorer/samples/P-RT02-S01/analyses",
            json={"service_uid": "SN-RT-002"},
        )
        assert resp.status_code == 200

        # Duplicate → 409
        resp2 = route_client.post(
            "/explorer/samples/P-RT02-S01/analyses",
            json={"service_uid": "SN-RT-002"},
        )
        assert resp2.status_code == 409


class TestNativeRemoveEndpoint:
    """DELETE /explorer/samples/{sample_id}/analyses/{keyword} — native branch."""

    def test_native_remove_pristine_200_row_gone(self, route_client):
        db = route_client._test_session
        svc = _make_service(db, keyword="TST-RT3", senaite_uid="SN-RT-003")
        parent = _make_sample(db, sample_id="P-RT03")
        sub = _make_sub(db, parent, uid="mk1://rt-uuid-003", sample_id="P-RT03-S01")
        db.commit()

        # Add first
        resp = route_client.post(
            "/explorer/samples/P-RT03-S01/analyses",
            json={"service_uid": "SN-RT-003"},
        )
        assert resp.status_code == 200

        # Remove
        resp2 = route_client.delete("/explorer/samples/P-RT03-S01/analyses/TST-RT3")
        assert resp2.status_code == 200
        body = resp2.json()
        assert body["success"] is True

        # Row gone
        row = db.execute(
            select(LimsAnalysis).where(
                LimsAnalysis.lims_sub_sample_pk == sub.id,
                LimsAnalysis.keyword == "TST-RT3",
            )
        ).scalar_one_or_none()
        assert row is None

    def test_native_remove_with_result_409(self, route_client):
        from lims_analyses.service import apply_transition, create_analysis

        db = route_client._test_session
        svc = _make_service(db, keyword="TST-RT4", senaite_uid="SN-RT-004")
        parent = _make_sample(db, sample_id="P-RT04")
        sub = _make_sub(db, parent, uid="mk1://rt-uuid-004", sample_id="P-RT04-S01")
        db.commit()

        # Create analysis with a result via service layer
        row = create_analysis(
            db,
            host_kind="sub_sample",
            host_pk=sub.id,
            analysis_service_id=svc.id,
            keyword="TST-RT4",
            title="Test Service",
            result_unit="%",
        )
        apply_transition(db, analysis_id=row.id, kind="assign")
        apply_transition(db, analysis_id=row.id, kind="submit", result_value="95.0")

        resp = route_client.delete("/explorer/samples/P-RT04-S01/analyses/TST-RT4")
        assert resp.status_code == 409

    def test_native_remove_not_found_404(self, route_client):
        db = route_client._test_session
        parent = _make_sample(db, sample_id="P-RT05")
        sub = _make_sub(db, parent, uid="mk1://rt-uuid-005", sample_id="P-RT05-S01")
        db.commit()

        resp = route_client.delete("/explorer/samples/P-RT05-S01/analyses/NO-SUCH-KW")
        assert resp.status_code == 404


class TestNonNativeFallthrough:
    """Non-native sample_id falls through to IS proxy (legacy path)."""

    def test_non_native_add_proxies_to_is(self, route_client):
        """sample_id with no mk1:// sub-sample row → legacy IS proxy path reached."""
        db = route_client._test_session
        # Create a SENAITE-backed sub-sample (legacy uid, no mk1:// prefix)
        parent = _make_sample(db, sample_id="P-LEG01")
        sub = _make_sub(
            db, parent,
            uid="a8c27e69bfa84ff1bf16a3e370a44456",  # SENAITE uid, NOT mk1://
            sample_id="P-LEG01-S01",
        )
        db.commit()

        with patch("httpx.AsyncClient") as mock_cls:
            mock_instance = AsyncMock()
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
            mock_resp = MagicMock()
            mock_resp.raise_for_status = MagicMock()
            mock_resp.json = MagicMock(return_value={"success": True, "message": "proxied"})
            mock_instance.post = AsyncMock(return_value=mock_resp)

            resp = route_client.post(
                "/explorer/samples/P-LEG01-S01/analyses",
                json={"service_uid": "SN-ANYTHING"},
            )

        # Assert the IS proxy was called (not native path)
        assert mock_instance.post.called
        assert resp.status_code == 200
