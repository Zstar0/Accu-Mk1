import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from datetime import datetime
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
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_entity("sub_sample", label=lambda d, e: f"V{e}",
                          deep_link=lambda e: f"/v/{e}", can_flag=lambda u, e: True)
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    types_service.seed_builtins(s)
    try:
        yield s
    finally:
        s.close()


def _user(id):
    return SimpleNamespace(id=id, role="standard", email=f"u{id}@x.t")


def _general(db, actor=1):
    from flags import service
    return service.create_flag(db, user=_user(actor), entity_type=None,
                               entity_id=None, type="task", title="t")


def test_set_change_clear_due(db):
    from flags import service
    f = _general(db)
    service.set_due(db, user=_user(1), flag_id=f.id, due_at=datetime(2026, 7, 15))
    service.set_due(db, user=_user(1), flag_id=f.id, due_at=datetime(2026, 7, 20))
    service.set_due(db, user=_user(1), flag_id=f.id, due_at=None)
    evs = [e.event_type for e in service.get_flag(db, f.id).events]
    assert evs.count("due_set") == 1 and "due_changed" in evs and "due_cleared" in evs
    assert service.get_flag(db, f.id).due_at is None


def test_set_due_no_op_when_unchanged(db):
    from flags import service
    f = _general(db)
    d = datetime(2026, 7, 15)
    service.set_due(db, user=_user(1), flag_id=f.id, due_at=d)
    service.set_due(db, user=_user(1), flag_id=f.id, due_at=d)  # no-op
    evs = [e.event_type for e in service.get_flag(db, f.id).events]
    assert evs.count("due_set") == 1


def test_set_due_permission_tiered(db):
    # Only the creator/assignee/admin may edit the due date (status-change tier).
    from flags import service
    from flags.errors import PermissionDeniedError
    f = _general(db)  # creator = 1
    with pytest.raises(PermissionDeniedError):
        service.set_due(db, user=_user(99), flag_id=f.id, due_at=datetime(2026, 7, 15))


def test_create_with_due_emits_due_set(db):
    from flags import service
    f = service.create_flag(db, user=_user(1), entity_type=None, entity_id=None,
                            type="task", title="t", due_at=datetime(2026, 8, 1))
    assert f.due_at == datetime(2026, 8, 1)
    assert any(e.event_type == "due_set" for e in f.events)


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import get_db, Base
    import models  # noqa: F401
    import flags.models  # noqa: F401
    from flags import seams, types_service
    seams.set_event_sink(seams.InMemoryEventSink())
    seams.register_mk1_entities()

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    shared = Session()
    types_service.seed_builtins(shared)

    def _db():
        yield shared
    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=42, role="standard", email="t@x.t")
    tc = TestClient(app)
    yield tc
    app.dependency_overrides.pop(get_db, None) if prev_db is None else app.dependency_overrides.__setitem__(get_db, prev_db)
    app.dependency_overrides.pop(get_current_user, None) if prev_user is None else app.dependency_overrides.__setitem__(get_current_user, prev_user)
    shared.close()


def test_due_route_sets_and_clears(client):
    r = client.post("/api/flags", json={"entity_type": None, "entity_id": None,
                                        "type": "task", "title": "t"})
    fid = r.json()["id"]
    up = client.put(f"/api/flags/{fid}/due", json={"due_at": "2026-07-15T17:00:00"})
    assert up.status_code == 200, up.text
    assert up.json()["due_at"] is not None
    cleared = client.put(f"/api/flags/{fid}/due", json={"due_at": None})
    assert cleared.status_code == 200 and cleared.json()["due_at"] is None
