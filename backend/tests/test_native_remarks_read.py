"""Native remarks serve path (read-flip spec §6): the shared helper's shape
mapping, plus endpoint wiring proven through the registry details endpoint
(which mocks the lookup — so a native remark appearing in its response can
ONLY have come from the re-apply, not SENAITE)."""
from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

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
TEST_LOOKUP_SAMPLE_ID = "TEST-NRR-LOOKUP"
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


# ═══════════════════════════════════════════════════════════════════════════
# Test 5 (review follow-up): the REAL lookup_senaite_sample — the directly
# exposed GET /wizard/senaite/lookup route (Order Status etc.) — ignores a
# SENAITE payload carrying a Remarks list and serves native rows instead.
# Tests 3-4 mock the lookup wholesale, so they prove only the registry
# endpoint's re-apply; this one drives the lookup's own internal swap.
# Live dev DB (same TEST-NRR-% seeding/cleanup as tests 1-2); SENAITE HTTP
# mocked at two layers: _fetch_senaite_sample for the AR payload, plus a
# broad httpx.AsyncClient patch (the _mock_receive_flow idiom from
# test_receive_remarks_native.py) whose every GET returns an empty-items
# payload — the lookup's downstream analyses/attachments/published-COA
# fetches all tolerate that (each is wrapped in its own try/except).
# ═══════════════════════════════════════════════════════════════════════════

def _mock_senaite_http_empty():
    """Broad httpx.AsyncClient patch: every request returns 200 with an
    empty-items JSON payload. Returns the patcher (caller must .stop())."""
    mock_instance = AsyncMock()
    resp = MagicMock()
    resp.status_code = 200
    resp.json = MagicMock(return_value={"count": 0, "items": []})
    resp.raise_for_status = MagicMock()
    mock_instance.get = AsyncMock(return_value=resp)
    mock_instance.post = AsyncMock(return_value=resp)
    p = patch("httpx.AsyncClient")
    cls = p.start()
    cls.return_value.__aenter__ = AsyncMock(return_value=mock_instance)
    cls.return_value.__aexit__ = AsyncMock(return_value=False)
    return p


def test_lookup_route_ignores_senaite_remarks_serves_native(db):
    parent = LimsSample(sample_id=TEST_LOOKUP_SAMPLE_ID, sample_type="x",
                        status="sample_received")
    db.add(parent)
    db.commit()
    db.refresh(parent)
    db.add(LimsSampleRemark(lims_sample_pk=parent.id,
                            content="<p>native lookup remark</p>",
                            author_label="native.author"))
    db.commit()

    # AR payload as SENAITE would return it — Remarks list present and
    # populated. The old parse would have surfaced it verbatim.
    ar_item = {
        "id": TEST_LOOKUP_SAMPLE_ID,
        "uid": "UID-NRR-LOOKUP",
        "Remarks": list(_STALE_SENAITE_REMARKS),
    }

    http_patcher = _mock_senaite_http_empty()
    try:
        with patch.object(main, "SENAITE_URL", "http://senaite.test"), \
             patch.object(main, "SENAITE_USER", "u"), \
             patch.object(main, "SENAITE_PASSWORD", "p"), \
             patch.object(main, "_fetch_senaite_sample",
                          AsyncMock(return_value={"count": 1, "items": [ar_item]})):
            main.app.dependency_overrides[get_current_user] = (
                lambda: {"email": "a@x", "role": "admin"})
            c = TestClient(main.app)
            r = c.get("/wizard/senaite/lookup",
                      params={"id": TEST_LOOKUP_SAMPLE_ID})
    finally:
        http_patcher.stop()
        main.app.dependency_overrides.clear()
        # The lookup unconditionally writes its result to the module-level
        # cache even when no_cache=true (which only skips the read) — evict
        # so no other test can be served this mocked result.
        main._senaite_lookup_cache.pop(TEST_LOOKUP_SAMPLE_ID, None)

    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["remarks"]) == 1
    assert body["remarks"][0]["content"] == "<p>native lookup remark</p>"
    assert body["remarks"][0]["user_id"] == "native.author"
    assert all("stale senaite remark" not in rm["content"]
               for rm in body["remarks"])
