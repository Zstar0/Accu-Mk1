"""Route-level tests: remove / reassign a worksheet item by integer id.

Regression for the prod 404 where Mk1-native sample UIDs (`mk1://<hex>`) placed
in a URL *path segment* get mangled by the nginx proxy: the FE encodes `://` to
`%3A%2F%2F`, nginx's `rewrite` decodes `%2F` and merges the resulting `//`, so
the backend receives extra path segments and no route matches -> 404 (never
reaching the handler's "Item not found"). SENAITE-native UIDs are bare hex with
no `://`, so they were unaffected.

The fix keys remove/reassign on the integer `worksheet_items.id`, which has no
slashes to mangle and mirrors the already-working `PATCH .../items/{item_id}`.

Pure unit tests: in-memory SQLite + dependency overrides, no live stack.
"""
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from main import app
from auth import get_current_user
from database import Base, get_db
from models import Worksheet, WorksheetItem

NATIVE_UID = "mk1://21b60840294d4fe6953946f66f8fd68b"  # the shape that 404s in prod


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: MagicMock(id=1)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed_item(db, *, uid=NATIVE_UID, sgid=None, title="Brandon WS"):
    ws = Worksheet(title=title)
    db.add(ws)
    db.flush()
    item = WorksheetItem(
        worksheet_id=ws.id,
        sample_uid=uid,
        sample_id="P-0140-S01",
        service_group_id=sgid,
    )
    db.add(item)
    db.commit()
    return ws, item


def test_remove_native_item_by_id_returns_200_and_deletes(client, db):
    ws, item = _seed_item(db)
    item_id = item.id

    resp = client.delete(f"/worksheets/{ws.id}/items/{item_id}")

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "removed"
    assert db.query(WorksheetItem).filter_by(id=item_id).first() is None


def test_remove_by_id_unknown_item_returns_404(client, db):
    ws, _ = _seed_item(db)
    resp = client.delete(f"/worksheets/{ws.id}/items/999999")
    assert resp.status_code == 404


def test_remove_by_id_wrong_worksheet_returns_404(client, db):
    """An item id that exists but under a different worksheet must not delete —
    the worksheet_id scopes the lookup."""
    ws, item = _seed_item(db)
    resp = client.delete(f"/worksheets/{ws.id + 999}/items/{item.id}")
    assert resp.status_code == 404
    assert db.query(WorksheetItem).filter_by(id=item.id).first() is not None


# ── reassign by id ───────────────────────────────────────────────────────────

def test_reassign_native_item_by_id_moves_to_target(client, db):
    src, item = _seed_item(db, title="Brandon WS")
    target = Worksheet(title="Patrick WS")
    db.add(target)
    db.commit()

    resp = client.post(
        f"/worksheets/{src.id}/items/{item.id}/reassign",
        json={"target_worksheet_id": target.id},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "reassigned"
    assert resp.json()["target_worksheet_id"] == target.id
    moved = db.query(WorksheetItem).filter_by(id=item.id).first()
    assert moved is not None and moved.worksheet_id == target.id


def test_reassign_by_id_unknown_item_returns_404(client, db):
    src, _ = _seed_item(db)
    target = Worksheet(title="Patrick WS")
    db.add(target)
    db.commit()
    resp = client.post(
        f"/worksheets/{src.id}/items/999999/reassign",
        json={"target_worksheet_id": target.id},
    )
    assert resp.status_code == 404


def test_reassign_by_id_target_not_open_returns_404(client, db):
    src, item = _seed_item(db)
    target = Worksheet(title="Closed WS", status="completed")
    db.add(target)
    db.commit()
    resp = client.post(
        f"/worksheets/{src.id}/items/{item.id}/reassign",
        json={"target_worksheet_id": target.id},
    )
    assert resp.status_code == 404
    # item must stay put
    assert db.query(WorksheetItem).filter_by(id=item.id).first().worksheet_id == src.id


# ── inbox priority by body (native uid can't ride in the path) ────────────────

def _seed_native_vial(db, uid=NATIVE_UID):
    """A native vial for `uid` + the seeded priorities rows (create_all seeds
    none). Task 8: the route maps the uid to this row and assigns on it."""
    from models import LimsSample, LimsSubSample, Priority, SlaTier
    from priority import service as priority_service

    db.add_all([
        Priority(key="default", name="Default", rank=0, icon="minus",
                 color="zinc", pulse=False, is_default=True, is_active=True),
        Priority(key="high", name="High", rank=10, icon="chevron-up",
                 color="amber", pulse=False, is_default=False, is_active=True),
    ])
    db.add(SlaTier(name="Standard", target_minutes=2880, is_default=True))
    parent = LimsSample(sample_id="P-7001", external_lims_uid="uid-p-7001")
    db.add(parent)
    db.flush()
    vial = LimsSubSample(parent_sample_pk=parent.id, sample_id="P-7001-S01",
                         external_lims_uid=uid, vial_sequence=1)
    db.add(vial)
    db.commit()
    priority_service.invalidate_priority_cache()
    return vial


def test_inbox_priority_by_body_native_uid_assigns_on_the_vial(client, db):
    """Task 8: the route no longer writes sample_priorities — it maps the
    native uid to its VIAL row and goes through priority.service.assign."""
    from models import PriorityAudit, SamplePriority

    vial = _seed_native_vial(db)
    resp = client.put(
        "/worksheets/inbox/priority",
        json={"sample_uid": NATIVE_UID, "priority": "high"},
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["priority"] == "high"
    assert resp.json()["sample_uid"] == NATIVE_UID
    assert resp.json()["level"] == "vial"
    db.expire_all()
    assert db.get(type(vial), vial.id).priority_key == "high"
    assert db.query(SamplePriority).filter_by(sample_uid=NATIVE_UID).first() is None
    audit = db.query(PriorityAudit).filter_by(level="vial").one()
    assert audit.new_key == "high" and audit.entity_id == str(vial.id)


def test_inbox_priority_by_body_normal_clears_to_inherit(client, db):
    vial = _seed_native_vial(db)
    client.put("/worksheets/inbox/priority",
               json={"sample_uid": NATIVE_UID, "priority": "high"})
    resp = client.put("/worksheets/inbox/priority",
                      json={"sample_uid": NATIVE_UID, "priority": "normal"})
    assert resp.status_code == 200, resp.text
    db.expire_all()
    assert db.get(type(vial), vial.id).priority_key is None


def test_inbox_priority_by_body_unknown_uid_404s(client, db):
    _seed_native_vial(db)
    resp = client.put(
        "/worksheets/inbox/priority",
        json={"sample_uid": "mk1://not-a-real-vial", "priority": "high"},
    )
    assert resp.status_code == 404


def test_inbox_priority_by_body_rejects_invalid(client, db):
    resp = client.put(
        "/worksheets/inbox/priority",
        json={"sample_uid": NATIVE_UID, "priority": "bogus"},
    )
    assert resp.status_code == 400
