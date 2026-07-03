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
    seams.register_entity("sub_sample",
                          label=lambda d, e: f"Vial {e}",
                          deep_link=lambda e: f"/v/{e}",
                          can_flag=lambda u, e: True)
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


def _raise(db, actor, title, assignee=None):
    from flags import service
    return service.create_flag(db, user=_user(actor), entity_type="sub_sample",
                               entity_id="1", type="blocker", title=title,
                               assignee_id=assignee)


def test_activity_relevance_and_order(db):
    from flags import service
    # Flag A: created by me(1), someone else(2) comments on it.
    a = _raise(db, actor=1, title="mine")
    service.add_comment(db, user=_user(2), flag_id=a.id, body="hi")
    # Flag B: not mine, not watched — I must NOT see its events.
    _raise(db, actor=9, title="theirs")
    rows, nxt = service.list_activity(db, user_id=1, limit=25)
    titles = [r.flag.title for r in rows]
    assert "theirs" not in titles                    # relevance excludes B
    assert "mine" in titles                           # creator relevance
    # Newest first: the comment event precedes the raise event.
    types = [r.event_type for r in rows if r.flag.title == "mine"]
    assert types[0] == "commented" and types[-1] == "raised"


def test_activity_includes_my_own_actions(db):
    from flags import service
    # A flag I neither created nor am assigned to, but I acted on (commented).
    other = _raise(db, actor=9, title="foreign")
    service.add_comment(db, user=_user(1), flag_id=other.id, body="me acting")
    rows, _ = service.list_activity(db, user_id=1, limit=25)
    assert any(r.event_type == "commented" and r.flag.title == "foreign" for r in rows)


def test_activity_keyset_pagination_no_dupes(db):
    from flags import service
    for i in range(5):
        _raise(db, actor=1, title=f"f{i}")
    page1, c1 = service.list_activity(db, user_id=1, limit=2)
    assert len(page1) == 2 and c1 is not None
    page2, c2 = service.list_activity(db, user_id=1, cursor=c1, limit=2)
    ids1 = {r.id for r in page1}
    ids2 = {r.id for r in page2}
    assert ids1.isdisjoint(ids2)                      # no dupes across the boundary
    page3, c3 = service.list_activity(db, user_id=1, cursor=c2, limit=2)
    assert c3 is None                                 # last page → no next cursor


def test_activity_bad_cursor_raises(db):
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.list_activity(db, user_id=1, cursor="!!notbase64!!", limit=5)


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from main import app
    from auth import get_current_user
    from database import get_db, Base
    import models  # noqa: F401  (register FlagType on Base)
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
    tc.db = shared
    yield tc
    app.dependency_overrides.pop(get_db, None) if prev_db is None else app.dependency_overrides.__setitem__(get_db, prev_db)
    app.dependency_overrides.pop(get_current_user, None) if prev_user is None else app.dependency_overrides.__setitem__(get_current_user, prev_user)
    shared.close()


def test_activity_endpoint_returns_page(client):
    r = client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": "1",
                                        "type": "blocker", "title": "epage"})
    assert r.status_code == 201, r.text
    a = client.get("/api/flags/activity?limit=10")
    assert a.status_code == 200, a.text
    body = a.json()
    assert body["items"][0]["flag"]["title"] == "epage"
    assert body["items"][0]["event_type"] == "raised"
    assert "next_cursor" in body


def test_activity_endpoint_bad_cursor_400(client):
    client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": "1",
                                    "type": "blocker", "title": "x"})
    assert client.get("/api/flags/activity?cursor=@@bad@@").status_code == 400
