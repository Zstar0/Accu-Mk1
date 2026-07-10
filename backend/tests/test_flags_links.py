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
    for et in ("sample", "sub_sample", "worksheet"):
        seams.register_entity(et, label=lambda d, e, _et=et: f"{_et} {e}",
                              deep_link=lambda e, _et=et: f"/{_et}/{e}",
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


def _anchored(db, actor=1):
    from flags import service
    return service.create_flag(db, user=_user(actor), entity_type="sample",
                               entity_id="PB-1", type="blocker", title="t")


# --- Task 5: entity reference links --------------------------------------
def test_entity_link_lifecycle(db):
    from flags import service
    from flags.errors import BadRequestError
    f = _anchored(db)
    link = service.add_entity_link(db, user=_user(1), flag_id=f.id,
                                   entity_type="worksheet", entity_id="17")
    assert link.id
    assert "entity_link_added" in [e.event_type
                                   for e in service.get_flag(db, f.id).events]
    # duplicate → BadRequest
    with pytest.raises(BadRequestError):
        service.add_entity_link(db, user=_user(1), flag_id=f.id,
                                entity_type="worksheet", entity_id="17")
    # unknown entity_type → BadRequest
    with pytest.raises(BadRequestError):
        service.add_entity_link(db, user=_user(1), flag_id=f.id,
                                entity_type="nope", entity_id="1")
    service.remove_entity_link(db, user=_user(1), flag_id=f.id, link_id=link.id)
    assert "entity_link_removed" in [e.event_type
                                     for e in service.get_flag(db, f.id).events]


def test_remove_entity_link_wrong_flag_404s(db):
    from flags import service
    from flags.errors import NotFoundError
    f = _anchored(db)
    g = _anchored(db)
    link = service.add_entity_link(db, user=_user(1), flag_id=f.id,
                                   entity_type="worksheet", entity_id="17")
    with pytest.raises(NotFoundError):
        service.remove_entity_link(db, user=_user(1), flag_id=g.id, link_id=link.id)


# --- Task 6: flag <-> flag links -----------------------------------------
def _general(db, actor=1, title="g"):
    from flags import service
    return service.create_flag(db, user=_user(actor), entity_type=None,
                               entity_id=None, type="task", title=title)


def test_flag_link_symmetric(db):
    from flags import service
    from flags.errors import BadRequestError
    a = _general(db, title="A")
    b = _general(db, title="B")
    service.add_flag_link(db, user=_user(1), flag_id=a.id, other_id=b.id)
    assert [l.id for l in service.list_flag_links(db, a.id)] == \
           [l.id for l in service.list_flag_links(db, b.id)]
    # event lands on BOTH flags
    assert "flag_link_added" in [e.event_type for e in service.get_flag(db, a.id).events]
    assert "flag_link_added" in [e.event_type for e in service.get_flag(db, b.id).events]
    # duplicate (either direction) and self-link raise
    with pytest.raises(BadRequestError):
        service.add_flag_link(db, user=_user(1), flag_id=b.id, other_id=a.id)
    with pytest.raises(BadRequestError):
        service.add_flag_link(db, user=_user(1), flag_id=a.id, other_id=a.id)


def test_flag_link_remove_from_either_side(db):
    from flags import service
    a = _general(db, title="A")
    b = _general(db, title="B")
    link = service.add_flag_link(db, user=_user(1), flag_id=a.id, other_id=b.id)
    # remove referencing the OTHER side's flag id
    service.remove_flag_link(db, user=_user(1), flag_id=b.id, link_id=link.id)
    assert service.list_flag_links(db, a.id) == []
    assert "flag_link_removed" in [e.event_type
                                   for e in service.get_flag(db, a.id).events]


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


def test_entity_link_route_and_detail(client):
    r = client.post("/api/flags", json={"entity_type": "sub_sample", "entity_id": "1",
                                        "type": "blocker", "title": "t"})
    fid = r.json()["id"]
    add = client.post(f"/api/flags/{fid}/links/entities",
                      json={"entity_type": "sub_sample", "entity_id": "2"})
    assert add.status_code == 201, add.text
    lid = add.json()["id"]
    detail = client.get(f"/api/flags/{fid}").json()
    assert [l["entity_id"] for l in detail["entity_links"]] == ["2"]
    rm = client.delete(f"/api/flags/{fid}/links/entities/{lid}")
    assert rm.status_code == 204
    assert client.get(f"/api/flags/{fid}").json()["entity_links"] == []


def test_flag_link_route_and_detail(client):
    a = client.post("/api/flags", json={"entity_type": None, "entity_id": None,
                                        "type": "task", "title": "A"}).json()["id"]
    b = client.post("/api/flags", json={"entity_type": None, "entity_id": None,
                                        "type": "task", "title": "B"}).json()["id"]
    add = client.post(f"/api/flags/{a}/links/flags", json={"flag_id": b})
    assert add.status_code == 201, add.text
    lid = add.json()["id"]
    # symmetric: on B's detail the link points back to A (pre-resolved title)
    detail_b = client.get(f"/api/flags/{b}").json()
    assert [l["flag_id"] for l in detail_b["flag_links"]] == [a]
    assert detail_b["flag_links"][0]["title"] == "A"
    rm = client.delete(f"/api/flags/{a}/links/flags/{lid}")
    assert rm.status_code == 204
    assert client.get(f"/api/flags/{a}").json()["flag_links"] == []
