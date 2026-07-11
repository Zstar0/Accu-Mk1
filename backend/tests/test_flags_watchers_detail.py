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


def _flag(db, assignee_id=None):
    from flags import service
    return service.create_flag(db, user=_user(1), entity_type="sub_sample",
                               entity_id="1", type="blocker", title="t",
                               assignee_id=assignee_id)


def test_detail_includes_watchers(db):
    from flags import service
    f = _flag(db)
    service.add_watcher(db, user=_user(1), flag_id=f.id, user_id=42)
    rows = service.list_watchers(db, f.id)
    assert [w.user_id for w in rows if w.user_id == 42] == [42]


def test_list_watchers_oldest_first_with_added_by(db):
    from flags import service
    f = _flag(db)
    service.add_watcher(db, user=_user(3), flag_id=f.id, user_id=7)
    service.add_watcher(db, user=_user(3), flag_id=f.id, user_id=9)
    rows = service.list_watchers(db, f.id)
    assert [w.user_id for w in rows] == [7, 9]        # insertion order
    assert rows[0].added_by == 3 and rows[0].added_at is not None


def test_list_watchers_missing_flag_404s(db):
    from flags import service
    from flags.errors import NotFoundError
    with pytest.raises(NotFoundError):
        service.list_watchers(db, 99999)


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


def test_detail_endpoint_serializes_watchers(client):
    r = client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": "1",
                                        "type": "blocker", "title": "w"})
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    assert client.post(f"/api/flags/{fid}/watchers", json={"user_id": 7}).status_code == 201
    body = client.get(f"/api/flags/{fid}").json()
    assert 7 in [w["user_id"] for w in body["watchers"]]
    w = next(w for w in body["watchers"] if w["user_id"] == 7)
    assert set(w.keys()) == {"user_id", "added_at", "added_by"}
