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


def test_flag_row_allows_null_anchor_and_due(db):
    from flags.models import FlagFlag
    f = FlagFlag(entity_type=None, entity_id=None, kind="issue", type="task",
                 status="open", title="general", created_by=1, due_at=None)
    db.add(f)
    db.commit()
    db.refresh(f)
    assert f.id and f.entity_type is None and f.due_at is None


def test_create_general_task(db):
    # A global-scoped type (entity_types == []) may be raised with no anchor.
    from flags import service, types_service
    t = types_service.create_type(db, label="General thing", color="#111",
                                   kind="issue", entity_types=[])
    f = service.create_flag(db, user=_user(1), entity_type=None, entity_id=None,
                            type=t.slug, title="pick up equipment")
    assert f.entity_type is None and f.entity_id is None and f.kind == "issue"


def test_general_task_rejects_entity_scoped_type(db):
    # A type restricted to `sample` must not be raisable as a general task.
    from flags import service, types_service
    from flags.errors import BadRequestError
    t = types_service.create_type(db, label="Sample only", color="#111",
                                  kind="issue", entity_types=["sample"])
    with pytest.raises(BadRequestError):
        service.create_flag(db, user=_user(1), entity_type=None, entity_id=None,
                            type=t.slug, title="x")


def test_general_task_rejects_entity_id_without_type(db):
    from flags import service
    from flags.errors import BadRequestError
    with pytest.raises(BadRequestError):
        service.create_flag(db, user=_user(1), entity_type=None, entity_id="1",
                            type="blocker", title="x")


def test_anchored_flag_still_works(db):
    # Regression: the existing anchored path is byte-for-byte unchanged.
    from flags import service
    f = service.create_flag(db, user=_user(1), entity_type="sub_sample",
                            entity_id="1", type="blocker", title="anchored")
    assert f.entity_type == "sub_sample" and f.entity_id == "1"


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


def test_general_task_serializes_through_list_and_detail(client):
    # A null-anchor row must serialize on LIST endpoints (_with_entity runs on
    # every row), not just get_flag — else the whole list 500s.
    r = client.post("/api/flags", json={"entity_type": None, "entity_id": None,
                                        "type": "question", "title": "gen"})
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    lst = client.get("/api/flags?tab=raised")
    assert lst.status_code == 200, lst.text
    assert any(f["id"] == fid and f["entity_type"] is None for f in lst.json())
    d = client.get(f"/api/flags/{fid}")
    assert d.status_code == 200 and d.json()["entity_type"] is None
