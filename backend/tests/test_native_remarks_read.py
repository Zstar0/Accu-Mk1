"""Native remarks serve path (read-flip spec §6): the shared helper's shape
mapping, plus endpoint wiring proven through the registry details endpoint
(which mocks the lookup — so a native remark appearing in its response can
ONLY have come from the re-apply, not SENAITE)."""
from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import main
from auth import get_current_user
from database import Base, SessionLocal, get_db
from models import LimsSample, LimsSampleRemark, User

TEST_SAMPLE_ID_1 = "TEST-NRR-P1"
TEST_SAMPLE_ID_2 = "TEST-NRR-P2"
TEST_USER_EMAIL_1 = "test-rmk@example.com"
TEST_USER_EMAIL_2 = "test-rmk-2@example.com"


# ═══════════════════════════════════════════════════════════════════════════
# Tests 1-2: helper called directly against the live dev DB.
# House pattern (test_lims_sample_remarks_schema.py / test_receive_remarks_
# native.py): TEST-prefixed sample_ids, FK-safe cleanup.
# ═══════════════════════════════════════════════════════════════════════════

@pytest.fixture
def db():
    s = SessionLocal()
    yield s
    s.rollback()
    s.execute(delete(LimsSampleRemark).where(
        LimsSampleRemark.lims_sample_pk.in_(
            select(LimsSample.id).where(LimsSample.sample_id.like("TEST-NRR-%"))
        )
    ))
    s.execute(delete(LimsSample).where(LimsSample.sample_id.like("TEST-NRR-%")))
    s.execute(delete(User).where(User.email.like("test-rmk%@example.com")))
    s.commit()
    s.close()


def test_helper_maps_rows_to_senaite_remark_shape(db):
    parent = LimsSample(sample_id=TEST_SAMPLE_ID_1, sample_type="x",
                        status="sample_received")
    db.add(parent)
    db.commit()
    db.refresh(parent)

    user = User(email=TEST_USER_EMAIL_1, hashed_password="x",
                first_name="Rem", last_name="Marker")
    db.add(user)
    db.commit()
    db.refresh(user)

    # Earlier created_at than the second row, so ORDER BY created_at puts
    # this one first regardless of insertion/id order.
    db.add(LimsSampleRemark(
        lims_sample_pk=parent.id,
        content="<p>first remark</p>",
        author_user_id=user.id,
        author_label=None,
        created_at=datetime(2026, 1, 1, 0, 0, 0),
    ))
    db.add(LimsSampleRemark(
        lims_sample_pk=parent.id,
        content="<p>legacy remark</p>",
        author_user_id=None,
        author_label="legacy.senaite.login",
        created_at=datetime(2026, 1, 2, 3, 4, 5),
    ))
    db.commit()

    out = main._native_sample_remarks(db, TEST_SAMPLE_ID_1)
    assert len(out) == 2
    assert out[0].user_id == "Rem Marker"
    assert out[0].content == "<p>first remark</p>"
    assert out[1].user_id == "legacy.senaite.login"
    assert out[1].created == "2026-01-02T03:04:05"
    assert out[1].content == "<p>legacy remark</p>"


def test_helper_user_fallback_to_email(db):
    parent = LimsSample(sample_id=TEST_SAMPLE_ID_2, sample_type="x",
                        status="sample_received")
    db.add(parent)
    db.commit()
    db.refresh(parent)

    user = User(email=TEST_USER_EMAIL_2, hashed_password="x",
                first_name=None, last_name=None)
    db.add(user)
    db.commit()
    db.refresh(user)

    db.add(LimsSampleRemark(
        lims_sample_pk=parent.id,
        content="<p>no-name user</p>",
        author_user_id=user.id,
        author_label=None,
    ))
    db.commit()

    out = main._native_sample_remarks(db, TEST_SAMPLE_ID_2)
    assert len(out) == 1
    assert out[0].user_id == TEST_USER_EMAIL_2


# ═══════════════════════════════════════════════════════════════════════════
# Tests 3-4: endpoint wiring, proven through /registry/sample/{id}/details
# with the lookup mocked. Fixture/helper idioms copied (not imported) from
# test_registry_read_endpoint.py.
# ═══════════════════════════════════════════════════════════════════════════

@pytest.fixture
def client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def _get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    main.app.dependency_overrides[get_db] = _get_db
    main.app.dependency_overrides[get_current_user] = lambda: {"email": "a@x", "role": "admin"}
    c = TestClient(main.app)
    c._Session = Session
    yield c
    main.app.dependency_overrides.clear()


def _seed_registry_row(client, **kw):
    db = client._Session()
    row = LimsSample(sample_id="P-1", external_lims_uid="AR_UID",
                      last_synced_at=datetime(2026, 1, 1), **kw)
    db.add(row)
    db.commit()
    db.refresh(row)
    pk = row.id
    db.close()
    return pk


def _seed_native_remark(client, lims_sample_pk, content="<p>native remark</p>",
                        author_label="native.author"):
    db = client._Session()
    db.add(LimsSampleRemark(lims_sample_pk=lims_sample_pk, content=content,
                            author_label=author_label))
    db.commit()
    db.close()


def _senaite_result(**overrides):
    """A SenaiteLookupResult with known values, standing in for a live SENAITE
    lookup. analytes/analyses use their real typed shapes (SenaiteAnalyte has
    required raw_name/slot_number; SenaiteAnalysis has required title) so the
    mock itself validates the same way lookup_senaite_sample's real return
    would."""
    defaults = dict(
        sample_id="P-1",
        sample_uid="SEN-UID",
        client="SenaiteCo",
        contact="Senaite Contact",
        sample_type="Peptide",
        date_received="2026-01-01T00:00:00",
        date_sampled="2026-01-02T00:00:00",
        client_order_number="WP-100",
        client_sample_id="CS-SEN",
        client_lot="L-SEN",
        review_state="sample_received",
        declared_weight_mg=5.0,
        analytes=[main.SenaiteAnalyte(raw_name="BPC-157", slot_number=1)],
        analyses=[main.SenaiteAnalysis(title="Purity"), main.SenaiteAnalysis(title="Identity")],
    )
    defaults.update(overrides)
    return main.SenaiteLookupResult(**defaults)


def _mock_lookup(result):
    return patch.object(main, "lookup_senaite_sample", AsyncMock(return_value=result))


_STALE_SENAITE_REMARKS = [{
    "content": "<p>stale senaite remark</p>",
    "user_id": "zeus",
    "created": "2020-01-01T00:00:00",
}]


def test_registry_endpoint_serves_native_remarks(client):
    sample_pk = _seed_registry_row(client, client_title="RegistryCo")
    _seed_native_remark(client, sample_pk, content="<p>native remark</p>")

    with _mock_lookup(_senaite_result(remarks=_STALE_SENAITE_REMARKS)):
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert len(body["remarks"]) == 1
    assert body["remarks"][0]["content"] == "<p>native remark</p>"
    assert all("stale senaite remark" not in rm["content"] for rm in body["remarks"])
    assert body["field_sources"]["remarks"] == "mk1"


def test_registry_endpoint_empty_native_remarks_is_empty_list(client):
    _seed_registry_row(client, client_title="RegistryCo")
    # No native remarks seeded — response must be [] even though the mocked
    # lookup carried a SENAITE remark (stale-by-design, spec §6).

    with _mock_lookup(_senaite_result(remarks=_STALE_SENAITE_REMARKS)):
        r = client.get("/registry/sample/P-1/details")
    assert r.status_code == 200
    body = r.json()
    assert body["remarks"] == []
