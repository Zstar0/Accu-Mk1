import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def db():
    from database import Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service, kinds_service
    seams.set_event_sink(seams.InMemoryEventSink())
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    kinds_service.seed_builtins(s)
    try:
        yield s
    finally:
        s.close()


def _user(id):
    return SimpleNamespace(id=id, role="standard", email=f"u{id}@x.t")


# --- seed + CRUD ---------------------------------------------------------
def test_general_task_builtin_seeded(db):
    from flags import kinds_service
    k = kinds_service.get_kind_by_slug(db, "general_task")
    assert k is not None and k.is_builtin and k.label == "General Task"
    assert k.is_active


def test_create_rename_recolor_deactivate(db):
    from flags import kinds_service
    k = kinds_service.create_kind(db, label="Purchase Task", color="#111111")
    assert k.slug == "purchase_task" and k.is_active and not k.is_builtin
    kinds_service.update_kind(db, k.id, label="Purchasing", color="#222222")
    got = kinds_service.get_kind(db, k.id)
    assert got.label == "Purchasing" and got.color == "#222222"
    kinds_service.set_active(db, k.id, False)
    assert kinds_service.get_kind(db, k.id).is_active is False


def test_slug_is_immutable(db):
    from flags import kinds_service
    from flags.errors import BadRequestError
    k = kinds_service.create_kind(db, label="Purchase Task", color="#111111")
    with pytest.raises(BadRequestError):
        kinds_service.update_kind(db, k.id, slug="something_else")
    # a no-op restatement of the same slug is tolerated
    kinds_service.update_kind(db, k.id, slug="purchase_task", label="P")
    assert kinds_service.get_kind(db, k.id).label == "P"


def test_duplicate_explicit_slug_conflicts(db):
    from flags import kinds_service
    from flags.errors import ConflictError
    kinds_service.create_kind(db, label="Purchase Task", color="#111111",
                              slug="purchase_task")
    with pytest.raises(ConflictError):
        kinds_service.create_kind(db, label="Other", color="#111111",
                                  slug="purchase_task")


def test_delete_unused_custom_kind(db):
    from flags import kinds_service
    k = kinds_service.create_kind(db, label="Temp Kind", color="#111111")
    kinds_service.delete_kind(db, k.id)
    assert kinds_service.get_kind(db, k.id) is None


def test_delete_builtin_blocked(db):
    from flags import kinds_service
    from flags.errors import ConflictError
    gt = kinds_service.get_kind_by_slug(db, "general_task")
    with pytest.raises(ConflictError):
        kinds_service.delete_kind(db, gt.id)


def test_delete_in_use_kind_blocked(db):
    from flags import kinds_service, service
    k = kinds_service.create_kind(db, label="Purchase Task", color="#111111")
    service.create_flag(db, user=_user(1), entity_type=k.slug, entity_id=None,
                        type="task", title="order reagents")
    from flags.errors import ConflictError
    with pytest.raises(ConflictError):
        kinds_service.delete_kind(db, k.id)


# --- virtual-kind resolution + create_flag gating ------------------------
def test_resolve_virtual_kind_active_only(db):
    from flags import kinds_service, seams
    k = kinds_service.create_kind(db, label="Purchase Task", color="#111111")
    assert seams.resolve_virtual_kind(db, "purchase_task") is not None
    assert seams.resolve_virtual_kind(db, "not_a_kind") is None
    # a deactivated kind must not resolve — no new flags on it.
    kinds_service.set_active(db, k.id, False)
    assert seams.resolve_virtual_kind(db, "purchase_task") is None


def test_create_flag_on_virtual_kind(db):
    from flags import service, kinds_service
    k = kinds_service.create_kind(db, label="Purchase Task", color="#111111")
    f = service.create_flag(db, user=_user(1), entity_type=k.slug,
                            entity_id=None, type="task", title="order reagents")
    assert f.entity_type == "purchase_task" and f.entity_id is None
    assert f.kind == "issue"


def test_create_flag_on_kind_rejects_entity_id(db):
    from flags import service, kinds_service
    from flags.errors import BadRequestError
    k = kinds_service.create_kind(db, label="Purchase Task", color="#111111")
    with pytest.raises(BadRequestError):
        service.create_flag(db, user=_user(1), entity_type=k.slug,
                            entity_id="5", type="task", title="x")


def test_create_flag_on_general_task_kind(db):
    # The backfilled builtin behaves like any virtual kind.
    from flags import service
    f = service.create_flag(db, user=_user(1), entity_type="general_task",
                            entity_id=None, type="task", title="sweep bench")
    assert f.entity_type == "general_task" and f.entity_id is None


def test_unknown_entity_type_still_rejected(db):
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_flag(db, user=_user(1), entity_type="not_registered",
                            entity_id=None, type="task", title="x")


# --- graceful degradation: no state/search affordances -------------------
def test_entity_search_on_kind_is_empty(db):
    from flags import kinds_service, seams
    kinds_service.create_kind(db, label="Purchase Task", color="#111111")
    assert seams.resolve_entity_search(db, "purchase_task", "anything") == []


def test_arm_watch_on_virtual_kind_rejected(db):
    from flags import kinds_service, watches
    from flags.errors import BadRequestError
    kinds_service.create_kind(db, label="Purchase Task", color="#111111")
    with pytest.raises(BadRequestError):
        watches.arm_watch(db, user=_user(1), entity_type="purchase_task",
                          entity_id="1",
                          condition={"field": "status", "op": "eq", "value": "x"},
                          action={"kind": "comment"})


# --- backfill ------------------------------------------------------------
def test_backfill_null_anchors_idempotent(db):
    from flags.models import FlagFlag
    from flags import kinds_service
    f = FlagFlag(entity_type=None, entity_id=None, kind="issue", type="task",
                 status="open", title="legacy", created_by=1)
    db.add(f)
    db.commit()
    n1 = kinds_service.backfill_general_task(db)
    n2 = kinds_service.backfill_general_task(db)  # second run is a no-op
    db.refresh(f)
    assert f.entity_type == "general_task"
    assert n1 == 1 and n2 == 0


# --- routes --------------------------------------------------------------
def _make_client(role):
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import get_db, Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import types_service, kinds_service, seams
    seams.set_event_sink(seams.InMemoryEventSink())

    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared = Session()
    types_service.seed_builtins(shared)
    kinds_service.seed_builtins(shared)

    def _db():
        yield shared
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=1, role=role, email="t@x.t")
    tc = TestClient(app)
    tc._session = shared  # type: ignore[attr-defined]
    return tc


@pytest.fixture
def client_admin():
    from main import app
    from auth import get_current_user
    from database import get_db
    tc = _make_client("admin")
    yield tc
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    tc._session.close()


@pytest.fixture
def client_standard():
    from main import app
    from auth import get_current_user
    from database import get_db
    tc = _make_client("standard")
    yield tc
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    tc._session.close()


def test_list_kinds_open_to_any_user(client_standard):
    r = client_standard.get("/api/flags/item-kinds")
    assert r.status_code == 200, r.text
    slugs = [k["slug"] for k in r.json()]
    assert "general_task" in slugs


def test_create_kind_requires_admin(client_standard):
    r = client_standard.post("/api/flags/item-kinds",
                             json={"label": "Purchase Task", "color": "#111111"})
    assert r.status_code == 403


def test_admin_kind_crud_roundtrip(client_admin):
    r = client_admin.post("/api/flags/item-kinds",
                          json={"label": "Purchase Task", "color": "#111111"})
    assert r.status_code == 201, r.text
    kid = r.json()["id"]
    assert r.json()["slug"] == "purchase_task"

    r = client_admin.put(f"/api/flags/item-kinds/{kid}",
                         json={"label": "Purchasing"})
    assert r.status_code == 200 and r.json()["label"] == "Purchasing"

    r = client_admin.delete(f"/api/flags/item-kinds/{kid}")
    assert r.status_code == 204

    r = client_admin.get("/api/flags/item-kinds")
    assert "purchase_task" not in [k["slug"] for k in r.json()]
